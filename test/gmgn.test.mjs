import test from 'node:test';
import assert from 'node:assert/strict';
import { GmgnClient, normalizeList, translateGmgnError } from '../src/providers/gmgn.mjs';

const apiKey = `gmgn_${'a1'.repeat(16)}`;
const address = '0x' + '1'.repeat(40);
const now = 1_800_000_000_000;
const clientId = '11111111-1111-4111-8111-111111111111';

function clientWith(fetch, options = {}) {
  return new GmgnClient({
    apiKeyProvider: () => apiKey,
    fetch,
    now: () => now,
    randomUUID: () => clientId,
    minRequestGapMs: 0,
    ...options
  });
}

test('normalizes nested GMGN list shapes without guessing token fields', () => {
  assert.deepEqual(normalizeList({ data: { rank: [{ address: 'a' }] } }), [{ address: 'a' }]);
  assert.deepEqual(normalizeList({ data: { data: { completed: [{ address: 'b' }] } } }, ['completed']), [{ address: 'b' }]);
});

test('the eight read operations use their exact exist-auth routes without leaking the API key', async () => {
  const requests = [];
  const client = clientWith(async (url, init) => {
    requests.push({ url: new URL(url), init });
    return new Response(JSON.stringify({ code: 0, data: { completed: [], rank: [] } }), { status: 200 });
  });

  await client.tokenInfo('bsc', address);
  await client.tokenSecurity('bsc', address);
  await client.tokenPoolInfo('bsc', address);
  await client.tokenTopHolders('bsc', address, { limit: 20, order_by: 'amount_percentage', direction: 'desc' });
  await client.tokenTopTraders('bsc', address, { limit: 20, order_by: 'amount_percentage', direction: 'desc' });
  await client.tokenKline('bsc', address, '1m', 100_000, 200_000);
  await client.marketRank('bsc', '5m', { limit: 100, order_by: 'volume', direction: 'desc', min_created: '5m', deadline: now + 1_000 });
  await client.trenches('bsc', { types: ['completed'], limit: 1, filters: { min_created: '5m' } });

  assert.deepEqual(requests.map(request => [request.init.method, request.url.pathname]), [
    ['GET', '/v1/token/info'], ['GET', '/v1/token/security'], ['GET', '/v1/token/pool_info'],
    ['GET', '/v1/market/token_top_holders'], ['GET', '/v1/market/token_top_traders'],
    ['GET', '/v1/market/token_kline'], ['GET', '/v1/market/rank'], ['POST', '/v1/trenches']
  ]);
  for (const request of requests) {
    assert.equal(request.url.searchParams.get('timestamp'), '1800000000');
    assert.equal(request.url.searchParams.get('client_id'), clientId);
    assert.equal(request.init.headers['X-APIKEY'], apiKey);
    assert.equal(request.init.headers['X-Signature'], undefined);
    assert.doesNotMatch(request.url.toString(), new RegExp(apiKey));
    assert.doesNotMatch(String(request.init.body || ''), new RegExp(apiKey));
  }
  assert.deepEqual(Object.fromEntries(requests[3].url.searchParams), {
    chain: 'bsc', address, limit: '20', order_by: 'amount_percentage', direction: 'desc', timestamp: '1800000000', client_id: clientId
  });
  assert.deepEqual(Object.fromEntries(requests[5].url.searchParams), {
    chain: 'bsc', address, resolution: '1m', from: '100000', to: '200000', timestamp: '1800000000', client_id: clientId
  });
  assert.equal(requests[6].url.searchParams.has('deadline'), false);
  assert.deepEqual(JSON.parse(requests[7].init.body), {
    version: 'v2',
    completed: {
      filters: ['offchain', 'onchain'], launchpad_platform_v2: true, limit: 1,
      quote_address_type: [6, 7, 1, 16, 8, 3, 9, 10, 2, 17, 18, 0], min_created: '5m'
    }
  });
});

test('kline time arguments stay in milliseconds and priceAt preserves millisecond candle timestamps', async () => {
  let request;
  const targetAt = now - 86_400_000;
  const client = clientWith(async (url, init) => {
    request = { url: new URL(url), init };
    return new Response(JSON.stringify({ code: 0, data: { list: [{ time: targetAt - 60_000, close: '2' }] } }), { status: 200 });
  });
  assert.deepEqual(await client.priceAt(address, targetAt, 'bsc'), { at: targetAt, price: 2, source: 'GMGN_1M_CLOSE' });
  assert.equal(request.url.searchParams.get('from'), String(targetAt - 120_000));
  assert.equal(request.url.searchParams.get('to'), String(targetAt + 60_000));
});

test('rejects nonzero or malformed envelopes and never accepts string zero as success', async () => {
  const responses = [
    new Response(JSON.stringify({ code: '0', data: {} }), { status: 200 }),
    new Response('not json', { status: 200 }),
    new Response(JSON.stringify({ code: 401, error: 'AUTH_KEY_INVALID', message: `bad ${apiKey}` }), { status: 401 })
  ];
  const client = clientWith(async () => responses.shift());
  await assert.rejects(client.tokenInfo('bsc', address), { code: 'GMGN_REQUEST_FAILED' });
  await assert.rejects(client.tokenInfo('bsc', address), { code: 'GMGN_INVALID_RESPONSE' });
  await assert.rejects(client.tokenInfo('bsc', address), error => {
    assert.equal(error.code, 'GMGN_AUTH_FAILED');
    assert.equal(error.status, 401);
    assert.equal(error.apiCode, 401);
    assert.equal(error.apiError, 'AUTH_KEY_INVALID');
    assert.doesNotMatch(error.message, new RegExp(apiKey));
    return true;
  });
});

test('bounds response bytes before parsing a provider payload', async () => {
  const client = clientWith(async () => new Response('x'.repeat(65)), { maxResponseBytes: 64 });
  await assert.rejects(client.tokenInfo('bsc', address), error => {
    assert.equal(error.code, 'GMGN_RESPONSE_TOO_LARGE');
    assert.doesNotMatch(error.message, /x{10}/);
    return true;
  });
});

test('aborts timed-out fetches and translates transport failures without exposing request details', async () => {
  let aborted = false;
  const timedOut = clientWith((_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      aborted = true;
      reject(new DOMException('aborted', 'AbortError'));
    });
  }), { timeoutMs: 1 });
  await assert.rejects(timedOut.tokenInfo('bsc', address), { code: 'GMGN_TIMEOUT' });
  assert.equal(aborted, true);

  const offline = clientWith(async () => { throw new TypeError('fetch failed'); });
  await assert.rejects(offline.tokenInfo('bsc', address), error => {
    assert.equal(error.code, 'GMGN_NETWORK_ERROR');
    assert.doesNotMatch(error.message, /token\/info|apiKey|gmgn_/i);
    return true;
  });
});

test('preserves body and header reset times while translating 429, 401, 403, timeout, and network failures', async () => {
  const headerResetAtUnix = Math.ceil(Date.now() / 1000) + 120;
  const bodyResetAtUnix = headerResetAtUnix - 30;
  const limited = clientWith(async () => new Response(JSON.stringify({
    code: 429, error: 'RATE_LIMIT_EXCEEDED', reset_at: bodyResetAtUnix
  }), { status: 429, headers: { 'x-ratelimit-reset': String(headerResetAtUnix) } }));
  await assert.rejects(limited.tokenInfo('bsc', address), error => {
    assert.equal(error.code, 'GMGN_RATE_LIMITED');
    assert.equal(error.headerResetAtUnix, headerResetAtUnix);
    assert.equal(error.bodyResetAtUnix, bodyResetAtUnix);
    assert.ok(error.retryAfterMs >= 120_000);
    return true;
  });
  assert.equal(translateGmgnError({ status: 401, apiCode: 401 }).code, 'GMGN_AUTH_FAILED');
  assert.equal(translateGmgnError({ status: 403, apiCode: 403 }).code, 'GMGN_PERMISSION_DENIED');
  assert.equal(translateGmgnError({ code: 'GMGN_TIMEOUT' }).code, 'GMGN_TIMEOUT');
  assert.equal(translateGmgnError({ code: 'GMGN_NETWORK_ERROR' }).code, 'GMGN_NETWORK_ERROR');
});

test('trenches locally sorts, deduplicates, and caps a provider response that ignores its limit', async () => {
  const client = clientWith(async () => new Response(JSON.stringify({ code: 0, data: {
    completed: [
      { address: '0x' + 'a'.repeat(40), volume_1h: 1 },
      { address: '0x' + 'b'.repeat(40), volume_1h: 3 },
      { address: '0x' + 'B'.repeat(40), volume_1h: 2 }
    ]
  } }), { status: 200 }));
  const data = await client.trenches('bsc', { types: ['completed'], limit: 1 });
  assert.deepEqual(data.completed, [{ address: '0x' + 'b'.repeat(40), volume_1h: 3 }]);
});

test('public client exposes only read operations and high-level read helpers, never trading or a command bridge', () => {
  const client = clientWith(async () => new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 }));
  for (const name of ['run', 'runNow', 'cachedRead', 'childEnvironment', 'privateKey', 'swap', 'order', 'followWallet', 'getUserInfo']) {
    assert.equal(typeof client[name], 'undefined', name);
  }
});
