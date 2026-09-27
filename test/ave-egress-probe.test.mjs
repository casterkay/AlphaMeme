import assert from 'node:assert/strict';
import test from 'node:test';
import worker, { AveEgressProbe, parseRunOptions, PROBE_LIMITS } from '../workers/fixtures/ave-egress-probe.mjs';

const API_KEY = 'ave-test-key-0123456789';
const TOKEN = '0x' + 'ab'.repeat(20);

function fakeContext() {
  const storage = new Map();
  return {
    read: key => storage.get(key),
    storage: {
      get: async key => structuredClone(storage.get(key)),
      put: async (key, value) => { storage.set(key, structuredClone(value)); },
      setAlarm: async at => { storage.set('alarm', at); },
      deleteAlarm: async () => { storage.set('alarm', null); }
    }
  };
}

// Answers the egress echo and serves AVE responses from a queue, recording every AVE URL.
function scriptedFetch(responses) {
  const aveUrls = [];
  const fetchImpl = async (url, options) => {
    if (String(url).startsWith('https://api.ipify.org')) return Response.json({ ip: '203.0.113.7' });
    aveUrls.push({ url: String(url), apiKey: options.headers['X-API-KEY'] });
    const next = responses.shift();
    if (!next) throw new Error('unexpected AVE request');
    return typeof next === 'function' ? next() : next;
  };
  return { fetchImpl, aveUrls };
}

const trendingOk = () => Response.json({ status: 1, data: { tokens: [{ token: TOKEN }, { token: 'not-an-address' }] } });

async function startedProbe(responses, body = { samples: 3 }, env = {}) {
  const ctx = fakeContext();
  const scripted = scriptedFetch(responses);
  const probe = new AveEgressProbe(ctx, { PROBE_TOKEN: 'probe-token', AVE_API_KEY: API_KEY, ...env }, scripted.fetchImpl);
  const response = await probe.fetch(new Request('https://probe.invalid/start', {
    method: 'POST', headers: { Authorization: 'Bearer probe-token' }, body: JSON.stringify(body)
  }));
  return { ctx, probe, response, ...scripted };
}

test('the probe Worker rejects requests without the probe secret before resolving a Durable Object', async () => {
  const response = await worker.fetch(new Request(
    'https://probe.test/runs/00000000-0000-0000-0000-000000000000/start',
    { method: 'POST', headers: { Authorization: 'Bearer undefined' } }
  ), { AVE_EGRESS_PROBE: { idFromName: () => assert.fail('unauthorized request must not resolve a Durable Object') } });
  assert.equal(response.status, 401);
});

test('a run cannot start without the AVE key secret and issues no AVE request', async () => {
  const { response, aveUrls, ctx } = await startedProbe([], {}, { AVE_API_KEY: '' });
  assert.equal(response.status, 409);
  assert.equal(ctx.read('record'), undefined);
  assert.equal(aveUrls.length, 0);
});

test('run options reject cadences faster than the planned 15-second production interval', () => {
  assert.deepEqual(parseRunOptions({}), {
    chain: 'bsc', samples: PROBE_LIMITS.defaultSamples, intervalMs: PROBE_LIMITS.defaultIntervalMs
  });
  for (const invalid of [{ intervalMs: 14_999 }, { samples: 0 }, { samples: PROBE_LIMITS.maxSamples + 1 }, { chain: 'arc' }, { extra: 1 }]) {
    assert.throws(() => parseRunOptions(invalid), RangeError, JSON.stringify(invalid));
  }
});

test('a healthy run reads trending once per alarm, checks token details once, and completes', async () => {
  const { ctx, probe, response, aveUrls } = await startedProbe([trendingOk(), trendingOk(), trendingOk(), trendingOk()]);
  assert.equal(response.status, 202);
  for (let alarm = 0; alarm < 3; alarm++) await probe.alarm();

  const record = ctx.read('record');
  assert.equal(record.stopReason, 'complete');
  assert.deepEqual(aveUrls.map(entry => new URL(entry.url).pathname), [
    '/v2/tokens/trending', `/v2/tokens/${TOKEN}-bsc`, '/v2/tokens/trending', '/v2/tokens/trending'
  ]);
  assert.ok(aveUrls.every(entry => entry.apiKey === API_KEY));
  assert.equal(record.samples[0].rows, 2);
  assert.equal(record.samples[0].egress, '203.0.113.7');
  assert.equal(ctx.read('alarm'), record.alarms.at(-2).startedAt + 15_000, 'no alarm is scheduled after the final sample');

  await probe.alarm();
  assert.equal(aveUrls.length, 4, 'a stopped run issues no further reads');
});

test('a rate-limited read backs off to the provider deadline and three in a row stop the run', async () => {
  const limited = () => new Response('{"msg":"too many requests"}', { status: 429, headers: { 'Retry-After': '120' } });
  const { ctx, probe } = await startedProbe([limited(), limited(), limited()], { samples: 10 });

  await probe.alarm();
  let record = ctx.read('record');
  assert.equal(record.samples[0].outcome, 'rate_limited');
  assert.equal(record.samples[0].bodyPrefix, '{"msg":"too many requests"}');
  assert.ok(ctx.read('alarm') - record.alarms[0].startedAt >= 120_000, 'the next read waits out Retry-After');

  await probe.alarm();
  await probe.alarm();
  record = ctx.read('record');
  assert.equal(record.stopReason, 'rate_limited');
  assert.equal(record.samples.length, 3);
});

test('an authentication rejection stops the run and never records the key', async () => {
  const echoed = () => new Response(`invalid key ${API_KEY}`, { status: 401 });
  const { ctx, probe } = await startedProbe([echoed()]);
  await probe.alarm();

  const record = ctx.read('record');
  assert.equal(record.stopReason, 'rejected');
  assert.ok(!JSON.stringify(record).includes(API_KEY));
});

test('a transport failure is recorded as a measurement rather than aborting the run', async () => {
  const { ctx, probe } = await startedProbe([() => { throw new TypeError('fetch failed'); }]);
  await probe.alarm();

  const record = ctx.read('record');
  assert.equal(record.samples[0].outcome, 'network_error');
  assert.equal(record.stopReason, null);
  assert.ok(ctx.read('alarm') > record.alarms[0].startedAt);
});
