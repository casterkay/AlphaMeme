import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, encodeEventTopics, parseAbiParameters } from 'viem';
import { EVENT_ABIS, decodeArcEvent, advancePoolState } from '../scripts/arc-backtest/collect.mjs';

const id = `0x${'12'.repeat(32)}`, address = `0x${'34'.repeat(20)}`;
function logFor(eventName, indexedArgs, types, values) {
  return { removed: false, topics: encodeEventTopics({ abi: EVENT_ABIS.v4, eventName, args: indexedArgs }), data: encodeAbiParameters(parseAbiParameters(types), values) };
}

test('Arc v4 decoding retains signed liquidity removal and swap fee', () => {
  const event = decodeArcEvent(logFor('ModifyLiquidity', { id, sender: address }, 'int24,int24,int256,bytes32', [-100, 100, -50n, id]), EVENT_ABIS.v4);
  assert.equal(event.args.liquidityDelta, -50n);
  const removed = advancePoolState({ sqrtPriceX96: '100', liquidity: '75', tick: 0, feePips: 2500 }, event);
  assert.equal(removed.liquidity, '25');
  const swap = decodeArcEvent(logFor('Swap', { id, sender: address }, 'int128,int128,uint160,uint128,int24,uint24', [25n, -10n, 120n, 400n, -20, 10_000]), EVENT_ABIS.v4);
  assert.deepEqual(advancePoolState(removed, swap), { sqrtPriceX96: '120', liquidity: '400', tick: -20, feePips: 10_000 });
});

test('Liquidity modifications use inclusive lower tick and exclusive upper tick', () => {
  const prior = { sqrtPriceX96: '100', liquidity: '75', tick: 10, feePips: 2500 };
  for (const [lower, upper, expected] of [[10, 20, '100'], [0, 10, '75'], [11, 20, '75']]) {
    const next = advancePoolState(prior, { eventName: 'ModifyLiquidity', args: { tickLower: lower, tickUpper: upper, liquidityDelta: 25n } });
    assert.equal(next.liquidity, expected);
  }
  assert.equal(prior.liquidity, '75');
});

test('V3 burn can remove all active liquidity and invalid negative liquidity fails', () => {
  const prior = { sqrtPriceX96: '100', liquidity: '75', tick: 0, feePips: 3000 };
  const event = { eventName: 'Burn', args: { tickLower: -10, tickUpper: 10, amount: 75n } };
  assert.equal(advancePoolState(prior, event).liquidity, '0');
  assert.throws(() => advancePoolState(prior, { ...event, args: { ...event.args, amount: 76n } }), /negative/);
});

test('V4 initialization preserves dynamic fee flag until Swap reports actual fee', () => {
  const event = decodeArcEvent(logFor('Initialize', { id, currency0: address, currency1: `0x${'56'.repeat(20)}` }, 'uint24,int24,address,uint160,int24', [0x800000, 200, address, 100n, -20]), EVENT_ABIS.v4);
  assert.deepEqual(advancePoolState(undefined, event), { sqrtPriceX96: '100', liquidity: '0', tick: -20, feePips: 0x800000 });
});
