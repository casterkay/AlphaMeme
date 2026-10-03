import test from 'node:test';
import assert from 'node:assert/strict';
import { DexBatchMarketOverlay, SecondaryValidator, aggregateSecondarySources, dexScreenerTokenUrl, secondaryChainSupport } from '../src/providers/secondary.mjs';
import { safetyVerdict } from '../src/scoring/safety.mjs';

const evmAddress = '0x1111111111111111111111111111111111111111';
const otherEvmAddress = '0x2222222222222222222222222222222222222222';

function jsonResponse(value, { status = 200, contentType = 'application/json', contentLength } = {}) {
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  const headers = new Map([
    ['content-type', contentType],
    ['content-length', String(contentLength ?? Buffer.byteLength(body, 'utf8'))]
  ]);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => headers.get(String(name).toLowerCase()) ?? null },
    text: async () => body
  };
}

function safeEvmSecurity(overrides = {}) {
  return {
    is_honeypot: '0',
    is_open_source: '1',
    is_mintable: '0',
    owner_change_balance: '0',
    hidden_owner: '0',
    cannot_sell_all: '0',
    selfdestruct: '0',
    external_call: '0',
    slippage_modifiable: '0',
    personal_slippage_modifiable: '0',
    transfer_pausable: '0',
    is_blacklisted: '0',
    trading_cooldown: '0',
    buy_tax: '0.01',
    sell_tax: '0.02',
    ...overrides
  };
}

function completeDexPair(overrides = {}) {
  return {
    chainId: 'bsc',
    dexId: 'pancakeswap',
    pairAddress: '0x3333333333333333333333333333333333333333',
    url: 'https://dexscreener.com/bsc/pair',
    baseToken: { address: evmAddress, symbol: 'DOG', name: 'Test Dog' },
    priceUsd: '0.000012',
    marketCap: 50_000,
    fdv: 52_000,
    liquidity: { usd: 12_000 },
    volume: { m5: 750 },
    pairCreatedAt: 1_700_000_000_000,
    info: {
      websites: [
        { url: 'https://dog.example' },
        { url: 'javascript:alert(1)' },
        { url: 'https://dog.example' }
      ]
    },
    upstream_private_field: 'must-not-leak',
    ...overrides
  };
}

test('batch market overlay fills every requested live card with exact pool fields in one request', async () => {
  const calls = [], at = 1_800_000_000_000;
  const fetchImpl = async url => {
    calls.push(url);
    return jsonResponse([
      completeDexPair({ pairAddress: '0x' + '3'.repeat(40), liquidity: { usd: 8_000 }, volume: { m5: 300 }, pairCreatedAt: at - 600_000 }),
      completeDexPair({ pairAddress: '0x' + '4'.repeat(40), liquidity: { usd: 18_000 }, volume: { m5: 900 },
        txns: { m5: { buys: 7, sells: 3 } }, pairCreatedAt: at - 900_000 }),
      completeDexPair({ baseToken: { address: otherEvmAddress }, pairAddress: '0x' + '5'.repeat(64),
        liquidity: { usd: 9_000 }, volume: { m5: 125 }, pairCreatedAt: at - 1_200_000, marketCap: 60_000 }),
      completeDexPair({ chainId: 'ethereum', liquidity: { usd: 999_999 } }),
      completeDexPair({ pairCreatedAt: at + 600_000, liquidity: { usd: 999_999 } })
    ]);
  };
  const rows = [
    { address: evmAddress, chain: 'bsc', marketProvider: 'AVE', market_cap: 50_000, price: 1, capturedAt: at - 120_000, sourceUpdatedAt: at - 120_000 },
    { address: otherEvmAddress, chain: 'bsc', marketProvider: 'AVE', market_cap: 60_000, price: 2, capturedAt: at - 120_000, sourceUpdatedAt: at - 120_000 },
    { address: '0x' + '9'.repeat(40), chain: 'bsc', marketProvider: 'AVE', market_cap: 500_000, price: 3 }
  ];
  const overlay = new DexBatchMarketOverlay({ fetchImpl, now: () => at });
  const result = await overlay.enrich('bsc', rows, { minMarketCap: 10_000, maxMarketCap: 150_000 });

  assert.equal(calls.length, 1);
  assert.match(calls[0], new RegExp('/tokens/v1/bsc/' + evmAddress + ',' + otherEvmAddress + '$'));
  assert.equal(result[0].liquidity, 18_000);
  assert.equal(result[0].volume_5m, 900);
  assert.deepEqual([result[0].buys_5m, result[0].sells_5m, result[0].swaps_5m], [7, 3, 10]);
  assert.equal(result[0].pool_created_at, Math.floor((at - 900_000) / 1_000));
  assert.equal(result[0].pairAddress, '0x' + '4'.repeat(40));
  assert.equal(result[0].sourceUpdatedAt, at);
  assert.equal(result[0].marketOverlayProvider, 'DEXSCREENER');
  assert.equal(result[1].liquidity, 9_000);
  assert.equal(result[1].volume_5m, 125);
  assert.equal(result[2], rows[2]);
});

test('batch overlay never applies base-token price or market cap to a requested quote token', async () => {
  const at = 1_800_000_000_000, third = '0x' + '7'.repeat(40);
  const fetchImpl = async () => jsonResponse([completeDexPair({
    baseToken: { address: third, symbol: 'BASE', name: 'Base' },
    quoteToken: { address: evmAddress, symbol: 'QUOTE', name: 'Quote' },
    pairAddress: '0x' + '8'.repeat(40), priceUsd: '999', marketCap: 999_999,
    liquidity: { usd: 20_000 }, volume: { m5: 400 }, txns: { m5: { buys: 9, sells: 1 } }, pairCreatedAt: at - 600_000
  })]);
  const row = { address: evmAddress, chain: 'bsc', marketProvider: 'AVE', market_cap: 50_000, price: 1,
    buys_5m: 5, sells_5m: 4, buy_volume_5m: 80, sell_volume_5m: 70,
    volume: 150, swaps: 9, buys: 5, sells: 4,
    marketCapSourceUpdatedAt: at, marketCapCapturedAt: at, marketCapExpiresAt: at + 20_000 };
  const [result] = await new DexBatchMarketOverlay({ fetchImpl, now: () => at }).enrich('bsc', [row], {
    minMarketCap: 10_000, maxMarketCap: 150_000
  });
  assert.equal(result.liquidity, 20_000);
  assert.equal(result.volume_5m, 400);
  assert.equal(result.market_cap, 50_000);
  assert.equal(result.price, null);
  assert.deepEqual([result.buys_5m, result.sells_5m, result.swaps_5m], [null, null, 10]);
  for (const field of ['buy_volume_5m', 'sell_volume_5m', 'volume', 'swaps', 'buys', 'sells']) assert.equal(result[field], null);
  assert.equal(result.marketOverlayPriceUpdated, false);
});

test('batch overlay never mixes a different Dex pool with pair-scoped AVE evidence', async () => {
  const at = 1_800_000_000_000, avePair = '0x' + 'a'.repeat(40), dexPair = '0x' + 'b'.repeat(40);
  const fetchImpl = async () => jsonResponse([completeDexPair({
    pairAddress: dexPair, liquidity: { usd: 99_000 }, volume: { m5: 9_000 }, pairCreatedAt: at - 600_000
  })]);
  const row = { address: evmAddress, chain: 'bsc', marketProvider: 'AVE', market_cap: 50_000, price: 1,
    liquidity: 5_000, volume_5m: 10, pairAddress: avePair,
    poolEvidence: { source: 'AVE', identityBasis: 'response', chain: 'bsc', pair: avePair,
      target_token: evmAddress, token0_address: evmAddress, token1_address: otherEvmAddress } };
  const [result] = await new DexBatchMarketOverlay({ fetchImpl, now: () => at }).enrich('bsc', [row], {
    minMarketCap: 10_000, maxMarketCap: 150_000
  });
  assert.equal(result, row);
  assert.equal(result.liquidity, 5_000);
  assert.equal(result.volume_5m, 10);
  assert.equal(result.pairAddress, avePair);
});

test('batch market overlay shares in-flight work, caches it and fails back to original AVE rows', async () => {
  let calls = 0, at = 1_800_000_000_000, release;
  const response = jsonResponse([completeDexPair({ pairAddress: '0x' + '3'.repeat(40), pairCreatedAt: at - 600_000 })]);
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) return new Promise(resolve => { release = () => resolve(response); });
    throw new Error('offline');
  };
  const row = { address: evmAddress, chain: 'bsc', marketProvider: 'AVE', market_cap: 50_000, price: 1 };
  const overlay = new DexBatchMarketOverlay({ fetchImpl, now: () => at, ttlMs: 5_000, staleTtlMs: 10_000 });
  const first = overlay.enrich('bsc', [row], { minMarketCap: 10_000, maxMarketCap: 150_000 });
  const second = overlay.enrich('bsc', [row], { minMarketCap: 10_000, maxMarketCap: 150_000 });
  await new Promise(resolve => setImmediate(resolve)); release();
  assert.equal((await first)[0].liquidity, 12_000);
  assert.equal((await second)[0].liquidity, 12_000);
  assert.equal(calls, 1);
  at += 6_000;
  assert.equal((await overlay.enrich('bsc', [row], { minMarketCap: 10_000, maxMarketCap: 150_000 }))[0].liquidity, 12_000);
  assert.equal(calls, 2);
  at += 5_000;
  const original = await overlay.enrich('bsc', [row], { minMarketCap: 10_000, maxMarketCap: 150_000 });
  assert.equal(original[0], row);
});

// A GoPlus stub that records every call and answers `security(url, init)`.
function goPlusStub(security) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => { calls.push({ url: String(url), init }); return security(String(url), init); };
  return { calls, fetchImpl };
}
const securityOf = record => () => jsonResponse({ code: 1, result: { [evmAddress]: record } });
const validatorWith = (stub, options = {}) => new SecondaryValidator({ fetchImpl: stub.fetchImpl, ...options });

test('a BSC check reads GoPlus chain 56 and exposes only allowlisted fields', async () => {
  const stub = goPlusStub(() => jsonResponse({ code: 1, result: { [evmAddress.toUpperCase()]: { ...safeEvmSecurity(), untrusted_blob: 'must-not-leak' } } }));
  const result = await validatorWith(stub).fetchSource({ chain: 'bsc', tokenAddress: evmAddress });
  assert.deepEqual(stub.calls.map(call => call.url), [`https://api.gopluslabs.io/api/v1/token_security/56?contract_addresses=${evmAddress}`]);
  assert.equal(result.source.status, 'OK');
  assert.equal(result.security.verdict, 'NO_FATAL_FLAGS');
  assert.equal(result.security.buyTax, 0.01);
  assert.equal(result.security.sellTax, 0.02);
  assert.equal(JSON.stringify(result).includes('must-not-leak'), false);
});

test('GoPlus fatal flags are not softened', async () => {
  const stub = goPlusStub(securityOf(safeEvmSecurity({ is_honeypot: '1', is_open_source: '0' })));
  const result = await validatorWith(stub).fetchSource({ chain: 'bsc', tokenAddress: evmAddress });
  assert.equal(result.security.verdict, 'FATAL');
  assert.deepEqual(result.security.fatal.map(row => row.field).sort(), ['isHoneypot', 'openSource']);
});

for (const [taxes, fatal] of [
  [{ buy_tax: '0.05', sell_tax: '0.05' }, []],
  [{ buy_tax: '0.06', sell_tax: '0.05' }, ['buyTax']],
  [{ buy_tax: '0', sell_tax: '0.3' }, ['sellTax']],
  [{ buy_tax: '0', sell_tax: '1' }, ['sellTax']],
  [{ buy_tax: '0', sell_tax: '0.05' }, []],
  [{ buy_tax: '', sell_tax: '0.3' }, ['sellTax']]
]) {
  test(`GoPlus taxes of ${taxes.buy_tax || 'unknown'} buy and ${taxes.sell_tax} sell veto on ${fatal.join(', ') || 'nothing'}`, async () => {
    const stub = goPlusStub(securityOf(safeEvmSecurity(taxes)));
    const { security } = await validatorWith(stub).fetchSource({ chain: 'bsc', tokenAddress: evmAddress });
    assert.deepEqual(security.fatal.map(row => row.field), fatal);
    if (fatal.length) assert.equal(security.verdict, 'FATAL');
  });
}

test('missing or malformed GoPlus safety fields stay UNKNOWN and degrade the check', async () => {
  const stub = goPlusStub(securityOf({ is_honeypot: 'unknown', is_open_source: '1' }));
  const value = await validatorWith(stub).fetchSource({ chain: 'bsc', tokenAddress: evmAddress });
  const result = aggregateSecondarySources({ chain: 'bsc', tokenAddress: evmAddress, sources: { goPlus: { value, collectedAt: 5 } } });
  assert.equal(result.status, 'DEGRADED');
  assert.equal(result.complete, false);
  assert.equal(result.checkedAt, 5);
  assert.equal(result.sources.goPlus.status, 'OK');
  assert.equal(result.security.verdict, 'UNKNOWN');
  assert.equal(result.security.fields.isHoneypot, null);
  assert.ok(result.security.unknownFields.includes('isHoneypot'));
  assert.ok(result.security.unknownFields.includes('buyTax'));
});

test('a complete GoPlus record makes the check COMPLETE, whatever else an older checkpoint recorded', () => {
  const goPlus = { value: { source: { status: 'OK' }, security: { complete: true, verdict: 'NO_FATAL_FLAGS', fatal: [], unknownFields: [], fields: {} } }, collectedAt: 7 };
  const result = aggregateSecondarySources({ chain: 'bsc', tokenAddress: evmAddress, sources: { dexScreener: { error: { code: 'HTTP_429' }, collectedAt: 6 }, goPlus } });
  assert.equal(result.status, 'COMPLETE');
  assert.deepEqual(Object.keys(result.sources), ['goPlus']);
  assert.equal(result.checkedAt, 7);
});

// GoPlus omits cannot_sell_all on Arc; AVE's distinct sellers stand in for that field there only.
for (const [name, chain, overrides, distinctSellers24h, expected, standIn] of [
  ['an Arc record missing only cannot_sell_all, with sellers', 'arc', { cannot_sell_all: undefined }, 410, 'PASSED', 410],
  ['an Arc record missing only cannot_sell_all, with one seller', 'arc', { cannot_sell_all: undefined }, 1, 'PASSED', 1],
  ['an Arc record missing only cannot_sell_all, without sellers', 'arc', { cannot_sell_all: undefined }, null, 'INCOMPLETE', null],
  ['an Arc record missing only cannot_sell_all, with zero sellers', 'arc', { cannot_sell_all: undefined }, 0, 'INCOMPLETE', null],
  ['a BSC record missing cannot_sell_all, with sellers', 'bsc', { cannot_sell_all: undefined }, 410, 'INCOMPLETE', null],
  ['an Arc record missing cannot_sell_all and is_honeypot, with sellers', 'arc', { cannot_sell_all: undefined, is_honeypot: undefined }, 410, 'INCOMPLETE', 410],
  ['an Arc record where GoPlus answers cannot_sell_all, with sellers', 'arc', {}, 410, 'PASSED', null],
  ['an Arc honeypot missing cannot_sell_all, with sellers', 'arc', { cannot_sell_all: undefined, is_honeypot: '1' }, 410, 'VETOED', 410]
]) {
  test(`${name} is ${expected}${standIn === null ? '' : ' and records the seller stand-in'}`, async () => {
    const value = await validatorWith(goPlusStub(securityOf(safeEvmSecurity(overrides)))).fetchSource({ chain, tokenAddress: evmAddress });
    const goPlusSecurity = structuredClone(value.security);
    const secondary = aggregateSecondarySources({ chain, tokenAddress: evmAddress, sources: { goPlus: { value, collectedAt: 5 } }, distinctSellers24h });
    assert.equal(safetyVerdict({ status: 'LIVE_READY', secondary }), expected);
    assert.deepEqual(secondary.security.standIns, standIn === null ? undefined : { cannotSellAll: { distinctSellers24h: standIn } });
    assert.equal(secondary.security.unknownFields.includes('cannotSellAll'), Object.hasOwn(overrides, 'cannot_sell_all') && standIn === null);
    // GoPlus's own answer is kept as given: the stand-in never fills its field.
    assert.equal(secondary.security.fields.cannotSellAll, Object.hasOwn(overrides, 'cannot_sell_all') ? null : false);
    assert.deepEqual(value.security, goPlusSecurity);
  });
}

test('unsupported chains and invalid addresses never make external requests', async () => {
  for (const [chain, tokenAddress, expected] of [
    ['robinhood', evmAddress, { status: 'UNSUPPORTED' }],
    ['stable', evmAddress, { status: 'UNSUPPORTED' }],
    ['base', 'not-an-address', { status: 'ERROR', errorCode: 'INVALID_ADDRESS' }]
  ]) {
    const stub = goPlusStub(() => { throw new Error('must not be called'); });
    const result = await validatorWith(stub).fetchSource({ chain, tokenAddress });
    assert.equal(stub.calls.length, 0);
    assert.deepEqual(result.source, expected);
  }
});

test('timeouts and upstream parse failures are recorded without rejecting the check', async () => {
  const neverFetch = goPlusStub((_url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  }));
  const timeout = await validatorWith(neverFetch, { timeoutMs: 5 }).fetchSource({ chain: 'eth', tokenAddress: evmAddress });
  assert.equal(timeout.source.errorCode, 'TIMEOUT');

  const malformed = await validatorWith(goPlusStub(() => jsonResponse('{ definitely-not-json'))).fetchSource({ chain: 'eth', tokenAddress: evmAddress });
  assert.equal(malformed.source.errorCode, 'INVALID_JSON');
  const large = await validatorWith(goPlusStub(() => jsonResponse('{}', { contentLength: 2_000 })), { maxResponseBytes: 1_024 })
    .fetchSource({ chain: 'eth', tokenAddress: evmAddress });
  assert.equal(large.source.errorCode, 'RESPONSE_TOO_LARGE');
});

test('exported support map contains only verified chain identifiers', () => {
  assert.deepEqual(secondaryChainSupport.dexScreener, {
    bsc: 'bsc', base: 'base', eth: 'ethereum', arc: 'arc'
  });
  assert.deepEqual(secondaryChainSupport.goPlus, {
    eth: '1', bsc: '56', base: '8453', arc: '5042'
  });
});

test('Arc tokens are checked on GoPlus chain 5042', async () => {
  const stub = goPlusStub(() => Response.json({}));
  await validatorWith(stub).fetchSource({ chain: 'arc', tokenAddress: evmAddress });
  assert.ok(stub.calls[0].url.startsWith('https://api.gopluslabs.io/api/v1/token_security/5042?'));
});

test('the chart link opens the token on DexScreener only for a chain it lists', () => {
  assert.equal(dexScreenerTokenUrl('eth', evmAddress.toUpperCase().replace('0X', '0x')), `https://dexscreener.com/ethereum/${evmAddress}`);
  assert.equal(dexScreenerTokenUrl('robinhood', evmAddress), '');
  assert.equal(dexScreenerTokenUrl('bsc', 'not-an-address'), '');
});
