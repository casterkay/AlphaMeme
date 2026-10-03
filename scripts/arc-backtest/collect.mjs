import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { decodeEventLog, parseAbi, toEventSelector } from 'viem';
import { POOL_SOURCES } from '../../src/providers/chain-logs.mjs';

const SOURCE = POOL_SOURCES.arc;
const ZERO = '0x0000000000000000000000000000000000000000';
export const EVENT_ABIS = Object.freeze({
  v4: parseAbi([
    'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
    'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
    'event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)'
  ]),
  v3Factory: parseAbi(['event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)']),
  v3: parseAbi([
    'event Initialize(uint160 sqrtPriceX96, int24 tick)',
    'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
    'event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)',
    'event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)'
  ])
});
const topicsFor = abi => abi.map(toEventSelector);
const hex = number => `0x${number.toString(16)}`;
const compareLogs = (a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) || Number(BigInt(a.transactionIndex) - BigInt(b.transactionIndex)) || Number(BigInt(a.logIndex) - BigInt(b.logIndex));

class RpcError extends Error {
  constructor(code, { retryable = false, rangeLimited = false, detail = '' } = {}) {
    super(`Arc RPC ${code}${detail ? `: ${detail.replace(/https?:\/\/\S+/g, '[RPC URL]')}` : ''}`);
    Object.assign(this, { name: 'RpcError', retryable, rangeLimited });
  }
}

/** Decode known Arc registry events; incoming logs remain unchanged. */
export function decodeArcEvent(log, abi) {
  if (log.removed) throw new Error('Removed log in historical Arc dataset');
  return decodeEventLog({ abi, topics: log.topics, data: log.data, strict: true });
}

/** Replay active liquidity only; Swap reports the canonical liquidity after tick crossings. */
export function advancePoolState(previous, event, feePips) {
  const { eventName, args } = event;
  if (eventName === 'Initialize') return { sqrtPriceX96: args.sqrtPriceX96.toString(), liquidity: '0', tick: Number(args.tick), feePips: Number(args.fee ?? feePips) };
  if (!previous) throw new Error(`Pool ${eventName} precedes initialization`);
  if (eventName === 'Swap') return { sqrtPriceX96: args.sqrtPriceX96.toString(), liquidity: args.liquidity.toString(), tick: Number(args.tick), feePips: Number(args.fee ?? previous.feePips) };
  const delta = eventName === 'ModifyLiquidity' ? args.liquidityDelta : eventName === 'Burn' ? -args.amount : args.amount;
  const active = Number(args.tickLower) <= previous.tick && previous.tick < Number(args.tickUpper);
  const liquidity = BigInt(previous.liquidity) + (active ? delta : 0n);
  if (liquidity < 0n) throw new Error('Active pool liquidity became negative');
  return { ...previous, liquidity: liquidity.toString() };
}

/** Preserve transaction details through the largest supported entry delay, not the full holding history. */
export function derivePoolStates(pool, logs, timestampFor) {
  const states = [];
  let previous, firstFundedBlock;
  for (const log of logs) {
    const event = decodeArcEvent(log, EVENT_ABIS[pool.protocol]);
    previous = advancePoolState(previous, event, pool.feePips);
    const blockNumber = Number(BigInt(log.blockNumber));
    if (firstFundedBlock === undefined && BigInt(previous.liquidity) > 0n) firstFundedBlock = blockNumber;
    const eventData = firstFundedBlock === undefined || blockNumber <= firstFundedBlock + 20
      ? Object.fromEntries(Object.entries(event.args).map(([name, value]) => [name, typeof value === 'bigint' ? value.toString() : value])) : undefined;
    states.push({ ...previous, blockNumber, timestamp: timestampFor(log), transactionHash: log.transactionHash,
      transactionIndex: Number(BigInt(log.transactionIndex)), logIndex: Number(BigInt(log.logIndex)), event: event.eventName,
      ...(eventData ? { eventData } : {}) });
  }
  return states;
}

async function mapConcurrent(items, operation, concurrency = 3) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await operation(items[index]);
    }
  }));
  return results;
}

/** Collect the earliest quote-paired pool per token created inside the requested UTC-second window. */
export async function collectArc({ rpcUrl = 'https://rpc.mainnet.arc.io', fromTimestamp, toTimestamp, cacheDirectory, onProgress = () => {}, capturedManifest }) {
  if (!Number.isFinite(fromTimestamp) || !Number.isFinite(toTimestamp) || fromTimestamp >= toTimestamp || !cacheDirectory) throw new TypeError('A valid discovery window and cacheDirectory are required');
  await mkdir(cacheDirectory, { recursive: true });
  let requestCount = 0, cacheHits = 0;
  let nextRequestAt = 0;
  const rpc = async (method, params) => {
    if (capturedManifest) throw new Error(`Missing cached Arc input for offline reconstruction: ${method}`);
    for (let attempt = 0; ; attempt++) {
      try {
        const waitMs = Math.max(0, nextRequestAt - Date.now());
        nextRequestAt = Date.now() + waitMs + 1000;
        if (waitMs) await sleep(waitMs);
        requestCount++;
        const response = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(25_000) });
        if (!response.ok) throw new RpcError(`HTTP_${response.status}`, { retryable: response.status === 429 || response.status >= 500 });
        const body = await response.json();
        if (body.error) {
          const message = String(body.error.message);
          const throttled = /rate|compute units|requests per|too many requests|throttl|capacity/i.test(message);
          throw new RpcError(body.error.code, { detail: message, rangeLimited: !throttled && /range|limit|too many|exceed|response size/i.test(message), retryable: throttled || /busy|timeout|temporar/i.test(message) });
        }
        if (!Object.hasOwn(body, 'result')) throw new RpcError('MISSING_RESULT');
        return body.result;
      } catch (error) {
        const transient = error instanceof RpcError ? error.retryable : error instanceof TypeError || error.name === 'TimeoutError' || error.name === 'AbortError';
        if (!transient || attempt >= 4) {
          if (error instanceof RpcError) throw error;
          if (transient) throw new RpcError('NETWORK_OR_TIMEOUT');
          throw error;
        }
        await sleep(1000 * 2 ** attempt);
      }
    }
  };
  const chainId = capturedManifest?.chainId ?? Number(BigInt(await rpc('eth_chainId', [])));
  if (chainId !== 5042) throw new Error(`Expected Arc chain 5042, received ${chainId}`);
  const headers = new Map();
  const header = async number => {
    if (!headers.has(number)) {
      const block = await rpc('eth_getBlockByNumber', [hex(number), false]);
      if (!block) throw new Error(`Arc block ${number} unavailable`);
      headers.set(number, { number, timestamp: Number(BigInt(block.timestamp)), hash: block.hash, baseFeePerGas: block.baseFeePerGas });
    }
    return headers.get(number);
  };
  const headNumber = capturedManifest?.captureToBlock ?? Number(BigInt(await rpc('eth_blockNumber', [])));
  const head = capturedManifest
    ? { number: headNumber, timestamp: capturedManifest.captureToTimestamp, baseFeePerGas: capturedManifest.sampledBaseFeePerGas }
    : await header(headNumber);
  const sample = capturedManifest ? null : await header(Math.max(0, headNumber - 10_000));
  const blockSeconds = capturedManifest?.blockSeconds ?? (head.timestamp - sample.timestamp) / (headNumber - sample.number);
  const boundary = async timestamp => {
    if (timestamp > head.timestamp) throw new Error('Requested discovery or follow-up window exceeds Arc head');
    let low = await header(0), high = head;
    if (timestamp <= low.timestamp) return 0;
    while (high.number - low.number > 1) {
      const estimate = low.number + (timestamp - low.timestamp) * (high.number - low.number) / (high.timestamp - low.timestamp);
      const middle = await header(Math.max(low.number + 1, Math.min(high.number - 1, Math.floor(estimate))));
      if (middle.timestamp < timestamp) low = middle;
      else high = middle;
    }
    return high.number;
  };
  const boundaryPath = join(cacheDirectory, `${createHash('sha256').update(JSON.stringify({ chainId, fromTimestamp, toTimestamp })).digest('hex')}.bounds`);
  let boundaries;
  try { boundaries = JSON.parse(await readFile(boundaryPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!boundaries) {
    const fromBlock = await boundary(fromTimestamp), toBlock = (await boundary(toTimestamp)) - 1;
    const followUpSeconds = 20 * 60 + Math.ceil(20 * blockSeconds) + 30;
    const captureToBlock = (await boundary(toTimestamp + followUpSeconds)) - 1;
    boundaries = { fromBlock, toBlock, captureToBlock, followUpSeconds, startHeader: await header(fromBlock), endHeader: await header(captureToBlock) };
    await writeFile(`${boundaryPath}.${process.pid}.tmp`, JSON.stringify(boundaries));
    await rename(`${boundaryPath}.${process.pid}.tmp`, boundaryPath);
  }
  const { fromBlock, toBlock, captureToBlock, followUpSeconds, startHeader, endHeader } = boundaries;
  const timestampFor = log => log.blockTimestamp ? Number(BigInt(log.blockTimestamp)) : startHeader.timestamp + (Number(BigInt(log.blockNumber)) - fromBlock) * (endHeader.timestamp - startHeader.timestamp) / (captureToBlock - fromBlock);
  const readLogs = async (filter, start, end) => {
    const key = createHash('sha256').update(JSON.stringify({ chainId, filter, start, end })).digest('hex');
    const path = join(cacheDirectory, `${key}.json`);
    try {
      const cached = JSON.parse(await readFile(path, 'utf8'));
      if (!Array.isArray(cached)) throw new Error('Invalid Arc log cache');
      cacheHits++;
      return cached;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    let logs;
    try {
      logs = await rpc('eth_getLogs', [{ ...filter, fromBlock: hex(start), toBlock: hex(end) }]);
    } catch (error) {
      if (!(error instanceof RpcError) || !error.rangeLimited) throw error;
      if (start === end) throw new Error(`${error.message}; block ${start}; filter ${JSON.stringify(filter)}`);
      const middle = Math.floor((start + end) / 2);
      logs = [...await readLogs(filter, start, middle), ...await readLogs(filter, middle + 1, end)];
    }
    if (!Array.isArray(logs)) throw new RpcError('INVALID_LOGS');
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(logs));
    await rename(temporary, path);
    return logs;
  };
  const ranges = (start, end) => {
    const items = [];
    for (let block = start; block <= end; block += 5000) items.push([block, Math.min(end, block + 4999)]);
    return items;
  };
  const discoveryFilter = { address: SOURCE.factories.map(item => item.address), topics: [[toEventSelector(EVENT_ABIS.v4[0]), toEventSelector(EVENT_ABIS.v3Factory[0])]] };
  let discoveryComplete = 0;
  const discoveryRanges = ranges(fromBlock, toBlock);
  const discoveryLogs = (await mapConcurrent(discoveryRanges, async ([start, end]) => {
    const logs = await readLogs(discoveryFilter, start, end);
    onProgress({ stage: 'discovery', completed: ++discoveryComplete, total: discoveryRanges.length, logs: logs.length, requestCount, cacheHits });
    return logs;
  })).flat().sort(compareLogs);
  const pools = [], seenTokens = new Set();
  let nonQuotePools = 0, duplicateTokenPools = 0;
  for (const log of discoveryLogs) {
    const factory = SOURCE.factories.find(item => item.address === log.address.toLowerCase());
    const { args } = decodeArcEvent(log, factory.event === 'v4' ? EVENT_ABIS.v4 : EVENT_ABIS.v3Factory);
    const token0 = (args.currency0 ?? args.token0).toLowerCase(), token1 = (args.currency1 ?? args.token1).toLowerCase();
    const quote0 = SOURCE.quotes.includes(token0), quote1 = SOURCE.quotes.includes(token1);
    if (quote0 === quote1) { nonQuotePools++; continue; }
    const token = quote0 ? token1 : token0;
    if (seenTokens.has(token)) { duplicateTokenPools++; continue; }
    seenTokens.add(token);
    const quoteToken = quote0 ? token0 : token1;
    const id = (args.id ?? args.pool).toLowerCase();
    pools.push({ id, venue: factory.venue, token, quoteToken, quoteDecimals: quoteToken === ZERO ? 18 : 6, tokenIs0: !quote0,
      feePips: Number(args.fee), hooks: args.hooks?.toLowerCase() ?? ZERO, creationBlock: Number(BigInt(log.blockNumber)), creationTimestamp: timestampFor(log), states: [], protocol: factory.event });
  }
  const eventsByPool = new Map(pools.map(pool => [pool.id, []]));
  for (const log of discoveryLogs) if (eventsByPool.has(log.topics[1]) && log.address.toLowerCase() === SOURCE.factories.find(factory => factory.event === 'v4').address) eventsByPool.get(log.topics[1]).push(log);
  const manager = SOURCE.factories.find(factory => factory.event === 'v4').address;
  const captureRanges = ranges(fromBlock, captureToBlock);
  let eventComplete = 0;
  await mapConcurrent(captureRanges, async ([start, end]) => {
    // One manager query per range avoids repeatedly scanning it for thousands of new pool IDs.
    const managerLogs = await readLogs({ address: manager, topics: [topicsFor(EVENT_ABIS.v4.slice(1))] }, start, end);
    for (const log of managerLogs) if (eventsByPool.has(log.topics[1])) eventsByPool.get(log.topics[1]).push(log);
    // Arc's public node rejects large address arrays even at a single block; topics keep this query narrow.
    const poolLogs = await readLogs({ topics: [topicsFor(EVENT_ABIS.v3)] }, start, end);
    for (const log of poolLogs) if (eventsByPool.has(log.address.toLowerCase())) eventsByPool.get(log.address.toLowerCase()).push(log);
    onProgress({ stage: 'events', completed: ++eventComplete, total: captureRanges.length, requestCount, cacheHits });
  });
  for (const pool of pools) {
    const logs = eventsByPool.get(pool.id).sort(compareLogs);
    pool.states = derivePoolStates(pool, logs, timestampFor);
    delete pool.protocol;
  }
  const fundedPools = pools.filter(pool => pool.states.some(state => BigInt(state.liquidity) > 0n)).length;
  return { version: 1, manifest: { chainId, fromBlock, toBlock, captureToBlock, fromTimestamp, toTimestamp, captureToTimestamp: endHeader.timestamp,
    blockSeconds, followUpSeconds, fromBlockHash: startHeader.hash, captureToBlockHash: endHeader.hash, sampledBaseFeePerGas: head.baseFeePerGas,
    timestampSource: 'RPC log blockTimestamp; interpolated only when absent', eventDataThroughDelayBlocks: 20, scope: 'Earliest native-USDC or ERC20-USDC paired pool per token created in window, across the two configured Arc Uniswap v3/v4 factories; not token deployment or pre-migration curves',
    discoveryLogs: discoveryLogs.length, nonQuotePools, duplicateTokenPools, pools: pools.length, fundedPools, noFundedPools: pools.length - fundedPools, requestCount, cacheHits }, pools };
}
