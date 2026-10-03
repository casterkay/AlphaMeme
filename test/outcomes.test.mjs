import test from 'node:test';
import assert from 'node:assert/strict';
import { collectOutcomeSamples, dueOutcomeJobs, horizons, outcomeCoverage, sampleRejected, selectOutcomeJobs } from '../src/scoring/outcomes.mjs';
import { sha256Bytes, sha256Hex } from '../src/util/crypto.mjs';

const address = '0x' + '1'.repeat(40);

test('historical samples survive delisting; missing prices stay missing and retries back off', async () => {
  const now = 1800000000000;
  const rows = [{ address, chain: 'bsc', baselineAt: now-1900000, baselinePrice: 2, cohortMetadata: { baselineProvider: 'AVE' }, initialDecision:'LIVE_READY', samples: {} }];
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
    baselinePrice: 2, cohortMetadata: baselineProvider ? { baselineProvider } : {}, initialDecision: 'LIVE_READY', samples: {}
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

test('rejection cohort is deterministic and separated from passed outcomes', async () => {
  const rows = [];
  for (let i=1;i<100;i++) await sampleRejected(rows, { chain:'bsc', address:'0x'+i.toString(16).padStart(40,'0'), price: 1, status:'HARD_REJECT' }, 10);
  assert.ok(rows.length > 5 && rows.length < 40);
  assert.equal(rows.length, 33);
  assert.deepEqual(rows.slice(0, 4).map(row => row.address), [
    '0x0000000000000000000000000000000000000001',
    '0x0000000000000000000000000000000000000002',
    '0x0000000000000000000000000000000000000005',
    '0x0000000000000000000000000000000000000006'
  ]);
  const count = rows.length;
  for (const row of [...rows]) await sampleRejected(rows, { ...row, price:1, status:'HARD_REJECT' }, 20);
  assert.equal(rows.length, count);
  assert.equal(outcomeCoverage(rows, 1900000).passed.m30.eligible, 0);
  assert.equal(outcomeCoverage(rows, 1900000).rejected.m30.eligible, count);
});

test('rejection sampling uses the legacy SHA-256 first byte modulo five rule', async () => {
  const candidate = { chain: 'bsc', address: '0x0000000000000000000000000000000000000001', price: 1, status: 'HARD_REJECT' };
  const rows = await sampleRejected([], candidate, 10);
  assert.deepEqual(rows.map(row => row.address), [candidate.address]);
  assert.equal(rows[0].cohortMetadata.baselineProvider, 'LEGACY_UNKNOWN');
});
