import assert from 'node:assert/strict';
import test from 'node:test';
import { renderPanel } from '../src/bot/panels.mjs';
import { projectTelegramCandidate } from '../src/bot/snapshot.mjs';
import { CHART_RISK_VERSION } from '../src/scoring/chart-risk.mjs';
import { KYBER_NATIVE_TOKEN } from '../src/trading/config.mjs';

const now = 1_800_000_000_000;
const TOKEN = '0x' + 'ab'.repeat(20);
const WALLET = '0x' + '12'.repeat(20);
const candidate = (changes = {}) => projectTelegramCandidate({ chain: 'bsc', address: TOKEN, symbol: 'MEME', status: 'LIVE_READY', auditedAt: now - 60_000, reviewRevision: 'revision',
  deep: { chainPass: true, chartRisk: { version: CHART_RISK_VERSION, pass: true }, checks: {}, failed: [], unknownFields: [], blockingUnknownFields: [] }, ...changes });
const trading = (changes = {}) => ({ chains: ['bsc', 'arc'], chainFacts: { bsc: { nativeSymbol: 'BNB', quoteDecimals: 18 }, arc: { nativeSymbol: 'USDC', quoteDecimals: 6 } },
  explorers: { bsc: 'https://bscscan.com', arc: null }, wallet: { address: WALLET, createdAt: now }, settings: { slippageBps: 500, capUsd: 100 }, trades: [],
  balances: { version: 1, sessionId: null, requestedAt: 0, pending: [], chains: {} }, exportIssue: false, ...changes });
const snapshot = (changes = {}, rows = [candidate()]) => ({ at: now, control: { configured: true, scanChain: 'bsc' }, candidates: rows, annotations: [], marks: [], events: [], queue: [], delivery: [], metrics: {}, sourceHealth: {}, feedByChain: {}, ave: {}, outcomes: [], trading: trading(changes) });
const detail = (value, locale = 'en') => renderPanel(value, { panel: 'detail', viewChain: 'bsc', query: { selectedToken: { chain: 'bsc', address: TOKEN } }, version: 1 }, locale);
const buttons = result => result.keyboard.flat();
const tradeActions = result => buttons(result).filter(item => /^trade\./.test(item.action)).map(item => [item.action, item.params]);

test('a tradable token detail offers buys up to the cap and sells', () => {
  assert.deepEqual(tradeActions(detail(snapshot())), [
    ['trade.buy', { usd: 10 }], ['trade.buy', { usd: 20 }], ['trade.buy', { usd: 50 }], ['trade.input', { side: 'buy' }],
    ['trade.sell', { percent: 25 }], ['trade.sell', { percent: 50 }], ['trade.sell', { percent: 100 }], ['trade.input', { side: 'sell' }]]);
  assert.deepEqual(tradeActions(detail(snapshot({ settings: { slippageBps: 500, capUsd: 20 } }))).filter(([action]) => action === 'trade.buy').map(([, params]) => params.usd), [10, 20]);
  assert.deepEqual(detail(snapshot()).keyboard.slice(0, 2).map(row => row.map(item => item.text)), [['Buy $10', 'Buy $20', 'Buy $50', 'Buy …'], ['Sell 25%', 'Sell 50%', 'Sell 100%', 'Sell …']]);
});

test('a safety veto hides the buy row with a reason and keeps selling', () => {
  const vetoed = detail(snapshot({}, [candidate({ status: 'HARD_REJECT' })]));
  assert.equal(tradeActions(vetoed).some(([action, params]) => action === 'trade.buy' || params.side === 'buy'), false);
  assert.equal(tradeActions(vetoed).filter(([action]) => action === 'trade.sell').length, 3);
  assert.match(vetoed.text, /buying is disabled/);
});

test('without a wallet the detail offers setup, and untradable chains offer nothing', () => {
  const setup = detail(snapshot({ wallet: null }));
  assert.deepEqual(tradeActions(setup), []);
  assert.ok(buttons(setup).some(item => item.action === 'panel.open' && item.params.panel === 'wallet' && item.text === 'Set up trading wallet'));
  const off = detail(snapshot({ chains: ['arc'] }));
  assert.deepEqual(tradeActions(off), []);assert.ok(!buttons(off).some(item => item.params?.panel === 'wallet'));
});

test('the confirm screen shows spend with its conversion, receive bounds, impact, slippage, gas and cap', () => {
  const trade = { id: 'f'.repeat(32), chain: 'bsc', token: TOKEN, side: 'buy', wallet: WALLET, usdCents: 1000, percent: null, slippageBps: 500, capUsd: 100, state: 'QUOTED', step: null,
    createdAt: now, tokenMeta: { decimals: 9, symbol: 'MEME' }, tokenIn: KYBER_NATIVE_TOKEN, tokenOut: TOKEN, amountIn: '16326530612244897', priceMicroUsd: '612500000',
    quote: { amountOut: '5000000000000', minAmountOut: '4750000000000', amountInUsd: '10', amountOutUsd: '9.5', gasUsd: '0.12', value: '16326530612244897', deadline: 1, quotedAt: now, expiresAt: now + 30_000 },
    confirmedAt: null, approval: null, swap: null, result: null };
  const result = renderPanel(snapshot({ trades: [trade] }), { panel: 'trade', viewChain: 'bsc', query: { tradeId: trade.id }, version: 1 }, 'en');
  for (const line of ['Spend: $10 ≈ 0.0163265 BNB (at $612.5/BNB)', 'Estimated receive: 5000 MEME', 'Minimum receive after slippage: 4750 MEME', 'Price impact (estimated): 5.00%', 'Slippage: 5%', 'Estimated gas: $0.1200', 'Per-trade buy cap: $100', '(30s)']) {
    assert.ok(result.text.includes(line), line);
  }
  assert.deepEqual(buttons(result).filter(item => item.action?.startsWith('trade.')).map(item => [item.text, item.action]), [['✅ Confirm', 'trade.confirm'], ['Cancel', 'trade.cancel']]);
  const zh = renderPanel(snapshot({ trades: [trade] }), { panel: 'trade', viewChain: 'bsc', query: { tradeId: trade.id }, version: 1 }, 'zh');
  assert.match(zh.text, /最少获得/);
});

test('the wallet panel shows the address, hot-wallet risk and management actions', () => {
  const result = renderPanel(snapshot({ balances: { version: 1, sessionId: null, requestedAt: 0, pending: ['arc'], chains: { bsc: { units: '1500000000000000000', error: null, at: now } } }, exportIssue: true }),
    { panel: 'wallet', viewChain: 'bsc', query: {}, version: 1 }, 'en');
  assert.ok(result.text.includes(`<code>${WALLET}</code>`));assert.match(result.text, /hot wallet/);assert.match(result.text, /BNB Chain: 1\.5 BNB/);assert.match(result.text, /Arc: Not read · refreshing/);
  assert.match(result.text, /export may not have arrived/);
  assert.deepEqual(buttons(result).map(item => item.action === 'panel.open' ? item.params.panel : item.action), ['wallet.refresh', 'trade_settings', 'wallet_export', 'wallet_remove', 'radar']);
});

test('a live trade offers Refresh and Back to its origin; the wallet refreshes balances instead', () => {
  const origin = { panel: 'detail', viewChain: 'bsc', query: { selectedToken: { chain: 'bsc', address: TOKEN } } };
  const trade = { id: 't1', chain: 'bsc', token: TOKEN, side: 'sell', percent: 50, state: 'QUOTING', tokenMeta: { symbol: 'MEME', decimals: 18 }, createdAt: now };
  const footer = result => result.keyboard.at(-1).map(item => item.action);
  assert.deepEqual(footer(renderPanel(snapshot({ trades: [trade] }), { panel: 'trade', viewChain: 'bsc', query: { tradeId: 't1', returnTo: origin }, version: 1 }, 'en')), ['panel.refresh', 'panel.back', 'panel.open']);
  const wallet = renderPanel(snapshot(), { panel: 'wallet', viewChain: 'bsc', query: {}, version: 1 }, 'en');
  assert.deepEqual(footer(wallet), ['panel.open']);
  assert.ok(buttons(wallet).some(item => item.action === 'wallet.refresh'));
});

test('the unverified-buy question names the token and amount and offers Yes then No before the footer', () => {
  const origin = { panel: 'detail', viewChain: 'bsc', query: { selectedToken: { chain: 'bsc', address: TOKEN } } };
  const question = (locale, rows = [candidate()]) => renderPanel(snapshot({}, rows), { panel: 'trade_unverified', viewChain: 'bsc', query: { unverifiedBuy: { chain: 'bsc', token: TOKEN, usdCents: 2550 }, returnTo: origin }, version: 1 }, locale);
  const en = question('en');
  for (const line of ['Safety check not finished', 'MEME · BNB Chain — buy $25.50?', 'have not verified this token yet', 'honeypot']) assert.ok(en.text.includes(line), line);
  assert.deepEqual(en.keyboard[0].map(item => [item.text, item.action]), [['Yes', 'trade.acknowledge_unverified'], ['No', 'trade.decline_unverified']]);
  assert.deepEqual(en.keyboard.at(-1).map(item => item.action), ['panel.back', 'panel.open']);
  assert.ok(!buttons(en).some(item => item.action === 'panel.refresh'));
  assert.match(question('zh').text, /安全核验未完成[\s\S]*买入 \$25\.50？/);
  assert.ok(question('en', []).text.includes(`<code>${TOKEN}</code>`), 'an unknown symbol falls back to the contract address');
});

test('the unverified-buy question says a pasted token\'s clean check is stale, unless a candidate is the token of record', () => {
  const stale = { chain: 'bsc', address: TOKEN, state: 'DONE', verdict: 'PASSED', stale: true, secondary: { checkedAt: now - 20 * 60_000 } };
  const question = (locale, rows) => renderPanel({ ...snapshot({}, rows), lookups: [stale] }, { panel: 'trade_unverified', viewChain: 'bsc', query: { unverifiedBuy: { chain: 'bsc', token: TOKEN, usdCents: 2550 } }, version: 1 }, locale).text;
  assert.match(question('en', []), /⚠️ Safety check is stale[\s\S]*GoPlus and DexScreener checked this token 20m ago; that check is stale\./);
  assert.doesNotMatch(question('en', []), /not finished|have not verified/);
  assert.match(question('zh', []), /⚠️ 安全核验已过期[\s\S]*GoPlus 和 DexScreener 于20分钟前核验此代币，结果已过期。/);
  assert.match(question('en', [candidate({ secondary: null })]), /Safety check not finished[\s\S]*have not verified this token yet/);
});

test('the quote screen repeats the warning only for a buy requested before the token was verified', () => {
  const trade = unverifiedAtRequest => ({ id: 'e'.repeat(32), chain: 'bsc', token: TOKEN, side: 'buy', usdCents: 1000, percent: null, state: 'QUOTING', tokenMeta: null, createdAt: now, unverifiedAtRequest });
  const render = value => renderPanel(snapshot({ trades: [trade(value)] }), { panel: 'trade', viewChain: 'bsc', query: { tradeId: 'e'.repeat(32) }, version: 1 }, 'en').text;
  assert.match(render(true), /⚠️ Requested before the safety check verified it\./);
  assert.doesNotMatch(render(false), /Requested before/);
});
