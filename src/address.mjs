const EVM_TOKEN = /^0x[0-9a-f]{40}$/i;
const EVM_POOL = /^0x(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

// Every supported chain is EVM, so addresses are case-insensitive and stored in lower case.
export function normalizeTokenAddress(value) {
  if (typeof value !== 'string' || value !== value.trim()) return null;
  return EVM_TOKEN.test(value) && !/^0x(?:0{40}|e{40})$/i.test(value) ? value.toLowerCase() : null;
}

export function normalizePoolAddress(value) {
  const token = normalizeTokenAddress(value);
  if (token) return token;
  if (typeof value !== 'string' || value !== value.trim()) return null;
  return EVM_POOL.test(value) && !/^0x0{64}$/i.test(value) ? value.toLowerCase() : null;
}

export const validTokenAddress = value => normalizeTokenAddress(value) !== null;
export const validPoolAddress = value => normalizePoolAddress(value) !== null;
