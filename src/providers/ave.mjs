import { normalizeTokenAddress } from '../address.mjs';
import { SCAN_CHAINS } from '../chains.mjs';

// AVE Data REST only. No wallet, signing, trading, arbitrary URL, or retry.
// https://ave-cloud.gitbook.io/data-api/rest/tokens
// https://ave-cloud.gitbook.io/data-api/rest/klines
//
// The parsers and market projection below are upstream's (src/ave.mjs in
// v0.1.10). The Worker replaces upstream's in-process client, file budget and
// request lane with one request per call: the scheduler owns pacing and the
// monthly credit budget durably, so nothing here waits, caches or retries.
export const AVE_LIMITS = Object.freeze({ timeoutMs: 12000, maxBytes: 1048576, detailsTtlMs: 30000 });
export const AVE_CHAINS = Object.freeze({ bsc: 'bsc', eth: 'eth', base: 'base', robinhood: 'robinhood', arc: 'arc' });
// Estimated credit units per request, as upstream accounts them.
export const AVE_CU = Object.freeze({ trending: 5, details: 5, klines: 10 });
const ORIGIN = 'https://prod.ave-api.com';

/** The token's page on ave.ai, or '' when AVE has no id for the chain or the address is not a token address. */
export function aveTokenUrl(chain, address) {
  const ca = Object.hasOwn(AVE_CHAINS, chain) ? normalizeTokenAddress(address) : null;
  return ca ? `https://ave.ai/token/${ca}-${AVE_CHAINS[chain]}` : '';
}
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';

for (const chain of SCAN_CHAINS) {
  if (!Object.hasOwn(AVE_CHAINS, chain)) throw new Error(`scan chain ${chain} has no AVE chain slug`);
}

const messages = {
  INPUT: 'AVE 只读请求参数无效', CONFIG: 'AVE 行情凭证未配置',
  ABORTED: 'AVE 行情请求已取消', TIMEOUT: 'AVE 行情响应超时',
  NETWORK: 'AVE 行情连接失败', SCHEMA: 'AVE 行情格式或链标识不匹配', SIZE: 'AVE 行情响应过大',
  AUTH: 'AVE 行情凭证或权限未通过', QUOTA: 'AVE 配额不足，已停止请求；不会自动购买',
  RATE_LIMITED: 'AVE 行情限流，已进入冷却', UPSTREAM: 'AVE 行情请求未成功', NOT_FOUND: 'AVE 在此链上没有该代币'
};
export class AveError extends Error {
  constructor(kind, status = 502, retryAt = null) {
    super(messages[kind]); this.name = 'AveError'; this.code = 'AVE_' + kind; this.status = status;
    if (retryAt !== null) this.retryAt = retryAt;
  }
}
const fail = (kind, status, retryAt) => new AveError(kind, status, retryAt);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, limit) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, limit) : '';
// The token's website as AVE lists it, kept only as an http(s) URL.
const webUrl = value => URL.canParse(text(value, 2048)) && ['http:', 'https:'].includes(new URL(text(value, 2048)).protocol) ? new URL(text(value, 2048)).href : '';
const numeric = value => (typeof value === 'number' || typeof value === 'string' && /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const signedNumeric = value => (typeof value === 'number' || typeof value === 'string' && /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) && Number.isFinite(Number(value)) ? Number(value) : null;
// Optional evidence that never decides the screen: a malformed count is unknown, not a bad row.
const count = value => Number.isSafeInteger(numeric(value)) ? numeric(value) : null;
const taxRate = value => value == null || value === '' ? null : numeric(value) / 100;
const seconds = value => Number.isSafeInteger(value) && value > 0 && value < 100000000000 ? value : null;
const upstreamTime = value => seconds(value) === null ? null : value * 1000;

/** An AVE Data API key as the user pastes it; the empty string when it cannot be one. */
export function normalizeAveApiKey(value) {
  if (typeof value !== 'string') return '';
  const key = value.trim();
  return /^[\x21-\x7e]{8,512}$/.test(key) ? key : '';
}

function retryAfterMs(header, at) {
  if (!header || header.length > 128) return 0;
  const target = /^\d+(?:\.\d+)?$/.test(header.trim()) ? at + Number(header) * 1000 : Date.parse(header);
  return Number.isFinite(target) && target > at && target <= 8640000000000000 ? Math.ceil(target - at) : 0;
}
// Classify only. Never retain upstream prose, headers, URLs, credentials or
// request identifiers in logs, snapshots or durable state.
async function errorCategory(response, timeoutMs) {
  const reader = response.body?.getReader?.(); if (!reader) return 'unknown';
  let size = 0, content = '', timer;
  try {
    return await Promise.race([
      new Promise(resolve => { timer = setTimeout(() => resolve('unknown'), timeoutMs); }),
      (async () => {
        const decoder = new TextDecoder();
        while (size < 8192) {
          const part = await reader.read(); if (part.done) break;
          const bytes = part.value.subarray(0, 8192 - size); size += bytes.byteLength;
          content += decoder.decode(bytes, { stream: true });
        }
        if (/quota|credit|balance|insufficient|配额|积分|余额/i.test(content)) return 'quota';
        if (/captcha|challenge|cloudflare|access denied|IP.{0,12}(?:block|limit)/i.test(content)) return 'gateway';
        if (/too many|rate.?limit|frequency|qps|throttl|频率|限流/i.test(content)) return 'rate';
        return 'unknown';
      })()
    ]);
  } catch (error) {
    // A failed or aborted read leaves the refusal unclassified, not the request.
    if (error instanceof TypeError || error?.name === 'AbortError') return 'unknown';
    throw error;
  } finally { clearTimeout(timer); void reader.cancel().catch(() => {}); }
}
function input(chain, ca) {
  if (!Object.hasOwn(AVE_CHAINS, chain) || ca !== undefined && !normalizeTokenAddress(ca)) throw fail('INPUT', 400);
  return ca === undefined ? undefined : normalizeTokenAddress(ca);
}
function envelope(raw, trending = false) {
  if (!object(raw)) throw fail('SCHEMA');
  if (Object.hasOwn(raw, 'status')) {
    if (raw.status !== 1 || !object(raw.data)) throw fail('SCHEMA');
    return raw.data;
  }
  if (trending && Array.isArray(raw.tokens) && !Object.hasOwn(raw, 'code') && !Object.hasOwn(raw, 'error')) return raw;
  throw fail('SCHEMA');
}
function checkEcho(row, chain, ca, requireAddress = false) {
  if (!object(row) || row.chain !== AVE_CHAINS[chain]) throw fail('SCHEMA');
  for (const field of ['token', 'address']) if (Object.hasOwn(row, field) && normalizeTokenAddress(row[field]) !== ca) throw fail('SCHEMA');
  if (Object.hasOwn(row, 'token_id') && row.token_id !== ca + '-' + AVE_CHAINS[chain]) throw fail('SCHEMA');
  if (requireAddress && normalizeTokenAddress(row.token) !== ca) throw fail('SCHEMA');
}
function tokenRow(row, chain, ca, required = false) {
  checkEcho(row, chain, ca, required);
  const price = numeric(row.current_price_usd);
  if (!(price > 0)) throw fail('SCHEMA');
  for (const field of ['market_cap', 'tvl', 'main_pair_tvl', 'token_tx_volume_usd_5m',
    'token_buy_volume_u_5m', 'token_sell_volume_u_5m']) {
    if (row[field] != null && numeric(row[field]) === null) throw fail('SCHEMA');
  }
  for (const field of ['holders', 'token_tx_count_5m', 'token_buy_tx_count_5m', 'token_sell_tx_count_5m']) {
    if (row[field] != null && !Number.isSafeInteger(numeric(row[field]))) throw fail('SCHEMA');
  }
  for (const field of ['updated_at', 'launch_at', 'created_at']) {
    // AVE occasionally uses zero as an explicit "not indexed yet" marker.
    // Preserve that as unknown, but reject every other malformed timestamp.
    if (row[field] != null && row[field] !== 0 && seconds(row[field]) === null) throw fail('SCHEMA');
  }
  if (row.token_price_change_5m != null && signedNumeric(row.token_price_change_5m) === null) throw fail('SCHEMA');
  // AVE states taxes in percent ("3.5" is 3.5%); a blank tax is unknown, never zero.
  for (const field of ['buy_tax', 'sell_tax']) if (row[field] != null && row[field] !== '' && !(numeric(row[field]) <= 100)) throw fail('SCHEMA');
  return { token: ca, chain, apiChain: AVE_CHAINS[chain], name: text(row.name, 100), symbol: text(row.symbol, 40),
    current_price_usd: price, market_cap: numeric(row.market_cap), holders: numeric(row.holders), tvl: numeric(row.tvl),
    main_pair_tvl: numeric(row.main_pair_tvl), token_tx_volume_usd_5m: numeric(row.token_tx_volume_usd_5m),
    token_buy_volume_u_5m: numeric(row.token_buy_volume_u_5m), token_sell_volume_u_5m: numeric(row.token_sell_volume_u_5m),
    token_tx_count_5m: numeric(row.token_tx_count_5m), token_buy_tx_count_5m: numeric(row.token_buy_tx_count_5m),
    token_sell_tx_count_5m: numeric(row.token_sell_tx_count_5m), token_sellers_24h: count(row.token_sellers_24h),
    token_price_change_5m: signedNumeric(row.token_price_change_5m),
    buy_tax: taxRate(row.buy_tax), sell_tax: taxRate(row.sell_tax),
    launch_at: seconds(row.launch_at), created_at: seconds(row.created_at), website: webUrl(row.website),
    updated_at: row.updated_at ?? null, sourceUpdatedAt: upstreamTime(row.updated_at),
    identityBasis: row.token === undefined && row.address === undefined ? 'request_path' : 'response' };
}
function outerEcho(raw, chain) {
  if (raw?.chain !== undefined && raw.chain !== AVE_CHAINS[chain]) throw fail('SCHEMA');
}
function parseTrending(raw, chain) {
  outerEcho(raw, chain); const data = envelope(raw, true); outerEcho(data, chain);
  if (!Array.isArray(data.tokens) || data.tokens.length > 100) throw fail('SCHEMA');
  const seen = new Map(), invalid = new Set(), rows = [];
  for (const row of data.tokens) {
    const ca = normalizeTokenAddress(row?.token);
    if (!ca) continue;
    let parsed;
    try { parsed = tokenRow(row, chain, ca, true); }
    catch (error) {
      // A hot-list can contain a newly indexed row before all of its market
      // fields are complete. Drop only that untrusted row; never let one bad
      // item take an otherwise valid chain offline. A wholly invalid nonempty
      // response still fails closed below.
      if (error?.code !== 'AVE_SCHEMA') throw error;
      if (seen.has(ca) || invalid.has(ca)) throw fail('SCHEMA');
      invalid.add(ca);
      continue;
    }
    if (invalid.has(ca)) throw fail('SCHEMA');
    const prior = seen.get(ca);
    if (prior) {
      // AVE's leaderboard can repeat an identical token row. Collapse
      // only an identical validated market identity; conflicting duplicates
      // remain a schema error so one address cannot smuggle two realities.
      if (JSON.stringify(prior) !== JSON.stringify(parsed)) throw fail('SCHEMA');
      continue;
    }
    seen.set(ca, parsed); rows.push(parsed);
  }
  if (data.tokens.length && !rows.length) throw fail('SCHEMA');
  if (data.next_page != null && (!Number.isSafeInteger(data.next_page) || data.next_page < -1)) throw fail('SCHEMA');
  return { rows, nextPage: data.next_page ?? null };
}
function parseDetails(raw, chain, ca) {
  outerEcho(raw, chain); const data = envelope(raw); outerEcho(data, chain);
  // A successful answer holding no token and no pairs: AVE has not indexed this address on the chain.
  if ((data.token == null || (object(data.token) && !Object.keys(data.token).length)) && Array.isArray(data.pairs) && !data.pairs.length) throw fail('NOT_FOUND', 404);
  if (!object(data.token) || !Array.isArray(data.pairs) || data.pairs.length > 100) throw fail('SCHEMA');
  return { token: tokenRow(data.token, chain, ca) };
}
function parseKlines(raw, chain, ca, capturedAt, fromTime, toTime) {
  outerEcho(raw, chain); const data = envelope(raw); outerEcho(data, chain);
  for (const field of ['address', 'token']) if (data[field] !== undefined && normalizeTokenAddress(data[field]) !== ca) throw fail('SCHEMA');
  if (data.token_id !== undefined && data.token_id !== ca + '-' + AVE_CHAINS[chain] || data.interval !== 1 || !Array.isArray(data.points) || data.points.length > 1000) throw fail('SCHEMA');
  const byTime = new Map(), closedAt = Math.min(capturedAt, toTime ?? capturedAt);
  for (const p of data.points) {
    if (!object(p) || seconds(p.time) === null || p.time % 60 !== 0) throw fail('SCHEMA');
    const candle = { time: p.time * 1000, open: numeric(p.open), high: numeric(p.high), low: numeric(p.low), close: numeric(p.close), volume: numeric(p.volume) };
    if (![candle.open, candle.high, candle.low, candle.close].every(n => n > 0) || candle.volume === null || candle.high < Math.max(candle.open, candle.close) || candle.low > Math.min(candle.open, candle.close) || candle.low > candle.high) throw fail('SCHEMA');
    const prior = byTime.get(candle.time);
    if (prior && JSON.stringify(prior) !== JSON.stringify(candle)) throw fail('SCHEMA');
    byTime.set(candle.time, candle);
  }
  const list = [...byTime.values()].filter(p => p.time >= (fromTime ?? Math.floor(capturedAt / 60000) * 60000 - 3600000) && p.time + 60000 <= closedAt).sort((a, b) => a.time - b.time).slice(-60);
  return { chain, address: ca, list, sourceUpdatedAt: list.at(-1)?.time + 60000 || null, scope: 'token_usd_1m', identityBasis: 'request_path', volumeUnit: 'upstream_unspecified' };
}
export function tokenInfoPrice(info, now = Date.now()) {
  if (info?.marketProvider === 'AVE' && (info.stale !== false || !Number.isFinite(info.capturedAt) || info.capturedAt > now ||
    !Number.isFinite(info.expiresAt) || info.expiresAt <= now)) return null;
  const price = numeric(info?.price?.price ?? info?.price ?? info?.current_price_usd);
  return price > 0 ? price : null;
}
function marketRow(row, capturedAt, now) {
  const sampledAt = row.sourceUpdatedAt;
  const expiresAt = sampledAt === null ? null : Math.min(capturedAt, sampledAt) + AVE_LIMITS.detailsTtlMs;
  const launchedAt = row.launch_at ?? row.created_at;
  const ageBasis = row.launch_at !== null ? 'launch' : row.created_at !== null ? 'token' : null;
  return { address: row.token, chain: row.chain, symbol: row.symbol, name: row.name, source: 'AVE', marketProvider: 'AVE',
    price: row.current_price_usd, market_cap: row.market_cap, holder_count: row.holders, tvl: row.tvl,
    marketCapSourceUpdatedAt: sampledAt, marketCapCapturedAt: capturedAt, marketCapExpiresAt: expiresAt,
    // These are first-party fields from AVE's trending/token response. They
    // are display/discovery market facts, not a contract-risk verdict.
    liquidity: row.main_pair_tvl ?? row.tvl, liquidityBasis: row.main_pair_tvl !== null ? 'main_pair_tvl' : row.tvl !== null ? 'token_tvl' : null,
    creation_timestamp: launchedAt, launch_at: row.launch_at, token_created_at: row.created_at, ageBasis,
    volume_5m: row.token_tx_volume_usd_5m, buy_volume_5m: row.token_buy_volume_u_5m,
    sell_volume_5m: row.token_sell_volume_u_5m, swaps_5m: row.token_tx_count_5m,
    buys_5m: row.token_buy_tx_count_5m, sells_5m: row.token_sell_tx_count_5m,
    // Distinct wallets that sold in the last 24 hours; on Arc they stand in for GoPlus's cannot_sell_all.
    sellers_24h: row.token_sellers_24h,
    price_change_percent5m: row.token_price_change_5m === null ? null : row.token_price_change_5m / 100,
    // AVE's own tax reading lets the screen drop high-tax tokens before any alert; GoPlus rechecks it later.
    buy_tax: row.buy_tax, sell_tax: row.sell_tax,
    rug_ratio: null, bundler_rate: null, rat_trader_amount_rate: null, is_wash_trading: null, is_honeypot: null,
    capturedAt, sourceUpdatedAt: sampledAt, sampledAt, expiresAt,
    stale: sampledAt === null || sampledAt > capturedAt + 30000 || now >= expiresAt,
    identityBasis: row.identityBasis };
}

async function readBody(response) {
  const declared = response.headers?.get?.('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > AVE_LIMITS.maxBytes)) throw fail('SIZE');
  if (!response.body?.getReader) throw fail('SCHEMA');
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > AVE_LIMITS.maxBytes) throw fail('SIZE'); chunks.push(part.value); }
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof AveError) throw error;
    if (error instanceof SyntaxError || error instanceof TypeError) throw fail('SCHEMA');
    throw error;
  } finally { void reader.cancel().catch(() => {}); }
}

/**
 * One AVE Data request per call. A failure is an AveError whose code the
 * scheduler's admission records: AVE_RATE_LIMITED (with retryAt when AVE sent
 * Retry-After), AVE_QUOTA, AVE_AUTH, or a transient transport/schema code.
 */
export class AveClient {
  #apiKey; #fetch; #now; #timeoutMs;
  constructor({ apiKey, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = AVE_LIMITS.timeoutMs } = {}) {
    if (typeof fetchImpl !== 'function' || typeof now !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > AVE_LIMITS.timeoutMs) throw fail('INPUT', 400);
    const key = normalizeAveApiKey(apiKey);
    if (!key) throw fail('CONFIG', 400);
    this.#apiKey = key; this.#fetch = fetchImpl; this.#now = now; this.#timeoutMs = timeoutMs;
  }

  /** The chain's trending list as upstream market rows, captured now. */
  async trending(chain, { signal } = {}) {
    input(chain);
    const raw = await this.#get('/v2/tokens/trending?chain=' + AVE_CHAINS[chain] + '&current_page=0&page_size=100', signal);
    const capturedAt = this.#now();
    const { rows } = parseTrending(raw, chain);
    return { rows: rows.map(row => marketRow(row, capturedAt, capturedAt)), capturedAt };
  }

  async details(chain, ca, { signal } = {}) {
    ca = input(chain, ca);
    if (!ca) throw fail('INPUT', 400);
    const raw = await this.#get('/v2/tokens/' + ca + '-' + AVE_CHAINS[chain], signal);
    return { ...parseDetails(raw, chain, ca), capturedAt: this.#now() };
  }

  /** One token's market row in the trending rows' shape, for a token AVE does not list as trending. */
  async market(chain, ca, { signal } = {}) {
    const { token, capturedAt } = await this.details(chain, ca, { signal });
    return { row: marketRow(token, capturedAt, capturedAt), capturedAt };
  }

  /** The closest closed one-minute candle to targetAt, or null when AVE has none within a minute. */
  async priceAt(ca, targetAt, chain, { signal } = {}) {
    ca = input(chain, ca);
    const at = this.#now();
    if (!ca || !Number.isFinite(targetAt) || targetAt <= 0 || targetAt > at) return null;
    const to = Math.min(Math.floor(at / 60000) * 60000, Math.ceil(targetAt / 60000) * 60000 + 60000), from = to - 180000;
    const raw = await this.#get('/v2/klines/token/' + ca + '-' + AVE_CHAINS[chain] + '?interval=1&limit=60&from_time=' + from / 1000 + '&to_time=' + to / 1000, signal);
    const capturedAt = this.#now(), result = parseKlines(raw, chain, ca, capturedAt, from, to);
    return result.list.map(row => ({ at: row.time + 60000, price: row.close, source: 'AVE_1M_CLOSE', capturedAt }))
      .filter(row => Math.abs(row.at - targetAt) <= 60000).sort((a, b) => Math.abs(a.at - targetAt) - Math.abs(b.at - targetAt))[0] || null;
  }

  async #get(path, signal) {
    if (signal?.aborted) throw fail('ABORTED', 499);
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.#timeoutMs);
    try {
      let response;
      try {
        // Workers' fetch rejects any receiver but the global scope.
        const fetchImpl = this.#fetch;
        response = await fetchImpl(ORIGIN + path, { method: 'GET', headers: { 'X-API-KEY': this.#apiKey, Accept: 'application/json' }, redirect: 'manual', signal: controller.signal });
      } catch (error) {
        if (timedOut) throw fail('TIMEOUT', 504);
        if (controller.signal.aborted) throw fail('ABORTED', 499);
        if (error instanceof TypeError) throw fail('NETWORK', 502);
        throw error;
      }
      const at = this.#now();
      if (response.status === 402 || response.status === 429) {
        // Some AVE gateways report exhausted credits as HTTP 429. Classify the
        // bounded response so quota exhaustion does not masquerade as a short
        // rate pause and trigger useless probes.
        const category = await errorCategory(response, Math.max(1, Math.min(250, this.#timeoutMs / 4)));
        if (response.status === 402 || category === 'quota') throw fail('QUOTA', 402);
        const delay = retryAfterMs(response.headers?.get?.('retry-after'), at);
        throw fail('RATE_LIMITED', 429, delay ? at + delay : null);
      }
      if (response.status === 401 || response.status === 403) throw fail('AUTH', 400);
      if (!response.ok) throw fail('UPSTREAM');
      let raw;
      try {
        raw = await readBody(response);
      } catch (error) {
        // An abort surfaces from the stream as whatever the runtime raises.
        if (controller.signal.aborted) throw fail(timedOut ? 'TIMEOUT' : 'ABORTED', timedOut ? 504 : 499);
        throw error;
      }
      // Never let an echoed credential reach a checkpoint or a log.
      return JSON.parse(JSON.stringify(raw, (_, value) => typeof value === 'string' ? value.split(this.#apiKey).join('[已移除凭证]') : value));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
}

/** Proves a candidate key can read AVE Data, using upstream's 5 CU WBNB details probe. */
export async function verifyAveApiKey(apiKey, { fetchImpl, now, signal } = {}) {
  await new AveClient({ apiKey, fetchImpl, now }).details('bsc', WBNB, { signal });
  return { verified: true };
}
