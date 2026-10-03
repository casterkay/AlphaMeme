import test from 'node:test';
import assert from 'node:assert/strict';
import { DISCOVERY_REJECT, collectOutcomeSamples, dueOutcomeJobs, horizons, outcomeCohort, outcomeCoverage, sampledForRejection, selectOutcomeJobs, summarizeOutcomes } from '../src/scoring/outcomes.mjs';
import { sha256Bytes, sha256Hex } from '../src/util/crypto.mjs';

const address = '0x' + '1'.repeat(40);

test('historical samples survive delisting; missing prices stay missing and retries back off', async () => {
  const now = 1800000000000;
  const rows = [{ address, chain: 'bsc', baselineAt: now-1900000, baselinePrice: 2, cohortMetadata: { baselineProvider: 'AVE' }, initialDecision:'LIVE_READY', latestDecision:'PASSED', samples: {} }];
  const calls = [];
  const gmgn = { priceAt: async (a, at, chain) => { calls.push([a,at,chain]); return { at, price: 3, source: 'GMGN_1M_CLOSE' }; } };
  await collectOutcomeSamples(rows, gmgn, 'bsc', { now: () => now, limit: 3 });
  assert.equal(rows[0].samples.m30.return, .5);
  assert.equal(calls.length, 3);
  assert.equal(rows[0].samples.h2, undefined);
  const missing = [{ ...rows[0], samples: {} }];
  await collectOutcomeSamples(missing, { priceAt: async () => null }, 'bsc', { now: () => now, limit: 3 });
  assert.deepEqual(missing[0].samples, {});
  assert.equal(dueOutcomeJobs(missing, now).length, 0);
  assert.equal(outcomeCoverage(missing, now).passed.m30.missing, 1);
  assert.equal(outcomeCoverage(missing, now).passed.h24.eligible, 0);
});

test('AVE sampling leaves legacy and unknown baselines readable without adding cross-provider prices', async () => {
  const now = 1_800_000_000_000;
  const rows = ['AVE', 'GMGN', 'LEGACY_UNKNOWN', undefined].map((baselineProvider, index) => ({
    address: `${address.slice(0, -1)}${index}`, chain: 'bsc', baselineAt: now - 600_000,
    baselinePrice: 2, cohortMetadata: baselineProvider ? { baselineProvider } : {}, initialDecision: 'LIVE_READY', latestDecision: 'PASSED', samples: {}
  }));
  const calls = [];
  const provider = { priceAt: async token => { calls.push(token); return { at: now - 300_000, price: 3, source: 'AVE' }; } };
  assert.deepEqual(selectOutcomeJobs({ bsc: rows }, { enabledChains: ['bsc'], limit: 10, now }).map(job => job.row.address), [rows[0].address]);
  assert.deepEqual(selectOutcomeJobs({ bsc: rows }, { enabledChains: ['bsc'], provider: 'GMGN', limit: 10, now }), []);
  await collectOutcomeSamples(rows, provider, 'bsc', { now: () => now, limit: 10 });
  assert.deepEqual(calls, [rows[0].address]);
  assert.equal(rows[0].samples.m5.return, .5);
  for (const row of rows.slice(1)) assert.deepEqual(row.samples, {});
  assert.equal(outcomeCoverage(rows, now).passed.m5.eligible, 4);
});

test('WebCrypto SHA-256 helpers preserve the legacy byte and hex vectors', async () => {
  const input = 'bsc:0x0000000000000000000000000000000000000001';
  assert.equal(await sha256Hex(input), '91ee07c1272616ab0c322bbe1ab3f839cc7d25e841889843466de90898a66eec');
  assert.equal((await sha256Bytes(input))[0], 145);
  assert.deepEqual(Object.keys(horizons), ['m5', 'm15', 'm30', 'h1', 'h2', 'h6', 'h24']);
});

test('a lead counts in the cohort of its latest verdict; a discovery rejection in the control cohort', () => {
  for (const [initialDecision, latestDecision, cohort] of [
    ['LIVE_READY', 'PASSED', 'passed'],
    ['LIVE_READY', 'VETOED', 'vetoed'],
    ['LIVE_READY', 'PENDING', 'unverified'],
    ['LIVE_READY', 'INCOMPLETE', 'unverified'],
    // Rows recorded before verdicts were kept hold the candidate status.
    ['LIVE_READY', 'HARD_REJECT', 'vetoed'],
    ['LIVE_READY', 'LIVE_READY', 'unverified'],
    [DISCOVERY_REJECT, null, 'rejected'],
    // A rejection that became a lead without an AVE baseline counts nowhere.
    [DISCOVERY_REJECT, 'PENDING', null],
    ['HARD_REJECT', 'HARD_REJECT', null]
  ]) assert.equal(outcomeCohort({ initialDecision, latestDecision }), cohort, `${initialDecision} → ${latestDecision}`);
});

test('coverage reports each cohort\'s missing rate beside its median and average, and only passed leads reach the gate', () => {
  const row = (initialDecision, latestDecision, value) => ({ initialDecision, latestDecision, baselineAt: 0, samples: value === null ? {} : { m30: { return: value } } });
  const rows = [row('LIVE_READY', 'PASSED', 0.5), row('LIVE_READY', 'PASSED', -0.25), row('LIVE_READY', 'PASSED', 0.5), row('LIVE_READY', 'PASSED', null),
    row('LIVE_READY', 'VETOED', -0.9), row('LIVE_READY', 'VETOED', null), row(DISCOVERY_REJECT, null, null)];
  const summary = summarizeOutcomes(rows, horizons.m30);
  assert.deepEqual(summary.coverage.passed.m30, { eligible: 4, completed: 3, missing: 1, missingRate: 0.25, median: 0.5, average: 0.25, positiveRate: 2 / 3 });
  assert.deepEqual(summary.coverage.vetoed.m30, { eligible: 2, completed: 1, missing: 1, missingRate: 0.5, median: -0.9, average: -0.9, positiveRate: 0 });
  assert.deepEqual(summary.coverage.rejected.m30, { eligible: 1, completed: 0, missing: 1, missingRate: 1, median: null, average: null, positiveRate: null });
  assert.deepEqual(summary.coverage.unverified.m30, { eligible: 0, completed: 0, missing: 0, missingRate: null, median: null, average: null, positiveRate: null });
  assert.deepEqual([summary.tracked, summary.completed30m], [6, 3]);
  const vetoedOnly = Array.from({ length: 50 }, () => ({ initialDecision: 'LIVE_READY', latestDecision: 'VETOED', baselineAt: 0,
    samples: { m30: { return: 0 }, h2: { return: 0 }, h24: { return: 0 } } }));
  assert.equal(summarizeOutcomes(vetoedOnly, horizons.h24).calibrationReady, false);
  assert.equal(summarizeOutcomes(vetoedOnly.map(item => ({ ...item, latestDecision: 'PASSED' })), horizons.h24).calibrationReady, true);
});

test('rejection sampling keeps about one token in five, stably and whatever the address suffix', () => {
  const tokens = Array.from({ length: 5000 }, (_, index) => `0x${index.toString(16).padStart(36, '0')}4444`);
  const rate = tokens.filter(token => sampledForRejection('arc', token)).length / tokens.length;
  assert.ok(rate > 0.17 && rate < 0.23, String(rate));
  for (const token of tokens.slice(0, 50)) {
    assert.equal(sampledForRejection('arc', token), sampledForRejection('arc', token.toUpperCase().replace('0X', '0x')));
  }
});
