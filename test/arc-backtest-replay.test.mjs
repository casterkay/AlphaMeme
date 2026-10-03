import test from 'node:test';
import assert from 'node:assert/strict';
import { POLICIES, normalizeSecurity, replay, market, buyFill, sellFill, runMatrix } from '../scripts/arc-backtest/replay.mjs';

const clean = { honeypot: false, buyTax: 0, sellTax: 0 };
const costs = { slippageBps: 0, gasPriceUsdPerUnit: 0 };
function point(blockNumber, price, liquidity = 1e9) {
  return { blockNumber, timestamp: blockNumber, sqrtPriceX96: BigInt(Math.round(Math.sqrt(price) * 2 ** 96)).toString(),
    liquidity: BigInt(liquidity).toString(), tick: 0, feePips: 0 };
}
function pool(states) { return { token: 'token', id: 'pool', tokenIs0: true, quoteDecimals: 0, feePips: 0, states }; }

test('honeypot blocks selling but never screens the immediate buy', () => {
  const result = replay(pool([point(0, 1), point(2, 3)]), { ...clean, honeypot: true }, 1, POLICIES[0], 1,
    { slippageBps: 0, gasPriceUsdPerUnit: 1e-8 });
  assert.equal(result.entered, true);
  assert.equal(result.spentUsd, 2);
  assert.equal(result.proceedsUsd, 0);
  assert.equal(result.failedExits, 1);
  assert.equal(result.gasUsd, 0.0055);
  assert.equal(result.exitReason, 'honeypot');
});

for (const policy of POLICIES) test(`${policy.name} sells the original fraction once and trails only the remainder`, () => {
  const source = pool([point(0, 1), point(2, 4), point(3, 4), point(4, 3), point(5, 3)]);
  const before = JSON.stringify(source);
  const result = replay(source, clean, 1, policy, 1, costs);
  const [buy, partial, rest] = result.fills;
  assert.equal(partial.reason, 'take_profit');
  assert.equal(partial.blockNumber, 3);
  assert.equal(rest.reason, 'trailing_stop');
  assert.equal(rest.blockNumber, 5);
  assert.ok(Math.abs(partial.quantity / buy.quantity - policy.fraction) < 1e-12);
  assert.ok(Math.abs(partial.quantity + rest.quantity - buy.quantity) < 1e-12);
  assert.equal(result.fills.length, 3);
  assert.equal(JSON.stringify(source), before);
});

test('ATH before the take-profit fill is retained when the trailing stop activates', () => {
  const result = replay(pool([point(0, 1), point(2, 4), point(3, 2.5), point(4, 2.4)]), clean, 1, POLICIES[0], 1, costs);
  assert.equal(result.fills[1].blockNumber, 3);
  assert.equal(result.fills[2].blockNumber, 4);
  assert.equal(result.fills[2].reason, 'trailing_stop');
});

test('a ten percent retracement before take-profit waits for the time stop', () => {
  const result = replay(pool([point(0, 1), point(2, 1.8), point(3, 1.2)]), clean, 1, POLICIES[0], 1, costs);
  assert.equal(result.fills.length, 2);
  assert.equal(result.fills[1].reason, 'time_stop');
  assert.equal(result.fills[1].blockNumber, 1202);
});

test('a stop-loss gap fills at the following block rather than the trigger price', () => {
  const result = replay(pool([point(0, 1), point(2, 0.4), point(3, 0.2)]), clean, 1, POLICIES[0], 1, costs);
  assert.equal(result.exitReason, 'stop_loss');
  assert.equal(result.fills[1].blockNumber, 3);
  assert.ok(result.proceedsUsd < 0.41);
});

test('an entry already below its stop exits next block without waiting for another swap', () => {
  for (const [liquidity, buyTax] of [[1, 0], [1e9, 0.6]]) {
    const result = replay(pool([point(0, 1, liquidity)]), { ...clean, buyTax }, 1, POLICIES[0], 1, costs);
    assert.equal(result.exitReason, 'stop_loss');
    assert.equal(result.fills[1].blockNumber, 2);
    assert.ok(result.netUsd < 0);
  }
});

test('liquidity removed between trigger and execution leaves zero proceeds and charges failed gas', () => {
  const result = replay(pool([point(0, 1), point(2, 4), point(3, 4, 0)]), clean, 1, POLICIES[0], 1,
    { slippageBps: 0, gasPriceUsdPerUnit: 1e-8 });
  assert.equal(result.exitReason, 'liquidity_disappeared');
  assert.equal(result.proceedsUsd, 0);
  assert.equal(result.failedExits, 1);
  assert.equal(result.netUsd, -2.0055);
});

test('the twenty-minute timer executes without any subsequent swaps', () => {
  const result = replay(pool([point(0, 1)]), clean, 1, POLICIES[0], 0.5, costs);
  assert.equal(result.fills[1].reason, 'time_stop');
  assert.equal(result.fills[1].blockNumber, 2402);
});

test('delayed entry uses the state after all swaps in its entry block', () => {
  const result = replay(pool([point(0, 1), point(1, 2), point(1, 4)]), clean, 1, POLICIES[0], 1, costs);
  assert.ok(Math.abs(result.fills[0].quantity - 0.5) < 1e-7);
});

test('fees, taxes, slippage and thin-pool impact reduce received tokens and proceeds', () => {
  const depth = { tokenReserve: 10, quoteReserveUsd: 10, fee: 0.01 };
  const bought = buyFill(depth, 2, 0.1, 100);
  const sold = sellFill(depth, bought, 0.2, 100);
  assert.ok(bought < 1.5);
  assert.ok(sold < 1.1);
  assert.ok(buyFill({ ...depth, fee: 0 }, 2, 0, 0) < 2);
});

test('native and ERC20 USDC decimal scales produce the same economic price', () => {
  for (const quoteDecimals of [6, 18]) {
    const squareRootPrice = Math.sqrt(10 ** quoteDecimals);
    const state = { ...point(0, 1), sqrtPriceX96: BigInt(Math.round(squareRootPrice * 2 ** 96)).toString() };
    assert.ok(Math.abs(market({ ...pool([]), quoteDecimals }, state).price - 1) < 1e-12);
  }
});

test('zero-valued sell flags and LP lock do not manufacture honeypot evidence', () => {
  assert.deepEqual(normalizeSecurity({ can_sell: 0, can_not_sell: 0, is_locked: false }), { honeypot: null, buyTax: null, sellTax: null });
  assert.equal(normalizeSecurity({ is_honeypot: false, honeypot: 1 }).honeypot, null);
  assert.deepEqual(normalizeSecurity({ is_honeypot: false, honeypot: 0, buy_tax: '0', sell_tax: '0.05' }), { honeypot: false, buyTax: 0, sellTax: 0.05 });
});

test('missing security stays in every matrix cell and has an explicit conservative scenario', () => {
  const results = runMatrix({ manifest: { blockSeconds: 1 }, pools: [pool([point(0, 1), point(25, 4)])] }, {}, costs);
  assert.equal(results.rows.length, 15);
  assert.ok(results.rows.every(row => row.entered === 1 && row.securityUnknown === 1));
  assert.ok(results.rows.every(row => row.conservativeNetUsd === -2));
  assert.ok(results.rows.every(row => row.netUsd > row.conservativeNetUsd));
});

test('positions without a full holding horizon are reported without fabricated liquidation', () => {
  const result = replay(pool([point(0, 1)]), clean, 1, POLICIES[0], 1, { ...costs, captureToTimestamp: 100 });
  assert.equal(result.exitReason, 'incomplete_horizon');
  assert.equal(result.entered, false);
  assert.equal(result.netUsd, 0);
  assert.equal(result.gasUsd, 0);
});
