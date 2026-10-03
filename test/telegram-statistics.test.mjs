import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readTelegramStatistics, STATISTICS_CHAINS } from '../src/bot/statistics.mjs';
import { horizons, summarizeOutcomes } from '../src/scoring/outcomes.mjs';

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE outcomes (tenant_id TEXT, chain TEXT, initial_decision TEXT, latest_decision TEXT, baseline_at INTEGER, samples_json TEXT)');
  return {
    storage: { sql: { exec: (query, ...values) => ({ toArray: () => db.prepare(query).all(...values) }) } },
    insert({ tenant = '1', chain = 'robinhood', decision = 'LIVE_READY', verdict = 'PASSED', baseline = 1000, samples = {} } = {}) {
      db.prepare('INSERT INTO outcomes VALUES (?, ?, ?, ?, ?, ?)').run(tenant, chain, decision, verdict, baseline, JSON.stringify(samples));
    }
  };
}

test('SQL statistics isolate tenants and chains and split cohorts by the recorded verdict', t => {
  const { storage, insert } = fixture(t);
  insert({ samples: { m30: { return: 0.2 } } });
  insert({ decision: 'DISCOVERY_REJECT', verdict: null, samples: { m30: { return: -0.5 } } });
  insert({ verdict: 'VETOED', samples: { m30: { return: -0.9 } } });
  insert({ tenant: '2', samples: { m30: { return: 99 } } });
  insert({ chain: 'bsc', samples: { m30: { return: 0.7 } } });
  const stats = readTelegramStatistics(storage, '1', 90_000_000);
  assert.deepEqual(Object.keys(stats), STATISTICS_CHAINS);
  assert.equal(stats.robinhood.tracked, 2);
  assert.equal(stats.robinhood.coverage.passed.m30.median, 0.2);
  assert.equal(stats.robinhood.coverage.rejected.m30.median, -0.5);
  assert.equal(stats.robinhood.coverage.vetoed.m30.median, -0.9);
  assert.equal(stats.bsc.coverage.passed.m30.median, 0.7);
  assert.equal(stats.eth.coverage.passed.m30.median, null);
});

test('all seven windows use exact eligibility boundaries and preserve missing samples as unknown', t => {
  const { storage, insert } = fixture(t);
  insert();
  for (const [window, duration] of Object.entries(horizons)) {
    assert.equal(readTelegramStatistics(storage, '1', 999 + duration).robinhood.coverage.passed[window].eligible, 0);
    assert.deepEqual(readTelegramStatistics(storage, '1', 1000 + duration).robinhood.coverage.passed[window], {
      eligible: 1, completed: 0, missing: 1, missingRate: 1, median: null, average: null, positiveRate: null
    });
  }
});

test('the calibration gate needs 50 samples in each of 30m, 2h and 24h', t => {
  const { storage, insert } = fixture(t);
  for (let index = 0; index < 50; index++) insert({ samples: { m30: { return: 0 }, h2: { return: 0 } } });
  let stats = readTelegramStatistics(storage, '1', 90_000_000).robinhood;
  assert.deepEqual(stats.readyWindows, ['m30', 'h2']);
  assert.equal(stats.calibrationReady, false);
  for (let index = 0; index < 49; index++) insert({ samples: { h24: { return: 0 } } });
  assert.equal(readTelegramStatistics(storage, '1', 90_000_000).robinhood.calibrationReady, false);
  insert({ samples: { h24: { return: 0 } } });
  stats = readTelegramStatistics(storage, '1', 90_000_000).robinhood;
  assert.equal(stats.calibrationReady, true);
  assert.deepEqual(stats.readyWindows, ['m30', 'h2', 'h24']);
  assert.equal(stats.coverage.passed.h24.median, 0);
});

test('SQL coverage shares the outcome summary contract including median and positive-return rate', t => {
  const { storage, insert } = fixture(t);
  const rows = [-0.2, 0, 0.4, null].map(value => ({ initialDecision: 'LIVE_READY', latestDecision: 'PASSED', baselineAt: 1000, samples: { h6: { return: value }, m30: { return: value } } }));
  for (const row of rows) insert({ samples: row.samples });
  const { available, generatedAt, readyWindows, ...summary } = readTelegramStatistics(storage, '1', 90_000_000).robinhood;
  assert.deepEqual(summary, summarizeOutcomes(rows, 90_000_000));
  assert.deepEqual(summary.coverage.passed.h6, { eligible: 4, completed: 3, missing: 1, missingRate: 0.25, median: 0, average: summary.coverage.passed.h6.average, positiveRate: 1 / 3 });
  assert.ok(Math.abs(summary.coverage.passed.h6.average - 0.2 / 3) < 1e-12);
});

test('unavailable or corrupt storage never becomes an empty successful statistics report', t => {
  assert.throws(() => readTelegramStatistics(null, '1', 0), /STATISTICS_STORAGE_UNAVAILABLE/);
  const { storage, insert } = fixture(t);
  insert({ baseline: null });
  assert.throws(() => readTelegramStatistics(storage, '1', 90_000_000), /STATISTICS_OUTCOME_CORRUPT/);
});
