import { ICONS, button, chainLabel, duration, localize, money, percent, truth, userText } from '../render/telegram.mjs';
import { reasonText } from './panels.mjs';

/** A lead's recorded safety check, from its secondary evidence; absent evidence means it has not run yet. */
export function checkState(secondary) {
  if (!secondary) return 'CHECKING';
  return secondary.status === 'COMPLETE' && secondary.security?.verdict === 'NO_FATAL_FLAGS' ? 'PASSED' : 'INCOMPLETE';
}

const CHECK_ICONS = Object.freeze({ CHECKING: ICONS.checking, PASSED: ICONS.passed, INCOMPLETE: ICONS.unknown });
const label = token => token.symbol || token.address.slice(-8);
const tokenButton = (text, token) => button(text, 'panel.open', { panel: 'detail' }, { chain: token.chain, address: token.address });

function marketFacts(token, now, L, locale) {
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  return [
    finite(token.marketCap) ? L(`市值 ${money(token.marketCap, locale)}`, `${money(token.marketCap, locale)} MC`) : null,
    finite(token.liquidity) ? L(`流动性 ${money(token.liquidity, locale)}`, `${money(token.liquidity, locale)} liq`) : null,
    // createdAt is in seconds, as AVE reports it.
    finite(token.createdAt) && token.createdAt > 0 && token.createdAt * 1000 <= now ? L(`币龄 ${duration(now - token.createdAt * 1000, locale)}`, `${duration(now - token.createdAt * 1000, locale)} old`) : null,
    finite(token.priceChange5m) ? L(`5分钟 ${percent(token.priceChange5m, locale, true)}`, `5m ${percent(token.priceChange5m, locale, true)}`) : null
  ].filter(Boolean).join(' · ');
}

function newLeadsCard(tokens, now, L, locale) {
  const chains = [...new Set(tokens.map(token => chainLabel(token.chain)))].join(', ');
  // Markers only distinguish rows once some check has finished; otherwise the closing line covers them all.
  const marked = tokens.some(token => token.check !== 'CHECKING');
  const lines = [`<b>${ICONS.newLead} ${L(`${tokens.length} 个新线索`, `${tokens.length} new lead${tokens.length === 1 ? '' : 's'}`)} · ${userText(chains)}</b>`];
  tokens.forEach((token, index) => {
    const facts = marketFacts(token, now, L, locale);
    lines.push(`${index + 1}. ${marked ? `${CHECK_ICONS[token.check]} ` : ''}${userText(label(token), 30)}${facts ? ` — ${userText(facts)}` : ''}`);
  });
  lines.push(marked
    ? L(`${ICONS.checking} 检查中 · ${ICONS.passed} 未发现问题 · ${ICONS.unknown} 核验不完整。不构成安全保证。`, `${ICONS.checking} check running · ${ICONS.passed} no failures found · ${ICONS.unknown} incomplete. Not a safety guarantee.`)
    : L('安全检查仍在进行，尚未核验。', 'Safety check still running; not verified.'));
  const keyboard = [];
  const buttons = tokens.map((token, index) => tokenButton(`${index + 1} ${label(token).slice(0, 30)}`, token));
  for (let index = 0; index < buttons.length; index += 2) keyboard.push(buttons.slice(index, index + 2));
  keyboard.push([button(`${ICONS.audits} ${L('全部线索', 'All leads')}`, 'panel.open', { panel: 'audits' }), button(`${ICONS.alertsOff} ${L('关闭提醒', 'Mute alerts')}`, 'notifications.set', { value: false })]);
  return { lines, keyboard };
}

function riskCard(token, L, locale) {
  const name = userText(label(token), 30);
  const lines = [`<b>${ICONS.vetoed} ${L(`${name} 未通过安全检查`, `${name} failed the safety check`)} · ${chainLabel(token.chain)}</b>`];
  // The recorded fatal fields and their values, through the evidence labels; never upstream prose.
  const findings = token.fatal.map(({ field, value }) => `${reasonText(field, locale)}: ${truth(value, locale)}`);
  if (findings.length) lines.push(userText(L(`GoPlus 标记：${findings.join(' · ')}`, `GoPlus flagged: ${findings.join(' · ')}`)));
  lines.push(L('已禁止买入；仍可卖出。', 'Buying is blocked; selling still works.'));
  return { lines, keyboard: [[tokenButton(L(`打开 ${label(token).slice(0, 30)}`, `Open ${label(token).slice(0, 30)}`), token)]] };
}

function accountCard(issue, L) {
  if (issue.reason === 'KEY_UNUSABLE') return {
    lines: [`<b>${ICONS.key} ${L('你的AVE密钥已失效', 'Your AVE key stopped working')}</b>`],
    keyboard: [[button(`${ICONS.key} ${L('重新连接AVE', 'Reconnect AVE')}`, 'panel.open', { panel: 'onboard' })]]
  };
  const title = issue.reason === 'DELIVERY_UNCERTAIN' ? `${ICONS.delivery} ${L('部分消息可能未送达', 'Some messages may not have arrived')}` : `${ICONS.unknown} ${L('雷达需要处理', 'The radar needs attention')}`;
  return { lines: [`<b>${title}</b>`], keyboard: [[button(`${ICONS.status} ${L('状态', 'Status')}`, 'panel.open', { panel: 'status' })]] };
}

/**
 * Render one alert. `tokens` aligns with the notification's members and carries
 * only recorded facts; any missing fact is left out rather than blocking the alert.
 */
export function alertCard(notification, tokens, { locale, now }) {
  const L = (zh, en) => localize(locale, zh, en);
  const { lines, keyboard } = notification.actionReason === 'CANDIDATE_NEW' ? newLeadsCard(tokens, now, L, locale)
    : notification.actionReason === 'RISK_WORSENED' ? riskCard(tokens[0], L, locale)
      : accountCard(notification.issue, L);
  return { text: lines.join('\n'), keyboard };
}
