// One bounded JSON request with an explicit timeout. Upstream prose, headers and
// URLs never leave this boundary; callers see a typed code and whether the
// failure is transient (the request may be retried or its effect is unknown).

export class TradingError extends Error {
  constructor(code, message, { transient = false, detail = null } = {}) {
    super(message);
    this.name = 'TradingError';
    this.code = code;
    this.transient = transient;
    if (detail !== null) this.detail = detail;
  }
}

async function readBounded(response, maxBytes, prefix) {
  const declared = response.headers?.get?.('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw new TradingError(`${prefix}_SIZE`, 'response exceeds its size limit');
  if (!response.body?.getReader) return '';
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) throw new TradingError(`${prefix}_SIZE`, 'response exceeds its size limit');
      chunks.push(part.value);
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new TradingError(`${prefix}_SCHEMA`, 'response is not UTF-8');
  }
}

/**
 * Returns { status, ok, json } where json is undefined when the body is not JSON.
 * Transport failures are transient: the request may or may not have taken effect.
 */
export async function requestJson({ fetchImpl, url, init, timeoutMs, maxBytes, signal, prefix }) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
  if (signal?.aborted) throw new TradingError(`${prefix}_ABORTED`, 'request aborted', { transient: true });
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const interrupted = () => timedOut
    ? new TradingError(`${prefix}_TIMEOUT`, 'request timed out', { transient: true })
    : new TradingError(`${prefix}_ABORTED`, 'request aborted', { transient: true });
  try {
    let response;
    try {
      response = await fetchImpl(url, { ...init, redirect: 'error', signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) throw interrupted();
      if (error instanceof TypeError) throw new TradingError(`${prefix}_NETWORK`, 'connection failed', { transient: true });
      throw error;
    }
    let text;
    try {
      text = await readBounded(response, maxBytes, prefix);
    } catch (error) {
      if (controller.signal.aborted) throw interrupted();
      if (error instanceof TypeError) throw new TradingError(`${prefix}_NETWORK`, 'connection failed while reading', { transient: true });
      throw error;
    }
    let json;
    try { json = text ? JSON.parse(text) : undefined; } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      json = undefined;
    }
    return { status: response.status, ok: response.ok, json };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
