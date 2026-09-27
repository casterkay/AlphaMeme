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
      list: async ({ prefix }) => new Map([...storage].filter(([key]) => key.startsWith(prefix))
        .sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => [key, structuredClone(value)])),
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

const authorization = { Authorization: 'Bearer probe-token' };
const call = (probe, action, init = {}) => probe.fetch(new Request(`https://probe.invalid/${action}`, { headers: authorization, ...init }));
const result = async probe => (await call(probe, 'result')).json();
const trendingOk = () => Response.json({ status: 1, data: { tokens: [{ token: TOKEN }, { token: 'not-an-address' }] } });
const detailsOk = () => Response.json({ status: 1, data: { token: { token: TOKEN, chain: 'bsc' }, pairs: [] } });

async function startedProbe(responses, body = { samples: 3 }, env = {}) {
  const ctx = fakeContext();
  const scripted = scriptedFetch(responses);
  const probe = new AveEgressProbe(ctx, { PROBE_TOKEN: 'probe-token', AVE_API_KEY: API_KEY, ...env }, scripted.fetchImpl);
  const response = await call(probe, 'start', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });
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
  const { ctx, probe, response, aveUrls } = await startedProbe([trendingOk(), detailsOk(), trendingOk(), trendingOk()]);
  assert.equal(response.status, 202);
  for (let alarm = 0; alarm < 3; alarm++) await probe.alarm();

  const { summary, samples } = await result(probe);
  assert.equal(summary.stopReason, 'complete');
  assert.equal(summary.estimatedCu, 20);
  assert.deepEqual(aveUrls.map(entry => new URL(entry.url).pathname), [
    '/v2/tokens/trending', `/v2/tokens/${TOKEN}-bsc`, '/v2/tokens/trending', '/v2/tokens/trending'
  ]);
  assert.ok(aveUrls.every(entry => entry.apiKey === API_KEY));
  assert.deepEqual(samples.map(sample => sample.outcome), ['ok', 'ok', 'ok', 'ok']);
  assert.equal(samples[0].rows, 2);
  assert.equal(samples[0].egress, '203.0.113.7');
  assert.equal(ctx.read('record').nextAlarmAt, null, 'no alarm is scheduled after the final sample');

  await probe.alarm();
  assert.equal(aveUrls.length, 4, 'a stopped run issues no further reads');
});

test('a rate-limited read backs off to the provider deadline and three in a row stop the run', async () => {
  const limited = () => new Response('{"msg":"too many requests"}', { status: 429, headers: { 'Retry-After': '120' } });
  const { ctx, probe } = await startedProbe([limited(), limited(), limited()], { samples: 10 });

  const before = Date.now();
  await probe.alarm();
  let { samples } = await result(probe);
  assert.equal(samples[0].outcome, 'rate_limited');
  assert.equal(samples[0].bodyPrefix, '{"msg":"too many requests"}');
  assert.ok(ctx.read('alarm') - before >= 120_000, 'the next read waits out Retry-After');

  await probe.alarm();
  await probe.alarm();
  const { summary } = await result(probe);
  assert.equal(summary.stopReason, 'rate_limited');
  assert.equal(summary.trendingAttempts, 3);
  assert.equal(summary.estimatedCu, 0);
});

test('an authentication rejection stops the run and never records the key', async () => {
  const echoed = () => new Response(`invalid key ${API_KEY}`, { status: 401 });
  const { ctx, probe } = await startedProbe([echoed()]);
  await probe.alarm();

  const evidence = await result(probe);
  assert.equal(evidence.summary.stopReason, 'rejected');
  assert.ok(!JSON.stringify(evidence).includes(API_KEY));
});

test('a transport failure is recorded as a measurement rather than aborting the run', async () => {
  const { ctx, probe } = await startedProbe([() => { throw new TypeError('fetch failed'); }]);
  await probe.alarm();

  const { summary, samples } = await result(probe);
  assert.equal(samples[0].outcome, 'network_error');
  assert.equal(summary.stopReason, null);
  assert.ok(ctx.read('alarm') > summary.startedAt);
});

test('a timed-out read is recorded as a timeout', async () => {
  const { probe } = await startedProbe([() => { throw new DOMException('timed out', 'TimeoutError'); }]);
  await probe.alarm();
  assert.equal((await result(probe)).samples[0].outcome, 'timeout');
});

test('an HTTP 200 whose body reports a refusal counts as a provider error, backs off and stops after three', async () => {
  const refused = () => Response.json({ status: 0, msg: 'api key banned' });
  const { ctx, probe } = await startedProbe([refused(), refused(), refused()], { samples: 10 });
  const before = Date.now();
  await probe.alarm();
  assert.equal((await result(probe)).samples[0].outcome, 'provider_error');
  assert.ok(ctx.read('alarm') - before >= 60_000, 'a refusal is not retried at the normal cadence');

  await probe.alarm();
  await probe.alarm();
  const { summary } = await result(probe);
  assert.equal(summary.stopReason, 'provider_error');
  assert.equal(summary.byOutcome.ok, undefined);
});

test('a 402 stops the run as a quota verdict', async () => {
  const { probe } = await startedProbe([new Response('{"msg":"insufficient credits"}', { status: 402 })]);
  await probe.alarm();
  assert.equal((await result(probe)).summary.stopReason, 'quota');
});

test('an operator stop that lands while an alarm awaits AVE is not overwritten', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const { ctx, probe } = await startedProbe([() => pending], { samples: 10 });
  const alarm = probe.alarm();
  await new Promise(resolve => setImmediate(resolve));

  const stopped = await call(probe, 'stop', { method: 'POST' });
  assert.equal((await stopped.json()).stopReason, 'operator');
  release(trendingOk());
  await alarm;

  const { summary } = await result(probe);
  assert.equal(summary.stopReason, 'operator');
  assert.equal(summary.trendingAttempts, 1, 'the in-flight read is still kept as evidence');
  assert.equal(ctx.read('alarm'), null, 'no further alarm is scheduled');
});

test('a malformed start body is rejected instead of starting a default run', async () => {
  const { response, ctx } = await startedProbe([], '{"samples": 3');
  assert.equal(response.status, 400);
  assert.equal(ctx.read('record'), undefined);
});

test('the router forwards an authorized request to the run\'s Durable Object', async () => {
  const runId = '00000000-0000-0000-0000-000000000001';
  const forwarded = [];
  const response = await worker.fetch(new Request(`https://probe.test/runs/${runId}/result`, { headers: authorization }), {
    PROBE_TOKEN: 'probe-token',
    AVE_EGRESS_PROBE: {
      idFromName: name => `id:${name}`,
      get: id => ({ fetch: async request => { forwarded.push({ id, url: request.url, auth: request.headers.get('Authorization') }); return new Response('ok'); } })
    }
  });
  assert.equal(response.status, 200);
  assert.deepEqual(forwarded, [{ id: `id:${runId}`, url: 'https://probe.invalid/result', auth: 'Bearer probe-token' }]);
});
