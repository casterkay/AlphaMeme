// The new-pool watchlist: tokens whose pools the chain logs just created, watched on
// DexScreener until they trade enough to be screened from that market, or go quiet.
// Pure functions over plain JSON, so the state can live in a checkpoint and replay.

const MAX_WATCHED = 500;
export const WATCH_BATCH = 30;
export const MAX_PROMOTIONS_PER_CYCLE = 2;
const WATCH_MS = 6 * 60 * 60_000;
// DexScreener indexes a new pool within minutes; one it never lists, or stops listing, is dropped.
const UNLISTED_MS = 10 * 60_000;
// Most new pools never trade; one with no trade for this long is dropped.
const IDLE_MS = 15 * 60_000;
// A token that passed the screen is screened again after this long, which keeps an off-list lead current.
// One that failed is screened again the next cycle: an early failure (no sells yet, a stale read) is often temporary.
const REPROMOTE_MS = 5 * 60_000;

export const emptyWatchState = () => ({ cursor: null, pools: [] });

/**
 * The tokens to check on DexScreener this cycle, in batches of WATCH_BATCH: every young pool (first seen
 * within youngPoolAgeMs), in as many batches as they need up to maxWatchRequestsPerCycle, with older pools
 * filling the slots left. Within each group, those checked longest ago first, newest pools first among equals.
 */
export function watchTargets(state, newPools, now, { youngPoolAgeMs, maxWatchRequestsPerCycle }) {
  const pools = mergePools(state.pools, newPools, now), young = pool => now - pool.firstSeenAt < youngPoolAgeMs;
  const requests = Math.min(maxWatchRequestsPerCycle, Math.max(1, Math.ceil(pools.filter(young).length / WATCH_BATCH)));
  return pools.sort((a, b) => young(b) - young(a) || (a.checkedAt ?? 0) - (b.checkedAt ?? 0) || b.firstSeenAt - a.firstSeenAt)
    .slice(0, requests * WATCH_BATCH).map(pool => pool.token);
}

function mergePools(pools, newPools, now) {
  const byToken = new Map(pools.map(pool => [pool.token, pool]));
  for (const pool of newPools) if (!byToken.has(pool.token)) byToken.set(pool.token, { token: pool.token, pool: pool.pool, venue: pool.venue, firstSeenAt: now });
  return [...byToken.values()];
}

const traded = market => (market.buys5m ?? 0) + (market.sells5m ?? 0) > 0 || market.volume5m > 0;

/**
 * Tokens worth screening this cycle. `promotable`: listed on DexScreener with market cap, volume, liquidity,
 * buys and age (from the token's first pool) inside the thresholds, and not excluded (on this cycle's hot
 * list, or vetoed). `promoted`: at most two of those not passed within REPROMOTE_MS, those never screened
 * first, so a token that keeps failing cannot hold a slot a new one needs, then busiest first.
 */
export function promotions(state, markets, { now, settings, excluded }) {
  const pools = new Map(state.pools.map(pool => [pool.token, pool]));
  const screened = market => pools.get(market.address)?.promotedAt !== undefined;
  const promotable = markets.filter(market => !excluded.has(market.address)
    && market.marketCap >= settings.discoveryMinMarketCap && market.marketCap <= settings.discoveryMaxMarketCap
    && market.volume5m >= settings.onchainMinVolume5m && market.liquidity >= settings.minLiquidity && (market.buys5m ?? 0) >= settings.onchainMinBuys5m
    // The screen rejects a token younger than minAgeSec, so promoting one earlier would only spend a slot.
    && now - market.firstPairCreatedAt >= settings.minAgeSec * 1000);
  const promoted = promotable.filter(market => {
    const pool = pools.get(market.address);
    return !(pool?.passed === true && pool.promotedAt > now - REPROMOTE_MS);
  }).sort((a, b) => screened(a) - screened(b) || b.volume5m - a.volume5m).slice(0, MAX_PROMOTIONS_PER_CYCLE);
  return { promotable: promotable.map(market => market.address), promoted: promoted.map(market => market.address) };
}

/**
 * The watchlist after one cycle: new pools added, checked ones updated, and expired ones dropped: older than
 * WATCH_MS, or at their last read unlisted for UNLISTED_MS or untraded for IDLE_MS. A token `screened` this
 * cycle (its screen's reasons, none when it passed) is stamped as promoted, with whether it passed. Its first
 * listing, first promotable cycle and first screen with its reasons are stamped once, when no earlier listing
 * or screen is on record, so a pool listed or screened before these stamps existed leaves them unknown.
 */
export function nextWatchState(state, { newPools = null, checked = [], markets = [], promotable = [], screened = new Map(), now }) {
  const found = new Map(markets.map(market => [market.address, market]));
  const pools = mergePools(state.pools, newPools?.pools ?? [], now).map(pool => {
    if (!checked.includes(pool.token)) return pool;
    const market = found.get(pool.token), reasons = screened.get(pool.token), first = pool.promotedAt === undefined;
    return { ...pool, checkedAt: now, ...(market ? { listedAt: now } : {}), ...(market && pool.listedAt === undefined ? { firstListedAt: now } : {}),
      ...(market && traded(market) ? { tradedAt: now } : {}),
      ...(first && pool.firstPromotableAt === undefined && promotable.includes(pool.token) ? { firstPromotableAt: now } : {}),
      ...(reasons ? { promotedAt: now, passed: reasons.length === 0, ...(first ? { firstScreenedAt: now, firstScreenReasons: reasons } : {}) } : {}) };
  }).filter(pool => {
    // Unlisted and idle are judged at the pool's last read: a pool left unread has given no evidence of either.
    const readAt = pool.checkedAt ?? pool.firstSeenAt;
    return now - pool.firstSeenAt <= WATCH_MS && readAt - (pool.listedAt ?? pool.firstSeenAt) <= UNLISTED_MS
      && readAt - (pool.tradedAt ?? pool.firstSeenAt) <= IDLE_MS;
  })
    .sort((a, b) => b.firstSeenAt - a.firstSeenAt).slice(0, MAX_WATCHED);
  return { cursor: newPools ? newPools.toBlock : state.cursor, pools };
}
