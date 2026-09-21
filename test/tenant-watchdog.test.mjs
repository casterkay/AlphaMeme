import assert from 'node:assert/strict';
import test from 'node:test';
import { settleTenantWakes, TenantWakeTimeoutError } from '../src/tenant-watchdog.mjs';

test('tenant watchdog records a hanging wake as a timed failure and handles its late rejection', async () => {
  let fireTimeout;
  let rejectWake;
  const cancelled = [];
  const hangingWake = new Promise((resolve, reject) => {
    rejectWake = reject;
  });
  const results = settleTenantWakes(['16000'], () => hangingWake, {
    timeoutMs: 50,
    schedule(callback) {
      fireTimeout = callback;
      return 1;
    },
    cancel(timeoutId) {
      cancelled.push(timeoutId);
    }
  });

  fireTimeout();
  const [result] = await results;
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason instanceof TenantWakeTimeoutError, true);
  assert.equal(result.reason.code, 'TENANT_WAKE_TIMEOUT');
  assert.deepEqual(cancelled, [1]);

  rejectWake(new Error('late service failure'));
  await new Promise(resolve => setImmediate(resolve));
});

test('tenant watchdog returns settled wake results before its timeout', async () => {
  const timers = new Map();
  const cancelled = [];
  const results = await settleTenantWakes(['16000', '16001'], tenantId => Promise.resolve({ accepted: tenantId === '16000' }), {
    timeoutMs: 50,
    schedule(callback) {
      const timeoutId = timers.size + 1;
      timers.set(timeoutId, callback);
      return timeoutId;
    },
    cancel(timeoutId) {
      cancelled.push(timeoutId);
      timers.delete(timeoutId);
    }
  });

  assert.deepEqual(results, [
    { status: 'fulfilled', value: { accepted: true } },
    { status: 'fulfilled', value: { accepted: false } }
  ]);
  assert.deepEqual(cancelled, [1, 2]);
  assert.equal(timers.size, 0);
});
