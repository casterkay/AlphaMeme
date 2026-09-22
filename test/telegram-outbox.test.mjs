import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeRadarSchema } from '../src/storage/schema.mjs';
import { TelegramOutbox } from '../src/bot/outbox.mjs';
import { createTelegramTransport } from '../src/bot/telegram-transport.mjs';

function fixture(transport = async () => ({ ok: true, result: { message_id: 42 } })) {
  const db = new DatabaseSync(':memory:');
  const storage = {
    sql: { exec: (query, ...args) => ({ toArray: () => db.prepare(query).all(...args) }) },
    transactionSync: callback => {
      db.exec('BEGIN');
      try { const result = callback(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    }
  };
  // DO exec executes writes eagerly, including those without cursor consumption.
  storage.sql.exec = (query, ...args) => {
    const statement = db.prepare(query);
    const rows = statement.columns().length ? statement.all(...args) : (statement.run(...args), []);
    return { toArray: () => rows };
  };
  initializeRadarSchema(storage);
  let now = 100;
  const outbox = new TelegramOutbox({ storage, tenantId: 'tenant', transport, now: () => now });
  const enqueue = (id, extras = {}) => storage.transactionSync(() => outbox.enqueueInTransaction({ id, chatId: '1', method: 'sendMessage', params: { text: 'hello' }, expiresAt: 100_000, ...extras }));
  const deliver = id => outbox.deliverOne(id, { request: operation => operation({ signal: new AbortController().signal }) });
  return { db, storage, outbox, enqueue, deliver, advance: ms => { now += ms; } };
}

test('SENDING and attempt are committed before network; success binds all card mappings atomically', async () => {
  const f = fixture(async () => {
    assert.equal(f.outbox.rows()[0].status, 'SENDING');
    assert.equal(f.outbox.rows()[0].attempts, 1);
    return { ok: true, result: { message_id: 42 } };
  });
  f.enqueue('a');
  await f.deliver('a');
  assert.equal(f.outbox.rows()[0].status, 'SENT');
});

test('crash after remote success recovers UNKNOWN and permits only one lifetime automatic ambiguous retry', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return { ok: false, kind: 'unknown' }; });
  f.enqueue('a');
  f.storage.sql.exec("UPDATE outbox SET status='SENDING', attempts=1 WHERE id='a'");
  f.outbox.reconcileInTransaction({ recoverSending: true });
  await f.deliver('a');
  f.advance(2000);
  await f.deliver('a');
  assert.equal(calls, 1);
  assert.equal(f.outbox.rows()[0].ambiguous_retries, 1);
  assert.equal(f.outbox.rows()[0].status, 'UNKNOWN');
  assert.deepEqual(f.outbox.reconcileInTransaction(), []);
});

test('UNKNOWN edit blocks newer edits even after its validity expires', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return { ok: false, kind: 'unknown' }; });
  f.enqueue('old', { method: 'editMessageText', params: { message_id: 42, text: 'old' }, expiresAt: 200 });
  await f.deliver('old');
  f.advance(200);
  f.enqueue('new', { method: 'editMessageText', params: { message_id: 42, text: 'new' } });
  await f.deliver('new');
  assert.equal(calls, 1);
  assert.deepEqual(f.outbox.reconcileInTransaction(), []);
});

test('send-time eligibility cancels muted notifications without sending', async () => {
  const f = fixture(() => { assert.fail('must not send'); });
  f.enqueue('a', { deliveryClass: 'ACTION_REQUIRED' });
  f.outbox.eligible = () => false;
  await f.deliver('a');
  assert.equal(f.outbox.rows()[0].status, 'CANCELLED');
});

test('stale session version cancels before send while latest version binds the message', async () => {
  const f = fixture();
  f.storage.sql.exec('INSERT INTO ui_sessions (tenant_id,id,owner_user_id,chat_id,panel,query_json,version,expires_at) VALUES (?,?,?,?,?,?,?,?)', 'tenant','s','u','1','home','{}',2,100000);
  f.enqueue('old', { sessionId: 's', sessionVersion: 1 });
  await f.deliver('old');
  assert.equal(f.outbox.rows()[0].status, 'CANCELLED');
  f.enqueue('new', { sessionId: 's', sessionVersion: 2 });
  await f.deliver('new');
  assert.equal(f.storage.sql.exec('SELECT message_id FROM ui_sessions').toArray()[0].message_id, '42');
});

test('retry_after is never shortened and clear failures stop after five total attempts', async () => {
  const f = fixture(async () => ({ ok: false, kind: 'retryable', retryAfterMs: 2000 }));
  f.enqueue('a');
  for (let i = 0; i < 5; i++) { await f.deliver('a'); f.advance(16000); }
  assert.equal(f.outbox.rows()[0].attempts, 5);
  assert.equal(f.outbox.rows()[0].status, 'FAILED');
});

test('duplicate event preserves original immutable payload and batches', () => {
  const f = fixture();
  f.enqueue('a', { eventId: 'event' });
  f.enqueue('b', { eventId: 'event', params: { text: 'changed' } });
  assert.equal(f.outbox.rows().length, 1);
  assert.equal(JSON.parse(f.outbox.rows()[0].payload_json).params.text, 'hello');
});

test('transport redacts rejection details and recognizes not-modified', async () => {
  const transport = createTelegramTransport({ botToken: 'secret', fetchImpl: async () => new Response(JSON.stringify({ ok: false, error_code: 400, description: 'secret message is not modified' }), { status: 400 }) });
  const result = await transport({ method: 'editMessageText', params: {} });
  assert.equal(result.kind, 'not-modified');
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('multiple messages retain independent token mappings; leaving detail removes only that message', async () => {
  const f = fixture();
  f.enqueue('a', { token: { chain: 'sol', address: 'token' } });
  await f.deliver('a');
  f.outbox.transport = async () => ({ ok: true, result: { message_id: 43 } });
  f.enqueue('b', { token: { chain: 'sol', address: 'token' } });
  await f.deliver('b');
  assert.equal(f.storage.sql.exec('SELECT * FROM message_map').toArray().length, 2);
  f.enqueue('c', { method: 'editMessageText', params: { message_id: 42, text: 'home' } });
  f.outbox.transport = async () => ({ ok: false, kind: 'not-modified' });
  await f.deliver('c');
  assert.deepEqual(f.storage.sql.exec('SELECT message_id FROM message_map').toArray().map(row => row.message_id), ['43']);
});

test('prompt send does not replace parent panel ownership', async () => {
  const f = fixture();
  f.storage.sql.exec('INSERT INTO ui_sessions (tenant_id,id,owner_user_id,chat_id,message_id,panel,query_json,version,expires_at) VALUES (?,?,?,?,?,?,?,?,?)', 'tenant','s','u','1','parent','home','{}',1,100000);
  f.enqueue('prompt', { sessionId: 's', sessionVersion: 1, purpose: 'prompt' });
  await f.deliver('prompt');
  assert.equal(f.storage.sql.exec('SELECT message_id FROM ui_sessions').toArray()[0].message_id, 'parent');
});

test('permanent deleted message clears mapping and exposes only redacted diagnosis', async () => {
  const f = fixture();
  f.enqueue('a', { token: { chain: 'sol', address: 'token' } });
  await f.deliver('a');
  f.outbox.transport = async () => ({ ok: false, kind: 'deleted', code: 'untrusted secret' });
  f.enqueue('b', { method: 'editMessageText', params: { message_id: 42, text: 'new' } });
  await f.deliver('b');
  assert.equal(f.storage.sql.exec('SELECT * FROM message_map').toArray().length, 0);
  assert.equal(f.outbox.issues()[0].reason, 'MESSAGE_DELETED');
  assert.equal(JSON.stringify(f.outbox.issues()).includes('secret'), false);
});

test('prompt confirmation callback cannot bind after a newer session navigation', async () => {
  const f = fixture(async () => {
    f.storage.sql.exec('UPDATE ui_sessions SET version = 2');
    return { ok: true, result: { message_id: 42 } };
  });
  f.storage.sql.exec('INSERT INTO ui_sessions (tenant_id,id,owner_user_id,chat_id,panel,query_json,version,expires_at) VALUES (?,?,?,?,?,?,?,?)', 'tenant','s','u','1','home','{}',1,100000);
  f.outbox.onConfirmedInTransaction = () => assert.fail('stale prompt must not bind');
  f.enqueue('prompt', { sessionId: 's', sessionVersion: 1, purpose: 'prompt' });
  await f.deliver('prompt');
  assert.equal(f.outbox.rows()[0].status, 'SENT');
});
