/** Lenient readers for upstream row values: each returns null for anything it cannot read. */
const NUMBER_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

export function optionalNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || !NUMBER_PATTERN.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function optionalRate(value) {
  let parsed;
  if (typeof value === 'string' && value.trim().endsWith('%')) {
    const percent = optionalNumber(value.trim().slice(0, -1));
    parsed = percent === null ? null : percent / 100;
  } else {
    parsed = optionalNumber(value);
  }
  return parsed !== null && parsed >= 0 && parsed <= 1 ? parsed : null;
}

export function optionalCount(value) {
  const parsed = optionalNumber(value);
  return parsed !== null && parsed >= 0 && Number.isInteger(parsed) ? parsed : null;
}

export function optionalNonNegativeNumber(value) {
  const parsed = optionalNumber(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}

// Internal thresholds use ratios. A literal percent string is accepted too,
// but large bare values are deliberately not guessed to be percentages because
// doing so would manufacture precision from ambiguous upstream data.
export function optionalSignedRate(value) {
  let parsed;
  if (typeof value === 'string' && value.trim().endsWith('%')) {
    const percent = optionalNumber(value.trim().slice(0, -1));
    parsed = percent === null ? null : percent / 100;
  } else {
    parsed = optionalNumber(value);
  }
  return parsed !== null && parsed >= -5 && parsed <= 5 ? parsed : null;
}

export function optionalBoolean(value) {
  if (value === true || value === false) return value;
  if (value === 1 || value === 0) return value === 1;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (['yes', 'true', '1'].includes(normalized)) return true;
  if (['no', 'false', '0'].includes(normalized)) return false;
  return null;
}

export const num = (value, fallback = 0) => optionalNumber(value) ?? fallback;
export const first = (...values) => values.find(value => value !== undefined && value !== null && value !== '');
