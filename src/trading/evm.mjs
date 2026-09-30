// EVM JSON-RPC: one HTTP request per call (a batch counts as one), with the
// endpoint's chain id checked on every request. ABI work is viem's.
import { decodeFunctionResult, encodeFunctionData, erc20Abi, toEventSelector } from 'viem';
import { TradingError, requestJson } from './http.mjs';

const LIMITS = Object.freeze({ timeoutMs: 10_000, maxBytes: 2_097_152 });
const quantity = /^0x(0|[1-9a-f][0-9a-f]{0,63})$/i;
const TRANSFER_TOPIC = toEventSelector('Transfer(address,address,uint256)');

/** A JSON-RPC error answer: the node received the request and refused it. */
export class RpcAnswerError extends TradingError {
  constructor(rpcCode, kind) {
    super('RPC_REFUSED', 'the node refused the request', { detail: Number.isSafeInteger(rpcCode) ? rpcCode : null });
    this.name = 'RpcAnswerError';
    this.kind = kind;
  }
}

// Classify only; node prose is never stored or shown. Order matters: the more
// specific phrase wins.
const ANSWER_KINDS = [
  ['KNOWN', /already known|known transaction|already imported|alreadyexists|already exists/i],
  ['NONCE_TOO_LOW', /nonce too low|nonce is too low|nonce_expired|nonce has already been used/i],
  ['INSUFFICIENT_FUNDS', /insufficient funds/i],
  ['INTRINSIC_GAS_TOO_LOW', /intrinsic gas too low/i],
  ['REPLACEMENT_UNDERPRICED', /replacement transaction underpriced|replacement fee too low/i],
  ['UNDERPRICED', /transaction underpriced/i],
  ['FEE_TOO_LOW', /max fee per gas less than block base fee|fee cap less than block base fee/i],
  ['INVALID_SENDER', /invalid sender/i],
  ['INVALID_CHAIN_ID', /invalid chain ?id|chain ?id mismatch|incorrect chain ?id/i],
  ['GAS_LIMIT_EXCEEDED', /exceeds block gas limit/i],
  ['FEE_CAP_EXCEEDED', /exceeds the configured cap/i],
  ['REVERTED', /revert/i]
];
function answerKind(message) {
  const text = typeof message === 'string' ? message : '';
  return ANSWER_KINDS.find(([, pattern]) => pattern.test(text))?.[0] ?? 'OTHER';
}

/** Refusals that prove a node did not accept a raw transaction; every other answer is ambiguous. */
export const DEFINITE_REFUSALS = Object.freeze(new Set(['NONCE_TOO_LOW', 'INSUFFICIENT_FUNDS', 'INTRINSIC_GAS_TOO_LOW', 'REPLACEMENT_UNDERPRICED',
  'UNDERPRICED', 'FEE_TOO_LOW', 'INVALID_SENDER', 'INVALID_CHAIN_ID', 'GAS_LIMIT_EXCEEDED', 'FEE_CAP_EXCEEDED']));

export function hexQuantity(value) {
  if (typeof value !== 'string' || !quantity.test(value)) throw new TradingError('RPC_SCHEMA', 'node returned an invalid quantity');
  return BigInt(value);
}

export class EvmRpc {
  #url; #chainId; #fetch; #timeoutMs;

  constructor({ url, chainId, fetchImpl = globalThis.fetch, timeoutMs = LIMITS.timeoutMs }) {
    if (typeof url !== 'string' || !url.startsWith('https://') || !Number.isSafeInteger(chainId) || chainId < 1 || typeof fetchImpl !== 'function') {
      throw new TypeError('EVM RPC configuration is invalid');
    }
    this.#url = url; this.#chainId = chainId; this.#fetch = fetchImpl; this.#timeoutMs = timeoutMs;
  }

  /**
   * Sends [eth_chainId, ...calls] as one batch. Returns, per call, { result } or
   * { error: RpcAnswerError }. Transport and shape failures throw.
   */
  async batch(calls, { signal } = {}) {
    if (!Array.isArray(calls) || !calls.length || calls.length > 16) throw new TypeError('EVM RPC batch is invalid');
    const body = [{ method: 'eth_chainId', params: [] }, ...calls].map((call, id) => ({ jsonrpc: '2.0', id, method: call.method, params: call.params }));
    const response = await requestJson({ fetchImpl: this.#fetch, url: this.#url, init: { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) },
      timeoutMs: this.#timeoutMs, maxBytes: LIMITS.maxBytes, signal, prefix: 'RPC' });
    if (response.status === 429) throw new TradingError('RPC_RATE_LIMITED', 'the node rate limited the request', { transient: true });
    if (response.status >= 500) throw new TradingError('RPC_UPSTREAM', 'the node did not answer', { transient: true });
    if (!response.ok || !Array.isArray(response.json) || response.json.length !== body.length) throw new TradingError('RPC_SCHEMA', 'the node answered an unexpected shape');
    const byId = new Map();
    for (const item of response.json) {
      if (!item || typeof item !== 'object' || !Number.isSafeInteger(item.id) || item.id < 0 || item.id >= body.length || byId.has(item.id)) {
        throw new TradingError('RPC_SCHEMA', 'the node answered an unexpected batch');
      }
      byId.set(item.id, item);
    }
    const answers = body.map(({ id }) => {
      const item = byId.get(id);
      if (item.error && typeof item.error === 'object') return { error: new RpcAnswerError(item.error.code, answerKind(item.error.message)) };
      if (!Object.hasOwn(item, 'result')) throw new TradingError('RPC_SCHEMA', 'the node answered without a result');
      return { result: item.result };
    });
    if (answers[0].error || hexQuantity(answers[0].result) !== BigInt(this.#chainId)) {
      throw new TradingError('RPC_CHAIN_MISMATCH', 'the RPC endpoint serves a different chain');
    }
    return answers.slice(1);
  }
}

export const rpc = Object.freeze({
  nonce: owner => ({ method: 'eth_getTransactionCount', params: [owner, 'pending'] }),
  minedNonce: owner => ({ method: 'eth_getTransactionCount', params: [owner, 'latest'] }),
  gasPrice: () => ({ method: 'eth_gasPrice', params: [] }),
  latestBlock: () => ({ method: 'eth_getBlockByNumber', params: ['latest', false] }),
  balance: (owner, block = 'latest') => ({ method: 'eth_getBalance', params: [owner, block] }),
  estimateGas: tx => ({ method: 'eth_estimateGas', params: [{ from: tx.from, to: tx.to, data: tx.data, value: `0x${tx.value.toString(16)}` }] }),
  sendRaw: raw => ({ method: 'eth_sendRawTransaction', params: [raw] }),
  receipt: hash => ({ method: 'eth_getTransactionReceipt', params: [hash] }),
  erc20: (token, functionName, args = [], block = 'latest') => ({ method: 'eth_call', params: [{ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName, args }) }, block] })
});

export const approveCalldata = (spender, amount) => encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] });

/** Decodes an ERC-20 view answer; throws RPC_SCHEMA when it is not one. */
export function decodeErc20(functionName, answer) {
  if (answer.error) throw answer.error;
  try {
    return decodeFunctionResult({ abi: erc20Abi, functionName, data: answer.result });
  } catch (error) {
    if (!(error instanceof Error) || error instanceof TradingError) throw error;
    throw new TradingError('RPC_SCHEMA', `token ${functionName} is unreadable`);
  }
}

/** EIP-1559 fees when the chain reports a base fee, else a legacy gas price. */
export function feeFields(gasPrice, block) {
  if (!block || typeof block !== 'object') throw new TradingError('RPC_SCHEMA', 'latest block is missing');
  if (block.baseFeePerGas === undefined || block.baseFeePerGas === null) return { type: 'legacy', gasPrice, maxCost: gasPrice };
  const baseFee = hexQuantity(block.baseFeePerGas);
  const tip = gasPrice > baseFee ? gasPrice - baseFee : 0n;
  const maxFeePerGas = baseFee * 2n + tip;
  return { type: 'eip1559', maxFeePerGas, maxPriorityFeePerGas: tip, maxCost: maxFeePerGas };
}

/** Receipt status: 'success', 'reverted', or null while not yet mined. */
export function receiptStatus(receipt) {
  if (receipt === null) return null;
  if (!receipt || typeof receipt !== 'object' || !Array.isArray(receipt.logs)) throw new TradingError('RPC_SCHEMA', 'receipt is malformed');
  if (receipt.status === '0x1') return 'success';
  if (receipt.status === '0x0') return 'reverted';
  throw new TradingError('RPC_SCHEMA', 'receipt status is malformed');
}

const topicAddress = topic => typeof topic === 'string' && /^0x0{24}[0-9a-f]{40}$/i.test(topic) ? `0x${topic.slice(26).toLowerCase()}` : null;

/** The sum of ERC-20 Transfer amounts of token in a receipt, filtered by from/to. */
export function transferredAmount(receipt, token, { from = null, to = null }) {
  let total = 0n, seen = false;
  for (const log of receipt.logs) {
    if (!log || typeof log.address !== 'string' || log.address.toLowerCase() !== token.toLowerCase() || !Array.isArray(log.topics) || log.topics[0] !== TRANSFER_TOPIC || log.topics.length !== 3) continue;
    if (from && topicAddress(log.topics[1]) !== from.toLowerCase()) continue;
    if (to && topicAddress(log.topics[2]) !== to.toLowerCase()) continue;
    total += hexQuantity(log.data === '0x' ? '0x0' : `0x${String(log.data).slice(2).replace(/^0+(?=.)/, '')}`);
    seen = true;
  }
  return seen ? total : null;
}
