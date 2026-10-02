import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, it, expect, vi } from 'vitest';
import { TelegramRuntime } from '../src/bot/runtime.mjs';
import { createTelegramExport } from '../src/bot/snapshot.mjs';
import { AveClient, AVE_CU } from '../src/providers/ave.mjs';
import { GoPlusAuth } from '../src/providers/goplus-auth.mjs';
import { SecondaryValidator } from '../src/providers/secondary.mjs';
import { listLookups, LOOKUP_SETTINGS } from '../src/lookup.mjs';
import { OneAlarmScheduler, externalRequestHandler } from '../src/scheduler.mjs';
import { readSchedulerStateInTransaction, SqliteSchedulerStore, writeSchedulerStateInTransaction } from '../src/storage/scheduler-state.mjs';
import { CHART_RISK_VERSION } from '../src/scoring/chart-risk.mjs';
import { safetyState } from '../src/trading/engine.mjs';

const start = 1_800_000_000_000;
const masterKey = { activeVersion: '1', keys: { '1': 'lookup-runtime-master-key' } };
const apiKey = 'ave-lookup-runtime-key-0001';
const TOKEN = '0x' + 'cd'.repeat(20);
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const GOPLUS_TOKEN_URL = 'https://api.gopluslabs.io/api/v1/token';
const GOPLUS = { appKey: 'goplus-key', appSecret: 'goplus-secret' };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const request = operation => operation({ signal: new AbortController().signal, timeoutMs: 1000 });
const CLEAN = { is_honeypot: '0', is_open_source: '1', is_mintable: '0', owner_change_balance: '0', hidden_owner: '0', cannot_sell_all: '0', selfdestruct: '0', external_call: '0',
  slippage_modifiable: '0', personal_slippage_modifiable: '0', transfer_pausable: '0', is_blacklisted: '0', trading_cooldown: '0', buy_tax: '0', sell_tax: '0' };

// Hand-written AVE and GoPlus endpoints that record every URL in order.
function network() {
  const calls = [], authorizations = [], knobs = { ave: null, goPlus: CLEAN };
  const aveToken = (address, apiChain) => ({ token: address, chain: apiChain, symbol: 'LOOK', name: 'Look token', current_price_usd: '0.0012', market_cap: '50000', main_pair_tvl: '20000',
    holders: 150, token_tx_volume_usd_5m: '4000', token_price_change_5m: '12.5', launch_at: (start - 3_600_000) / 1000, website: 'https://look.example' });
  const fetch = async (url, init = {}) => {
    const target = String(url);
    calls.push(target);
    const ave = /^https:\/\/prod\.ave-api\.com\/v2\/tokens\/([^-]+)-([a-z]+)$/.exec(target);
    if (target.startsWith('https://prod.ave-api.com/v2/tokens/trending?')) return json({ status: 1, data: { tokens: [] } });
    if (ave) {
      if (ave[1] === WBNB) return json({ status: 1, data: { token: { token: WBNB, chain: 'bsc', current_price_usd: '600' }, pairs: [] } });
      return knobs.ave ? knobs.ave(ave[1], ave[2]) : json({ status: 1, data: { token: aveToken(ave[1], ave[2]), pairs: [] } });
    }
    if (target === GOPLUS_TOKEN_URL) return json({ code: 1, message: 'ok', result: { access_token: 'goplus-token', expires_in: 7200 } });
    const goPlus = /contract_addresses=(.+)$/.exec(target);
    if (goPlus) authorizations.push(init.headers?.Authorization);
    if (goPlus) return json({ code: 1, result: { [decodeURIComponent(goPlus[1])]: knobs.goPlus } });
    throw new Error(`unexpected request ${target}`);
  };
  return { calls, authorizations, knobs, fetch, ave: () => calls.filter(url => url.startsWith('https://prod.ave-api.com/') && !url.includes(WBNB)) };
}

async function withLookups(tenantId, operation, extraEnv = {}) {
  const radar = env.RADAR.get(env.RADAR.idFromName(`lookup:${tenantId}`));
  return runInDurableObject(radar, async (_instance, { storage }) => {
    let clock = start, update = 0, message = 100;
    const net = network(), sent = [];
    // One validator, as the agent keeps one, so its GoPlus token is issued once.
    const secondary = new SecondaryValidator({ goPlusAuth: new GoPlusAuth({ ...GOPLUS, fetchImpl: net.fetch, now: () => clock }), fetchImpl: net.fetch, now: () => clock });
    const runtimeEnv = { MASTER_ENC_KEY: masterKey, AVE_MONTHLY_CU: env.AVE_MONTHLY_CU, AVE_CU_RESET_DAY: env.AVE_CU_RESET_DAY, ...extraEnv };
    const make = () => {
      const runtime = new TelegramRuntime({ storage, tenantId, env: runtimeEnv, now: () => clock });
      runtime.outbox.transport = async input => {
        sent.push(structuredClone({ method: input.method, params: input.params }));
        return { ok: true, result: input.method === 'sendMessage' ? { message_id: ++message } : input.method === 'editMessageText' ? { message_id: Number(input.params.message_id) } : true };
      };
      return runtime;
    };
    let runtime = make();
    const receipt = (commandType, payload, overrides = {}) => ({ tenantId, actorUserId: tenantId, updateId: String(++update), commandType, payload, dueAt: clock, messageDate: Math.floor(clock / 1000), sourceMessageId: String(1000 + update), locale: 'en', ...overrides });
    const drain = async () => {
      for (let count = 0; count < 100; count++) {
        const task = storage.transactionSync(() => runtime.outbox.reconcileInTransaction()).find(item => item.dueAt <= clock);
        if (!task) return;
        await runtime.outbox.deliverOne(task.id.slice('outbox:'.length), { request });
      }
      throw new Error('outbox did not converge');
    };
    const run = async input => { runtime.receive(input); await runtime.runCommand(input.updateId); await drain(); return input; };
    const sessions = () => storage.sql.exec('SELECT id FROM ui_sessions WHERE tenant_id=? ORDER BY rowid', tenantId).toArray().map(row => runtime.commands.sessions.get(row.id));
    const session = id => runtime.commands.sessions.get(id);
    const link = (shown, action, predicate = () => true) => {
      const current = session(shown.id);
      const found = storage.sql.exec('SELECT * FROM shortlinks WHERE tenant_id=? AND ui_session_id=? AND expected_ui_version=? AND action=?', tenantId, current.id, current.version, action).toArray()
        .find(row => predicate(JSON.parse(row.params_json), row));
      if (!found) throw new Error(`missing ${action} on ${current.panel} v${current.version}`);
      return found;
    };
    const click = binding => run(receipt('callback', { callbackId: binding.id, callbackQueryId: `q${update + 1}` }, { sourceMessageId: binding.origin_message_id }));
    // Connect AVE the way an owner does: /setkey, then one verification read.
    const connect = async () => {
      const input = receipt('credential', { source: 'message' });
      await runtime.receiveCredential(input, `/setkey ${apiKey}`);
      await runtime.runCommand(input.updateId);
      await runtime.verifyCredential(runtime.inbox.get(input.updateId).generation, { request, fetchImpl: net.fetch });
      await drain();
    };
    const paste = async address => { await run(receipt('lookup', { family: 'evm', address })); return sessions().at(-1); };
    const tasks = () => storage.transactionSync(() => runtime.reconcileInTransaction()).filter(task => task.kind === 'lookup');
    const details = (chain, address, options) => new AveClient({ apiKey, fetchImpl: net.fetch, now: () => clock }).details(chain, address, options);
    // Run the one due lookup step the way the scheduler's handler does.
    const step = async () => {
      const [task] = tasks();
      if (!task) throw new Error('no lookup step is scheduled');
      await runtime.lookups.runStep(task.id, { request, details, secondary });
      await drain();
    };
    const lookups = () => listLookups(storage, tenantId);
    const lastText = () => sent.filter(row => row.params.text).at(-1).params.text;
    const count = table => storage.sql.exec(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id=?`, tenantId).one().n;
    await operation({ runtime: () => runtime, restart: () => { runtime = make(); }, storage, tenantId, net, sent, secondary, receipt, run, drain, sessions, session, link, click, connect, paste,
      tasks, step, details, lookups, lastText, count, clock: { now: () => clock, advance: ms => { clock += ms; } } });
  });
}

describe('pasted contract-address lookup', () => {
  it('looks the address up on the scan chain: AVE, then GoPlus, one request per step besides the GoPlus token, editing the same detail each time', async () => {
    await withLookups('26801', async ({ runtime, net, sent, connect, paste, tasks, step, lookups, lastText, session }) => {
      await connect();
      const detail = await paste(TOKEN);
      expect(session(detail.id)).toMatchObject({ panel: 'detail', viewChain: 'arc', query: { selectedToken: { chain: 'arc', address: TOKEN } } });
      expect(lastText()).toMatch(/^<b>\? · Arc<\/b>\n⏳ Looking up on Arc…\n<code>0x(cd){20}<\/code>/);
      expect(net.ave()).toEqual([]);
      expect(tasks()).toEqual([{ id: `lookup:arc:${TOKEN}:${start}`, kind: 'lookup', dueAt: start, enabled: true, aveCost: AVE_CU.details }]);
      const edits = () => sent.filter(row => row.method === 'editMessageText' && row.params.message_id === session(detail.id).messageId).length;
      await step();
      expect(lookups()[0].state).toBe('GOPLUS');expect(edits()).toBe(1);
      expect(lastText()).toMatch(/^<b>LOOK · Arc<\/b>\n⏳ Looking up on Arc…\nMC \$50K · Liq \$20K · 150 holders\n1h old · 5m \+12\.5% · 5m vol \$4K\n[\s\S]*AVE · just now/);
      expect(tasks()[0].aveCost).toBe(0);
      await step();expect(lookups()[0].state).toBe('DONE');expect(edits()).toBe(2);
      expect(net.calls.filter(url => !url.includes(WBNB))).toEqual([`https://prod.ave-api.com/v2/tokens/${TOKEN}-arc`, GOPLUS_TOKEN_URL,
        `https://api.gopluslabs.io/api/v1/token_security/5042?contract_addresses=${TOKEN}`]);
      expect(net.authorizations).toEqual(['goplus-token']);
      expect(lastText()).toMatch(/\n✅ No failures found · checked just now\n/);
      const buttons = sent.at(-1).params.reply_markup.inline_keyboard.flat();
      expect(buttons.filter(button => button.url).map(button => [button.text, button.url])).toEqual([['🌐 Site', 'https://look.example/'], ['📊 Chart', `https://dexscreener.com/arc/${TOKEN}`], ['🔭 Profile', `https://ave.ai/token/${TOKEN}-arc`]]);
      expect(tasks()).toEqual([]);
      expect(runtime().lookups.read('arc', TOKEN).secondary).toMatchObject({ status: 'COMPLETE', sources: { goPlus: { status: 'OK' } }, security: { verdict: 'NO_FATAL_FLAGS' } });
    });
  });

  it.each([
    ['NOT_FOUND', '26803', () => json({ status: 1, data: { token: {}, pairs: [] } }), /AVE has no token at this address on Arc\./],
    ['FAILED', '26804', () => json({ status: 0, msg: 'unexpected' }), /Lookup failed: AVE returned an answer it could not be read from/],
    ['FAILED', '26805', () => new Response('unauthorized', { status: 401 }), /Lookup failed: AVE key unavailable; reconnect/]
  ])('ends %s (tenant %s) without any GoPlus request and offers the other EVM chains', async (state, tenantId, answer, copy) => {
    await withLookups(tenantId, async ({ net, connect, paste, step, tasks, lookups, lastText, link, click, session }) => {
      await connect();
      net.knobs.ave = answer;
      const detail = await paste(TOKEN);
      await step();
      expect(lookups()[0]).toMatchObject({ state, secondary: null, sources: {} });
      expect(tasks()).toEqual([]);
      expect(net.calls.filter(url => !url.startsWith('https://prod.ave-api.com/'))).toEqual([]);
      expect(lastText()).toMatch(copy);
      net.knobs.ave = null;
      await click(link(detail, 'lookup.start', (_params, row) => row.chain === 'bsc'));
      expect(session(detail.id).query.selectedToken).toEqual({ chain: 'bsc', address: TOKEN });
      await step();
      expect(net.ave().at(-1)).toBe(`https://prod.ave-api.com/v2/tokens/${TOKEN}-bsc`);
      expect(lookups().find(record => record.chain === 'bsc').state).toBe('GOPLUS');
    });
  });

  it('waits for AVE capacity on a rate limit or quota answer without failing, then continues', async () => {
    await withLookups('26807', async ({ runtime, storage, tenantId, net, connect, paste, step, tasks, lookups, lastText, clock }) => {
      await connect();
      net.knobs.ave = () => new Response('{"msg":"too many requests"}', { status: 429 });
      const detail = await paste(TOKEN);
      // Admission records the refusal before the step commits, as the agent's handler does.
      storage.transactionSync(() => { const state = readSchedulerStateInTransaction(storage, tenantId);
        writeSchedulerStateInTransaction(storage, tenantId, { ...state, ave: { ...state.ave, blockedUntil: clock.now() + 60_000, blockReason: 'RATE_LIMITED' } }); });
      await step();
      expect(lookups()[0]).toMatchObject({ state: 'DETAILS', reason: null });
      expect(tasks()).toEqual([expect.objectContaining({ enabled: true, aveCost: AVE_CU.details })]);
      expect(lastText()).toMatch(/⏳ Waiting for AVE capacity/);
      clock.advance(60_000);net.knobs.ave = null;
      await step();
      expect(lookups()[0].state).toBe('GOPLUS');
      expect(runtime().commands.sessions.get(detail.id).panel).toBe('detail');
    });
  });

  it('resumes after a restart from the step it reached, and a step replayed concurrently commits once', async () => {
    await withLookups('26808', async ({ runtime, restart, net, connect, paste, step, tasks, lookups, details, secondary }) => {
      await connect();await paste(TOKEN);
      await step();
      restart();
      const [task] = tasks();
      expect(task).toMatchObject({ aveCost: 0 });expect(lookups()[0].state).toBe('GOPLUS');
      const revision = lookups()[0].revision;
      await Promise.all([runtime().lookups.runStep(task.id, { request, details, secondary }), runtime().lookups.runStep(task.id, { request, details, secondary })]);
      expect(lookups()[0]).toMatchObject({ state: 'DONE', revision: revision + 1 });
      expect(net.ave()).toHaveLength(1);
      expect(tasks()).toEqual([]);
    });
  });

  it('reuses a lookup pasted again within 60 s, rebinding it to the new detail, and runs a fresh one after', async () => {
    await withLookups('26809', async ({ net, connect, paste, step, tasks, lookups, clock }) => {
      await connect();
      const first = await paste(TOKEN);
      for (let index = 0; index < 2; index++) await step();
      clock.advance(LOOKUP_SETTINGS.reuseMs - 1);
      const second = await paste(TOKEN);
      expect(lookups()).toEqual([expect.objectContaining({ state: 'DONE', startedAt: start, sessionId: second.id })]);
      expect(second.id).not.toBe(first.id);
      expect([tasks(), net.ave()]).toEqual([[], [`https://prod.ave-api.com/v2/tokens/${TOKEN}-arc`]]);
      clock.advance(1);
      await paste(TOKEN);
      expect(lookups()).toEqual([expect.objectContaining({ state: 'DETAILS', startedAt: start + LOOKUP_SETTINGS.reuseMs })]);
      expect(tasks().map(task => task.id)).toEqual([`lookup:arc:${TOKEN}:${start + LOOKUP_SETTINGS.reuseMs}`]);
    });
  });

  it(`runs one lookup at a time, oldest first, and refuses more than ${LOOKUP_SETTINGS.pending} waiting with a banner`, async () => {
    await withLookups('26810', async ({ connect, paste, step, tasks, lookups, lastText, session, clock }) => {
      await connect();
      const addresses = Array.from({ length: LOOKUP_SETTINGS.pending + 1 }, (_, index) => '0x' + String(index + 1).repeat(40));
      for (const address of addresses.slice(0, -1)) { await paste(address);clock.advance(1); }
      expect(tasks().map(task => task.id)).toEqual([`lookup:arc:${addresses[0]}:${start}`]);
      const refused = await paste(addresses.at(-1));
      expect(session(refused.id).panel).toBe('radar');
      expect(lastText()).toMatch(new RegExp(`^⚠️ ${LOOKUP_SETTINGS.pending} lookups are already waiting; try again when one finishes\\.`));
      expect(lookups()).toHaveLength(LOOKUP_SETTINGS.pending);
      for (let index = 0; index < 2; index++) await step();
      expect(tasks().map(task => task.id)).toEqual([`lookup:arc:${addresses[1]}:${start + 1}`]);
      await paste(addresses.at(-1));
      expect(lookups()).toHaveLength(LOOKUP_SETTINGS.pending + 1);
    });
  });

  it('opens a hot-list token at once and spends nothing, but looks up a token that is only watched', async () => {
    await withLookups('26819', async ({ storage, tenantId, connect, paste, tasks, lookups, lastText, clock }) => {
      await connect();
      const HOT = '0x' + 'ab'.repeat(20);
      storage.sql.exec('INSERT INTO scheduler_state (tenant_id,key,value_json) VALUES (?,?,?)', tenantId, 'feed.snapshot:arc',
        JSON.stringify({ rows: [{ address: HOT, symbol: 'HOT', marketCap: 90_000 }], status: 'READY', at: clock.now(), observedAt: clock.now(), receivedCount: 1, leadCount: 0 }));
      await paste(HOT);
      expect(lastText()).toMatch(/^<b>HOT · Arc<\/b>/);
      expect([lookups(), tasks()]).toEqual([[], []]);
      storage.sql.exec('INSERT INTO annotations (tenant_id,chain,address,favorite,note,updated_at) VALUES (?,?,?,?,?,?)', tenantId, 'arc', TOKEN, 1, '', clock.now());
      await paste(TOKEN);
      expect(lookups()).toEqual([expect.objectContaining({ address: TOKEN, state: 'DETAILS' })]);
    });
  });

  it('runs Retry at once, within the reuse window and after the token was watched', async () => {
    await withLookups('26820', async ({ net, connect, paste, step, tasks, lookups, link, click, session, clock }) => {
      await connect();
      net.knobs.ave = () => new Response('unauthorized', { status: 401 });
      const detail = await paste(TOKEN);
      await step();
      expect(lookups()[0]).toMatchObject({ state: 'FAILED', reason: 'AVE_AUTH' });
      await click(link(session(detail.id), 'favorite.set'));
      clock.advance(1_000);net.knobs.ave = null;
      await click(link(session(detail.id), 'lookup.start', params => params.retry === true));
      expect(lookups()[0]).toMatchObject({ state: 'DETAILS', startedAt: clock.now() });
      expect(tasks()).toHaveLength(1);
      await step();
      expect(lookups()[0].state).toBe('GOPLUS');
    });
  });

  it('runs an explicit lookup even of a candidate or hot-list token: a chain button and Retry never just open the detail', async () => {
    await withLookups('26823', async ({ storage, tenantId, net, connect, paste, step, tasks, lookups, link, click, session, clock }) => {
      await connect();
      net.knobs.ave = () => json({ status: 1, data: { token: {}, pairs: [] } });
      const detail = await paste(TOKEN);
      await step();
      storage.sql.exec('INSERT INTO candidates (tenant_id,chain,address,symbol,status,audited_at,review_revision,deep_json) VALUES (?,?,?,?,?,?,?,?)',
        tenantId, 'bsc', TOKEN, 'LEAD', 'LIVE_READY', clock.now(), 'revision', JSON.stringify({ chainPass: true, chartRisk: { version: CHART_RISK_VERSION }, checks: {}, failed: [], unknownFields: [] }));
      net.knobs.ave = null;
      await click(link(detail, 'lookup.start', (_params, row) => row.chain === 'bsc'));
      expect(lookups().find(record => record.chain === 'bsc')).toMatchObject({ state: 'DETAILS', startedAt: clock.now() });
      expect(tasks()).toHaveLength(1);
      await step();await step();

      const OTHER = '0x' + 'e3'.repeat(20);
      net.knobs.ave = () => new Response('unauthorized', { status: 401 });
      clock.advance(1_000);
      const failed = await paste(OTHER);
      await step();
      expect(lookups().find(record => record.address === OTHER).state).toBe('FAILED');
      storage.sql.exec('INSERT INTO scheduler_state (tenant_id,key,value_json) VALUES (?,?,?)', tenantId, 'feed.snapshot:arc', JSON.stringify({ rows: [{ address: OTHER, symbol: 'HOT' }] }));
      clock.advance(1_000);net.knobs.ave = null;
      await click(link(session(failed.id), 'lookup.start', params => params.retry === true));
      expect(lookups().find(record => record.address === OTHER)).toMatchObject({ state: 'DETAILS', startedAt: clock.now() });
      expect(tasks()).toHaveLength(1);
    });
  });

  it('opens a token known locally at once and spends nothing', async () => {
    await withLookups('26811', async ({ storage, tenantId, connect, paste, tasks, lookups, session, lastText, clock }) => {
      await connect();
      storage.sql.exec('INSERT INTO candidates (tenant_id,chain,address,symbol,status,audited_at,review_revision,deep_json) VALUES (?,?,?,?,?,?,?,?)', tenantId, 'arc', TOKEN, 'KNOWN', 'LIVE_READY', clock.now() - 1000, 'revision',
        JSON.stringify({ chainPass: true, chartRisk: { version: CHART_RISK_VERSION }, checks: {}, failed: [], unknownFields: [] }));
      const detail = await paste(TOKEN);
      expect(session(detail.id)).toMatchObject({ panel: 'detail', query: { selectedToken: { chain: 'arc', address: TOKEN } } });
      expect(lastText()).toMatch(/^<b>KNOWN · Arc<\/b>/);
      expect([lookups(), tasks()]).toEqual([[], []]);
    });
  });

  it('sends an unknown token to the AVE connection panel while AVE is not connected', async () => {
    await withLookups('26812', async ({ paste, session, lookups, tasks, lastText }) => {
      const shown = await paste(TOKEN);
      expect(session(shown.id).panel).toBe('onboard');
      expect(lastText()).toMatch(/^⚠️ Looking up a token needs AVE\. Connect it first\.\n\n<b>🔑 AVE key<\/b>/);
      expect([lookups(), tasks()]).toEqual([[], []]);
    });
  });

  it('ends a lookup FAILED when the scheduler gives up on a transient AVE error, and Retry starts a new run', async () => {
    await withLookups('26814', async ({ runtime, storage, tenantId, net, connect, paste, details, lookups, lastText, link, click, tasks, step, drain, clock }) => {
      await connect();
      net.knobs.ave = () => new Response('bad gateway', { status: 502 });
      const detail = await paste(TOKEN);
      const scheduler = new OneAlarmScheduler({ store: new SqliteSchedulerStore(storage, tenantId), now: clock.now, aveBudget: { monthlyCu: 1_000_000, resetDay: 1 },
        alarms: { setAlarm: async () => {}, deleteAlarm: async () => {} },
        handlers: { lookup: externalRequestHandler(({ task, request: scoped }) => runtime().lookups.runStep(task.id, { request: scoped, details })) },
        taskReconciler: tasks => runtime().reconcileInTransaction({ tasks }).filter(task => task.kind === 'lookup') });
      for (let attempt = 0; attempt < 20 && lookups()[0].state === 'DETAILS'; attempt++) { await scheduler.alarm();clock.advance(30_000); }
      expect(lookups()[0]).toMatchObject({ state: 'FAILED', reason: 'AVE_UPSTREAM' });
      expect(net.ave()).toHaveLength(5);
      await drain();
      expect(lastText()).toMatch(/Lookup failed: AVE is temporarily unavailable/);
      net.knobs.ave = null;
      await click(link(detail, 'lookup.start', params => params.retry === true));
      expect(lookups()[0]).toMatchObject({ state: 'DETAILS', startedAt: clock.now() });
      await step();
      expect(lookups()[0].state).toBe('GOPLUS');
      expect(tasks()).toHaveLength(1);
      expect(lastText()).toMatch(/Looking up on Arc/);
    });
  });

  it('gives buys the lookup\'s safety: unverified while running, verified when clean, vetoed when fatal even beside a candidate', async () => {
    await withLookups('26815', async ({ storage, tenantId, net, connect, paste, step, clock }) => {
      await connect();
      const CLEAN_TOKEN = '0x' + 'c1'.repeat(20), FATAL_TOKEN = '0x' + 'f1'.repeat(20);
      const state = address => safetyState(storage, tenantId, 'arc', address.toUpperCase().replace('0X', '0x'), clock.now());
      expect(state(CLEAN_TOKEN)).toBe('UNVERIFIED');
      await paste(CLEAN_TOKEN);
      await step();
      expect(state(CLEAN_TOKEN)).toBe('UNVERIFIED');
      await step();
      expect(state(CLEAN_TOKEN)).toBe('VERIFIED');
      // A clean check verifies a buy for 15 minutes from its GoPlus read; then a buy asks again.
      clock.advance(LOOKUP_SETTINGS.verifiedMs);
      expect(state(CLEAN_TOKEN)).toBe('VERIFIED');
      clock.advance(1);
      expect(state(CLEAN_TOKEN)).toBe('UNVERIFIED');
      net.knobs.goPlus = { ...CLEAN, is_honeypot: '1' };
      await paste(FATAL_TOKEN);
      for (let index = 0; index < 2; index++) await step();
      expect(state(FATAL_TOKEN)).toBe('VETOED');
      // A candidate is the token of record: its open check outranks a clean lookup, but a fatal lookup still vetoes.
      for (const address of [CLEAN_TOKEN, FATAL_TOKEN]) storage.sql.exec('INSERT INTO candidates (tenant_id,chain,address,symbol,status,audited_at,review_revision,deep_json) VALUES (?,?,?,?,?,?,?,?)',
        tenantId, 'arc', address, 'LEAD', 'LIVE_READY', clock.now(), 'revision', JSON.stringify({ chainPass: true, chartRisk: { version: CHART_RISK_VERSION }, checks: {}, failed: [], unknownFields: [] }));
      expect([state(CLEAN_TOKEN), state(FATAL_TOKEN)]).toEqual(['UNVERIFIED', 'VETOED']);
      // A veto is a safety fact: it outlives the lookup's expiry.
      clock.advance(LOOKUP_SETTINGS.expiryMs);
      expect(state(FATAL_TOKEN)).toBe('VETOED');
    });
  });

  it('keeps a recorded veto through a rerun until a complete clean GoPlus check replaces it', async () => {
    await withLookups('26817', async ({ storage, tenantId, net, connect, paste, step, lookups, lastText, clock }) => {
      await connect();
      const state = () => safetyState(storage, tenantId, 'arc', TOKEN, clock.now());
      const rerun = async ave => { clock.advance(LOOKUP_SETTINGS.reuseMs);net.knobs.ave = ave;await paste(TOKEN); };
      net.knobs.goPlus = { ...CLEAN, is_honeypot: '1' };
      await paste(TOKEN);
      for (let index = 0; index < 2; index++) await step();
      expect(state()).toBe('VETOED');
      // A rerun keeps the veto while it runs, and when it ends NOT_FOUND or FAILED.
      await rerun(null);
      expect([lookups()[0].state, state()]).toEqual(['DETAILS', 'VETOED']);
      expect(lastText()).toMatch(/⏳ Looking up on Arc…\n⛔ Vetoed: Honeypot/);
      for (let index = 0; index < 2; index++) await step();
      await rerun(() => json({ status: 1, data: { pairs: [] } }));await step();
      expect([lookups()[0].state, state()]).toEqual(['NOT_FOUND', 'VETOED']);
      await rerun(() => json({ status: 0, msg: 'unexpected' }));await step();
      expect([lookups()[0].state, state()]).toEqual(['FAILED', 'VETOED']);
      // A finished check without a complete GoPlus answer keeps it too.
      net.knobs.goPlus = { ...CLEAN, is_honeypot: undefined };
      await rerun(null);for (let index = 0; index < 2; index++) await step();
      expect([lookups()[0].state, lookups()[0].secondary.security.verdict, state()]).toEqual(['DONE', 'UNKNOWN', 'VETOED']);
      net.knobs.goPlus = CLEAN;
      await rerun(null);for (let index = 0; index < 2; index++) await step();
      expect([lookups()[0].veto, state()]).toEqual([null, 'VERIFIED']);
    });
  });

  it('prunes beyond the newest 20 and after 24 h, but never a vetoed lookup', async () => {
    await withLookups('26818', async ({ storage, tenantId, net, connect, paste, step, lookups, clock }) => {
      await connect();
      net.knobs.goPlus = { ...CLEAN, is_honeypot: '1' };
      const VETOED = '0x' + 'fe'.repeat(20);
      await paste(VETOED);for (let index = 0; index < 2; index++) await step();
      net.knobs.ave = () => json({ status: 1, data: { pairs: [] } });
      const addresses = Array.from({ length: LOOKUP_SETTINGS.kept + 1 }, (_, index) => '0x' + index.toString(16).padStart(40, 'a'));
      for (const address of addresses) { clock.advance(1);await paste(address);await step(); }
      expect(lookups().map(record => record.address)).toEqual([...addresses.slice(1).reverse(), VETOED]);
      clock.advance(LOOKUP_SETTINGS.expiryMs);
      await paste('0x' + 'b'.repeat(40));
      expect(lookups().map(record => record.address)).toEqual(['0x' + 'b'.repeat(40), VETOED]);
      expect(safetyState(storage, tenantId, 'arc', VETOED, clock.now())).toBe('VETOED');
    });
  });

  it(`keeps every veto uncapped, warns once more than ${LOOKUP_SETTINGS.vetoesWarned} are held, and reads none of them in a scheduler pass`, async () => {
    await withLookups('26824', async ({ runtime, storage, tenantId, net, connect, paste, step, tasks, lookups, clock }) => {
      await connect();
      net.knobs.goPlus = { ...CLEAN, is_honeypot: '1' };
      const veto = async address => { clock.advance(1);await paste(address);for (let index = 0; index < 2; index++) await step(); };
      await veto(TOKEN);
      // Copies of the recorded veto bring the tenant to one below the threshold.
      const [record] = lookups();
      for (let index = 1; index < LOOKUP_SETTINGS.vetoesWarned - 1; index++) {
        const address = '0x' + index.toString(16).padStart(40, '0');
        storage.sql.exec('INSERT INTO scheduler_state (tenant_id,key,value_json) VALUES (?,?,?)', tenantId, `lookup:arc:${address}`, JSON.stringify({ ...record, address }));
      }
      const logs = vi.spyOn(console, 'log');
      try {
        const warnings = () => logs.mock.calls.map(([line]) => String(line)).filter(line => line.includes('lookup_vetoes_high')).map(line => JSON.parse(line));
        await veto('0x' + 'f2'.repeat(20));
        expect(lookups().filter(item => item.veto)).toHaveLength(LOOKUP_SETTINGS.vetoesWarned);
        expect(warnings()).toEqual([]);
        await veto('0x' + 'f3'.repeat(20));
        expect(lookups().filter(item => item.veto)).toHaveLength(LOOKUP_SETTINGS.vetoesWarned + 1);
        expect(warnings()).toEqual([{ event: 'lookup_vetoes_high', held: LOOKUP_SETTINGS.vetoesWarned + 1 }]);
      } finally { logs.mockRestore(); }

      clock.advance(LOOKUP_SETTINGS.expiryMs);
      const RUNNING = '0x' + 'f4'.repeat(20);
      await paste(RUNNING);
      // Record the lookup rows every read of a scheduler pass returns.
      const exec = storage.sql.exec.bind(storage.sql), read = [];
      const spy = vi.spyOn(storage.sql, 'exec').mockImplementation((query, ...bindings) => {
        if (query.includes("substr(key,1,7)='lookup:'") && query.startsWith('SELECT key')) read.push(...exec(query, ...bindings).toArray().map(row => row.key));
        return exec(query, ...bindings);
      });
      try { expect(tasks()).toHaveLength(1); } finally { spy.mockRestore(); }
      expect(read.length).toBeGreaterThan(0);
      expect(new Set(read)).toEqual(new Set([`lookup:arc:${RUNNING}`]));
      for (const address of [TOKEN, '0x' + '1'.padStart(40, '0')]) expect(safetyState(storage, tenantId, 'arc', address, clock.now())).toBe('VETOED');
      expect(runtime().commands.snapshot(storage, tenantId, clock.now()).lookups.filter(item => item.verdict === 'VETOED')).toHaveLength(LOOKUP_SETTINGS.vetoesWarned + 1);
    });
  });

  it('resumes a lookup saved at the retired DexScreener step with its GoPlus step', async () => {
    await withLookups('26830', async ({ storage, tenantId, connect, paste, step, tasks, lookups, clock }) => {
      await connect();
      await paste(TOKEN);
      await step();
      // As the previous release saved it after AVE confirmed the token.
      const key = `lookup:arc:${TOKEN}`, saved = JSON.parse(storage.sql.exec('SELECT value_json FROM scheduler_state WHERE tenant_id=? AND key=?', tenantId, key).one().value_json);
      storage.sql.exec('UPDATE scheduler_state SET value_json=? WHERE tenant_id=? AND key=?', JSON.stringify({ ...saved, state: 'DEXSCREENER' }), tenantId, key);
      expect(lookups()).toEqual([expect.objectContaining({ address: TOKEN, state: 'GOPLUS' })]);
      expect(tasks()).toHaveLength(1);
      await step();
      expect(lookups()).toEqual([expect.objectContaining({ address: TOKEN, state: 'DONE' })]);
      expect(safetyState(storage, tenantId, 'arc', TOKEN, clock.now())).toBe('VERIFIED');
    });
  });

  it('skips an unreadable lookup row everywhere but safetyState, which refuses to guess about it', async () => {
    await withLookups('26821', async ({ runtime, storage, tenantId, connect, paste, step, tasks, lookups, lastText, clock }) => {
      await connect();
      const OLD = '0x' + 'a1'.repeat(20), BROKEN = '0x' + 'a2'.repeat(20);
      storage.sql.exec('INSERT INTO scheduler_state (tenant_id,key,value_json) VALUES (?,?,?),(?,?,?)', tenantId, `lookup:arc:${OLD}`, JSON.stringify({ version: 2, chain: 'arc', address: OLD }),
        tenantId, `lookup:arc:${BROKEN}`, 'not json');
      const logs = vi.spyOn(console, 'log');
      try {
        expect(lookups()).toEqual([]);
        await paste(TOKEN);
        for (let index = 0; index < 2; index++) await step();
        expect(lookups()).toEqual([expect.objectContaining({ address: TOKEN, state: 'DONE' })]);
        expect(runtime().commands.snapshot(storage, tenantId, clock.now()).lookups).toHaveLength(1);
        expect(tasks()).toEqual([]);
        const unreadable = logs.mock.calls.map(([line]) => String(line)).filter(line => line.includes('lookup_record_unreadable'));
        expect(unreadable.map(line => JSON.parse(line).key).sort()).toEqual([`lookup:arc:${OLD}`, `lookup:arc:${BROKEN}`]);
      } finally { logs.mockRestore(); }
      for (const address of [OLD, BROKEN]) expect(() => safetyState(storage, tenantId, 'arc', address, clock.now())).toThrow(expect.objectContaining({ code: 'LOOKUP_RECORD_CORRUPT' }));
      expect(safetyState(storage, tenantId, 'arc', TOKEN, clock.now())).toBe('VERIFIED');
      await paste(OLD);
      expect(lastText()).toMatch(/^⚠️ The earlier lookup of this token cannot be read, so it was left as it is and not rerun\./);
      expect(storage.sql.exec('SELECT value_json FROM scheduler_state WHERE tenant_id=? AND key=?', tenantId, `lookup:arc:${OLD}`).one().value_json).toContain('"version":2');
    });
  });

  it('blames the check, not AVE, when the scheduler gives up after AVE confirmed the token', async () => {
    await withLookups('26822', async ({ runtime, storage, tenantId, connect, paste, step, details, lookups, lastText, drain, clock }) => {
      await connect();
      await paste(TOKEN);
      await step();
      expect(lookups()[0].state).toBe('GOPLUS');
      const secondary = { fetchSource: async () => { throw new Error('a defect in the check'); } };
      const scheduler = new OneAlarmScheduler({ store: new SqliteSchedulerStore(storage, tenantId), now: clock.now, aveBudget: { monthlyCu: 1_000_000, resetDay: 1 },
        alarms: { setAlarm: async () => {}, deleteAlarm: async () => {} },
        handlers: { lookup: externalRequestHandler(({ task, request: scoped }) => runtime().lookups.runStep(task.id, { request: scoped, details, secondary })) },
        taskReconciler: tasks => runtime().reconcileInTransaction({ tasks }).filter(task => task.kind === 'lookup') });
      for (let attempt = 0; attempt < 20 && lookups()[0].state === 'GOPLUS'; attempt++) { await scheduler.alarm();clock.advance(30_000); }
      await drain();
      expect(lookups()[0]).toMatchObject({ state: 'FAILED', reason: 'SCHEDULER_STEP_FAILED' });
      expect(runtime().commands.snapshot(storage, tenantId, clock.now()).lookups[0].failedStep).toBe('GOPLUS');
      expect(lastText()).toMatch(/Lookup failed: the GoPlus check did not finish/);
      expect(lastText()).not.toMatch(/AVE could not be read/);
    });
  });

  it('never makes a looked-up token a lead: no candidate, audit, outcome, notification, statistic or export entry', async () => {
    await withLookups('26802', async ({ runtime, storage, connect, paste, step, lookups, count, clock }) => {
      await connect();await paste(TOKEN);
      for (let index = 0; index < 2; index++) await step();
      expect(lookups()[0].state).toBe('DONE');
      for (const table of ['candidates', 'audit_queue', 'outcomes', 'events', 'risk_exclusions']) expect(count(table), table).toBe(0);
      const notifications = storage.transactionSync(() => runtime().notifications.reconcileInTransaction({ issues: [] }).notifications);
      expect(notifications).toEqual([]);
      const snapshot = runtime().commands.snapshot(storage, runtime().tenantId, clock.now());
      expect(snapshot.lookups).toHaveLength(1);
      expect(snapshot.stats.arc.tracked).toBe(0);
      expect(JSON.stringify(createTelegramExport(snapshot)).toLowerCase()).not.toContain(TOKEN.slice(2));
    });
  });

  it('runs through the agent\'s scheduler: the AVE read waits for admission, spends its 5 CU once, and the checks follow', async () => {
    const tenantId = '26816', radar = env.RADAR.get(env.RADAR.idFromName(`lookup-agent:${tenantId}`)), net = network();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => net.fetch(url, init));
    try {
      await runInDurableObject(radar, async (instance, state) => {
        const now = Date.now(), receipt = (updateId, commandType, payload) => ({ tenantId, actorUserId: tenantId, updateId, commandType, payload, dueAt: now, messageDate: Math.floor(now / 1000), sourceMessageId: `9${updateId}`, locale: 'en' });
        const alarms = async (count, until = () => false) => { for (let index = 0; index < count && !until(); index++) await instance.alarm(); };
        await instance.receiveTelegramCredential(receipt('1', 'credential', { source: 'message' }), `/setkey ${apiKey}`);
        await alarms(20, () => false);
        expect((await instance.getStatus(tenantId)).control.configured).toBe(true);
        const held = await instance.getAveAdmissionState(tenantId);
        await instance.setAveAdmissionState({ tenantId, state: { ...held, spacingReadyAt: now + 3_600_000 } });
        await instance.receiveTelegramUpdate(receipt('2', 'lookup', { family: 'evm', address: TOKEN }));
        const record = () => listLookups(state.storage, tenantId)[0];
        await alarms(5);
        expect(record().state).toBe('DETAILS');
        expect(net.ave().filter(url => url.includes(TOKEN))).toEqual([]);
        expect((await instance.getAveAdmissionState(tenantId)).cuUsed).toBe(held.cuUsed);
        await instance.setAveAdmissionState({ tenantId, state: { ...(await instance.getAveAdmissionState(tenantId)), spacingReadyAt: 0 } });
        await alarms(10, () => record().state === 'DONE');
        expect(record().state).toBe('DONE');
        expect(net.calls.filter(url => url.includes(TOKEN))).toEqual([`https://prod.ave-api.com/v2/tokens/${TOKEN}-arc`,
          `https://api.gopluslabs.io/api/v1/token_security/5042?contract_addresses=${TOKEN}`]);
        // The agent's validator signs in with the env's GoPlus credentials.
        expect(net.calls).toContain(GOPLUS_TOKEN_URL);expect(net.authorizations).toEqual(['goplus-token']);
        expect(record().secondary.status).toBe('COMPLETE');
        const spent = await instance.getAveAdmissionState(tenantId);
        expect(spent.cuUsed).toBe(held.cuUsed + AVE_CU.details);
        expect(spent.spacingReadyAt).toBeGreaterThan(now);
        // The scan stays scheduled; keep its real alarm from firing after the test.
        await state.storage.deleteAlarm();
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
