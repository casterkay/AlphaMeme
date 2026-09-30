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
