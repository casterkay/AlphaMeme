// Exact amount arithmetic. Money is integer cents or token base units (bigint);
// every division floors, so no conversion ever spends more than asked.
import { formatUnits } from 'viem';

const MICRO = 1_000_000n;

/** A user-typed USD amount ("12", "12.5", "$12.50") as integer cents, or null. */
export function parseUsdCents(value) {
  const text = typeof value === 'string' ? value.trim().replace(/^\$/, '') : '';
  const match = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
  return cents > 0 ? cents : null;
}

/** A user-typed whole percentage from 1 to 100 ("25", "25%"), or null. */
export function parsePercent(value) {
  const text = typeof value === 'string' ? value.trim().replace(/%$/, '') : '';
  if (!/^\d{1,3}$/.test(text)) return null;
  const percent = Number(text);
  return percent >= 1 && percent <= 100 ? percent : null;
}

export function withinBuyCap(usdCents, capUsd) {
  return Number.isSafeInteger(usdCents) && usdCents > 0 && Number.isSafeInteger(capUsd) && usdCents <= capUsd * 100;
}

/** USD cents in base units of a USD-pegged token with the given decimals (Arc USDC: 6). */
export function usdCentsToStableUnits(usdCents, decimals) {
  if (!Number.isSafeInteger(usdCents) || usdCents <= 0 || !Number.isSafeInteger(decimals) || decimals < 2) throw new RangeError('USD amount is invalid');
  return BigInt(usdCents) * 10n ** BigInt(decimals - 2);
}

/** A non-negative decimal (string or number) scaled to micro units, truncated. */
export function decimalToMicro(value) {
  const text = typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value.toFixed(6) : value;
  const match = typeof text === 'string' ? /^(\d{1,30})(?:\.(\d+))?$/.exec(text.trim()) : null;
  if (!match) return null;
  return BigInt(match[1]) * MICRO + BigInt((match[2] || '').slice(0, 6).padEnd(6, '0'));
}

/**
 * The USD price of one whole native coin, in micro-USD, from a Kyber route that
 * spent `amountIn` base units (18 decimals) and valued them at amountInUsd.
 */
export function nativePriceMicroUsd(amountInUsd, amountIn, decimals = 18) {
  const valueMicro = decimalToMicro(amountInUsd);
  if (valueMicro === null || valueMicro <= 0n || typeof amountIn !== 'bigint' || amountIn <= 0n) return null;
  const price = valueMicro * 10n ** BigInt(decimals) / amountIn;
  return price > 0n ? price : null;
}

/** USD cents converted to native base units at priceMicroUsd per whole coin, floored. */
export function usdCentsToNativeUnits(usdCents, priceMicroUsd, decimals = 18) {
  if (!Number.isSafeInteger(usdCents) || usdCents <= 0 || typeof priceMicroUsd !== 'bigint' || priceMicroUsd <= 0n) throw new RangeError('conversion input is invalid');
  return BigInt(usdCents) * 10_000n * 10n ** BigInt(decimals) / priceMicroUsd;
}

/** percent (1–100) of a balance, floored; 100 is the whole balance. */
export function percentOf(balance, percent) {
  if (typeof balance !== 'bigint' || balance < 0n || !Number.isSafeInteger(percent) || percent < 1 || percent > 100) throw new RangeError('percentage input is invalid');
  return balance * BigInt(percent) / 100n;
}

/** The minimum output a swap accepts at slippageBps, floored as the router does. */
export function minimumOut(amountOut, slippageBps) {
  if (typeof amountOut !== 'bigint' || amountOut < 0n || !Number.isSafeInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) throw new RangeError('slippage input is invalid');
  return amountOut * BigInt(10_000 - slippageBps) / 10_000n;
}

/** A human amount with at most `digits` significant fractional digits. */
export function displayUnits(amount, decimals, digits = 6) {
  const [whole, fraction = ''] = formatUnits(BigInt(amount), decimals).split('.');
  if (!fraction) return whole;
  const lead = whole === '0' ? fraction.search(/[1-9]/) : 0;
  const kept = fraction.slice(0, Math.max(0, lead) + digits).replace(/0+$/, '');
  return kept ? `${whole}.${kept}` : whole;
}

export const centsText = cents => `$${Math.floor(cents / 100)}${cents % 100 ? '.' + String(cents % 100).padStart(2, '0') : ''}`;
export const microUsdText = micro => `$${displayUnits(micro, 6, 2)}`;
