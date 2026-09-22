import assert from 'node:assert/strict';
import test from 'node:test';
import { callWorkerRpc, WorkerRpcTimeoutError } from '../src/worker-rpc.mjs';

test('Worker RPC timeout rejects the caller while retaining a late failure handler', async () => {
  let fireTimeout;
  let rejectOperation;
  const cancelled = [];
  const operation = new Promise((resolve, reject) => {
    rejectOperation = reject;
  });
  const call = callWorkerRpc(() => operation, {
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
  await assert.rejects(call, error => error instanceof WorkerRpcTimeoutError && error.code === 'WORKER_RPC_TIMEOUT');
  assert.deepEqual(cancelled, [1]);

  rejectOperation(new Error('late tenant failure'));
  await new Promise(resolve => setImmediate(resolve));
});

test('Worker RPC timeout returns settled values and clears its timer', async () => {
  const cancelled = [];
  const result = await callWorkerRpc(() => Promise.resolve({ accepted: true }), {
    timeoutMs: 50,
    schedule() {
      return 1;
    },
    cancel(timeoutId) {
      cancelled.push(timeoutId);
    }
  });

  assert.deepEqual(result, { accepted: true });
  assert.deepEqual(cancelled, [1]);
});
