import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveEntryFeatures, derivePoolEntryFeature, entryCutoff } from '../scripts/arc-backtest/features.mjs';
const ZERO = '0x0000000000000000000000000000000000000000';
const owner = '0x1111111111111111111111111111111111111111';
const poolAddress = '0x2222222222222222222222222222222222222222';
const state = (blockNumber, event, eventData = {}, extra = {}) => ({ blockNumber, timestamp: blockNumber * 2, liquidity: '1000000', sqrtPriceX96: String(2n ** 96n), tick: 0, feePips: 10000, event, eventData, transactionHash: `tx${blockNumber}`, ...extra });
const pool = { id: poolAddress, token: '0x3333333333333333333333333333333333333333', venue: 'Uniswap v3', quoteDecimals: 6, tokenIs0: true, feePips: 10000, creationBlock: 100, states: [state(100, 'Initialize', {}, { liquidity: '0' }), state(101, 'Mint', { owner, tickLower: '-887220', tickUpper: '887220', amount: '1000000' }), state(102, 'Swap', { amount0: '1000', amount1: '-1000', sender: 'router' }), state(107, 'Swap', { amount0: '2000', amount1: '-2000', sender: 'future' })] };
const transfer = (blockNumber, from, to, value) => ({ blockNumber, from, to, value: String(value), transactionHash: `tx${blockNumber}`, transactionIndex: 0, logIndex: 0 });

test('entry features exclude later swaps and transfers and preserve input records', () => {
  const original = JSON.stringify(pool);
  const transfers = [transfer(100, ZERO, owner, 10000000), transfer(102, owner, poolAddress, 1000), transfer(107, owner, poolAddress, 2000)];
  const result = derivePoolEntryFeature(pool, 4, { transfers, supplyRaw: '10000000', decimals: 6, completeTransferHistory: true });
  assert.equal(result.entryBlock, 105); assert.equal(result.priorSellCount, 1); assert.equal(result.priorSuccessfulSellers, 1);
  assert.equal(result.priorSellRouterCount, 1); assert.equal(result.holderCount, 1); assert.equal(result.top1HolderShare, 0.9999);
  assert.equal(result.marketCapUsd, 10); assert.equal(JSON.stringify(pool), original); assert.equal(result.entryTimestamp, 210);
});

test('active virtual depth and LP principal remain separate quantities', () => {
  const narrow = { ...pool, states: [pool.states[0], state(101, 'Mint', { owner, tickLower: '-100', tickUpper: '100', amount: '1000000' })] };
  const result = derivePoolEntryFeature(narrow, 4);
  assert.equal(result.activeVirtualQuoteReserveUsd, 1);
  assert.ok(result.poolQuotePrincipalUsd < 0.01); assert.ok(result.poolSizeUsd < 0.02);
  assert.equal(result.stakeToDepthRatio, 2); assert.equal(result.activePositionCount, 1);
});

test('incomplete token history leaves holder features null rather than known zero', () => {
  const result = derivePoolEntryFeature(pool, 4, { transfers: [transfer(102, owner, poolAddress, 1000)], supplyRaw: '10000000' });
  assert.equal(result.holderCount, null); assert.equal(result.top1HolderShare, null);
  assert.equal(result.priorSuccessfulSellers, 1); assert.equal(result.marketCapUsd, 10);
});

test('a v4 sell uses negative token delta and transfer payer attribution', () => {
  const manager = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
  const v4 = { ...pool, venue: 'Uniswap v4', states: [pool.states[0], state(101, 'ModifyLiquidity', { sender: owner, salt: 'x', tickLower: '-100', tickUpper: '100', liquidityDelta: '1000000' }), state(102, 'Swap', { amount0: '-1000', amount1: '1000', sender: 'router' })] };
  const result = derivePoolEntryFeature(v4, 4, { transfers: [transfer(102, owner, manager, 1000)] });
  assert.equal(result.priorSellCount, 1); assert.equal(result.priorSuccessfulSellers, 1); assert.equal(result.priorSellVolumeUsd, 0.001);
});

test('dynamic fee before its first swap stays unknown and has no future fee lookahead', () => {
  const dynamic = { ...pool, feePips: 0x800000, states: [pool.states[0], state(101, 'Mint', { owner, tickLower: '-100', tickUpper: '100', amount: '1000000' }, { feePips: 0x800000 }), state(107, 'Swap', { amount0: '1000', amount1: '-1000' }, { feePips: 3000 })] };
  const result = derivePoolEntryFeature(dynamic, 4);
  assert.equal(result.observedPoolFeePips, null); assert.equal(result.dynamicFee, true); assert.equal(result.priorSwapCount, 0);
});

test('a negative transfer ledger reports unavailable holder accounting', () => {
  const result = derivePoolEntryFeature(pool, 4, { completeTransferHistory: true, transfers: [transfer(102, owner, poolAddress, 1000)] });
  assert.equal(result.holderCount, null); assert.equal(result.holderHistoryStatus, 'unavailable_nonstandard_transfer_accounting');
});

test('never funded pools retain their identity and have no artificial entry', () => {
  const unfunded = { ...pool, states: [pool.states[0]] };
  assert.equal(entryCutoff(unfunded, 4), null);
  assert.equal(derivePoolEntryFeature(unfunded, 4).featureStatus, 'never_funded');
});

test('multiple successful sell swaps in one transaction count one attributed transaction', () => {
  const sameTransaction = { ...pool, states: [...pool.states.slice(0, 3), { ...pool.states[2], logIndex: 2 }] };
  const result = derivePoolEntryFeature(sameTransaction, 4, { transfers: [transfer(102, owner, poolAddress, 2000)] });
  assert.equal(result.priorSellCount, 2); assert.equal(result.attributedSellSwaps, 2); assert.equal(result.attributedSellTransactions, 1);
  assert.equal(result.sellerAttributionCoverage, 1); assert.equal(result.priorSuccessfulSellers, 1);
});

test('late first liquidity defines entry delay rather than pool initialization', () => {
  const late = { ...pool, states: [pool.states[0], state(150, 'Mint', { owner, tickLower: '-100', tickUpper: '100', amount: '1000000' }), state(155, 'Swap', { amount0: '1000', amount1: '-1000', sender: 'later' })] };
  const result = derivePoolEntryFeature(late, 4);
  assert.equal(result.entryBlock, 154); assert.equal(result.entryTimestamp, 308); assert.equal(result.priorSwapCount, 0);
  assert.equal(result.poolAgeBlocks, 54);
});

test('historical RPC maps unordered batch results and offline cache reproduces entry features', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'arc-entry-feature-test-'));
  const originalFetch = globalThis.fetch;
  const requests = [];
  const token = pool.token;
  const topicAddress = value => `0x${value.slice(2).padStart(64, '0')}`;
  const rawTransfer = (block, from, to, value) => ({ address: token, topics: ['transfer', topicAddress(from), topicAddress(to)], data: `0x${BigInt(value).toString(16)}`, blockNumber: `0x${block.toString(16)}`, transactionHash: `tx${block}`, transactionIndex: '0x0', logIndex: '0x0' });
  globalThis.fetch = async (_url, options) => {
    const calls = JSON.parse(options.body); requests.push(...calls);
    const results = calls.map(call => ({ id: call.id, result: call.method === 'eth_getLogs'
      ? [rawTransfer(100, ZERO, owner, 10000000), rawTransfer(102, owner, poolAddress, 1000), rawTransfer(107, owner, poolAddress, 2000)]
      : call.method === 'eth_getCode' ? '0x' : call.params[0].data === '0x313ce567' ? '0x6' : '0x989680' })).reverse();
    return { ok: true, json: async () => results };
  };
  const dataset = { manifest: { eventDataThroughDelayBlocks: 20, blockSeconds: 2 }, pools: [pool] };
  try {
    const result = await deriveEntryFeatures(dataset, { cacheDirectory: directory, delays: [4, 6, 8], requestIntervalMs: 0 });
    assert.equal(result[0].marketCapUsd, 10); assert.equal(result[0].top1HolderShare, 0.9999); assert.equal(result[1].top1HolderShare, 0.9997);
    assert.equal(requests.filter(call => call.method === 'eth_call' && call.params[0].data === '0x18160ddd').length, 3);
    assert.equal(requests.find(call => call.method === 'eth_call' && call.params[0].data === '0x313ce567').params[1], '0x69');
    globalThis.fetch = async () => { throw new Error('Offline replay must not request the network'); };
    assert.deepEqual(await deriveEntryFeatures(dataset, { cacheDirectory: directory, delays: [4, 6, 8], requestIntervalMs: 0 }), result);
  } finally { globalThis.fetch = originalFetch; await rm(directory, { recursive: true, force: true }); }
});

test('legacy capture without decoded entry event payloads is rejected', async () => {
  await assert.rejects(deriveEntryFeatures({ manifest: {}, pools: [pool] }, { cacheDirectory: '/unused' }), /decoded historical event payloads/);
});
