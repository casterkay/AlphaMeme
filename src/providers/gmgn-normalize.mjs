export function unwrapGmgn(value) {
  let current = value;
  for (let index = 0; index < 3; index += 1) {
    if (current && typeof current === 'object' && !Array.isArray(current) && current.data != null) current = current.data;
    else break;
  }
  return current;
}

export function normalizeGmgnList(raw, keys = ['list', 'rank', 'completed', 'tokens']) {
  const value = unwrapGmgn(raw);
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  for (const key of keys) if (Array.isArray(value[key])) return value[key];
  return [];
}

export function tokenInfoPrice(info) {
  const value = info?.price?.price ?? info?.price ?? info?.price_usd;
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const price = Number(value);
  return Number.isFinite(price) && price > 0 ? price : null;
}
