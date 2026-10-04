import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HostSchemaError, initializeHostSchema } from '../src/host/state.mjs';
import { openDatabase, sqliteStorage } from '../src/host/storage.mjs';

function fixture() {
  const storage = sqliteStorage(new DatabaseSync(':memory:'));
  storage.sql.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
  const insert = body => storage.sql.exec('INSERT INTO notes (body) VALUES (?)', body);
  const bodies = () => storage.sql.exec('SELECT body FROM notes ORDER BY id').toArray().map(row => row.body);
  return { storage, insert, bodies };
}

test('a nested transaction commits with its outer transaction', () => {
  const { storage, insert, bodies } = fixture();
  const value = storage.transactionSync(() => {
    insert('outer');
    return storage.transactionSync(() => {
      insert('inner');
      return 'returned';
    });
  });
  assert.equal(value, 'returned');
  assert.deepEqual(bodies(), ['outer', 'inner']);
});

test('a failed nested transaction undoes only its own writes and still propagates', () => {
  const { storage, insert, bodies } = fixture();
  storage.transactionSync(() => {
    insert('before');
    assert.throws(() => storage.transactionSync(() => {
      insert('inner');
      throw new RangeError('inner failed');
    }), RangeError);
    insert('after');
  });
  assert.deepEqual(bodies(), ['before', 'after']);
});

test('an outer failure undoes the writes of nested transactions that completed', () => {
  const { storage, insert, bodies } = fixture();
  assert.throws(() => storage.transactionSync(() => {
    storage.transactionSync(() => insert('inner'));
    throw new RangeError('outer failed');
  }), RangeError);
  assert.deepEqual(bodies(), []);
  storage.transactionSync(() => insert('next'));
  assert.deepEqual(bodies(), ['next'], 'the adapter is usable after a rollback');
});

test('cursors report written rows and enforce one()', () => {
  const { storage, insert } = fixture();
  insert('a');
  insert('b');
  assert.equal(storage.sql.exec("UPDATE notes SET body = 'c'").rowsWritten, 2);
  assert.equal(storage.sql.exec('SELECT COUNT(*) AS count FROM notes').one().count, 2);
  assert.throws(() => storage.sql.exec('SELECT body FROM notes').one(), /exactly one row/);
});

test('host databases are opened in WAL mode with full synchronous commits', t => {
  const dir = mkdtempSync(join(tmpdir(), 'radar-host-storage-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = openDatabase(join(dir, 'radar.sqlite'));
  t.after(() => db.close());
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(db.prepare('PRAGMA synchronous').get().synchronous, 2);
});

test('the host schema is created once and a foreign table set is refused', () => {
  const storage = sqliteStorage(new DatabaseSync(':memory:'));
  initializeHostSchema(storage);
  initializeHostSchema(storage);
  storage.sql.exec('CREATE TABLE extra (id INTEGER)');
  assert.throws(() => initializeHostSchema(storage), HostSchemaError);
});
