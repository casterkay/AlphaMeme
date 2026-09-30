import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { RecoverableScanner } from '../src/recoverable-scanner.mjs';
import { executeRecoverableScanStep, recoverableRequestCost } from '../src/recoverable-scan-executor.mjs';
import { AveClient } from '../src/providers/ave.mjs';
import { SecondaryValidator } from '../src/providers/secondary.mjs';
import { scannerSettings } from '../src/scanner-settings.mjs';
import { SqliteControlStateStore } from '../src/storage/control-state.mjs';
import { SqliteRecoverableScannerStore, stableEffectId } from '../src/storage/recoverable-scanner.mjs';
import { initializeRadarSchema } from '../src/storage/schema.mjs';
import { readSchedulerStateInTransaction, writeSchedulerStateInTransaction } from '../src/storage/scheduler-state.mjs';

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const TENANT = '1000';
const API_KEY = 'radar-test-ave-key';
const address = digit => `0x${digit.repeat(40)}`;
const A = address('a'), B = address('b'), C = address('c'), D = address('d'), E = address('f');

function sqliteStorage() {
  const db = new DatabaseSync(':memory:');
  return {
    sql: {
      exec: (sql, ...args) => {
        const statement = db.prepare(sql);
        const rows = statement.columns().length ? statement.all(...args) : (statement.run(...args), []);
        return { toArray: () => rows };
      }
    },
    transactionSync: fn => {
      db.exec('BEGIN');
      try {
        const value = fn();
        db.exec('COMMIT');
        return value;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
  };
}

const request = operation => operation({ signal: new AbortController().signal });

// A configured tenant scanning `chain`, backed by the real SQLite store, a real
// AveClient over a hand-written fetch stub, and a hand-written secondary source.
function radar({ chain = 'bsc', settings: overrides = {} } = {}) {
  const storage = sqliteStorage();
  initializeRadarSchema(storage);
  const state = readSchedulerStateInTransaction(storage, TENANT);
  writeSchedulerStateInTransaction(storage, TENANT, {
    ...state,
    runtime: { ...state.runtime, eligibility: { paused: false, configured: true }, control: { ...state.runtime.control, activeChain: chain } }
  });
  const settings = { ...scannerSettings, ...overrides };
  const clock = { now: NOW };
  const store = new SqliteRecoverableScannerStore(storage, TENANT);
  const scanner = new RecoverableScanner({ store, settings, now: () => clock.now });
  const fixture = {
    storage, store, scanner, settings, clock,
    hotList: [],
    trendingStatus: 200,
    trendingRequests: 0,
    verdicts: new Map(),
    secondaryCalls: [],
    priceAt: async () => null
  };
  const fetchImpl = async url => {
    assert.ok(url.startsWith('https://prod.ave-api.com/v2/tokens/trending?'), url);
    fixture.trendingRequests += 1;
    if (fixture.trendingStatus !== 200) return new Response('upstream unavailable', { status: fixture.trendingStatus });
    return Response.json({ status: 1, data: { tokens: fixture.hotList } });
  };
  const client = new AveClient({ apiKey: API_KEY, fetchImpl, now: () => clock.now });
  fixture.ave = {
    trending: (name, options) => client.trending(name, options),
    priceAt: (...args) => fixture.priceAt(...args)
  };
  fixture.secondary = {
    async fetchSource({ source, tokenAddress }) {
      fixture.secondaryCalls.push({ source, tokenAddress });
      if (source === 'dexScreener') {
        return { source: { status: 'OK' }, market: { complete: true, priceUsd: null, marketCap: null, liquidityUsd: null, websites: [] } };
      }
      const verdict = fixture.verdicts.get(tokenAddress) || 'NO_FATAL_FLAGS';
      return {
        source: { status: 'OK' },
        security: { complete: true, verdict, fatal: verdict === 'FATAL' ? [{ field: 'isHoneypot' }] : [], unknownFields: [], fields: {}, buyTax: 0, sellTax: 0 }
      };
    }
  };
  // An AVE trending row as the API sends it, quoted `quoteAgeMs` before now.
  fixture.quote = (token, { price = 0.001, marketCap = 50_000, liquidity = 20_000, volume5m = 5_000, quoteAgeMs = 5_000, launchedAgoMs = 30 * MINUTE } = {}) => ({
    token, chain: chain === 'sol' ? 'solana' : chain, symbol: `T${token.slice(2, 5)}`, name: 'Test token',
    current_price_usd: price, market_cap: marketCap, main_pair_tvl: liquidity, token_tx_volume_usd_5m: volume5m, holders: 120,
    updated_at: Math.floor((clock.now - quoteAgeMs) / 1000), launch_at: Math.floor((clock.now - launchedAgoMs) / 1000)
  });
  fixture.control = () => new SqliteControlStateStore(storage, TENANT).snapshot();
  fixture.step = (cycleId, extra = {}) => executeRecoverableScanStep({
    scanner, cycleId, ave: fixture.ave, secondary: fixture.secondary, request, now: () => clock.now, ...extra
  });
  fixture.begin = (cycleId, deadlineAt = clock.now + settings.auditCycleBudgetMs) => {
    const control = fixture.control();
    return scanner.begin({ cycleId, chain, keyEpoch: control.keyEpoch, controlEpoch: control.controlEpoch, deadlineAt });
  };
  fixture.runCycle = async (cycleId, { onFinalized } = {}) => {
    fixture.begin(cycleId);
    const results = [];
    for (let step = 0; step < 100; step += 1) {
      const result = await fixture.step(cycleId, onFinalized ? { onFinalized } : {});
      results.push(result);
      if (result.complete || result.nextTask) return results;
    }
    assert.fail(`cycle ${cycleId} did not finish`);
  };
  // Steps a fresh cycle until its screened hot list is committed.
  fixture.screenCycle = async cycleId => {
    fixture.begin(cycleId);
    await fixture.step(cycleId);
    assert.equal(store.read(cycleId).phase, 'SCREEN');
    await fixture.step(cycleId);
    assert.equal(store.read(cycleId).phase, 'BUILD_QUEUE');
  };
  fixture.candidate = token => store.readCandidate(chain, token);
  fixture.outcome = token => store.readOutcomes(chain).find(row => row.address === token) || null;
  fixture.events = () => storage.sql.exec('SELECT type, address, data_json FROM events WHERE tenant_id = ? ORDER BY at, id', TENANT).toArray();
  fixture.state = key => {
    const row = storage.sql.exec('SELECT value_json FROM scheduler_state WHERE tenant_id = ? AND key = ?', TENANT, key).toArray()[0];
    return row ? JSON.parse(row.value_json) : null;
  };
  fixture.seedCheckpoint = checkpoint => store.begin({
    keyEpoch: 0, controlEpoch: 0, deadlineAt: null, tokenIndex: 0, endpointIndex: 0, updatedAt: clock.now, ...checkpoint
  });
  fixture.seedOutcome = ({ chain: outcomeChain = chain, token, baselineAt, baselinePrice = 1 }) => storage.sql.exec(
    `INSERT INTO outcomes (tenant_id, chain, address, initial_decision, latest_decision, baseline_at, baseline_price, last_audited_at, symbol, latest_failed_json, sampling, strategy_version, samples_json, sample_retries_json, cohort_metadata_json)
     VALUES (?, ?, ?, 'LIVE_READY', 'LIVE_READY', ?, ?, ?, 'SEEDED', '[]', 'ALL_LEADS', 'ave-leads-v1', '{}', '{}', '{}')`,
    TENANT, outcomeChain, token, baselineAt, baselinePrice, baselineAt
  );
  return fixture;
}

function leadItem(token) {
  return {
    address: token,
    row: { address: token, symbol: `T${token.slice(2, 5)}`, price: 0.001, market_cap: 50_000, liquidity: 20_000 },
    screen: { pass: true, mc: 50_000, liquidity: 20_000, ageSec: 1_800, priorityBand: true, score: 60, reasons: [] }
  };
}

test('a fresh AVE trending row that passes the screen becomes a lead with an event, a baseline and a feed row in the screen commit', async () => {
  const radarFixture = radar();
  radarFixture.hotList = [radarFixture.quote(A, { price: 0.002 })];
  radarFixture.begin('cycle-fresh');

  await radarFixture.step('cycle-fresh');
  assert.equal(radarFixture.candidate(A), null, 'discovery alone commits no lead');
  assert.deepEqual(radarFixture.events(), []);
  assert.equal(radarFixture.outcome(A), null);
  assert.equal(radarFixture.state('feed.snapshot:bsc'), null);

  await radarFixture.step('cycle-fresh');
  const lead = radarFixture.candidate(A);
  assert.equal(lead.status, 'LIVE_READY');
  assert.equal(lead.staleAt, NOW + scannerSettings.liveLeadRetentionMs);
  assert.equal(lead.metadata.qualifiedAt, NOW);
  assert.equal(lead.secondary, null);
  assert.deepEqual(radarFixture.events().map(({ type, address: token }) => ({ type, token })), [{ type: 'CANDIDATE_NEW', token: A }]);
  assert.equal(JSON.parse(radarFixture.events()[0].data_json).reviewRevision, lead.reviewRevision);
  const outcome = radarFixture.outcome(A);
  assert.equal(outcome.initialDecision, 'LIVE_READY');
  assert.equal(outcome.baselineAt, NOW - 5_000);
  assert.equal(outcome.baselinePrice, 0.002);
  assert.deepEqual(outcome.samples, {});
  const feed = radarFixture.state('feed.snapshot:bsc');
  assert.equal(feed.status, 'READY');
  assert.equal(feed.leadCount, 1);
  assert.deepEqual(feed.rows.map(row => [row.address, row.pass]), [[A, true]]);
});

for (const [scenario, options, reason] of [
  ['a quote older than 60 seconds', { quoteAgeMs: 61_000 }, 'AVE 行情已过期或原始时间未核验'],
  ['a market cap above the discovery range', { marketCap: 150_001 }, '市值不在发现范围'],
  ['a market cap below the discovery range', { marketCap: 9_999 }, '市值不在发现范围']
]) {
  test(`${scenario} does not become a lead`, async () => {
    const radarFixture = radar();
    radarFixture.hotList = [radarFixture.quote(A, options)];
    await radarFixture.runCycle(`cycle-rejected-${options.quoteAgeMs ? 'stale' : options.marketCap}`);

    assert.equal(radarFixture.candidate(A), null);
    assert.deepEqual(radarFixture.events(), []);
    assert.equal(radarFixture.outcome(A), null);
    assert.equal(radarFixture.secondaryCalls.length, 0);
    const [row] = radarFixture.state('feed.snapshot:bsc').rows;
    assert.equal(row.pass, false);
    assert.ok(row.reasons.includes(reason), JSON.stringify(row.reasons));
  });
}

test('a lead failing a later screen is deleted while an absent lead is kept until stale_at and pruned at summary', async () => {
  const radarFixture = radar();
  radarFixture.hotList = [radarFixture.quote(A), radarFixture.quote(B)];
  await radarFixture.runCycle('cycle-leads-1');
  assert.equal(radarFixture.candidate(A).status, 'LIVE_READY');
  assert.equal(radarFixture.candidate(B).staleAt, NOW + scannerSettings.liveLeadRetentionMs);

  radarFixture.clock.now = NOW + 10 * MINUTE;
  radarFixture.hotList = [radarFixture.quote(A, { marketCap: 500_000 })];
  await radarFixture.runCycle('cycle-leads-2');
  assert.equal(radarFixture.candidate(A), null, 'a failing screen eliminates the lead');
  assert.equal(radarFixture.candidate(B).status, 'LIVE_READY', 'absence from one hot list is not elimination');

  radarFixture.clock.now = NOW + scannerSettings.liveLeadRetentionMs;
  radarFixture.hotList = [];
  await radarFixture.runCycle('cycle-leads-3');
  assert.equal(radarFixture.candidate(B).status, 'LIVE_READY', 'a lead is shown through its stale_at');

  radarFixture.clock.now = NOW + scannerSettings.liveLeadRetentionMs + 1;
  await radarFixture.runCycle('cycle-leads-4');
  assert.equal(radarFixture.candidate(B), null);
});

test('a refreshed lead keeps its secondary result, review revision and qualification time', async () => {
  const radarFixture = radar();
  radarFixture.hotList = [radarFixture.quote(A, { price: 0.001 })];
  await radarFixture.runCycle('cycle-refresh-1');
  const checked = radarFixture.candidate(A);
  assert.equal(checked.secondary.security.verdict, 'NO_FATAL_FLAGS');

  radarFixture.clock.now = NOW + MINUTE;
  radarFixture.hotList = [radarFixture.quote(A, { price: 0.0012 })];
  await radarFixture.screenCycle('cycle-refresh-2');
  const refreshed = radarFixture.candidate(A);
  assert.equal(refreshed.price, 0.0012);
  assert.equal(refreshed.staleAt, NOW + MINUTE + scannerSettings.liveLeadRetentionMs);
  assert.equal(refreshed.reviewRevision, checked.reviewRevision);
  assert.deepEqual(refreshed.secondary, checked.secondary);
  assert.equal(refreshed.metadata.qualifiedAt, NOW);
  assert.deepEqual(radarFixture.events().map(event => event.type), ['CANDIDATE_NEW'], 'a refresh is not a new lead');
});

test('a non-fatal secondary result keeps the lead status and revision and records the result', async () => {
  const radarFixture = radar();
  radarFixture.hotList = [radarFixture.quote(A)];
  await radarFixture.screenCycle('cycle-non-fatal');
  const lead = radarFixture.candidate(A);

  const results = [];
  for (let step = 0; step < 20 && !results.at(-1)?.complete; step += 1) results.push(await radarFixture.step('cycle-non-fatal'));
  const checked = radarFixture.candidate(A);
  assert.equal(checked.status, 'LIVE_READY');
  assert.equal(checked.reviewRevision, lead.reviewRevision);
  assert.equal(checked.secondary.security.verdict, 'NO_FATAL_FLAGS');
  assert.deepEqual(radarFixture.secondaryCalls.map(call => call.source), ['dexScreener', 'goPlus']);
  assert.deepEqual(radarFixture.events().map(event => event.type), ['CANDIDATE_NEW']);
});

test('a GoPlus fatal verdict vetoes a lead and the vetoed token is not re-promoted by the next screen', async () => {
  const radarFixture = radar();
  radarFixture.verdicts.set(A, 'FATAL');
  radarFixture.hotList = [radarFixture.quote(A)];
  await radarFixture.screenCycle('cycle-veto-1');
  const lead = radarFixture.candidate(A);
  const baseline = radarFixture.outcome(A);

  radarFixture.clock.now = NOW + 1_000;
  for (let step = 0; step < 20; step += 1) {
    if ((await radarFixture.step('cycle-veto-1')).complete) break;
  }
  const vetoed = radarFixture.candidate(A);
  assert.equal(vetoed.status, 'HARD_REJECT');
  assert.notEqual(vetoed.reviewRevision, lead.reviewRevision);
  assert.equal(vetoed.secondary.security.verdict, 'FATAL');
  assert.deepEqual(radarFixture.events().map(event => event.type), ['CANDIDATE_NEW', 'RISK_WORSENED']);
  assert.equal(JSON.parse(radarFixture.events()[1].data_json).reviewRevision, vetoed.reviewRevision);
  const outcome = radarFixture.outcome(A);
  assert.equal(outcome.latestDecision, 'HARD_REJECT');
  assert.equal(outcome.initialDecision, 'LIVE_READY');
  assert.equal(outcome.baselineAt, baseline.baselineAt);
  assert.equal(outcome.baselinePrice, baseline.baselinePrice);

  radarFixture.clock.now = NOW + MINUTE;
  radarFixture.secondaryCalls.length = 0;
  radarFixture.hotList = [radarFixture.quote(A)];
  await radarFixture.runCycle('cycle-veto-2');
  const after = radarFixture.candidate(A);
  assert.equal(after.status, 'HARD_REJECT');
  assert.equal(after.reviewRevision, vetoed.reviewRevision);
  assert.equal(radarFixture.state('feed.snapshot:bsc').leadCount, 0);
  assert.equal(radarFixture.secondaryCalls.length, 0);
  assert.deepEqual(radarFixture.events().map(event => event.type), ['CANDIDATE_NEW', 'RISK_WORSENED']);
});

test('a trending read failure still completes the cycle, keeps leads, and records discovery health', async () => {
  const radarFixture = radar();
  radarFixture.hotList = [radarFixture.quote(A)];
  await radarFixture.runCycle('cycle-health-1');
  assert.deepEqual(radarFixture.state('runtime.sourceHealth').discovery.trending, { ok: true, count: 1 });

  radarFixture.clock.now = NOW + MINUTE;
  radarFixture.trendingStatus = 503;
  const results = await radarFixture.runCycle('cycle-health-2');
  assert.equal(results.at(-1).complete, true);
  assert.equal(radarFixture.trendingRequests, 2);
  const discovery = radarFixture.state('runtime.sourceHealth').discovery;
  assert.equal(discovery.complete, false);
  assert.equal(discovery.checkedAt, NOW + MINUTE);
  assert.deepEqual(discovery.trending, { ok: false, code: 'AVE_UPSTREAM' });
  const feed = radarFixture.state('feed.snapshot:bsc');
  assert.equal(feed.status, 'AVE_UPSTREAM');
  assert.equal(feed.observedAt, null);
  assert.equal(radarFixture.candidate(A).status, 'LIVE_READY');
});

test('later trending quotes sample an outcome horizon only within the five-minute lag', async () => {
  const radarFixture = radar();
  radarFixture.hotList = [radarFixture.quote(A, { price: 0.001 })];
  await radarFixture.runCycle('cycle-sample-1');
  const baselineAt = radarFixture.outcome(A).baselineAt;

  // The quote lands 2 minutes after the 5-minute horizon.
  radarFixture.clock.now = baselineAt + 7 * MINUTE + 5_000;
  radarFixture.hotList = [radarFixture.quote(A, { price: 0.0015 })];
  await radarFixture.runCycle('cycle-sample-2');
  const sampled = radarFixture.outcome(A);
  assert.deepEqual(Object.keys(sampled.samples), ['m5']);
  assert.equal(sampled.samples.m5.at, baselineAt + 7 * MINUTE);
  assert.equal(sampled.samples.m5.targetAt, baselineAt + 5 * MINUTE);
  assert.equal(sampled.samples.m5.lagMs, 2 * MINUTE);
  assert.equal(sampled.samples.m5.source, 'AVE_TRENDING');
  assert.ok(Math.abs(sampled.samples.m5.return - 0.5) < 1e-9);

  // The quote lands 6 minutes after the 15-minute horizon: too late.
  radarFixture.clock.now = baselineAt + 21 * MINUTE + 5_000;
  radarFixture.hotList = [radarFixture.quote(A, { price: 0.003 })];
  await radarFixture.runCycle('cycle-sample-3');
  const late = radarFixture.outcome(A);
  assert.deepEqual(Object.keys(late.samples), ['m5']);
  assert.deepEqual(late.samples.m5, sampled.samples.m5);
});

test('secondary checks per cycle are bounded by maxSecondaryChecksPerCycle', async () => {
  const radarFixture = radar({ settings: { maxSecondaryChecksPerCycle: 2 } });
  radarFixture.hotList = [A, B, C, D, E].map(token => radarFixture.quote(token));
  await radarFixture.runCycle('cycle-bounded');

  const checked = [...new Set(radarFixture.secondaryCalls.map(call => call.tokenAddress))];
  assert.equal(checked.length, 2);
  assert.equal(radarFixture.secondaryCalls.length, 4);
  const leads = [A, B, C, D, E].map(token => radarFixture.candidate(token));
  assert.ok(leads.every(lead => lead.status === 'LIVE_READY'));
  assert.deepEqual(leads.filter(lead => lead.secondary).map(lead => lead.address).sort(), checked.sort());
});

test('recoverableRequestCost charges AVE credits only for trending and candle reads', () => {
  assert.equal(recoverableRequestCost({ kind: 'DISCOVER' }), 5);
  assert.equal(recoverableRequestCost({ kind: 'OUTCOMES_SAMPLE' }), 10);
  assert.equal(recoverableRequestCost({ kind: 'SECONDARY' }), 0);
  assert.equal(recoverableRequestCost({ kind: 'DEADLINE_EXPIRED' }), 0);
  assert.equal(recoverableRequestCost(null), 0);
});

test('a finalized cycle schedules its successor with the cost of a trending read', async () => {
  const radarFixture = radar();
  radarFixture.hotList = [radarFixture.quote(A)];
  radarFixture.begin('cycle-successor');
  assert.equal(recoverableRequestCost(radarFixture.scanner.nextRequest('cycle-successor')), 5);

  const first = await radarFixture.step('cycle-successor');
  assert.equal(first.nextAveCost, 0, 'screening makes no AVE request');
  let result;
  for (let step = 0; step < 20; step += 1) {
    radarFixture.clock.now += 1;
    result = await radarFixture.step('cycle-successor', {
      onFinalized(checkpoint) {
        const summary = checkpoint.partial.summary;
        const successor = radarFixture.scanner.begin({
          cycleId: summary.nextCycleId, chain: checkpoint.chain, keyEpoch: checkpoint.keyEpoch, controlEpoch: checkpoint.controlEpoch,
          deadlineAt: summary.nextDeadlineAt, partial: { rootCycleId: checkpoint.partial.rootCycleId, scanCount: summary.scanCount }
        });
        return { checkpoint: successor, task: { id: `scan:${summary.nextCycleId}`, kind: 'scan', dueAt: summary.nextCycleAt, enabled: true, aveCost: 5 } };
      }
    });
    if (result.nextTask) break;
  }
  assert.equal(result.complete, false);
  assert.equal(result.nextAveCost, 5);
  assert.equal(result.nextTask.id, 'scan:cycle-successor:cycle:2');
  assert.equal(result.nextTask.dueAt, NOW + scannerSettings.scanIntervalMs);
  assert.equal(Object.hasOwn(result, 'nextDueAt'), false);
  assert.equal(radarFixture.scanner.nextRequest('cycle-successor:cycle:2').kind, 'DISCOVER');
});

test('a finalized cycle without a successor completes with no AVE cost', async () => {
  const radarFixture = radar();
  const results = await radarFixture.runCycle('cycle-last');
  assert.equal(results.at(-1).complete, true);
  assert.equal(results.at(-1).nextAveCost, 0);
  assert.ok(results.slice(0, -1).every(result => result.complete === false && Number.isSafeInteger(result.nextDueAt)));
});

test('an overdue finalized cycle schedules its successor at the current time', async () => {
  const radarFixture = radar();
  radarFixture.begin('cycle-overdue');
  for (let step = 0; step < 5; step += 1) await radarFixture.step('cycle-overdue');
  assert.equal(radarFixture.store.read('cycle-overdue').partial.summary.finalized, true);

  radarFixture.clock.now = NOW + scannerSettings.scanIntervalMs + 1_000;
  const result = await radarFixture.step('cycle-overdue', {
    onFinalized(checkpoint) {
      const summary = checkpoint.partial.summary;
      const dueAt = Math.max(radarFixture.clock.now, summary.nextCycleAt);
      const successor = radarFixture.scanner.begin({
        cycleId: summary.nextCycleId, chain: checkpoint.chain, keyEpoch: checkpoint.keyEpoch, controlEpoch: checkpoint.controlEpoch,
        deadlineAt: dueAt + scannerSettings.auditCycleBudgetMs, partial: { rootCycleId: checkpoint.partial.rootCycleId, scanCount: summary.scanCount }
      });
      return { checkpoint: successor, task: { id: `scan:${summary.nextCycleId}`, kind: 'scan', dueAt, enabled: true, aveCost: 5 } };
    }
  });
  assert.equal(result.nextTask.dueAt, radarFixture.clock.now);
  assert.equal(result.nextAveCost, 5);
  assert.equal(Object.hasOwn(result, 'nextDueAt'), false);
});

test('the scanner persists one response cursor at a time and a new store resumes it with the original deadline', () => {
  const radarFixture = radar();
  radarFixture.begin('cycle-cursor', NOW + 20_000);
  assert.equal(radarFixture.scanner.nextRequest('cycle-cursor').endpoint, 'trending');

  radarFixture.scanner.recordRequest('cycle-cursor', { value: { rows: [], capturedAt: NOW + 1 }, collectedAt: NOW + 1 });
  const reopened = new RecoverableScanner({ store: new SqliteRecoverableScannerStore(radarFixture.storage, TENANT), settings: radarFixture.settings, now: () => NOW + 2 });
  const persisted = reopened.checkpoint('cycle-cursor');
  assert.equal(persisted.phase, 'SCREEN');
  assert.equal(persisted.endpointIndex, 0);
  assert.equal(persisted.partial.discovery.responses.trending.collectedAt, NOW + 1);
  assert.equal(persisted.deadlineAt, NOW + 20_000);

  assert.equal(reopened.advanceLocal('cycle-cursor').phase, 'BUILD_QUEUE');
  assert.equal(reopened.advanceLocal('cycle-cursor').phase, 'OUTCOMES_SAMPLE');
  assert.equal(reopened.checkpoint('cycle-cursor').deadlineAt, NOW + 20_000);
});

test('the scanner rejects a response from an already-advanced request cursor', () => {
  const radarFixture = radar();
  radarFixture.begin('cycle-stale-response');
  const original = radarFixture.scanner.nextRequest('cycle-stale-response');
  radarFixture.scanner.recordRequest('cycle-stale-response', { value: { rows: [], capturedAt: NOW }, collectedAt: NOW + 1, expectedCheckpoint: original.checkpoint });

  assert.throws(() => radarFixture.scanner.recordRequest('cycle-stale-response', {
    value: { rows: [{ address: A }], capturedAt: NOW }, collectedAt: NOW + 2, expectedCheckpoint: original.checkpoint
  }), error => error?.code === 'CYCLE_CHECKPOINT_CURSOR_CONFLICT');
  const checkpoint = radarFixture.store.read('cycle-stale-response');
  assert.equal(checkpoint.phase, 'SCREEN');
  assert.deepEqual(checkpoint.partial.discovery.responses.trending.value.rows, []);
});

test('the executor makes one trending request and checkpoints its parsed rows', async () => {
  const radarFixture = radar();
  radarFixture.hotList = [radarFixture.quote(A)];
  radarFixture.begin('cycle-executor');
  const result = await radarFixture.step('cycle-executor');

  assert.equal(radarFixture.trendingRequests, 1);
  const response = radarFixture.store.read('cycle-executor').partial.discovery.responses.trending;
  assert.equal(response.value.capturedAt, NOW);
  assert.deepEqual(response.value.rows.map(row => [row.address, row.marketProvider, row.sourceUpdatedAt]), [[A, 'AVE', NOW - 5_000]]);
  assert.equal(result.status, 'success');
  assert.equal(result.complete, false);
  assert.equal(result.nextAveCost, 0);
});

test('the executor records a caught AVE error as the trending response', async () => {
  const radarFixture = radar();
  const client = new AveClient({ apiKey: API_KEY, fetchImpl: async () => { throw new TypeError('fetch failed'); }, now: () => NOW });
  radarFixture.ave.trending = (name, options) => client.trending(name, options);
  radarFixture.begin('cycle-executor-error');
  const result = await radarFixture.step('cycle-executor-error');

  assert.equal(result.status, 'success');
  const checkpoint = radarFixture.store.read('cycle-executor-error');
  assert.equal(checkpoint.phase, 'SCREEN');
  assert.equal(checkpoint.partial.discovery.responses.trending.error.code, 'AVE_NETWORK');
});

test('an expired cycle budget finishes the current token secondary checks before stopping at the next token', async () => {
  const radarFixture = radar();
  radarFixture.hotList = [radarFixture.quote(A), radarFixture.quote(B)];
  radarFixture.begin('cycle-deadline', NOW + 1_000);
  await radarFixture.step('cycle-deadline');
  await radarFixture.step('cycle-deadline');
  await radarFixture.step('cycle-deadline');
  assert.equal(radarFixture.store.read('cycle-deadline').phase, 'SECONDARY');

  radarFixture.clock.now = NOW + 2_000;
  assert.equal(radarFixture.scanner.nextRequest('cycle-deadline').kind, 'SECONDARY');
  await radarFixture.step('cycle-deadline');
  await radarFixture.step('cycle-deadline');
  await radarFixture.step('cycle-deadline');
  const afterFirst = radarFixture.store.read('cycle-deadline');
  assert.equal(afterFirst.phase, 'SECONDARY');
  assert.equal(afterFirst.tokenIndex, 1);
  assert.equal(radarFixture.scanner.nextRequest('cycle-deadline').kind, 'DEADLINE_EXPIRED');

  await radarFixture.step('cycle-deadline');
  const stopped = radarFixture.store.read('cycle-deadline');
  assert.equal(stopped.phase, 'OUTCOMES_SAMPLE');
  assert.equal(stopped.partial.outcomeDeadlineAt, NOW + 1_000 + 25_000);
  assert.equal(radarFixture.secondaryCalls.length, 2);
  const [checked, unchecked] = afterFirst.partial.queue.selected.map(item => radarFixture.candidate(item.address));
  assert.equal(checked.secondary.security.verdict, 'NO_FATAL_FLAGS');
  assert.equal(unchecked.secondary, null);
});

test('an outcome read is not requested once its bounded sampling deadline has passed', async () => {
  const radarFixture = radar({ settings: { outcomeReadsPerCycle: 2 } });
  radarFixture.seedOutcome({ token: C, baselineAt: NOW - 10 * MINUTE });
  radarFixture.seedCheckpoint({ cycleId: 'cycle-sample-deadline', chain: 'bsc', deadlineAt: NOW - 1, phase: 'OUTCOMES_SAMPLE',
    partial: { settings: radarFixture.settings } });
  radarFixture.scanner.advanceLocal('cycle-sample-deadline');
  assert.equal(radarFixture.scanner.nextRequest('cycle-sample-deadline').kind, 'OUTCOMES_SAMPLE');

  let reads = 0;
  radarFixture.priceAt = async () => { reads += 1; return null; };
  radarFixture.clock.now = NOW - 1 + 25_000;
  assert.equal(radarFixture.scanner.nextRequest('cycle-sample-deadline'), null);
  await radarFixture.step('cycle-sample-deadline');
  assert.equal(reads, 0);
  assert.equal(radarFixture.store.read('cycle-sample-deadline').phase, 'SUMMARIZE');
  assert.deepEqual(radarFixture.outcome(C).samples, {});
});

test('outcome reads per cycle are capped', () => {
  const radarFixture = radar({ settings: { outcomeReadsPerCycle: 1 } });
  radarFixture.seedOutcome({ token: C, baselineAt: NOW - 10 * MINUTE });
  radarFixture.seedOutcome({ token: D, baselineAt: NOW - 10 * MINUTE - 1 });
  radarFixture.seedCheckpoint({ cycleId: 'cycle-outcome-limit', chain: 'bsc', phase: 'OUTCOMES_SAMPLE', partial: { settings: radarFixture.settings } });

  radarFixture.scanner.advanceLocal('cycle-outcome-limit');
  const target = radarFixture.store.read('cycle-outcome-limit').partial.outcomes.job.address;
  radarFixture.scanner.recordOutcomeSample('cycle-outcome-limit', { error: Object.assign(new Error('no candle'), { code: 'NO_CANDLE' }), collectedAt: NOW + 1 });

  const checkpoint = radarFixture.store.read('cycle-outcome-limit');
  assert.equal(checkpoint.phase, 'SUMMARIZE');
  assert.equal(checkpoint.partial.outcomes, undefined);
  const other = target === C ? D : C;
  assert.equal(radarFixture.outcome(target).sampleRetries.m5.attempts, 1);
  assert.equal(radarFixture.outcome(target).sampleRetries.m5.code, 'NO_CANDLE');
  assert.equal(radarFixture.outcome(other).sampleRetries.m5, undefined);
});

test('a due outcome is sampled from the nearest AVE candle and closes the cycle at the read cap', async () => {
  const radarFixture = radar({ settings: { outcomeReadsPerCycle: 1 } });
  const baselineAt = NOW - 400_000;
  radarFixture.seedOutcome({ token: C, baselineAt });
  radarFixture.seedCheckpoint({ cycleId: 'cycle-candle-sample', chain: 'bsc', phase: 'OUTCOMES_SAMPLE', partial: { settings: radarFixture.settings } });
  radarFixture.scanner.advanceLocal('cycle-candle-sample');
  const next = radarFixture.scanner.nextRequest('cycle-candle-sample');
  assert.equal(next.kind, 'OUTCOMES_SAMPLE');
  assert.equal(recoverableRequestCost(next), 10);

  const reads = [];
  radarFixture.priceAt = async (token, targetAt, chain) => {
    reads.push({ token, targetAt, chain });
    return { price: 2, at: targetAt + 30_000, source: 'AVE_1M_CLOSE' };
  };
  const result = await radarFixture.step('cycle-candle-sample');

  assert.deepEqual(reads, [{ token: C, targetAt: baselineAt + 5 * MINUTE, chain: 'bsc' }]);
  const outcome = radarFixture.outcome(C);
  assert.equal(outcome.samples.m5.price, 2);
  assert.equal(outcome.samples.m5.return, 1);
  assert.equal(outcome.samples.m5.lagMs, 30_000);
  assert.equal(radarFixture.store.read('cycle-candle-sample').phase, 'SUMMARIZE');
  assert.equal(result.nextAveCost, 0);
});

test('a chain without secondary sources completes its source steps without a fetch and says the lead is unverified', async () => {
  const radarFixture = radar({ chain: 'robinhood' });
  let fetches = 0;
  radarFixture.secondary = new SecondaryValidator({ fetchImpl: async () => { fetches += 1; throw new Error('must not fetch'); } });
  radarFixture.seedCheckpoint({ cycleId: 'cycle-unsupported', chain: 'robinhood', phase: 'SECONDARY',
    partial: { settings: radarFixture.settings, queue: { selected: [leadItem(A)] } } });

  await radarFixture.step('cycle-unsupported', { secondary: radarFixture.secondary });
  await radarFixture.step('cycle-unsupported', { secondary: radarFixture.secondary });
  assert.equal(fetches, 0);
  assert.equal(radarFixture.store.read('cycle-unsupported').phase, 'CLASSIFY_AND_COMMIT');

  await radarFixture.step('cycle-unsupported', { secondary: radarFixture.secondary });
  const candidate = radarFixture.candidate(A);
  assert.equal(candidate.status, 'LIVE_READY');
  assert.match(candidate.decisionReason, /当前链暂无第二数据源/);
});

test('stable effect IDs include the tenant, cycle, chain, address, and effect type', () => {
  const id = stableEffectId('1000', 'cycle-1', 'sol', 'So11111111111111111111111111111111111111112', 'CANDIDATE_NEW');
  assert.equal(id, stableEffectId('1000', 'cycle-1', 'sol', 'So11111111111111111111111111111111111111112', 'CANDIDATE_NEW'));
  assert.notEqual(id, stableEffectId('1000', 'cycle-2', 'sol', 'So11111111111111111111111111111111111111112', 'CANDIDATE_NEW'));
  assert.notEqual(id, stableEffectId('1001', 'cycle-1', 'sol', 'So11111111111111111111111111111111111111112', 'CANDIDATE_NEW'));
  assert.notEqual(id, stableEffectId('1000', 'cycle-1', 'bsc', 'So11111111111111111111111111111111111111112', 'CANDIDATE_NEW'));
  assert.notEqual(id, stableEffectId('1000', 'cycle-1', 'sol', 'So11111111111111111111111111111111111111112', 'RISK_WORSENED'));
});
