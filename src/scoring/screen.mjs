import { validTokenAddress } from '../address.mjs';
import { num, optionalCount, optionalNonNegativeNumber, optionalNumber, optionalRate } from './parse.mjs';
import { ADMIT, CLEAR, DROP, ENFORCE, HIT, SHADOW, UNKNOWN, evaluateRules, rulesetVersion } from './rules.mjs';
import { taxBreaches } from './tax.mjs';

/**
 * The discovery screen as a rule table (./rules.mjs), one verdict per rule for
 * each row. Any enforced DROP hit drops the token; otherwise it is admitted when
 * every enforced ADMIT rule is clear, and undecided (not alerted) when one is
 * not. A rule's id names the reason a blocked token shows, so each rule has a
 * single blocking meaning: thresholds are DROP rules, and the data a pass
 * requires are ADMIT rules.
 * A rule declares the settings it reads; thresholds come only from the scanner
 * settings, which are checked complete (completeScannerSettings) where each
 * cycle snapshots them.
 */

const known = (value, hit) => value === null ? UNKNOWN : hit ? HIT : CLEAR;
const required = present => present ? CLEAR : UNKNOWN;
const ageVerdict = (market, hit) => market.ageSec === null ? UNKNOWN : hit(market.ageSec) ? HIT : CLEAR;
// A 5-minute side volume AVE reports must be positive; one it reports but that cannot be read counts as none.
const sideVolume = value => value == null ? UNKNOWN : optionalNonNegativeNumber(value) > 0 ? CLEAR : HIT;

// Issue #1's D1 terms, which in a ticker or name mark impersonation or phishing. They are
// part of NAME_BLOCKLISTED's definition: changing them is a new version of that rule.
const BLOCKED_NAME_TERMS = Object.freeze(['official', 'airdrop', '官方', '空投', 'teneo']);
const nameText = value => typeof value === 'string' && value.trim() ? value.normalize('NFKC').toLowerCase() : null;

// A blocked term in the symbol or the name hits; it is clear only when both were read.
function nameBlocklisted({ row }) {
  const texts = [nameText(row.symbol), nameText(row.name)];
  if (texts.some(text => text !== null && BLOCKED_NAME_TERMS.some(term => text.includes(term)))) return HIT;
  return texts.includes(null) ? UNKNOWN : CLEAR;
}

export const SCREEN_RULES = Object.freeze([
  { id: 'IDENTITY_MISMATCH', version: 1, role: DROP, mode: ENFORCE, settings: [],
    evaluate: market => market.identityMatches ? CLEAR : HIT },
  { id: 'QUOTE_FRESH', version: 1, role: ADMIT, mode: ENFORCE, settings: ['maxQuoteAgeMs'],
    evaluate: (market, settings) => quoteFreshness(market, settings) },
  { id: 'MARKET_CAP_FRESH', version: 1, role: ADMIT, mode: ENFORCE, settings: ['maxQuoteAgeMs'],
    evaluate: (market, settings) => marketCapFreshness(market, settings) },
  { id: 'PRICE_KNOWN', version: 1, role: ADMIT, mode: ENFORCE, settings: [],
    evaluate: market => required(market.price > 0) },
  { id: 'AGE_KNOWN', version: 1, role: ADMIT, mode: ENFORCE, settings: [],
    evaluate: market => required(market.ageSec !== null) },
  { id: 'AGE_TOO_YOUNG', version: 1, role: DROP, mode: ENFORCE, settings: ['minAgeSec'],
    evaluate: (market, settings) => ageVerdict(market, ageSec => ageSec < settings.minAgeSec) },
  { id: 'AGE_TOO_OLD', version: 1, role: DROP, mode: ENFORCE, settings: ['maxAgeSec'],
    evaluate: (market, settings) => ageVerdict(market, ageSec => ageSec > settings.maxAgeSec) },
  { id: 'MARKET_CAP_KNOWN', version: 1, role: ADMIT, mode: ENFORCE, settings: [],
    evaluate: market => required(market.marketCap !== null) },
  { id: 'MARKET_CAP_OUT_OF_RANGE', version: 1, role: DROP, mode: ENFORCE, settings: ['discoveryMinMarketCap', 'discoveryMaxMarketCap'],
    evaluate: (market, settings) => known(market.marketCap,
      !(market.marketCap >= settings.discoveryMinMarketCap && market.marketCap <= settings.discoveryMaxMarketCap)) },
  { id: 'LIQUIDITY_KNOWN', version: 1, role: ADMIT, mode: ENFORCE, settings: [],
    evaluate: market => required(market.liquidity !== null) },
  { id: 'LIQUIDITY_TOO_LOW', version: 1, role: DROP, mode: ENFORCE, settings: ['minLiquidity'],
    evaluate: (market, settings) => known(market.liquidity, market.liquidity < settings.minLiquidity) },
  { id: 'TAX_TOO_HIGH', version: 1, role: DROP, mode: ENFORCE, settings: ['maxBuyTax', 'maxSellTax'],
    evaluate: (market, settings) => taxBreaches(market.buyTax, market.sellTax, settings).length ? HIT
      : market.buyTax === null || market.sellTax === null ? UNKNOWN : CLEAR },
  { id: 'VOLUME_5M_POSITIVE', version: 1, role: ADMIT, mode: ENFORCE, settings: [],
    evaluate: market => known(market.volume5m, market.volume5m === 0) },
  { id: 'LOW_ACTIVITY', version: 1, role: DROP, mode: ENFORCE,
    settings: ['matureMarketAgeSec', 'oldMarketAgeSec', 'minMatureVolume5mUsd', 'minOldVolume5mUsd', 'minMatureTurnover5m', 'minOldTurnover5m'],
    evaluate: (market, settings) => activity(market, settings) },
  { id: 'NO_BUY_VOLUME_5M', version: 1, role: DROP, mode: ENFORCE, settings: [],
    evaluate: market => sideVolume(market.row.buy_volume_5m) },
  { id: 'NO_SELL_VOLUME_5M', version: 1, role: DROP, mode: ENFORCE, settings: [],
    evaluate: market => sideVolume(market.row.sell_volume_5m) },
  { id: 'NO_BUYS_5M', version: 1, role: DROP, mode: ENFORCE, settings: [],
    evaluate: market => known(market.buys5m, market.buys5m === 0) },
  { id: 'NO_SELLS_5M', version: 1, role: DROP, mode: ENFORCE, settings: [],
    evaluate: market => known(market.sells5m, market.sells5m === 0) },
  { id: 'NAME_BLOCKLISTED', version: 1, role: DROP, mode: SHADOW, settings: [],
    evaluate: nameBlocklisted }
].map(rule => Object.freeze({ ...rule, settings: Object.freeze(rule.settings) })));

// A cycle screens every row with one settings object, so its ruleset is hashed once per cycle.
const rulesets = new WeakMap();
function screenRuleset(settings) {
  if (!rulesets.has(settings)) rulesets.set(settings, rulesetVersion(SCREEN_RULES, settings));
  return rulesets.get(settings);
}

// AVE rows carry their source clock; DexScreener keeps none, so our read time stands in and its row is fresh for maxQuoteAgeMs after the read.
function quoteFreshness({ row, now }, { maxQuoteAgeMs }) {
  const capturedAt = optionalNumber(row.capturedAt), sourceUpdatedAt = optionalNumber(row.sourceUpdatedAt);
  if (capturedAt === null || sourceUpdatedAt === null || capturedAt <= 0 || sourceUpdatedAt <= 0 || capturedAt > now || sourceUpdatedAt > capturedAt) return UNKNOWN;
  return row.stale === true || now - capturedAt > maxQuoteAgeMs || now - sourceUpdatedAt > maxQuoteAgeMs
    || row.expiresAt != null && (optionalNumber(row.expiresAt) === null || row.expiresAt <= now) ? HIT : CLEAR;
}

// An AVE market cap may come from the token rather than the pool, with its own clock; a fresh pool never refreshes an old token market cap.
// A row without that clock (DexScreener) quotes market cap with the rest of the row, under QUOTE_FRESH.
function marketCapFreshness({ row, now }, { maxQuoteAgeMs }) {
  if (!Object.hasOwn(row, 'marketCapSourceUpdatedAt')) return CLEAR;
  const sourceUpdatedAt = optionalNumber(row.marketCapSourceUpdatedAt);
  if (sourceUpdatedAt === null || !(sourceUpdatedAt > 0)) return UNKNOWN;
  return row.marketCapSourceUpdatedAt > row.marketCapCapturedAt || row.marketCapCapturedAt > now
    || now - row.marketCapSourceUpdatedAt > maxQuoteAgeMs || !(row.marketCapExpiresAt > now) ? HIT : CLEAR;
}

// A mature market must still trade: 5-minute volume at least the larger of a dollar floor and a share of liquidity.
function activity({ ageSec, volume5m, liquidity }, settings) {
  if (ageSec === null || volume5m === null || liquidity === null) return UNKNOWN;
  if (ageSec < settings.matureMarketAgeSec) return CLEAR;
  const old = ageSec >= settings.oldMarketAgeSec;
  const floor = Math.max(old ? settings.minOldVolume5mUsd : settings.minMatureVolume5mUsd,
    liquidity * (old ? settings.minOldTurnover5m : settings.minMatureTurnover5m));
  return volume5m < floor ? HIT : CLEAR;
}

// The row as the rules read it. A DexScreener row has no launch time; its token's first pool dates it.
function marketView(row, chain, nowSec) {
  const fallbackBasis = row.marketProvider === 'DEXSCREENER' ? 'pool' : 'token';
  const launchAt = optionalNumber(row.launch_at);
  const tokenAt = row.ageBasis === 'launch' || row.ageBasis === fallbackBasis ? optionalNumber(row.creation_timestamp) : null;
  const createdAt = launchAt !== null && launchAt > 0 ? launchAt : tokenAt;
  return {
    row, now: nowSec * 1000, createdAt,
    ageBasis: launchAt !== null && launchAt > 0 ? 'launch' : tokenAt !== null && tokenAt > 0 ? fallbackBasis : 'unknown',
    ageSec: createdAt !== null && createdAt > 0 && Number.isInteger(createdAt) ? nowSec - createdAt : null,
    identityMatches: row.chain === chain && validTokenAddress(row.address),
    price: optionalNumber(row.price), marketCap: optionalNonNegativeNumber(row.market_cap),
    liquidity: optionalNonNegativeNumber(row.liquidity), volume5m: optionalNonNegativeNumber(row.volume_5m),
    buys5m: optionalCount(row.buys_5m), sells5m: optionalCount(row.sells_5m),
    buyTax: optionalRate(row.buy_tax), sellTax: optionalRate(row.sell_tax)
  };
}

/**
 * Screen one discovery row: an AVE hot-list row, or a promoted new pool's
 * DexScreener row, on token-level market facts: a pool's type, hook or history
 * never decides it. Only an admitted token passes; an undecided one is not
 * alerted either. The score orders the audit queue and is not a rule.
 */
export function discoveryScreen(row, settings, nowSec = Date.now() / 1000, rules = SCREEN_RULES) {
  if (row?.marketProvider !== 'AVE' && row?.marketProvider !== 'DEXSCREENER') {
    throw new TypeError(`discovery row from an unsupported market provider: ${String(row?.marketProvider)}`);
  }
  const market = marketView(row, settings.chain, nowSec);
  const { decision, verdicts, reasons } = evaluateRules(market, settings, rules);
  const mc = market.marketCap ?? 0, liquidity = market.liquidity ?? 0;
  const priorityBand = mc >= settings.priorityMinMarketCap && mc <= settings.priorityMaxMarketCap;
  const score = (priorityBand ? 35 : 10) + Math.min(25, liquidity / 1000) + Math.min(20, (market.volume5m || 0) / 1000) + Math.min(20, num(row.holder_count) / 10);
  return { pass: decision === ADMIT, decision, reasons, ruleset: rules === SCREEN_RULES ? screenRuleset(settings) : rulesetVersion(rules, settings), verdicts, priorityBand, score, mc, liquidity,
    ageSec: market.createdAt !== null && market.createdAt > 0 ? nowSec - market.createdAt : 0, ageBasis: market.ageBasis,
    marketProvider: row.marketProvider, createdAt: market.createdAt };
}
