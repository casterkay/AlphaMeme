// The chains the radar can scan. AVE serves each one (Arc was confirmed by a
// deployed read), and one chain is scanned at a time; Arc is the default.
export const SCAN_CHAINS = Object.freeze(['arc', 'bsc', 'base', 'eth', 'sol', 'robinhood']);
export const DEFAULT_SCAN_CHAIN = 'arc';

export function isScanChain(value) {
  return typeof value === 'string' && SCAN_CHAINS.includes(value);
}
