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

function durableAdmissionStore(initial = {}, { failWrites = false } = {}) {
  const state = {
    nextAllowedAt: 0,
    backoffFactor: 1,
    lastRequestAt: 0,
    lastWeight: 1,
    successStreak: 0,
    spacingReadyAt: 0,
    keyEpoch: 0,
    ...initial
  };
  const writes = [];
  return {
    writes,
    state,
    async read() { return structuredClone(state); },
    async write(next) {
      if (failWrites) throw new Error('durable store unavailable');
      writes.push(structuredClone(next));
      Object.assign(state, structuredClone(next));
    }
  };
}

function response(data = {}) {
  return new Response(JSON.stringify({ code: 0, data }), { status: 200 });
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

test('priceAt forwards the bounded request signal to its kline read', async () => {
  const controller = new AbortController();
  const client = new GmgnClient();
  let options;
  client.tokenKline = async (_chain, _address, _resolution, _from, _to, receivedOptions) => {
    options = receivedOptions;
    return { list: [] };
  };

  await client.priceAt(address, now - 60_000, 'bsc', { deadline: now + 1_000, signal: controller.signal });
  assert.equal(options.signal, controller.signal);
  assert.equal(options.deadline, now + 1_000);
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

test('verification fails closed when HTTP 401 contains a success-shaped envelope', async () => {
  const client = clientWith(async () => new Response(JSON.stringify({ code: 0, data: { rank: [] } }), { status: 401 }));
  await assert.rejects(client.verifyApiKey(apiKey), error => {
    assert.equal(error.code, 'GMGN_AUTH_FAILED');
    assert.equal(error.status, 401);
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

test('non-JSON HTTP 429 preserves its reset header and enters the shared cooldown', async () => {
  const headerResetAtUnix = Math.ceil(Date.now() / 1000) + 120;
  const client = clientWith(async () => new Response('temporarily unavailable', {
    status: 429, headers: { 'x-ratelimit-reset': String(headerResetAtUnix) }
  }));
  await assert.rejects(client.tokenInfo('bsc', address), error => {
    assert.equal(error.code, 'GMGN_RATE_LIMITED');
    assert.equal(error.status, 429);
    assert.equal(error.headerResetAtUnix, headerResetAtUnix);
    return true;
  });
  assert.ok(client.nextAllowedAt > now);
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
  assert.deepEqual(data._coverage, {
    selectedCategories: ['completed'], localLimit: 1,
    categories: {
      completed: {
        returnedCount: 3, dedupedCount: 2, retainedCount: 1,
        providerExceededLimit: true, locallyCapped: true, locallyDeduplicated: true
      }
    }
  });
});

test('discovery health keeps trenches coverage when the upstream ignores a cap', async () => {
  const rows = Array.from({ length: 81 }, (_, index) => ({
    address: `0x${index.toString(16).padStart(40, '0')}`, volume_1h: index
  }));
  const client = clientWith(async (_url, init) => new Response(JSON.stringify({ code: 0, data:
    init.method === 'POST' ? { completed: rows } : { rank: [] }
  }), { status: 200 }));
  await client.discover('bsc');
  assert.deepEqual(client.lastDiscoveryHealth.trenches.coverage.categories.completed, {
    returnedCount: 81, dedupedCount: 81, retainedCount: 80,
    providerExceededLimit: true, locallyCapped: true, locallyDeduplicated: false
  });
});

test('public client exposes only read operations and high-level read helpers, never trading or a command bridge', () => {
  const client = clientWith(async () => new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 }));
  for (const name of ['run', 'runNow', 'cachedRead', 'childEnvironment', 'privateKey', 'swap', 'order', 'followWallet', 'getUserInfo']) {
    assert.equal(typeof client[name], 'undefined', name);
  }
});

test('one durable admission queue serializes concurrent audit, live and key verification reads', async () => {
  const store = durableAdmissionStore();
  let active = 0;
  let maximumActive = 0;
  const client = clientWith(async (_url, init) => {
    active++;
    maximumActive = Math.max(maximumActive, active);
    await new Promise(resolve => setTimeout(resolve, 1));
    active--;
    return response(init.method === 'POST' ? { completed: [] } : { rank: [], list: [] });
  }, { admissionStateStore: store });

  await Promise.all([
    client.audit(address, now / 1000, 'bsc'),
    client.marketRank('bsc', '1m', { limit: 1 }),
    client.verifyApiKey(apiKey)
  ]);

  assert.equal(maximumActive, 1);
  assert.ok(store.writes.length > 0);
});

test('reconstructed clients honor persisted weighted spacing reservations before fetch', async () => {
  const store = durableAdmissionStore();
  let current = now;
  const waits = [];
  const first = clientWith(async () => response({ list: [] }), {
    admissionStateStore: store,
    minRequestGapMs: 100,
    now: () => current,
    wait: async milliseconds => { waits.push(milliseconds); current += milliseconds; }
  });
  await first.tokenTopHolders('bsc', address);
  assert.deepEqual(store.state, {
    nextAllowedAt: 0,
    backoffFactor: 1,
    lastRequestAt: now,
    lastWeight: 5,
    successStreak: 1,
    spacingReadyAt: now + 500,
    keyEpoch: 0
  });

  const second = clientWith(async () => response({ rank: [] }), {
    admissionStateStore: store,
    minRequestGapMs: 100,
    now: () => current,
    wait: async milliseconds => { waits.push(milliseconds); current += milliseconds; }
  });
  await second.marketRank('bsc', '1m', { limit: 1 });

  assert.deepEqual(waits, [500]);
  assert.equal(store.state.lastWeight, 1);
  assert.equal(store.state.spacingReadyAt, now + 600);
});

test('persisted rate-limit cooldown survives credential changes and blocks every later read', async () => {
  const store = durableAdmissionStore({ nextAllowedAt: now + 60_000 });
  let requests = 0;
  const client = clientWith(async () => { requests++; return response({ rank: [] }); }, { admissionStateStore: store });

  await client.resetCredentials();

  assert.equal(store.state.nextAllowedAt, now + 60_000);
  assert.equal(store.state.keyEpoch, 1);
  await assert.rejects(client.marketRank('bsc', '1m', { limit: 1 }), { code: 'GMGN_RATE_LIMITED' });
  assert.equal(requests, 0);
});

test('bootstrap state cannot shorten a durable cooldown after reconstruction', async () => {
  const cooldownUntil = now + 60_000;
  const store = durableAdmissionStore({ nextAllowedAt: cooldownUntil });
  let requests = 0;
  const client = clientWith(async () => { requests++; return response({ rank: [] }); }, { admissionStateStore: store });

  client.nextAllowedAt = 0;

  await assert.rejects(client.marketRank('bsc', '1m', { limit: 1 }), { code: 'GMGN_RATE_LIMITED' });
  assert.equal(requests, 0);
  assert.equal(store.state.nextAllowedAt, cooldownUntil);
  assert.ok(store.writes.every(entry => entry.nextAllowedAt >= cooldownUntil));
});

test('cache entries are invalidated by the persisted credential epoch', async () => {
  const store = durableAdmissionStore();
  let calls = 0;
  const client = clientWith(async () => { calls++; return response({ list: [] }); }, { admissionStateStore: store });
  const audit = () => client.audit(address, now / 1000, 'bsc', { shouldStopEarly: () => true });

  await audit();
  await audit();
  assert.equal(calls, 3);
  await client.resetCredentials();
  await audit();

  assert.equal(calls, 6);
  assert.equal(store.state.keyEpoch, 1);
});

test('429 backoff is persisted before the admission queue accepts another request', async () => {
  const store = durableAdmissionStore();
  const resetAtUnix = Math.ceil((now + 60_000) / 1000);
  const client = clientWith(async () => new Response(JSON.stringify({ code: 429, error: 'RATE_LIMIT_EXCEEDED' }), {
    status: 429,
    headers: { 'x-ratelimit-reset': String(resetAtUnix) }
  }), { admissionStateStore: store });

  await assert.rejects(client.tokenInfo('bsc', address), { code: 'GMGN_RATE_LIMITED' });

  assert.ok(store.state.nextAllowedAt >= now + 60_000);
  assert.equal(store.state.backoffFactor, 2);
  assert.equal(store.state.successStreak, 0);
  assert.equal(client.metrics.rateLimits, 1);
  assert.ok(store.writes.some(entry => entry.nextAllowedAt >= now + 60_000));
});

test('admission persistence failure fails closed before a GMGN request is sent', async () => {
  const store = durableAdmissionStore({}, { failWrites: true });
  let requests = 0;
  const client = clientWith(async () => { requests++; return response({ rank: [] }); }, { admissionStateStore: store });

  await assert.rejects(client.marketRank('bsc', '1m', { limit: 1 }), { code: 'GMGN_ADMISSION_STATE_UNAVAILABLE' });

  assert.equal(requests, 0);
});
