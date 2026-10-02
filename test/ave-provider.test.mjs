import assert from 'node:assert/strict';
import test from 'node:test';
import { AVE_CU, AveClient, AveError, normalizeAveApiKey, verifyAveApiKey } from '../src/providers/ave.mjs';
import { scannerSettings } from '../src/scanner-settings.mjs';
import { discoveryScreen } from '../src/scoring/index.mjs';

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const API_KEY = 'ave-provider-test-key';
const BSC_TOKEN = `0x${'a'.repeat(40)}`;
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';

// A hand-written fetch that records each request and answers with `respond`.
function stubFetch(respond) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  return { calls, fetchImpl };
}

function client(respond, options = {}) {
  const stub = stubFetch(respond);
  return { ...stub, ave: new AveClient({ apiKey: API_KEY, fetchImpl: stub.fetchImpl, now: () => NOW, ...options }) };
}

function tokenRow(token, chain = 'bsc', fields = {}) {
  return {
    token, chain, symbol: 'TEST', name: 'Test token', current_price_usd: '0.0012', market_cap: 50_000, main_pair_tvl: 20_000,
    token_tx_volume_usd_5m: 4_000, holders: 150, updated_at: (NOW - 10_000) / 1000, launch_at: (NOW - 3_600_000) / 1000, ...fields
  };
}

const envelope = tokens => Response.json({ status: 1, data: { tokens } });

async function rejectsWith(promise, code, check = () => true) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof AveError, `expected AveError, got ${error}`);
    assert.equal(error.code, code);
    return check(error) !== false;
  });
}

for (const [chain, slug, token] of [['arc', 'arc', BSC_TOKEN], ['bsc', 'bsc', BSC_TOKEN], ['robinhood', 'robinhood', BSC_TOKEN]]) {
  test(`trending on ${chain} requests the ${slug} slug with the API key header`, async () => {
    const { ave, calls } = client(() => envelope([tokenRow(token, slug)]));
    const result = await ave.trending(chain);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `https://prod.ave-api.com/v2/tokens/trending?chain=${slug}&current_page=0&page_size=100`);
    assert.equal(calls[0].init.method, 'GET');
    assert.equal(calls[0].init.headers['X-API-KEY'], API_KEY);
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].address, token);
    assert.equal(result.rows[0].chain, chain);
  });
}

test('trending parses rows into fresh AVE market rows with their quote clocks', async () => {
  const { ave } = client(() => envelope([tokenRow(BSC_TOKEN)]));
  const { rows, capturedAt } = await ave.trending('bsc');
  const [row] = rows;

  assert.equal(capturedAt, NOW);
  assert.equal(row.marketProvider, 'AVE');
  assert.equal(row.price, 0.0012);
  assert.equal(row.market_cap, 50_000);
  assert.equal(row.liquidity, 20_000);
  assert.equal(row.liquidityBasis, 'main_pair_tvl');
  assert.equal(row.volume_5m, 4_000);
  assert.equal(row.capturedAt, NOW);
  assert.equal(row.sourceUpdatedAt, NOW - 10_000);
  assert.equal(row.expiresAt, NOW - 10_000 + 30_000);
  assert.equal(row.stale, false);
  assert.equal(row.creation_timestamp, (NOW - 3_600_000) / 1000);
  assert.equal(row.ageBasis, 'launch');
  assert.equal(Object.hasOwn(row, 'aveUrl'), false);
  assert.equal(AVE_CU.trending, 5);
});

test('trending drops a single malformed row and keeps the valid ones', async () => {
  const other = `0x${'b'.repeat(40)}`;
  const { ave } = client(() => envelope([tokenRow(BSC_TOKEN), tokenRow(other, 'bsc', { current_price_usd: 0 })]));
  const { rows } = await ave.trending('bsc');
  assert.deepEqual(rows.map(row => row.address), [BSC_TOKEN]);
});

test('trending reads AVE percent taxes as rates so the screen drops only high-tax tokens before any alert', async () => {
  const cases = [
    { buy_tax: '1.0', sell_tax: '1.0', rates: [0.01, 0.01], rejected: false },
    { buy_tax: '3.0', sell_tax: '5.0', rates: [0.03, 0.05], rejected: false },
    { buy_tax: '0.0', sell_tax: '100.0', rates: [0, 1], rejected: true },
    { buy_tax: '0', sell_tax: '5.5', rates: [0, 0.055], rejected: true },
    { buy_tax: '0.5', sell_tax: '3.0', rates: [0.005, 0.03], rejected: true },
    { buy_tax: '', rates: [null, null], rejected: false }
  ].map((fields, index) => ({ ...fields, address: `0x${String(index + 1).repeat(40)}` }));
  const { ave } = client(() => envelope(cases.map(({ address, rates, rejected, ...fields }) => tokenRow(address, 'bsc', fields))));
  const { rows } = await ave.trending('bsc');
  for (const [index, { rates, rejected }] of cases.entries()) {
    assert.deepEqual([rows[index].buy_tax, rows[index].sell_tax], rates);
    assert.equal(discoveryScreen(rows[index], scannerSettings, NOW / 1000).reasons.includes('交易税超过风险门槛'), rejected);
  }
});

test('trending drops a row whose tax is not a percentage', async () => {
  const other = `0x${'b'.repeat(40)}`;
  const { ave } = client(() => envelope([tokenRow(BSC_TOKEN), tokenRow(other, 'bsc', { sell_tax: '150' })]));
  const { rows } = await ave.trending('bsc');
  assert.deepEqual(rows.map(row => row.address), [BSC_TOKEN]);
});

test('trending fails when every row is malformed', async () => {
  const other = `0x${'b'.repeat(40)}`;
  const { ave } = client(() => envelope([tokenRow(BSC_TOKEN, 'bsc', { market_cap: 'lots' }), tokenRow(other, 'bsc', { current_price_usd: -1 })]));
  await rejectsWith(ave.trending('bsc'), 'AVE_SCHEMA');
});

test('trending fails when a row echoes another chain', async () => {
  const { ave } = client(() => envelope([tokenRow(BSC_TOKEN, 'eth')]));
  await rejectsWith(ave.trending('bsc'), 'AVE_SCHEMA');
});

for (const status of [401, 403]) {
  test(`HTTP ${status} is AVE_AUTH`, async () => {
    const { ave } = client(() => new Response('denied', { status }));
    await rejectsWith(ave.trending('bsc'), 'AVE_AUTH');
  });
}

test('HTTP 402 is AVE_QUOTA', async () => {
  const { ave } = client(() => new Response('payment required', { status: 402 }));
  await rejectsWith(ave.trending('bsc'), 'AVE_QUOTA', error => assert.equal(error.status, 402));
});

test('HTTP 429 whose body reports exhausted credits is AVE_QUOTA, not a rate pause', async () => {
  const { ave } = client(() => new Response('{"msg":"insufficient credit balance"}', { status: 429, headers: { 'retry-after': '30' } }));
  await rejectsWith(ave.trending('bsc'), 'AVE_QUOTA', error => assert.equal(error.retryAt, undefined));
});

test('HTTP 429 is AVE_RATE_LIMITED with retryAt from Retry-After seconds', async () => {
  const { ave } = client(() => new Response('too many requests', { status: 429, headers: { 'retry-after': '30' } }));
  await rejectsWith(ave.trending('bsc'), 'AVE_RATE_LIMITED', error => {
    assert.equal(error.status, 429);
    assert.equal(error.retryAt, NOW + 30_000);
  });
});

test('HTTP 429 without Retry-After is AVE_RATE_LIMITED without a retry time', async () => {
  const { ave } = client(() => new Response('slow down', { status: 429 }));
  await rejectsWith(ave.trending('bsc'), 'AVE_RATE_LIMITED', error => assert.equal(Object.hasOwn(error, 'retryAt'), false));
});

test('a redirect is never followed and is AVE_UPSTREAM', async () => {
  const { ave, calls } = client(() => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } }));
  await rejectsWith(ave.trending('bsc'), 'AVE_UPSTREAM');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.redirect, 'manual');
});

for (const status of [500, 502, 503]) {
  test(`HTTP ${status} is AVE_UPSTREAM`, async () => {
    const { ave } = client(() => new Response('bad gateway', { status }));
    await rejectsWith(ave.trending('bsc'), 'AVE_UPSTREAM');
  });
}

for (const [scenario, body] of [
  ['a code/data body without the status envelope', { code: 0, data: { tokens: [] } }],
  ['a failed status envelope', { status: 0, data: { tokens: [] } }],
  ['a JSON array', []]
]) {
  test(`a 200 response with ${scenario} is AVE_SCHEMA`, async () => {
    const { ave } = client(() => Response.json(body));
    await rejectsWith(ave.trending('bsc'), 'AVE_SCHEMA');
  });
}

test('a 200 response that is not JSON is AVE_SCHEMA', async () => {
  const { ave } = client(() => new Response('<html>maintenance</html>', { status: 200 }));
  await rejectsWith(ave.trending('bsc'), 'AVE_SCHEMA');
});

test('a declared body over 1 MiB is AVE_SIZE', async () => {
  const { ave } = client(() => new Response('{}', { status: 200, headers: { 'content-length': String(1_048_577) } }));
  await rejectsWith(ave.trending('bsc'), 'AVE_SIZE');
});

test('a streamed body over 1 MiB is AVE_SIZE', async () => {
  const { ave } = client(() => new Response(`{"status":1,"data":{"tokens":[],"pad":"${'x'.repeat(1_048_576)}"}}`, { status: 200 }));
  await rejectsWith(ave.trending('bsc'), 'AVE_SIZE');
});

// A fetch that never answers on its own; it rejects only when its signal aborts.
const hangingFetch = (_url, init) => new Promise((_, reject) => {
  init.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')), { once: true });
});

test('a request that outlives its timeout is AVE_TIMEOUT', async () => {
  const ave = new AveClient({ apiKey: API_KEY, fetchImpl: hangingFetch, now: () => NOW, timeoutMs: 1 });
  await rejectsWith(ave.trending('bsc'), 'AVE_TIMEOUT');
});

test('a caller abort in flight is AVE_ABORTED', async () => {
  const ave = new AveClient({ apiKey: API_KEY, fetchImpl: hangingFetch, now: () => NOW });
  const controller = new AbortController();
  const pending = ave.trending('bsc', { signal: controller.signal });
  controller.abort();
  await rejectsWith(pending, 'AVE_ABORTED');
});

test('an already-aborted caller signal is AVE_ABORTED without a request', async () => {
  const { ave, calls } = client(() => envelope([]));
  const controller = new AbortController();
  controller.abort();
  await rejectsWith(ave.trending('bsc', { signal: controller.signal }), 'AVE_ABORTED');
  assert.equal(calls.length, 0);
});

test('a network TypeError is AVE_NETWORK', async () => {
  const { ave } = client(() => { throw new TypeError('fetch failed'); });
  await rejectsWith(ave.trending('bsc'), 'AVE_NETWORK');
});

test('an echoed API key is redacted from parsed rows', async () => {
  const { ave } = client(() => envelope([tokenRow(BSC_TOKEN, 'bsc', { name: `echo ${API_KEY}`, symbol: API_KEY.slice(0, 40) })]));
  const { rows } = await ave.trending('bsc');
  assert.equal(rows[0].name, 'echo [已移除凭证]');
  assert.equal(JSON.stringify(rows).includes(API_KEY), false);
});

test('normalizeAveApiKey accepts 8 to 512 printable ASCII characters after trimming', () => {
  assert.equal(normalizeAveApiKey('  abcdefgh \n'), 'abcdefgh');
  assert.equal(normalizeAveApiKey('a'.repeat(512)), 'a'.repeat(512));
  for (const invalid of ['abcdefg', 'a'.repeat(513), 'abcd efgh', 'abcdefgé', '', null, 12345678]) {
    assert.equal(normalizeAveApiKey(invalid), '', JSON.stringify(invalid));
  }
});

test('a client without a usable key is AVE_CONFIG and makes no request', () => {
  const { fetchImpl, calls } = stubFetch(() => envelope([]));
  assert.throws(() => new AveClient({ apiKey: 'short', fetchImpl, now: () => NOW }), error => error.code === 'AVE_CONFIG');
  assert.equal(calls.length, 0);
});

test('an unknown chain is AVE_INPUT without a request', async () => {
  const { ave, calls } = client(() => envelope([]));
  await rejectsWith(ave.trending('stable'), 'AVE_INPUT');
  assert.equal(calls.length, 0);
});

test('verifyAveApiKey reads WBNB details on bsc with the candidate key', async () => {
  const { fetchImpl, calls } = stubFetch(() => Response.json({
    status: 1, data: { token: { token: WBNB, chain: 'bsc', current_price_usd: '600.5', updated_at: NOW / 1000 }, pairs: [] }
  }));
  assert.deepEqual(await verifyAveApiKey('candidate-key-123', { fetchImpl, now: () => NOW }), { verified: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://prod.ave-api.com/v2/tokens/${WBNB}-bsc`);
  assert.equal(calls[0].init.headers['X-API-KEY'], 'candidate-key-123');
});

test('verifyAveApiKey rejects a key AVE refuses', async () => {
  const { fetchImpl } = stubFetch(() => new Response('unauthorized', { status: 401 }));
  await rejectsWith(verifyAveApiKey('candidate-key-123', { fetchImpl, now: () => NOW }), 'AVE_AUTH');
});

test('details reads one token on its chain and returns its row', async () => {
  const { ave, calls } = client(() => Response.json({ status: 1, data: { token: tokenRow(BSC_TOKEN), pairs: [] } }));
  const { token, capturedAt } = await ave.details('bsc', BSC_TOKEN);
  assert.equal(calls[0].url, `https://prod.ave-api.com/v2/tokens/${BSC_TOKEN}-bsc`);
  assert.deepEqual([token.symbol, token.market_cap, token.main_pair_tvl, token.holders, capturedAt], ['TEST', 50_000, 20_000, 150, NOW]);
});

test('details keeps the website AVE lists only as an http(s) URL', async () => {
  for (const [website, expected] of [['https://www.pepe.vip/', 'https://www.pepe.vip/'], ['javascript:alert(1)', ''], ['not a url', ''], [undefined, '']]) {
    const { ave } = client(() => Response.json({ status: 1, data: { token: { ...tokenRow(BSC_TOKEN), website }, pairs: [] } }));
    assert.equal((await ave.details('bsc', BSC_TOKEN)).token.website, expected, String(website));
  }
});

// Only a successful answer that holds no token and no pairs means "not indexed";
// a refusal or a malformed answer must not read as "no such token".
for (const [scenario, body, code] of [
  ['no token and no pairs', { status: 1, data: { pairs: [] } }, 'AVE_NOT_FOUND'],
  ['a null token and no pairs', { status: 1, data: { token: null, pairs: [] } }, 'AVE_NOT_FOUND'],
  ['an empty token and no pairs', { status: 1, data: { token: {}, pairs: [] } }, 'AVE_NOT_FOUND'],
  ['an empty token beside pairs', { status: 1, data: { token: {}, pairs: [{ pair: 'x' }] } }, 'AVE_SCHEMA'],
  ['a failed status envelope', { status: 0, msg: 'api key banned', data: null }, 'AVE_SCHEMA'],
  ['a token without a price', { status: 1, data: { token: { token: BSC_TOKEN, chain: 'bsc' }, pairs: [] } }, 'AVE_SCHEMA']
]) {
  test(`details with ${scenario} is ${code}`, async () => {
    const { ave } = client(() => Response.json(body));
    await rejectsWith(ave.details('bsc', BSC_TOKEN), code);
  });
}

function candle(time, close) {
  return { time: time / 1000, open: close, high: close * 1.01, low: close * 0.99, close, volume: 10 };
}

test('priceAt picks the nearest closed one-minute candle within a minute of the target', async () => {
  const targetAt = NOW - 10 * MINUTE + 20_000;
  const to = NOW - 8 * MINUTE;
  const { ave, calls } = client(() => Response.json({
    status: 1,
    data: {
      interval: 1,
      points: [
        candle(NOW - 11 * MINUTE, 1.1), // closes 20 s after the target
        candle(NOW - 10 * MINUTE, 1.2), // closes 40 s after the target
        candle(NOW - 9 * MINUTE, 1.3), // closes 100 s after the target
        candle(NOW - 8 * MINUTE, 9.9) // not closed by the window end
      ]
    }
  }));

  const sample = await ave.priceAt(BSC_TOKEN, targetAt, 'bsc');
  assert.equal(calls[0].url, `https://prod.ave-api.com/v2/klines/token/${BSC_TOKEN}-bsc?interval=1&limit=60&from_time=${(to - 3 * MINUTE) / 1000}&to_time=${to / 1000}`);
  assert.deepEqual(sample, { at: NOW - 10 * MINUTE, price: 1.1, source: 'AVE_1M_CLOSE', capturedAt: NOW });
  assert.equal(AVE_CU.klines, 10);
});

test('priceAt returns null when no closed candle is within a minute of the target', async () => {
  const targetAt = NOW - 10 * MINUTE + 20_000;
  const { ave } = client(() => Response.json({ status: 1, data: { interval: 1, points: [candle(NOW - 9 * MINUTE, 1.3)] } }));
  assert.equal(await ave.priceAt(BSC_TOKEN, targetAt, 'bsc'), null);
});

test('priceAt makes no request for a target in the future', async () => {
  const { ave, calls } = client(() => Response.json({ status: 1, data: { interval: 1, points: [] } }));
  assert.equal(await ave.priceAt(BSC_TOKEN, NOW + 1, 'bsc'), null);
  assert.equal(calls.length, 0);
});
