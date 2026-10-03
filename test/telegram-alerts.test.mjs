import assert from 'node:assert/strict';
import test from 'node:test';
import { alertCard } from '../src/bot/alerts.mjs';
import { renderPanel } from '../src/bot/panels.mjs';
import { projectTelegramCandidate, projectTelegramFeedRow } from '../src/bot/snapshot.mjs';

const now = 1_800_000_000_000;
const lead = (symbol, overrides = {}) => ({ chain: 'arc', address: `0x${symbol.toLowerCase().replace(/[^0-9a-z]/g, '').padStart(40, '0')}`, symbol, marketCap: null, liquidity: null, createdAt: null, fatal: [], ...overrides });
const buttons = keyboard => keyboard.flat().map(({ text, action, params, token }) => ({ text, action, params, ...(token ? { token } : {}) }));
const clean = { status: 'COMPLETE', security: { verdict: 'NO_FATAL_FLAGS', fatal: [] } };

// A token's alert as the 'alert' panel renders it from a snapshot; `feed` is its hot-list row.
function alert(recorded, { locale = 'en', feed = null } = {}) {
  const row = projectTelegramCandidate({ status: 'LIVE_READY', auditedAt: now - 60_000, reviewRevision: 'revision', deep: {}, ...recorded });
  const snapshot = { at: now, candidates: [row], annotations: [], marks: [], feedByChain: { arc: { rows: feed ? [projectTelegramFeedRow({ address: recorded.address, ...feed }, 'arc')] : [] } } };
  return renderPanel(snapshot, { panel: 'alert', viewChain: 'arc', query: { selectedToken: { chain: 'arc', address: recorded.address } }, version: 0 }, locale);
}
const pepe = lead('PEPE', { marketCap: 120_400, liquidity: 30_100, createdAt: (now - 4 * 60_000) / 1000 });

test('a new-lead alert names one token with its facts, check state and address, and opens it, lists leads or mutes', () => {
  const { text, keyboard, token } = alert(pepe, { feed: { priceChange5m: 0.35 } });
  assert.equal(text, [
    '<b>🆕 New lead · PEPE · Arc</b>',
    '$120K MC · $30.1K liq · 4m old · 5m +35%',
    '⏳ Checking',
    `<code>${pepe.address}</code>`,
    'Safety check still running; not verified.',
    '',
    'Updated Jan 15 08:00 UTC'
  ].join('\n'));
  assert.deepEqual(token, { chain: 'arc', address: pepe.address }, 'the alert is tracked so later checks edit it');
  assert.deepEqual(buttons(keyboard), [
    { text: 'Open PEPE', action: 'panel.open', params: { panel: 'detail' }, token: { chain: 'arc', address: pepe.address } },
    { text: '🎯 All leads', action: 'panel.open', params: { panel: 'audits' } },
    { text: '🔕 Mute alerts', action: 'notifications.set', params: { value: false } }
  ]);
});

test('a new-lead alert renders in Chinese with the same facts', () => {
  const lines = alert(pepe, { locale: 'zh', feed: { priceChange5m: 0.35 } }).text.split('\n');
  assert.deepEqual(lines.slice(0, 3), ['<b>🆕 新线索 · PEPE · Arc</b>', '市值 $120K · 流动性 $30.1K · 币龄 4分钟 · 5分钟 +35%', '⏳ 检查中']);
  assert.equal(lines[4], '安全检查仍在进行，尚未核验。');
});

test('a new-lead alert leaves out each missing fact instead of printing a placeholder', () => {
  const lines = alert(lead('NONE', { symbol: '', liquidity: 5_000, createdAt: (now + 60_000) / 1000 })).text.split('\n');
  assert.equal(lines[0], '<b>🆕 New lead · 0000none · Arc</b>', 'no symbol falls back to the address tail');
  assert.equal(lines[1], '$5K liq');
  assert.doesNotMatch(lines.join('\n'), /Unknown|NaN|undefined|null/);
});

test('an edited alert shows each finished check with the shared badge, and a veto says buying is blocked', () => {
  for (const [secondary, extra, expected, closing] of [
    [clean, {}, '✅ No failures found', 'Checks are not a safety guarantee.'],
    [{ ...clean, status: 'DEGRADED' }, {}, '⚠️ Needs review', 'Checks are not a safety guarantee.'],
    [clean, { status: 'LIVE_READY', deep: { failed: [], blockingUnknownFields: ['lpBurned'] } }, '⚠️ Needs review', 'Checks are not a safety guarantee.'],
    [{ ...clean, security: { verdict: 'FATAL', fatal: [{ field: 'isHoneypot' }] } }, { status: 'HARD_REJECT' }, '⛔ Vetoed: Honeypot', 'Buying is blocked; selling still works.']
  ]) {
    const lines = alert({ ...pepe, secondary, ...extra }).text.split('\n');
    assert.match(lines[2], new RegExp(`^${expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.doesNotMatch(lines[2], /ago/, 'an alert is not re-rendered as time passes, so it states no relative time');
    assert.equal(lines[4], closing);
  }
  assert.equal(alert({ ...pepe, status: 'HARD_REJECT', secondary: { ...clean, security: { verdict: 'FATAL', fatal: [{ field: 'isHoneypot' }] } } }).text.split('\n')[0], '<b>⛔ PEPE failed the safety check · Arc</b>');
});

test('token symbols are escaped as user text in every alert', () => {
  const hostile = lead('<b>X</b>&');
  for (const text of [alert(hostile).text, alertCard({ actionReason: 'RISK_WORSENED', members: [] }, [hostile], { locale: 'en' }).text]) {
    assert.match(text, /&lt;b&gt;X&lt;\/b&gt;&amp;/);
    assert.doesNotMatch(text, /<b>X<\/b>/);
  }
});

test('a new lead is never rendered as a notice card', () => {
  assert.throws(() => alertCard({ actionReason: 'CANDIDATE_NEW', members: [] }, [pepe], { locale: 'en' }), RangeError);
});

test('a risk alert names the token, the recorded fatal findings and that only buying is blocked', () => {
  const vetoed = lead('PEPE', { fatal: [{ field: 'isHoneypot', value: true }, { field: 'openSource', value: false }] });
  const { text, keyboard } = alertCard({ actionReason: 'RISK_WORSENED', members: [] }, [vetoed], { locale: 'en' });
  assert.equal(text, ['<b>⛔ PEPE failed the safety check · Arc</b>', 'GoPlus flagged: Honeypot: Yes · Open source: No', 'Buying is blocked; selling still works.'].join('\n'));
  assert.deepEqual(buttons(keyboard), [{ text: 'Open PEPE', action: 'panel.open', params: { panel: 'detail' }, token: { chain: 'arc', address: vetoed.address } }]);
  const zh = alertCard({ actionReason: 'RISK_WORSENED', members: [] }, [vetoed], { locale: 'zh' }).text;
  assert.equal(zh, ['<b>⛔ PEPE 未通过安全检查 · Arc</b>', 'GoPlus 标记：貔貅风险：是 · 开源：否', '已禁止买入；仍可卖出。'].join('\n'));
});

test('a risk alert states a vetoing tax as a percentage', () => {
  const vetoed = lead('PEPE', { fatal: [{ field: 'sellTax', value: 0.3 }] });
  const { text } = alertCard({ actionReason: 'RISK_WORSENED', members: [] }, [vetoed], { locale: 'en' });
  assert.equal(text.split('\n')[1], 'GoPlus flagged: Sell tax: 30%');
});

test('a risk alert without readable findings still names the token and the blocked buy', () => {
  const { text, keyboard } = alertCard({ actionReason: 'RISK_WORSENED', members: [] }, [lead('PEPE')], { locale: 'en' });
  assert.equal(text, ['<b>⛔ PEPE failed the safety check · Arc</b>', 'Buying is blocked; selling still works.'].join('\n'));
  assert.equal(keyboard.flat().length, 1);
});

test('account alerts carry the button that resolves them and no generic title', () => {
  for (const [issue, locale, expectedText, expectedButton] of [
    [{ key: 'ave-unusable', reason: 'KEY_UNUSABLE', nextAction: '/onboard' }, 'en', '<b>🔑 Your AVE key stopped working</b>', { text: '🔑 Reconnect AVE', action: 'panel.open', params: { panel: 'onboard' } }],
    [{ key: 'ave-unusable', reason: 'KEY_UNUSABLE', nextAction: '/onboard' }, 'zh', '<b>🔑 你的AVE密钥已失效</b>', { text: '🔑 重新连接AVE', action: 'panel.open', params: { panel: 'onboard' } }],
    [{ key: 'delivery-uncertain', reason: 'DELIVERY_UNCERTAIN', nextAction: '/status' }, 'en', '<b>📭 Some messages may not have arrived</b>', { text: '📊 Status', action: 'panel.open', params: { panel: 'status' } }],
    [{ key: 'delivery-uncertain', reason: 'DELIVERY_UNCERTAIN', nextAction: '/status' }, 'zh', '<b>📭 部分消息可能未送达</b>', { text: '📊 状态', action: 'panel.open', params: { panel: 'status' } }]
  ]) {
    const { text, keyboard } = alertCard({ actionReason: 'ACCOUNT_ACTION_REQUIRED', members: [], issue }, [], { locale });
    assert.equal(text, expectedText);
    assert.deepEqual(buttons(keyboard), [expectedButton]);
  }
});
