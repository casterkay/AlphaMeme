import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, it, expect, vi } from 'vitest';
import { decodeFunctionData, encodeFunctionResult, erc20Abi, getAddress, keccak256, parseTransaction, toEventSelector } from 'viem';
import { TelegramRuntime } from '../src/bot/runtime.mjs';
import { OneAlarmScheduler, externalRequestHandler } from '../src/scheduler.mjs';
import { readSchedulerStateInTransaction, SqliteSchedulerStore, writeSchedulerStateInTransaction } from '../src/storage/scheduler-state.mjs';
import { CHART_RISK_VERSION } from '../src/scoring/chart-risk.mjs';
import { KYBER_API_ORIGIN, KYBER_ROUTER } from '../src/trading/kyber.mjs';
import { ARC_USDC_ERC20, KYBER_NATIVE_TOKEN } from '../src/trading/config.mjs';
import { listTrades } from '../src/trading/trades.mjs';
import { safetyState, TradeRefusal } from '../src/trading/engine.mjs';
import { aggregateSecondarySources } from '../src/providers/secondary.mjs';
import { swapCalldata } from '../test/fixtures/kyber-calldata.mjs';
import { revealTradingKey, tradingWalletEnvelope } from '../src/trading/wallet.mjs';
import { LOOKUP_SETTINGS } from '../src/lookup.mjs';

const start = 1_800_000_000_000;
const masterKey = { activeVersion: '1', keys: { '1': 'trading-runtime-master-key' } };
const TOKEN = getAddress('0x' + 'ab'.repeat(20));
const CHAINS = { arc: { id: 5042, url: 'https://arc-rpc.test/' }, bsc: { id: 56, url: 'https://bsc-rpc.test/' } };
const TRANSFER = toEventSelector('Transfer(address,address,uint256)');
const word = value => '0x' + BigInt(value).toString(16).padStart(64, '0');
const topic = address => '0x' + '0'.repeat(24) + address.slice(2).toLowerCase();
const json = value => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
const SECURITY = { complete: true, verdict: 'NO_FATAL_FLAGS', fatal: [], unknownFields: [], fields: {}, buyTax: 0, sellTax: 0 };
// A GoPlus/DexScreener check recorded the way the scanner stores it.
const check = ({ dex = 'OK', security = SECURITY } = {}) => aggregateSecondarySources({ chain: 'arc', tokenAddress: TOKEN, sources: {
  dexScreener: { value: { source: { status: dex }, market: { complete: true, priceUsd: null, marketCap: null, liquidityUsd: null, websites: [] } } },
  goPlus: { value: { source: { status: 'OK' }, security } } } });
const VERIFIED = check();
const conflicted = type => ({ ...VERIFIED, conflicts: [{ type, field: 'isHoneypot', primary: true, secondary: false }] });
const FATAL = check({ security: { ...SECURITY, verdict: 'FATAL', fatal: [{ field: 'honeypot', reason: 'honeypot' }] } });

// A hand-written EVM node and KyberSwap endpoint; nothing touches the network.
function venue() {
  const chains = Object.fromEntries(Object.entries(CHAINS).map(([name, facts]) => [name, { ...facts, native: 0n, tokens: {}, allowances: {}, nonce: 0, sent: [], receipts: {}, mine: true, revert: false, sendFault: null, sendRefusal: null, httpFault: null, beforeBatch: null, balanceAt: {} }]));
  // Kyber knobs: nativeUsd prices the native coin; thinPool refuses routes of 1 whole coin or more;
  // routeUsd overrides a route's USD valuation; tamper alters the built swap description.
  const kyber = [], knobs = { nativeUsd: 600n, thinPool: false, routeUsd: null, tamper: null };
  const balanceOf = (chain, token, owner) => chain.tokens[`${token.toLowerCase()}:${owner.toLowerCase()}`] ?? 0n;
  function call(chain, wallet, request) {
    const { method, params } = request;
    if (method === 'eth_chainId') return '0x' + chain.id.toString(16);
    if (method === 'eth_getTransactionCount') return '0x' + (params[1] === 'latest' ? chain.sent.filter(tx => chain.receipts[tx.hash]).length : chain.nonce).toString(16);
    if (method === 'eth_gasPrice') return '0x3b9aca00';
    if (method === 'eth_getBlockByNumber') return { number: '0x10', baseFeePerGas: '0x1' };
    if (method === 'eth_getBalance') return '0x' + (chain.balanceAt[params[1]] ?? chain.native).toString(16);
    if (method === 'eth_estimateGas') return chain.revert && params[0].to === KYBER_ROUTER ? { error: { code: 3, message: 'execution reverted' } } : '0x186a0';
    if (method === 'eth_call') {
      const { functionName, args } = decodeFunctionData({ abi: erc20Abi, data: params[0].data });
      const token = params[0].to;
      const result = functionName === 'decimals' ? (token === ARC_USDC_ERC20 ? 6 : 9) : functionName === 'symbol' ? 'MEME' : functionName === 'balanceOf' ? balanceOf(chain, token, args[0])
        : chain.allowances[`${token.toLowerCase()}:${args[0].toLowerCase()}:${args[1].toLowerCase()}`] ?? 0n;
      return encodeFunctionResult({ abi: erc20Abi, functionName, result });
    }
    if (method === 'eth_sendRawTransaction') {
      const raw = params[0], hash = keccak256(raw), tx = parseTransaction(raw);
      if (chain.sent.some(item => item.hash === hash)) return { error: { code: -32000, message: 'already known' } };
      if (chain.sendRefusal) { const message = chain.sendRefusal;chain.sendRefusal = null;return { error: { code: -32000, message } }; }
      chain.sent.push({ raw, hash, tx });chain.nonce += 1;
      if (tx.to.toLowerCase() !== KYBER_ROUTER.toLowerCase()) {
        const { args } = decodeFunctionData({ abi: erc20Abi, data: tx.data });
        chain.allowances[`${tx.to.toLowerCase()}:${wallet().toLowerCase()}:${args[0].toLowerCase()}`] = args[1];
      }
      return hash;
    }
    if (method === 'eth_getTransactionReceipt') {
      const sent = chain.sent.find(item => item.hash === params[0]);
      if (!sent || !chain.mine) return null;
      const swap = sent.tx.to.toLowerCase() === KYBER_ROUTER.toLowerCase();
      chain.receipts[sent.hash] = true;
      return { status: chain.revert && swap ? '0x0' : '0x1', blockNumber: '0x10', gasUsed: '0x5208', effectiveGasPrice: '0x2',
        logs: swap ? [{ address: TOKEN, topics: [TRANSFER, topic(KYBER_ROUTER), topic(wallet())], data: word(4_000_000_000_000n) }] : [] };
    }
    throw new Error(`unexpected RPC ${method}`);
  }
  let walletAddress = null;
  const wallet = () => walletAddress;
  const fetch = async (url, init) => {
    const target = String(url);
    if (target.startsWith(KYBER_API_ORIGIN)) {
      const parsed = new URL(target);
      kyber.push({ path: parsed.pathname, query: Object.fromEntries(parsed.searchParams), body: init.body ? JSON.parse(init.body) : null, clientId: init.headers['x-client-id'] });
      if (parsed.pathname.endsWith('/routes')) {
        const { tokenIn, tokenOut, amountIn } = Object.fromEntries(parsed.searchParams);
        if (knobs.thinPool && BigInt(amountIn) >= 10n ** 18n) return new Response(JSON.stringify({ code: 4008, message: 'route not found' }), { status: 400 });
        const micro = BigInt(amountIn) * knobs.nativeUsd * 1_000_000n / 10n ** 18n;
        const usd = tokenIn === KYBER_NATIVE_TOKEN ? `${micro / 1_000_000n}.${String(micro % 1_000_000n).padStart(6, '0')}` : '10';
        return json({ code: 0, data: { routerAddress: KYBER_ROUTER, routeSummary: { tokenIn, tokenOut, amountIn, amountOut: '5000000000000', amountInUsd: knobs.routeUsd ?? usd, amountOutUsd: '9.5', gasUsd: '0.01' } } });
      }
      const { routeSummary, sender, slippageTolerance } = JSON.parse(init.body);
      const amountOut = BigInt(routeSummary.amountOut);
      const data = swapCalldata({ tokenIn: routeSummary.tokenIn, tokenOut: routeSummary.tokenOut, amountIn: BigInt(routeSummary.amountIn), recipient: sender,
        minReturnAmount: amountOut * BigInt(10_000 - slippageTolerance) / 10_000n }, knobs.tamper ?? {});
      return json({ code: 0, data: { routerAddress: KYBER_ROUTER, amountIn: routeSummary.amountIn, amountOut: routeSummary.amountOut, amountInUsd: '10', amountOutUsd: '9.5', gasUsd: '0.01',
        transactionValue: routeSummary.tokenIn === KYBER_NATIVE_TOKEN ? routeSummary.amountIn : '0', data } });
    }
    const chain = Object.values(chains).find(item => item.url.replace(/\/$/, '') === target);
    const batch = JSON.parse(init.body);
    if (chain.beforeBatch) chain.beforeBatch(batch);
    if (chain.httpFault && batch.some(request => request.method === 'eth_sendRawTransaction')) {
      const status = chain.httpFault;chain.httpFault = null;
      return new Response('bad gateway', { status });
    }
    const answers = batch.map(request => {
      if (request.method === 'eth_sendRawTransaction' && chain.sendFault) {
        const fault = chain.sendFault;chain.sendFault = null;
        const result = call(chain, wallet, request);
        if (fault === 'lost') throw new TypeError('connection reset after the node accepted the transaction');
        if (fault === 'evicted') throw new Error('isolate evicted after broadcast');
        return { jsonrpc: '2.0', id: request.id, result };
      }
      const result = call(chain, wallet, request);
      return result && typeof result === 'object' && 'error' in result && Object.keys(result).length === 1 ? { jsonrpc: '2.0', id: request.id, error: result.error } : { jsonrpc: '2.0', id: request.id, result };
    });
    return json(answers);
  };
  return { chains, kyber, knobs, fetch, setWallet: address => { walletAddress = address; }, fund: (name, native, tokens = {}) => {
    chains[name].native = native;
    for (const [token, amount] of Object.entries(tokens)) chains[name].tokens[`${token.toLowerCase()}:${walletAddress.toLowerCase()}`] = amount;
  } };
}

async function withTrading(name, operation) {
  const tenantId = String(40000 + Math.floor(Math.random() * 9999));
  const radar = env.RADAR.get(env.RADAR.idFromName(`trading:${name}:${tenantId}`));
  return runInDurableObject(radar, async (_instance, { storage }) => {
    let clock = start, update = 0, message = 100;
    const network = venue();
    const runtimeEnv = { MASTER_ENC_KEY: masterKey, AVE_MONTHLY_CU: env.AVE_MONTHLY_CU, AVE_CU_RESET_DAY: env.AVE_CU_RESET_DAY, KYBER_CLIENT_ID: 'radar-test',
      ARC_RPC_URL: CHAINS.arc.url, BSC_RPC_URL: CHAINS.bsc.url, BASE_RPC_URL: '', ETH_RPC_URL: '' };
    const sent = [];
    let transportFault = null;
    const make = () => {
      const runtime = new TelegramRuntime({ storage, tenantId, env: runtimeEnv, now: () => clock });
      runtime.outbox.transport = async input => {
        if (transportFault) { const fault = transportFault;transportFault = null;return fault; }
        sent.push(structuredClone({ method: input.method, params: input.params }));
        return { ok: true, result: input.method === 'sendMessage' ? { message_id: ++message } : input.method === 'editMessageText' ? { message_id: Number(input.params.message_id) } : true };
      };
      return runtime;
    };
    let runtime = make();
    const request = operation => operation({ signal: new AbortController().signal, timeoutMs: 1000 });
    const receipt = (commandType, payload, overrides = {}) => ({ tenantId, actorUserId: tenantId, updateId: String(++update), commandType, payload, dueAt: clock + 60_000, messageDate: Math.floor(clock / 1000), sourceMessageId: String(1000 + update), locale: 'zh', ...overrides });
    const drain = async () => {
      for (let count = 0; count < 100; count++) {
        const task = storage.transactionSync(() => runtime.outbox.reconcileInTransaction()).find(item => item.dueAt <= clock);
        if (!task) return;
        await runtime.outbox.deliverOne(task.id.slice('outbox:'.length), { request });
      }
      throw new Error('outbox did not converge');
    };
    const command = async (name, args = '') => { const input = receipt(`command:${name}`, { source: 'message', arguments: args });runtime.receive(input);await runtime.runCommand(input.updateId);await drain();return input; };
    const sessions = () => storage.sql.exec('SELECT id FROM ui_sessions WHERE tenant_id=? ORDER BY rowid', tenantId).toArray().map(row => runtime.commands.sessions.get(row.id));
    const link = (session, action, predicate = () => true) => {
      const current = runtime.commands.sessions.get(session.id);
      const found = storage.sql.exec('SELECT * FROM shortlinks WHERE tenant_id=? AND ui_session_id=? AND expected_ui_version=? AND action=?', tenantId, current.id, current.version, action).toArray().find(row => predicate(JSON.parse(row.params_json), row));
      if (!found) throw new Error(`missing ${action} on ${current.panel} v${current.version}`);
      return found;
    };
    const has = (session, action) => { const current = runtime.commands.sessions.get(session.id);return storage.sql.exec('SELECT 1 FROM shortlinks WHERE tenant_id=? AND ui_session_id=? AND expected_ui_version=? AND action=?', tenantId, current.id, current.version, action).toArray().length > 0; };
    const click = async (binding) => { const input = receipt('callback', { callbackId: binding.id, callbackQueryId: `q${update + 1}` }, { sourceMessageId: binding.origin_message_id });runtime.receive(input);await runtime.runCommand(input.updateId);await drain();return input; };
    const tradeTasks = () => storage.transactionSync(() => runtime.reconcileInTransaction()).filter(task => task.kind === 'trade' && task.enabled);
    // Run due trade steps, advancing the clock to the next due step, until `until` holds.
    const run = async (until, limit = 400) => {
      for (let count = 0; count < limit; count++) {
        if (until()) return;
        const tasks = tradeTasks().sort((left, right) => left.dueAt - right.dueAt);
        if (!tasks.length) throw new Error(`no trade step is scheduled: ${JSON.stringify(listTrades(storage, tenantId).map(trade => [trade.state, trade.result]))}`);
        clock = Math.max(clock, tasks[0].dueAt);
        await runtime.trading.runStep(tasks[0].id, { request, fetchImpl: network.fetch });
        await drain();
      }
      throw new Error('trade did not reach the expected state');
    };
    // A candidate with its recorded safety check; `secondary: null` is a lead whose check has not run.
    const seed = (chain = 'arc', status = 'LIVE_READY', secondary = VERIFIED) => storage.sql.exec('INSERT INTO candidates (tenant_id,chain,address,symbol,status,audited_at,review_revision,deep_json,secondary_json) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,chain,address) DO UPDATE SET status=excluded.status, secondary_json=excluded.secondary_json',
      tenantId, chain, TOKEN, 'MEME', status, clock - 1000, 'revision', JSON.stringify({ chainPass: true, chartRisk: { version: CHART_RISK_VERSION }, checks: {}, failed: [], unknownFields: [] }), secondary === null ? null : JSON.stringify(secondary));
    const createWallet = async () => {
      await command('wallet');
      const panel = sessions().at(-1);
      await click(link(panel, 'wallet.create'));
      const address = runtime.trading.wallet().address;
      network.setWallet(address);
      return { panel, address };
    };
    const openDetail = async (chain = 'arc') => {
      await command('leads');
      const list = sessions().at(-1);
      if (chain !== 'arc') {
        await click(link(list, 'panel.open', params => params.panel === 'view_chain'));
        await click(link(list, 'view_chain.set', params => params.value === chain));
      }
      await click(link(list, 'panel.open', params => params.panel === 'detail'));
      return runtime.commands.sessions.get(list.id);
    };
    const trades = () => listTrades(storage, tenantId);
    const tradeOf = session => trades().find(trade => trade.id === runtime.commands.sessions.get(session.id).query.tradeId);
    // Open a token detail, tap a buy (or sell) and wait for the confirm screen.
    const quote = async (chain = 'bsc', action = 'trade.buy', predicate = params => params.usd === 1) => {
      const detail = await openDetail(chain);
      await click(link(detail, action, predicate));
      await run(() => ['QUOTED', 'FAILED'].includes(tradeOf(detail).state));
      return detail;
    };
    const confirm = async detail => click(link(runtime.commands.sessions.get(detail.id), 'trade.confirm'));
    const lastText = () => sent.filter(row => row.params.text).at(-1).params.text;
    const reply = async (session, text) => {
      const pending = runtime.commands.sessions.get(session.id).query.pendingInput;
      const input = receipt('reply', { source: 'reply', text, replyToMessageId: pending.promptMessageId });
      runtime.receive(input);await runtime.runCommand(input.updateId);await drain();
    };
    // Paste a contract address with AVE connected; the lookup's steps run with stub AVE and secondary answers.
    const paste = async address => {
      storage.transactionSync(() => { const state = readSchedulerStateInTransaction(storage, tenantId);
        writeSchedulerStateInTransaction(storage, tenantId, { ...state, runtime: { ...state.runtime, eligibility: { ...state.runtime.eligibility, configured: true } } }); });
      const input = receipt('lookup', { family: 'evm', address: address.toLowerCase() });runtime.receive(input);await runtime.runCommand(input.updateId);await drain();
      return sessions().at(-1);
    };
    const lookupStep = async ({ details, secondary }) => {
      const [task] = storage.transactionSync(() => runtime.reconcileInTransaction()).filter(item => item.kind === 'lookup');
      await runtime.lookups.runStep(task.id, { request, details, secondary });await drain();
    };
    await command('lang', 'en');
    await operation({ paste, lookupStep, tradeOf, quote, confirm, reply, runtime: () => runtime, restart: () => { runtime = make(); }, storage, tenantId, network, sent, command, sessions, link, has, click, run, seed, createWallet, openDetail, trades, lastText, drain,
      clock: { now: () => clock, advance: ms => { clock += ms; } }, faultTransport: fault => { transportFault = fault; } });
  });
}

describe('one-tap trading', () => {
  it('buys from alert controls in the same message and returns through the warning to the alert keyboard', async () => {
    await withTrading('alert-controls', async ({ runtime, storage, click, link, seed, createWallet, trades, sent, drain, reply }) => {
      await createWallet();seed('arc', 'LIVE_READY', null);
      const commands=runtime().commands;
      const alert=storage.transactionSync(()=>commands.renderInTransaction(commands.sessions.createInTransaction('alert','arc',{selectedToken:{chain:'arc',address:TOKEN}})));
      await drain();
      const current=()=>commands.sessions.get(alert.id),messageId=current().messageId;
      await click(link(current(),'panel.open',params=>params.panel==='detail'));
      expect(sent.at(-1)).toMatchObject({method:'editMessageReplyMarkup',params:{message_id:messageId}});
      await click(link(current(),'trade.input',params=>params.side==='buy'));
      await reply(current(),'invalid');
      expect(sent.at(-1).params.text).toContain('Invalid amount');
      await reply(current(),'1000');
      expect(sent.at(-1).params.text).toContain('Above your per-trade buy cap');
      await click(link(current(),'trade.buy',params=>params.usd===1));
      expect(current()).toMatchObject({panel:'trade_unverified',query:{unverifiedBuy:{usdCents:100}}});
      expect(runtime().alertMessageId({chain:'arc',address:TOKEN})).toBe(Number(messageId));
      expect(sent.at(-1)).toMatchObject({method:'editMessageText',params:{message_id:messageId}});
      await click(link(current(),'trade.decline_unverified'));
      expect(current()).toMatchObject({panel:'alert',query:{tokenControls:true}});
      expect(sent.at(-1).params.text).toContain('New lead · MEME');
      await click(link(current(),'trade.buy',params=>params.usd===1));
      seed('arc','LIVE_READY',FATAL);
      await click(link(current(),'trade.acknowledge_unverified'));
      expect(current()).toMatchObject({panel:'alert',query:{tokenControls:true}});
      expect(sent.at(-1).params.text).toContain('buy was refused');
      await click(link(current(),'panel.back'));
      expect(current().query.tokenControls).toBeUndefined();
      expect(sent.at(-1)).toMatchObject({method:'editMessageText',params:{message_id:messageId}});
      expect(sent.at(-1).params.text).not.toContain('buy was refused');
      expect(sent.at(-1).params.reply_markup.inline_keyboard[0][0].text).toBe('Open MEME');
      expect(trades()).toEqual([]);
      await click(link(current(),'panel.open',params=>params.panel==='detail'));
      await click(link(current(),'panel.open',params=>params.panel==='radar'));
      expect(current().panel).toBe('radar');
      expect(current().query.returnTo).toBeUndefined();
      expect(runtime().alertMessageId({chain:'arc',address:TOKEN})).toBe(Number(messageId));
    });
  });

  it('buys on Arc end to end: quote, confirm, exact approval, swap, receipt and a filled edit of the same message', async () => {
    await withTrading('arc-e2e', async ({ runtime, network, sent, click, link, run, seed, createWallet, openDetail, trades, lastText }) => {
      seed();await createWallet();
      network.fund('arc', 50n * 10n ** 18n, { [ARC_USDC_ERC20]: 50_000_000n });
      const detail = await openDetail();
      await click(link(detail, 'trade.buy', params => params.usd === 1));
      const [trade] = trades();
      expect(trade).toMatchObject({ state: 'QUOTING', side: 'buy', usdCents: 100, tokenIn: ARC_USDC_ERC20 });
      await run(() => trades()[0].state === 'QUOTED');
      const route = network.kyber.find(item => item.path === '/arc/api/v1/routes');
      expect(route).toMatchObject({ clientId: 'radar-test', query: { tokenIn: ARC_USDC_ERC20, tokenOut: TOKEN, amountIn: '1000000' } });
      const confirm = lastText();
      expect(confirm).toContain('Spend');expect(confirm).toContain('$1 = 1 USDC');expect(confirm).toContain('$100');
      const session = runtime().commands.sessions.get(detail.id);
      expect(sent.filter(row => row.method === 'editMessageText').at(-1).params.message_id).toBe(detail.messageId);
      await click(link(session, 'trade.confirm'));
      expect(trades()[0].state).toBe('CONFIRMED');
      await run(() => ['FILLED', 'FAILED', 'UNKNOWN'].includes(trades()[0].state));
      const done = trades()[0];
      expect(done.state).toBe('FILLED');expect(done.result).toMatchObject({ received: '4000000000000', spent: '1000000' });
      const [approval, swap] = network.chains.arc.sent;
      expect(approval.tx.to.toLowerCase()).toBe(ARC_USDC_ERC20.toLowerCase());
      expect(decodeFunctionData({ abi: erc20Abi, data: approval.tx.data })).toEqual({ functionName: 'approve', args: [KYBER_ROUTER, 1_000_000n] });
      expect(swap.tx).toMatchObject({ to: KYBER_ROUTER.toLowerCase(), nonce: 1, chainId: 5042 });expect(swap.tx.value ?? 0n).toBe(0n);
      expect(lastText()).toContain('Filled');expect(lastText()).toContain('Received: 4000 MEME');
      expect(sent.filter(row => row.method === 'editMessageText').at(-1).params.message_id).toBe(detail.messageId);
    });
  });

  it('converts a USD buy to wei at the Kyber native price and needs no approval for a native input', async () => {
    await withTrading('bsc-native', async ({ runtime, network, click, link, run, seed, createWallet, openDetail, trades, lastText }) => {
      seed('bsc');await createWallet();network.fund('bsc', 10n ** 18n);
      const detail = await openDetail('bsc');
      await click(link(detail, 'trade.buy', params => params.usd === 2));
      await run(() => trades()[0].state === 'QUOTED');
      expect(network.kyber[0].query).toMatchObject({ tokenIn: KYBER_NATIVE_TOKEN, amountIn: String(10n ** 15n) });
      expect(trades()[0]).toMatchObject({ priceMicroUsd: '600000000', amountIn: String(200n * 10_000n * 10n ** 18n / 600_000_000n) });
      expect(lastText()).toContain('$2 ≈ 0.00333333 BNB (at $600/BNB)');
      await click(link(runtime().commands.sessions.get(detail.id), 'trade.confirm'));
      await run(() => trades()[0].state === 'FILLED');
      expect(network.chains.bsc.sent).toHaveLength(1);expect(network.chains.bsc.sent[0].tx.value).toBe(BigInt(trades()[0].amountIn));
    });
  });

  it('refuses a vetoed buy at quote, at confirm and immediately before signing, and never signs', async () => {
    await withTrading('veto', async ({ runtime, storage, tenantId, network, click, link, run, seed, createWallet, openDetail, trades, sent }) => {
      seed();await createWallet();network.fund('arc', 50n * 10n ** 18n, { [ARC_USDC_ERC20]: 50_000_000n });
      const detail = await openDetail();
      const buy = link(detail, 'trade.buy', params => params.usd === 1);
      seed('arc', 'HARD_REJECT');
      await click(buy);
      // The refusal is a banner on the detail it came from, and the next render drops it.
      expect(trades()).toEqual([]);expect(sent.at(-1)).toMatchObject({ method: 'editMessageText', params: { message_id: detail.messageId } });
      expect(sent.at(-1).params.text).toMatch(/^⚠️ Safety check failed; the buy was refused\. Selling is not affected\.\n\n<b>MEME/);
      expect(runtime().commands.sessions.get(detail.id).query.notice).toBeUndefined();
      await click(link(runtime().commands.sessions.get(detail.id), 'panel.refresh'));
      expect(sent.at(-1).params.text).toMatch(/^<b>MEME/);

      seed('arc', 'LIVE_READY');
      const fresh = await openDetail();
      await click(link(fresh, 'trade.buy', params => params.usd === 1));
      await run(() => trades()[0].state === 'QUOTED');
      seed('arc', 'HARD_REJECT');
      await click(link(runtime().commands.sessions.get(fresh.id), 'trade.confirm'));
      expect(trades()[0]).toMatchObject({ state: 'FAILED', result: { reason: 'VETOED' } });

      storage.sql.exec("UPDATE candidates SET status='LIVE_READY' WHERE tenant_id=?", tenantId);
      const third = await openDetail();
      await click(link(third, 'trade.buy', params => params.usd === 1));
      const current = () => trades().find(trade => trade.id === runtime().commands.sessions.get(third.id).query.tradeId);
      await run(() => current().state === 'QUOTED');
      await click(link(runtime().commands.sessions.get(third.id), 'trade.confirm'));
      // The veto lands while the pre-signing reads are in flight.
      network.chains.arc.beforeBatch = batch => { if (batch.some(call => call.method === 'eth_estimateGas')) storage.sql.exec("UPDATE candidates SET status='HARD_REJECT' WHERE tenant_id=?", tenantId); };
      await run(() => current().state !== 'CONFIRMED');
      expect(current()).toMatchObject({ state: 'FAILED', result: { reason: 'VETOED' }, approval: null, swap: null });
      expect(network.chains.arc.sent).toEqual([]);
    });
  });

  it('never blocks a sell of a vetoed token', async () => {
    await withTrading('veto-sell', async ({ runtime, network, click, link, run, seed, createWallet, openDetail, trades }) => {
      seed('arc', 'HARD_REJECT');await createWallet();network.fund('arc', 50n * 10n ** 18n, { [TOKEN]: 1_000_000_000_000n });
      const detail = await openDetail();
      await click(link(detail, 'trade.sell', params => params.percent === 25));
      await run(() => trades()[0].state === 'QUOTED');
      expect(trades()[0]).toMatchObject({ amountIn: '250000000000', tokenIn: TOKEN, tokenOut: ARC_USDC_ERC20 });
      await click(link(runtime().commands.sessions.get(detail.id), 'trade.confirm'));
      await run(() => trades()[0].state === 'FILLED');
      expect(network.chains.arc.sent).toHaveLength(2);
    });
  });

  it('re-quotes instead of executing a quote confirmed after it expired', async () => {
    await withTrading('expiry', async ({ runtime, network, click, link, run, seed, createWallet, openDetail, trades, clock }) => {
      seed();await createWallet();network.fund('arc', 50n * 10n ** 18n, { [ARC_USDC_ERC20]: 50_000_000n });
      const detail = await openDetail();
      await click(link(detail, 'trade.buy', params => params.usd === 1));
      await run(() => trades()[0].state === 'QUOTED');
      const confirm = link(runtime().commands.sessions.get(detail.id), 'trade.confirm');
      clock.advance(30_000);
      await click(confirm);
      const [fresh, expired] = trades();
      expect(expired.state).toBe('EXPIRED');expect(fresh.state).toBe('QUOTING');
      expect(runtime().commands.sessions.get(detail.id).query.tradeId).toBe(fresh.id);
      await run(() => trades()[0].state === 'QUOTED');
      expect(network.chains.arc.sent).toEqual([]);
    });
  });

  it.each(['APPROVE_SIGNED', 'SWAP_SIGNED'])('replays a broadcast evicted at %s with the identical raw transaction and never signs twice', async state => {
    await withTrading(`replay-${state}`, async ({ runtime, restart, network, click, link, run, seed, createWallet, openDetail, trades }) => {
      seed();await createWallet();network.fund('arc', 50n * 10n ** 18n, { [ARC_USDC_ERC20]: 50_000_000n });
      const detail = await openDetail();
      await click(link(detail, 'trade.buy', params => params.usd === 1));
      await run(() => trades()[0].state === 'QUOTED');
      await click(link(runtime().commands.sessions.get(detail.id), 'trade.confirm'));
      await run(() => trades()[0].state === state);
      const signed = trades()[0][state === 'APPROVE_SIGNED' ? 'approval' : 'swap'];
      network.chains.arc.sendFault = 'evicted';
      await expect(run(() => false, 1)).rejects.toThrow('isolate evicted');
      expect(trades()[0].state).toBe(state);
      restart();
      await run(() => trades()[0].state === (state === 'APPROVE_SIGNED' ? 'APPROVE_SENT' : 'SWAP_SENT'));
      expect(trades()[0][state === 'APPROVE_SIGNED' ? 'approval' : 'swap'].raw).toBe(signed.raw);
      await run(() => trades()[0].state === 'FILLED');
      const nonces = network.chains.arc.sent.map(item => item.tx.nonce);
      expect(nonces).toEqual([0, 1]);
    });
  });

  it('treats a broadcast lost in transit as sent and settles it by receipt', async () => {
    await withTrading('lost-broadcast', async ({ runtime, network, click, link, run, seed, createWallet, openDetail, trades }) => {
      seed('bsc');await createWallet();network.fund('bsc', 10n ** 18n);
      const detail = await openDetail('bsc');
      await click(link(detail, 'trade.buy', params => params.usd === 1));
      await run(() => trades()[0].state === 'QUOTED');
      await click(link(runtime().commands.sessions.get(detail.id), 'trade.confirm'));
      network.chains.bsc.sendFault = 'lost';
      await run(() => trades()[0].state === 'SWAP_SENT');
      expect(trades()[0].swap.uncertain).toBe(true);
      await run(() => trades()[0].state === 'FILLED');
      expect(network.chains.bsc.sent).toHaveLength(1);
    });
  });

  it('marks a swap UNKNOWN after the receipt deadline, shows its link and signs no replacement', async () => {
    await withTrading('unknown', async ({ runtime, network, click, link, run, seed, createWallet, openDetail, trades, lastText }) => {
      seed('bsc');await createWallet();network.fund('bsc', 10n ** 18n);
      const detail = await openDetail('bsc');
      await click(link(detail, 'trade.buy', params => params.usd === 1));
      await run(() => trades()[0].state === 'QUOTED');
      await click(link(runtime().commands.sessions.get(detail.id), 'trade.confirm'));
      network.chains.bsc.mine = false;
      await run(() => trades()[0].state === 'UNKNOWN');
      const trade = trades()[0];
      expect(trade.result.reason).toBe('NO_RECEIPT');
      expect(new Set(network.chains.bsc.sent.map(item => item.hash))).toEqual(new Set([trade.swap.hash]));
      expect(lastText()).toContain(`https://bscscan.com/tx/${trade.swap.hash}`);expect(lastText()).toContain('No replacement will be signed');
    });
  });

  it('fails a reverted swap', async () => {
    await withTrading('revert', async ({ runtime, network, click, link, run, seed, createWallet, openDetail, trades, lastText }) => {
      seed('bsc');await createWallet();network.fund('bsc', 10n ** 18n);
      const detail = await openDetail('bsc');
      await click(link(detail, 'trade.buy', params => params.usd === 1));
      await run(() => trades()[0].state === 'QUOTED');
      await click(link(runtime().commands.sessions.get(detail.id), 'trade.confirm'));
      await run(() => trades()[0].state === 'SWAP_SENT');
      network.chains.bsc.revert = true;
      await run(() => trades()[0].state === 'FAILED');
      expect(trades()[0].result.reason).toBe('SWAP_REVERTED');expect(lastText()).toContain('reverted on chain');
    });
  });

  it('refuses a second confirmation while another trade executes', async () => {
    await withTrading('concurrent', async ({ runtime, network, click, link, run, seed, createWallet, openDetail, trades, sent }) => {
      seed('bsc');await createWallet();network.fund('bsc', 10n ** 18n);
      const first = await openDetail('bsc');
      await click(link(first, 'trade.buy', params => params.usd === 1));
      await run(() => trades()[0].state === 'QUOTED');
      network.chains.bsc.mine = false;
      await click(link(runtime().commands.sessions.get(first.id), 'trade.confirm'));
      const second = await openDetail('bsc');
      await click(link(second, 'trade.buy', params => params.usd === 2));
      await run(() => trades().find(trade => trade.usdCents === 200)?.state === 'QUOTED');
      const executing = trades().find(trade => trade.usdCents === 100);
      expect(executing.state).not.toBe('QUOTED');
      await click(link(runtime().commands.sessions.get(second.id), 'trade.confirm'));
      expect(trades().find(trade => trade.usdCents === 200).state).toBe('QUOTED');
      expect(sent.some(row => row.params.text?.includes('Another trade is executing'))).toBe(true);
    });
  });

  it('names the token in the custom-buy prompt, shows a refused or invalid reply as a banner and keeps the prompt usable', async () => {
    await withTrading('custom', async ({ runtime, click, link, seed, createWallet, openDetail, trades, sent, drain }) => {
      seed();await createWallet();
      const detail = await openDetail();
      let updateId = 900;
      const prompt = async () => {
        await click(link(runtime().commands.sessions.get(detail.id), 'trade.input', params => params.side === 'buy'));
        return runtime().commands.sessions.get(detail.id).query.pendingInput;
      };
      const answer = async (pending, text) => {
        const input = { tenantId: runtime().tenantId, actorUserId: runtime().tenantId, updateId: String(++updateId), commandType: 'reply', payload: { source: 'reply', text, replyToMessageId: pending.promptMessageId }, dueAt: start + 60_000, messageDate: start / 1000, sourceMessageId: '9000', locale: 'zh' };
        runtime().receive(input);await runtime().runCommand(input.updateId);await drain();
      };
      const panelEdit = () => sent.filter(row => row.method === 'editMessageText' && row.params.message_id === detail.messageId).at(-1).params.text;
      let pending = await prompt();
      expect(sent.findLast(row => row.params.reply_markup?.force_reply).params.text).toBe('Reply with the USD amount of MEME (Arc) to buy, up to 2 decimals, cap $100. /cancel to stop.');
      await answer(pending, '150');
      expect(trades()).toEqual([]);
      expect(panelEdit()).toMatch(/^⚠️ Above your per-trade buy cap of \$100; refused\. Adjust it in Trade limits\.\n\n<b>MEME/);
      expect(sent.some(row => row.method === 'sendMessage' && row.params.text?.includes('Above your'))).toBe(false);
      pending = await prompt();
      expect(panelEdit()).toMatch(/^<b>MEME/);
      await answer(pending, 'ten dollars');
      expect(panelEdit()).toMatch(/^⚠️ Invalid amount: reply like 25 or 12\.5\.\n\n<b>MEME/);
      expect(runtime().commands.sessions.get(detail.id).query).toMatchObject({ pendingInput: { promptMessageId: pending.promptMessageId } });
      await answer(pending, '12.5');
      expect(trades()[0]).toMatchObject({ state: 'QUOTING', usdCents: 1250 });
    });
  });
});

describe('buying before the safety check verified a token', () => {
  it.each([
    ['a hot-list row that never became a candidate', null, 'none', 'UNVERIFIED'],
    ['a lead whose check has not run', 'LIVE_READY', null, 'UNVERIFIED'],
    ['a degraded check', 'LIVE_READY', check({ dex: 'ERROR' }), 'UNVERIFIED'],
    ['an unknown verdict', 'LIVE_READY', check({ security: { ...SECURITY, complete: false, verdict: 'UNKNOWN', unknownFields: ['honeypot'] } }), 'UNVERIFIED'],
    ['a complete record whose verdict is unknown', 'LIVE_READY', { status: 'COMPLETE', security: { verdict: 'UNKNOWN' } }, 'UNVERIFIED'],
    ['a complete check with a security conflict', 'LIVE_READY', conflicted('SECURITY_MISMATCH'), 'UNVERIFIED'],
    ['a complete check with a market conflict', 'LIVE_READY', conflicted('MARKET_MISMATCH'), 'UNVERIFIED'],
    ['a complete check without fatal flags', 'LIVE_READY', VERIFIED, 'VERIFIED'],
    ['a complete check with a waiting deep-audit failure', 'X_REVIEW', VERIFIED, 'UNVERIFIED', { failed: ['notHoneypot'], blockingUnknownFields: [] }],
    ['a complete check with a blocking unknown deep-audit field', 'X_REVIEW', VERIFIED, 'UNVERIFIED', { failed: [], blockingUnknownFields: ['buyTax'] }],
    ['a complete check with a legacy deep audit that has only unknownFields', 'X_REVIEW', VERIFIED, 'UNVERIFIED', { failed: [], unknownFields: ['top10'] }],
    ['a fatal verdict', 'LIVE_READY', FATAL, 'VETOED'],
    ['a hard reject with a clean check', 'HARD_REJECT', VERIFIED, 'VETOED'],
    ['a risk exclusion with a clean check', 'exclusion', VERIFIED, 'VETOED']
  ])('classifies %s as %s', async (name, status, secondary, expected, deep = null) => {
    await withTrading(`unverified-state-${name.replaceAll(' ', '-')}`, async ({ storage, tenantId, seed }) => {
      if (status !== null) seed('arc', status === 'exclusion' ? 'LIVE_READY' : status, secondary);
      if (deep) storage.sql.exec('UPDATE candidates SET deep_json=? WHERE tenant_id=?', JSON.stringify(deep), tenantId);
      if (status === 'exclusion') storage.sql.exec('INSERT INTO risk_exclusions (tenant_id,chain,address,version,codes_json,reasons_json,at) VALUES (?,?,?,?,?,?,?)', tenantId, 'arc', TOKEN, 1, '[]', '[]', start);
      expect(safetyState(storage, tenantId, 'arc', TOKEN)).toBe(expected);
      expect(safetyState(storage, tenantId, 'arc', TOKEN.toLowerCase())).toBe(expected);
    });
  });

  it('the engine refuses an unverified buy without the acknowledgement and records one made with it; sells and verified buys need none', async () => {
    await withTrading('unverified-engine', async ({ runtime, storage, seed, createWallet, trades }) => {
      seed('arc', 'LIVE_READY', null);await createWallet();
      const request = changes => storage.transactionSync(() => runtime().trading.requestTradeInTransaction({ chain: 'arc', token: TOKEN, side: 'buy', usdCents: 1000, slippageBps: 500, capUsd: 100, ...changes }));
      let refusal;
      try { request({}); } catch (error) { refusal = error; }
      expect(refusal).toBeInstanceOf(TradeRefusal);
      expect(refusal).toMatchObject({ code: 'UNVERIFIED', request: { chain: 'arc', token: TOKEN, usdCents: 1000 } });
      // Only a literal true acknowledges, and a buy over the cap is refused before anyone is asked.
      for (const unverifiedAcknowledged of ['yes', 1, {}]) expect(() => request({ unverifiedAcknowledged })).toThrow(expect.objectContaining({ code: 'UNVERIFIED' }));
      expect(() => request({ usdCents: 20_000 })).toThrow(expect.objectContaining({ code: 'OVER_CAP' }));
      expect(trades()).toEqual([]);
      expect(request({ unverifiedAcknowledged: true })).toMatchObject({ side: 'buy', usdCents: 1000, unverifiedAtRequest: true });
      expect(request({ side: 'sell', usdCents: null, percent: 50 })).toMatchObject({ side: 'sell', unverifiedAtRequest: false });
      seed('arc', 'LIVE_READY', FATAL);
      expect(() => request({ unverifiedAcknowledged: true })).toThrow(expect.objectContaining({ code: 'VETOED' }));
      expect(() => request({ unverifiedAcknowledged: true, usdCents: 20_000 })).toThrow(expect.objectContaining({ code: 'VETOED' }));
      seed('arc', 'LIVE_READY', VERIFIED);
      expect(request({})).toMatchObject({ unverifiedAtRequest: false });
      expect(trades()).toHaveLength(3);
    });
  });

  it('asks Yes/No before buying a pasted token whose lookup is running, and refuses any buy once its lookup is vetoed', async () => {
    await withTrading('lookup-buy', async ({ runtime, storage, network, paste, lookupStep, click, link, has, createWallet, trades, lastText }) => {
      await createWallet();network.fund('arc', 50n * 10n ** 18n, { [ARC_USDC_ERC20]: 50_000_000n });
      const detail = await paste(TOKEN), session = () => runtime().commands.sessions.get(detail.id);
      expect(lastText()).toContain('Looking up on Arc');
      await click(link(detail, 'trade.buy', params => params.usd === 1));
      expect(session()).toMatchObject({ panel: 'trade_unverified', query: { unverifiedBuy: { chain: 'arc', token: TOKEN, usdCents: 100 } } });
      expect(trades()).toEqual([]);expect(network.kyber).toEqual([]);
      await click(link(session(), 'trade.decline_unverified'));
      const details = async () => ({ token: { symbol: 'MEME', name: 'Meme', current_price_usd: 0.001, market_cap: 1000, main_pair_tvl: 500, tvl: null, holders: 10, launch_at: null, created_at: null, token_price_change_5m: null, token_tx_volume_usd_5m: null }, capturedAt: Date.now() });
      const secondary = { fetchSource: async ({ source }) => source === 'dexScreener'
        ? { source: { status: 'OK' }, market: { complete: true, priceUsd: 0.001, marketCap: 1000, liquidityUsd: 500, pairUrl: '', websites: [] } }
        : { source: { status: 'OK' }, security: FATAL.security } };
      for (let index = 0; index < 3; index++) await lookupStep({ details, secondary });
      expect(session().panel).toBe('detail');expect(lastText()).toContain('⛔ Vetoed');
      expect(has(session(), 'trade.buy')).toBe(false);expect(has(session(), 'trade.sell')).toBe(true);
      expect(() => storage.transactionSync(() => runtime().trading.requestTradeInTransaction({ chain: 'arc', token: TOKEN, side: 'buy', usdCents: 1000, slippageBps: 500, capUsd: 100, unverifiedAcknowledged: true })))
        .toThrow(expect.objectContaining({ code: 'VETOED' }));
      expect(trades()).toEqual([]);
    });
  });

  it('says a pasted token\'s clean check is stale once it is too old to verify a buy, on the detail and in the Buy question', async () => {
    await withTrading('lookup-stale-question', async ({ runtime, paste, lookupStep, click, link, command, sessions, createWallet, trades, lastText, clock }) => {
      await createWallet();
      const detail = await paste(TOKEN);
      // Open the detail afresh from the Watchlist; an older panel's buttons have expired by then.
      const open = async () => { await command('watchlist');const list = sessions().at(-1);await click(link(list, 'panel.open', params => params.panel === 'detail'));return list; };
      const details = async () => ({ token: { symbol: 'MEME', name: 'Meme', current_price_usd: 0.001, market_cap: 1000, main_pair_tvl: 500, tvl: null, holders: 10, launch_at: null, created_at: null, token_price_change_5m: null, token_tx_volume_usd_5m: null }, capturedAt: clock.now() });
      const secondary = { fetchSource: async ({ source }) => source === 'dexScreener'
        ? { source: { status: 'OK' }, market: { complete: true, priceUsd: 0.001, marketCap: 1000, liquidityUsd: 500, pairUrl: '', websites: [] } }
        : { source: { status: 'OK' }, security: VERIFIED.security } };
      for (let index = 0; index < 3; index++) await lookupStep({ details, secondary });
      await click(link(runtime().commands.sessions.get(detail.id), 'favorite.set'));
      clock.advance(LOOKUP_SETTINGS.verifiedMs);
      await open();
      expect(lastText()).toMatch(/✅ No failures found · checked 15m ago\n/);
      clock.advance(1);
      const list = await open();
      expect(lastText()).toMatch(/✅ No failures found · checked 15m ago · stale, paste the address again to re-check\n/);
      await click(link(list, 'trade.buy', params => params.usd === 1));
      expect(runtime().commands.sessions.get(list.id).panel).toBe('trade_unverified');
      expect(lastText()).toMatch(/⚠️ Safety check is stale[\s\S]*GoPlus and DexScreener checked this token 15m ago; that check is stale\./);
      expect(trades()).toEqual([]);
    });
  });

  it('offers no buy of a watched token whose lookup was vetoed more than 24 h ago', async () => {
    await withTrading('lookup-veto-watched', async ({ runtime, paste, lookupStep, click, link, has, command, sessions, createWallet, clock }) => {
      await createWallet();
      const detail = await paste(TOKEN);
      const details = async () => ({ token: { symbol: 'MEME', name: 'Meme', current_price_usd: 0.001, market_cap: 1000, main_pair_tvl: 500, tvl: null, holders: 10, launch_at: null, created_at: null, token_price_change_5m: null, token_tx_volume_usd_5m: null }, capturedAt: clock.now() });
      const secondary = { fetchSource: async ({ source }) => source === 'dexScreener'
        ? { source: { status: 'OK' }, market: { complete: true, priceUsd: 0.001, marketCap: 1000, liquidityUsd: 500, pairUrl: '', websites: [] } }
        : { source: { status: 'OK' }, security: FATAL.security } };
      for (let index = 0; index < 3; index++) await lookupStep({ details, secondary });
      await click(link(runtime().commands.sessions.get(detail.id), 'favorite.set'));
      clock.advance(LOOKUP_SETTINGS.expiryMs + 1);
      await command('watchlist');
      const list = sessions().at(-1);
      await click(link(list, 'panel.open', params => params.panel === 'detail'));
      expect(runtime().commands.sessions.get(list.id).panel).toBe('detail');
      expect(has(list, 'trade.buy')).toBe(false);expect(has(list, 'trade.sell')).toBe(true);
    });
  });

  it('asks Yes/No before a preset buy of an unverified token: No requests nothing, Yes quotes with a warning', async () => {
    await withTrading('unverified-preset', async ({ runtime, network, sent, click, link, run, seed, createWallet, openDetail, trades, tradeOf, lastText }) => {
      seed('arc', 'LIVE_READY', null);await createWallet();network.fund('arc', 50n * 10n ** 18n, { [ARC_USDC_ERC20]: 50_000_000n });
      const detail = await openDetail();
      await click(link(detail, 'trade.buy', params => params.usd === 1));
      const session = () => runtime().commands.sessions.get(detail.id);
      expect(session()).toMatchObject({ panel: 'trade_unverified', query: { unverifiedBuy: { chain: 'arc', token: TOKEN, usdCents: 100 } } });
      expect(lastText()).toContain('Safety check not finished');expect(lastText()).toContain('MEME · Arc — buy $1?');
      expect(sent.at(-1).params.reply_markup.inline_keyboard[0].map(item => item.text)).toEqual(['✅ Yes', '❌ No']);
      expect(trades()).toEqual([]);expect(network.kyber).toEqual([]);

      await click(link(session(), 'trade.decline_unverified'));
      expect(session().panel).toBe('detail');expect(trades()).toEqual([]);expect(network.kyber).toEqual([]);

      await click(link(session(), 'trade.buy', params => params.usd === 1));
      await click(link(session(), 'trade.acknowledge_unverified'));
      expect(tradeOf(detail)).toMatchObject({ state: 'QUOTING', usdCents: 100, unverifiedAtRequest: true });
      await run(() => tradeOf(detail).state === 'QUOTED');
      expect(lastText()).toContain('Requested before the safety check verified it.');expect(lastText()).toContain('Confirm');
      expect(session().query.returnTo.panel).toBe('detail');
    });
  });

  it('honors Yes only from the question panel, even when another panel carries a pending buy', async () => {
    await withTrading('unverified-guard', async ({ runtime, storage, click, seed, createWallet, openDetail, trades, sent }) => {
      seed('arc', 'LIVE_READY', null);await createWallet();
      const detail = await openDetail();
      const sessions = runtime().commands.sessions;
      const [[yes]] = storage.transactionSync(() => {
        const current = sessions.get(detail.id);
        sessions.saveInTransaction({ ...current, query: { ...current.query, unverifiedBuy: { chain: 'arc', token: TOKEN, usdCents: 1000 } } });
        return sessions.bindKeyboardInTransaction(sessions.get(detail.id), [[{ text: 'Yes', action: 'trade.acknowledge_unverified', params: {} }]], runtime().commands.controls.snapshot());
      });
      await click({ id: yes.callback_data.slice('cb:'.length), origin_message_id: sessions.get(detail.id).messageId });
      expect(trades()).toEqual([]);expect(sent.at(-1).params.text).toMatch(/old action was not applied/);
    });
  });

  it('asks before buying a token whose sources conflict, even though its check is complete', async () => {
    await withTrading('unverified-conflict', async ({ runtime, click, link, seed, createWallet, openDetail, trades }) => {
      seed('arc', 'LIVE_READY', conflicted('SECURITY_MISMATCH'));await createWallet();
      const detail = await openDetail();
      await click(link(detail, 'trade.buy', params => params.usd === 1));
      expect(runtime().commands.sessions.get(detail.id)).toMatchObject({ panel: 'trade_unverified', query: { unverifiedBuy: { usdCents: 100 } } });
      expect(trades()).toEqual([]);
    });
  });

  it('fails a buy loudly on a malformed recorded check instead of guessing, and still sells', async () => {
    await withTrading('unverified-corrupt', async ({ runtime, storage, tenantId, seed, createWallet, trades }) => {
      seed('arc');await createWallet();
      const request = changes => storage.transactionSync(() => runtime().trading.requestTradeInTransaction({ chain: 'arc', token: TOKEN, usdCents: 1000, slippageBps: 500, capUsd: 100, ...changes }));
      for (const column of ['secondary_json', 'deep_json']) {
        seed('arc');
        storage.sql.exec(`UPDATE candidates SET ${column}=? WHERE tenant_id=?`, '{not json', tenantId);
        expect(() => safetyState(storage, tenantId, 'arc', TOKEN), column).toThrow(SyntaxError);
        expect(() => request({ side: 'buy', unverifiedAcknowledged: true }), column).toThrow(SyntaxError);
        expect(trades(), column).toEqual([]);
      }
      expect(request({ side: 'sell', usdCents: null, percent: 50 })).toMatchObject({ side: 'sell' });
    });
  });

  it('asks before a custom-amount buy of an unverified token and buys exactly that amount on Yes', async () => {
    await withTrading('unverified-custom', async ({ runtime, click, link, seed, createWallet, openDetail, trades, reply }) => {
      seed('arc', 'LIVE_READY', null);await createWallet();
      const detail = await openDetail();
      await click(link(detail, 'trade.input', params => params.side === 'buy'));
      await reply(detail, '12.5');
      const session = () => runtime().commands.sessions.get(detail.id);
      expect(session()).toMatchObject({ panel: 'trade_unverified', query: { unverifiedBuy: { usdCents: 1250 } } });
      expect(trades()).toEqual([]);
      await click(link(session(), 'trade.acknowledge_unverified'));
      expect(trades()).toEqual([expect.objectContaining({ usdCents: 1250, unverifiedAtRequest: true })]);
    });
  });

  it('binds Yes to the question it answered: a stale Yes is rejected and a replayed Yes buys once', async () => {
    await withTrading('unverified-stale', async ({ runtime, click, link, seed, createWallet, openDetail, trades, sent }) => {
      seed('arc', 'LIVE_READY', null);await createWallet();
      const detail = await openDetail();
      const session = () => runtime().commands.sessions.get(detail.id);
      await click(link(detail, 'trade.buy', params => params.usd === 1));
      const yesFor10 = link(session(), 'trade.acknowledge_unverified');
      await click(link(session(), 'trade.decline_unverified'));
      await click(link(session(), 'trade.buy', params => params.usd === 2));
      await click(yesFor10);
      expect(trades()).toEqual([]);expect(sent.at(-1).params.text).toMatch(/old action was not applied/);
      expect(session()).toMatchObject({ panel: 'trade_unverified', query: { unverifiedBuy: { usdCents: 200 } } });
      const yesFor20 = link(session(), 'trade.acknowledge_unverified');
      await click(yesFor20);
      await click(yesFor20);
      expect(trades()).toEqual([expect.objectContaining({ usdCents: 200, unverifiedAtRequest: true })]);
    });
  });

  it('lets Yes proceed once the check verifies the token, and refuses it once the check finds it fatal', async () => {
    await withTrading('unverified-meanwhile', async ({ runtime, click, link, seed, createWallet, openDetail, trades, sent }) => {
      seed('arc', 'LIVE_READY', null);await createWallet();
      const first = await openDetail();
      await click(link(first, 'trade.buy', params => params.usd === 1));
      seed('arc', 'LIVE_READY', VERIFIED);
      await click(link(runtime().commands.sessions.get(first.id), 'trade.acknowledge_unverified'));
      expect(trades()).toEqual([expect.objectContaining({ usdCents: 100, unverifiedAtRequest: false })]);

      seed('arc', 'LIVE_READY', null);
      const second = await openDetail();
      await click(link(second, 'trade.buy', params => params.usd === 2));
      seed('arc', 'LIVE_READY', FATAL);
      await click(link(runtime().commands.sessions.get(second.id), 'trade.acknowledge_unverified'));
      expect(trades()).toHaveLength(1);
      expect(sent.some(row => row.params.text?.includes('buy was refused'))).toBe(true);
      expect(runtime().commands.sessions.get(second.id).panel).toBe('detail');
    });
  });

  it('never asks for a sell or a verified buy', async () => {
    await withTrading('unverified-skip', async ({ runtime, click, link, seed, createWallet, openDetail, tradeOf }) => {
      seed('arc', 'LIVE_READY', null);await createWallet();
      const detail = await openDetail();
      await click(link(detail, 'trade.sell', params => params.percent === 25));
      expect(runtime().commands.sessions.get(detail.id).panel).toBe('trade');
      expect(tradeOf(detail)).toMatchObject({ side: 'sell', unverifiedAtRequest: false });

      seed('arc', 'LIVE_READY', VERIFIED);
      const verified = await openDetail();
      await click(link(verified, 'trade.buy', params => params.usd === 1));
      expect(runtime().commands.sessions.get(verified.id).panel).toBe('trade');
      expect(tradeOf(verified)).toMatchObject({ side: 'buy', unverifiedAtRequest: false });
    });
  });

  it('keeps an acknowledged buy acknowledged on requote, and asks again when a verified quote expires onto an unverified token', async () => {
    await withTrading('unverified-requote', async ({ runtime, network, click, link, run, seed, createWallet, openDetail, confirm, tradeOf, trades, clock }) => {
      seed('bsc', 'LIVE_READY', null);await createWallet();network.fund('bsc', 10n ** 18n);
      const acknowledged = await openDetail('bsc');
      await click(link(acknowledged, 'trade.buy', params => params.usd === 1));
      await click(link(runtime().commands.sessions.get(acknowledged.id), 'trade.acknowledge_unverified'));
      await run(() => tradeOf(acknowledged).state === 'QUOTED');
      clock.advance(30_000);
      await confirm(acknowledged);
      expect(runtime().commands.sessions.get(acknowledged.id).panel).toBe('trade');
      expect(tradeOf(acknowledged)).toMatchObject({ state: 'QUOTING', unverifiedAtRequest: true });

      seed('bsc', 'LIVE_READY', VERIFIED);
      const verified = await openDetail('bsc');
      await click(link(verified, 'trade.buy', params => params.usd === 2));
      await run(() => tradeOf(verified).state === 'QUOTED');
      const expiring = tradeOf(verified).id;
      seed('bsc', 'LIVE_READY', check({ dex: 'ERROR' }));
      clock.advance(30_000);
      await confirm(verified);
      expect(trades().find(trade => trade.id === expiring).state).toBe('EXPIRED');
      expect(runtime().commands.sessions.get(verified.id)).toMatchObject({ panel: 'trade_unverified', query: { unverifiedBuy: { chain: 'bsc', usdCents: 200 } } });
    });
  });
});

describe('trading wallet custody', () => {
  it('keeps the key encrypted everywhere, sends it only on a confirmed export, and deletes that message after 60 s', async () => {
    const logs = ['log', 'info', 'warn', 'error', 'debug'].map(level => vi.spyOn(console, level));
    try {
      await withTrading('custody', async ({ runtime, storage, tenantId, sent, click, link, has, createWallet, command, clock, drain }) => {
        const { panel } = await createWallet();
        const privateKey = await revealTradingKey(masterKey, tenantId, tradingWalletEnvelope(storage, tenantId));
        const bare = privateKey.slice(2);
        const everything = () => storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").toArray()
          .flatMap(({ name }) => storage.sql.exec(`SELECT * FROM "${name}"`).toArray()).map(row => JSON.stringify(row)).join('\n');
        expect(everything()).not.toContain(bare);
        expect(JSON.stringify(sent)).not.toContain(bare);
        const wallet = runtime().commands.sessions.get(panel.id);
        expect(has(wallet, 'wallet.export')).toBe(false);
        await click(link(wallet, 'panel.open', params => params.panel === 'wallet_export'));
        expect(JSON.stringify(sent)).not.toContain(bare);
        await click(link(runtime().commands.sessions.get(panel.id), 'wallet.export'));
        const exports = sent.filter(row => JSON.stringify(row).includes(bare));
        expect(exports).toHaveLength(1);expect(exports[0].params.text).toContain('Anyone with this key');
        expect(everything()).not.toContain(bare);
        const deletion = storage.sql.exec("SELECT next_at,payload_json FROM outbox WHERE tenant_id=? AND id LIKE 'delete:wallet-export:%'", tenantId).one();
        expect(deletion.next_at).toBe(clock.now() + 60_000);
        clock.advance(60_000);await drain();
        expect(sent.at(-1)).toMatchObject({ method: 'deleteMessage', params: { message_id: expect.any(Number) } });
        expect(storage.sql.exec("SELECT payload_json FROM outbox WHERE tenant_id=? AND id LIKE 'wallet-export:%'", tenantId).one().payload_json).not.toContain('"secret":"');
        await command('disconnect');
        expect(storage.sql.exec("SELECT name FROM keys WHERE tenant_id=?", tenantId).toArray()).toEqual([{ name: 'trade-wallet-key' }]);
        for (const spy of logs) for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain(bare);
      });
    } finally { for (const spy of logs) spy.mockRestore(); }
  });

  it('never resends an export whose delivery was ambiguous and tells the user to export again', async () => {
    await withTrading('export-ambiguous', async ({ runtime, storage, tenantId, sent, click, link, createWallet, faultTransport, drain, command, clock }) => {
      const { panel } = await createWallet();
      await click(link(runtime().commands.sessions.get(panel.id), 'panel.open', params => params.panel === 'wallet_export'));
      faultTransport({ ok: false, kind: 'unknown', code: 'TELEGRAM_TRANSPORT_UNCERTAIN' });
      await click(link(runtime().commands.sessions.get(panel.id), 'wallet.export'));
      const row = () => storage.sql.exec("SELECT status,attempts,payload_json FROM outbox WHERE tenant_id=? AND id LIKE 'wallet-export:%'", tenantId).one();
      expect(row().status).toBe('UNKNOWN');
      clock.advance(5_000);
      storage.transactionSync(() => runtime().reconcileInTransaction());await drain();
      expect(row()).toMatchObject({ status: 'UNKNOWN', attempts: 1 });expect(row().payload_json).toContain('"secret":null');
      const bare = (await revealTradingKey(masterKey, tenantId, tradingWalletEnvelope(storage, tenantId))).slice(2);
      expect(JSON.stringify(sent)).not.toContain(bare);
      await command('wallet');
      expect(sent.filter(item => item.params.text).at(-1).params.text).toContain('export may not have arrived');
    });
  });

  it('leaves the wallet on Back after create, export and removal instead of reopening a spent dialog', async () => {
    await withTrading('wallet-back', async ({ runtime, network, click, link, seed, openDetail }) => {
      seed('bsc');
      const detail = await openDetail('bsc');
      const current = () => runtime().commands.sessions.get(detail.id);
      await click(link(current(), 'panel.open', params => params.panel === 'wallet'));
      await click(link(current(), 'wallet.create'));
      network.setWallet(runtime().trading.wallet().address);
      expect(current().panel).toBe('wallet');expect(current().query.returnTo.panel).toBe('detail');
      await click(link(current(), 'panel.open', params => params.panel === 'wallet_export'));
      await click(link(current(), 'wallet.export'));
      expect(current().panel).toBe('wallet');expect(current().query.returnTo.panel).toBe('detail');
      await click(link(current(), 'panel.open', params => params.panel === 'wallet_remove'));
      await click(link(current(), 'wallet.remove'));
      expect(runtime().trading.wallet()).toBeNull();
      await click(link(current(), 'panel.back'));
      expect(current().panel).toBe('detail');
    });
  });

  it('removes the wallet only from its warning panel', async () => {
    await withTrading('remove', async ({ runtime, storage, tenantId, click, link, has, createWallet, sent }) => {
      const { panel } = await createWallet();
      expect(has(runtime().commands.sessions.get(panel.id), 'wallet.remove')).toBe(false);
      await click(link(runtime().commands.sessions.get(panel.id), 'panel.open', params => params.panel === 'wallet_remove'));
      expect(sent.at(-1).params.text).toContain('unrecoverable');
      await click(link(runtime().commands.sessions.get(panel.id), 'wallet.remove'));
      expect(storage.sql.exec('SELECT name FROM keys WHERE tenant_id=?', tenantId).toArray()).toEqual([]);
      expect(runtime().trading.wallet()).toBeNull();
    });
  });
});


describe('trading safety on review', () => {
  const OTHER = getAddress('0x' + '77'.repeat(20));

  it.each([['recipient', { dstReceiver: OTHER }], ['minimum out', { minReturnAmount: 1n }], ['source token', { srcToken: OTHER }], ['destination token', { dstToken: OTHER }],
    ['amount', { amount: 1n }], ['fee receiver', { feeReceivers: [OTHER], feeAmounts: [1n] }], ['flags', { flags: 2n }]])('refuses a build whose calldata changes the %s and never signs', async (_name, tamper) => {
    await withTrading('tamper', async ({ network, seed, createWallet, quote, tradeOf }) => {
      seed('bsc');await createWallet();network.fund('bsc', 10n ** 18n);
      network.knobs.tamper = tamper;
      const detail = await quote();
      expect(tradeOf(detail)).toMatchObject({ state: 'FAILED', result: { reason: 'KYBER_CALLDATA_REFUSED' }, quote: null });
      expect(network.chains.bsc.sent).toEqual([]);
    });
  });

  it('re-verifies stored calldata against the confirmed minimum right before signing', async () => {
    await withTrading('presign-calldata', async ({ storage, tenantId, network, seed, createWallet, quote, confirm, run, tradeOf }) => {
      seed('bsc');await createWallet();network.fund('bsc', 10n ** 18n);
      const detail = await quote();
      const trade = tradeOf(detail);
      const tampered = { ...trade, quote: { ...trade.quote, data: swapCalldata({ tokenIn: KYBER_NATIVE_TOKEN, tokenOut: TOKEN, amountIn: BigInt(trade.amountIn), recipient: OTHER, minReturnAmount: BigInt(trade.quote.minAmountOut) }) } };
      storage.sql.exec('UPDATE scheduler_state SET value_json=? WHERE tenant_id=? AND key=?', JSON.stringify(tampered), tenantId, `trade:${trade.id}`);
      await confirm(detail);
      expect(tradeOf(detail).confirmedMinAmountOut).toBe(trade.quote.minAmountOut);
      await run(() => tradeOf(detail).state !== 'CONFIRMED');
      expect(tradeOf(detail)).toMatchObject({ state: 'FAILED', result: { reason: 'KYBER_CALLDATA_REFUSED' }, swap: null });
      expect(network.chains.bsc.sent).toEqual([]);
    });
  });

  it('keeps an ambiguously answered broadcast sent, rebroadcasts the identical bytes and settles by receipt', async () => {
    await withTrading('ambiguous-json-rpc', async ({ network, seed, createWallet, quote, confirm, run, tradeOf }) => {
      seed('bsc');await createWallet();network.fund('bsc', 10n ** 18n);
      const detail = await quote();
      const raws = [];
      network.chains.bsc.beforeBatch = batch => raws.push(...batch.filter(call => call.method === 'eth_sendRawTransaction').map(call => call.params[0]));
      network.chains.bsc.sendRefusal = 'internal error';
      await confirm(detail);
      await run(() => tradeOf(detail).state === 'SWAP_SENT');
      expect(tradeOf(detail).swap.uncertain).toBe(true);
      await run(() => tradeOf(detail).state === 'FILLED');
      expect(raws.length).toBeGreaterThanOrEqual(2);expect(new Set(raws).size).toBe(1);
      expect(network.chains.bsc.sent).toHaveLength(1);
    });
  });

  it('turns an HTTP 5xx broadcast into UNKNOWN after the deadline, never FAILED, and releases the wallet', async () => {
    await withTrading('ambiguous-5xx', async ({ runtime, network, seed, createWallet, quote, confirm, run, tradeOf }) => {
      seed('bsc');await createWallet();network.fund('bsc', 10n ** 18n);
      const detail = await quote();
      network.chains.bsc.httpFault = 502;network.chains.bsc.mine = false;
      await confirm(detail);
      await run(() => tradeOf(detail).state === 'SWAP_SENT');
      await run(() => tradeOf(detail).state !== 'SWAP_SENT');
      expect(tradeOf(detail)).toMatchObject({ state: 'UNKNOWN', result: { reason: 'NO_RECEIPT' } });
      expect(runtime().trading.executing()).toBeNull();
    });
  });

  it('fails a definitely refused broadcast and frees the wallet for the next trade', async () => {
    await withTrading('refused', async ({ runtime, network, seed, createWallet, quote, confirm, run, tradeOf }) => {
      seed('bsc');await createWallet();network.fund('bsc', 10n ** 18n);
      const first = await quote();
      network.chains.bsc.sendRefusal = 'insufficient funds for gas * price + value';
      await confirm(first);
      await run(() => ['FAILED', 'UNKNOWN', 'FILLED'].includes(tradeOf(first).state));
      expect(tradeOf(first)).toMatchObject({ state: 'FAILED', result: { reason: 'BROADCAST_REJECTED_INSUFFICIENT_FUNDS' } });
      expect(network.chains.bsc.sent).toEqual([]);
      const second = await quote();
      await confirm(second);
      expect(tradeOf(second).state).toBe('CONFIRMED');
      await run(() => tradeOf(second).state === 'FILLED');
      expect(runtime().trading.executing()).toBeNull();
    });
  });

  it('settles a native-out sell from the balance change across its block', async () => {
    await withTrading('native-out', async ({ network, seed, createWallet, quote, confirm, run, tradeOf }) => {
      seed('bsc');await createWallet();network.fund('bsc', 10n ** 18n, { [TOKEN]: 2_000_000_000_000n });
      const detail = await quote('bsc', 'trade.sell', params => params.percent === 50);
      expect(tradeOf(detail).amountIn).toBe('1000000000000');
      const before = 10n ** 18n, fee = 0x5208n * 2n, gained = 3_000_000_000_000_000n;
      network.chains.bsc.balanceAt = { '0xf': before, '0x10': before + gained - fee };
      await confirm(detail);
      await run(() => tradeOf(detail).state === 'FILLED');
      expect(tradeOf(detail).result).toMatchObject({ received: gained.toString(), spent: '1000000000000' });
    });
  });

  it.each([['nothing was signed', 'CONFIRMED', 'FAILED'], ['a swap was signed', 'SWAP_SIGNED', 'UNKNOWN']])('ends a trade whose step throws until the scheduler gives up (%s)', async (_name, stuck, outcome) => {
    await withTrading(`give-up-${stuck}`, async ({ runtime, storage, tenantId, network, seed, createWallet, quote, confirm, run, tradeOf, trades, clock }) => {
      seed('bsc');await createWallet();network.fund('bsc', 10n ** 18n);
      const detail = await quote();
      await confirm(detail);
      if (stuck === 'SWAP_SIGNED') await run(() => tradeOf(detail).state === 'SWAP_SIGNED');
      // Sessions expire while the scheduler backs off; follow the trade by its record.
      const id = tradeOf(detail).id, current = () => trades().find(trade => trade.id === id);
      network.chains.bsc.beforeBatch = () => { throw new Error('a defect in the step'); };
      const scheduler = new OneAlarmScheduler({ store: new SqliteSchedulerStore(storage, tenantId), now: clock.now, aveBudget: { monthlyCu: 1000, resetDay: 1 },
        alarms: { setAlarm: async () => {}, deleteAlarm: async () => {} },
        handlers: { trade: externalRequestHandler(({ task, request }) => runtime().trading.runStep(task.id, { request, fetchImpl: network.fetch })) },
        taskReconciler: tasks => runtime().reconcileInTransaction({ tasks }).filter(task => task.kind === 'trade') });
      for (let attempt = 0; attempt < 20 && current().state === stuck; attempt++) { await scheduler.alarm();clock.advance(60_000); }
      expect(current()).toMatchObject({ state: outcome, result: { reason: 'STEP_FAILED' } });
      if (outcome === 'UNKNOWN') expect(current().swap.hash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(runtime().trading.executing()).toBeNull();
      network.chains.bsc.beforeBatch = null;
      const next = await quote();
      await confirm(next);
      expect(tradeOf(next).state).toBe('CONFIRMED');
    });
  });

  it('re-quotes an expired confirmation with the current slippage and cap', async () => {
    await withTrading('requote-settings', async ({ runtime, network, seed, createWallet, quote, confirm, tradeOf, clock }) => {
      seed('bsc');await createWallet();network.fund('bsc', 10n ** 18n);
      const detail = await quote();
      expect(tradeOf(detail)).toMatchObject({ slippageBps: 500, capUsd: 100 });
      runtime().commands.setPreference('tradingSlippageBps', 100);runtime().commands.setPreference('tradingBuyCapUsd', 250);
      clock.advance(30_000);
      await confirm(detail);
      expect(tradeOf(detail)).toMatchObject({ state: 'QUOTING', slippageBps: 100, capUsd: 250 });
    });
  });

  it('prices a native buy with a small probe, so a pool too thin for a whole coin still quotes', async () => {
    await withTrading('thin-pool', async ({ network, seed, createWallet, quote, tradeOf }) => {
      seed('bsc');await createWallet();network.fund('bsc', 10n ** 18n);
      network.knobs.thinPool = true;
      const detail = await quote();
      expect(tradeOf(detail)).toMatchObject({ state: 'QUOTED', priceMicroUsd: '600000000' });
    });
  });

  it('refuses a native buy whose routed USD value exceeds the cap', async () => {
    await withTrading('cap-mismatch', async ({ network, seed, createWallet, quote, tradeOf }) => {
      seed('bsc');await createWallet();network.fund('bsc', 10n ** 18n);
      network.knobs.nativeUsd = 60n;network.knobs.routeUsd = '150';
      const detail = await quote('bsc', 'trade.buy', params => params.usd === 5);
      expect(tradeOf(detail)).toMatchObject({ state: 'FAILED', result: { reason: 'OVER_CAP' }, quote: null });
    });
  });
});

describe('guarded wallet removal', () => {
  const removePanel = async ({ runtime, click, link, createWallet }) => {
    const { panel } = await createWallet();
    await click(link(runtime().commands.sessions.get(panel.id), 'panel.open', params => params.panel === 'wallet_remove'));
    return panel;
  };

  it('refuses while a trade is open, even from an earlier confirmation button', async () => {
    await withTrading('remove-open', async context => {
      const { runtime, storage, tenantId, click, link, has, seed, quote, sent } = context;
      seed('bsc');
      const panel = await removePanel(context);
      const stale = link(runtime().commands.sessions.get(panel.id), 'wallet.remove');
      await quote();
      await click(stale);
      expect(storage.sql.exec('SELECT name FROM keys WHERE tenant_id=?', tenantId).toArray()).toEqual([{ name: 'trade-wallet-key' }]);
      expect(sent.some(row => row.params.text?.includes('cannot be removed yet'))).toBe(true);
      await click(link(runtime().commands.sessions.get(panel.id), 'panel.back'));
      await click(link(runtime().commands.sessions.get(panel.id), 'panel.open', params => params.panel === 'wallet_remove'));
      expect(has(runtime().commands.sessions.get(panel.id), 'wallet.remove')).toBe(false);
    });
  });

  it('refuses while a trade is UNKNOWN until a refresh resolves it from its receipt', async () => {
    await withTrading('remove-unknown', async context => {
      const { runtime, storage, tenantId, network, click, link, seed, quote, confirm, run, tradeOf, drain } = context;
      seed('bsc');
      const panel = await removePanel(context);
      network.chains.bsc.mine = false;network.fund('bsc', 10n ** 18n);
      const detail = await quote();
      await confirm(detail);
      await run(() => tradeOf(detail).state === 'UNKNOWN');
      network.fund('bsc', 0n);
      const stale = link(runtime().commands.sessions.get(panel.id), 'wallet.remove');
      await click(stale);
      expect(runtime().trading.wallet()).not.toBeNull();
      network.chains.bsc.mine = true;
      await context.command('wallet');
      const wallet = context.sessions().at(-1);
      await click(link(wallet, 'wallet.refresh'));
      await run(() => tradeOf(detail).state !== 'UNKNOWN' && runtime().trading.balances().pending.length === 0);
      await drain();
      expect(tradeOf(detail).state).toBe('FILLED');
      await click(link(runtime().commands.sessions.get(wallet.id), 'panel.open', params => params.panel === 'wallet_remove'));
      await click(link(runtime().commands.sessions.get(wallet.id), 'wallet.remove'));
      expect(storage.sql.exec('SELECT name FROM keys WHERE tenant_id=?', tenantId).toArray()).toEqual([]);
    });
  });

  it('asks for an export first when funds were seen and the key was never exported, then removes after export', async () => {
    await withTrading('remove-export-first', async context => {
      const { runtime, storage, tenantId, network, click, link, has, run, drain, sent } = context;
      const { panel } = await context.createWallet();
      network.fund('arc', 5n * 10n ** 18n);network.fund('bsc', 0n);
      await click(link(runtime().commands.sessions.get(panel.id), 'wallet.refresh'));
      await run(() => runtime().trading.balances().pending.length === 0);
      await drain();
      await click(link(runtime().commands.sessions.get(panel.id), 'panel.open', params => params.panel === 'wallet_remove'));
      const removal = runtime().commands.sessions.get(panel.id);
      expect(has(removal, 'wallet.remove')).toBe(false);
      expect(sent.at(-1).params.text).toContain('Export it first');
      await click(link(removal, 'panel.open', params => params.panel === 'wallet_export'));
      await click(link(runtime().commands.sessions.get(panel.id), 'wallet.export'));
      expect(runtime().trading.wallet().exportedAt).not.toBeNull();
      await click(link(runtime().commands.sessions.get(panel.id), 'panel.open', params => params.panel === 'wallet_remove'));
      await click(link(runtime().commands.sessions.get(panel.id), 'wallet.remove'));
      expect(storage.sql.exec('SELECT name FROM keys WHERE tenant_id=?', tenantId).toArray()).toEqual([]);
    });
  });

  it('refuses a stale removal button once funds are seen on an unexported key', async () => {
    await withTrading('remove-stale-funds', async context => {
      const { runtime, network, click, link, run, drain, sent } = context;
      const panel = await removePanel(context);
      const stale = link(runtime().commands.sessions.get(panel.id), 'wallet.remove');
      await context.command('wallet');
      const wallet = context.sessions().at(-1);
      network.fund('arc', 1n);network.fund('bsc', 0n);
      await click(link(wallet, 'wallet.refresh'));
      await run(() => runtime().trading.balances().pending.length === 0);
      await drain();
      await click(stale);
      expect(runtime().trading.wallet()).not.toBeNull();
      expect(sent.some(row => row.params.text?.includes('export it first'))).toBe(true);
    });
  });
});
