import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeSecurity, supplementSecurity } from '../scripts/arc-backtest/supplement.mjs';

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
