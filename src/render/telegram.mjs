import { safeTelegramText, safeTelegramUrl } from '../bot/snapshot.mjs';

export const TELEGRAM_TEXT_BUDGET = 3500;
export const CHAIN_LABELS = Object.freeze({ sol: 'Solana', bsc: 'BNB Chain', base: 'Base', eth: 'Ethereum', robinhood: 'Robinhood', arc: 'Arc', stable: 'Stable' });
export const localize = (locale, zh, en) => locale === 'en' ? en : zh;
export const escapeHtml = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const userText = (value, max = 500) => escapeHtml(safeTelegramText(value, max));
export const chainLabel = chain => CHAIN_LABELS[chain] || chain;
export const button = (text, action, params = {}, token) => ({ text, action, params, ...(token ? { token } : {}) });
export const urlButton = (text, value) => { const url = safeTelegramUrl(value); return url ? { text, url } : null; };

export function numberText(value, locale = 'zh') {
  return typeof value === 'number' && Number.isFinite(value) ? new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'zh-CN', { maximumSignificantDigits: 8 }).format(value) : localize(locale, '未知', 'Unknown');
}
export function money(value, locale = 'zh') {
  if (typeof value !== 'number' || !Number.isFinite(value)) return localize(locale, '未知', 'Unknown');
  const magnitude = Math.abs(value);
  return '$' + (magnitude >= 1e6 ? numberText(value / 1e6, locale) + 'M' : magnitude >= 1e3 ? numberText(value / 1e3, locale) + 'K' : numberText(value, locale));
}
export function percent(value, locale = 'zh', signed = false) {
  return typeof value === 'number' && Number.isFinite(value) ? `${signed && value > 0 ? '+' : ''}${numberText(value * 100, locale)}%` : localize(locale, '未知', 'Unknown');
}
export function timestamp(value, locale = 'zh') {
  return typeof value === 'number' && value > 0 && Number.isFinite(value) && Math.abs(value) <= 8.64e15 ? new Date(value).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC') : localize(locale, '尚无记录', 'No record');
}
export function age(value, now, locale = 'zh') {
  if (!(value > 0)) return localize(locale, '未知', 'Unknown');
  const seconds = Math.max(0, Math.floor((now - value) / 1000));
  return localize(locale, `快照时${seconds < 60 ? seconds + '秒' : Math.floor(seconds / 60) + '分钟'}前`, `${seconds < 60 ? seconds + 's' : Math.floor(seconds / 60) + 'm'} ago at snapshot`);
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

export function finishPanel(title, blocks, keyboard, snapshot, session, locale, token) {
  const text = `<b>${escapeHtml(title)}</b>\n${blocks.filter(value => value !== undefined && value !== null).join('\n')}\n\n${localize(locale, '快照', 'Snapshot')} ${timestamp(snapshot.at, locale)}`;
  if (text.length > TELEGRAM_TEXT_BUDGET) throw new RangeError('Telegram panel exceeds text budget; paginate its source blocks');
  return { text, keyboard: keyboard.map(row => row.filter(Boolean)).filter(row => row.length), version: session.version, ...(token ? { token } : {}) };
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
