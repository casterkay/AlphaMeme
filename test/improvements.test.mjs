import test from 'node:test';
import assert from 'node:assert/strict';
import { GmgnClient, tokenInfoPrice, translateGmgnError } from '../src/providers/gmgn.mjs';
import { collectOutcomeSamples, dueOutcomeJobs, horizons, outcomeCoverage, sampleRejected } from '../src/scoring/outcomes.mjs';
import { sha256Bytes, sha256Hex } from '../src/util/crypto.mjs';

const address = '0x' + '1'.repeat(40);

test('weighted request pacing, bounded cache and credential invalidation', async () => {
  const client = new GmgnClient({ minRequestGapMs: 0 });
  let calls = 0;
  const read = () => ({ count: ++calls });
  client.tokenInfo = async () => read();
  client.tokenSecurity = async () => read();
  client.tokenPoolInfo = async () => read();
  client.tokenTopHolders = async () => read();
  client.tokenTopTraders = async () => read();
  client.tokenKline = async () => ({ list: [] });
  await client.audit(address, 1_800_000_000, 'bsc');
  assert.equal(calls, 5);
  await client.audit(address, 1_800_000_000, 'bsc');
  assert.equal(calls, 5);
  client.nextAllowedAt = Date.now() + 60000;
  client.resetCredentials();
  await client.audit(address, 1_800_000_000, 'bsc');
  assert.equal(calls, 10);
  assert.ok(client.nextAllowedAt > Date.now());
  assert.equal(client.metrics.cacheHits, 6);
  assert.equal(tokenInfoPrice({ price: { price: '0.025' } }), 0.025);
  assert.equal(tokenInfoPrice({ price: '' }), null);
  const cooldown = translateGmgnError({ status: 429, resetAtUnix: Math.ceil(Date.now()/1000) + 120 });
  assert.ok(cooldown.retryAfterMs >= 120000);
});

test('confirmed static rejection skips expensive wallet and candle reads', async () => {
  const client = new GmgnClient(); const commands = [];
  client.tokenInfo = async () => { commands.push('info'); return { is_honeypot: 'yes' }; };
  client.tokenSecurity = async () => { commands.push('security'); return { is_honeypot: 'yes' }; };
  client.tokenPoolInfo = async () => { commands.push('pool'); return { is_honeypot: 'yes' }; };
  client.tokenTopHolders = async () => { commands.push('holders'); return { list: [] }; };
  client.tokenTopTraders = async () => { commands.push('traders'); return { list: [] }; };
  client.tokenKline = async () => { commands.push('kline'); return { list: [] }; };
  const audit = await client.audit(address, 1800000000, 'bsc', { shouldStopEarly: partial => partial.security.is_honeypot === 'yes' });
  assert.deepEqual(commands, ['info','security','pool']);
  assert.equal(audit._meta.earlyExit, true);
  assert.equal(audit._meta.complete, false);
});

test('historical samples survive delisting; missing prices stay missing and retries back off', async () => {
  const now = 1800000000000;
  const rows = [{ address, chain: 'bsc', baselineAt: now-1900000, baselinePrice: 2, initialDecision:'X_REVIEW', samples: {} }];
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

test('priceAt selects timestamped closed candles, not current price or future bars', async () => {
  const client = new GmgnClient();
  const target = Date.now() - 86400000;
  client.tokenKline = async () => ({ list: [{ time: target - 60000, close: '2' }, { time: Date.now() + 60000, close: '99' }] });
  assert.deepEqual(await client.priceAt(address, target, 'bsc'), { at: target, price:2, source:'GMGN_1M_CLOSE' });
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
});
