import { discoveryScreen, knownRiskReasons } from './scoring/index.mjs';

const number = value => value === null || value === undefined || value === '' || typeof value === 'boolean'
  ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const count = value => { const n = number(value); return n !== null && n >= 0 && Number.isInteger(n) ? n : null; };
const rate = value => { const n = number(value); return n !== null && n >= 0 && n <= 1 ? n : null; };
const flag = value => ['1', 'true', 'yes'].includes(String(value).toLowerCase()) ? true
  : ['0', 'false', 'no'].includes(String(value).toLowerCase()) ? false : null;
const text = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max);
const safeText = (value, max) => /gmgn_[a-z0-9]{8,}|bearer\s|api[_ -]?key|private[_ -]?key/i.test(String(value)) ? '?' : text(value, max);
const identity = (chain, value) => chain === 'sol' ? value : value.toLowerCase();
const addressValid = (chain, value) => typeof value === 'string' && (chain === 'sol' ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ : /^0x[0-9a-f]{40}$/i).test(value);
const safeUrl = value => {
  try { const url = new URL(String(value)); return url.protocol === 'https:' && !url.username && !url.password ? url.href.slice(0, 500) : ''; }
  catch { return ''; }
};

// This is a discovery snapshot, never an audit verdict. No extra per-token reads.
export function normalizeLiveRows(input, chain, previous = [], at = Date.now(), initialized = false, settings) {
  const before = new Map(previous.map(row => [identity(chain, row.address), row]));
  const unique = new Map();
  for (const raw of input.slice(0, 100)) {
    if (!raw || !addressValid(chain, raw.address) || (raw.chain && raw.chain !== chain)) continue;
    const address = identity(chain, raw.address);
    if (knownRiskReasons(raw, settings).length) continue;
    const mc = number(raw.market_cap), liquidity = number(raw.liquidity), created = number(raw.creation_timestamp);
    if (mc === null || mc < 10000 || mc > 500000 || liquidity === null || liquidity < 3000
      || created === null || created <= 0 || at / 1000 - created < 300) continue;
    if (flag(raw.is_wash_trading) === true || (chain !== 'sol' && flag(raw.is_honeypot) === true)
      || [raw.rug_ratio, raw.bundler_rate, raw.rat_trader_amount_rate].some(value => rate(value) !== null && rate(value) > .3)) continue;
    const old = before.get(address);
    const elapsed = old ? at - old.observedAt : 0;
    // The floor sits below the 5s poll interval so request-latency jitter between two
    // consecutive polls never drops a real delta below the comparable window.
    const comparable = elapsed >= 3000 && elapsed <= 120000;
    const price = number(raw.price), holders = count(raw.holder_count), smart = count(raw.smart_degen_count);
    const hasUnknownRisk = [raw.rug_ratio, raw.bundler_rate, raw.rat_trader_amount_rate].some(value => rate(value) === null)
      || flag(raw.is_wash_trading) === null || (chain !== 'sol' && flag(raw.is_honeypot) === null);
    unique.set(address, {
      address, chain, symbol: safeText(raw.symbol || '?', 30), name: safeText(raw.name, 80),
      marketCap: mc, liquidity, createdAt: created, price: price !== null && price > 0 ? price : null,
      volume1m: number(raw.volume) >= 0 ? number(raw.volume) : null,
      buys1m: count(raw.buys), sells1m: count(raw.sells), swaps1m: count(raw.swaps), holders, smartMoney: smart,
      observedAt: at, firstSeenAt: old?.firstSeenAt || at,
      newAt: old?.newAt || (initialized && !old ? at : 0),
      deltaWindowMs: comparable ? elapsed : null,
      priceDelta: comparable && price > 0 && old.price > 0 ? price / old.price - 1 : null,
      holdersDelta: comparable && holders !== null && old.holders !== null ? holders - old.holders : null,
      smartDelta: comparable && smart !== null && old.smartMoney !== null ? smart - old.smartMoney : null,
      priorityBand: mc >= 20000 && mc <= 80000, hasUnknownRisk,
      website: safeUrl(raw.website), twitter: safeText(raw.twitter_username, 80),
      auditEligible: discoveryScreen(raw, { ...settings, chain }, at / 1000).pass
    });
  }
  return [...unique.values()].sort((a, b) => (b.volume1m || 0) - (a.volume1m || 0));
}

