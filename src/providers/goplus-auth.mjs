// GoPlus app sign-in: an app key and secret buy an access token whose quota is
// the app's own, not shared with everyone behind the same egress IP.
const TOKEN_URL = 'https://api.gopluslabs.io/api/v1/token';

// Renew this long before GoPlus says the token expires, so no check carries a dying token.
const RENEW_EARLY_MS = 5 * 60_000;

export class GoPlusAuthError extends Error {
  constructor(code) {
    super(code);
    this.name = 'GoPlusAuthError';
    this.code = code;
  }
}

/** The app credentials from the Worker env: both set, or neither (anonymous GoPlus). */
export function goPlusCredentials(env) {
  const appKey = typeof env?.GOPLUS_APP_KEY === 'string' ? env.GOPLUS_APP_KEY.trim() : '';
  const appSecret = typeof env?.GOPLUS_APP_SECRET === 'string' ? env.GOPLUS_APP_SECRET.trim() : '';
  if (Boolean(appKey) !== Boolean(appSecret)) throw new TypeError('GOPLUS_APP_KEY and GOPLUS_APP_SECRET must be set together');
  return appKey ? Object.freeze({ appKey, appSecret }) : null;
}

async function sha1Hex(text) {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Holds one access token and renews it before it expires; concurrent checks share one sign-in. */
export class GoPlusAuth {
  #token = null;
  #pending = null;

  constructor({ appKey, appSecret, fetchImpl = globalThis.fetch, now = () => Date.now(), timeoutMs = 8_000 }) {
    if (!appKey || !appSecret) throw new TypeError('GoPlus app key and secret are required');
    if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
    Object.assign(this, { appKey, appSecret, fetchImpl, now, timeoutMs });
  }

  async accessToken({ signal } = {}) {
    if (this.#token && this.now() < this.#token.renewAt) return this.#token.value;
    this.#pending ||= this.#signIn(signal).finally(() => { this.#pending = null; });
    return this.#pending;
  }

  forget() {
    this.#token = null;
  }

  async #signIn(signal) {
    const time = Math.floor(this.now() / 1000), sign = await sha1Hex(`${this.appKey}${time}${this.appSecret}`);
    const { fetchImpl } = this;
    let body;
    try {
      const response = await fetchImpl(TOKEN_URL, {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ app_key: this.appKey, time, sign }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs)
      });
      if (!response.ok) throw new GoPlusAuthError(`GOPLUS_AUTH_HTTP_${response.status}`);
      body = await response.json();
    } catch (error) {
      if (error instanceof GoPlusAuthError) throw error;
      if (['AbortError', 'TimeoutError'].includes(error?.name)) throw new GoPlusAuthError('GOPLUS_AUTH_TIMEOUT');

      // Never pass on the error itself: it could quote the request, which holds the signature.
      throw new GoPlusAuthError('GOPLUS_AUTH_FAILED');
    }
    const value = body?.result?.access_token, expiresInSec = Number(body?.result?.expires_in);
    if (Number(body?.code) !== 1 || typeof value !== 'string' || !value || !(expiresInSec > 0)) throw new GoPlusAuthError('GOPLUS_AUTH_REJECTED');
    this.#token = { value, renewAt: this.now() + Math.max(0, expiresInSec * 1000 - RENEW_EARLY_MS) };
    return value;
  }
}
