import { ICONS, button, chainLabel, localize, truth, userText } from '../render/telegram.mjs';
import { reasonText } from './panels.mjs';

const label = token => token.symbol || token.address.slice(-8);
const tokenButton = (text, token) => button(text, 'panel.open', { panel: 'detail' }, { chain: token.chain, address: token.address });

function riskCard(token, L, locale) {
  const name = userText(label(token), 30);
  const lines = [`<b>${ICONS.vetoed} ${L(`${name} 未通过安全检查`, `${name} failed the safety check`)} · ${chainLabel(token.chain)}</b>`];
  // The recorded fatal fields and their values, through the evidence labels; never upstream prose.
  const findings = token.fatal.map(({ field, value }) => `${reasonText(field, locale)}${L('：', ': ')}${truth(value, locale)}`);
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
 * Render a risk or account notice. A new lead is the 'alert' panel instead, since it is edited in place.
 * `tokens` aligns with the notification's members and carries only recorded facts.
 */
export function alertCard(notification, tokens, { locale }) {
  const L = (zh, en) => localize(locale, zh, en);
  if (!['RISK_WORSENED', 'ACCOUNT_ACTION_REQUIRED'].includes(notification.actionReason)) throw new RangeError(`no notice for ${notification.actionReason}`);
  const { lines, keyboard } = notification.actionReason === 'RISK_WORSENED' ? riskCard(tokens[0], L, locale) : accountCard(notification.issue, L);
  return { text: lines.join('\n'), keyboard };
}
