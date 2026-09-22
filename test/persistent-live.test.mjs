import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeRadarSchema } from '../src/storage/schema.mjs';
import { readSchedulerStateInTransaction, writeSchedulerStateInTransaction } from '../src/storage/scheduler-state.mjs';
import { PersistentLive } from '../src/bot/live.mjs';
import { config } from '../src/config.mjs';
const START = 1800000000000;
const token = overrides => ({ address: `0x${'1'.repeat(40)}`, symbol: 'T', market_cap: 50000, liquidity: 15000, creation_timestamp: START / 1000 - 1000, price: 1, volume: 1000, buys: 10, sells: 5, holder_count: 100, smart_degen_count: 3, rug_ratio: .1, bundler_rate: .1, rat_trader_amount_rate: .1, is_wash_trading: false, is_honeypot: 0, ...overrides });
function fixture() {
  const db = new DatabaseSync(':memory:');
  const storage = { sql: { exec: (sql, ...args) => {
    const statement = db.prepare(sql), rows = statement.columns().length ? statement.all(...args) : (statement.run(...args), []);
    return { toArray: () => rows };
  } }, transactionSync: callback => { db.exec('BEGIN'); try { const result = callback(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } } };
  initializeRadarSchema(storage);
  const state = readSchedulerStateInTransaction(storage, '123');
  state.runtime.eligibility.configured = true;
  writeSchedulerStateInTransaction(storage, '123', state);
  let now = START;
  const create = () => new PersistentLive({ storage, tenantId: '123', settings: config, now: () => now });
  return { storage, create, live: create(), advance: milliseconds => { now += milliseconds; }, request: operation => operation({ signal: new AbortController().signal, timeoutMs: 25000 }) };
}

test('persistent subscription polls for 120 seconds without input and retains delta through eviction', async () => {
  const f = fixture();
  f.live.subscribeInTransaction('bsc');
  for (let i = 0; i <= 6; i++) {
    f.live = f.create();
    assert.equal(f.live.reconcileInTransaction()[0].dueAt, START + i * 20000);
    await f.live.pollOne({ request: f.request, gmgn: { marketRank: async (chain, window) => { assert.equal(window, '1m'); return { rank: [token({ price: 1 + i })] }; } } });
    const snapshot = f.live.snapshot('bsc');
    assert.equal(snapshot.leaseUntil, START + i * 20000 + 30000);
    if (i) assert.equal(snapshot.rows[0].deltaWindowMs, 20000);
    f.advance(20000);
  }
  assert.equal(f.live.snapshot('bsc').pollCount, 7);
});

test('pause retains intent without renewing lease; unsubscribe prevents autonomous renewal', async () => {
  const f = fixture(); f.live.subscribeInTransaction('bsc');
  const state = f.live.state(); state.runtime.eligibility.paused = true;
  writeSchedulerStateInTransaction(f.storage, '123', state);
  assert.deepEqual(f.live.reconcileInTransaction(), []);
  await f.live.pollOne({ request: f.request, gmgn: { marketRank: () => assert.fail('paused') } });
  assert.equal(f.live.snapshot('bsc').subscribed, true);
  assert.equal(f.live.snapshot('bsc').leaseUntil, 0);
  f.live.unsubscribeInTransaction(); f.advance(120000);
  assert.deepEqual(f.create().reconcileInTransaction(), []);
});

test('slow read coalesces missed slots and prevents concurrent catch-up', async () => {
  const f = fixture(); f.live.subscribeInTransaction('bsc'); let resolve;
  const pending = f.live.pollOne({ request: f.request, gmgn: { marketRank: () => new Promise(done => { resolve = done; }) } });
  await f.live.pollOne({ request: f.request, gmgn: { marketRank: () => assert.fail('concurrent') } });
  f.advance(55000); resolve({ rank: [] }); await pending;
  assert.equal(f.live.snapshot('bsc').nextPollAt, START + 55000);
  await f.live.pollOne({ request: f.request, gmgn: { marketRank: async () => ({ rank: [] }) } });
  assert.equal(f.live.snapshot('bsc').nextPollAt, START + 75000);
});

test('rate limit preserves prior snapshot and records safe reason; cooldown start records lag', async () => {
  const f = fixture(); f.live.subscribeInTransaction('bsc');
  await f.live.pollOne({ request: f.request, gmgn: { marketRank: async () => ({ rank: [token()] }) } });
  f.advance(20000);
  await f.live.pollOne({ request: f.request, gmgn: { marketRank: async () => { throw Object.assign(new Error('private data'), { code: 'GMGN_RATE_LIMITED' }); } } });
  assert.equal(f.live.snapshot('bsc').rows.length, 1);
  assert.equal(f.live.snapshot('bsc').delayReason, 'RATE_LIMITED');
  f.advance(60000);
  await f.live.pollOne({ request: f.request, gmgn: { marketRank: async () => ({ rank: [] }) } });
  assert.equal(f.live.snapshot('bsc').pollLagMs, 30000);
  assert.equal(JSON.stringify(f.live.snapshot('bsc')).includes('private'), false);
});

test('credential change during read discards result and reconnect cannot expose old epoch cache', async () => {
  const f = fixture(); f.live.subscribeInTransaction('bsc');
  await f.live.pollOne({ request: f.request, gmgn: { marketRank: async () => {
    const state = f.live.state(); state.gmgn.keyEpoch++;
    writeSchedulerStateInTransaction(f.storage, '123', state);
    return { rank: [token()] };
  } } });
  assert.equal(f.live.snapshot('bsc').rows.length, 0);
  assert.equal(f.live.state().runtime.live.running, null);
});

test('audit enqueue retains chain, snapshot, exclusion and quota gates and strips minute counters', async () => {
  const f = fixture(); f.live.subscribeInTransaction('bsc');
  await f.live.pollOne({ request: f.request, gmgn: { marketRank: async () => ({ rank: [token()] }) } });
  const address = token().address;
  assert.equal(f.live.enqueueReviewInTransaction('bsc', address, { snapshotAt: START, enabledChains: ['sol'] }).reason, 'chain_not_scanning');
  assert.equal(f.live.enqueueReviewInTransaction('bsc', address, { snapshotAt: START - 1, enabledChains: ['bsc'] }).reason, 'stale_snapshot');
  assert.equal(f.live.enqueueReviewInTransaction('bsc', address, { snapshotAt: START, enabledChains: ['bsc'] }).accepted, true);
  assert.equal(f.live.enqueueReviewInTransaction('bsc', address, { snapshotAt: START, enabledChains: ['bsc'] }).accepted, true);
  const queue = f.storage.sql.exec('SELECT * FROM audit_queue').toArray();
  assert.equal(queue.length, 1);
  assert.equal(JSON.parse(queue[0].details_json).row.buys, undefined);
  assert.equal(f.live.read('live.requestedReviews').length, 1);
  f.storage.sql.exec('INSERT INTO risk_exclusions (tenant_id,chain,address) VALUES (?,?,?)', '123','bsc',address);
  assert.equal(f.live.enqueueReviewInTransaction('bsc', address, { snapshotAt: START, enabledChains: ['bsc'] }).reason, 'risk_excluded');
});

test('timeout exposes stale state without leaking errors or stranding the running claim', async () => {
  const f = fixture(); f.live.subscribeInTransaction('bsc');
  await f.live.pollOne({ request: async () => { f.advance(25000); throw Object.assign(new Error('secret'), { code: 'SCHEDULER_REQUEST_TIMEOUT' }); }, gmgn: {} });
  assert.equal(f.live.snapshot('bsc').status, 'REQUEST_FAILED');
  assert.equal(f.live.snapshot('bsc').stale, true);
  assert.equal(f.live.state().runtime.live.running, null);
  assert.equal(f.live.snapshot('bsc').requestMs, 25000);
});
