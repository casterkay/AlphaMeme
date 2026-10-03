import { validTokenAddress } from '../address.mjs';
import { verifiedAvePoolEvidence } from '../pool-identity.mjs';
import { scannerSettings } from '../scanner-settings.mjs';
import { taxBreaches } from '../scoring/tax.mjs';

const DEX_CHAIN_IDS = Object.freeze({ bsc: 'bsc', base: 'base', eth: 'ethereum', arc: 'arc' });
// Fast overlays must use the same verified chain map as deep validation.
// Robinhood Chain currently has no verified DexScreener chain id here; a
// speculative request only wastes time and makes the UI overstate coverage.
const DEX_BATCH_CHAIN_IDS = DEX_CHAIN_IDS;
// Arc ids as DexScreener (dexscreener.com/arc) and GoPlus (chain 5042) publish them.
const GOPLUS_EVM_CHAIN_IDS = Object.freeze({ eth: '1', bsc: '56', base: '8453', arc: '5042' });

const NUMBER_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const DEFAULT_MAX_BYTES = 1_000_000;

function optionalNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || !NUMBER_PATTERN.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function optionalNonNegative(value) {
  const parsed = optionalNumber(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}

function optionalCount(value) {
  const parsed = optionalNonNegative(value);
  return parsed !== null && Number.isSafeInteger(parsed) ? parsed : null;
}

function optionalRate(value) {
  let parsed;
  if (typeof value === 'string' && value.trim().endsWith('%')) {
    const percent = optionalNumber(value.trim().slice(0, -1));
    parsed = percent === null ? null : percent / 100;
  } else {
    parsed = optionalNumber(value);
  }
  return parsed !== null && parsed >= 0 && parsed <= 1 ? parsed : null;
}

function optionalBoolean(value) {
  if (value === true || value === false) return value;
  if (value === 1 || value === 0) return value === 1;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes'].includes(normalized)) return true;
  if (['0', 'false', 'no'].includes(normalized)) return false;
  return null;
}

function nestedBoolean(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return optionalBoolean(value.status);
  return optionalBoolean(value);
}

function cleanString(value, maxLength = 160) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

const normalizedAddress = value => cleanString(value, 128).toLowerCase();

function sameAddress(left, right) {
  const a = normalizedAddress(left), b = normalizedAddress(right);
  return Boolean(a && b && a === b);
}

const validAddress = value => validTokenAddress(cleanString(value, 128));

function errorCode(error) {
  if (error?.code) return String(error.code).slice(0, 64);
  if (error?.name === 'AbortError') return 'TIMEOUT';
  return 'REQUEST_FAILED';
}

async function readLimitedText(response, maxBytes) {
  const contentLength = optionalNonNegative(response?.headers?.get?.('content-length'));
  if (contentLength !== null && contentLength > maxBytes) {
    const error = new Error('response too large');
    error.code = 'RESPONSE_TOO_LARGE';
    throw error;
  }

  if (response?.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        total += chunk.byteLength;
        if (total > maxBytes) {
          const error = new Error('response too large');
          error.code = 'RESPONSE_TOO_LARGE';
          throw error;
        }
        chunks.push(chunk);
      }
    } finally {
      if (total > maxBytes) await reader.cancel().catch(() => {});
    }
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(combined);
  }

  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    const error = new Error('response too large');
    error.code = 'RESPONSE_TOO_LARGE';
    throw error;
  }
  return text;
}

async function requestJson(fetchImpl, url, { timeoutMs, maxResponseBytes, signal, headers = {} }) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(signal.reason);
  if (signal) {
    if (signal.aborted) abortFromParent();
    else signal.addEventListener('abort', abortFromParent, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json', ...headers },
      signal: controller.signal
    });
    if (!response || typeof response.ok !== 'boolean') {
      const error = new Error('invalid response');
      error.code = 'INVALID_RESPONSE';
      throw error;
    }
    if (!response.ok) {
      const error = new Error('upstream HTTP error');
      error.code = `HTTP_${Number(response.status) || 0}`;
      throw error;
    }
    const contentType = cleanString(response.headers?.get?.('content-type'), 128).toLowerCase();
    if (contentType && !/(?:application|text)\/(?:[a-z0-9.+-]*\+)?json\b/.test(contentType)) {
      const error = new Error('invalid content type');
      error.code = 'INVALID_CONTENT_TYPE';
      throw error;
    }
    const text = await readLimitedText(response, maxResponseBytes);
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      const error = new Error('invalid JSON');
      error.code = 'INVALID_JSON';
      throw error;
    }
    if (parsed === null || typeof parsed !== 'object') {
      const error = new Error('invalid JSON root');
      error.code = 'INVALID_JSON_SHAPE';
      throw error;
    }
    return parsed;
  } catch (error) {
    if (controller.signal.aborted && error?.code !== 'RESPONSE_TOO_LARGE') {
      const timeout = new Error('request timed out');
      timeout.code = 'TIMEOUT';
      throw timeout;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abortFromParent);
  }
}

function validPairAddress(value) {
  return /^0x(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(cleanString(value, 128));
}

function parseDexBatch(payload, { dexChainId, tokenAddresses, capturedAt }) {
  if (!Array.isArray(payload) || payload.length > 1_000) {
    const error = new Error('unexpected DexScreener batch JSON shape');
    error.code = 'INVALID_JSON_SHAPE';
    throw error;
  }
  const requested = new Set(tokenAddresses.map(value => normalizedAddress(value)));
  const best = new Map();
  for (const pair of payload) {
    if (!pair || typeof pair !== 'object' || cleanString(pair.chainId, 32) !== dexChainId) continue;
    const baseAddress = normalizedAddress(pair.baseToken?.address);
    const members = [baseAddress, normalizedAddress(pair.quoteToken?.address)].filter(value => requested.has(value));
    if (!members.length || !validPairAddress(pair.pairAddress)) continue;
    const liquidity = optionalNonNegative(pair.liquidity?.usd);
    const volume5m = optionalNonNegative(pair.volume?.m5);
    const buys5m = optionalCount(pair.txns?.m5?.buys), sells5m = optionalCount(pair.txns?.m5?.sells);
    const createdAt = optionalNonNegative(pair.pairCreatedAt);
    if (liquidity === null || volume5m === null || !Number.isSafeInteger(createdAt)
      || createdAt <= 0 || createdAt > capturedAt + 300_000) continue;
    const poolMarket = {
      pairAddress: cleanString(pair.pairAddress, 128), dexId: cleanString(pair.dexId, 64),
      liquidity, volume5m, pairCreatedAt: createdAt,
      swaps5m: buys5m !== null && sells5m !== null && Number.isSafeInteger(buys5m + sells5m) ? buys5m + sells5m : null
    };
    for (const tokenAddress of members) {
      const market = { ...poolMarket,
        // DexScreener's price/market-cap fields describe baseToken only. Pool
        // metrics remain valid when the requested token happens to be quote.
        priceUsd: tokenAddress === baseAddress ? optionalNonNegative(pair.priceUsd) : null,
        marketCap: tokenAddress === baseAddress ? optionalNonNegative(pair.marketCap) : null,
        fdv: tokenAddress === baseAddress ? optionalNonNegative(pair.fdv) : null,
        // DexScreener's trade direction is defined for the base token.
        buys5m: tokenAddress === baseAddress ? buys5m : null,
        sells5m: tokenAddress === baseAddress ? sells5m : null };
      const previous = best.get(tokenAddress);
      if (!previous || market.liquidity > previous.liquidity) best.set(tokenAddress, market);
    }
  }
  return best;
}

function overlayDexMarket(rows, chain, marketByToken, capturedAt, ttlMs) {
  return rows.map(row => {
    const market = marketByToken.get(normalizedAddress(row?.address));
    if (!market) return row;
    const evidence = verifiedAvePoolEvidence(row, chain);
    const evidencePair = evidence?.pair || '';
    // Pair-scoped AVE facts (age, ATH and 1h move) are atomic. Do not combine
    // them with DexScreener's highest-liquidity *different* pool.
    if (evidencePair && evidencePair !== normalizedAddress(market.pairAddress)) return row;
    // An overlay without a strictly verified same-pool AVE identity starts a
    // new atomic pool tuple. Never carry a legacy first-trade clock, ATH or
    // other pair-scoped evidence into the selected DexScreener pool.
    const cleanRow = evidence ? row : { ...row, first_trade_at: null, firstTradeAt: null,
      last_trade_at: null, lastTradeAt: null, poolEvidence: null };
    const marketCap = market.marketCap ?? cleanRow.market_cap;
    const marketOverlayPriceUpdated = market.priceUsd > 0;
    // A fresh pool response without this token's price cannot refresh an old one.
    const price = marketOverlayPriceUpdated ? market.priceUsd : null;
    return {
      ...cleanRow, price, market_cap: marketCap,
      marketCapSourceUpdatedAt: market.marketCap !== null ? capturedAt : cleanRow.marketCapSourceUpdatedAt,
      marketCapCapturedAt: market.marketCap !== null ? capturedAt : cleanRow.marketCapCapturedAt,
      marketCapExpiresAt: market.marketCap !== null ? capturedAt + ttlMs : cleanRow.marketCapExpiresAt,
      liquidity: market.liquidity, volume_5m: market.volume5m,
      buys_5m: market.buys5m, sells_5m: market.sells5m, swaps_5m: market.swaps5m,
      buy_volume_5m: null, sell_volume_5m: null,
      volume: null, buys: null, sells: null, swaps: null,
      pool_created_at: Math.floor(market.pairCreatedAt / 1_000), poolCreatedAt: market.pairCreatedAt,
      pairAddress: market.pairAddress, dexId: market.dexId, ageBasis: 'pool', activityWindow: '5m',
      tokenSourceUpdatedAt: cleanRow.tokenSourceUpdatedAt ?? cleanRow.sourceUpdatedAt,
      tokenCapturedAt: cleanRow.tokenCapturedAt ?? cleanRow.capturedAt,
      capturedAt, sourceUpdatedAt: capturedAt, sampledAt: capturedAt, expiresAt: capturedAt + ttlMs, stale: false,
      marketOverlayProvider: 'DEXSCREENER', marketOverlayCapturedAt: capturedAt, marketOverlayPriceUpdated
    };
  });
}

// AVE remains the discovery source. This one bounded batch request only fills
// the live card's main-pool market fields while AVE's slower per-pool checks
// continue independently. Missing or malformed rows are never guessed.
/** DexScreener's best-liquidity pool facts for up to 30 tokens on one chain, as plain rows. */
export async function fetchDexMarkets(chain, tokenAddresses, { fetchImpl = globalThis.fetch, timeoutMs = 8_000, maxResponseBytes = DEFAULT_MAX_BYTES, signal, now = Date.now } = {}) {
  const dexChainId = DEX_BATCH_CHAIN_IDS[chain];
  const addresses = [...new Set(tokenAddresses.filter(validAddress).map(normalizedAddress))];
  if (!dexChainId || !addresses.length || addresses.length > 30) throw Object.assign(new Error('DexScreener batch input is invalid'), { code: 'INVALID_INPUT' });
  const url = `https://api.dexscreener.com/tokens/v1/${dexChainId}/${addresses.join(',')}`;
  const capturedAt = now();
  const payload = await requestJson(fetchImpl, url, { timeoutMs, maxResponseBytes, signal });
  return { capturedAt, markets: [...parseDexBatch(payload, { dexChainId, tokenAddresses: addresses, capturedAt })].map(([address, market]) => ({ address, ...market })) };
}

export class DexBatchMarketOverlay {
  constructor({ fetchImpl = globalThis.fetch, timeoutMs = 8_000, maxResponseBytes = DEFAULT_MAX_BYTES,
    now = () => Date.now(), ttlMs = 20_000, staleTtlMs = 60_000 } = {}) {
    if (typeof fetchImpl !== 'function' || typeof now !== 'function') throw new TypeError('fetch implementation is required');
    this.fetchImpl = fetchImpl;
    this.timeoutMs = Math.max(1, Number(timeoutMs) || 8_000);
    this.maxResponseBytes = Math.max(1_024, Number(maxResponseBytes) || DEFAULT_MAX_BYTES);
    this.now = now;
    this.ttlMs = Math.max(5_000, Math.min(30_000, Number(ttlMs) || 20_000));
    this.staleTtlMs = Math.max(this.ttlMs, Math.min(120_000, Number(staleTtlMs) || 60_000));
    this.cache = new Map();
    this.pending = new Map();
  }

  async enrich(chain, rows, { minMarketCap = 0, maxMarketCap = Number.MAX_SAFE_INTEGER } = {}) {
    if (!Array.isArray(rows)) return [];
    const normalizedChain = cleanString(chain, 24).toLowerCase();
    const dexChainId = DEX_BATCH_CHAIN_IDS[normalizedChain];
    if (!dexChainId) return rows;
    const addresses = [...new Set(rows.filter(row => {
      const marketCap = optionalNonNegative(row?.market_cap);
      return row?.marketProvider === 'AVE' && marketCap !== null && marketCap >= minMarketCap && marketCap <= maxMarketCap
        && validAddress(row.address);
    })
      .map(row => normalizedAddress(row.address)))].slice(0, 30);
    if (!addresses.length) return rows;
    const key = normalizedChain + ':' + [...addresses].sort().join(',');
    const at = this.now(), cached = this.cache.get(key);
    if (cached?.until > at) return overlayDexMarket(rows, normalizedChain, cached.marketByToken, cached.capturedAt, this.ttlMs);
    let job = this.pending.get(key);
    if (!job) {
      const url = `https://api.dexscreener.com/tokens/v1/${dexChainId}/${addresses.map(encodeURIComponent).join(',')}`;
      job = (async () => {
        const capturedAt = this.now();
        const payload = await requestJson(this.fetchImpl, url, this);
        const marketByToken = parseDexBatch(payload, { dexChainId, tokenAddresses: addresses, capturedAt });
        const entry = { marketByToken, capturedAt, until: capturedAt + this.ttlMs, staleUntil: capturedAt + this.staleTtlMs };
        if (!this.cache.has(key) && this.cache.size >= 16) this.cache.delete(this.cache.keys().next().value);
        this.cache.set(key, entry);
        return entry;
      })();
      this.pending.set(key, job);
      job.finally(() => { if (this.pending.get(key) === job) this.pending.delete(key); }).catch(() => {});
    }
    try {
      const entry = await job;
      return overlayDexMarket(rows, normalizedChain, entry.marketByToken, entry.capturedAt, this.ttlMs);
    } catch {
      if (cached?.staleUntil > at) return overlayDexMarket(rows, normalizedChain, cached.marketByToken, cached.capturedAt, this.ttlMs)
        .map((row, index) => row === rows[index] ? row : { ...row, stale: true });
      return rows;
    }
  }
}

const EVM_SECURITY_RULES = Object.freeze([
  ['isHoneypot', 'is_honeypot', true, true, 'GoPlus标记为貔貅'],
  ['openSource', 'is_open_source', false, true, '合约未开源'],
  ['mintable', 'is_mintable', true, true, '合约仍可增发'],
  ['ownerChangeBalance', 'owner_change_balance', true, true, '所有者可修改余额'],
  ['hiddenOwner', 'hidden_owner', true, true, '存在隐藏所有者'],
  ['cannotSellAll', 'cannot_sell_all', true, true, '持有人无法全部卖出'],
  ['selfDestruct', 'selfdestruct', true, false, '合约可自毁'],
  ['externalCall', 'external_call', true, false, '合约包含高风险外部调用'],
  ['slippageModifiable', 'slippage_modifiable', true, false, '滑点或税率可修改'],
  ['personalSlippageModifiable', 'personal_slippage_modifiable', true, false, '可按地址修改滑点或税率'],
  ['transferPausable', 'transfer_pausable', true, false, '代币转账可暂停'],
  ['blacklisted', 'is_blacklisted', true, false, '合约包含黑名单机制'],
  ['tradingCooldown', 'trading_cooldown', true, false, '合约包含交易冷却限制']
]);

const TAX_BREACH_REASONS = Object.freeze({ buyTax: '买入税超过风险门槛', sellTax: '卖出税超过风险门槛' });

function findGoPlusRecord(payload, tokenAddress) {
  if (!payload || Array.isArray(payload) || typeof payload !== 'object') return null;
  const result = payload.result;
  if (!result || typeof result !== 'object') return null;
  if (Array.isArray(result)) {
    return result.find(row => sameAddress(row?.contract_address || row?.address, tokenAddress)) || null;
  }
  for (const [key, value] of Object.entries(result)) {
    if (sameAddress(key, tokenAddress) && value && typeof value === 'object') return value;
  }
  return null;
}

function parseGoPlus(payload, { tokenAddress }) {
  if (!payload || Array.isArray(payload) || typeof payload !== 'object') {
    const error = new Error('unexpected GoPlus JSON shape');
    error.code = 'INVALID_JSON_SHAPE';
    throw error;
  }
  if (payload.code !== undefined && ![1, '1'].includes(payload.code)) {
    const error = new Error('GoPlus rejected request');
    error.code = Number(payload.code) === 4029 ? 'RATE_LIMITED' : 'UPSTREAM_REJECTED';
    throw error;
  }
  const record = findGoPlusRecord(payload, tokenAddress);
  if (!record) return {
    found: false,
    security: { complete: false, verdict: 'UNKNOWN', fatal: [], unknownFields: ['tokenSecurity'], fields: {}, buyTax: null, sellTax: null }
  };
  const fields = {};
  const fatal = [];
  const unknownFields = [];
  for (const [field, rawField, fatalWhen, , reason] of EVM_SECURITY_RULES) {
    const value = nestedBoolean(record[rawField]);
    fields[field] = value;
    if (value === null) {
      unknownFields.push(field);
    } else if (value === fatalWhen) {
      fatal.push({ field, reason });
    }
  }
  const buyTax = optionalRate(record.buy_tax);
  const sellTax = optionalRate(record.sell_tax);
  if (buyTax === null) {
    unknownFields.push('buyTax');
  }
  if (sellTax === null) {
    unknownFields.push('sellTax');
  }
  fields.buyTax = buyTax;
  fields.sellTax = sellTax;
  for (const field of taxBreaches(buyTax, sellTax, scannerSettings)) fatal.push({ field, reason: TAX_BREACH_REASONS[field] });
  // An omitted risk flag is not evidence of safety. Keep the source incomplete
  // so callers can recheck instead of treating an unknown field as a clean bill.
  const complete = unknownFields.length === 0;
  return {
    found: true,
    security: {
      complete,
      verdict: fatal.length ? 'FATAL' : complete ? 'NO_FATAL_FLAGS' : 'UNKNOWN',
      fatal,
      unknownFields,
      fields,
      buyTax,
      sellTax
    }
  };
}

function sourceState(status, extra = {}) {
  return { status, ...extra };
}

function unknownSecurity(verdict = 'UNKNOWN') {
  return { complete: false, verdict, fatal: [], unknownFields: ['tokenSecurity'], fields: {}, buyTax: null, sellTax: null };
}

function sourceResult(response) {
  if (response?.error) return { source: sourceState('ERROR', { errorCode: errorCode(response.error) }), security: unknownSecurity() };
  const value = response?.value;
  if (!value || typeof value !== 'object' || Array.isArray(value) || !value.source || typeof value.source.status !== 'string') {
    return { source: sourceState('ERROR', { errorCode: 'NORMALIZATION_MISSING' }), security: unknownSecurity() };
  }
  return { source: value.source, security: value.security && typeof value.security === 'object' ? value.security : unknownSecurity() };
}

// GoPlus answers every other rule on Arc but never cannot_sell_all (6 of 6
// tokens, 2026-10-02). There, AVE's distinct sellers stand in for that one
// field. It is weaker evidence: wallets selling some amount does not rule out
// maximum-sell or partial-balance rules, so the check records the stand-in.
const CANNOT_SELL_ALL_STAND_IN_CHAINS = Object.freeze(['arc']);

// A new security view with the stand-in applied; GoPlus's own fields, including
// its missing cannotSellAll, are kept as it answered.
function withSellerStandIn(security, chain, distinctSellers24h) {
  if (!CANNOT_SELL_ALL_STAND_IN_CHAINS.includes(chain) || !security.unknownFields?.includes('cannotSellAll')
    || !Number.isSafeInteger(distinctSellers24h) || distinctSellers24h < 1) return security;
  const unknownFields = security.unknownFields.filter(field => field !== 'cannotSellAll');
  const complete = unknownFields.length === 0;
  return {
    ...security, complete, unknownFields,
    verdict: security.verdict === 'FATAL' ? 'FATAL' : complete ? 'NO_FATAL_FLAGS' : 'UNKNOWN',
    standIns: { cannotSellAll: { distinctSellers24h } }
  };
}

/**
 * The token's secondary safety check from its recorded GoPlus response. On a
 * chain where GoPlus omits cannot_sell_all, at least one distinct seller in
 * AVE's 24-hour window (`distinctSellers24h`) stands in for it, recorded as
 * `security.standIns.cannotSellAll`; without one the field stays unknown.
 */
export function aggregateSecondarySources({ chain, tokenAddress, sources = {}, distinctSellers24h = null }) {
  const normalizedChain = cleanString(chain, 24).toLowerCase();
  const goPlus = sourceResult(sources.goPlus);
  const security = withSellerStandIn(goPlus.security, normalizedChain, distinctSellers24h);
  const complete = goPlus.source.status === 'OK' && security.complete === true;
  const collectedAt = sources.goPlus?.collectedAt;
  return {
    status: complete ? 'COMPLETE' : 'DEGRADED',
    complete,
    checkedAt: Number.isSafeInteger(collectedAt) && collectedAt >= 0 ? collectedAt : 0,
    chain: normalizedChain,
    tokenAddress: cleanString(tokenAddress, 128),
    sources: { goPlus: goPlus.source },
    security
  };
}

/** Reads a token's GoPlus security record, signed in with the app key when `goPlusAuth` holds one. */
export class SecondaryValidator {
  constructor({ goPlusAuth = null, fetchImpl = globalThis.fetch, timeoutMs = 8_000, maxResponseBytes = DEFAULT_MAX_BYTES, now = () => Date.now() } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
    this.fetchImpl = fetchImpl;
    this.goPlusAuth = goPlusAuth;
    this.timeoutMs = Math.max(1, Number(timeoutMs) || 8_000);
    this.maxResponseBytes = Math.max(1_024, Number(maxResponseBytes) || DEFAULT_MAX_BYTES);
    this.now = now;
  }

  /** The token's GoPlus check as a source record; a failure is recorded, never thrown. */
  async fetchSource({ chain, tokenAddress, signal } = {}) {
    const chainId = GOPLUS_EVM_CHAIN_IDS[cleanString(chain, 24).toLowerCase()];
    const address = cleanString(tokenAddress, 128);
    if (!chainId) return { source: sourceState('UNSUPPORTED'), security: unknownSecurity('UNSUPPORTED') };
    if (!validAddress(address)) return { source: sourceState('ERROR', { errorCode: 'INVALID_ADDRESS' }), security: unknownSecurity() };
    const url = `https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${encodeURIComponent(address)}`;
    try {
      const headers = this.goPlusAuth ? { Authorization: await this.goPlusAuth.accessToken({ signal }) } : {};
      const payload = await requestJson(this.fetchImpl, url, { ...this, signal, headers });
      const parsed = parseGoPlus(payload, { tokenAddress: address });
      return { source: sourceState(parsed.found ? 'OK' : 'NO_DATA'), security: parsed.security };
    } catch (error) {

      // A refused request may mean the token was revoked early; the next check signs in again.
      if (error?.code === 'UPSTREAM_REJECTED') this.goPlusAuth?.forget();
      return { source: sourceState('ERROR', { errorCode: errorCode(error) }), security: unknownSecurity() };
    }
  }
}

export const secondaryChainSupport = Object.freeze({
  dexScreener: Object.freeze({ ...DEX_CHAIN_IDS }),
  goPlus: Object.freeze({ ...GOPLUS_EVM_CHAIN_IDS })
});

/** The token's chart on dexscreener.com, which opens its busiest pool, or '' when DexScreener has no id for the chain. */
export function dexScreenerTokenUrl(chain, address) {
  const chainId = DEX_CHAIN_IDS[chain], token = normalizedAddress(address);
  return chainId && validAddress(token) ? `https://dexscreener.com/${chainId}/${token}` : '';
}
