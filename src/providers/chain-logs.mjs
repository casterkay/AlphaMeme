// New-pool discovery from the chains' own logs: one eth_getLogs over the pinned
// pool factories per scan, through the chain's RPC URL (the one trading uses).
// Read-only; the URL, which may hold a provider key, never reaches a log or error.

const ZERO = '0x0000000000000000000000000000000000000000';
const TOPICS = Object.freeze({
  // UniswapV3Factory PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)
  v3: '0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118',
  // PoolManager Initialize(PoolId indexed id, Currency indexed currency0, Currency indexed currency1, ...)
  v4: '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438'
});
// The factories and quote assets observed on each chain (2026-10-01): every factory was
// labelled by sampling its pools on DexScreener. A pool pairs one new token with one quote asset.
export const POOL_SOURCES = Object.freeze({
  arc: Object.freeze({
    blockMs: 500,
    quotes: Object.freeze([ZERO, '0x3600000000000000000000000000000000000000']),
    factories: Object.freeze([
      { address: '0x8366a39cc670b4001a1121b8f6a443a643e40951', event: 'v4', venue: 'Uniswap v4' },
      { address: '0xf0db7b58379503491d857db50ac9ece64c653918', event: 'v3', venue: 'Uniswap v3' }
    ])
  })
});
// One request covers at most this many blocks; a scan that falls behind catches up a chunk per cycle.
export const MAX_LOG_BLOCKS = 500;
// After downtime longer than this, the radar resumes near the head instead of backfilling.
export const MAX_GAP_MS = 10 * 60_000;
const START_LOOKBACK_MS = 60_000;
// The head and the logs may come from different nodes; reading this far behind the reported
// head keeps a lagging node from returning an empty range the cursor would then skip.
const HEAD_LAG_MS = 3_000;

export class ChainLogsError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'ChainLogsError';
    this.code = code;
  }
}

/**
 * The block range to read next: from the block after `cursor` up to HEAD_LAG_MS behind the head,
 * at most MAX_LOG_BLOCKS. With no cursor, or after a gap longer than MAX_GAP_MS, it restarts a
 * minute behind and reports the blocks it skipped.
 */
export function nextLogRange(cursor, reportedHead, blockMs) {
  const head = Math.max(0, reportedHead - Math.ceil(HEAD_LAG_MS / blockMs));
  const restart = Math.max(0, head - Math.ceil(START_LOOKBACK_MS / blockMs));
  let fromBlock = cursor === null ? restart : cursor + 1, skippedBlocks = 0;
  if (cursor !== null && head - cursor > Math.ceil(MAX_GAP_MS / blockMs)) {
    skippedBlocks = restart - fromBlock;
    fromBlock = restart;
  }
  if (fromBlock > head) return null;
  return { fromBlock, toBlock: Math.min(head, fromBlock + MAX_LOG_BLOCKS - 1), skippedBlocks };
}

const word = (data, index) => typeof data === 'string' && data.length >= 2 + 64 * (index + 1) ? data.slice(2 + 64 * index, 2 + 64 * (index + 1)) : null;
const topicAddress = topic => typeof topic === 'string' && /^0x0{24}[0-9a-f]{40}$/i.test(topic) ? `0x${topic.slice(26).toLowerCase()}` : null;
const wordAddress = value => value && /^0{24}[0-9a-f]{40}$/i.test(value) ? `0x${value.slice(24).toLowerCase()}` : null;

/** Decode one pool-creation log into the new token it lists, or null when it pairs no single quote asset. */
export function decodePoolLog(log, source) {
  const factory = source.factories.find(item => item.address === String(log?.address).toLowerCase());
  if (!factory || !Array.isArray(log.topics) || log.topics[0] !== TOPICS[factory.event]) return null;
  const block = typeof log.blockNumber === 'string' ? Number.parseInt(log.blockNumber, 16) : NaN;
  if (!Number.isSafeInteger(block)) return null;
  const [token0, token1] = factory.event === 'v4' ? [topicAddress(log.topics[2]), topicAddress(log.topics[3])] : [topicAddress(log.topics[1]), topicAddress(log.topics[2])];
  const pool = factory.event === 'v4' ? (/^0x[0-9a-f]{64}$/i.test(log.topics[1] ?? '') ? log.topics[1].toLowerCase() : null)
    : wordAddress(word(log.data, 1));
  if (!token0 || !token1 || !pool) return null;
  const quote0 = source.quotes.includes(token0), quote1 = source.quotes.includes(token1);
  if (quote0 === quote1) return null;
  const token = quote0 ? token1 : token0;
  return token === ZERO ? null : { token, pool, venue: factory.venue, block };
}

/** Why a cycle on `chain` reads no new pools, or null when it does. */
export function onchainOffReason(chain, rpcUrls) {
  return POOL_SOURCES[chain] && !rpcUrls[chain] ? 'ONCHAIN_NOT_CONFIGURED' : null;
}

export class ChainLogs {
  /** `rpcUrls` maps a chain to its validated RPC URL (`chainRpcUrls`); a chain without one is not configured. */
  constructor({ rpcUrls, fetchImpl = globalThis.fetch, timeoutMs = 8_000 }) {
    if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
    Object.assign(this, { rpcUrls, fetchImpl, timeoutMs });
  }

  async #rpc(url, method, params, signal) {
    const controller = new AbortController(), abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, this.timeoutMs);
    let response;

    // Called unbound: the Workers runtime rejects fetch invoked as another object's method ("Illegal invocation").
    const { fetchImpl } = this;
    try {
      response = await fetchImpl(url, {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: controller.signal
      });
      if (!response.ok) throw new ChainLogsError(`ONCHAIN_HTTP_${response.status}`);
      const body = await response.json();
      if (body?.error) throw new ChainLogsError(Number.isSafeInteger(body.error.code) ? `ONCHAIN_RPC_${Math.abs(body.error.code)}` : 'ONCHAIN_RPC');
      return body?.result;
    } catch (error) {
      if (error instanceof ChainLogsError) throw error;
      if (error?.name === 'AbortError') throw new ChainLogsError('ONCHAIN_TIMEOUT');
      if (error instanceof SyntaxError) throw new ChainLogsError('ONCHAIN_SCHEMA');
      if (error instanceof TypeError) throw new ChainLogsError('ONCHAIN_NETWORK');
      // Any other error may quote the request URL, which holds the key; only its class leaves.
      throw new ChainLogsError('ONCHAIN_FAILED');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  /** The new pools created on `chain` after block `cursor` (null on first use), one bounded range per call. */
  async newPools(chain, { cursor, signal } = {}) {
    const source = POOL_SOURCES[chain];
    if (!source) throw new ChainLogsError('ONCHAIN_UNSUPPORTED');
    const url = this.rpcUrls[chain];
    if (!url) throw new ChainLogsError('ONCHAIN_NOT_CONFIGURED');
    const head = Number.parseInt(await this.#rpc(url, 'eth_blockNumber', [], signal), 16);
    if (!Number.isSafeInteger(head) || head < 0) throw new ChainLogsError('ONCHAIN_SCHEMA');
    const range = nextLogRange(cursor ?? null, head, source.blockMs);
    if (!range) return { head, fromBlock: null, toBlock: cursor, skippedBlocks: 0, pools: [] };
    const hex = value => `0x${value.toString(16)}`;
    const logs = await this.#rpc(url, 'eth_getLogs', [{ fromBlock: hex(range.fromBlock), toBlock: hex(range.toBlock),
      address: source.factories.map(item => item.address), topics: [[...new Set(source.factories.map(item => TOPICS[item.event]))]] }], signal);
    if (!Array.isArray(logs)) throw new ChainLogsError('ONCHAIN_SCHEMA');
    const pools = [...new Map(logs.map(log => decodePoolLog(log, source)).filter(Boolean).map(pool => [pool.token, pool])).values()];
    return { head, ...range, pools };
  }
}
