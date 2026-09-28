import test from 'node:test';
import assert from 'node:assert/strict';
import { KyberClient, KYBER_ROUTER, KYBER_API_ORIGIN, verifySwapCalldata } from '../src/trading/kyber.mjs';
import { swapCalldata } from './fixtures/kyber-calldata.mjs';
import { EvmRpc, rpc, feeFields, transferredAmount, approveCalldata, DEFINITE_REFUSALS } from '../src/trading/evm.mjs';
import { parseTradingConfig, TRADE_CHAINS, KYBER_NATIVE_TOKEN, ARC_USDC_ERC20 } from '../src/trading/config.mjs';
import { TradingError } from '../src/trading/http.mjs';
import { parseUsdCents, parsePercent, withinBuyCap, usdCentsToStableUnits, nativePriceMicroUsd, usdCentsToNativeUnits, percentOf, minimumOut, displayUnits } from '../src/trading/amounts.mjs';

const TOKEN = '0x' + 'ab'.repeat(20);
const WALLET = '0x' + '12'.repeat(20);
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
const routeBody = (overrides = {}, summary = {}) => ({ code: 0, message: 'successfully', data: { routerAddress: KYBER_ROUTER.toLowerCase(),
  routeSummary: { tokenIn: KYBER_NATIVE_TOKEN, tokenOut: TOKEN, amountIn: '1000', amountOut: '5000', amountInUsd: '612.5', amountOutUsd: '600', gasUsd: '0.12', route: [], ...summary }, ...overrides } });
const plain = { tokenIn: KYBER_NATIVE_TOKEN, tokenOut: TOKEN, amountIn: 1000n, recipient: WALLET, minReturnAmount: 4750n };
const buildBody = (overrides = {}) => ({ code: 0, data: { routerAddress: KYBER_ROUTER, amountIn: '1000', amountOut: '5000', amountInUsd: '612.5', amountOutUsd: '600', gasUsd: '0.1', transactionValue: '1000', data: swapCalldata(plain), ...overrides } });

// A hand-written fetch stub: records each request, answers from a queue.
function stub(...answers) {
  const calls = [];
  return { calls, fetch: async (url, init) => { calls.push({ url: String(url), init }); const next = answers.shift(); return typeof next === 'function' ? next(url, init) : next; } };
}
const kyber = (fetch, timeoutMs) => new KyberClient({ clientId: 'meme-radar-test', fetchImpl: fetch, ...(timeoutMs ? { timeoutMs } : {}) });

test('route request uses the chain slug, exact amount and client id header', async () => {
  const network = stub(json(routeBody()));
  const route = await kyber(network.fetch).route({ slug: TRADE_CHAINS.eth.kyberSlug, tokenIn: KYBER_NATIVE_TOKEN, tokenOut: TOKEN, amountIn: 1000n });
  const url = new URL(network.calls[0].url);
  assert.equal(url.origin + url.pathname, `${KYBER_API_ORIGIN}/ethereum/api/v1/routes`);
  assert.deepEqual(Object.fromEntries(url.searchParams), { tokenIn: KYBER_NATIVE_TOKEN, tokenOut: TOKEN, amountIn: '1000', gasInclude: 'true' });
  assert.equal(network.calls[0].init.headers['x-client-id'], 'meme-radar-test');
  assert.equal(network.calls[0].init.redirect, 'error');
  assert.equal(route.amountOut, 5000n);assert.equal(route.amountInUsd, '612.5');
});

test('chain slugs map to KyberSwap network names', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(TRADE_CHAINS).map(([chain, facts]) => [chain, [facts.kyberSlug, facts.chainId]])),
    { arc: ['arc', 5042], bsc: ['bsc', 56], base: ['base', 8453], eth: ['ethereum', 1] });
});

test('build posts the route with sender, recipient, slippage and deadline and returns the pinned router', async () => {
  const network = stub(json(buildBody()));
  const built = await kyber(network.fetch).build({ slug: 'bsc', routeSummary: { amountIn: '1000' }, tokenIn: KYBER_NATIVE_TOKEN, tokenOut: TOKEN, amountIn: 1000n, sender: WALLET, slippageBps: 500, deadline: 1_900_000_000 });
  assert.equal(network.calls[0].url, `${KYBER_API_ORIGIN}/bsc/api/v1/route/build`);
  assert.equal(network.calls[0].init.method, 'POST');assert.equal(network.calls[0].init.headers['x-client-id'], 'meme-radar-test');
  assert.deepEqual(JSON.parse(network.calls[0].init.body), { routeSummary: { amountIn: '1000' }, sender: WALLET, recipient: WALLET, slippageTolerance: 500, deadline: 1_900_000_000 });
  assert.deepEqual({ to: built.to, value: built.value, amountOut: built.amountOut }, { to: KYBER_ROUTER, value: 1000n, amountOut: 5000n });
});

test('any router other than the pinned MetaAggregationRouterV2 is rejected', async () => {
  const other = '0x' + '99'.repeat(20);
  await assert.rejects(kyber(stub(json(routeBody({ routerAddress: other }))).fetch).route({ slug: 'bsc', tokenIn: KYBER_NATIVE_TOKEN, tokenOut: TOKEN, amountIn: 1000n }), { code: 'KYBER_ROUTER_MISMATCH' });
  await assert.rejects(kyber(stub(json(buildBody({ routerAddress: other }))).fetch).build({ slug: 'bsc', routeSummary: {}, tokenIn: KYBER_NATIVE_TOKEN, tokenOut: TOKEN, amountIn: 1000n, sender: WALLET, slippageBps: 500, deadline: 1 }), { code: 'KYBER_ROUTER_MISMATCH' });
});

test('value and amount mismatches are rejected for native and token inputs', async () => {
  const build = (body, tokenIn = KYBER_NATIVE_TOKEN) => kyber(stub(json(buildBody({ data: swapCalldata({ ...plain, tokenIn }), ...body }))).fetch).build({ slug: 'arc', routeSummary: {}, tokenIn, tokenOut: TOKEN, amountIn: 1000n, sender: WALLET, slippageBps: 500, deadline: 1 });
  await assert.rejects(build({ transactionValue: '999' }), { code: 'KYBER_VALUE_MISMATCH' });
  await assert.rejects(build({ transactionValue: '1000' }, ARC_USDC_ERC20), { code: 'KYBER_VALUE_MISMATCH' });
  assert.equal((await build({ transactionValue: '0' }, ARC_USDC_ERC20)).value, 0n);
  await assert.rejects(build({ amountIn: '1001' }), { code: 'KYBER_AMOUNT_MISMATCH' });
  await assert.rejects(kyber(stub(json(routeBody({}, { amountIn: '999' }))).fetch).route({ slug: 'bsc', tokenIn: KYBER_NATIVE_TOKEN, tokenOut: TOKEN, amountIn: 1000n }), { code: 'KYBER_AMOUNT_MISMATCH' });
  await assert.rejects(kyber(stub(json(routeBody({}, { tokenOut: WALLET }))).fetch).route({ slug: 'bsc', tokenIn: KYBER_NATIVE_TOKEN, tokenOut: TOKEN, amountIn: 1000n }), { code: 'KYBER_ROUTE_MISMATCH' });
});

test('non-OK envelopes are typed: refusals are definite, throttling and outages transient', async () => {
  const route = response => kyber(stub(response).fetch).route({ slug: 'bsc', tokenIn: KYBER_NATIVE_TOKEN, tokenOut: TOKEN, amountIn: 1000n });
  await assert.rejects(route(json({ code: 4008, message: 'route not found' }, 400)), error => error.code === 'KYBER_REJECTED' && error.transient === false && error.detail === 4008);
  await assert.rejects(route(json({ code: 4001, message: 'x' })), { code: 'KYBER_REJECTED' });
  await assert.rejects(route(json({}, 429)), error => error.code === 'KYBER_RATE_LIMITED' && error.transient);
  await assert.rejects(route(new Response('<html>', { status: 502 })), error => error.code === 'KYBER_UPSTREAM' && error.transient);
  await assert.rejects(route(new Response('not json')), { code: 'KYBER_SCHEMA' });
});

test('an unanswered request times out and an oversized one is refused', async () => {
  const hung = (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
  await assert.rejects(kyber(stub(hung).fetch, 5).route({ slug: 'bsc', tokenIn: KYBER_NATIVE_TOKEN, tokenOut: TOKEN, amountIn: 1n }), error => error.code === 'KYBER_TIMEOUT' && error.transient);
  await assert.rejects(kyber(stub(new Response('x'.repeat(10), { headers: { 'content-length': String(2 * 1024 * 1024) } })).fetch).route({ slug: 'bsc', tokenIn: KYBER_NATIVE_TOKEN, tokenOut: TOKEN, amountIn: 1n }), { code: 'KYBER_SIZE' });
  await assert.rejects(kyber(stub(new Response('x'.repeat(1_048_577))).fetch).route({ slug: 'bsc', tokenIn: KYBER_NATIVE_TOKEN, tokenOut: TOKEN, amountIn: 1n }), { code: 'KYBER_SIZE' });
});

test('the RPC client checks the chain id on every batch and types node refusals', async () => {
  const node = stub(async (_url, init) => json(JSON.parse(init.body).map(call => call.method === 'eth_chainId' ? { jsonrpc: '2.0', id: call.id, result: '0x38' } : { jsonrpc: '2.0', id: call.id, error: { code: -32000, message: 'nonce too low: next nonce 5' } })));
  const [answer] = await new EvmRpc({ url: 'https://rpc.example', chainId: 56, fetchImpl: node.fetch }).batch([rpc.sendRaw('0x01')]);
  assert.equal(answer.error.kind, 'NONCE_TOO_LOW');assert.equal(answer.error.message.includes('next nonce'), false);
  await assert.rejects(new EvmRpc({ url: 'https://rpc.example', chainId: 1, fetchImpl: stub(async (_url, init) => json(JSON.parse(init.body).map(call => ({ jsonrpc: '2.0', id: call.id, result: '0x38' })))).fetch }).batch([rpc.gasPrice()]), { code: 'RPC_CHAIN_MISMATCH' });
});

test('fees are EIP-1559 when the block has a base fee and legacy otherwise', () => {
  assert.deepEqual(feeFields(15n, { baseFeePerGas: '0xa' }), { type: 'eip1559', maxFeePerGas: 25n, maxPriorityFeePerGas: 5n, maxCost: 25n });
  assert.deepEqual(feeFields(15n, { number: '0x1' }), { type: 'legacy', gasPrice: 15n, maxCost: 15n });
});

test('transfer amounts are summed from matching Transfer logs only', () => {
  const topic = address => '0x' + '0'.repeat(24) + address.slice(2);
  const transfer = (token, from, to, amount) => ({ address: token, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', topic(from), topic(to)], data: '0x' + amount.toString(16).padStart(64, '0') });
  const receipt = { logs: [transfer(TOKEN, KYBER_ROUTER, WALLET, 7n), transfer(TOKEN, KYBER_ROUTER, WALLET, 3n), transfer(TOKEN, WALLET, KYBER_ROUTER, 100n), transfer(ARC_USDC_ERC20, KYBER_ROUTER, WALLET, 1n)] };
  assert.equal(transferredAmount(receipt, TOKEN, { to: WALLET }), 10n);
  assert.equal(transferredAmount(receipt, TOKEN, { from: WALLET }), 100n);
  assert.equal(transferredAmount({ logs: [] }, TOKEN, { to: WALLET }), null);
});

test('USD converts exactly to Arc USDC units and to wei through a Kyber USD valuation', () => {
  assert.equal(usdCentsToStableUnits(1000, 6), 10_000_000n);
  assert.equal(usdCentsToStableUnits(1234, 6), 12_340_000n);
  const price = nativePriceMicroUsd('612.5', 10n ** 18n);
  assert.equal(price, 612_500_000n);
  assert.equal(usdCentsToNativeUnits(1000, price), 16_326_530_612_244_897n);
  assert.equal(nativePriceMicroUsd('0', 10n ** 18n), null);assert.equal(nativePriceMicroUsd('abc', 10n ** 18n), null);
  assert.equal(displayUnits(16_326_530_612_244_897n, 18, 4), '0.01632');
});

test('percentage sells floor the balance and 100% is the whole balance', () => {
  assert.equal(percentOf(999n, 25), 249n);assert.equal(percentOf(999n, 50), 499n);assert.equal(percentOf(999n, 100), 999n);assert.equal(percentOf(3n, 25), 0n);
  assert.equal(minimumOut(10_000n, 500), 9_500n);assert.equal(minimumOut(9_999n, 500), 9_499n);
});

test('custom amounts parse strictly and the cap is inclusive', () => {
  assert.equal(parseUsdCents('$12.5'), 1250);assert.equal(parseUsdCents('12.345'), null);assert.equal(parseUsdCents('0'), null);assert.equal(parseUsdCents('-5'), null);
  assert.equal(parsePercent('25%'), 25);assert.equal(parsePercent('0'), null);assert.equal(parsePercent('101'), null);assert.equal(parsePercent('2.5'), null);
  assert.equal(withinBuyCap(10_000, 100), true);assert.equal(withinBuyCap(10_001, 100), false);
});

test('trading config enables exactly the chains with an RPC URL and fails loudly on malformed values', () => {
  assert.deepEqual(parseTradingConfig({}).chains, {});
  const config = parseTradingConfig({ KYBER_CLIENT_ID: 'radar', ARC_RPC_URL: 'https://arc.example/rpc', BSC_RPC_URL: '', BASE_RPC_URL: 'https://base.example' });
  assert.deepEqual(Object.keys(config.chains), ['arc', 'base']);
  assert.equal(config.chains.arc.explorerUrl, null);assert.equal(config.chains.base.explorerUrl, 'https://basescan.org');
  assert.throws(() => parseTradingConfig({ ARC_RPC_URL: 'https://arc.example' }), error => error instanceof TradingError && error.code === 'TRADING_CONFIG_INVALID');
  assert.throws(() => parseTradingConfig({ KYBER_CLIENT_ID: 'radar', ETH_RPC_URL: 'http://insecure.example' }), { code: 'TRADING_CONFIG_INVALID' });
  assert.throws(() => parseTradingConfig({ KYBER_CLIENT_ID: 'radar', ETH_RPC_URL: 'https://x.example', ETH_EXPLORER_URL: 'nope' }), { code: 'TRADING_CONFIG_INVALID' });
});

test('router calldata is decoded and refused unless it is the confirmed plain swap to the wallet', () => {
  const other = '0x' + '77'.repeat(20);
  const refused = (data, field) => assert.throws(() => verifySwapCalldata(data, { ...plain, minAmountOut: 4750n }), error => error.code === 'KYBER_CALLDATA_REFUSED' && error.detail === field, field);
  assert.equal(verifySwapCalldata(swapCalldata(plain), { ...plain, minAmountOut: 4750n }).functionName, 'swap');
  assert.equal(verifySwapCalldata(swapCalldata(plain, { minReturnAmount: 4800n }), { ...plain, minAmountOut: 4750n }).minReturnAmount, 4800n);
  refused(swapCalldata(plain, { dstReceiver: other }), 'dstReceiver');
  refused(swapCalldata(plain, { minReturnAmount: 4749n }), 'minReturnAmount');
  refused(swapCalldata(plain, { srcToken: other }), 'srcToken');
  refused(swapCalldata(plain, { dstToken: other }), 'dstToken');
  refused(swapCalldata(plain, { amount: 1001n }), 'amount');
  refused(swapCalldata(plain, { feeReceivers: [other], feeAmounts: [1n] }), 'fee');
  refused(swapCalldata(plain, { feeAmounts: [1n] }), 'fee');
  refused(swapCalldata(plain, { flags: 1n }), 'flags');
  refused(swapCalldata(plain, { permit: '0x01' }), 'permit');
  refused(approveCalldata(other, 1000n), 'entry point');
  refused('0x59e50fed' + '00'.repeat(64), 'entry point');
  refused(swapCalldata(plain, {}, 'swapSimpleMode'), 'entry point');
  const tokenInput = { ...plain, tokenIn: ARC_USDC_ERC20 };
  assert.equal(verifySwapCalldata(swapCalldata(tokenInput, {}, 'swapSimpleMode'), { ...tokenInput, minAmountOut: 4750n }).functionName, 'swapSimpleMode');
});

test('a build whose calldata pays someone else or less than the shown minimum is refused', async () => {
  const build = data => kyber(stub(json(buildBody({ data }))).fetch).build({ slug: 'bsc', routeSummary: {}, tokenIn: KYBER_NATIVE_TOKEN, tokenOut: TOKEN, amountIn: 1000n, sender: WALLET, slippageBps: 500, deadline: 1 });
  assert.equal((await build(swapCalldata(plain))).minAmountOut, 4750n);
  await assert.rejects(build(swapCalldata(plain, { dstReceiver: '0x' + '77'.repeat(20) })), { code: 'KYBER_CALLDATA_REFUSED' });
  await assert.rejects(build(swapCalldata(plain, { minReturnAmount: 1n })), { code: 'KYBER_CALLDATA_REFUSED' });
});

test('only allowlisted node refusals are definite; unknown answers stay ambiguous', async () => {
  const answer = async message => {
    const node = stub(async (_url, init) => json(JSON.parse(init.body).map(call => call.method === 'eth_chainId' ? { jsonrpc: '2.0', id: call.id, result: '0x1' } : { jsonrpc: '2.0', id: call.id, error: { code: -32000, message } })));
    return (await new EvmRpc({ url: 'https://rpc.example', chainId: 1, fetchImpl: node.fetch }).batch([rpc.sendRaw('0x01')]))[0].error.kind;
  };
  for (const [message, kind] of [['insufficient funds for gas * price + value', 'INSUFFICIENT_FUNDS'], ['intrinsic gas too low', 'INTRINSIC_GAS_TOO_LOW'],
    ['replacement transaction underpriced', 'REPLACEMENT_UNDERPRICED'], ['invalid sender', 'INVALID_SENDER'], ['nonce too low', 'NONCE_TOO_LOW']]) {
    assert.equal(await answer(message), kind);assert.ok(DEFINITE_REFUSALS.has(kind));
  }
  for (const message of ['internal error', 'request timed out', 'header not found', '']) assert.equal(DEFINITE_REFUSALS.has(await answer(message)), false, message);
});
