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
 * Tokens worth screening: listed on DexScreener with market cap, volume, liquidity, buys and age (from the
 * token's first pool) inside the thresholds, not excluded (on this cycle's hot list, or vetoed), and not
 * passed within REPROMOTE_MS. At most two: those never screened first, so a token that keeps failing
 * cannot hold a slot a new one needs, then busiest first.
 */
export function promotions(state, markets, { now, settings, excluded }) {
  const pools = new Map(state.pools.map(pool => [pool.token, pool]));
  const screened = market => pools.get(market.address)?.promotedAt !== undefined;
  return markets.filter(market => {
    const pool = pools.get(market.address);
    return !excluded.has(market.address) && !(pool?.passed === true && pool.promotedAt > now - REPROMOTE_MS)
      && market.marketCap >= settings.discoveryMinMarketCap && market.marketCap <= settings.discoveryMaxMarketCap
      && market.volume5m >= settings.onchainMinVolume5m && market.liquidity >= settings.minLiquidity && (market.buys5m ?? 0) >= settings.onchainMinBuys5m
      // The screen rejects a token younger than minAgeSec, so promoting one earlier would only spend a slot.
      && now - market.firstPairCreatedAt >= settings.minAgeSec * 1000;
  }).sort((a, b) => screened(a) - screened(b) || b.volume5m - a.volume5m).slice(0, MAX_PROMOTIONS_PER_CYCLE).map(market => market.address);
}

/**
 * The watchlist after one cycle: new pools added, checked ones updated, promoted ones stamped with
 * whether they `passed` the screen, and expired ones dropped: older than WATCH_MS, or at their last read
 * unlisted for UNLISTED_MS or untraded for IDLE_MS.
 */
export function nextWatchState(state, { newPools = null, checked = [], markets = [], promoted = [], passed = [], now }) {
  const found = new Map(markets.map(market => [market.address, market]));
  const pools = mergePools(state.pools, newPools?.pools ?? [], now).map(pool => {
    if (!checked.includes(pool.token)) return pool;
    const market = found.get(pool.token);
    return { ...pool, checkedAt: now, ...(market ? { listedAt: now } : {}), ...(market && traded(market) ? { tradedAt: now } : {}),
      ...(promoted.includes(pool.token) ? { promotedAt: now, passed: passed.includes(pool.token) } : {}) };
  }).filter(pool => {
    // Unlisted and idle are judged at the pool's last read: a pool left unread has given no evidence of either.
    const readAt = pool.checkedAt ?? pool.firstSeenAt;
    return now - pool.firstSeenAt <= WATCH_MS && readAt - (pool.listedAt ?? pool.firstSeenAt) <= UNLISTED_MS
      && readAt - (pool.tradedAt ?? pool.firstSeenAt) <= IDLE_MS;
  })
    .sort((a, b) => b.firstSeenAt - a.firstSeenAt).slice(0, MAX_WATCHED);
  return { cursor: newPools ? newPools.toBlock : state.cursor, pools };
}
