import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeSecurity, supplementSecurity } from '../scripts/arc-backtest/supplement.mjs';
import { collectSecurity } from '../scripts/arc-backtest/security.mjs';

test('supplemental honeypot findings override a clear flag and preserve GMGN tax priority', () => {
  assert.deepEqual(mergeSecurity({ is_honeypot: false, buy_tax: '0.01', sell_tax: '0.02' }, { is_honeypot: '1', buy_tax: '0', sell_tax: '0' }), { is_honeypot: true, buy_tax: 0.01, sell_tax: 0.02 });
});
test('AVE negative-one remains unknown and absent taxes are not manufactured', () => {
  assert.deepEqual(mergeSecurity({ honeypot: -1 }, null, { is_honeypot: -1 }), { is_honeypot: null, buy_tax: null, sell_tax: null });
  assert.equal(mergeSecurity({ honeypot: -1 }, { is_honeypot: '0' }).is_honeypot, false);
});
test('supplement requests only unresolved tokens and reuses captured evidence', async () => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), 'arc-security-'));
  let calls = 0;
  const snapshots = {
    '0xa': { data: { is_honeypot: false, buy_tax: '0', sell_tax: '0' } },
    '0xb': { data: { honeypot: -1, buy_tax: '0', sell_tax: '0' } }
  };
  const options = { cacheDirectory, goPlusIntervalMs: 0, fetchImpl: async () => { calls++; return { ok: true, status: 200, json: async () => ({ code: 1, result: { '0xb': { is_honeypot: '1' } } }) }; } };
  try {
    const first = await supplementSecurity(snapshots, options);
    assert.equal(first['0xb'].data.is_honeypot, true);
    assert.equal(calls, 1);
    const second = await supplementSecurity(snapshots, options);
    assert.deepEqual(second['0xb'].providers.goplus, first['0xb'].providers.goplus);
    assert.equal(calls, 1);
    assert.equal(snapshots['0xb'].data.honeypot, -1);
  } finally { await rm(cacheDirectory, { recursive: true }); }
});

test('a timed-out CLI child leaves an unavailable snapshot and continues the token cohort', async () => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), 'arc-security-timeout-'));
  let calls = 0;
  const executeImpl = async () => {
    if (++calls === 1) throw Object.assign(new Error('child timed out'), { code: null, killed: true, signal: 'SIGTERM', stderr: '' });
    return { stdout: JSON.stringify({ is_honeypot: false, buy_tax: '0', sell_tax: '0' }) };
  };
  try {
    const snapshots = await collectSecurity(['first', 'second'], { apiKey: 'test-key', cacheDirectory, cliPath: '/test/cli.mjs', executeImpl, requestIntervalMs: 0 });
    assert.equal(snapshots.first.status, 'unavailable');
    assert.equal(snapshots.first.error, 'timeout');
    assert.equal(snapshots.first.data, null);
    assert.equal(snapshots.second.status, 'ok');
    assert.equal(calls, 2);
  } finally { await rm(cacheDirectory, { recursive: true }); }
});
