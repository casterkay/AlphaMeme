import { normalizeGmgnApiKey } from '../gmgn-api-key.mjs';
import { normalizeGmgnList, tokenInfoPrice, unwrapGmgn } from './gmgn-normalize.mjs';

export { normalizeGmgnList as normalizeList, tokenInfoPrice } from './gmgn-normalize.mjs';

const API_ORIGIN = 'https://openapi.gmgn.ai';
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const CHAINS = new Set(['sol', 'bsc', 'base', 'eth', 'robinhood', 'arc', 'stable']);
const TRENCH_TYPES = new Set(['new_creation', 'near_completion', 'completed']);
const TRENCHES_QUOTE_ADDRESS_TYPES = Object.freeze({
  sol: [4, 5, 3, 1, 13, 0],
  bsc: [6, 7, 1, 16, 8, 3, 9, 10, 2, 17, 18, 0],
  base: [11, 3, 12, 13, 0],
  eth: [20, 11, 8, 3, 12, 1, 0],
  robinhood: [11, 20, 24, 12, 0]
});

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function errorWith(code, message, properties = {}) {
  return Object.assign(new Error(message), { code, ...properties });
}

function errorSummary(error) {
  return {
    ok: false,
    code: String(error?.code || 'GMGN_REQUEST_FAILED'),
    message: String(error?.message || 'GMGN数据请求失败')
  };
}

function mergeDefined(left = {}, right = {}) {
  const merged = { ...left };
  for (const [key, value] of Object.entries(right || {})) {
    if (value !== undefined && value !== null && value !== '') {
      merged[key] = key === 'link' && typeof value === 'object'
        ? mergeDefined(left?.link || {}, value)
        : value;
    }
  }
  return merged;
}


// Both the message-derived wait and a provider-declared deadline are judged against one horizon:
// the provider documents that repeated requests extend a block by at most five minutes, and a
// deadline beyond that is a quota or plan condition rather than momentary throttling.
const RESET_HORIZON_MS = 5 * 60_000;

function retryAfterMs(message) {
  const match = String(message || '').match(/~?(\d+)s\s+remaining/i);
  return Math.min(RESET_HORIZON_MS, Math.max(30_000, Number(match?.[1] || 30) * 1000));
}

// The provider's official client reads the reset deadline from the `x-ratelimit-reset` header
// only. The body `reset_at` field is retained because some published skills describe it.
function resetDeadlineUnix(error) {
  return Math.max(Number(error?.headerResetAtUnix) || 0, Number(error?.bodyResetAtUnix) || 0, Number(error?.resetAtUnix) || 0);
}

function resetDeadlineMs(error) {
  return Math.max(0, resetDeadlineUnix(error) * 1000 - Date.now() + 1000 || 0);
}

const EVIDENCE_BODY_LIMIT = 1024;
const EVIDENCE_HEADER_PATTERN = /^(x-ratelimit|retry-after|x-request-id|cf-ray)/i;

// Bounded raw evidence from a provider response, so a rejection can be classified from captured
// bytes instead of an assumed shape. The deployed timing probe records the same fields, which is
// how a future run distinguishes a provider rejection from a local cooldown refusal.
export function responseEvidence(response, body) {
  const headers = {};
  for (const [name, value] of response?.headers?.entries?.() ?? []) {
    if (EVIDENCE_HEADER_PATTERN.test(name)) headers[name.toLowerCase()] = value;
  }
  const text = typeof body === 'string' ? body : '';
  return {
    status: Number(response?.status) || 0,
    headers,
    bodyPrefix: text.slice(0, EVIDENCE_BODY_LIMIT),
    bodyTruncated: text.length > EVIDENCE_BODY_LIMIT
  };
}

function preserveErrorMetadata(translated, source) {
  for (const name of ['status', 'apiCode', 'apiError', 'apiMessage', 'upgradeUrl', 'upgradeMessage', 'resetAtUnix', 'headerResetAtUnix', 'bodyResetAtUnix', 'rateLimitEvidence']) {
    if (source?.[name] !== undefined) translated[name] = source[name];
  }
  return translated;
}

export function translateGmgnError(error) {
  const raw = [
    error?.code,
    error?.status ? `HTTP ${error.status}` : '',
    error?.apiCode !== undefined ? `API ${error.apiCode}` : '',
    error?.apiError,
    error?.apiMessage,
    error?.message || error || ''
  ].join(' ');
  let code = 'GMGN_REQUEST_FAILED';
  let message = 'GMGN数据请求暂时失败，下一轮会自动重试。';
  let retryAfterMsValue = 0;

  if (error?.code === 'GMGN_RESPONSE_TOO_LARGE') {
    code = 'GMGN_RESPONSE_TOO_LARGE';
    message = 'GMGN返回数据过大，已丢弃原始响应并等待重试。';
  } else if (error?.code === 'GMGN_INVALID_RESPONSE' || /non-JSON|invalid response/i.test(raw)) {
    code = 'GMGN_INVALID_RESPONSE';
    message = 'GMGN返回的数据格式无法解析，已丢弃原始响应并等待重试。';
  } else if (/ERROR_RATE_LIMIT_BLOCKED/i.test(raw)) {
    // Repeated *business* errors block the key; GMGN requires the request to be fixed and does
    // not auto-retry this case. No floor is invented: the block's own reset deadline governs.
    retryAfterMsValue = resetDeadlineMs(error);
    code = 'GMGN_RATE_LIMIT_BLOCKED';
    message = retryAfterMsValue > 0
      ? `GMGN已因重复的请求错误临时封锁该Key；约${Math.ceil(retryAfterMsValue / 1000)}秒后可重试，请先修正请求，继续请求可能延长封锁。`
      : 'GMGN已因重复的请求错误临时封锁该Key，需修正请求后再试；继续请求可能延长封锁。';
  } else if (/RATE_LIMIT_EXCEEDED|RATE_LIMIT_BANNED|GMGN_RATE_LIMITED|HTTP\s*429|API\s*429/i.test(raw)) {
    const resetMs = resetDeadlineMs(error);
    if (resetMs > RESET_HORIZON_MS) {
      // A deadline beyond the throttle horizon is a quota or plan ceiling. The wait is still
      // honored, but it is reported as a block so it is not misread as "retry shortly".
      retryAfterMsValue = resetMs;
      code = 'GMGN_RATE_LIMIT_BLOCKED';
      message = `GMGN限流恢复时间约${Math.ceil(resetMs / 60_000)}分钟，超过${Math.ceil(RESET_HORIZON_MS / 60_000)}分钟阈值，可能是配额或套餐上限；请检查Key与用量，勿反复重试。`;
    } else {
      retryAfterMsValue = Math.max(retryAfterMs(raw), resetMs);
      code = 'GMGN_RATE_LIMITED';
      message = `GMGN请求频率超限，已停止本轮后续请求；约${Math.ceil(retryAfterMsValue / 1000)}秒后可恢复，下一轮会自动重试。`;
    }
  } else if (/HTTP\s*401|API\s*401|GMGN_AUTH_FAILED|UNAUTHORIZED|AUTH_KEY_INVALID|invalid.*api.?key/i.test(raw)) {
    code = 'GMGN_AUTH_FAILED';
    message = 'GMGN API Key无效或已失效，请重新配置。';
  } else if (/HTTP\s*403|API\s*403|GMGN_PERMISSION_DENIED|FORBIDDEN/i.test(raw)) {
    code = 'GMGN_PERMISSION_DENIED';
    message = 'GMGN API当前没有读取该数据的权限。';
  } else if (error?.code === 'GMGN_TIMEOUT' || /timed?\s*out|ETIMEDOUT|AbortError/i.test(raw)) {
    code = 'GMGN_TIMEOUT';
    message = 'GMGN数据请求超时，下一轮会自动重试。';
  } else if (error?.code === 'GMGN_NETWORK_ERROR' || /ECONN|ENET|EAI_AGAIN|socket|network|fetch failed/i.test(raw)) {
    code = 'GMGN_NETWORK_ERROR';
    message = '网络暂时无法连接GMGN，下一轮会自动重试。';
  }

  return preserveErrorMetadata(Object.assign(new Error(message), { code, retryAfterMs: retryAfterMsValue }), error);
}


export function gmgnRequestWeight(operation) {
  return ({ tokenTopHolders: 5, tokenTopTraders: 5, trenches: 3, tokenKline: 2 })[operation] || 1;
}

const ADMISSION_STATE_DEFAULTS = Object.freeze({
  nextAllowedAt: 0,
  backoffFactor: 1,
  lastRequestAt: 0,
  lastWeight: 1,
  successStreak: 0,
  spacingReadyAt: 0,
  keyEpoch: 0
});
const MONOTONIC_ADMISSION_FIELDS = new Set([
  'nextAllowedAt', 'spacingReadyAt', 'backoffFactor', 'lastRequestAt', 'keyEpoch'
]);

function nonnegativeNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function positiveInteger(value, fallback) {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function admissionState(value = {}) {
  return {
    nextAllowedAt: nonnegativeNumber(value.nextAllowedAt, 0),
    backoffFactor: Math.max(1, nonnegativeNumber(value.backoffFactor, 1)),
    lastRequestAt: nonnegativeNumber(value.lastRequestAt, 0),
    lastWeight: positiveInteger(value.lastWeight, 1),
    successStreak: Math.trunc(nonnegativeNumber(value.successStreak, 0)),
    spacingReadyAt: nonnegativeNumber(value.spacingReadyAt, 0),
    keyEpoch: Math.trunc(nonnegativeNumber(value.keyEpoch, 0))
  };
}

function mergeBootstrapAdmissionState(persisted, overrides) {
  const merged = { ...persisted };
  for (const [field, value] of Object.entries(overrides)) {
    merged[field] = MONOTONIC_ADMISSION_FIELDS.has(field)
      ? Math.max(persisted[field], value)
      : value;
  }
  return admissionState(merged);
}

// A later DO migration supplies this small read/write boundary with versioned
// SQLite. Keeping the local implementation here preserves fail-closed admission
// semantics without introducing a competing schema.
export class MemoryGmgnAdmissionStateStore {
  constructor(initial = ADMISSION_STATE_DEFAULTS) {
    this.value = admissionState(initial);
  }

  async read() {
    return structuredClone(this.value);
  }

  async write(next) {
    this.value = admissionState(next);
    return structuredClone(this.value);
  }
}

function validateChain(chain) {
  if (!CHAINS.has(chain)) throw errorWith('GMGN_INVALID_REQUEST', 'Unsupported chain');
}

function validateAddress(chain, address) {
  const valid = chain === 'sol' ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ : /^0x[a-f0-9]{40}$/i;
  if (!valid.test(String(address || ''))) throw errorWith('GMGN_INVALID_REQUEST', 'Invalid address');
}

function validateLimit(limit, maximum) {
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum) throw errorWith('GMGN_INVALID_REQUEST', 'Invalid limit');
}

function definedEntries(object) {
  return Object.entries(object || {}).filter(([, value]) => value !== undefined && value !== null && value !== '');
}

function buildQuery(query, now, randomUUID) {
  const params = new URLSearchParams();
  for (const [name, value] of definedEntries({ ...query, timestamp: Math.floor(now() / 1000), client_id: randomUUID() })) {
    if (Array.isArray(value)) for (const member of value) params.append(name, String(member));
    else params.set(name, String(value));
  }
  return params;
}

function validUnixSeconds(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : undefined;
}

async function boundedResponseText(response, maximumBytes) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw errorWith('GMGN_RESPONSE_TOO_LARGE', 'Response exceeded the configured size bound');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error?.code === 'GMGN_RESPONSE_TOO_LARGE') throw error;
    throw errorWith('GMGN_INVALID_RESPONSE', 'Response body could not be read');
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function parseEnvelope(response, body) {
  const status = Number(response?.status);
  const headerResetAtUnix = validUnixSeconds(response.headers?.get?.('x-ratelimit-reset'));
  let envelope;
  try {
    envelope = JSON.parse(body);
  } catch {
    if (status < 200 || status >= 300) {
      throw errorWith('GMGN_HTTP_ERROR', 'GMGN returned an HTTP error', {
        status, headerResetAtUnix, resetAtUnix: headerResetAtUnix, rateLimitEvidence: responseEvidence(response, body)
      });
    }
    throw errorWith('GMGN_INVALID_RESPONSE', 'Response was not JSON', {
      status: response.status, rateLimitEvidence: responseEvidence(response, body)
    });
  }
  if (status < 200 || status >= 300 || !envelope || typeof envelope !== 'object' || envelope.code !== 0) {
    const bodyResetAtUnix = validUnixSeconds(envelope?.reset_at);
    throw errorWith('GMGN_API_ERROR', 'GMGN envelope reported an error', {
      status,
      apiCode: envelope?.code,
      apiError: envelope?.error,
      apiMessage: envelope?.message,
      upgradeUrl: envelope?.upgrade_url,
      upgradeMessage: envelope?.upgrade_message,
      headerResetAtUnix,
      bodyResetAtUnix,
      resetAtUnix: Math.max(headerResetAtUnix || 0, bodyResetAtUnix || 0) || undefined,
      rateLimitEvidence: responseEvidence(response, body)
    });
  }
  return envelope.data;
}

function buildTrenchesBody(chain, types, limit, filters) {
  const quoteAddressTypes = TRENCHES_QUOTE_ADDRESS_TYPES[chain] || [];
  const section = {
    filters: ['offchain', 'onchain'],
    launchpad_platform_v2: true,
    limit,
    ...(quoteAddressTypes.length ? { quote_address_type: quoteAddressTypes } : {}),
    ...filters
  };
  return Object.fromEntries([
    ['version', 'v2'],
    ...types.map(type => [type, { ...section }])
  ]);
}

function compactTrenches(value, chain, types, limit) {
  if (!value || typeof value !== 'object') return value;
  const compacted = { ...value };
  const coverage = { selectedCategories: [...types], localLimit: limit, categories: {} };
  for (const type of types) {
    const rows = Array.isArray(value[type]) ? value[type] : [];
    const unique = new Map();
    for (const row of [...rows].sort((left, right) => Number(right?.volume_1h || 0) - Number(left?.volume_1h || 0))) {
      if (!row?.address) continue;
      const key = chain === 'sol' ? String(row.address) : String(row.address).toLowerCase();
      if (!unique.has(key)) unique.set(key, row);
    }
    const retained = [...unique.values()].slice(0, limit);
    coverage.categories[type] = {
      returnedCount: rows.length, dedupedCount: unique.size, retainedCount: retained.length,
      providerExceededLimit: rows.length > limit, locallyCapped: unique.size > limit,
      locallyDeduplicated: rows.length !== unique.size
    };
    if (Array.isArray(value[type])) compacted[type] = retained;
  }
  compacted._coverage = coverage;
  return compacted;
}

export class GmgnClient {
  constructor({ timeoutMs = 15_000, maxResponseBytes = MAX_RESPONSE_BYTES, minRequestGapMs = 1_100, apiKeyProvider = null,
    legacyKeyProvider = () => '', fetch = globalThis.fetch, now = Date.now, randomUUID = () => globalThis.crypto.randomUUID(),
    wait = delay, admissionStateStore = new MemoryGmgnAdmissionStateStore(), admissionReservation = null } = {}) {
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;
    this.minRequestGapMs = minRequestGapMs;
    this.apiKeyProvider = typeof apiKeyProvider === 'function' ? apiKeyProvider : null;
    this.legacyKeyProvider = legacyKeyProvider;
    this.fetch = fetch;
    this.now = now;
    this.randomUUID = randomUUID;
    this.wait = wait;
    this.admissionStateStore = admissionStateStore;
    this.admissionReservation = admissionReservation === null ? null : this.#reservation(admissionReservation);
    this.admission = admissionState();
    this.admissionOverrides = new Map();
    this.admissionInitialization = null;
    this.admissionFailure = null;
    this.admissionLoaded = false;
    this.pendingCredentialChanges = 0;
    this.lastVerifiedKey = '';
    this.queue = Promise.resolve();
    this.cache = new Map();
    this.disabled = false;
    this.metrics = { requests: 0, cacheHits: 0, rateLimits: 0 };
  }

  get nextAllowedAt() { return this.admission.nextAllowedAt; }
  set nextAllowedAt(value) { this.#overrideAdmission('nextAllowedAt', value); }
  get backoffFactor() { return this.admission.backoffFactor; }
  set backoffFactor(value) { this.#overrideAdmission('backoffFactor', value); }
  get lastRequestAt() { return this.admission.lastRequestAt; }
  set lastRequestAt(value) { this.#overrideAdmission('lastRequestAt', value); }
  get lastWeight() { return this.admission.lastWeight; }
  set lastWeight(value) { this.#overrideAdmission('lastWeight', value); }
  get successStreak() { return this.admission.successStreak; }
  set successStreak(value) { this.#overrideAdmission('successStreak', value); }
  get spacingReadyAt() { return this.admission.spacingReadyAt; }
  set spacingReadyAt(value) { this.#overrideAdmission('spacingReadyAt', value); }
  get keyEpoch() { return this.admission.keyEpoch + this.pendingCredentialChanges; }

  apiKey() {
    if (this.disabled) return '';
    return normalizeGmgnApiKey(this.apiKeyProvider?.()) || normalizeGmgnApiKey(this.legacyKeyProvider?.());
  }

  async configured() {
    return Boolean(this.apiKey());
  }

  resetCredentials({ disabled = false } = {}) {
    this.disabled = disabled;
    this.cache.clear();
    this.lastVerifiedKey = '';
    this.pendingCredentialChanges++;
    const task = this.#enqueue(async () => {
      try {
        await this.#ensureAdmissionState();
        await this.#persistAdmission({ ...this.admission, keyEpoch: this.admission.keyEpoch + 1 });
      } finally {
        this.pendingCredentialChanges--;
      }
    });
    return task;
  }

  async tokenInfo(chain, address, options = {}) {
    validateChain(chain); validateAddress(chain, address);
    return this.#read('tokenInfo', 'GET', '/v1/token/info', { chain, address }, null, options);
  }

  async tokenSecurity(chain, address, options = {}) {
    validateChain(chain); validateAddress(chain, address);
    return this.#read('tokenSecurity', 'GET', '/v1/token/security', { chain, address }, null, options);
  }

  async tokenPoolInfo(chain, address, options = {}) {
    validateChain(chain); validateAddress(chain, address);
    return this.#read('tokenPoolInfo', 'GET', '/v1/token/pool_info', { chain, address }, null, options);
  }

  async tokenTopHolders(chain, address, { limit = 20, order_by = 'amount_percentage', direction = 'desc', tag, ...options } = {}) {
    validateChain(chain); validateAddress(chain, address); validateLimit(limit, 100);
    return this.#read('tokenTopHolders', 'GET', '/v1/market/token_top_holders', { chain, address, limit, order_by, direction, tag }, null, options);
  }

  async tokenTopTraders(chain, address, { limit = 20, order_by = 'amount_percentage', direction = 'desc', tag, ...options } = {}) {
    validateChain(chain); validateAddress(chain, address); validateLimit(limit, 100);
    return this.#read('tokenTopTraders', 'GET', '/v1/market/token_top_traders', { chain, address, limit, order_by, direction, tag }, null, options);
  }

  async tokenKline(chain, address, resolution, from, to, options = {}) {
    validateChain(chain); validateAddress(chain, address);
    if (resolution !== '1m' || !Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from) {
      throw errorWith('GMGN_INVALID_REQUEST', 'Invalid candle request');
    }
    return this.#read('tokenKline', 'GET', '/v1/market/token_kline', { chain, address, resolution, from, to }, null, options);
  }

  async marketRank(chain, interval, { limit = 100, apiKey, deadline, verification, signal, ...query } = {}) {
    validateChain(chain); validateLimit(limit, 100);
    if (!['1m', '5m'].includes(interval)) throw errorWith('GMGN_INVALID_REQUEST', 'Invalid discovery request');
    return this.#read('marketRank', 'GET', '/v1/market/rank', { chain, interval, limit, ...query }, null, { apiKey, deadline, verification, signal });
  }

  async trenches(chain, { types = ['new_creation', 'near_completion', 'completed'], limit = 80, filters = {}, ...options } = {}) {
    validateChain(chain); validateLimit(limit, 80);
    if (!Array.isArray(types) || !types.length || types.some(type => !TRENCH_TYPES.has(type))) {
      throw errorWith('GMGN_INVALID_REQUEST', 'Invalid trenches request');
    }
    const data = await this.#read('trenches', 'POST', '/v1/trenches', { chain }, buildTrenchesBody(chain, types, limit, filters), options);
    return compactTrenches(data, chain, types, limit);
  }

  async verifyApiKey(apiKey, { signal = null, timeoutMs = 45_000 } = {}) {
    const key = normalizeGmgnApiKey(apiKey);
    if (!key) throw translateGmgnError(errorWith('GMGN_AUTH_FAILED', 'invalid api key'));
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw errorWith('GMGN_INVALID_REQUEST', 'Invalid verification timeout');
    const deadline = this.now() + timeoutMs;
    await this.#read('marketRank', 'GET', '/v1/market/rank', { chain: 'sol', interval: '1m', limit: 1 }, null, {
      apiKey: key, deadline, verification: true, signal
    });
    return { verified: true };
  }

  async discover(chain = 'robinhood') {
    const filters = {
      min_created: '5m', max_created: '10080m', min_marketcap: 10_000,
      max_marketcap: 150_000, min_liquidity: 3_000
    };
    const [trenches, trending] = await Promise.allSettled([
      this.trenches(chain, {
        types: ['completed'], limit: 80,
        filters: { max_rug_ratio: 0.3, max_bundler_rate: 0.3, max_insider_ratio: 0.3, ...filters }
      }),
      this.marketRank(chain, '5m', { limit: 100, order_by: 'volume', direction: 'desc', ...filters })
    ]);
    const trenchRows = trenches.status === 'fulfilled' ? normalizeGmgnList(trenches.value, ['completed']) : [];
    const trendingRows = trending.status === 'fulfilled' ? normalizeGmgnList(trending.value, ['rank']) : [];
    this.lastDiscoveryHealth = {
      complete: trenches.status === 'fulfilled' && trending.status === 'fulfilled',
      trenches: trenches.status === 'fulfilled'
        ? { ok: true, count: trenchRows.length, coverage: trenches.value?._coverage }
        : errorSummary(trenches.reason),
      trending: trending.status === 'fulfilled' ? { ok: true, count: trendingRows.length } : errorSummary(trending.reason),
      checkedAt: this.now()
    };
    const rows = [...trenchRows, ...trendingRows];
    if (!rows.length) {
      const failures = [trenches, trending].filter(result => result.status === 'rejected');
      if (failures.length === 2) throw failures[0].reason;
    }
    const merged = new Map();
    for (const row of rows.filter(row => row?.address)) {
      const key = chain === 'sol' ? String(row.address) : String(row.address).toLowerCase();
      merged.set(key, mergeDefined(merged.get(key), row));
    }
    return [...merged.values()];
  }

  async audit(address, nowSec = Math.floor(this.now() / 1000), chain = 'robinhood', { shouldStopEarly } = {}) {
    const from = (nowSec - 20 * 60) * 1000;
    const to = nowSec * 1000;
    const staticCalls = await Promise.allSettled([
      this.#cachedRead(`tokenInfo:${chain}:${address}`, () => this.tokenInfo(chain, address), 15_000),
      this.#cachedRead(`tokenSecurity:${chain}:${address}`, () => this.tokenSecurity(chain, address), 60_000),
      this.#cachedRead(`tokenPoolInfo:${chain}:${address}`, () => this.tokenPoolInfo(chain, address), 15_000)
    ]);
    const partial = {
      info: staticCalls[0].status === 'fulfilled' ? unwrapGmgn(staticCalls[0].value) : {},
      security: staticCalls[1].status === 'fulfilled' ? unwrapGmgn(staticCalls[1].value) : {},
      pool: staticCalls[2].status === 'fulfilled' ? unwrapGmgn(staticCalls[2].value) : {},
      holders: [], traders: [], candles: [], _meta: { complete: false, earlyExit: true }
    };
    if (staticCalls.every(result => result.status === 'fulfilled') && shouldStopEarly?.(partial)) return partial;
    const dynamicCalls = await Promise.allSettled([
      this.#cachedRead(`tokenTopHolders:${chain}:${address}`, () => this.tokenTopHolders(chain, address, { limit: 100 }), 15_000),
      this.#cachedRead(`tokenTopTraders:${chain}:${address}`, () => this.tokenTopTraders(chain, address, { limit: 50 }), 15_000),
      this.#cachedRead(`tokenKline:${chain}:${address}:${from}:${to}`, () => this.tokenKline(chain, address, '1m', from, to), 15_000)
    ]);
    const calls = [...staticCalls, ...dynamicCalls];
    const names = ['info', 'security', 'pool', 'holders', 'traders', 'candles'];
    const endpoints = Object.fromEntries(names.map((name, index) => [name,
      calls[index].status === 'fulfilled' ? { ok: true } : errorSummary(calls[index].reason)
    ]));
    if (calls.every(call => call.status === 'rejected')) {
      const limited = calls.find(call => call.reason?.code === 'GMGN_RATE_LIMITED');
      throw limited?.reason || calls[0].reason;
    }
    const value = index => calls[index].status === 'fulfilled' ? calls[index].value : null;
    return {
      info: unwrapGmgn(value(0)) || {}, security: unwrapGmgn(value(1)) || {}, pool: unwrapGmgn(value(2)) || {},
      holders: normalizeGmgnList(value(3)), traders: normalizeGmgnList(value(4)), candles: normalizeGmgnList(value(5)),
      _meta: { complete: calls.every(call => call.status === 'fulfilled'), endpoints, auditedAt: this.now() }
    };
  }

  async priceAt(address, targetAt, chain, { deadline = Infinity, signal } = {}) {
    const from = targetAt - 120_000;
    const to = targetAt + 60_000;
    const raw = await this.tokenKline(chain, address, '1m', from, to, { deadline, signal });
    const rows = normalizeGmgnList(raw).map(row => ({ at: Number(row.time) + 60_000, price: Number(row.close) }))
      .filter(row => Number.isFinite(row.at) && row.at <= this.now() && Math.abs(row.at - targetAt) <= 60_000 && row.price > 0 && Number.isFinite(row.price))
      .sort((left, right) => Math.abs(left.at - targetAt) - Math.abs(right.at - targetAt));
    return rows[0] ? { ...rows[0], source: 'GMGN_1M_CLOSE' } : null;
  }

  async #cachedRead(key, operation, ttlMs) {
    await this.#ensureAdmissionState();
    const epoch = this.keyEpoch;
    const cacheKey = `${epoch}:${key}`;
    const cached = this.cache.get(cacheKey);
    if (!this.disabled && cached && this.now() - cached.at < ttlMs) {
      this.metrics.cacheHits++;
      return structuredClone(cached.value);
    }
    const value = await operation();
    if (!this.disabled && epoch === this.keyEpoch) {
      this.cache.set(cacheKey, { value, at: this.now() });
      if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value);
    }
    return value;
  }

  async #read(operation, method, path, query, body, options) {
    return this.#enqueue(() => this.#readNow(operation, method, path, query, body, options));
  }

  #enqueue(operation) {
    const task = this.queue.then(operation);
    this.queue = task.catch(() => {});
    return task;
  }

  async #readNow(operation, method, path, query, body, { apiKey = this.apiKey(), deadline = Infinity, verification = false, signal = null } = {}) {
    await this.#ensureAdmissionState();
    if (this.disabled && !verification) throw translateGmgnError(errorWith('GMGN_AUTH_FAILED', 'invalid api key'));
    if (!apiKey) throw translateGmgnError(errorWith('GMGN_AUTH_FAILED', 'invalid api key'));
    const epoch = this.keyEpoch;
    const startedAt = this.now();
    if (this.nextAllowedAt > startedAt) {
      throw Object.assign(new Error(`GMGN请求频率超限，已停止本轮后续请求；约${Math.ceil((this.nextAllowedAt - startedAt) / 1000)}秒后可恢复，下一轮会自动重试。`), {
        code: 'GMGN_RATE_LIMITED', retryAfterMs: this.nextAllowedAt - startedAt
      });
    }
    const weight = gmgnRequestWeight(operation);
    const reserved = this.#consumeAdmissionReservation(weight);
    const waitMs = reserved ? 0 : Math.max(0, this.spacingReadyAt - startedAt);
    if (waitMs) await this.wait(waitMs);
    if ((this.disabled && !verification) || epoch !== this.keyEpoch) throw translateGmgnError(errorWith('GMGN_AUTH_FAILED', 'invalid api key'));
    const remainingMs = Math.min(this.timeoutMs, deadline - this.now());
    if (!(remainingMs > 0)) throw translateGmgnError(errorWith('GMGN_TIMEOUT', 'request deadline expired'));

    const requestAt = this.now();
    if (!reserved) {
      await this.#persistAdmission({
        ...this.admission,
        lastRequestAt: requestAt,
        lastWeight: weight,
        spacingReadyAt: requestAt + this.minRequestGapMs * weight * this.backoffFactor
      });
    }
    this.metrics.requests++;
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener?.('abort', abort, { once: true });
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, remainingMs);
    timeout.unref?.();
    try {
      const params = buildQuery(query, this.now, this.randomUUID);
      const response = await this.fetch(`${API_ORIGIN}${path}?${params.toString()}`, {
        method,
        headers: { 'X-APIKEY': apiKey, 'Content-Type': 'application/json' },
        ...(body === null ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal
      });
      const data = parseEnvelope(response, await boundedResponseText(response, this.maxResponseBytes));
      const nextAdmission = { ...this.admission, successStreak: this.successStreak + 1 };
      if (nextAdmission.successStreak >= 30) {
        nextAdmission.backoffFactor = Math.max(1, this.backoffFactor - 0.25);
        nextAdmission.successStreak = 0;
      }
      await this.#persistAdmission(nextAdmission);
      if (!this.disabled && epoch === this.keyEpoch) this.lastVerifiedKey = apiKey;
      return data;
    } catch (error) {
      if (error?.code === 'GMGN_ADMISSION_STATE_UNAVAILABLE') throw error;
      const source = timedOut
        ? errorWith('GMGN_TIMEOUT', 'request timed out')
        : error?.code
          ? error
          : errorWith('GMGN_NETWORK_ERROR', 'network request failed');
      const translated = translateGmgnError(source);
      const blocked = translated.code === 'GMGN_RATE_LIMIT_BLOCKED';
      if (translated.code === 'GMGN_RATE_LIMITED' || blocked) {
        // A block states when it lifts, so it arms the shared cooldown from that deadline
        // without inventing a floor and without escalating the rate-limit backoff.
        await this.#persistAdmission({
          ...this.admission,
          nextAllowedAt: Math.max(this.nextAllowedAt, this.now() + (Number(translated.retryAfterMs) || 0)),
          backoffFactor: blocked ? this.backoffFactor : Math.min(8, this.backoffFactor * 2),
          successStreak: 0
        });
        if (!blocked) this.metrics.rateLimits++;
        if (translated.rateLimitEvidence) {
          this.metrics.lastRateLimitEvidence = { code: translated.code, ...translated.rateLimitEvidence };
        }
      }
      throw translated;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener?.('abort', abort);
    }
  }

  #overrideAdmission(field, value) {
    const next = admissionState({ ...this.admission, [field]: value });
    const resolved = this.admissionLoaded && MONOTONIC_ADMISSION_FIELDS.has(field)
      ? Math.max(this.admission[field], next[field])
      : next[field];
    this.admission = admissionState({ ...this.admission, [field]: resolved });
    this.admissionOverrides.set(field, resolved);
  }

  async #ensureAdmissionState() {
    if (this.admissionFailure) throw this.admissionFailure;
    if (!this.admissionInitialization) {
      this.admissionInitialization = this.#loadAdmissionState().catch(error => {
        this.admissionFailure = this.#admissionFailure(error);
        throw this.admissionFailure;
      });
    }
    return this.admissionInitialization;
  }

  async #loadAdmissionState() {
    if (!this.admissionStateStore || typeof this.admissionStateStore.read !== 'function' || typeof this.admissionStateStore.write !== 'function') {
      throw new Error('invalid admission state store');
    }
    let next = admissionState(await this.admissionStateStore.read());
    if (this.admissionOverrides.size) {
      next = mergeBootstrapAdmissionState(next, Object.fromEntries(this.admissionOverrides));
      await this.admissionStateStore.write(structuredClone(next));
      this.admissionOverrides.clear();
    }
    this.admission = next;
    this.admissionLoaded = true;
  }

  async #persistAdmission(next) {
    if (this.admissionFailure) throw this.admissionFailure;
    const value = admissionState(next);
    try {
      const persisted = await this.admissionStateStore.write(structuredClone(value));
      this.admission = admissionState(persisted === undefined ? value : persisted);
    } catch (error) {
      this.admissionFailure = this.#admissionFailure(error);
      throw this.admissionFailure;
    }
    return this.admission;
  }

  #reservation(value) {
    if (!value || typeof value !== 'object' || !Number.isSafeInteger(value.requestAt) || value.requestAt < 0
      || !positiveInteger(value.weight, 0) || !Number.isSafeInteger(value.spacingReadyAt) || value.spacingReadyAt < value.requestAt
      || !Number.isSafeInteger(value.keyEpoch) || value.keyEpoch < 0) {
      throw errorWith('GMGN_ADMISSION_RESERVATION_INVALID', 'GMGN request reservation is invalid');
    }
    return { requestAt: value.requestAt, weight: value.weight, spacingReadyAt: value.spacingReadyAt, keyEpoch: value.keyEpoch, consumed: false };
  }

  #consumeAdmissionReservation(weight) {
    const reservation = this.admissionReservation;
    if (!reservation) return false;
    if (reservation.consumed || reservation.weight !== weight || this.now() < reservation.requestAt
      || reservation.keyEpoch !== this.admission.keyEpoch || reservation.spacingReadyAt !== this.admission.spacingReadyAt
      || this.admission.lastRequestAt !== reservation.requestAt || this.admission.lastWeight !== reservation.weight) {
      throw errorWith('GMGN_ADMISSION_RESERVATION_INVALID', 'GMGN request reservation no longer matches durable admission state');
    }
    reservation.consumed = true;
    return true;
  }

  #admissionFailure(_error) {
    return errorWith('GMGN_ADMISSION_STATE_UNAVAILABLE', 'GMGN request admission state is unavailable');
  }
}
