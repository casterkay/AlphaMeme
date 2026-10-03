// A frozen copy of the discovery screen before the rule table (#105), taken from
// origin/dev at e5864bf. It is the parity oracle: the rule table must
// pass and fail exactly the rows this passes and fails. Never edit it.
import { validTokenAddress } from '../../src/address.mjs';

function taxBreaches(buyTax, sellTax, { maxBuyTax, maxSellTax }) {
  return [buyTax !== null && buyTax > maxBuyTax && 'buyTax', sellTax !== null && sellTax > maxSellTax && 'sellTax'].filter(Boolean);
}

const NUMBER_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

function optionalNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || !NUMBER_PATTERN.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
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

function optionalCount(value) {
  const parsed = optionalNumber(value);
  return parsed !== null && parsed >= 0 && Number.isInteger(parsed) ? parsed : null;
}

function optionalNonNegativeNumber(value) {
  const parsed = optionalNumber(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}

// Internal thresholds use ratios. A literal percent string is accepted too,
// but large bare values are deliberately not guessed to be percentages because
// doing so would manufacture precision from ambiguous upstream data.
function optionalSignedRate(value) {
  let parsed;
  if (typeof value === 'string' && value.trim().endsWith('%')) {
    const percent = optionalNumber(value.trim().slice(0, -1));
    parsed = percent === null ? null : percent / 100;
  } else {
    parsed = optionalNumber(value);
  }
  return parsed !== null && parsed >= -5 && parsed <= 5 ? parsed : null;
}

function optionalBoolean(value) {
  if (value === true || value === false) return value;
  if (value === 1 || value === 0) return value === 1;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (['yes', 'true', '1'].includes(normalized)) return true;
  if (['no', 'false', '0'].includes(normalized)) return false;
  return null;
}

const num = (value, fallback = 0) => optionalNumber(value) ?? fallback;
const first = (...values) => values.find(value => value !== undefined && value !== null && value !== '');

function discoverySignalView(row = {}) {
  return {
    smartDegenCount: optionalCount(row.smart_degen_count), renownedCount: optionalCount(row.renowned_count),
    holders: optionalCount(row.holder_count), swaps5m: optionalCount(row.swaps_5m), buys5m: optionalCount(row.buys_5m),
    sells5m: optionalCount(row.sells_5m), volume5m: optionalNonNegativeNumber(row.volume_5m),
    priceChange5m: optionalSignedRate(row.price_change_percent5m)
  };
}

export function discoveryScreen(row, config, nowSec = Date.now() / 1000) {
  if (row?.marketProvider !== 'AVE' && row?.marketProvider !== 'DEXSCREENER') {
    throw new TypeError(`discovery row from an unsupported market provider: ${String(row?.marketProvider)}`);
  }
  const now = nowSec * 1000, chain = config.chain, dexScreener = row.marketProvider === 'DEXSCREENER';
  const mcValue = optionalNonNegativeNumber(row.market_cap), liquidityValue = optionalNonNegativeNumber(row.liquidity);
  const fallbackBasis = dexScreener ? 'pool' : 'token';
  const launchAt = optionalNumber(row.launch_at), tokenAt = row.ageBasis === 'launch' || row.ageBasis === fallbackBasis
    ? optionalNumber(row.creation_timestamp) : null;
  const created = launchAt !== null && launchAt > 0 ? launchAt : tokenAt;
  const ageBasis = launchAt !== null && launchAt > 0 ? 'launch' : tokenAt !== null && tokenAt > 0 ? fallbackBasis : 'unknown';
  const ageSec = created !== null && created > 0 ? nowSec - created : 0;
  const mc = mcValue ?? 0, liquidity = liquidityValue ?? 0, volume = optionalNonNegativeNumber(row.volume_5m);
  const reasons = knownRiskReasons(row, { ...config, strictLiquidity: config.minLiquidity });
  if (row.chain !== chain || !validTokenAddress(row.address) || /^0x(?:0{40}|e{40})$/i.test(row.address || '')) reasons.push('链或代币地址不匹配');
  if (!(optionalNumber(row.price) > 0)) reasons.push('价格数据未知');
  // DexScreener keeps no source clock: our read time stands in, so its row is fresh for a minute after the read.
  const capturedAt = optionalNumber(row.capturedAt), sourceUpdatedAt = optionalNumber(row.sourceUpdatedAt);
  if (row.stale === true || capturedAt === null || sourceUpdatedAt === null || capturedAt <= 0 || sourceUpdatedAt <= 0 ||
    capturedAt > now || sourceUpdatedAt > capturedAt || now - capturedAt > 60000 || now - sourceUpdatedAt > 60000 ||
    row.expiresAt != null && (optionalNumber(row.expiresAt) === null || row.expiresAt <= now)) reasons.push(dexScreener ? 'DexScreener 行情已过期或读取时间未核验' : 'AVE 行情已过期或原始时间未核验');
  // A fresh pool response may omit market cap. Token fallback keeps its own
  // original clock; a fresh pool must never refresh an old token market cap.
  if (Object.hasOwn(row, 'marketCapSourceUpdatedAt') && (optionalNumber(row.marketCapSourceUpdatedAt) === null ||
    !(row.marketCapSourceUpdatedAt > 0) || row.marketCapSourceUpdatedAt > row.marketCapCapturedAt ||
    row.marketCapCapturedAt > now || now - row.marketCapSourceUpdatedAt > 60000 ||
    !(row.marketCapExpiresAt > now))) reasons.push('市值原始时间待更新');
  if (created === null || created <= 0 || !Number.isInteger(created)) reasons.push('上线时间未知');
  else if (ageSec < config.minAgeSec) reasons.push('上线不足5分钟');
  else if (ageSec > config.maxAgeSec) reasons.push('超过观察年龄上限');
  if (mcValue === null) reasons.push('市值数据未知');
  else if (!(mc >= config.discoveryMinMarketCap && mc <= config.discoveryMaxMarketCap)) reasons.push('市值不在发现范围');
  if (liquidityValue === null) reasons.push('流动性数据未知');
  else if (liquidity < config.minLiquidity) reasons.push('流动性不足');
  if (!(volume > 0)) reasons.push('近5分钟成交额不足或未知');
  if (volume !== null && liquidityValue !== null && ageSec >= (config.matureMarketAgeSec ?? 3600)) {
    const old = ageSec >= (config.oldMarketAgeSec ?? 21600);
    const absolute = old ? config.minOldVolume5mUsd ?? 250 : config.minMatureVolume5mUsd ?? 100;
    const turnover = old ? config.minOldTurnover5m ?? .01 : config.minMatureTurnover5m ?? .005;
    if (volume < Math.max(absolute, liquidity * turnover)) reasons.push(old ? '老币当前成交活跃度不足' : '当前成交活跃度不足');
  }
  for (const field of ['buy_volume_5m', 'sell_volume_5m']) {
    if (row[field] != null && !(optionalNonNegativeNumber(row[field]) > 0)) reasons.push(field === 'buy_volume_5m' ? '近5分钟买入额不足或未核验' : '近5分钟卖出额不足或未核验');
  }
  if (optionalCount(row.buys_5m) === 0) reasons.push('近5分钟无买入成交');
  if (optionalCount(row.sells_5m) === 0) reasons.push('近5分钟无卖出成交');
  if (optionalBoolean(row.is_honeypot) === true || row.sellable === false || optionalBoolean(row.cannot_sell_all) === true) reasons.push('已知貔貅或卖出受限');
  if (optionalBoolean(row.is_wash_trading) === true) reasons.push('检测到刷量');
  for (const [field, label] of [['rug_ratio', 'rug风险'], ['bundler_rate', '捆绑机器人占比'], ['rat_trader_amount_rate', '内幕占比']]) {
    if ((optionalRate(row[field]) ?? 0) > .3) reasons.push(label + '过高');
  }
  const signals = discoverySignalView(row), priorityBand = mc >= config.priorityMinMarketCap && mc <= config.priorityMaxMarketCap;
  const score = (priorityBand ? 35 : 10) + Math.min(25, liquidity / 1000) + Math.min(20, (volume || 0) / 1000) + Math.min(20, num(row.holder_count) / 10);
  return { pass: reasons.length === 0, reasons: [...new Set(reasons)], priorityBand, score, mc, liquidity, ageSec, ageBasis,
    marketProvider: row.marketProvider, createdAt: created, signals,
    unknownFields: ['rugRatio', 'bundler', 'insider', 'wash', 'honeypot'].filter(field => ({ rugRatio: optionalRate(row.rug_ratio), bundler: optionalRate(row.bundler_rate),
      insider: optionalRate(row.rat_trader_amount_rate), wash: optionalBoolean(row.is_wash_trading), honeypot: optionalBoolean(row.is_honeypot) })[field] === null) };
}

// Known adverse facts in a discovery row. Missing facts remain unknown.
function knownRiskReasons(row, config) {
  const reasons = [];
  const lp = optionalNumber(row.liquidity);
  const buy = optionalRate(row.buy_tax), sell = optionalRate(row.sell_tax);
  const dev = optionalRate(first(row.dev_team_hold_rate, row.creator_balance_rate, row.creator_hold_rate));
  if (lp !== null && lp < config.strictLiquidity) reasons.push('流动性低于深审门槛');
  if (taxBreaches(buy, sell, config).length) reasons.push('交易税超过风险门槛');
  if (dev !== null && dev > .01) reasons.push('DEV持仓超过1%');
  // Never reinterpret the live feed's generic 1m counters as 5m activity.
  if (optionalNumber(row.volume_5m) === 0) reasons.push('近5分钟无成交，暂不进入候选');
  return reasons;
}
