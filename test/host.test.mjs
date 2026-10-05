import assert from 'node:assert/strict';
import test from 'node:test';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import '../src/host/cloudflare-hook.mjs';
import { backupDatabases, BACKUP_SETS_KEPT } from '../src/host/backup.mjs';
import { DATABASE_FILES } from '../src/host/storage.mjs';

const { startHost } = await import('../src/host/host.mjs');

const OWNER = 1000;
const STRANGER = 2000;
const BOT_TOKEN = 'host-test-bot-token';
const AVE_KEY = 'host-test-ave-key-0001';
const OPERATOR_TOKEN = 'host-test-operator-token';
const WBNB_DETAILS_URL = 'https://prod.ave-api.com/v2/tokens/0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c-bsc';
const LEAD = `0x${'1'.repeat(40)}`;
const VARS = Object.freeze({
  TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  OPERATOR_TOKEN,
  MASTER_ENC_KEY: 'host-test-master-key',
  AVE_MONTHLY_CU: '1000000',
  AVE_CU_RESET_DAY: '1'
});

const json = value => Response.json(value);

async function eventually(condition, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for ${label}`);
}

// Telegram and AVE as hand-written stubs over the global fetch for this whole
// file, so no request leaves the machine even while a host stops. getUpdates
// answers the queued updates from the requested offset, as Telegram does.
const localFetch = globalThis.fetch;
let stubs;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url.startsWith('http://127.0.0.1:')) return localFetch(input, init);
  const { telegram, ave } = stubs;
  const telegramMethod = url.startsWith(`https://api.telegram.org/bot${BOT_TOKEN}/`) ? url.slice(url.lastIndexOf('/') + 1) : null;
  if (telegramMethod === 'getUpdates') {
    const { offset = 0 } = JSON.parse(init.body);
    telegram.offsets.push(offset);
    const pending = telegram.updates.filter(update => update.update_id >= offset);
    if (!pending.length) await new Promise(resolve => setTimeout(resolve, 20));
    return json({ ok: true, result: pending });
  }
  if (telegramMethod) {
    telegram.calls.push({ method: telegramMethod, params: JSON.parse(init.body) });
    return json({ ok: true, result: telegramMethod === 'sendMessage' ? { message_id: telegram.nextMessageId++ } : true });
  }
  if (url.startsWith('https://prod.ave-api.com/')) {
    ave.requests.push({ url, apiKey: init.headers?.['X-API-KEY'] ?? null });
    if (url === WBNB_DETAILS_URL) return json({ status: 1, data: { token: { token: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', chain: 'bsc', current_price_usd: '600' }, pairs: [] } });
    if (url.startsWith('https://prod.ave-api.com/v2/tokens/trending?chain=arc')) return json({ status: 1, data: { tokens: ave.hotList } });
  }
  return new Response('not stubbed', { status: 404 });
};

function upstreams(t) {
  stubs = { telegram: { updates: [], calls: [], offsets: [], nextMessageId: 500 }, ave: { requests: [], hotList: [] } };
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  return stubs;
}

let updateId = 0;
function message(from, text, messageId = 100 + updateId) {
  return {
    update_id: ++updateId,
    message: { message_id: messageId, date: Math.floor(Date.now() / 1000), chat: { id: from, type: 'private' }, from: { id: from, language_code: 'en' }, text }
  };
}

async function boot(t, dataDir = mkdtempSync(join(tmpdir(), 'radar-host-'))) {
  const host = await startHost({ dataDir, vars: VARS, port: 0, telegramRetryPauseMs: 10 });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await host.stop();
    rmSync(dataDir, { recursive: true, force: true });
  };
  t.after(stop);
  const sql = (query, ...args) => host.storage.radar.sql.exec(query, ...args).toArray();
  const offset = () => JSON.parse(host.storage.host.sql.exec("SELECT value_json FROM kv WHERE scope = 'host' AND key = 'telegram.offset'").toArray()[0]?.value_json ?? 'null');
  return { host, dataDir, sql, offset, stop };
}

// The owner sends /setkey through Telegram; the host stores and verifies it.
async function connect(fixture, { telegram }) {
  const setkey = message(OWNER, `/setkey ${AVE_KEY}`);
  telegram.updates.push(setkey);
  await eventually(async () => (await fixture.host.radar.getStatus(String(OWNER))).control.configured, 'the AVE key to activate');
  return setkey;
}

test('/setkey through the host is stored only as ciphertext, deleted from the chat, verified and activated', async t => {
  const stubs = upstreams(t);
  const fixture = await boot(t);
  const setkey = await connect(fixture, stubs);

  assert.deepEqual(stubs.ave.requests.filter(request => request.url === WBNB_DETAILS_URL), [{ url: WBNB_DETAILS_URL, apiKey: AVE_KEY }]);
  assert.deepEqual(fixture.sql('SELECT tenant_id FROM tenants').map(row => row.tenant_id), [String(OWNER)]);
  for (const file of readdirSync(fixture.dataDir)) {
    assert.equal(readFileSync(join(fixture.dataDir, file)).includes(AVE_KEY), false, `${file} holds no plaintext key`);
  }
  await eventually(() => stubs.telegram.calls.some(call => call.method === 'deleteMessage' && Number(call.params.message_id) === setkey.message.message_id), 'the /setkey message to be deleted');
  assert.equal(fixture.offset(), setkey.update_id + 1);
});

test('updates are confirmed through the last done one: stored and declined advance the offset, a failure is fetched again', async t => {
  const stubs = upstreams(t);
  const fixture = await boot(t);
  await connect(fixture, stubs);
  const stored = message(OWNER, '/radar');
  const declined = message(STRANGER, '/radar');
  const failing = message(OWNER, '/leads');
  const after = message(OWNER, '/help');

  const receive = fixture.host.radar.receiveTelegramUpdate.bind(fixture.host.radar);
  let failures = 0;
  fixture.host.radar.receiveTelegramUpdate = async receipt => {
    if (receipt.updateId === String(failing.update_id) && failures++ === 0) throw new Error('storage unavailable');
    return receive(receipt);
  };
  const offsetsBefore = stubs.telegram.offsets.length;
  stubs.telegram.updates.push(stored, declined, failing, after);
  await eventually(() => fixture.offset() === after.update_id + 1, 'every update to be confirmed');

  assert.equal(failures, 2, 'the failed update was delivered again');
  const offsets = stubs.telegram.offsets.slice(offsetsBefore);
  assert.ok(offsets.includes(failing.update_id), 'polling resumed from the failed update');
  const inbox = fixture.sql('SELECT update_id FROM inbox ORDER BY CAST(update_id AS INTEGER)').map(row => Number(row.update_id));
  assert.ok([stored, failing, after].every(update => inbox.includes(update.update_id)));
  assert.ok(!inbox.includes(declined.update_id), 'another sender is declined, not stored');
  assert.deepEqual(fixture.host.storage.registry.sql.exec('SELECT tenant_id FROM tenant_registry').toArray().map(row => row.tenant_id), [String(OWNER)]);
});

test('a full scan cycle runs on the host alarm and commits an AVE trending lead', async t => {
  const stubs = upstreams(t);
  const fixture = await boot(t);
  await connect(fixture, stubs);
  const nowSec = Math.floor(Date.now() / 1000);
  stubs.ave.hotList = [{
    token: LEAD, chain: 'arc', symbol: 'TLEAD', name: 'Host test token', current_price_usd: '0.5',
    market_cap: '50000', main_pair_tvl: '12000', token_tx_volume_usd_5m: '800', updated_at: nowSec - 1, launch_at: nowSec - 600
  }];
  // The verification read spaced the next AVE request; release that spacing instead of waiting it out.
  const { radar } = fixture.host;
  await radar.setAveAdmissionState({ tenantId: String(OWNER), state: { ...(await radar.getAveAdmissionState(String(OWNER))), spacingReadyAt: 0 } });
  await radar.wake();

  await eventually(() => fixture.sql('SELECT address FROM candidates').length > 0, 'a committed lead');
  assert.deepEqual(fixture.sql('SELECT chain, address, status FROM candidates').map(row => [row.chain, row.address, row.status]), [['arc', LEAD, 'LIVE_READY']]);
  assert.ok(stubs.ave.requests.some(request => request.url.startsWith('https://prod.ave-api.com/v2/tokens/trending?chain=arc') && request.apiKey === AVE_KEY));
  await eventually(() => fixture.host.alarm.getAlarm() !== null, 'the next alarm to be persisted');
});

test('the operator routes answer on localhost with the operator token', async t => {
  upstreams(t);
  const fixture = await boot(t);
  const base = `http://127.0.0.1:${fixture.host.port}`;
  assert.equal((await globalThis.fetch(`${base}/health`)).status, 401);
  const health = await globalThis.fetch(`${base}/health`, { headers: { authorization: `Bearer ${OPERATOR_TOKEN}` } });
  assert.deepEqual(await health.json(), { ok: true, service: 'meme-radar', lifecycle: 'SKELETON' });
});

test('a verified backup restores into a fresh directory and the host boots from it', async t => {
  const stubs = upstreams(t);
  const fixture = await boot(t);
  await connect(fixture, stubs);
  const backups = join(fixture.dataDir, 'backups');
  mkdirSync(backups);
  for (let day = 1; day <= BACKUP_SETS_KEPT; day += 1) mkdirSync(join(backups, `2026-01-${String(day).padStart(2, '0')}T03-00-00Z`));
  mkdirSync(join(backups, '2026-01-20T03-00-00Z.partial'));

  // Taken while the host runs, as the nightly job does.
  const { set, databases } = backupDatabases({ dataDir: fixture.dataDir });
  const sets = readdirSync(backups).sort();
  assert.equal(sets.length, BACKUP_SETS_KEPT);
  assert.equal(sets.at(-1), set);
  assert.ok(!sets.includes('2026-01-01T03-00-00Z') && !sets.some(name => name.endsWith('.partial')));
  assert.ok(databases['radar.sqlite'].tenants === 1 && databases['registry.sqlite'].tenant_registry === 1 && databases['host.sqlite'].kv >= 1);
  const offset = fixture.offset();
  const restored = mkdtempSync(join(tmpdir(), 'radar-host-restored-'));
  for (const file of Object.values(DATABASE_FILES)) copyFileSync(join(backups, set, file), join(restored, file));
  await fixture.stop();

  const restarted = await boot(t, restored);
  assert.equal((await restarted.host.radar.getStatus(String(OWNER))).control.configured, true);
  assert.equal(restarted.offset(), offset, 'polling resumes after the last confirmed update');
  assert.equal(typeof restarted.host.alarm.getAlarm(), 'number', 'the pending alarm is re-armed');
  assert.equal(restarted.sql('SELECT COUNT(*) AS count FROM keys')[0].count, databases['radar.sqlite'].keys);
});
