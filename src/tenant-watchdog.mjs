export const WATCHDOG_WAKE_TIMEOUT_MS = 15_000;

export class TenantWakeTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`tenant watchdog wake did not settle within ${timeoutMs}ms`);
    this.name = 'TenantWakeTimeoutError';
    this.code = 'TENANT_WAKE_TIMEOUT';
  }
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

export async function wakeTenantWithTimeout(wake, {
  timeoutMs = WATCHDOG_WAKE_TIMEOUT_MS,
  schedule = setTimeout,
  cancel = clearTimeout
} = {}) {
  if (typeof wake !== 'function' || !positiveInteger(timeoutMs) || typeof schedule !== 'function' || typeof cancel !== 'function') {
    throw new TypeError('tenant watchdog wake timeout configuration is invalid');
  }

  let timeoutId;
  const timeout = new Promise((resolve, reject) => {
    timeoutId = schedule(() => {
      reject(new TenantWakeTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  const request = Promise.resolve().then(wake);

  // Racing registers a rejection handler on the original request. It may continue
  // after the timeout, but a late rejection cannot become unhandled.
  return Promise.race([request, timeout]).finally(() => cancel(timeoutId));
}

export function settleTenantWakes(tenantIds, wakeTenant, options) {
  if (!Array.isArray(tenantIds) || typeof wakeTenant !== 'function') {
    throw new TypeError('tenant watchdog wake inputs are invalid');
  }
  return Promise.allSettled(tenantIds.map(tenantId => wakeTenantWithTimeout(() => wakeTenant(tenantId), options)));
}
