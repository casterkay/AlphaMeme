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
