import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_PROMOTIONS_PER_CYCLE, WATCH_BATCH, emptyWatchState, nextWatchState, promotions, watchTargets } from '../src/onchain-watch.mjs';
import { scannerSettings } from '../src/scanner-settings.mjs';

const NOW = 1_800_000_000_000, MINUTE = 60_000;
const token = index => `0x${index.toString(16).padStart(40, '0')}`;
const pool = (index, changes = {}) => ({ token: token(index), pool: `0x${'9'.repeat(64)}`, venue: 'Uniswap v4', firstSeenAt: NOW - index * MINUTE, ...changes });
const market = (index, changes = {}) => ({ address: token(index), marketCap: 50_000, liquidity: 20_000, volume5m: 2_000, buys5m: 20, sells5m: 5, pairCreatedAt: NOW - 30 * MINUTE, firstPairCreatedAt: NOW - 30 * MINUTE, ...changes });
const promote = (state, markets, excluded = []) => promotions(state, markets, { now: NOW, settings: scannerSettings, excluded: new Set(excluded) });

test('the watch checks the tokens checked longest ago first, newest pools first among equals', () => {
  const state = { cursor: 1, pools: [pool(1, { checkedAt: NOW - MINUTE }), pool(2), pool(3, { checkedAt: NOW - 2 * MINUTE })] };
  assert.deepEqual(watchTargets(state, [{ token: token(9), pool: 'p', venue: 'v' }], NOW, scannerSettings), [token(9), token(2), token(3), token(1)]);
});

test('every young pool is read each cycle, in as many batches as it takes up to the cap, with older pools in the slots left', () => {
  const { youngPoolAgeMs, maxWatchRequestsPerCycle } = scannerSettings;
  const watched = (young, old) => ({ cursor: 1, pools: [
    ...Array.from({ length: young }, (_, index) => pool(index + 1, { firstSeenAt: NOW - youngPoolAgeMs + 1, checkedAt: NOW - 15_000 })),
    ...Array.from({ length: old }, (_, index) => pool(1_000 + index, { firstSeenAt: NOW - youngPoolAgeMs, checkedAt: NOW - 60 * MINUTE }))] });
  const targets = (young, old) => watchTargets(watched(young, old), [], NOW, scannerSettings);
  const youngTokens = count => Array.from({ length: count }, (_, index) => token(index + 1));

  assert.equal(targets(0, 40).length, WATCH_BATCH, 'older pools alone take one batch');
  assert.deepEqual(targets(WATCH_BATCH + 15, 40).slice(0, WATCH_BATCH + 15).sort(), youngTokens(WATCH_BATCH + 15).sort(), 'young pools first, though checked more recently');
  assert.equal(targets(WATCH_BATCH + 15, 40).length, 2 * WATCH_BATCH, 'older pools fill the second batch');
  assert.equal(targets(2 * WATCH_BATCH, 40).length, 2 * WATCH_BATCH, 'no batch only for older pools');
  const crowded = targets(maxWatchRequestsPerCycle * WATCH_BATCH + 1, 40);
  assert.equal(crowded.length, maxWatchRequestsPerCycle * WATCH_BATCH, 'capped');
  assert.ok(crowded.every(address => youngTokens(maxWatchRequestsPerCycle * WATCH_BATCH + 1).includes(address)));
});

test('a watched token is promoted only inside every threshold, when not excluded, and not passed recently', () => {
  const state = { cursor: 1, pools: [pool(1)] };
  assert.deepEqual(promote(state, [market(1)]), [token(1)]);
  for (const [scenario, changes] of [
    ['market cap too small', { marketCap: scannerSettings.discoveryMinMarketCap - 1 }],
    ['market cap too large', { marketCap: scannerSettings.discoveryMaxMarketCap + 1 }],
    ['market cap unknown', { marketCap: null }],
    ['volume too low', { volume5m: scannerSettings.onchainMinVolume5m - 1 }],
    ['liquidity too thin', { liquidity: scannerSettings.minLiquidity - 1 }],
    ['too few buys', { buys5m: scannerSettings.onchainMinBuys5m - 1 }],
    ['first pool too young for the screen', { pairCreatedAt: NOW - scannerSettings.minAgeSec * 1000 + 1, firstPairCreatedAt: NOW - scannerSettings.minAgeSec * 1000 + 1 }]
  ]) assert.deepEqual(promote(state, [market(1, changes)]), [], scenario);
  assert.deepEqual(promote(state, [market(1, { pairCreatedAt: NOW - MINUTE })]), [token(1)], 'a young deepest pool of a token whose first pool is old enough');
  assert.deepEqual(promote(state, [market(1)], [token(1)]), [], 'excluded: on the hot list, or vetoed');
  assert.deepEqual(promote({ cursor: 1, pools: [pool(1, { promotedAt: NOW - 4 * MINUTE, passed: true })] }, [market(1)]), [], 'passed four minutes ago');
  assert.deepEqual(promote({ cursor: 1, pools: [pool(1, { promotedAt: NOW - 6 * MINUTE, passed: true })] }, [market(1)]), [token(1)], 'passed six minutes ago');
  assert.deepEqual(promote({ cursor: 1, pools: [pool(1, { promotedAt: NOW - 15_000, passed: false })] }, [market(1)]), [token(1)], 'failed the cycle before');
  const busiest = promote(state, [market(1, { volume5m: 500 }), market(2, { volume5m: 9_000 }), market(3, { volume5m: 3_000 })]);
  assert.deepEqual(busiest, [token(2), token(3)].slice(0, MAX_PROMOTIONS_PER_CYCLE));
});

test('tokens never screened take the promotion slots ahead of busier ones that failed', () => {
  const failed = { promotedAt: NOW - 15_000, passed: false };
  const state = { cursor: 1, pools: [pool(1, failed), pool(2, failed), pool(3), pool(4)] };
  const markets = [market(1, { volume5m: 9_000 }), market(2, { volume5m: 8_000 }), market(3, { volume5m: 500 }), market(4, { volume5m: 400 })];
  assert.deepEqual(promote(state, markets), [token(3), token(4)]);
  assert.deepEqual(promote(state, markets.slice(0, 3)), [token(3), token(1)], 'then the busiest failed one');
});

test('the watchlist adds new pools, records what a check found, and drops unlisted, idle and old pools', () => {
  const state = { cursor: 100, pools: [
    pool(1, { firstSeenAt: NOW - 20 * MINUTE, checkedAt: NOW - 15_000, listedAt: NOW - 11 * MINUTE, tradedAt: NOW - MINUTE }),
    pool(2, { firstSeenAt: NOW - 11 * MINUTE, checkedAt: NOW - 15_000 }),
    pool(3, { firstSeenAt: NOW - 20 * MINUTE, checkedAt: NOW - 15_000, listedAt: NOW - MINUTE, tradedAt: NOW - 16 * MINUTE }),
    pool(4, { firstSeenAt: NOW - 6 * 60 * MINUTE - 1, listedAt: NOW, tradedAt: NOW }),
    pool(5, { firstSeenAt: NOW - 20 * MINUTE, listedAt: NOW - 20 * MINUTE, tradedAt: NOW - 20 * MINUTE }),
    pool(6, { firstSeenAt: NOW - 5 * MINUTE })
  ] };
  const next = nextWatchState(state, { newPools: { toBlock: 200, pools: [{ token: token(7), pool: 'p', venue: 'Uniswap v3' }, { token: token(6), pool: 'q', venue: 'x' }] },
    checked: [token(5), token(6)], markets: [market(5), market(6, { volume5m: 0, buys5m: 0, sells5m: 0 })], promoted: [token(5)], passed: [], now: NOW });
  assert.equal(next.cursor, 200);
  assert.deepEqual(next.pools.map(item => item.token), [token(7), token(6), token(5)], 'unlisted (1, 2), idle (3) and old (4) pools leave; new and checked ones stay');
  assert.deepEqual(next.pools[0], { token: token(7), pool: 'p', venue: 'Uniswap v3', firstSeenAt: NOW });
  assert.deepEqual(next.pools[1], { ...pool(6, { firstSeenAt: NOW - 5 * MINUTE }), checkedAt: NOW, listedAt: NOW }, 'listed but not traded; its first pool is kept');
  assert.deepEqual(next.pools[2], { ...state.pools[4], checkedAt: NOW, listedAt: NOW, tradedAt: NOW, promotedAt: NOW, passed: false });
});

test('a pool left unread while young pools fill every batch is not dropped as unlisted or idle', () => {
  const { youngPoolAgeMs, maxWatchRequestsPerCycle, scanIntervalMs } = scannerSettings;
  const young = Array.from({ length: maxWatchRequestsPerCycle * WATCH_BATCH }, (_, index) => pool(index + 1, { firstSeenAt: NOW }));
  const older = pool(1_000, { firstSeenAt: NOW - youngPoolAgeMs, checkedAt: NOW, listedAt: NOW, tradedAt: NOW });
  let state = { cursor: 1, pools: [...young, older] };
  for (let now = NOW + scanIntervalMs; now <= NOW + 16 * MINUTE; now += scanIntervalMs) {
    const checked = watchTargets(state, [], now, scannerSettings);
    assert.ok(!checked.includes(older.token), 'young pools take every slot');
    state = nextWatchState(state, { checked, markets: checked.map(address => market(Number.parseInt(address, 16))), now });
  }
  assert.deepEqual(state.pools.find(item => item.token === older.token), older, 'kept, unread, until it is read again');
});

test('a failed log read keeps the cursor, and the watchlist is capped at its newest 500 pools', () => {
  assert.equal(nextWatchState({ cursor: 100, pools: [] }, { newPools: null, now: NOW }).cursor, 100);
  const crowded = nextWatchState(emptyWatchState(), { newPools: { toBlock: 1, pools: Array.from({ length: 501 }, (_, index) => ({ token: token(index + 1), pool: 'p', venue: 'v' })) }, now: NOW });
  assert.equal(crowded.pools.length, 500);
});
