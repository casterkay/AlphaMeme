// Trading configuration: the tradable chains, their venue facts, and the
// defaults a user can adjust. Parsed once from the Worker's vars; a malformed
// value fails loudly instead of silently disabling or mis-routing a chain.
import { TradingError } from './http.mjs';

export const KYBER_NATIVE_TOKEN = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
export const ARC_USDC_ERC20 = '0x3600000000000000000000000000000000000000';

// Buys spend the chain's native coin. Arc's native coin is USDC, but Kyber
// routes its ERC-20 view (6 decimals) of the same balance (18 decimals natively).
export const TRADE_CHAINS = Object.freeze({
  arc: Object.freeze({ chainId: 5042, kyberSlug: 'arc', rpcVar: 'ARC_RPC_URL', explorerVar: 'ARC_EXPLORER_URL', defaultExplorer: null,
    nativeSymbol: 'USDC', quoteToken: ARC_USDC_ERC20, quoteDecimals: 6, quoteSharesNativeBalance: true }),
  bsc: Object.freeze({ chainId: 56, kyberSlug: 'bsc', rpcVar: 'BSC_RPC_URL', explorerVar: 'BSC_EXPLORER_URL', defaultExplorer: 'https://bscscan.com',
    nativeSymbol: 'BNB', quoteToken: KYBER_NATIVE_TOKEN, quoteDecimals: 18, quoteSharesNativeBalance: false }),
  base: Object.freeze({ chainId: 8453, kyberSlug: 'base', rpcVar: 'BASE_RPC_URL', explorerVar: 'BASE_EXPLORER_URL', defaultExplorer: 'https://basescan.org',
    nativeSymbol: 'ETH', quoteToken: KYBER_NATIVE_TOKEN, quoteDecimals: 18, quoteSharesNativeBalance: false }),
  eth: Object.freeze({ chainId: 1, kyberSlug: 'ethereum', rpcVar: 'ETH_RPC_URL', explorerVar: 'ETH_EXPLORER_URL', defaultExplorer: 'https://etherscan.io',
    nativeSymbol: 'ETH', quoteToken: KYBER_NATIVE_TOKEN, quoteDecimals: 18, quoteSharesNativeBalance: false })
});

/** Every trading default in one place; user choices are limited to the listed options. */
export const TRADING_SETTINGS = Object.freeze({
  slippageBps: 500,
  slippageChoicesBps: Object.freeze([100, 300, 500, 1000, 2000]),
  buyCapUsd: 100,
  buyCapChoicesUsd: Object.freeze([50, 100, 250, 500, 1000]),
  buyButtonsUsd: Object.freeze([1, 2, 5]),
  sellButtonsPercent: Object.freeze([25, 50, 100]),
  quoteTtlMs: 30_000,
  // A native price probe spends 10^-3 of a coin; a native buy's routed USD value may exceed the cap by this much.
  priceProbeDecimalsBelowCoin: 3,
  capTolerancePercent: 2,
  swapDeadlineMs: 10 * 60_000,
  receiptPollMs: 3_000,
  receiptDeadlineMs: 10 * 60_000,
  rebroadcastEveryPolls: 5,
  transientRetries: 3,
  gasLimitBufferPercent: 20,
  exportDeleteAfterMs: 60_000,
  recentTradesKept: 20
});

function httpsUrl(name, value) {
  let url;
  try { url = new URL(value); } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new TradingError('TRADING_CONFIG_INVALID', `${name} must be an https URL`);
  }
  if (url.protocol !== 'https:' || url.username || url.password) throw new TradingError('TRADING_CONFIG_INVALID', `${name} must be an https URL without credentials`);
  return url.href.replace(/\/$/, '');
}

function optionalVar(env, name) {
  const value = env?.[name];
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new TradingError('TRADING_CONFIG_INVALID', `${name} must be a string`);
  return value.trim();
}

/** Each chain's one JSON-RPC URL, shared by chain reads (new-pool discovery) and trading; an empty var leaves the chain out. */
export function chainRpcUrls(env) {
  const urls = {};
  for (const [chain, facts] of Object.entries(TRADE_CHAINS)) {
    const rpc = optionalVar(env, facts.rpcVar);
    if (rpc) urls[chain] = httpsUrl(facts.rpcVar, rpc);
  }
  return Object.freeze(urls);
}

/** The chains with an RPC URL are tradable, once the user has a wallet; an empty RPC var disables its chain. */
export function parseTradingConfig(env) {
  const clientId = optionalVar(env, 'KYBER_CLIENT_ID');
  const chains = {};
  for (const [chain, rpcUrl] of Object.entries(chainRpcUrls(env))) {
    const facts = TRADE_CHAINS[chain], explorer = optionalVar(env, facts.explorerVar);
    chains[chain] = Object.freeze({ ...facts, chain, rpcUrl, explorerUrl: explorer ? httpsUrl(facts.explorerVar, explorer) : facts.defaultExplorer });
  }
  if (Object.keys(chains).length && !/^[\x21-\x7e]{1,128}$/.test(clientId)) {
    throw new TradingError('TRADING_CONFIG_INVALID', 'KYBER_CLIENT_ID is required when any chain RPC URL is set');
  }
  return Object.freeze({ clientId, chains: Object.freeze(chains) });
}
