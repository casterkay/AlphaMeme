import { POOL_SOURCES } from '../providers/chain-logs.mjs';
import { optionalNonNegativeNumber } from './parse.mjs';
import { ADMIT, DROP, SHADOW, UNKNOWN, evaluateRules, known, rulesetVersion } from './rules.mjs';

/**
 * The post-alert audit: the old deep audit's checks as a rule table
 * (./rules.mjs), run after each GoPlus check over the holder distribution that
 * check read and the discovery row's market facts. Every rule runs in shadow:
 * its verdict is recorded with the lead and its outcome, and the safety verdict
 * ignores it. A check with no data source yet (source null) is always UNKNOWN,
 * and the record lists it as not run, apart from a check that ran without data.
 */
const BURN_ADDRESSES = new Set(['0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dead']);

// Uniswap v4 keeps every pool's tokens in one PoolManager, which GoPlus leaves untagged and unlocked and
// lists only by pool id. A chain whose PoolManager discovery pins can set it aside; elsewhere a v4 token's
// top holders cannot be told from its pools.
const v4PoolManagers = chain => (POOL_SOURCES[chain]?.factories || []).filter(factory => factory.event === 'v4').map(factory => factory.address);

const shareOf = holders => Math.min(1, holders.reduce((sum, holder) => sum + holder.rate, 0));
const lockedOrBurned = holder => holder.locked || BURN_ADDRESSES.has(holder.address);

// The LP share locked or burned. A V3 or V4 position is an NFT, and GoPlus's list does not say which
// of the token's pools it belongs to, so any position leaves the share unknown.
function lpLockedRate({ lpHolders, lpTotalSupply }) {
  if (!lpHolders?.length || !(lpTotalSupply > 0) || lpHolders.some(holder => holder.nftPositions)) return null;
  return shareOf(lpHolders.filter(lockedOrBurned));
}

// The top holders' share, setting aside locked and burned supply and the token's own pools.
// GoPlus lists the top 10, so what remains after setting those aside is fewer than ten holders.
function top10Rate({ holders, pairAddresses, venues }, chain) {
  const managers = v4PoolManagers(chain);
  if (!holders?.length || venues.includes('UniV4') && !managers.length) return null;
  const pools = new Set([...pairAddresses, ...managers]);
  return shareOf(holders.filter(holder => !lockedOrBurned(holder) && !pools.has(holder.address)));
}

// The V3 or V4 LP positions' holders, whose lock a later rule version can count once it knows which pool each covers.
const lpPositions = ({ lpHolders }) => (lpHolders || []).filter(holder => holder.nftPositions).slice(0, 10)
  .map(({ address, rate, locked }) => ({ address, rate, locked: lockedOrBurned({ address, locked }) }));

/** The facts the audit rules read, each null when it could not be read. They are recorded as the audit's evidence. */
export function auditFacts({ chain, holdings, liquidity }) {
  return {
    ownerRenounced: holdings?.ownerAddress ? BURN_ADDRESSES.has(holdings.ownerAddress) : null,
    lpLockedRate: holdings ? lpLockedRate(holdings) : null,
    lpPositions: holdings ? lpPositions(holdings) : [],
    top10Rate: holdings ? top10Rate(holdings, chain) : null,
    creatorRate: holdings?.creatorRate ?? null,
    creatorHoneypots: holdings?.creatorHoneypots ?? null,
    liquidity: optionalNonNegativeNumber(liquidity)
  };
}

const notRun = (id, role = DROP) => ({ id, version: 1, role, mode: SHADOW, source: null, settings: [], evaluate: () => UNKNOWN });

export const AUDIT_RULES = Object.freeze([
  { id: 'OWNER_NOT_RENOUNCED', version: 1, role: DROP, mode: SHADOW, source: 'GOPLUS', settings: [],
    evaluate: facts => known(facts.ownerRenounced, facts.ownerRenounced === false) },
  { id: 'LP_NOT_LOCKED', version: 1, role: DROP, mode: SHADOW, source: 'GOPLUS', settings: ['minLpLockedRate'],
    evaluate: (facts, settings) => known(facts.lpLockedRate, facts.lpLockedRate < settings.minLpLockedRate) },
  { id: 'TOP10_CONCENTRATED', version: 1, role: DROP, mode: SHADOW, source: 'GOPLUS', settings: ['maxTop10Rate'],
    evaluate: (facts, settings) => known(facts.top10Rate, facts.top10Rate > settings.maxTop10Rate) },
  { id: 'DEV_HOLD_TOO_HIGH', version: 1, role: DROP, mode: SHADOW, source: 'GOPLUS', settings: ['maxDevHoldRate'],
    evaluate: (facts, settings) => known(facts.creatorRate, facts.creatorRate > settings.maxDevHoldRate) },
  { id: 'LIQUIDITY_BELOW_STRICT', version: 1, role: DROP, mode: SHADOW, source: 'ROW', settings: ['strictLiquidity'],
    evaluate: (facts, settings) => known(facts.liquidity, facts.liquidity < settings.strictLiquidity) },
  // #107's first signal: GoPlus knows the creator made a honeypot before.
  { id: 'CREATOR_HONEYPOT_HISTORY', version: 1, role: DROP, mode: SHADOW, source: 'GOPLUS', settings: [],
    evaluate: facts => known(facts.creatorHoneypots, facts.creatorHoneypots === true) },
  // Arc's full-balance sale over its RPC, and the GMGN, candle and history checks, once their sources exist.
  notRun('SELL_ALL_SIMULATION'), notRun('OBSERVATION_5M'), notRun('CHART_RISK'), notRun('RUG_RATIO'),
  notRun('INSIDER_RATE'), notRun('BUNDLER_RATE'), notRun('SNIPER_RATE'), notRun('WASH_TRADING'),
  notRun('WALLET_ANALYSIS'), notRun('MARKET_BEHAVIOR'), notRun('CREATOR_LAUNCHES_24H'), notRun('SELF_TRADING'),
  notRun('HOLDERS_GROWING', ADMIT)
].map(rule => Object.freeze({ ...rule, settings: Object.freeze(rule.settings) })));

const NOT_RUN = Object.freeze(AUDIT_RULES.filter(rule => rule.source === null).map(rule => rule.id));

/**
 * The audit of one GoPlus check: the ruleset, every rule's verdict, the checks
 * that did not run, and the facts the rules read. `holdings` is the check's
 * holder distribution (goPlusHoldings), null when GoPlus did not answer;
 * `liquidity` is the discovery row's.
 */
export function postAlertAudit({ chain, holdings, liquidity, at }, settings) {
  const evidence = auditFacts({ chain, holdings, liquidity });
  return { ruleset: rulesetVersion(AUDIT_RULES, settings), at, verdicts: evaluateRules(evidence, settings, AUDIT_RULES).verdicts, notRun: NOT_RUN, evidence };
}
