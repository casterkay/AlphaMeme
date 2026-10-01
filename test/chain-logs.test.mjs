import test from 'node:test';
import assert from 'node:assert/strict';
import { ChainLogs, ChainLogsError, MAX_LOG_BLOCKS, POOL_SOURCES, decodePoolLog, nextLogRange, parseAlchemyApiKey } from '../src/providers/chain-logs.mjs';

const ZERO = '0x0000000000000000000000000000000000000000';
const USDC = '0x3600000000000000000000000000000000000000';
const TOKEN = '0x' + 'ab'.repeat(20), OTHER = '0x' + 'cd'.repeat(20);
const topic = address => '0x' + '0'.repeat(24) + address.slice(2);
const word = hex => hex.replace(/^0x/, '').padStart(64, '0');
const POOL = '0x' + '12'.repeat(20), POOL_ID = '0x' + '34'.repeat(32);
const block = '0x3e8';
const logs = {
  v2: (token0, token1, address = '0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f') => ({ address, blockNumber: block, data: '0x' + word(POOL) + word('0x1'),
    topics: ['0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9', topic(token0), topic(token1)] }),
  v3: (token0, token1, address = '0xf0db7b58379503491d857db50ac9ece64c653918') => ({ address, blockNumber: block, data: '0x' + word('0x3c') + word(POOL),
    topics: ['0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118', topic(token0), topic(token1), '0x' + word('0xbb8')] }),
  v4: (currency0, currency1) => ({ address: '0x8366a39cc670b4001a1121b8f6a443a643e40951', blockNumber: block, data: '0x' + word('0x0'),
    topics: ['0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438', POOL_ID, topic(currency0), topic(currency1)] })
};

test('pool logs decode to the one new token they list against a quote asset, on either side', () => {
  for (const [scenario, log, source, expected] of [
    ['v3, token first', logs.v3(TOKEN, USDC), POOL_SOURCES.arc, { token: TOKEN, pool: POOL, venue: 'Uniswap v3', block: 1000 }],
    ['v3, quote first', logs.v3(USDC, TOKEN), POOL_SOURCES.arc, { token: TOKEN, pool: POOL, venue: 'Uniswap v3', block: 1000 }],
    ['v4 against the native coin', logs.v4(ZERO, TOKEN), POOL_SOURCES.arc, { token: TOKEN, pool: POOL_ID, venue: 'Uniswap v4', block: 1000 }],
    ['v2 against WETH', logs.v2(TOKEN, '0x0bd7d308f8e1639fab988df18a8011f41eacad73'), POOL_SOURCES.robinhood, { token: TOKEN, pool: POOL, venue: 'Uniswap v2', block: 1000 }],
    ['a launchpad graduation pool', logs.v2('0x5fc5360d0400a0fd4f2af552add042d716f1d168', TOKEN, '0x0d1ebb179cdbca88d74c923c4255cb2b17474afd'), POOL_SOURCES.robinhood, { token: TOKEN, pool: POOL, venue: 'flap.sh', block: 1000 }]
  ]) assert.deepEqual(decodePoolLog(log, source), expected, scenario);
});

test('a pool of two quote assets, two unknown tokens, an unknown factory or a mismatched event is not a new token', () => {
  for (const [scenario, log] of [
    ['two quotes', logs.v4(ZERO, USDC)],
    ['no quote', logs.v3(TOKEN, OTHER)],
    ['another factory', logs.v3(TOKEN, USDC, '0x' + 'ee'.repeat(20))],
    ['a v2 event from the v3 factory', logs.v2(TOKEN, USDC, '0xf0db7b58379503491d857db50ac9ece64c653918')],
    ['a truncated pool word', { ...logs.v3(TOKEN, USDC), data: '0x' + word('0x3c') }],
    ['a bad block number', { ...logs.v3(TOKEN, USDC), blockNumber: 'latest' }]
  ]) assert.equal(decodePoolLog(log, POOL_SOURCES.arc), null, scenario);
});

test('the log range reads on from the cursor in bounded chunks, starts a minute back, and skips a long gap', () => {
  assert.deepEqual(nextLogRange(null, 10_000, 500), { fromBlock: 9_880, toBlock: 10_000, skippedBlocks: 0 }, 'first use: a minute of 0.5 s blocks');
  assert.deepEqual(nextLogRange(9_970, 10_000, 500), { fromBlock: 9_971, toBlock: 10_000, skippedBlocks: 0 });
  assert.equal(nextLogRange(10_000, 10_000, 500), null, 'nothing new');
  assert.deepEqual(nextLogRange(9_000, 10_000, 500), { fromBlock: 9_001, toBlock: 9_000 + MAX_LOG_BLOCKS, skippedBlocks: 0 }, 'behind by less than ten minutes: catch up a chunk');
  assert.deepEqual(nextLogRange(1_000, 10_000, 500), { fromBlock: 9_880, toBlock: 10_000, skippedBlocks: 8_879 }, 'behind by more than ten minutes: resume near the head');
});

test('the Alchemy key is optional but never accepted malformed', () => {
  assert.equal(parseAlchemyApiKey({}), null);
  assert.equal(parseAlchemyApiKey({ ALCHEMY_API_KEY: '  ' }), null);
  assert.equal(parseAlchemyApiKey({ ALCHEMY_API_KEY: ' abcdefghijklmnop_1234 ' }), 'abcdefghijklmnop_1234');
  assert.throws(() => parseAlchemyApiKey({ ALCHEMY_API_KEY: 'has spaces in it, too long' }), error => error.code === 'ONCHAIN_CONFIG');
});

test('newPools asks the chain network for one bounded range over its factories and reports errors without the key', async () => {
  const key = 'secret-key-0123456789', calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    return Response.json({ jsonrpc: '2.0', id: 1, result: body.method === 'eth_blockNumber' ? '0x2710' : [logs.v3(TOKEN, USDC), logs.v4(ZERO, USDC)] });
  };
  const result = await new ChainLogs({ apiKey: key, fetchImpl }).newPools('arc', { cursor: 9_990 });
  assert.deepEqual(result, { head: 10_000, fromBlock: 9_991, toBlock: 10_000, skippedBlocks: 0, pools: [{ token: TOKEN, pool: POOL, venue: 'Uniswap v3', block: 1000 }] });
  assert.equal(calls[0].url, `https://arc-mainnet.g.alchemy.com/v2/${key}`);
  assert.deepEqual(calls[1].body.params[0], { fromBlock: '0x2707', toBlock: '0x2710', address: POOL_SOURCES.arc.factories.map(item => item.address),
    topics: [['0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438', '0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118']] });

  for (const [scenario, answer, code] of [
    ['HTTP refusal', () => new Response('no', { status: 403 }), 'ONCHAIN_HTTP_403'],
    ['RPC error', () => Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32600, message: `ARC_MAINNET is not enabled for ${key}` } }), 'ONCHAIN_RPC_32600'],
    ['network failure', () => { throw new TypeError('fetch failed'); }, 'ONCHAIN_NETWORK']
  ]) {
    const error = await new ChainLogs({ apiKey: key, fetchImpl: async () => answer() }).newPools('arc', { cursor: null }).catch(caught => caught);
    assert.ok(error instanceof ChainLogsError, scenario);
    assert.equal(error.code, code, scenario);
    assert.doesNotMatch(error.message, new RegExp(key), scenario);
  }
  await assert.rejects(new ChainLogs({ apiKey: null }).newPools('arc', { cursor: null }), error => error.code === 'ONCHAIN_NOT_CONFIGURED');
});
