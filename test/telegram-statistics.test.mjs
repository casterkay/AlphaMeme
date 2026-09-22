import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readTelegramStatistics, STATISTICS_CHAINS } from '../src/bot/statistics.mjs';
import { summarizeOutcomes as scannerSummary } from '../src/scanner.mjs';
import { horizons, summarizeOutcomes } from '../src/scoring/outcomes.mjs';

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE outcomes (tenant_id TEXT, chain TEXT, initial_decision TEXT, baseline_at INTEGER, samples_json TEXT)');
  return {
    storage: { sql: { exec: (query, ...values) => ({ toArray: () => db.prepare(query).all(...values) }) } },
    insert({ tenant = '1', chain = 'sol', decision = 'X_REVIEW', baseline = 1000, samples = {} } = {}) {
      db.prepare('INSERT INTO outcomes VALUES (?, ?, ?, ?, ?)').run(tenant, chain, decision, baseline, JSON.stringify(samples));
    }
  };
}

test('SQL statistics isolate tenants and chains and keep original rejected cohort membership', t => {
  const { storage, insert } = fixture(t);
  insert({ samples: { m30: { return: 0.2 } } });
  insert({ decision: 'HARD_REJECT', samples: { m30: { return: -0.5 } } });
  insert({ tenant: '2', samples: { m30: { return: 99 } } });
  insert({ chain: 'bsc', samples: { m30: { return: 0.7 } } });
  const stats = readTelegramStatistics(storage, '1', 90_000_000);
  assert.deepEqual(Object.keys(stats), STATISTICS_CHAINS);
  assert.equal(stats.sol.tracked, 1);
  assert.equal(stats.sol.averageReturn30m, 0.2);
  assert.equal(stats.sol.coverage.rejected.m30.median, -0.5);
  assert.equal(stats.bsc.averageReturn30m, 0.7);
  assert.equal(stats.eth.averageReturn30m, null);
});

test('all seven windows use exact eligibility boundaries and preserve missing samples as unknown', t => {
  const { storage, insert } = fixture(t);
  insert();
  for (const [window, duration] of Object.entries(horizons)) {
    assert.equal(readTelegramStatistics(storage, '1', 999 + duration).sol.coverage.passed[window].eligible, 0);
    assert.deepEqual(readTelegramStatistics(storage, '1', 1000 + duration).sol.coverage.passed[window], {
      eligible: 1, completed: 0, missing: 1, median: null, positiveRate: null
    });
  }
  const summary = readTelegramStatistics(storage, '1', 90_000_000).sol;
  assert.equal(summary.averageReturn30m, null);
  assert.equal(Object.hasOwn(summary, 'averageReturn6h'), false);
});

test('the calibration gate needs 50 samples in each of 30m, 2h and 24h', t => {
  const { storage, insert } = fixture(t);
  for (let index = 0; index < 50; index++) insert({ samples: { m30: { return: 0 }, h2: { return: 0 } } });
  let stats = readTelegramStatistics(storage, '1', 90_000_000).sol;
  assert.deepEqual(stats.readyWindows, ['m30', 'h2']);
  assert.equal(stats.calibrationReady, false);
  for (let index = 0; index < 49; index++) insert({ samples: { h24: { return: 0 } } });
  assert.equal(readTelegramStatistics(storage, '1', 90_000_000).sol.calibrationReady, false);
  insert({ samples: { h24: { return: 0 } } });
  stats = readTelegramStatistics(storage, '1', 90_000_000).sol;
  assert.equal(stats.calibrationReady, true);
  assert.deepEqual(stats.readyWindows, ['m30', 'h2', 'h24']);
  assert.equal(stats.averageReturn24h, 0);
});

test('SQL coverage and averages share the scanner contract including median and positive-return rate', t => {
  assert.equal(scannerSummary, summarizeOutcomes);
  const { storage, insert } = fixture(t);
  const rows = [-0.2, 0, 0.4, null].map(value => ({ initialDecision: 'X_REVIEW', baselineAt: 1000, samples: { h6: { return: value }, m30: { return: value } } }));
  for (const row of rows) insert({ samples: row.samples });
  const { available, generatedAt, readyWindows, ...summary } = readTelegramStatistics(storage, '1', 90_000_000).sol;
  assert.deepEqual(summary, summarizeOutcomes(rows, 90_000_000));
  assert.deepEqual(summary.coverage.passed.h6, { eligible: 4, completed: 3, missing: 1, median: 0, positiveRate: 1 / 3 });
  assert.equal(summary.averageReturn30m, (-0.2 + 0.4) / 3);
});

test('unavailable or corrupt storage never becomes an empty successful statistics report', t => {
  assert.throws(() => readTelegramStatistics(null, '1', 0), /STATISTICS_STORAGE_UNAVAILABLE/);
  const { storage, insert } = fixture(t);
  insert({ baseline: null });
  assert.throws(() => readTelegramStatistics(storage, '1', 90_000_000), /STATISTICS_OUTCOME_CORRUPT/);
});
