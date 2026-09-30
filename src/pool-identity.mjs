import { validTokenAddress } from './address.mjs';

const EVM_POOL = /^0x(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const SOL_POOL = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const clean = value => typeof value === 'string' ? value.trim() : '';
const normalized = (value, chain) => chain === 'sol' ? clean(value) : clean(value).toLowerCase();
const poolAddress = (value, chain) => {
  const address = clean(value);
  return (chain === 'sol' ? SOL_POOL : EVM_POOL).test(address) ? normalized(address, chain) : '';
};
const tokenAddress = (value, chain) => validTokenAddress(chain, clean(value)) ? normalized(value, chain) : '';
export function verifiedAvePoolEvidence(row, chain, { requireRowPair = false } = {}) {
  const pool = row?.poolEvidence;
  const token = tokenAddress(row?.address, chain);
  if (!token || !pool || pool.source !== 'AVE' || pool.identityBasis !== 'response' || pool.chain !== chain) return null;
  const pair = poolAddress(pool.pair, chain), target = tokenAddress(pool.target_token, chain);
  const token0 = tokenAddress(pool.token0_address, chain), token1 = tokenAddress(pool.token1_address, chain);
  if (!pair || !target || target !== token || !token0 || !token1 || token0 === token1 || token !== token0 && token !== token1) return null;
  const rowPair = poolAddress(row?.pairAddress, chain);
  if (requireRowPair && rowPair !== pair) return null;
  return { pool, pair, token, token0, token1, rowPair };
}
