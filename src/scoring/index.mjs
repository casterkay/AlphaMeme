import { chartRiskScreen } from './chart-risk.mjs';
import { taxBreaches } from './tax.mjs';
import { first, num, optionalBoolean, optionalCount, optionalNonNegativeNumber, optionalNumber, optionalRate, optionalSignedRate } from './parse.mjs';

const lower = value => String(value ?? '').toLowerCase();

const normalizeAddress = value => typeof value === 'string' ? value.trim().toLowerCase() : '';

function normalizeTags(...values) {
  const tags = [];
  for (const value of values) {
    const rows = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,;|]/) : [];
    for (const row of rows) {
      const normalized = String(row).trim().toLowerCase().replace(/[\s-]+/g, '_');
      if (normalized) tags.push(normalized);
    }
  }
  return [...new Set(tags)];
}

const smartTags = new Set(['smart_degen']);
const renownedTags = new Set(['renowned', 'kol']);

function taggedWalletSignals(holders, chain) {
  const wallets = new Map();
  // Holder tags are a current-position snapshot. General trader rows may be
  // historical and are therefore not promoted to "currently participating".
  for (const row of (Array.isArray(holders) ? holders : [])) {
    const address = normalizeAddress(row?.address);
    if (!address) continue;
    const tags = wallets.get(address) || new Set();
    for (const tag of normalizeTags(row.tags, row.maker_token_tags)) tags.add(tag);
    wallets.set(address, tags);
  }
  return {
    smartWallets: [...wallets.values()].filter(tags => [...tags].some(tag => smartTags.has(tag))).length,
    renownedWallets: [...wallets.values()].filter(tags => [...tags].some(tag => renownedTags.has(tag))).length,
    sampledTaggedWallets: [...wallets.values()].filter(tags => tags.size > 0).length
  };
}

export function marketCap(row) {
  return num(first(row.market_cap, row.usd_market_cap, row.mcp));
}

export function createdAt(row) {
  // The same launch-based age the AVE screen uses; pools never date a token.
  if (row?.marketProvider === 'AVE') return num(first(row.launch_at,
    row.ageBasis === 'launch' || row.ageBasis === 'token' ? row.creation_timestamp : null));
  return num(first(row.creation_timestamp, row.created_timestamp, row.open_timestamp));
}

function securityView(source = {}, discovery = {}, info = {}) {
  const stat = info.stat || {};
  const dev = info.dev || {};
  return {
    openSource: first(source.open_source, source.is_open_source, discovery.open_source, discovery.is_open_source),
    ownerRenounced: first(source.owner_renounced, source.is_renounced, discovery.owner_renounced, discovery.is_renounced),
    honeypot: first(source.is_honeypot, discovery.is_honeypot),
    buyTax: first(source.buy_tax, discovery.buy_tax),
    sellTax: first(source.sell_tax, discovery.sell_tax),
    rugRatio: first(source.rug_ratio, discovery.rug_ratio),
    top10: first(source.top_10_holder_rate, discovery.top_10_holder_rate, stat.top_10_holder_rate, dev.top_10_holder_rate),
    devHold: first(source.dev_team_hold_rate, source.creator_balance_rate, discovery.dev_team_hold_rate,
      discovery.creator_balance_rate, stat.dev_team_hold_rate, stat.creator_hold_rate),
    creatorStatus: first(source.creator_token_status, discovery.creator_token_status, dev.creator_token_status),
    insider: first(source.suspected_insider_hold_rate, source.rat_trader_amount_rate,
      discovery.rat_trader_amount_rate, stat.top_rat_trader_percentage),
    bundler: first(source.bundler_trader_amount_rate, discovery.bundler_rate,
      discovery.bundler_trader_amount_rate, stat.top_bundler_trader_percentage),
    sniperHold: first(source.top70_sniper_hold_rate, discovery.top70_sniper_hold_rate),
    wash: first(source.is_wash_trading, discovery.is_wash_trading),
    burnStatus: first(source.burn_status, discovery.burn_status),
    lockRate: first(source.lock_percent, source.locked_ratio, discovery.lock_percent, discovery.locked_ratio, info.locked_ratio)
  };
}

const riskTags = new Set(['bundler', 'rat_trader', 'sniper', 'wash_trader', 'dex_bot']);

export function analyzeWallets(holders, config) {
  const rows = Array.isArray(holders) ? holders : [];
  const grouped = new Map();
  let missingAddressCount = 0;
  for (const row of rows) {
    const address = normalizeAddress(row?.address);
    if (!address) {
      missingAddressCount += 1;
      continue;
    }
    const current = grouped.get(address) || {
      address, addrTypes: [], tags: new Set(), holdRates: [], invalidHoldRate: false,
      isNewValues: [], suspiciousValues: [], buyTxCounts: [], sources: new Set()
    };
    const addrType = optionalNumber(row.addr_type);
    current.addrTypes.push(addrType);
    for (const tag of normalizeTags(row.tags, row.maker_token_tags)) current.tags.add(tag);
    const holdRate = optionalRate(row.amount_percentage);
    if (holdRate === null || holdRate < 0) current.invalidHoldRate = true;
    else current.holdRates.push(holdRate);
    current.isNewValues.push(optionalBoolean(row.is_new));
    current.suspiciousValues.push(optionalBoolean(row.is_suspicious));
    current.buyTxCounts.push(optionalNumber(row.buy_tx_count_cur));
    const source = normalizeAddress(first(row.native_transfer?.from_address, row.native_transfer?.address));
    if (source) current.sources.add(source);
    grouped.set(address, current);
  }

  const normalized = [...grouped.values()].map(row => ({
    address: row.address,
    addrTypeKnown: row.addrTypes.length > 0 && row.addrTypes.every(value => value !== null),
    regular: row.addrTypes.length > 0 && row.addrTypes.every(value => value === 0),
    tags: [...row.tags],
    holdRate: row.invalidHoldRate || !row.holdRates.length ? null : Math.max(...row.holdRates),
    isNew: row.isNewValues.includes(true) ? true : row.isNewValues.every(value => value === false) ? false : null,
    suspicious: row.suspiciousValues.includes(true) ? true : row.suspiciousValues.every(value => value === false) ? false : null,
    buyTxCount: row.buyTxCounts.length > 0 && row.buyTxCounts.every(value => value !== null) ? Math.max(...row.buyTxCounts) : null,
    sources: [...row.sources]
  }));
  const regular = normalized.filter(row => row.regular);
  const taggedRisk = regular.filter(row => row.tags.some(tag => riskTags.has(tag)) || row.suspicious === true);
  const ordinary = regular.filter(row => row.address && row.isNew === false && row.suspicious === false
    && row.buyTxCount !== null && row.buyTxCount > 0 && row.holdRate !== null
    && !row.tags.some(tag => riskTags.has(tag)));
  const invalidRateCount = regular.filter(row => row.holdRate === null).length;
  const riskRateUnknown = taggedRisk.some(row => row.holdRate === null);
  const botHoldRate = riskRateUnknown ? null : taggedRisk.reduce((sum, row) => sum + row.holdRate, 0);
  const sourceGroups = new Map();
  for (const row of regular) {
    for (const source of row.sources) {
      const group = sourceGroups.get(source) || [];
      group.push(row);
      sourceGroups.set(source, group);
    }
  }
  const linked = [...sourceGroups.values()].filter(group => group.length >= 2).flat();
  const uniqueLinked = [...new Map(linked.map(row => [row.address, row])).values()];
  const linkedRateUnknown = uniqueLinked.some(row => row.holdRate === null);
  const linkedHoldRate = linkedRateUnknown ? null : uniqueLinked.reduce((sum, row) => sum + row.holdRate, 0);
  const ordinaryHoldRate = ordinary.reduce((sum, row) => sum + row.holdRate, 0);
  const unknownFields = [
    missingAddressCount > 0 ? 'holders.address' : null,
    normalized.some(row => !row.addrTypeKnown) ? 'holders.addrType' : null,
    invalidRateCount > 0 ? 'holders.amountPercentage' : null,
    regular.some(row => row.isNew === null) ? 'holders.isNew' : null,
    regular.some(row => row.suspicious === null) ? 'holders.isSuspicious' : null,
    regular.some(row => row.buyTxCount === null) ? 'holders.buyTxCount' : null
  ].filter(Boolean);
  const dataComplete = unknownFields.length === 0;
  return {
    sampled: regular.length,
    ordinaryCount: ordinary.length,
    ordinaryHoldRate,
    riskWalletCount: taggedRisk.length,
    botHoldRate,
    linkedHoldRate,
    duplicateCount: rows.length - missingAddressCount - grouped.size,
    missingAddressCount,
    invalidRateCount,
    unknownFields,
    dataComplete,
    pass: dataComplete && ordinary.length >= config.minOrdinaryWallets
      && botHoldRate !== null && botHoldRate <= config.maxBotHoldRate
      && linkedHoldRate !== null && linkedHoldRate <= config.maxLinkedHoldRate
  };
}

function normalizedCreatorStatus(value) {
  const status = lower(value).trim();
  if (['creator_close', 'close', 'closed', 'sell', 'sold', 'exited'].includes(status)) return 'EXITED';
  if (['creator_hold', 'hold', 'holding'].includes(status)) return 'HOLDING';
  return 'UNKNOWN';
}

export function marketBehaviorScreen({ discovery = {}, info = {}, holders = [], observation = null, nowMs = Date.now() }, config) {
  const price = info.price || {};
  const tagEvidence = taggedWalletSignals(holders, config.chain);
  const aggregateSmart = optionalCount(first(info.wallet_tags_stat?.smart_wallets, discovery.smart_degen_count));
  const aggregateRenowned = optionalCount(first(info.wallet_tags_stat?.renowned_wallets, discovery.renowned_count));
  const smartKnown = aggregateSmart !== null || tagEvidence.smartWallets > 0;
  const renownedKnown = aggregateRenowned !== null || tagEvidence.renownedWallets > 0;
  const smartWallets = smartKnown ? Math.max(aggregateSmart ?? 0, tagEvidence.smartWallets) : null;
  const renownedWallets = renownedKnown ? Math.max(aggregateRenowned ?? 0, tagEvidence.renownedWallets) : null;

  const holderCount = optionalCount(first(info.holder_count, info.stat?.holder_count, discovery.holder_count));
  const swaps5m = optionalCount(first(price.swaps_5m, discovery.swaps_5m));
  const buys5m = optionalCount(first(price.buys_5m, discovery.buys_5m));
  const sells5m = optionalCount(first(price.sells_5m, discovery.sells_5m));
  const volume5m = optionalNonNegativeNumber(first(price.volume_5m, discovery.volume_5m));
  const currentPrice = optionalNumber(price.price);
  const priorPrice5m = optionalNumber(price.price_5m);
  const calculatedPriceChange = currentPrice !== null && currentPrice > 0 && priorPrice5m !== null && priorPrice5m > 0
    ? currentPrice / priorPrice5m - 1 : null;
  const priceChange5m = optionalSignedRate(first(
    calculatedPriceChange, discovery.price_change_percent5m, discovery.price_change_percent_5m
  ));
  // Trading age is the relevant clock for phase detection. Some contracts are
  // deployed long before liquidity opens, so prefer the market-open timestamp.
  const created = optionalNumber(first(info.open_timestamp, discovery.open_timestamp,
    info.creation_timestamp, discovery.creation_timestamp, discovery.created_timestamp));
  const ageSec = created !== null && created > 0 ? nowMs / 1000 - created : null;
  const creatorStatus = normalizedCreatorStatus(first(info.dev?.creator_token_status, discovery.creator_token_status));
  const creatorCreatedCount = optionalCount(discovery.creator_created_count);
  const creatorGraduatedCount = optionalCount(discovery.creator_created_open_count);
  const creatorLaunchCount = optionalCount(first(info.dev?.creator_open_count, creatorCreatedCount));
  const creatorOpenRatio = creatorCreatedCount !== null && creatorCreatedCount > 0
    && creatorGraduatedCount !== null && creatorGraduatedCount <= creatorCreatedCount
    ? creatorGraduatedCount / creatorCreatedCount : null;
  const creatorDeletedPosts = optionalCount(info.dev?.twitter_del_post_token_count);
  const creatorPromotedTokens = optionalCount(info.dev?.twitter_create_token_count);

  const txTotal = buys5m !== null && sells5m !== null ? buys5m + sells5m : null;
  const swapCountConsistent = swaps5m === null || txTotal === null
    ? null : Math.abs(swaps5m - txTotal) <= Math.max(2, Math.ceil(swaps5m * 0.05));
  const swapsPerHolder5m = swaps5m !== null && holderCount !== null && holderCount > 0 ? swaps5m / holderCount : null;
  const holderSampleDistinct = new Set((Array.isArray(holders) ? holders : [])
    .map(row => normalizeAddress(row?.address)).filter(Boolean)).size;
  const holderSampleConsistent = holderCount === null || holderSampleDistinct === 0 ? null : holderCount >= holderSampleDistinct;
  const sellBuyRatio = buys5m !== null && sells5m !== null
    ? (buys5m > 0 ? sells5m / buys5m : sells5m === 0 ? 0 : null) : null;

  // These are deliberately conservative downgrade signals, not claims of
  // fraud or profitability. They only send the token to a later recheck.
  const kolOnly = smartWallets !== null && smartWallets <= 1 && renownedWallets !== null && renownedWallets > 0;
  const activityHolderMismatch = swaps5m !== null && swaps5m >= 100
    && swapsPerHolder5m !== null && swapsPerHolder5m >= 15
    && smartWallets !== null && smartWallets < 2;
  const distributionFlow = priceChange5m !== null && priceChange5m >= 0.12
    && buys5m !== null && sells5m !== null && sells5m >= 20
    && (buys5m === 0 || (sellBuyRatio !== null && sellBuyRatio >= 1.5));
  const oldSuddenPump = ageSec !== null && ageSec >= 24 * 60 * 60
    && priceChange5m !== null && priceChange5m >= 0.35;
  const fadingPump = observation?.pass === true && optionalSignedRate(observation.return5m) !== null
    && observation.return5m >= 0.10 && observation.volumeTrend === 'FALLING'
    && optionalCount(observation.decliningVolumeBars) !== null && observation.decliningVolumeBars >= 3;
  const repeatLauncherWithWeakHistory = creatorLaunchCount !== null && creatorLaunchCount >= 10
    && ((creatorOpenRatio !== null && creatorOpenRatio < 0.20)
      || (creatorDeletedPosts !== null && creatorDeletedPosts >= 3
        && creatorPromotedTokens !== null && creatorPromotedTokens > 0
        && creatorDeletedPosts / creatorPromotedTokens >= 0.50));
  const repeatLauncherStillHolding = creatorLaunchCount !== null && creatorLaunchCount >= 10
    && creatorStatus === 'HOLDING';

  const downgradeReasons = [
    kolOnly ? '仅见KOL钱包，未见至少2个独立聪明钱钱包' : null,
    swapCountConsistent === false ? '5分钟买卖笔数与总交换数不一致' : null,
    holderSampleConsistent === false ? '持有人总数小于已返回的独立钱包样本' : null,
    activityHolderMismatch ? '5分钟交易笔数与持有人数量严重不匹配' : null,
    distributionFlow ? '短时上涨同时卖单显著压过买单，疑似分发阶段' : null,
    oldSuddenPump ? '老盘5分钟突然大幅拉升，等待避免追高' : null,
    fadingPump ? '价格上涨但连续缩量，等待确认承接' : null,
    repeatLauncherWithWeakHistory ? '创建者反复发币且可验证历史质量偏弱' : null,
    repeatLauncherStillHolding ? '创建者反复发币且当前仍持币' : null
  ].filter(Boolean);
  const warnings = [
    creatorLaunchCount !== null && creatorLaunchCount >= 10 ? `创建者历史发币${creatorLaunchCount}个` : null,
    creatorStatus === 'UNKNOWN' ? '创建者当前持币状态未知' : null
  ].filter(Boolean);
  const strengths = [
    smartWallets !== null && smartWallets >= 3 ? `${smartWallets}个聪明钱钱包形成多钱包验证` : null,
    smartWallets === 2 ? '2个聪明钱钱包，只有轻度加分' : null
  ].filter(Boolean);
  const unknownFields = [
    smartWallets === null ? 'marketBehavior.smartWallets' : null,
    renownedWallets === null ? 'marketBehavior.renownedWallets' : null,
    holderCount === null ? 'marketBehavior.holderCount' : null,
    swaps5m === null ? 'marketBehavior.swaps5m' : null,
    buys5m === null ? 'marketBehavior.buys5m' : null,
    sells5m === null ? 'marketBehavior.sells5m' : null,
    volume5m === null ? 'marketBehavior.volume5m' : null,
    priceChange5m === null ? 'marketBehavior.priceChange5m' : null,
    ageSec === null ? 'marketBehavior.age' : null,
    creatorLaunchCount === null ? 'marketBehavior.creatorLaunchCount' : null
  ].filter(Boolean);
  return {
    pass: downgradeReasons.length === 0,
    status: downgradeReasons.length ? 'WAITING' : 'PASS',
    downgradeReasons, warnings, strengths, unknownFields,
    evidence: {
      smartWallets, renownedWallets, taggedSmartWallets: tagEvidence.smartWallets,
      taggedRenownedWallets: tagEvidence.renownedWallets, sampledTaggedWallets: tagEvidence.sampledTaggedWallets,
      holderCount, holderSampleDistinct, swaps5m, buys5m, sells5m, volume5m, priceChange5m,
      swapsPerHolder5m, swapCountConsistent, holderSampleConsistent, sellBuyRatio, ageSec,
      creatorStatus, creatorLaunchCount, creatorCreatedCount, creatorGraduatedCount,
      creatorOpenRatio, creatorDeletedPosts, creatorPromotedTokens
    }
  };
}

export function observeFiveMinutes(candles, nowMs = Date.now()) {
  const source = Array.isArray(candles) ? candles : [];
  const parsed = source.map(row => ({
    time: optionalNumber(first(row?.time, row?.t)), open: optionalNumber(row?.open), high: optionalNumber(row?.high),
    low: optionalNumber(row?.low), close: optionalNumber(row?.close), volume: optionalNumber(row?.volume)
  }));
  const valid = parsed.filter(row => row.time !== null && row.time > 0
    && row.open !== null && row.open > 0 && row.high !== null && row.high > 0
    && row.low !== null && row.low > 0 && row.close !== null && row.close > 0
    && row.volume !== null && row.volume >= 0
    && row.high >= Math.max(row.open, row.close) && row.low <= Math.min(row.open, row.close));
  const invalidBars = source.length - valid.length;
  const unique = [...new Map(valid.map(row => [row.time, row])).values()];
  const duplicateBars = valid.length - unique.length;
  const rows = unique.filter(row => row.time + 60_000 <= nowMs).sort((a, b) => a.time - b.time).slice(-10);
  if (rows.length < 5) return {
    pass: false, status: 'WAITING', reason: '不足5根有效且已收盘的1分钟K线', bars: rows.length,
    invalidBars, duplicateBars, continuous: false, fresh: false, unknownFields: ['candles']
  };
  const firstFive = rows.slice(-5), start = firstFive[0].open, end = firstFive.at(-1).close;
  const gapsMs = firstFive.slice(1).map((row, index) => row.time - firstFive[index].time);
  const continuous = gapsMs.every(gap => Math.abs(gap - 60_000) <= 1_000);
  const latestClosedAt = firstFive.at(-1).time + 60_000;
  const stalenessMs = Math.max(0, nowMs - latestClosedAt);
  const fresh = stalenessMs <= 2 * 60_000;
  if (!continuous) return {
    pass: false, status: 'WAITING', reason: '最近K线不连续，等待完整5分钟窗口', bars: firstFive.length,
    invalidBars, duplicateBars, continuous, fresh, gapsMs, latestClosedAt, stalenessMs, unknownFields: ['candles.continuity']
  };
  if (!fresh) return {
    pass: false, status: 'WAITING', reason: '最近K线已过期，等待行情更新', bars: firstFive.length,
    invalidBars, duplicateBars, continuous, fresh, gapsMs, latestClosedAt, stalenessMs, unknownFields: ['candles.freshness']
  };
  let peak = firstFive[0].high, maxDrawdown = 0;
  for (const row of firstFive) { peak = Math.max(peak, row.high); maxDrawdown = Math.max(maxDrawdown, peak > 0 ? (peak - row.low) / peak : 0); }
  const volumes = firstFive.map(row => row.volume), totalVolume = volumes.reduce((a, b) => a + b, 0);
  const volumeConcentration = totalVolume > 0 ? Math.max(...volumes) / totalVolume : 1;
  const earlyVolume = (volumes[0] + volumes[1]) / 2;
  const recentVolume = (volumes.at(-2) + volumes.at(-1)) / 2;
  const volumeChange = earlyVolume > 0 ? recentVolume / earlyVolume - 1 : recentVolume > 0 ? null : 0;
  const volumeTrend = volumeChange === null ? 'UNKNOWN' : volumeChange > 0.15 ? 'RISING' : volumeChange < -0.15 ? 'FALLING' : 'STABLE';
  const decliningVolumeBars = volumes.slice(1).filter((value, index) => value < volumes[index]).length;
  const return5m = end / start - 1;
  const activeBars = volumes.filter(value => value > 0).length;
  const pass = return5m >= -0.12 && return5m <= 0.80 && maxDrawdown <= 0.25 && volumeConcentration <= 0.65 && activeBars >= 4;
  const reason = return5m < -0.12 ? '观察期跌幅过大'
    : return5m > 0.80 ? '5分钟涨幅过大，拒绝追高'
      : maxDrawdown > 0.25 ? '观察期最大回撤过大'
        : volumeConcentration > 0.65 ? '成交集中在单根K线，疑似机器脉冲'
          : activeBars < 4 ? '多数分钟无成交' : '5分钟盘面通过';
  return {
    pass, status: pass ? 'PASS' : 'FAIL', reason, bars: firstFive.length, return5m, maxDrawdown,
    volumeConcentration, totalVolume, activeBars, volumeChange, volumeTrend, decliningVolumeBars,
    invalidBars, duplicateBars, continuous, fresh, gapsMs, latestClosedAt, stalenessMs, unknownFields: []
  };
}

function unixSeconds(value) {
  const parsed = optionalNumber(value);
  if (parsed === null || parsed <= 0) return null;
  return parsed >= 1_000_000_000_000 ? parsed / 1000 : parsed;
}

export function empiricalSellability({ info, discovery, traders, nowSec = Date.now() / 1000, windowSec = 5 * 60, chain = 'robinhood' }) {
  const price = info.price || {};
  const sells5m = optionalNumber(first(price.sells_5m, discovery.sells_5m));
  const sells24h = optionalNumber(first(price.sells_24h, discovery.sells_24h));
  const unique = new Map();
  for (const row of Array.isArray(traders) ? traders : []) {
    const address = normalizeAddress(row?.address);
    if (!address) continue;
    const sellTxCount = optionalNumber(row.sell_tx_count_cur);
    const lastActiveAt = unixSeconds(first(row.last_active_timestamp, row.last_active_at));
    const previous = unique.get(address) || { address, sellTxCount: null, lastActiveAt: null };
    unique.set(address, {
      address,
      sellTxCount: sellTxCount === null ? previous.sellTxCount : Math.max(previous.sellTxCount ?? 0, sellTxCount),
      lastActiveAt: lastActiveAt === null ? previous.lastActiveAt : Math.max(previous.lastActiveAt ?? 0, lastActiveAt)
    });
  }
  const historicalSellers = [...unique.values()].filter(row => row.sellTxCount !== null && row.sellTxCount > 0);
  const recentActiveSellers = historicalSellers.filter(row => row.lastActiveAt !== null
    && row.lastActiveAt >= nowSec - windowSec && row.lastActiveAt <= nowSec + 60);
  const historicalDistinctSellers = historicalSellers.length;
  const distinctSellers = recentActiveSellers.length;
  const unknownFields = [
    sells5m === null ? 'sellability.sells5m' : null,
    sells24h === null ? 'sellability.sells24h' : null,
    historicalSellers.some(row => row.lastActiveAt === null) ? 'sellability.traderLastActiveAt' : null
  ].filter(Boolean);
  const pass = unknownFields.length === 0 && sells5m >= 2 && sells24h >= 10 && distinctSellers >= 5;
  return {
    pass, sells5m, sells24h, distinctSellers, historicalDistinctSellers, windowSec, unknownFields,
    evidenceType: 'recent_active_seller_proxy',
    evidenceNote: '不同卖家按最近链上活跃时间近似对齐5分钟窗口；活跃动作不一定就是卖出，仍不是合约级卖出保证。'
  };
}

export function deepScreen({ discovery, audit, nowMs = Date.now() }, config) {
  const info = audit.info || {}, pool = audit.pool || {};
  const sec = securityView(audit.security, discovery, info);
  const openSource = optionalBoolean(sec.openSource);
  const ownerRenounced = optionalBoolean(sec.ownerRenounced);
  const honeypot = optionalBoolean(sec.honeypot);
  const buyTax = optionalRate(sec.buyTax);
  const sellTax = optionalRate(sec.sellTax);
  const rugRatio = optionalRate(sec.rugRatio);
  const top10 = optionalRate(sec.top10);
  const devHold = optionalRate(sec.devHold);
  const insider = optionalRate(sec.insider);
  const bundler = optionalRate(sec.bundler);
  const sniperHold = optionalRate(sec.sniperHold);
  const wash = optionalBoolean(sec.wash);
  const liquidityValue = optionalNumber(first(pool.liquidity, info.liquidity, discovery.liquidity));
  const liquidity = liquidityValue ?? 0;
  const lockRate = optionalRate(first(sec.lockRate, info.locked_ratio));
  const lpBurned = lower(sec.burnStatus) === 'burn';
  const wallets = analyzeWallets(audit.holders, config);
  const observation = observeFiveMinutes(audit.candles, nowMs);
  const chartRisk = chartRiskScreen(audit.candles, nowMs);
  const marketBehavior = marketBehaviorScreen({
    discovery, info, holders: audit.holders, observation, nowMs
  }, config);
  const sellability = empiricalSellability({ info, discovery, traders: audit.traders, nowSec: nowMs / 1000, chain: config.chain });
  const exactNotHoneypot = honeypot === false;
  const explicitHoneypot = honeypot === true;
  const checks = {
    openSource: openSource === true,
    ownerRenounced: ownerRenounced === true,
    lpLocked: lpBurned || (lockRate !== null && lockRate >= config.minLpLockedRate),
    notHoneypot: exactNotHoneypot || (!explicitHoneypot && sellability.pass),
    tax: buyTax !== null && sellTax !== null && !taxBreaches(buyTax, sellTax, config).length,
    rug: rugRatio !== null && rugRatio <= config.maxRugRatio,
    concentration: top10 !== null && top10 <= config.maxTop10Rate,
    dev: devHold !== null && devHold <= 0.01,
    insider: insider !== null && insider <= config.maxInsiderRate,
    bundler: bundler !== null && bundler <= config.maxBundlerRate,
    sniper: sniperHold !== null && sniperHold <= config.maxSniperHoldRate,
    wash: wash === false,
    liquidity: liquidityValue !== null && liquidity >= config.strictLiquidity,
    wallets: wallets.pass,
    observation: observation.pass,
    chartRisk: chartRisk.pass,
    marketBehavior: marketBehavior.pass
  };
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  const chainPass = failed.length === 0;
  const honeypotEvidence = exactNotHoneypot ? 'GMGN明确非貔貅' : sellability.pass ? '经验卖出证据' : explicitHoneypot ? '检测到貔貅' : '未验证';
  const unknownFields = [
    openSource === null ? 'openSource' : null,
    ownerRenounced === null ? 'ownerRenounced' : null,
    honeypot === null ? 'honeypot' : null,
    buyTax === null ? 'buyTax' : null,
    sellTax === null ? 'sellTax' : null,
    rugRatio === null ? 'rugRatio' : null,
    top10 === null ? 'top10' : null,
    devHold === null ? 'devHold' : null,
    insider === null ? 'insider' : null,
    bundler === null ? 'bundler' : null,
    sniperHold === null ? 'sniperHold' : null,
    wash === null ? 'wash' : null,
    !lpBurned && lockRate === null ? 'lockRate' : null,
    liquidityValue === null ? 'liquidity' : null,
    ...wallets.unknownFields,
    ...observation.unknownFields,
    ...chartRisk.unknownFields,
    ...(honeypot !== false ? sellability.unknownFields : [])
  ].filter(Boolean);
  const blockingUnknownFields = [
    openSource === null ? 'openSource' : null,
    ownerRenounced === null ? 'ownerRenounced' : null,
    honeypot === null && !sellability.pass ? 'honeypot' : null,
    buyTax === null ? 'buyTax' : null,
    sellTax === null ? 'sellTax' : null,
    rugRatio === null ? 'rugRatio' : null,
    top10 === null ? 'top10' : null,
    devHold === null ? 'devHold' : null,
    insider === null ? 'insider' : null,
    bundler === null ? 'bundler' : null,
    sniperHold === null ? 'sniperHold' : null,
    wash === null ? 'wash' : null,
    !lpBurned && lockRate === null ? 'lockRate' : null,
    liquidityValue === null ? 'liquidity' : null,
    ...wallets.unknownFields,
    ...(observation.status === 'WAITING' ? observation.unknownFields : []),
    ...chartRisk.unknownFields,
    ...(honeypot === null && !sellability.pass ? sellability.unknownFields : [])
  ].filter(Boolean);
  return {
    chainPass, failed, checks, wallets, observation, chartRisk, marketBehavior, sellability, honeypotEvidence,
    unknownFields: [...new Set(unknownFields)],
    blockingUnknownFields: [...new Set(blockingUnknownFields)],
    security: {
      openSource, ownerRenounced, honeypot, buyTax, sellTax,
      taxDifference: buyTax !== null && sellTax !== null ? Math.abs(buyTax - sellTax) : null,
      rugRatio, top10, devHold, creatorStatus: normalizedCreatorStatus(sec.creatorStatus),
      insider, bundler, sniperHold, wash, lockRate, lpBurned, liquidity: liquidityValue
    }
  };
}
