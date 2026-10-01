const EVM_TOKEN = /^0x[0-9a-f]{40}$/i;
const EVM_POOL = /^0x(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const SOLANA_TEXT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BASE58_TEXT = /^[1-9A-HJ-NP-Za-km-z]+$/;
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** The number of bytes base58 text decodes to, or 0 when it is not base58. */
export function base58ByteLength(value) {
  if (!BASE58_TEXT.test(value)) return 0;
  let number = 0n;
  for (const character of value) number = number * 58n + BigInt(BASE58.indexOf(character));
  const significant = number === 0n ? 0 : Math.ceil(number.toString(16).length / 2);
  return significant + (value.match(/^1*/)?.[0].length || 0);
}

const solanaBytes = value => SOLANA_TEXT.test(value) ? base58ByteLength(value) : 0;

export function normalizeTokenAddress(chain, value) {
  if (typeof value !== 'string' || value !== value.trim()) return null;
  if (chain === 'sol') return solanaBytes(value) === 32 && !/^1+$/.test(value) ? value : null;
  return EVM_TOKEN.test(value) && !/^0x(?:0{40}|e{40})$/i.test(value) ? value.toLowerCase() : null;
}

export function normalizePoolAddress(chain, value) {
  const token = normalizeTokenAddress(chain, value);
  if (token) return token;
  if (chain === 'sol' || typeof value !== 'string' || value !== value.trim()) return null;
  return EVM_POOL.test(value) && !/^0x0{64}$/i.test(value) ? value.toLowerCase() : null;
}

export const validTokenAddress = (chain, value) => normalizeTokenAddress(chain, value) !== null;
export const validPoolAddress = (chain, value) => normalizePoolAddress(chain, value) !== null;
