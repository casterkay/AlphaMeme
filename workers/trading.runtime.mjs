import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, it, expect, vi } from 'vitest';
import { decodeFunctionData, encodeFunctionResult, erc20Abi, getAddress, keccak256, parseTransaction, toEventSelector } from 'viem';
import { TelegramRuntime } from '../src/bot/runtime.mjs';
import { CHART_RISK_VERSION } from '../src/scoring/chart-risk.mjs';
import { KYBER_API_ORIGIN, KYBER_ROUTER } from '../src/trading/kyber.mjs';
import { ARC_USDC_ERC20, KYBER_NATIVE_TOKEN } from '../src/trading/config.mjs';
import { listTrades } from '../src/trading/trades.mjs';
import { revealTradingKey, tradingWalletEnvelope } from '../src/trading/wallet.mjs';

const start = 1_800_000_000_000;
const masterKey = { activeVersion: '1', keys: { '1': 'trading-runtime-master-key' } };
const TOKEN = getAddress('0x' + 'ab'.repeat(20));
const CHAINS = { arc: { id: 5042, url: 'https://arc-rpc.test/' }, bsc: { id: 56, url: 'https://bsc-rpc.test/' } };
const TRANSFER = toEventSelector('Transfer(address,address,uint256)');
const word = value => '0x' + BigInt(value).toString(16).padStart(64, '0');
const topic = address => '0x' + '0'.repeat(24) + address.slice(2).toLowerCase();
const json = value => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });

// A hand-written EVM node and KyberSwap endpoint; nothing touches the network.
function venue() {
  const chains = Object.fromEntries(Object.entries(CHAINS).map(([name, facts]) => [name, { ...facts, native: 0n, tokens: {}, allowances: {}, nonce: 0, sent: [], receipts: {}, mine: true, revert: false, sendFault: null, beforeBatch: null }]));
  const kyber = [];
  const balanceOf = (chain, token, owner) => chain.tokens[`${token.toLowerCase()}:${owner.toLowerCase()}`] ?? 0n;
  function call(chain, wallet, request) {
    const { method, params } = request;
    if (method === 'eth_chainId') return '0x' + chain.id.toString(16);
    if (method === 'eth_getTransactionCount') return '0x' + (params[1] === 'latest' ? chain.sent.filter(tx => chain.receipts[tx.hash]).length : chain.nonce).toString(16);
    if (method === 'eth_gasPrice') return '0x3b9aca00';
    if (method === 'eth_getBlockByNumber') return { number: '0x10', baseFeePerGas: '0x1' };
    if (method === 'eth_getBalance') return '0x' + chain.native.toString(16);
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
        return json({ code: 0, data: { routerAddress: KYBER_ROUTER, routeSummary: { tokenIn, tokenOut, amountIn, amountOut: '5000000000000', amountInUsd: tokenIn === KYBER_NATIVE_TOKEN && amountIn === String(10n ** 18n) ? '600' : '10', amountOutUsd: '9.5', gasUsd: '0.01' } } });
      }
      const { routeSummary } = JSON.parse(init.body);
      return json({ code: 0, data: { routerAddress: KYBER_ROUTER, amountIn: routeSummary.amountIn, amountOut: routeSummary.amountOut, amountInUsd: '10', amountOutUsd: '9.5', gasUsd: '0.01',
        transactionValue: routeSummary.tokenIn === KYBER_NATIVE_TOKEN ? routeSummary.amountIn : '0', data: '0xdeadbeef' + BigInt(routeSummary.amountIn).toString(16).padStart(64, '0') } });
    }
    const chain = Object.values(chains).find(item => item.url.replace(/\/$/, '') === target);
    const batch = JSON.parse(init.body);
    if (chain.beforeBatch) chain.beforeBatch(batch);
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
  return { chains, kyber, fetch, setWallet: address => { walletAddress = address; }, fund: (name, native, tokens = {}) => {
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
    const receipt = (commandType, payload, overrides = {}) => ({ tenantId, actorUserId: tenantId, updateId: String(++update), commandType, payload, dueAt: clock + 60_000, messageDate: Math.floor(clock / 1000), sourceMessageId: String(1000 + update), ...overrides });
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
    const seed = (chain = 'arc', status = 'LIVE_READY') => storage.sql.exec('INSERT INTO candidates (tenant_id,chain,address,symbol,status,audited_at,review_revision,deep_json) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,chain,address) DO UPDATE SET status=excluded.status', tenantId, chain, TOKEN, 'MEME', status, clock - 1000, 'revision', JSON.stringify({ chainPass: true, chartRisk: { version: CHART_RISK_VERSION }, checks: {}, failed: [], unknownFields: [] }));
    const createWallet = async () => {
      await command('wallet');
      const panel = sessions().at(-1);
      await click(link(panel, 'wallet.create'));
      const address = runtime.trading.wallet().address;
      network.setWallet(address);
      return { panel, address };
    };
    const openDetail = async (chain = 'arc') => {
      await command('audits');
      const list = sessions().at(-1);
      if (chain !== 'arc') {
        await click(link(list, 'panel.open', params => params.panel === 'view_chain'));
        await click(link(list, 'view_chain.set', params => params.value === chain));
      }
      await click(link(list, 'panel.open', params => params.panel === 'detail'));
      return runtime.commands.sessions.get(list.id);
    };
    const trades = () => listTrades(storage, tenantId);
    const lastText = () => sent.filter(row => row.params.text).at(-1).params.text;
    await command('lang', 'en');
    await operation({ runtime: () => runtime, restart: () => { runtime = make(); }, storage, tenantId, network, sent, command, sessions, link, has, click, run, seed, createWallet, openDetail, trades, lastText, drain,
      clock: { now: () => clock, advance: ms => { clock += ms; } }, faultTransport: fault => { transportFault = fault; } });
  });
}

describe('one-tap trading', () => {
  it('buys on Arc end to end: quote, confirm, exact approval, swap, receipt and a filled edit of the same message', async () => {
    await withTrading('arc-e2e', async ({ runtime, network, sent, click, link, run, seed, createWallet, openDetail, trades, lastText }) => {
      seed();await createWallet();
      network.fund('arc', 50n * 10n ** 18n, { [ARC_USDC_ERC20]: 50_000_000n });
      const detail = await openDetail();
      await click(link(detail, 'trade.buy', params => params.usd === 10));
      const [trade] = trades();
      expect(trade).toMatchObject({ state: 'QUOTING', side: 'buy', usdCents: 1000, tokenIn: ARC_USDC_ERC20 });
      await run(() => trades()[0].state === 'QUOTED');
      const route = network.kyber.find(item => item.path === '/arc/api/v1/routes');
      expect(route).toMatchObject({ clientId: 'radar-test', query: { tokenIn: ARC_USDC_ERC20, tokenOut: TOKEN, amountIn: '10000000' } });
      const confirm = lastText();
      expect(confirm).toContain('Spend');expect(confirm).toContain('$10 = 10 USDC');expect(confirm).toContain('$100');
      const session = runtime().commands.sessions.get(detail.id);
      expect(sent.filter(row => row.method === 'editMessageText').at(-1).params.message_id).toBe(detail.messageId);
      await click(link(session, 'trade.confirm'));
      expect(trades()[0].state).toBe('CONFIRMED');
      await run(() => ['FILLED', 'FAILED', 'UNKNOWN'].includes(trades()[0].state));
      const done = trades()[0];
      expect(done.state).toBe('FILLED');expect(done.result).toMatchObject({ received: '4000000000000', spent: '10000000' });
      const [approval, swap] = network.chains.arc.sent;
      expect(approval.tx.to.toLowerCase()).toBe(ARC_USDC_ERC20.toLowerCase());
      expect(decodeFunctionData({ abi: erc20Abi, data: approval.tx.data })).toEqual({ functionName: 'approve', args: [KYBER_ROUTER, 10_000_000n] });
      expect(swap.tx).toMatchObject({ to: KYBER_ROUTER.toLowerCase(), nonce: 1, chainId: 5042 });expect(swap.tx.value ?? 0n).toBe(0n);
      expect(lastText()).toContain('Filled');expect(lastText()).toContain('Received: 4000 MEME');
      expect(sent.filter(row => row.method === 'editMessageText').at(-1).params.message_id).toBe(detail.messageId);
    });
  });

  it('converts a USD buy to wei at the Kyber native price and needs no approval for a native input', async () => {
    await withTrading('bsc-native', async ({ runtime, network, click, link, run, seed, createWallet, openDetail, trades, lastText }) => {
      seed('bsc');await createWallet();network.fund('bsc', 10n ** 18n);
      const detail = await openDetail('bsc');
      await click(link(detail, 'trade.buy', params => params.usd === 20));
      await run(() => trades()[0].state === 'QUOTED');
      expect(network.kyber[0].query).toMatchObject({ tokenIn: KYBER_NATIVE_TOKEN, amountIn: String(10n ** 18n) });
      expect(trades()[0]).toMatchObject({ priceMicroUsd: '600000000', amountIn: String(2000n * 10_000n * 10n ** 18n / 600_000_000n) });
      expect(lastText()).toContain('$20 ≈ 0.0333333 BNB (at $600/BNB)');
      await click(link(runtime().commands.sessions.get(detail.id), 'trade.confirm'));
      await run(() => trades()[0].state === 'FILLED');
      expect(network.chains.bsc.sent).toHaveLength(1);expect(network.chains.bsc.sent[0].tx.value).toBe(BigInt(trades()[0].amountIn));
    });
  });

  it('refuses a vetoed buy at quote, at confirm and immediately before signing, and never signs', async () => {
    await withTrading('veto', async ({ runtime, storage, tenantId, network, click, link, run, seed, createWallet, openDetail, trades, sent }) => {
      seed();await createWallet();network.fund('arc', 50n * 10n ** 18n, { [ARC_USDC_ERC20]: 50_000_000n });
      const detail = await openDetail();
      const buy = link(detail, 'trade.buy', params => params.usd === 10);
      seed('arc', 'HARD_REJECT');
      await click(buy);
      expect(trades()).toEqual([]);expect(sent.at(-2).params.text).toMatch(/buy was refused/);

      seed('arc', 'LIVE_READY');
      const fresh = await openDetail();
      await click(link(fresh, 'trade.buy', params => params.usd === 10));
      await run(() => trades()[0].state === 'QUOTED');
      seed('arc', 'HARD_REJECT');
      await click(link(runtime().commands.sessions.get(fresh.id), 'trade.confirm'));
      expect(trades()[0]).toMatchObject({ state: 'FAILED', result: { reason: 'VETOED' } });

      storage.sql.exec("UPDATE candidates SET status='LIVE_READY' WHERE tenant_id=?", tenantId);
      const third = await openDetail();
      await click(link(third, 'trade.buy', params => params.usd === 10));
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
      await click(link(detail, 'trade.buy', params => params.usd === 10));
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
      await click(link(detail, 'trade.buy', params => params.usd === 10));
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
      await click(link(detail, 'trade.buy', params => params.usd === 10));
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
      await click(link(detail, 'trade.buy', params => params.usd === 10));
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
      await click(link(detail, 'trade.buy', params => params.usd === 10));
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
      await click(link(first, 'trade.buy', params => params.usd === 10));
      await run(() => trades()[0].state === 'QUOTED');
      network.chains.bsc.mine = false;
      await click(link(runtime().commands.sessions.get(first.id), 'trade.confirm'));
      const second = await openDetail('bsc');
      await click(link(second, 'trade.buy', params => params.usd === 20));
      await run(() => trades().find(trade => trade.usdCents === 2000)?.state === 'QUOTED');
      const executing = trades().find(trade => trade.usdCents === 1000);
      expect(executing.state).not.toBe('QUOTED');
      await click(link(runtime().commands.sessions.get(second.id), 'trade.confirm'));
      expect(trades().find(trade => trade.usdCents === 2000).state).toBe('QUOTED');
      expect(sent.some(row => row.params.text?.includes('Another trade is executing'))).toBe(true);
    });
  });

  it('refuses a custom buy above the cap and accepts one within it through a ForceReply', async () => {
    await withTrading('custom', async ({ runtime, click, link, seed, createWallet, openDetail, trades, sent, drain }) => {
      seed();await createWallet();
      const detail = await openDetail();
      const reply = async text => {
        await click(link(runtime().commands.sessions.get(detail.id), 'trade.input', params => params.side === 'buy'));
        const pending = runtime().commands.sessions.get(detail.id).query.pendingInput;
        const input = { tenantId: runtime().tenantId, actorUserId: runtime().tenantId, updateId: String(900 + text.length), commandType: 'reply', payload: { source: 'reply', text, replyToMessageId: pending.promptMessageId }, dueAt: start + 60_000, messageDate: start / 1000, sourceMessageId: '9000' };
        runtime().receive(input);await runtime().runCommand(input.updateId);await drain();
      };
      await reply('150');
      expect(trades()).toEqual([]);expect(sent.some(row => row.params.text?.includes('Above your per-trade buy cap of $100'))).toBe(true);
      await reply('12.5');
      expect(trades()[0]).toMatchObject({ state: 'QUOTING', usdCents: 1250 });
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

