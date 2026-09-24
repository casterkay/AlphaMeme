import assert from 'node:assert/strict';
import test from 'node:test';
import worker, { LiveTimingProbe } from '../workers/fixtures/deployed-live-timing-spike.mjs';

test('deployed timing Worker rejects Bearer undefined when probe secret is absent', async () => {
  const response = await worker.fetch(new Request(
    'https://probe.test/runs/00000000-0000-0000-0000-000000000000/normal',
    { method: 'POST', headers: { Authorization: 'Bearer undefined' } }
  ), {
    LIVE_TIMING_PROBE: {
      idFromName: () => assert.fail('unauthorized request must not resolve a Durable Object')
    }
  });

  assert.equal(response.status, 401);
});

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

test('the deployed probe records whether a rejected attempt reached the network', async () => {
  const ctx = fakeContext();
  const probe = new LiveTimingProbe(ctx, {
    PROBE_TOKEN: 'probe-token',
    // The controlled 429 answers without reading the credential, but the client refuses to issue
    // any read before a well-formed key is present.
    GMGN_API_KEY: `gmgn_${'a'.repeat(32)}`
  });
  const started = await probe.fetch(new Request('https://probe.invalid/rate-limit', {
    method: 'POST', headers: { Authorization: 'Bearer probe-token' }
  }));
  assert.equal(started.status, 202);

  await probe.alarm();

  const record = ctx.read('record');
  const [attempt] = record.requests;
  assert.equal(attempt.kind, 'scan');
  assert.equal(attempt.networkAttempted, true, 'a provider rejection is a real network attempt');
  assert.equal(attempt.network.status, 429);
  assert.ok(attempt.network.bodyPrefix.includes('RATE_LIMIT_EXCEEDED'), 'the raw envelope is retained');
  assert.equal(attempt.cooldownRemainingMs, 0);
  assert.ok(record.state.gmgn.nextAllowedAt > Date.now(), 'the 429 arms the shared cooldown');
  assert.ok(record.nextAlarmAt >= record.state.gmgn.nextAllowedAt,
    'the next attempt waits out that cooldown rather than being refused locally');
  // The refusal path (networkAttempted false, no fetch issued) is asserted in test/gmgn.test.mjs
  // by 'persisted rate-limit cooldown survives credential changes and blocks every later read'.
});

test('deployed timing Durable Object rejects Bearer undefined when probe secret is absent', async () => {
  const probe = new LiveTimingProbe({
    storage: {
      get: () => assert.fail('unauthorized request must not read storage')
    }
  }, {});
  const response = await probe.fetch(new Request('https://probe.invalid/result', {
    headers: { Authorization: 'Bearer undefined' }
  }));

  assert.equal(response.status, 401);
});
