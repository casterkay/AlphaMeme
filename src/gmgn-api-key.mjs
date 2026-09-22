const KEY_SUFFIX_PATTERN = /^[A-Za-z0-9_-]{24,128}$/;

export function normalizeGmgnApiKey(value) {
  if (typeof value !== 'string') return '';
  const key = value.trim();
  if (!key.startsWith('gmgn_')) return '';
  return KEY_SUFFIX_PATTERN.test(key.slice(5)) ? key : '';
}
