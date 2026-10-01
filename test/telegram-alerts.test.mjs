import assert from 'node:assert/strict';
import test from 'node:test';
import { alertCard, checkState } from '../src/bot/alerts.mjs';

const now = 1_800_000_000_000;
const newLeads = { actionReason: 'CANDIDATE_NEW', members: [] };
const lead = (symbol, overrides = {}) => ({ chain: 'arc', address: `0x${symbol.toLowerCase().padStart(40, '0')}`, symbol, marketCap: null, liquidity: null, createdAt: null, priceChange5m: null, check: 'CHECKING', fatal: [], ...overrides });
const pepe = lead('PEPE', { marketCap: 120_400, liquidity: 30_100, createdAt: (now - 4 * 60_000) / 1000, priceChange5m: 0.35 });
const doge = lead('DOGE2', { marketCap: 48_000, liquidity: 9_000, createdAt: (now - 61_000) / 1000, priceChange5m: -0.08 });
const buttons = keyboard => keyboard.flat().map(({ text, action, params, token }) => ({ text, action, params, ...(token ? { token } : {}) }));

test('checkState reads the recorded secondary check: none yet, complete without fatal flags, or anything else', () => {
  for (const [secondary, expected] of [
    [null, 'CHECKING'],
    [{ status: 'COMPLETE', security: { verdict: 'NO_FATAL_FLAGS' } }, 'PASSED'],
    [{ status: 'DEGRADED', security: { verdict: 'NO_FATAL_FLAGS' } }, 'INCOMPLETE'],
    [{ status: 'COMPLETE', security: { verdict: 'UNKNOWN' } }, 'INCOMPLETE'],
    [{ status: 'DEGRADED', security: { verdict: 'UNSUPPORTED' } }, 'INCOMPLETE'],
    [{ status: 'COMPLETE', security: { verdict: 'FATAL' } }, 'INCOMPLETE']
  ]) assert.equal(checkState(secondary), expected, JSON.stringify(secondary));
});

test('a new-lead batch shows market facts per row, the chain, and leads plus mute buttons without a Status button', () => {
  const { text, keyboard } = alertCard(newLeads, [pepe, doge], { locale: 'en', now });
  assert.equal(text, [
    '<b>🆕 2 new leads · Arc</b>',
    '1. PEPE — $120K MC · $30.1K liq · 4m old · 5m +35%',
    '2. DOGE2 — $48K MC · $9K liq · 1m old · 5m -8%',
    'Safety check still running; not verified.'
  ].join('\n'));
  assert.doesNotMatch(text, /Action required/);
  assert.deepEqual(keyboard.map(row => row.length), [2, 2]);
  assert.deepEqual(buttons(keyboard), [
    { text: '1 PEPE', action: 'panel.open', params: { panel: 'detail' }, token: { chain: 'arc', address: pepe.address } },
    { text: '2 DOGE2', action: 'panel.open', params: { panel: 'detail' }, token: { chain: 'arc', address: doge.address } },
    { text: '🎯 All leads', action: 'panel.open', params: { panel: 'audits' } },
    { text: '🔕 Mute alerts', action: 'notifications.set', params: { value: false } }
  ]);
});

test('a new-lead row leaves out each missing fact instead of printing a placeholder', () => {
  const sparse = lead('BARE', { liquidity: 5_000, createdAt: (now + 60_000) / 1000 });
  const { text } = alertCard(newLeads, [sparse, lead('NONE', { symbol: '' })], { locale: 'en', now });
  const lines = text.split('\n');
  assert.equal(lines[0], '<b>🆕 2 new leads · Arc</b>');
  assert.equal(lines[1], '1. BARE — $5K liq');
  assert.equal(lines[2], '2. 0000none', 'no symbol falls back to the address tail and no facts leave a bare row');
  assert.doesNotMatch(text, /Unknown|NaN|undefined|null/);
});

test('rows are marked with their check state once any check has finished', () => {
  const { text } = alertCard(newLeads, [lead('WAIT'), lead('OK', { check: 'PASSED' }), lead('PART', { check: 'INCOMPLETE' })], { locale: 'en', now });
  const lines = text.split('\n');
  assert.equal(lines[0], '<b>🆕 3 new leads · Arc</b>');
  assert.deepEqual(lines.slice(1, 4), ['1. ⏳ WAIT', '2. ✅ OK', '3. ⚠️ PART']);
  assert.equal(lines[4], '⏳ check running · ✅ no failures found · ⚠️ incomplete. Not a safety guarantee.');
  assert.doesNotMatch(text, /still running; not verified/, 'the blanket line would be false for checked rows');
});

test('a finished but incomplete check alone is enough to mark rows and replace the still-running line', () => {
  const { text } = alertCard(newLeads, [lead('WAIT'), lead('PART', { check: 'INCOMPLETE' })], { locale: 'zh', now });
  assert.deepEqual(text.split('\n'), ['<b>🆕 2 个新线索 · Arc</b>', '1. ⏳ WAIT', '2. ⚠️ PART', '⏳ 检查中 · ✅ 未发现问题 · ⚠️ 核验不完整。不构成安全保证。']);
});

test('a single new lead is singular and an odd batch keeps the last token button alone on its row', () => {
  const { text, keyboard } = alertCard(newLeads, [pepe, doge, lead('ODD')], { locale: 'en', now });
  assert.match(text, /^<b>🆕 3 new leads · Arc<\/b>/);
  assert.deepEqual(keyboard.map(row => row.length), [2, 1, 2]);
  assert.match(alertCard(newLeads, [pepe], { locale: 'en', now }).text, /^<b>🆕 1 new lead · Arc<\/b>/);
});

test('a new-lead batch renders in Chinese with the same facts', () => {
  const { text, keyboard } = alertCard(newLeads, [pepe], { locale: 'zh', now });
  assert.equal(text, ['<b>🆕 1 个新线索 · Arc</b>', '1. PEPE — 市值 $120K · 流动性 $30.1K · 币龄 4分钟 · 5分钟 +35%', '安全检查仍在进行，尚未核验。'].join('\n'));
  assert.deepEqual(buttons(keyboard).slice(1).map(button => button.text), ['🎯 全部线索', '🔕 关闭提醒']);
});

test('token symbols are escaped as user text in every alert', () => {
  const hostile = lead('<b>X</b>&', { check: 'PASSED' });
  for (const notification of [newLeads, { actionReason: 'RISK_WORSENED', members: [] }]) {
    const { text } = alertCard(notification, [hostile], { locale: 'en', now });
    assert.match(text, /&lt;b&gt;X&lt;\/b&gt;&amp;/);
    assert.doesNotMatch(text, /<b>X<\/b>/);
  }
});

test('a risk alert names the token, the recorded fatal findings and that only buying is blocked', () => {
  const vetoed = lead('PEPE', { fatal: [{ field: 'isHoneypot', value: true }, { field: 'openSource', value: false }] });
  const { text, keyboard } = alertCard({ actionReason: 'RISK_WORSENED', members: [] }, [vetoed], { locale: 'en', now });
  assert.equal(text, ['<b>⛔ PEPE failed the safety check · Arc</b>', 'GoPlus flagged: Honeypot: Yes · Open source: No', 'Buying is blocked; selling still works.'].join('\n'));
  assert.deepEqual(buttons(keyboard), [{ text: 'Open PEPE', action: 'panel.open', params: { panel: 'detail' }, token: { chain: 'arc', address: vetoed.address } }]);
  const zh = alertCard({ actionReason: 'RISK_WORSENED', members: [] }, [vetoed], { locale: 'zh', now }).text;
  assert.equal(zh, ['<b>⛔ PEPE 未通过安全检查 · Arc</b>', 'GoPlus 标记：貔貅风险：是 · 开源：否', '已禁止买入；仍可卖出。'].join('\n'));
});

test('a risk alert without readable findings still names the token and the blocked buy', () => {
  const { text, keyboard } = alertCard({ actionReason: 'RISK_WORSENED', members: [] }, [lead('PEPE')], { locale: 'en', now });
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
    const { text, keyboard } = alertCard({ actionReason: 'ACCOUNT_ACTION_REQUIRED', members: [], issue }, [], { locale, now });
    assert.equal(text, expectedText);
    assert.deepEqual(buttons(keyboard), [expectedButton]);
  }
});
