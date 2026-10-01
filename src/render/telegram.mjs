import { safeTelegramText, safeTelegramUrl } from '../bot/snapshot.mjs';

export const TELEGRAM_TEXT_BUDGET = 3500;
export const CHAIN_LABELS = Object.freeze({ arc: 'Arc', bsc: 'BNB Chain', base: 'Base', eth: 'Ethereum', sol: 'Solana', robinhood: 'Robinhood' });
export const localize = (locale, zh, en) => locale === 'en' ? en : zh;
export const escapeHtml = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const userText = (value, max = 500) => escapeHtml(safeTelegramText(value, max));
export const chainLabel = chain => CHAIN_LABELS[chain] || chain;
export const button = (text, action, params = {}, token) => ({ text, action, params, ...(token ? { token } : {}) });
export const urlButton = (text, value) => { const url = safeTelegramUrl(value); return url ? { text, url } : null; };

// The only source of icons. Each marks a state or a destination; none is decorative.
export const ICONS = Object.freeze({
  refresh: '🔄', back: '⬅️', home: '🏠',
  scanning: '🟢', paused: '⏸️', disconnected: '🔌', alertsOn: '🔔', alertsOff: '🔕',
  radar: '📡', audits: '🎯', feed: '🔥', saved: '⭐', stats: '📈', events: '🗂️', status: '📊', settings: '⚙️', wallet: '👛', help: '❓',
  passed: '✅', unknown: '⚠️', vetoed: '⛔', checking: '⏳', newLead: '🆕', key: '🔑',
  chains: '🔗', trade_settings: '🎚️', language: '🌐', export: '📤', sources: '🛜', delivery: '📭'
});

const finite = value => typeof value === 'number' && Number.isFinite(value);
const unknownText = locale => localize(locale, '未知', 'Unknown');
const numberFormat = (locale, options) => new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'zh-CN', options);

/** Exact value for evidence and counts. */
export function numberText(value, locale = 'zh') {
  return finite(value) ? numberFormat(locale, { maximumSignificantDigits: 8 }).format(value) : unknownText(locale);
}

const MONEY_UNITS = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K'], [1, '']];
/** Compact USD for summaries: three significant digits with K/M/B. */
export function money(value, locale = 'zh') {
  if (!finite(value)) return unknownText(locale);
  const magnitude = Math.abs(value);
  // Pick the unit after rounding so 999,950 reads $1M, not $1,000K.
  const index = MONEY_UNITS.findIndex(([scale]) => Number((magnitude / scale).toPrecision(3)) >= 1);
  const [scale, suffix] = MONEY_UNITS[index === -1 ? MONEY_UNITS.length - 1 : index];
  return `${value < 0 ? '-' : ''}$${numberFormat(locale, { maximumSignificantDigits: 3 }).format(magnitude / scale)}${suffix}`;
}

/** A ratio as a percentage: one decimal below 100%, whole numbers above. */
export function percent(value, locale = 'zh', signed = false) {
  if (!finite(value)) return unknownText(locale);
  const hundredths = value * 100;
  return `${numberFormat(locale, { maximumFractionDigits: Math.abs(hundredths) >= 100 ? 0 : 1, signDisplay: signed ? 'exceptZero' : 'negative' }).format(hundredths)}%`;
}

/** Exact UTC timestamp for the audit record (evidence pages). */
export function timestamp(value, locale = 'zh') {
  return validTime(value) ? new Date(value).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC') : localize(locale, '尚无记录', 'No record');
}

/** A length of time in its largest whole unit: 45s, 4m, 2h, 3d. */
export function duration(milliseconds, locale = 'zh') {
  if (!finite(milliseconds)) return unknownText(locale);
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const [amount, zh, en] = seconds < 60 ? [seconds, '秒', 's'] : seconds < 3600 ? [Math.floor(seconds / 60), '分钟', 'm'] : seconds < 86400 ? [Math.floor(seconds / 3600), '小时', 'h'] : [Math.floor(seconds / 86400), '天', 'd'];
  return localize(locale, `${amount}${zh}`, `${amount}${en}`);
}

const validTime = value => typeof value === 'number' && value > 0 && Number.isFinite(value) && Math.abs(value) <= 8.64e15;
const utcDay = value => Math.floor(value / 86_400_000);

/** Short UTC clock time; the date is included unless it matches `reference`'s UTC day. */
export function clockTime(value, locale = 'zh', { reference = null, seconds = false } = {}) {
  if (!validTime(value)) return localize(locale, '尚无记录', 'No record');
  const date = new Date(value), pad = number => String(number).padStart(2, '0');
  const time = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}${seconds ? `:${pad(date.getUTCSeconds())}` : ''} UTC`;
  if (reference !== null && utcDay(reference) === utcDay(value)) return time;
  const month = date.getUTCMonth(), day = date.getUTCDate();
  return localize(locale, `${month + 1}月${day}日 ${time}`, `${date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} ${day} ${time}`);
}

/**
 * How long before `now` a past event happened. Panels are static messages, so
 * this reads against the footer's "Updated" time; future deadlines use clockTime.
 */
export function relativeTime(value, now, locale = 'zh') {
  if (!validTime(value)) return localize(locale, '尚无记录', 'No record');
  if (value > now) return clockTime(value, locale, { reference: now });
  return now - value < 5000 ? localize(locale, '刚刚', 'just now') : localize(locale, `${duration(now - value, locale)}前`, `${duration(now - value, locale)} ago`);
}
export function truth(value, locale = 'zh') {
  return value === true ? localize(locale, '是', 'Yes') : value === false ? localize(locale, '否', 'No') : localize(locale, '未知', 'Unknown');
}

// Split source blocks before escaping, preserving every evidence item and valid HTML.
export function textPages(blocks, budget = 2100) {
  const pages = [];
  let page = [], length = 0;
  for (const block of blocks) {
    const pieces = [];
    let piece = '';
    for (const character of String(block)) {
      if (escapeHtml(piece + character).length > budget) { pieces.push(piece); piece = ''; }
      piece += character;
    }
    if (piece || !pieces.length) pieces.push(piece);
    for (const item of pieces) {
      const size = escapeHtml(item).length + 1;
      if (length + size > budget && page.length) { pages.push(page); page = []; length = 0; }
      page.push(item); length += size;
    }
  }
  if (page.length || !pages.length) pages.push(page);
  return pages;
}

/**
 * Wrap a panel with its title, an "Updated" footer line and the standard
 * navigation row: [Refresh] [Back] [Home]. Back appears only with somewhere to
 * return to; the Radar root shows neither Back nor Home.
 */
export function finishPanel(title, blocks, keyboard, snapshot, session, locale, { token = null, refresh = true } = {}) {
  const root = session.panel === 'radar';
  const footer = [
    refresh ? button(`${ICONS.refresh} ${localize(locale, '刷新', 'Refresh')}`, 'panel.refresh') : null,
    !root && session.query?.returnTo ? button(`${ICONS.back} ${localize(locale, '返回', 'Back')}`, 'panel.back') : null,
    root ? null : button(`${ICONS.home} ${localize(locale, '首页', 'Home')}`, 'panel.open', { panel: 'radar' })
  ];
  const text = `<b>${escapeHtml(title)}</b>\n${blocks.filter(value => value !== undefined && value !== null).join('\n')}\n\n${localize(locale, '更新于', 'Updated')} ${clockTime(snapshot.at, locale)}`;
  if (text.length > TELEGRAM_TEXT_BUDGET) throw new RangeError('Telegram panel exceeds text budget; paginate its source blocks');
  return { text, keyboard: [...keyboard, footer].map(row => row.filter(Boolean)).filter(row => row.length), version: session.version, ...(token ? { token } : {}) };
}

const reservedXPaths = new Set(['home','explore','search','intent','share','i','messages','notifications','settings','compose','login','signup','hashtag']);
export function officialXUrl(...values) {
  for (const value of values) {
    let input = String(value || '').trim();
    if (!input) continue;
    try {
      if (/^(https?:\/\/|(?:www\.)?(?:x|twitter)\.com(?:\/|$))/i.test(input)) {
        const url = new URL(/^https?:/.test(input) ? input : 'https://' + input);
        if (!['x.com','twitter.com'].includes(url.hostname.toLowerCase().replace(/^www\./, '')) || url.username || url.password) continue;
        input = url.pathname.split('/').filter(Boolean)[0] || '';
      } else input = input.replace(/^@/, '').split(/[/?#]/)[0];
    } catch (error) { if (error instanceof TypeError) continue; throw error; }
    if (/^[A-Za-z0-9_]{1,15}$/.test(input) && !reservedXPaths.has(input.toLowerCase())) return 'https://x.com/' + input;
  }
  return '';
}
