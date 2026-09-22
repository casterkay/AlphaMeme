export const WORKER_RPC_TIMEOUT_MS = 15_000;

export class WorkerRpcTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Worker RPC did not settle within ${timeoutMs}ms`);
    this.name = 'WorkerRpcTimeoutError';
    this.code = 'WORKER_RPC_TIMEOUT';
  }
}

export async function callWorkerRpc(operation, {
  timeoutMs = WORKER_RPC_TIMEOUT_MS,
  schedule = setTimeout,
  cancel = clearTimeout
} = {}) {
  if (typeof operation !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || typeof schedule !== 'function' || typeof cancel !== 'function') {
    throw new TypeError('Worker RPC timeout configuration is invalid');
  }
  let timeoutId;
  const timeout = new Promise((resolve, reject) => {
    timeoutId = schedule(() => reject(new WorkerRpcTimeoutError(timeoutMs)), timeoutMs);
  });
  const request = Promise.resolve().then(operation);
  return Promise.race([request, timeout]).finally(() => cancel(timeoutId));
}
