import { setTimeout as delay } from 'node:timers/promises';
import { legacyGmgnApiKey, normalizeGmgnApiKey } from '../gmgn-key-store.mjs';

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

function unwrap(raw) {
  let value = raw;
  for (let index = 0; index < 3; index++) {
    if (value && typeof value === 'object' && !Array.isArray(value) && value.data != null) value = value.data;
    else break;
  }
  return value;
}

export function normalizeList(raw, keys = ['list', 'rank', 'completed', 'tokens']) {
  const value = unwrap(raw);
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  for (const key of keys) if (Array.isArray(value[key])) return value[key];
  return [];
}

function retryAfterMs(message) {
  const match = String(message || '').match(/~?(\d+)s\s+remaining/i);
  return Math.min(5 * 60_000, Math.max(30_000, Number(match?.[1] || 30) * 1000));
}

function preserveErrorMetadata(translated, source) {
  for (const name of ['status', 'apiCode', 'apiError', 'apiMessage', 'resetAtUnix', 'headerResetAtUnix', 'bodyResetAtUnix']) {
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
  } else if (/RATE_LIMIT_EXCEEDED|RATE_LIMIT_BANNED|GMGN_RATE_LIMITED|HTTP\s*429|API\s*429/i.test(raw)) {
    const resetAtUnix = Math.max(Number(error?.headerResetAtUnix) || 0, Number(error?.bodyResetAtUnix) || 0, Number(error?.resetAtUnix) || 0);
    retryAfterMsValue = Math.max(retryAfterMs(raw), resetAtUnix * 1000 - Date.now() + 1000 || 0);
    code = 'GMGN_RATE_LIMITED';
    message = `GMGN请求频率超限，已停止本轮后续请求；约${Math.ceil(retryAfterMsValue / 1000)}秒后可恢复，下一轮会自动重试。`;
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

export function tokenInfoPrice(info) {
  const value = info?.price?.price ?? info?.price ?? info?.price_usd;
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const price = Number(value);
  return Number.isFinite(price) && price > 0 ? price : null;
}

function requestWeight(operation) {
  return ({ tokenTopHolders: 5, tokenTopTraders: 5, trenches: 3, tokenKline: 2 })[operation] || 1;
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
        status, headerResetAtUnix, resetAtUnix: headerResetAtUnix
      });
    }
    throw errorWith('GMGN_INVALID_RESPONSE', 'Response was not JSON', { status: response.status });
  }
  if (status < 200 || status >= 300 || !envelope || typeof envelope !== 'object' || envelope.code !== 0) {
    const bodyResetAtUnix = validUnixSeconds(envelope?.reset_at);
    throw errorWith('GMGN_API_ERROR', 'GMGN envelope reported an error', {
      status,
      apiCode: envelope?.code,
      apiError: envelope?.error,
      apiMessage: envelope?.message,
      headerResetAtUnix,
      bodyResetAtUnix,
      resetAtUnix: Math.max(headerResetAtUnix || 0, bodyResetAtUnix || 0) || undefined
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
    legacyKeyProvider = legacyGmgnApiKey, fetch = globalThis.fetch, now = Date.now, randomUUID = () => globalThis.crypto.randomUUID() } = {}) {
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;
    this.minRequestGapMs = minRequestGapMs;
    this.apiKeyProvider = typeof apiKeyProvider === 'function' ? apiKeyProvider : null;
    this.legacyKeyProvider = legacyKeyProvider;
    this.fetch = fetch;
    this.now = now;
    this.randomUUID = randomUUID;
    this.lastVerifiedKey = '';
    this.lastRequestAt = 0;
    this.nextAllowedAt = 0;
    this.queue = Promise.resolve();
    this.cache = new Map();
    this.keyEpoch = 0;
    this.disabled = false;
    this.backoffFactor = 1;
    this.successStreak = 0;
    this.lastWeight = 1;
    this.metrics = { requests: 0, cacheHits: 0, rateLimits: 0 };
  }

  apiKey() {
    if (this.disabled) return '';
    return normalizeGmgnApiKey(this.apiKeyProvider?.()) || normalizeGmgnApiKey(this.legacyKeyProvider?.());
  }

  async configured() {
    return Boolean(this.apiKey());
  }

  resetCredentials({ disabled = false } = {}) {
    this.keyEpoch++;
    this.disabled = disabled;
    this.cache.clear();
    this.lastVerifiedKey = '';
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

  async marketRank(chain, interval, { limit = 100, apiKey, deadline, verification, ...query } = {}) {
    validateChain(chain); validateLimit(limit, 100);
    if (!['1m', '5m'].includes(interval)) throw errorWith('GMGN_INVALID_REQUEST', 'Invalid discovery request');
    return this.#read('marketRank', 'GET', '/v1/market/rank', { chain, interval, limit, ...query }, null, { apiKey, deadline, verification });
  }

  async trenches(chain, { types = ['new_creation', 'near_completion', 'completed'], limit = 80, filters = {}, ...options } = {}) {
    validateChain(chain); validateLimit(limit, 80);
    if (!Array.isArray(types) || !types.length || types.some(type => !TRENCH_TYPES.has(type))) {
      throw errorWith('GMGN_INVALID_REQUEST', 'Invalid trenches request');
    }
    const data = await this.#read('trenches', 'POST', '/v1/trenches', { chain }, buildTrenchesBody(chain, types, limit, filters), options);
    return compactTrenches(data, chain, types, limit);
  }

  async verifyApiKey(apiKey) {
    const key = normalizeGmgnApiKey(apiKey);
    if (!key) throw translateGmgnError(errorWith('GMGN_AUTH_FAILED', 'invalid api key'));
    const deadline = this.now() + 45_000;
    await this.#read('marketRank', 'GET', '/v1/market/rank', { chain: 'sol', interval: '1m', limit: 1 }, null, {
      apiKey: key, deadline, verification: true
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
    const trenchRows = trenches.status === 'fulfilled' ? normalizeList(trenches.value, ['completed']) : [];
    const trendingRows = trending.status === 'fulfilled' ? normalizeList(trending.value, ['rank']) : [];
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
      info: staticCalls[0].status === 'fulfilled' ? unwrap(staticCalls[0].value) : {},
      security: staticCalls[1].status === 'fulfilled' ? unwrap(staticCalls[1].value) : {},
      pool: staticCalls[2].status === 'fulfilled' ? unwrap(staticCalls[2].value) : {},
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
      info: unwrap(value(0)) || {}, security: unwrap(value(1)) || {}, pool: unwrap(value(2)) || {},
      holders: normalizeList(value(3)), traders: normalizeList(value(4)), candles: normalizeList(value(5)),
      _meta: { complete: calls.every(call => call.status === 'fulfilled'), endpoints, auditedAt: this.now() }
    };
  }

  async priceAt(address, targetAt, chain, { deadline = Infinity } = {}) {
    const from = targetAt - 120_000;
    const to = targetAt + 60_000;
    const raw = await this.tokenKline(chain, address, '1m', from, to, { deadline });
    const rows = normalizeList(raw).map(row => ({ at: Number(row.time) + 60_000, price: Number(row.close) }))
      .filter(row => Number.isFinite(row.at) && row.at <= this.now() && Math.abs(row.at - targetAt) <= 60_000 && row.price > 0 && Number.isFinite(row.price))
      .sort((left, right) => Math.abs(left.at - targetAt) - Math.abs(right.at - targetAt));
    return rows[0] ? { ...rows[0], source: 'GMGN_1M_CLOSE' } : null;
  }

  async #cachedRead(key, operation, ttlMs) {
    const epoch = this.keyEpoch;
    const cached = this.cache.get(key);
    if (!this.disabled && cached && cached.epoch === epoch && this.now() - cached.at < ttlMs) {
      this.metrics.cacheHits++;
      return structuredClone(cached.value);
    }
    const value = await operation();
    if (!this.disabled && epoch === this.keyEpoch) {
      this.cache.set(key, { value, at: this.now(), epoch });
      if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value);
    }
    return value;
  }

  async #read(operation, method, path, query, body, options) {
    const task = this.queue.then(() => this.#readNow(operation, method, path, query, body, options));
    this.queue = task.catch(() => {});
    return task;
  }

  async #readNow(operation, method, path, query, body, { apiKey = this.apiKey(), deadline = Infinity, verification = false } = {}) {
    if (this.disabled && !verification) throw translateGmgnError(errorWith('GMGN_AUTH_FAILED', 'invalid api key'));
    if (!apiKey) throw translateGmgnError(errorWith('GMGN_AUTH_FAILED', 'invalid api key'));
    const epoch = this.keyEpoch;
    const startedAt = this.now();
    if (this.nextAllowedAt > startedAt) {
      throw Object.assign(new Error(`GMGN请求频率超限，已停止本轮后续请求；约${Math.ceil((this.nextAllowedAt - startedAt) / 1000)}秒后可恢复，下一轮会自动重试。`), {
        code: 'GMGN_RATE_LIMITED', retryAfterMs: this.nextAllowedAt - startedAt
      });
    }
    const waitMs = Math.max(0, this.lastRequestAt + this.minRequestGapMs * this.lastWeight * this.backoffFactor - startedAt);
    if (waitMs) await delay(waitMs);
    if ((this.disabled && !verification) || epoch !== this.keyEpoch) throw translateGmgnError(errorWith('GMGN_AUTH_FAILED', 'invalid api key'));
    const remainingMs = Math.min(this.timeoutMs, deadline - this.now());
    if (!(remainingMs > 0)) throw translateGmgnError(errorWith('GMGN_TIMEOUT', 'request deadline expired'));

    this.lastRequestAt = this.now();
    this.lastWeight = requestWeight(operation);
    this.metrics.requests++;
    const controller = new AbortController();
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
      if (!this.disabled && epoch === this.keyEpoch) this.lastVerifiedKey = apiKey;
      if (++this.successStreak >= 30) {
        this.backoffFactor = Math.max(1, this.backoffFactor - 0.25);
        this.successStreak = 0;
      }
      return data;
    } catch (error) {
      const source = timedOut
        ? errorWith('GMGN_TIMEOUT', 'request timed out')
        : error?.code
          ? error
          : errorWith('GMGN_NETWORK_ERROR', 'network request failed');
      const translated = translateGmgnError(source);
      if (translated.code === 'GMGN_RATE_LIMITED') {
        this.nextAllowedAt = this.now() + translated.retryAfterMs;
        this.backoffFactor = Math.min(8, this.backoffFactor * 2);
        this.successStreak = 0;
        this.metrics.rateLimits++;
      }
      throw translated;
    } finally {
      clearTimeout(timeout);
    }
  }
}
