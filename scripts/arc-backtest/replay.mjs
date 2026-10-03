/** Immediate $2 baseline. Historical markets stay fixed; our own fills pay impact. */
export const POLICIES = Object.freeze([
  { name: '50% at 2x', multiple: 2, fraction: 0.5 },
  { name: '63% at 1.6x', multiple: 1.6, fraction: 0.63 },
  { name: '40% at 2.5x', multiple: 2.5, fraction: 0.4 }
]);
export const DELAYS = Object.freeze([1, 2, 4, 10, 20]);
export const DEFAULT_COSTS = Object.freeze({
  stakeUsd: 2, slippageBps: 50, gasPriceUsdPerUnit: 20e9 / 1e18,
  swapGasUnits: 250_000, approvalGasUnits: 50_000, exitDelayBlocks: 1,
  dynamicFeePips: 3_000
});

function flag(value) {
  if ([true, 1, '1', 'true', 'yes'].includes(value)) return true;
  if ([false, 0, '0', 'false', 'no'].includes(value)) return false;
  return null;
}
function tax(value) {
  if (value === undefined || value === null || value === '') return null;
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 && result <= 1 ? result : null;
}

/** GMGN's two honeypot representations must agree; missing is distinct from false. */
export function normalizeSecurity(raw) {
  const flags = [flag(raw?.is_honeypot), flag(raw?.honeypot)].filter(value => value !== null);
  const honeypot = flags.length && flags.every(value => value === flags[0]) ? flags[0] : null;
  return { honeypot, buyTax: tax(raw?.buy_tax), sellTax: tax(raw?.sell_tax) };
}

/** Single active-range virtual reserves: inexpensive size-aware v3/v4 approximation. */
export function market(pool, state, costs = DEFAULT_COSTS) {
  const squareRootPrice = Number(BigInt(state.sqrtPriceX96)) / 2 ** 96;
  const liquidity = Number(BigInt(state.liquidity));
  if (!(squareRootPrice > 0) || !(liquidity > 0)) return null;
  const reserve0 = liquidity / squareRootPrice, reserve1 = liquidity * squareRootPrice;
  const tokenReserve = pool.tokenIs0 ? reserve0 : reserve1;
  const quoteReserveUsd = (pool.tokenIs0 ? reserve1 : reserve0) / 10 ** pool.quoteDecimals;
  // A dynamic fee before the first Swap uses that pool's first observed fee.
  const observedFee = state.feePips ?? pool.feePips;
  const firstFee = pool.states.find(point => point.feePips >= 0 && point.feePips < 1_000_000)?.feePips;
  const feePips = observedFee >= 0 && observedFee < 1_000_000 ? observedFee : firstFee ?? costs.dynamicFeePips;
  if (!(tokenReserve > 0) || !(quoteReserveUsd > 0)) return null;
  return { tokenReserve, quoteReserveUsd, price: quoteReserveUsd / tokenReserve, fee: feePips / 1_000_000 };
}

export function buyFill(depth, spendUsd, buyTax, slippageBps) {
  const effectiveSpend = spendUsd * (1 - depth.fee);
  return depth.tokenReserve * effectiveSpend / (depth.quoteReserveUsd + effectiveSpend)
    * (1 - buyTax) * (1 - slippageBps / 10_000);
}
export function sellFill(depth, quantity, sellTax, slippageBps) {
  const effectiveQuantity = quantity * (1 - sellTax) * (1 - depth.fee);
  return depth.quoteReserveUsd * effectiveQuantity / (depth.tokenReserve + effectiveQuantity)
    * (1 - slippageBps / 10_000);
}

/** Bounds cover missing current security/taxes without removing tokens from the cohort. */
export function replay(pool, security, delay, policy, blockSeconds, costs = DEFAULT_COSTS, unknown = 'optimistic') {
  costs = { ...DEFAULT_COSTS, ...costs };
  const result = { token: pool.token, pool: pool.id, delayBlocks: delay, policy: policy.name,
    entered: false, spentUsd: 0, proceedsUsd: 0, gasUsd: 0, netUsd: 0,
    failedExits: 0, fills: [], exitReason: 'never_funded', securityUnknown: Object.values(security).some(value => value === null) };
  const first = pool.states.findIndex(point => BigInt(point.liquidity) > 0n && BigInt(point.sqrtPriceX96) > 0n);
  if (first < 0) return result;
  const entryBlock = pool.states[first].blockNumber + delay;
  let cursor = first, state = pool.states[first];
  while (cursor + 1 < pool.states.length && pool.states[cursor + 1].blockNumber <= entryBlock) state = pool.states[++cursor];
  const entryDepth = market(pool, state, costs), swapGas = costs.swapGasUnits * costs.gasPriceUsdPerUnit;
  result.gasUsd += swapGas;
  if (!entryDepth) return { ...result, exitReason: 'entry_no_liquidity', netUsd: -result.gasUsd };
  const buyTax = security.buyTax ?? (unknown === 'conservative' ? 1 : 0);
  const sellTax = security.sellTax ?? (unknown === 'conservative' ? 1 : 0);
  const honeypot = security.honeypot ?? unknown === 'conservative';
  const quantity = buyFill(entryDepth, costs.stakeUsd, buyTax, costs.slippageBps);
  const entryTimestamp = state.timestamp + (entryBlock - state.blockNumber) * blockSeconds;
  if (costs.captureToTimestamp !== undefined && entryTimestamp + 1200 + costs.exitDelayBlocks * blockSeconds > costs.captureToTimestamp) {
    return { ...result, gasUsd: 0, exitReason: 'incomplete_horizon' };
  }
  result.entered = true;
  result.spentUsd = costs.stakeUsd;
  result.entryBlock = entryBlock;
  result.entryTimestamp = entryTimestamp;
  result.fills.push({ side: 'buy', blockNumber: entryBlock, quantity, usd: costs.stakeUsd });
  if (!(quantity > 0)) return { ...result, exitReason: 'buy_tax_consumed_position', netUsd: -result.spentUsd - result.gasUsd };
  const entryPrice = costs.stakeUsd / quantity;
  let remaining = quantity, high = entryPrice, takeProfitFilled = false;
  // Taxes or a thin pool can put the received position below its stop immediately.
  let pending = entryDepth.price <= entryPrice * 0.5
    ? { reason: 'stop_loss', blockNumber: entryBlock + costs.exitDelayBlocks } : null;
  const deadlineBlock = entryBlock + Math.ceil(1200 / blockSeconds);
  let block = entryBlock, approved = false, deadlineProcessed = false;
  while (remaining > 0) {
    const nextEventBlock = pool.states[cursor + 1]?.blockNumber ?? Infinity;
    block = Math.min(nextEventBlock, pending?.blockNumber ?? Infinity, deadlineProcessed ? Infinity : deadlineBlock);
    if (block >= deadlineBlock) deadlineProcessed = true;
    const trailingWasActive = takeProfitFilled;
    const observations = [];
    while (cursor + 1 < pool.states.length && pool.states[cursor + 1].blockNumber <= block) {
      state = pool.states[++cursor];
      const depth = market(pool, state, costs);
      if (depth) {
        high = Math.max(high, depth.price);
        observations.push({ price: depth.price, high });
      }
    }
    if (pending?.blockNumber === block) {
      if (!approved) { result.gasUsd += costs.approvalGasUnits * costs.gasPriceUsdPerUnit; approved = true; }
      result.gasUsd += swapGas;
      const depth = market(pool, state, costs);
      if (honeypot || !depth) {
        result.failedExits++;
        result.exitReason = honeypot ? 'honeypot' : 'liquidity_disappeared';
        result.fills.push({ side: 'failed_sell', blockNumber: block, reason: result.exitReason, quantity: remaining, usd: 0 });
        // This first slice makes one attempt; a failed liquidation writes off the remainder.
        break;
      }
      const soldQuantity = pending.reason === 'take_profit' ? Math.min(quantity * policy.fraction, remaining) : remaining;
      const proceeds = sellFill(depth, soldQuantity, sellTax, costs.slippageBps);
      result.proceedsUsd += proceeds;
      result.fills.push({ side: 'sell', reason: pending.reason, blockNumber: block, quantity: soldQuantity, usd: proceeds });
      remaining = Math.max(0, remaining - soldQuantity);
      result.exitReason = pending.reason;
      if (pending.reason === 'take_profit') takeProfitFilled = true;
      pending = null;
      if (!remaining) break;
    }
    if (pending) continue;
    const latestDepth = market(pool, state, costs);
    const prices = observations.length ? observations : latestDepth ? [{ price: latestDepth.price, high }] : [];
    let reason = null;
    if (prices.some(point => point.price <= entryPrice * 0.5)) reason = 'stop_loss';
    else if (takeProfitFilled && (trailingWasActive ? prices.some(point => point.price <= point.high * (policy.trailingAthFraction ?? 0.9))
      : latestDepth && latestDepth.price <= high * (policy.trailingAthFraction ?? 0.9))) reason = 'trailing_stop';
    else if (block >= deadlineBlock) reason = 'time_stop';
    else if (!takeProfitFilled && prices.some(point => point.price >= entryPrice * policy.multiple)) reason = 'take_profit';
    if (reason) pending = { reason, blockNumber: block + costs.exitDelayBlocks };
  }
  result.netUsd = result.proceedsUsd - result.spentUsd - result.gasUsd;
  return result;
}

export function summarizeTrades(cohort, delay, policyName) {
  const entered = cohort.filter(trade => trade.entered);
  const total = key => cohort.reduce((sum, trade) => sum + trade[key], 0);
  const reasons = {};
  for (const trade of cohort) reasons[trade.exitReason] = (reasons[trade.exitReason] ?? 0) + 1;
  return { delayBlocks: delay, policy: policyName, discovered: cohort.length, entered: entered.length,
    unentered: cohort.length - entered.length, spentUsd: total('spentUsd'), proceedsUsd: total('proceedsUsd'), gasUsd: total('gasUsd'),
    netUsd: total('netUsd'), conservativeNetUsd: total('conservativeNetUsd'), evPerEntryUsd: entered.length ? total('netUsd') / entered.length : null,
    winRate: entered.length ? entered.filter(trade => trade.netUsd > 0).length / entered.length : null,
    failedExits: total('failedExits'), securityUnknown: entered.filter(trade => trade.securityUnknown).length, exitReasons: reasons };
}

export function runMatrix(dataset, snapshots, costs = DEFAULT_COSTS, { delays = DELAYS, policies = POLICIES, entryFeatures = [] } = {}) {
  costs = { ...DEFAULT_COSTS, ...costs, captureToTimestamp: dataset.manifest.captureToTimestamp };
  const rows = [], trades = [];
  const featuresByEntry = new Map(entryFeatures.map(feature => [`${feature.token}:${feature.delayBlocks}`, feature]));
  for (const delay of delays) for (const policy of policies) {
    const cohort = dataset.pools.map(pool => {
      const security = normalizeSecurity(snapshots[pool.token]?.data);
      const main = replay(pool, security, delay, policy, dataset.manifest.blockSeconds, costs);
      const conservative = main.securityUnknown ? replay(pool, security, delay, policy, dataset.manifest.blockSeconds, costs, 'conservative') : main;
      const feature = featuresByEntry.get(`${pool.token}:${delay}`);
      return { ...main, conservativeNetUsd: conservative.netUsd, ...(feature ? { entryFeatureKey: `${pool.token}:${delay}` } : {}) };
    });
    trades.push(...cohort);
    rows.push(summarizeTrades(cohort, delay, policy.name));
  }
  return { rows, trades };
}
