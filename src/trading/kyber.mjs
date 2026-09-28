// KyberSwap Aggregator: one route or build request per call, strictly checked.
// https://docs.kyberswap.com/kyberswap-solutions/kyberswap-aggregator/aggregator-api-specification/evm-swaps
// The router address is pinned; transactions are always sent to the pinned
// address, never to anything a response names, and no response URL is followed.
import { getAddress } from 'viem';
import { TradingError, requestJson } from './http.mjs';
import { KYBER_NATIVE_TOKEN } from './config.mjs';

export const KYBER_API_ORIGIN = 'https://aggregator-api.kyberswap.com';
// MetaAggregationRouterV2, the same address on every supported chain (EIP-55 checksummed).
export const KYBER_ROUTER = getAddress('0x6131b5fae19ea4f9d964eac0408e4408b66337b5');
const LIMITS = Object.freeze({ timeoutMs: 10_000, maxBytes: 1_048_576 });
const unsigned = /^(0|[1-9]\d{0,77})$/;
const decimal = /^\d{1,40}(\.\d{1,40})?$/;
const address = /^0x[0-9a-fA-F]{40}$/;
const sameAddress = (left, right) => typeof left === 'string' && typeof right === 'string' && address.test(left) && left.toLowerCase() === right.toLowerCase();
const usd = value => typeof value === 'string' && decimal.test(value) ? value : typeof value === 'number' && Number.isFinite(value) && value >= 0 ? String(value) : null;
const fail = (code, message) => new TradingError(code, message);

function envelope(result) {
  if (result.status === 429) throw new TradingError('KYBER_RATE_LIMITED', 'KyberSwap rate limited the request', { transient: true });
  if (result.status >= 500) throw new TradingError('KYBER_UPSTREAM', 'KyberSwap did not answer', { transient: true });
  const body = result.json;
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('KYBER_SCHEMA', 'KyberSwap response is not an object');
  if (!result.ok || body.code !== 0) {
    throw new TradingError('KYBER_REJECTED', 'KyberSwap refused the request', { detail: Number.isSafeInteger(body.code) ? body.code : null });
  }
  if (!body.data || typeof body.data !== 'object' || Array.isArray(body.data)) throw fail('KYBER_SCHEMA', 'KyberSwap response has no data');
  return body.data;
}

function pinnedRouter(value) {
  if (!sameAddress(value, KYBER_ROUTER)) throw fail('KYBER_ROUTER_MISMATCH', 'KyberSwap named an unexpected router');
}

function positive(value, code) {
  if (typeof value !== 'string' || !unsigned.test(value) || value === '0') throw fail(code, 'KyberSwap amount is invalid');
  return BigInt(value);
}

export class KyberClient {
  #clientId; #fetch; #timeoutMs;

  constructor({ clientId, fetchImpl = globalThis.fetch, timeoutMs = LIMITS.timeoutMs }) {
    if (typeof clientId !== 'string' || !clientId || typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new TypeError('KyberSwap client configuration is invalid');
    }
    this.#clientId = clientId; this.#fetch = fetchImpl; this.#timeoutMs = timeoutMs;
  }

  #request(url, init, signal) {
    return requestJson({ fetchImpl: this.#fetch, url, init: { ...init, headers: { ...init.headers, accept: 'application/json', 'x-client-id': this.#clientId } },
      timeoutMs: this.#timeoutMs, maxBytes: LIMITS.maxBytes, signal, prefix: 'KYBER' });
  }

  /** The best route for exactly amountIn of tokenIn. */
  async route({ slug, tokenIn, tokenOut, amountIn, signal }) {
    if (!/^[a-z]{2,20}$/.test(slug) || !address.test(tokenIn) || !address.test(tokenOut) || typeof amountIn !== 'bigint' || amountIn <= 0n) {
      throw new TypeError('KyberSwap route request is invalid');
    }
    const query = new URLSearchParams({ tokenIn, tokenOut, amountIn: amountIn.toString(), gasInclude: 'true' });
    const data = envelope(await this.#request(`${KYBER_API_ORIGIN}/${slug}/api/v1/routes?${query}`, { method: 'GET', headers: {} }, signal));
    pinnedRouter(data.routerAddress);
    const summary = data.routeSummary;
    if (!summary || typeof summary !== 'object' || Array.isArray(summary)) throw fail('KYBER_SCHEMA', 'KyberSwap route has no summary');
    if (!sameAddress(summary.tokenIn, tokenIn) || !sameAddress(summary.tokenOut, tokenOut)) throw fail('KYBER_ROUTE_MISMATCH', 'KyberSwap routed different tokens');
    if (summary.amountIn !== amountIn.toString()) throw fail('KYBER_AMOUNT_MISMATCH', 'KyberSwap routed a different input amount');
    return {
      routeSummary: summary,
      amountOut: positive(summary.amountOut, 'KYBER_SCHEMA'),
      amountInUsd: usd(summary.amountInUsd),
      amountOutUsd: usd(summary.amountOutUsd),
      gasUsd: usd(summary.gasUsd)
    };
  }

  /** Build the swap for a route; the result is checked against what was requested. */
  async build({ slug, routeSummary, tokenIn, amountIn, sender, slippageBps, deadline, signal }) {
    if (!/^[a-z]{2,20}$/.test(slug) || !address.test(sender) || !address.test(tokenIn) || typeof amountIn !== 'bigint'
      || !Number.isSafeInteger(slippageBps) || slippageBps < 1 || slippageBps > 5000 || !Number.isSafeInteger(deadline)) {
      throw new TypeError('KyberSwap build request is invalid');
    }
    const body = JSON.stringify({ routeSummary, sender, recipient: sender, slippageTolerance: slippageBps, deadline });
    const data = envelope(await this.#request(`${KYBER_API_ORIGIN}/${slug}/api/v1/route/build`, { method: 'POST', headers: { 'content-type': 'application/json' }, body }, signal));
    pinnedRouter(data.routerAddress);
    if (data.amountIn !== amountIn.toString()) throw fail('KYBER_AMOUNT_MISMATCH', 'KyberSwap built a different input amount');
    if (typeof data.transactionValue !== 'string' || !unsigned.test(data.transactionValue)) throw fail('KYBER_SCHEMA', 'KyberSwap transaction value is invalid');
    const value = BigInt(data.transactionValue);
    const nativeIn = sameAddress(tokenIn, KYBER_NATIVE_TOKEN);
    if (value !== (nativeIn ? amountIn : 0n)) throw fail('KYBER_VALUE_MISMATCH', 'KyberSwap transaction value does not match the swap input');
    if (typeof data.data !== 'string' || !/^0x(?:[0-9a-fA-F]{2}){4,65536}$/.test(data.data)) throw fail('KYBER_SCHEMA', 'KyberSwap calldata is invalid');
    return {
      to: KYBER_ROUTER,
      data: data.data,
      value,
      amountOut: positive(data.amountOut, 'KYBER_SCHEMA'),
      amountInUsd: usd(data.amountInUsd),
      amountOutUsd: usd(data.amountOutUsd),
      gasUsd: usd(data.gasUsd)
    };
  }
}
