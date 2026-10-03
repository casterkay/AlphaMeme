import test from 'node:test';
import assert from 'node:assert/strict';
import { scannerSettings as config } from '../src/scanner-settings.mjs';
import {
  discoveryScreen, analyzeWallets, observeFiveMinutes, deepScreen, empiricalSellability, marketBehaviorScreen, createdAt
} from '../src/scoring/index.mjs';

const nowSec = 1_800_000_000;
const address = '0x1111111111111111111111111111111111111111';
const validHolders = () => Array.from({ length: 10 }, (_, i) => ({
  address: `0x${String(i + 1).padStart(40, '0')}`, addr_type: 0, buy_tx_count_cur: 1,
  is_new: false, is_suspicious: false, amount_percentage: .01,
  native_transfer: { from_address: `source-${i}` }, tags: [], maker_token_tags: []
}));
const recentTraders = () => Array.from({ length: 5 }, (_, i) => ({
  address: `seller-${i}`, sell_tx_count_cur: 1, last_active_timestamp: nowSec - 60
}));

test('discovery fails loudly on a row from any provider but AVE or DexScreener', () => {
  const row = { address, chain: 'arc', market_cap: 50_000, liquidity: 10_000, creation_timestamp: nowSec - 600 };
  for (const marketProvider of [undefined, 'GMGN']) {
    assert.throws(() => discoveryScreen({ ...row, marketProvider }, { ...config, chain: 'arc' }, nowSec), TypeError);
  }
});

test('wallet proxy rejects bot-heavy and linked-funding holder sets', () => {
  const ordinary = Array.from({ length: 10 }, (_, i) => ({ address: `0x${String(i + 1).padStart(40, '0')}`, addr_type: 0, buy_tx_count_cur: 1, is_new: false, is_suspicious: false, amount_percentage: .01, native_transfer: { from_address: `source-${i}` }, tags: [], maker_token_tags: [] }));
  assert.equal(analyzeWallets(ordinary, config).pass, true);
  const botHeavy = ordinary.map((row, i) => i < 3 ? { ...row, amount_percentage: .08, maker_token_tags: ['bundler'] } : row);
  assert.equal(analyzeWallets(botHeavy, config).pass, false);
});

test('wallet proxy deduplicates addresses, normalizes risk tags and parses explicit percentages', () => {
  const ordinary = Array.from({ length: 10 }, (_, i) => ({ address: `0x${String(i + 1).padStart(40, '0')}`, addr_type: 0, buy_tx_count_cur: 1, is_new: false, is_suspicious: false, amount_percentage: '1%', native_transfer: { from_address: `source-${i}` }, tags: [], maker_token_tags: [] }));
  const deduped = analyzeWallets([...ordinary, { ...ordinary[0], address: ordinary[0].address.toUpperCase() }], config);
  assert.equal(deduped.sampled, 10);
  assert.equal(deduped.ordinaryCount, 10);
  assert.equal(deduped.duplicateCount, 1);
  assert.equal(deduped.pass, true);

  const bot = analyzeWallets(ordinary.map((row, index) => index === 0 ? { ...row, amount_percentage: '25%', maker_token_tags: ['BUNDLER'] } : row), config);
  assert.equal(bot.botHoldRate, .25);
  assert.equal(bot.pass, false);

  const missing = analyzeWallets([...ordinary.slice(0, 9), { ...ordinary[9], address: '' }], config);
  assert.equal(missing.ordinaryCount, 9);
  assert.equal(missing.pass, false);
  assert.ok(missing.unknownFields.includes('holders.address'));
});

test('market behavior deduplicates wallet evidence and requires multiple smart wallets for strength', () => {
  const firstSmart = { address, tags: ['SMART-DEGEN'] };
  const duplicateSmart = { address: address.toUpperCase(), maker_token_tags: ['smart_degen'] };
  const secondSmart = { address: '0x2222222222222222222222222222222222222222', tags: ['smart_degen'] };
  const one = marketBehaviorScreen({ holders: [firstSmart, duplicateSmart], nowMs: nowSec * 1000 }, config);
  assert.equal(one.evidence.smartWallets, 1);
  assert.deepEqual(one.strengths, []);

  const two = marketBehaviorScreen({ holders: [firstSmart, duplicateSmart, secondSmart], nowMs: nowSec * 1000 }, config);
  assert.equal(two.evidence.smartWallets, 2);
  assert.match(two.strengths.join(' '), /轻度加分/);
});

test('market behavior sends KOL-only, inconsistent activity and old sudden pumps to recheck', () => {
  const kolOnly = marketBehaviorScreen({
    discovery: { smart_degen_count: 1, renowned_count: 2 }, nowMs: nowSec * 1000
  }, config);
  assert.equal(kolOnly.pass, false);
  assert.match(kolOnly.downgradeReasons.join(' '), /仅见KOL/);

  const mismatch = marketBehaviorScreen({
    discovery: { smart_degen_count: 0, renowned_count: 0, holder_count: 10, swaps: 200, buys: 100, sells: 100 },
    nowMs: nowSec * 1000
  }, config);
  assert.equal(mismatch.pass, false);
  assert.match(mismatch.downgradeReasons.join(' '), /交易笔数与持有人数量/);

  const oldPump = marketBehaviorScreen({
    discovery: {
      creation_timestamp: nowSec - 2 * 86400, smart_degen_count: 3, renowned_count: 0,
      price_change_percent5m: .40, swaps: 40, buys: 25, sells: 15, holder_count: 100
    }, nowMs: nowSec * 1000
  }, config);
  assert.equal(oldPump.pass, false);
  assert.match(oldPump.downgradeReasons.join(' '), /老盘5分钟突然大幅拉升/);

  const recentlyOpened = marketBehaviorScreen({
    discovery: {
      creation_timestamp: nowSec - 2 * 86400, open_timestamp: nowSec - 600,
      smart_degen_count: 3, renowned_count: 0, price_change_percent5m: .40,
      swaps: 40, buys: 25, sells: 15, holder_count: 100
    }, nowMs: nowSec * 1000
  }, config);
  assert.equal(recentlyOpened.pass, true);
});

test('market behavior identifies distribution flow and corroborated repeat-launcher risk', () => {
  const distribution = marketBehaviorScreen({
    discovery: {
      creation_timestamp: nowSec - 3600, smart_degen_count: 3, renowned_count: 1,
      price_change_percent5m: .15, swaps: 60, buys: 20, sells: 40, holder_count: 100
    }, nowMs: nowSec * 1000
  }, config);
  assert.equal(distribution.pass, false);
  assert.match(distribution.downgradeReasons.join(' '), /分发阶段/);

  const repeat = marketBehaviorScreen({
    discovery: { creator_created_count: 20, creator_created_open_count: 2 },
    info: { dev: { creator_open_count: 20, creator_token_status: 'sell' } },
    nowMs: nowSec * 1000
  }, config);
  assert.equal(repeat.pass, false);
  assert.equal(repeat.evidence.creatorStatus, 'EXITED');
  assert.match(repeat.downgradeReasons.join(' '), /历史质量偏弱/);

  const historyUnknown = marketBehaviorScreen({
    info: { dev: { creator_open_count: 20, creator_token_status: 'sell' } },
    nowMs: nowSec * 1000
  }, config);
  assert.equal(historyUnknown.pass, true);
  assert.match(historyUnknown.warnings.join(' '), /历史发币20个/);
});

function candles({ spike = false } = {}) {
  return Array.from({ length: 6 }, (_, i) => ({ time: (nowSec - 7 * 60 + i * 60) * 1000, open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: spike && i === 5 ? 10000 : 100 }));
}

test('five-minute observation rejects single-candle machine volume pulse', () => {
  const normal = observeFiveMinutes(candles(), nowSec * 1000);
  assert.equal(normal.pass, true);
  assert.equal(normal.continuous, true);
  assert.equal(normal.fresh, true);
  assert.equal(normal.volumeTrend, 'STABLE');
  const result = observeFiveMinutes(candles({ spike: true }), nowSec * 1000);
  assert.equal(result.pass, false);
  assert.match(result.reason, /机器脉冲/);
});

test('five-minute observation waits on gapped or stale candles', () => {
  const gapped = candles();
  gapped[3] = { ...gapped[3], time: gapped[3].time + 30_000 };
  const gapResult = observeFiveMinutes(gapped, nowSec * 1000);
  assert.equal(gapResult.status, 'WAITING');
  assert.ok(gapResult.unknownFields.includes('candles.continuity'));

  const stale = candles().map(row => ({ ...row, time: row.time - 10 * 60_000 }));
  const staleResult = observeFiveMinutes(stale, nowSec * 1000);
  assert.equal(staleResult.status, 'WAITING');
  assert.ok(staleResult.unknownFields.includes('candles.freshness'));
});

test('sellability aligns seller evidence to a recent activity window and states its limitation', () => {
  const traders = Array.from({ length: 5 }, (_, i) => ({ address: `seller-${i}`, sell_tx_count_cur: 1, last_active_timestamp: nowSec - 60 }));
  const result = empiricalSellability({ info: { price: { sells_5m: 3, sells_24h: 20 } }, discovery: {}, traders, nowSec });
  assert.equal(result.pass, true);
  assert.equal(result.distinctSellers, 5);
  assert.match(result.evidenceNote, /不一定就是卖出/);
  assert.equal(empiricalSellability({ info: { price: { sells_5m: 3, sells_24h: 20 } }, discovery: {}, traders: traders.map(row => ({ ...row, last_active_timestamp: nowSec - 600 })), nowSec }).pass, false);
});

test('deep screen accepts strict chain data with empirical sell evidence and known DEV balance', () => {
  const holders = Array.from({ length: 10 }, (_, i) => ({ address: `0x${String(i + 1).padStart(40, '0')}`, addr_type: 0, buy_tx_count_cur: 1, is_new: false, is_suspicious: false, amount_percentage: .01, native_transfer: { from_address: `source-${i}` }, tags: [], maker_token_tags: [] }));
  const traders = Array.from({ length: 5 }, (_, i) => ({ address: `seller-${i}`, sell_tx_count_cur: 1, last_active_timestamp: nowSec - 60 }));
  const result = deepScreen({
    discovery: { address, market_cap: 50_000, liquidity: 10_000, sells_24h: 20, rug_ratio: .1, top_10_holder_rate: .2, bundler_rate: .05, rat_trader_amount_rate: .05, top70_sniper_hold_rate: .02, is_wash_trading: false, creator_token_status: 'creator_close', dev_team_hold_rate: 0, lock_percent: .9 },
    audit: { info: { liquidity: 10_000, price: { sells_5m: 3, sells_24h: 20 } }, security: { open_source: 'yes', owner_renounced: 'yes', buy_tax: .01, sell_tax: .01, rug_ratio: .1, top_10_holder_rate: .2, creator_token_status: 'creator_close', rat_trader_amount_rate: .05, bundler_trader_amount_rate: .05, top70_sniper_hold_rate: .02, is_wash_trading: false, lock_percent: .9 }, pool: { liquidity: 10_000 }, holders, traders, candles: candles() },
    nowMs: nowSec * 1000
  }, config);
  assert.equal(result.chainPass, true);
  assert.equal(result.honeypotEvidence, '经验卖出证据');
});

test('deep screen reuses nested token-info dev and stat fields without another request', () => {
  const result = deepScreen({
    discovery: { liquidity: 10_000, sells_24h: 20 },
    audit: {
      info: {
        liquidity: 10_000,
        locked_ratio: .9,
        holder_count: 10,
        dev: { creator_token_status: 'sell', creator_open_count: 2 },
        stat: { top_10_holder_rate: .2, dev_team_hold_rate: 0, top_rat_trader_percentage: .05, top_bundler_trader_percentage: .05 },
        price: { sells_5m: 3, sells_24h: 20 }
      },
      security: {
        open_source: true, owner_renounced: true, is_honeypot: false, buy_tax: 0, sell_tax: 0,
        rug_ratio: .1, top70_sniper_hold_rate: .02, is_wash_trading: false
      },
      pool: { liquidity: 10_000 }, holders: validHolders(), traders: recentTraders(), candles: candles()
    },
    nowMs: nowSec * 1000
  }, config);
  assert.equal(result.checks.dev, true);
  assert.equal(result.checks.concentration, true);
  assert.equal(result.security.creatorStatus, 'EXITED');
});

test('deep screen rejects malformed taxes instead of coercing them to zero', () => {
  const result = deepScreen({ discovery: {}, audit: { info: {}, security: { open_source: true, owner_renounced: true, buy_tax: 'unknown', sell_tax: '5%' }, pool: {}, holders: [], traders: [], candles: [] }, nowMs: nowSec * 1000 }, config);
  assert.equal(result.checks.tax, false);
  assert.ok(result.failed.includes('tax'));
  assert.ok(result.unknownFields.includes('buyTax'));
  assert.ok(result.blockingUnknownFields.includes('buyTax'));
  assert.equal(result.security.sellTax, .05);
});

test('deep screen accepts unequal buy and sell taxes within their limits', () => {
  const result = deepScreen({
    discovery: {
      address, market_cap: 50_000, liquidity: 10_000, sells_24h: 20, rug_ratio: .1,
      top_10_holder_rate: .2, bundler_rate: .05, rat_trader_amount_rate: .05,
      top70_sniper_hold_rate: .02, is_wash_trading: false, creator_token_status: 'creator_close', lock_percent: .9
    },
    audit: {
      info: { liquidity: 10_000, price: { sells_5m: 3, sells_24h: 20 } },
      security: { open_source: 'yes', owner_renounced: 'yes', is_honeypot: 'no', buy_tax: .01, sell_tax: .04,
        rug_ratio: .1, top_10_holder_rate: .2, creator_token_status: 'creator_close', rat_trader_amount_rate: .05,
        bundler_trader_amount_rate: .05, top70_sniper_hold_rate: .02, is_wash_trading: false, lock_percent: .9 },
      pool: { liquidity: 10_000 }, holders: validHolders(), traders: recentTraders(), candles: candles()
    },
    nowMs: nowSec * 1000
  }, config);
  assert.equal(result.checks.tax, true);
});


test('deep screen hard-fails unrenounced ownership and unlocked LP', () => {
  const result = deepScreen({ discovery: {}, audit: { info: {}, security: { open_source: 'yes', owner_renounced: 'no' }, pool: {}, holders: [], traders: [], candles: [] } }, config);
  assert.equal(result.chainPass, false);
  assert.ok(result.failed.includes('ownerRenounced'));
  assert.ok(result.failed.includes('lpLocked'));
  assert.ok(result.failed.includes('wash'));
});

// Rows exactly as AveClient parses an AVE hot list, so the screen sees production's fields.
async function aveHotListRows(tokens) {
  const { AveClient } = await import('../src/providers/ave.mjs');
  const client = new AveClient({ apiKey: 'scoring-test-key-0001', fetchImpl: async () => new Response(JSON.stringify({ status: 1, data: { tokens } })) });
  return (await client.trending('arc')).rows;
}

function aveToken(index, ageHours, overrides = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  return { token: `0x${String(index).padStart(40, 'a')}`, chain: 'arc', symbol: `T${index}`, name: 'Arc token', current_price_usd: '0.5',
    market_cap: '50000', main_pair_tvl: '12000', tvl: '12000', token_tx_volume_usd_5m: '900', token_buy_volume_u_5m: '500',
    token_sell_volume_u_5m: '400', updated_at: nowSec - 1, launch_at: nowSec - Math.round(ageHours * 3600), ...overrides };
}

test('the AVE screen admits healthy tokens up to the 7-day age limit on token-level facts alone', async () => {
  const ages = [0.5, 2, 5.9, 6.1, 24, 72, 167];
  const rows = await aveHotListRows(ages.map((age, index) => aveToken(index + 1, age)));
  for (const [index, row] of rows.entries()) {
    const screen = discoveryScreen(row, { ...config, chain: 'arc' }, Date.now() / 1000);
    assert.equal(screen.pass, true, `age ${ages[index]}h: ${screen.reasons.join(' | ')}`);
  }
  const [tooOld] = await aveHotListRows([aveToken(9, 169)]);
  assert.deepEqual(discoveryScreen(tooOld, { ...config, chain: 'arc' }, Date.now() / 1000).reasons, ['超过观察年龄上限']);
});

test('the AVE screen still demands more current activity from older tokens', async () => {
  // $150 of 5-minute volume clears the 1-6 h bar ($100, 0.5% of $12k = $60) but not the 6 h+ bar ($250, 1% = $120).
  const [mature, old] = await aveHotListRows([aveToken(1, 3, { token_tx_volume_usd_5m: '150' }), aveToken(2, 30, { token_tx_volume_usd_5m: '150' })]);
  assert.equal(discoveryScreen(mature, { ...config, chain: 'arc' }, Date.now() / 1000).pass, true);
  assert.deepEqual(discoveryScreen(old, { ...config, chain: 'arc' }, Date.now() / 1000).reasons, ['老币当前成交活跃度不足']);
});

test('AVE signals use verified five-minute fields and never generic activity counters', async () => {
  const [row] = await aveHotListRows([aveToken(1, 2)]);
  const screen = discoveryScreen({ ...row, volume_5m: null, swaps: 90, buys: 80, sells: 10, volume: 50_000 }, { ...config, chain: 'arc' }, Date.now() / 1000);
  assert.equal(screen.pass, false);
  assert.deepEqual([screen.signals.swaps5m, screen.signals.buys5m, screen.signals.sells5m, screen.signals.volume5m], [null, null, null, null]);
  assert.match(screen.reasons.join(' '), /近5分钟成交额不足或未知/);
});

test('AVE screen rejects a known zero five-minute trade side without inventing a missing side', async () => {
  const [row] = await aveHotListRows([aveToken(1, 2)]);
  for (const [field, label] of [['buys_5m', '近5分钟无买入成交'], ['sells_5m', '近5分钟无卖出成交']]) {
    const rejected = discoveryScreen({ ...row, [field]: 0 }, { ...config, chain: 'arc' }, Date.now() / 1000);
    assert.equal(rejected.pass, false);
    assert.ok(rejected.reasons.includes(label));
  }
  assert.equal(discoveryScreen(row, { ...config, chain: 'arc' }, Date.now() / 1000).pass, true);
});

test('the AVE screen does not screen by pool: a Uniswap v4 hook pool is neither required nor rejected', async () => {
  for (const ageHours of [2, 30]) {
    const [row] = await aveHotListRows([aveToken(1, ageHours)]);
    const withHookPool = { ...row, pairs: [{ chain: 'arc', address: row.address, pair: `0x${'b'.repeat(64)}`, amm: 'uniswap v4' }] };
    const screen = discoveryScreen(withHookPool, { ...config, chain: 'arc' }, Date.now() / 1000);
    assert.equal(screen.pass, true, `age ${ageHours}h: ${screen.reasons.join(' | ')}`);
  }
});

test('an AVE token without a launch time is dated by its creation time, as the lead shows it', async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const [row] = await aveHotListRows([aveToken(1, 0, { launch_at: null, created_at: nowSec - 30 * 3600 })]);
  const screen = discoveryScreen(row, { ...config, chain: 'arc' }, Date.now() / 1000);
  assert.equal(screen.pass, true, screen.reasons.join(' | '));
  assert.equal(screen.ageBasis, 'token');
  assert.equal(createdAt({ ...row, pool_created_at: nowSec - 3600 }), nowSec - 30 * 3600);
});

test('a promoted pool\'s DexScreener row is dated by its pool and fresh for a minute after our read; an AVE row is never dated by a pool', () => {
  const now = Date.now(), nowSec = Math.floor(now / 1000);
  const row = { address: `0x${'a'.repeat(40)}`, chain: 'arc', marketProvider: 'DEXSCREENER', price: 0.5, market_cap: 50_000, liquidity: 12_000,
    holder_count: null, buy_tax: null, sell_tax: null, creation_timestamp: nowSec - 3600, launch_at: null, ageBasis: 'pool',
    volume_5m: 900, buys_5m: 20, sells_5m: 5, capturedAt: now - 1_000, sourceUpdatedAt: now - 1_000 };
  const screen = discoveryScreen(row, { ...config, chain: 'arc' }, now / 1000);
  assert.equal(screen.pass, true, screen.reasons.join(' | '));
  assert.deepEqual([screen.ageBasis, screen.createdAt, screen.marketProvider], ['pool', nowSec - 3600, 'DEXSCREENER']);
  assert.deepEqual(discoveryScreen({ ...row, capturedAt: now - 61_000, sourceUpdatedAt: now - 61_000 }, { ...config, chain: 'arc' }, now / 1000).reasons,
    ['DexScreener 行情已过期或读取时间未核验']);
  const avePool = { ...row, marketProvider: 'AVE' };
  assert.deepEqual(discoveryScreen(avePool, { ...config, chain: 'arc' }, now / 1000).reasons, ['上线时间未知']);
});
