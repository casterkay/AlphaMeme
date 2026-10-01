import { validTokenAddress } from './address.mjs';

const EVM_POOL = /^0x(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

const clean = value => typeof value === 'string' ? value.trim() : '';
const poolAddress = value => EVM_POOL.test(clean(value)) ? clean(value).toLowerCase() : '';
const tokenAddress = value => validTokenAddress(clean(value)) ? clean(value).toLowerCase() : '';
export function verifiedAvePoolEvidence(row, chain, { requireRowPair = false } = {}) {
  const pool = row?.poolEvidence;
  const token = tokenAddress(row?.address);
  if (!token || !pool || pool.source !== 'AVE' || pool.identityBasis !== 'response' || pool.chain !== chain) return null;
  const pair = poolAddress(pool.pair), target = tokenAddress(pool.target_token);
  const token0 = tokenAddress(pool.token0_address), token1 = tokenAddress(pool.token1_address);
  if (!pair || !target || target !== token || !token0 || !token1 || token0 === token1 || token !== token0 && token !== token1) return null;
  const rowPair = poolAddress(row?.pairAddress);
  if (requireRowPair && rowPair !== pair) return null;
  return { pool, pair, token, token0, token1, rowPair };
}
