import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ZERO = '0x0000000000000000000000000000000000000000';
const protocol = pool => pool.protocol ?? (pool.venue === 'Uniswap v4' ? 'v4' : pool.venue === 'Uniswap v3' ? 'v3' : null);
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const hex = value => `0x${value.toString(16)}`;
const address = topic => `0x${topic.slice(-40)}`.toLowerCase();
const integer = value => { try { return value === undefined || value === null || value === '0x' ? null : BigInt(value); } catch (error) { if (error instanceof SyntaxError) return null; throw error; } };
const finite = value => Number.isFinite(value) ? value : null;
const order = (a, b) => a.blockNumber - b.blockNumber || a.transactionIndex - b.transactionIndex || a.logIndex - b.logIndex;

export function entryCutoff(pool, delayBlocks) {
  const first = pool.states.find(state => BigInt(state.liquidity) > 0n && BigInt(state.sqrtPriceX96) > 0n);
  return first ? first.blockNumber + delayBlocks : null;
}

function reserves(state, tokenIs0, quoteDecimals) {
  const sqrt = Number(BigInt(state.sqrtPriceX96)) / 2 ** 96, liquidity = Number(BigInt(state.liquidity));
  if (!(sqrt > 0)) return null;
  const token = tokenIs0 ? liquidity / sqrt : liquidity * sqrt;
  const quote = (tokenIs0 ? liquidity * sqrt : liquidity / sqrt) / 10 ** quoteDecimals;
  const price = tokenIs0 ? sqrt * sqrt / 10 ** quoteDecimals : 1 / (sqrt * sqrt * 10 ** quoteDecimals);
  return { token, quote, price, sqrt };
}

/** LP principal excludes accrued fees and is distinct from active virtual reserves. */
function principal(states, state, pool) {
  const positions = new Map();
  for (const point of states) {
    const args = point.eventData;
    if (!args || !['Mint', 'Burn', 'ModifyLiquidity'].includes(point.event)) continue;
    const key = [args.owner ?? args.sender, args.tickLower, args.tickUpper, args.salt ?? ''].join(':');
    const delta = point.event === 'ModifyLiquidity' ? BigInt(args.liquidityDelta) : BigInt(args.amount) * (point.event === 'Burn' ? -1n : 1n);
    positions.set(key, { lower: Number(args.tickLower), upper: Number(args.tickUpper), liquidity: (positions.get(key)?.liquidity ?? 0n) + delta });
  }
  const sqrt = Number(BigInt(state.sqrtPriceX96)) / 2 ** 96;
  let amount0 = 0, amount1 = 0;
  for (const position of positions.values()) {
    const low = 1.0001 ** (position.lower / 2), high = 1.0001 ** (position.upper / 2), liquidity = Number(position.liquidity);
    const clipped = Math.max(low, Math.min(high, sqrt));
    amount0 += liquidity * (high - clipped) / (clipped * high);
    amount1 += liquidity * (clipped - low);
  }
  return { token: pool.tokenIs0 ? amount0 : amount1, quote: (pool.tokenIs0 ? amount1 : amount0) / 10 ** pool.quoteDecimals, count: [...positions.values()].filter(position => position.liquidity > 0n).length };
}

/** All observations end at entry's block, before the simulated purchase. */
export function derivePoolEntryFeature(pool, delayBlocks, { transfers = [], supplyRaw = null, decimals = null, completeTransferHistory = false, metadataStatus = 'unavailable', blockSeconds = 2 } = {}) {
  const entryBlock = entryCutoff(pool, delayBlocks);
  const base = { token: pool.token, pool: pool.id, delayBlocks, entryBlock, cutoff: 'end_of_entry_block_before_simulated_buy', venue: pool.protocol ?? pool.venue,
    tokenDecimals: decimals, totalSupplyRaw: supplyRaw === null ? null : String(supplyRaw), metadataStatus,
    holderCount: null, top1HolderShare: null, top10HolderShare: null, initialMintRecipientShare: null,
    holderHistoryStatus: completeTransferHistory ? 'complete_from_predeployment_block' : 'unavailable_incomplete_token_history' };
  if (entryBlock === null) return { ...base, featureStatus: 'never_funded' };
  const states = pool.states.filter(state => state.blockNumber <= entryBlock), state = states.at(-1), depth = reserves(state, pool.tokenIs0, pool.quoteDecimals);
  const observedTransfers = transfers.filter(transfer => transfer.blockNumber <= entryBlock);
  const transfersByTransaction = new Map();
  for (const transfer of observedTransfers) {
    const list = transfersByTransaction.get(transfer.transactionHash) ?? [];
    list.push(transfer); transfersByTransaction.set(transfer.transactionHash, list);
  }
  const custody = (protocol(pool) === 'v4' ? MANAGER : pool.id).toLowerCase();
  const sellers = new Set(), routers = new Set(), attributedTransactions = new Set();
  let buys = 0, sells = 0, buyVolume = 0, sellVolume = 0, attributedSells = 0;
  const swaps = states.filter(point => point.event === 'Swap');
  for (const swap of swaps) {
    const args = swap.eventData;
    if (!args || args.amount0 === undefined || args.amount1 === undefined) continue;
    const tokenAmount = BigInt(pool.tokenIs0 ? args.amount0 : args.amount1);
    const quoteAmount = Number(BigInt(pool.tokenIs0 ? args.amount1 : args.amount0)) / 10 ** pool.quoteDecimals;
    const sell = protocol(pool) === 'v4' ? tokenAmount < 0n : tokenAmount > 0n;
    if (sell) {
      sells++; sellVolume += Math.abs(quoteAmount);
      if (args.sender) routers.add(args.sender.toLowerCase());
      const payers = (transfersByTransaction.get(swap.transactionHash) ?? []).filter(transfer => transfer.to === custody && transfer.from !== custody && transfer.from !== ZERO && BigInt(transfer.value) > 0n);
      if (payers.length) { attributedSells++; attributedTransactions.add(swap.transactionHash); }
      for (const transfer of payers) sellers.add(transfer.from);
    } else { buys++; buyVolume += Math.abs(quoteAmount); }
  }
  const inventory = principal(states, state, pool);
  const firstDepth = reserves(states.find(point => BigInt(point.liquidity) > 0n) ?? state, pool.tokenIs0, pool.quoteDecimals);
  const supply = integer(supplyRaw), holders = new Map();
  let initialMintRecipient = null;
  if (completeTransferHistory) {
    for (const transfer of observedTransfers) {
      const value = BigInt(transfer.value);
      if (transfer.from === ZERO && initialMintRecipient === null && value > 0n) initialMintRecipient = transfer.to;
      if (transfer.from !== ZERO) holders.set(transfer.from, (holders.get(transfer.from) ?? 0n) - value);
      if (transfer.to !== ZERO) holders.set(transfer.to, (holders.get(transfer.to) ?? 0n) + value);
    }
    if ([...holders.values()].some(value => value < 0n)) base.holderHistoryStatus = 'unavailable_nonstandard_transfer_accounting';
    else {
      // Custody balances are retained in the ledger, but concentration describes outside wallets.
      const balances = [...holders.entries()].filter(([owner, value]) => owner !== custody && value > 0n).map(([, value]) => value).sort((a, b) => a > b ? -1 : a < b ? 1 : 0);
      base.holderCount = balances.length;
      if (supply !== null && supply > 0n) {
        base.top1HolderShare = Number(balances[0] ?? 0n) / Number(supply);
        base.top10HolderShare = Number(balances.slice(0, 10).reduce((sum, value) => sum + value, 0n)) / Number(supply);
        base.initialMintRecipientShare = initialMintRecipient === null ? null : Number(holders.get(initialMintRecipient) ?? 0n) / Number(supply);
      }
    }
  }
  const feature = { ...base, featureStatus: 'available', entryTimestamp: state.timestamp + (entryBlock - state.blockNumber) * blockSeconds, stateBlock: state.blockNumber,
    poolAgeBlocks: entryBlock - pool.creationBlock, activeLiquidityRaw: state.liquidity,
    activeVirtualQuoteReserveUsd: finite(depth?.quote), activeVirtualTokenReserveRaw: finite(depth?.token),
    estimatedTradableDepthUsd: finite(depth?.quote), stakeToDepthRatio: depth?.quote > 0 ? finite(2 / depth.quote) : null,
    poolQuotePrincipalUsd: finite(inventory.quote), poolTokenPrincipalRaw: finite(inventory.token),
    poolSizeUsd: depth ? finite(inventory.quote + inventory.token * depth.price) : null,
    poolSizeMethod: 'concentrated_liquidity_position_principal_excluding_fees', activePositionCount: inventory.count,
    priceUsdPerRawToken: finite(depth?.price), priceUsdPerToken: decimals !== null && depth ? finite(depth.price * 10 ** decimals) : null,
    marketCapUsd: supply !== null && depth ? finite(Number(supply) * depth.price) : null, marketCapMethod: 'total_supply_times_spot_price',
    observedPoolFeePips: state.feePips < 1_000_000 ? state.feePips : null, dynamicFee: pool.feePips >= 1_000_000,
    hooks: pool.hooks ?? ZERO, hasHooks: Boolean(pool.hooks && pool.hooks.toLowerCase() !== ZERO),
    priorSwapCount: swaps.length, priorBuyCount: buys, priorSellCount: sells,
    priorBuyVolumeUsd: buyVolume, priorSellVolumeUsd: sellVolume,
    priorSuccessfulSellers: sellers.size, attributedSellSwaps: attributedSells, attributedSellTransactions: attributedTransactions.size, priorSellRouterCount: routers.size,
    sellerEvidence: 'token_transfer_payers_into_pool_in_successful_sell_swap_transaction',
    sellerAttributionCoverage: sells ? attributedSells / sells : 1,
    priceChangeSinceFirstLiquidity: depth && firstDepth?.price > 0 ? finite(depth.price / firstDepth.price - 1) : null };
  return feature;
}

/** Historical RPC inputs are disposable cache; no current holder snapshots enter features. */
export async function deriveEntryFeatures(dataset, { delays = [4, 6, 8], rpcUrl = 'https://rpc.mainnet.arc.io', cacheDirectory, metadataRpcUrl = rpcUrl, onProgress = () => {}, requestIntervalMs = 1000 } = {}) {
  if (!cacheDirectory) throw new TypeError('cacheDirectory is required');
  if (!(dataset.manifest.eventDataThroughDelayBlocks >= Math.max(...delays))) throw new Error('Entry features require decoded historical event payloads through every requested delay');
  await mkdir(cacheDirectory, { recursive: true });
  const nextRequestAt = new Map();
  let requests = 0, hits = 0;
  const cachedRequest = async calls => {
    const key = createHash('sha256').update(JSON.stringify(calls)).digest('hex'), path = join(cacheDirectory, `${key}.json`);
    try { const result = JSON.parse(await readFile(path, 'utf8')); hits++; return result; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const accumulated = new Array(calls.length);
    for (let attempt = 0; ; attempt++) {
      const endpoint = calls[0].method === 'eth_getLogs' ? rpcUrl : metadataRpcUrl;
      const wait = Math.max(0, (nextRequestAt.get(endpoint) ?? 0) - Date.now());
      nextRequestAt.set(endpoint, Date.now() + wait + requestIntervalMs);
      if (wait) await sleep(wait);
      try {
        const pending = calls.map((call, id) => ({ jsonrpc: '2.0', id, ...call })).filter(call => !accumulated[call.id]);
        const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(pending), signal: AbortSignal.timeout(25_000) });
        requests++;
        if (!response.ok) { const error = new Error(`Feature RPC HTTP ${response.status}`); error.retryable = response.status === 429 || response.status >= 500; throw error; }
        const body = await response.json();
        if (!Array.isArray(body) || body.length !== pending.length) throw new Error('Feature RPC returned an incomplete batch');
        const byId = new Map(body.map(item => [item.id, item]));
        let transient;
        for (const call of pending) {
          const item = byId.get(call.id);
          if (!item) throw new Error('Feature RPC returned incomplete batch IDs');
          if (item.error && /rate|too many requests|timeout|temporar|busy|capacity/i.test(item.error.message)) transient = item;
          else accumulated[call.id] = item;
        }
        if (transient) { const error = new Error(`Feature RPC temporary failure ${transient.error.code}`); error.retryable = true; throw error; }
        const result = accumulated;
        await writeFile(`${path}.tmp`, JSON.stringify(result)); await rename(`${path}.tmp`, path);
        return result;
      } catch (error) {
        if (!(error.retryable || error instanceof TypeError || ['TimeoutError', 'AbortError'].includes(error.name)) || attempt >= 4) throw error;
        await sleep(1000 * 2 ** attempt);
      }
    }
  };
  const funded = dataset.pools.filter(pool => entryCutoff(pool, Math.max(...delays)) !== null);
  const groups = new Map();
  for (const pool of funded) {
    const bucket = Math.floor(pool.creationBlock / 2000) * 2000;
    const group = groups.get(bucket) ?? []; group.push(pool); groups.set(bucket, group);
  }
  const transfersByToken = new Map(), metadata = new Map();
  const calls = [], slots = [];
  for (const [bucket, pools] of groups) for (const pool of pools) {
    const targets = [['code', 'eth_getCode', [pool.token, hex(bucket - 1)]], ['decimals', 'eth_call', [{ to: pool.token, data: '0x313ce567' }, hex(entryCutoff(pool, Math.min(...delays)))]]];
    for (const delay of delays) targets.push([`supply:${delay}`, 'eth_call', [{ to: pool.token, data: '0x18160ddd' }, hex(entryCutoff(pool, delay))]]);
    for (const [field, method, params] of targets) { slots.push({ token: pool.token, field }); calls.push({ method, params }); }
  }
  const loadMetadata = async () => {
    // Reuse successful larger batches captured before reducing the provider's burst size.
    const earlierResults = new Map();
    for (let index = 0; index < calls.length; index += 100) {
      const key = createHash('sha256').update(JSON.stringify(calls.slice(index, index + 100))).digest('hex');
      try {
        const result = JSON.parse(await readFile(join(cacheDirectory, `${key}.json`), 'utf8'));
        result.forEach((item, offset) => earlierResults.set(index + offset, item));
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    for (let index = 0; index < calls.length; index += 10) {
      const count = Math.min(10, calls.length - index);
      const cached = Array.from({ length: count }, (_, offset) => earlierResults.get(index + offset));
      const result = cached.every(Boolean) ? (hits++, cached) : await cachedRequest(calls.slice(index, index + count));
      result.forEach((item, offset) => { const slot = slots[index + offset], values = metadata.get(slot.token) ?? {}; values[slot.field] = item.error ? null : item.result; metadata.set(slot.token, values); });
      onProgress({ stage: 'feature_metadata', completed: index + count, total: calls.length, requests, cacheHits: hits });
    }
  };
  const transferLogs = async (addresses, first, last) => {
    const [response] = await cachedRequest([{ method: 'eth_getLogs', params: [{ address: addresses, fromBlock: hex(first), toBlock: hex(last), topics: [TRANSFER] }] }]);
    if (!response.error) return response.result;
    if (/range|limit|response size/i.test(response.error.message)) {
      if (addresses.length > 1) {
        const middle = Math.ceil(addresses.length / 2);
        return [...await transferLogs(addresses.slice(0, middle), first, last), ...await transferLogs(addresses.slice(middle), first, last)];
      }
      if (first < last) {
        const middle = Math.floor((first + last) / 2);
        return [...await transferLogs(addresses, first, middle), ...await transferLogs(addresses, middle + 1, last)];
      }
    }
    throw new Error(`Entry Transfer query failed ${response.error.code}: ${response.error.message}`);
  };
  const loadTransfers = async () => {
  let completed = 0;
  for (const [bucket, pools] of groups) {
    for (let index = 0; index < pools.length; index += 50) {
      const cohort = pools.slice(index, index + 50), last = Math.max(...cohort.map(pool => entryCutoff(pool, Math.max(...delays))));
      const logs = [];
      for (let first = bucket; first <= last; first += 5000) {
        logs.push(...await transferLogs(cohort.map(pool => pool.token), first, Math.min(first + 4999, last)));
      }
      for (const pool of cohort) transfersByToken.set(pool.token, []);
      for (const log of logs) {
        if (log.removed) throw new Error('Removed historical Transfer log');
        if (log.topics.length !== 3) continue;
        transfersByToken.get(log.address.toLowerCase())?.push({ from: address(log.topics[1]), to: address(log.topics[2]), value: BigInt(log.data).toString(), transactionHash: log.transactionHash,
          blockNumber: Number(BigInt(log.blockNumber)), transactionIndex: Number(BigInt(log.transactionIndex)), logIndex: Number(BigInt(log.logIndex)) });
      }
    }
    completed++;
    onProgress({ stage: 'feature_transfers', completed, total: groups.size, requests, cacheHits: hits });
  }
  };
  await Promise.all([loadMetadata(), loadTransfers()]);
  return dataset.pools.flatMap(pool => delays.map(delay => {
    const values = metadata.get(pool.token), supply = integer(values?.[`supply:${delay}`]), decimal = integer(values?.decimals);
    const decimals = decimal !== null && decimal <= 255n ? Number(decimal) : null;
    return derivePoolEntryFeature(pool, delay, { transfers: (transfersByToken.get(pool.token) ?? []).sort(order), supplyRaw: supply, decimals,
      completeTransferHistory: values?.code === '0x', blockSeconds: dataset.manifest.blockSeconds, metadataStatus: supply !== null && decimals !== null ? 'historical_rpc' : 'unavailable_historical_call' });
  }));
}
