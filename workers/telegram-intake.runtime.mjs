import { env } from 'cloudflare:workers';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import worker from '../src/worker.mjs';
import { TelegramRuntime } from '../src/bot/runtime.mjs';
import { readSchedulerStateInTransaction } from '../src/storage/scheduler-state.mjs';

function receipt({ tenantId = '18100', updateId = '1', commandType = 'command:start' } = {}) {
  return {
    tenantId,
    actorUserId: tenantId,
    updateId,
    commandType,
    payload: commandType === 'callback' ? { callbackId: 'action', callbackQueryId: 'query' } : { source: 'message', arguments: '' },
    dueAt: Date.now() + 60_000,
    messageDate: 1_700_000_000,
    sourceMessageId: '10',
    locale: 'zh'
  };
}

function webhookRequest(update, secret = 'test-webhook-secret') {
  return new Request('https://worker.test/webhook/telegram', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': secret
    },
    body: JSON.stringify(update)
  });
}

describe('Telegram first-contact intake', () => {
  it('persists one non-secret command receipt and scheduler task before acknowledging duplicates', async () => {
    const radar = env.RADAR.get(env.RADAR.idFromName('radar:18100'));
    const first = await radar.receiveTelegramUpdate(receipt());
    const duplicate = await radar.receiveTelegramUpdate(receipt());

    expect(first.accepted).toBe(true);
    expect(duplicate).toMatchObject({ accepted: true, duplicate: true });
    await runInDurableObject(radar, async (_instance, state) => {
      expect(state.storage.sql.exec('SELECT tenant_id, owner_user_id FROM tenants').toArray())
        .toEqual([{ tenant_id: '18100', owner_user_id: '18100' }]);
      expect(state.storage.sql.exec('SELECT update_id, command_type, payload_json, payload_enc, status, next_at FROM inbox').toArray())
        .toEqual([{ update_id: '1', command_type: 'command:start', payload_json: '{"source":"message","arguments":""}', payload_enc: null, status: 'RECEIVED', next_at: first.dueAt }]);
      expect(state.storage.sql.exec('SELECT value_json FROM scheduler_state WHERE tenant_id = ? AND key = ?', '18100', 'scheduler.tasks.v1').one())
        .toMatchObject({ value_json: expect.stringContaining('inbox:1') });
      expect(await state.storage.getAlarm()).toBe(first.dueAt);
    });
  });

  it('seeds the language of a new tenant from its first receipt and never changes it afterwards', async () => {
    const radar = env.RADAR.get(env.RADAR.idFromName('radar:23620'));
    await radar.receiveTelegramUpdate({ ...receipt({ tenantId: '23620', updateId: '1' }), locale: 'en' });
    await radar.receiveTelegramUpdate({ ...receipt({ tenantId: '23620', updateId: '2' }), locale: 'zh' });
    await runInDurableObject(radar, async (_instance, state) => {
      expect(state.storage.sql.exec('SELECT key, value_json FROM preferences WHERE tenant_id = ? AND key = ?', '23620', 'telegram.language').toArray())
        .toEqual([{ key: 'telegram.language', value_json: '"en"' }]);
    });
  });

  it('leaves the default language of a tenant created before seeding existed', async () => {
    const radar = env.RADAR.get(env.RADAR.idFromName('radar:23625'));
    await runInDurableObject(radar, async (_instance, state) => {
      state.storage.sql.exec('INSERT INTO tenants (tenant_id, owner_user_id, created_at) VALUES (?, ?, ?)', '23625', '23625', Date.now());
    });
    await radar.receiveTelegramUpdate({ ...receipt({ tenantId: '23625', updateId: '1' }), locale: 'en' });
    await runInDurableObject(radar, async (_instance, state) => {
      expect(state.storage.sql.exec('SELECT key FROM preferences WHERE tenant_id = ? AND key = ?', '23625', 'telegram.language').toArray()).toEqual([]);
    });
  });

  it('rejects a durable owner mismatch without adding an inbox row', async () => {
    const tenantId = '18101';
    const radar = env.RADAR.get(env.RADAR.idFromName(`radar:${tenantId}`));
    await runInDurableObject(radar, async (_instance, state) => {
      state.storage.sql.exec(
        'INSERT INTO tenants (tenant_id, owner_user_id, created_at) VALUES (?, ?, ?)',
        tenantId,
        'other-owner',
        Date.now()
      );
    });

    await expect(radar.receiveTelegramUpdate(receipt({ tenantId }))).resolves.toEqual({ accepted: false, reason: 'owner_mismatch' });
    await runInDurableObject(radar, async (_instance, state) => {
      expect(state.storage.sql.exec('SELECT update_id FROM inbox').toArray()).toEqual([]);
      expect(state.storage.sql.exec('SELECT tenant_id FROM scheduler_state').toArray()).toEqual([]);
    });
  });

  it('completes a due durable command and creates a response instead of rearming the M2 receipt stub', async () => {
    const radar = env.RADAR.get(env.RADAR.idFromName('radar:18105'));
    const pending = receipt({ tenantId: '18105', updateId: '5' });
    await radar.receiveTelegramUpdate(pending);

    await runInDurableObject(radar, async (_instance, state) => {
      const row = state.storage.sql
        .exec('SELECT value_json FROM scheduler_state WHERE tenant_id = ? AND key = ?', '18105', 'scheduler.tasks.v1')
        .one();
      const tasks = JSON.parse(row.value_json);
      tasks.tasks[0].dueAt = Date.now() - 1;
      state.storage.sql.exec('UPDATE inbox SET next_at = ? WHERE tenant_id = ? AND update_id = ?', Date.now() - 1, '18105', '5');
      state.storage.sql.exec(
        'UPDATE scheduler_state SET value_json = ? WHERE tenant_id = ? AND key = ?',
        JSON.stringify(tasks),
        '18105',
        'scheduler.tasks.v1'
      );
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    expect(await runDurableObjectAlarm(radar)).toBe(true);
    await runInDurableObject(radar, async (_instance, state) => {
      expect(state.storage.sql.exec('SELECT status FROM inbox WHERE update_id = ?', '5').one()).toEqual({ status: 'DONE' });
      const tasks = JSON.parse(state.storage.sql
        .exec('SELECT value_json FROM scheduler_state WHERE tenant_id = ? AND key = ?', '18105', 'scheduler.tasks.v1')
        .one().value_json).tasks;
      expect(tasks.some(task => task.id === 'inbox:5')).toBe(false);
      expect(state.storage.sql.exec('SELECT panel FROM ui_sessions WHERE tenant_id = ?', '18105').toArray()).toEqual([{ panel: 'radar' }]);
      expect(state.storage.sql.exec('SELECT delivery_class FROM outbox WHERE tenant_id = ?', '18105').toArray()).toEqual([{ delivery_class: 'USER_RESPONSE' }]);
      expect(JSON.parse(state.storage.sql
        .exec('SELECT value_json FROM scheduler_state WHERE tenant_id = ? AND key = ?', '18105', 'scheduler.runtime.v1')
        .one().value_json).retries).toEqual({});
    });
  });

  it('does not recreate scheduler work for a duplicate terminal inbox receipt', async () => {
    const radar = env.RADAR.get(env.RADAR.idFromName('radar:18106'));
    const durableReceipt = receipt({ tenantId: '18106', updateId: '6' });
    await radar.receiveTelegramUpdate(durableReceipt);
    await runInDurableObject(radar, async (_instance, state) => {
      state.storage.sql.exec('UPDATE inbox SET status = ? WHERE tenant_id = ? AND update_id = ?', 'DONE', '18106', '6');
    });

    await expect(radar.receiveTelegramUpdate(durableReceipt)).resolves.toMatchObject({ accepted: true, duplicate: true });
    await runInDurableObject(radar, async (_instance, state) => {
      const tasks = JSON.parse(state.storage.sql
        .exec('SELECT value_json FROM scheduler_state WHERE tenant_id = ? AND key = ?', '18106', 'scheduler.tasks.v1')
        .one().value_json).tasks;
      expect(tasks).toEqual([]);
    });
  });

  it('registers before tenant receipt and routes credentials separately without storing plaintext in ordinary receipts', async () => {
    const calls = [];
    const fakeEnv = {
      TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret',
      TENANT_REGISTRY: {
        getByName() {
          return { registerTenant: async tenantId => { calls.push(`register:${tenantId}`); } };
        }
      },
      RADAR: {
        idFromName(name) { calls.push(`id:${name}`); return name; },
        get() {
          return {
            receiveTelegramCredential: async (receipt, secret) => {
              expect(secret).toBe('/setkey ave-secret-value');
              expect(JSON.stringify(receipt)).not.toContain('ave-secret-value');
              calls.push(`credential:${receipt.tenantId}`);
              return { accepted: true };
            },
            receiveTelegramUpdate: async message => {
              calls.push(`receive:${message.tenantId}`);
              return { accepted: true };
            }
          };
        }
      }
    };
    const valid = {
      update_id: 3,
      message: { message_id: 8, date: 1_700_000_000, chat: { id: 18102, type: 'private' }, from: { id: 18102 }, text: '/start secret' }
    };
    const response = await worker.fetch(webhookRequest(valid), fakeEnv);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: true });
    expect(calls).toEqual(['register:18102', 'id:radar:18102', 'receive:18102']);

    calls.length = 0;
    const credential = { ...valid, update_id: 4, message: { ...valid.message, text: '/setkey ave-secret-value' } };
    expect((await worker.fetch(webhookRequest(credential), fakeEnv)).status).toBe(200);
    expect(calls).toEqual(['register:18102', 'id:radar:18102', 'credential:18102']);

    calls.length = 0;
    const group = { ...valid, update_id: 5, message: { ...valid.message, chat: { id: -18102, type: 'group' } } };
    expect((await worker.fetch(webhookRequest(group), fakeEnv)).status).toBe(200);
    expect(calls).toEqual([]);
  });

  it('fails closed before routing on an invalid secret and returns retryable failure after route or tenant errors', async () => {
    const fakeEnv = {
      TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret',
      TENANT_REGISTRY: { getByName: () => ({ registerTenant: async () => { throw new Error('registry unavailable'); } }) },
      RADAR: { idFromName: name => name, get: () => ({ receiveTelegramUpdate: async () => ({ accepted: true }) }) }
    };
    const update = {
      update_id: 6,
      message: { message_id: 8, date: 1_700_000_000, chat: { id: 18103, type: 'private' }, from: { id: 18103 }, text: '/start' }
    };
    expect((await worker.fetch(webhookRequest(update, 'wrong-secret'), fakeEnv)).status).toBe(403);
    expect((await worker.fetch(webhookRequest(update), fakeEnv)).status).toBe(500);

    const invocationFailureEnv = {
      ...fakeEnv,
      TENANT_REGISTRY: { getByName: () => ({ registerTenant: async () => undefined }) },
      RADAR: { idFromName: name => name, get: () => ({ receiveTelegramUpdate: async () => { throw new Error('tenant unavailable'); } }) }
    };
    expect((await worker.fetch(webhookRequest(update), invocationFailureEnv)).status).toBe(500);
  });

  it('keeps operator routes bearer-authenticated and returns an explicit status allowlist', async () => {
    const fakeEnv = {
      OPERATOR_TOKEN: 'test-operator-token',
      RADAR: {
        idFromName: name => name,
        get: () => ({
          getStatus: async () => ({
            tenantId: 'should-not-leak',
            lifecycle: 'SKELETON',
            schemaVersion: 2,
            aveAdmission: {
              keyEpoch: 0, periodStartAt: 3, cuUsed: 10, lastRequestAt: 99, spacingReadyAt: 2,
              blockedUntil: 4, blockReason: 'RATE_LIMITED', backoffFactor: 2, successStreak: 5
            },
            control: { activeChain: 'arc' }
          })
        })
      }
    };
    expect((await worker.fetch(new Request('https://worker.test/health'), fakeEnv)).status).toBe(401);
    const response = await worker.fetch(new Request('https://worker.test/status?tenant_id=18104', {
      headers: { authorization: 'Bearer test-operator-token' }
    }), fakeEnv);
    expect(await response.json()).toEqual({
      lifecycle: 'SKELETON',
      schemaVersion: 2,
      aveAdmission: { cuUsed: 10, periodStartAt: 3, spacingReadyAt: 2, blockedUntil: 4, blockReason: 'RATE_LIMITED', keyEpoch: 0 }
    });
  });
});

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const random = length => crypto.getRandomValues(new Uint8Array(length));
const hex = bytes => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
function base58(bytes) {
  let number = BigInt('0x' + hex(bytes)), text = '';
  while (number > 0n) { text = BASE58[Number(number % 58n)] + text; number /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; text = '1' + text; }
  return text;
}

// Every row of every table, and every key-value entry, as one string.
async function everythingStored(storage) {
  const tables = storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").toArray();
  const rows = tables.map(({ name }) => storage.sql.exec(`SELECT * FROM "${name}"`).toArray());
  return JSON.stringify([rows, [...(await storage.list())]]);
}

describe('Telegram text that is not a command', () => {
  const webhookEnv = { ...env, TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret' };
  const pem = () => `-----BEGIN PRIVATE KEY-----\nMIIE${base58(random(24))}\n-----END PRIVATE KEY-----`;

  // Run the webhook end to end, then the tenant's commands, and read what its outbox would send.
  async function deliver(tenantId, message, field = 'message') {
    const logged = [];
    const spies = ['log', 'info', 'warn', 'error', 'debug'].map(level => vi.spyOn(console, level).mockImplementation((...values) => { logged.push(values); }));
    // Every outbound request in this isolate, including any another tenant's alarm makes.
    const fetched = [];
    spies.push(vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      fetched.push({ url: request.url, headers: [...request.headers], body: await request.text() });
      return new Response('{}', { status: 500 });
    }));
    try {
      const update = { update_id: 1, [field]: { message_id: 77, date: Math.floor(Date.now() / 1000), chat: { id: Number(tenantId), type: 'private' }, from: { id: Number(tenantId), language_code: 'en' }, ...message } };
      expect(await (await worker.fetch(webhookRequest(update), webhookEnv)).json()).toEqual({ accepted: true });
      const radar = env.RADAR.get(env.RADAR.idFromName(`radar:${tenantId}`));
      return await runInDurableObject(radar, async (_instance, { storage }) => {
        // The tenant's real alarm may already have tried a delivery (this env has no bot token), so the
        // proof reads the queued rows, which hold exactly what would be sent, rather than transport calls.
        await storage.deleteAlarm();
        const storedAtIntake = await everythingStored(storage);
        const runtime = new TelegramRuntime({ storage, env: webhookEnv, tenantId });
        for (const { update_id: updateId } of storage.sql.exec("SELECT update_id FROM inbox WHERE status IN ('RECEIVED', 'RUNNING')").toArray()) await runtime.runCommand(updateId);
        const requests = storage.sql.exec('SELECT payload_json FROM outbox ORDER BY rowid').toArray()
          .map(row => JSON.parse(row.payload_json)).map(payload => ({ method: payload.method, params: payload.params }));
        const inbox = storage.sql.exec('SELECT command_type, payload_json, status FROM inbox').one();
        const verifications = readSchedulerStateInTransaction(storage, tenantId).tasks.filter(task => task.kind === 'credential');
        const keys = storage.sql.exec('SELECT name FROM keys').toArray().map(row => row.name);
        return { inbox, requests, verifications, keys, fetched: JSON.stringify(fetched), stored: storedAtIntake + await everythingStored(storage), logged: JSON.stringify(logged) };
      });
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  }

  it.each([
    ['plain text', '23611', () => '0x' + hex(random(32)), secret => ({ text: secret })],
    ['plain text', '23612', () => base58(random(64)), secret => ({ text: `here is my wallet ${secret} thanks` })],
    ['a prompt reply', '23613', () => hex(random(32)), secret => ({ text: secret, reply_to_message: { message_id: 5 } })],
    ['a command argument', '23614', () => base58(random(64)), secret => ({ text: `/note ${secret}` })],
    ['a /setkey PEM block', '23615', pem, secret => ({ text: `/setkey ${secret}` })],
    ['a /setkey EVM key', '23617', () => hex(random(32)), secret => ({ text: `/setkey ${secret}` })],
    ['a /setkey 0x EVM key', '23618', () => '0x' + hex(random(32)), secret => ({ text: `/setkey ${secret}` })],
    ['a /setkey Solana secret key', '23619', () => base58(random(64)), secret => ({ text: `/setkey ${secret}` })],
    ['an edit', '23622', () => '0x' + hex(random(32)), secret => ({ text: `/setkey ${secret}` }), 'edited_message'],
    ['a photo caption', '23623', () => base58(random(64)), secret => ({ caption: secret, photo: [{ file_id: 'photo' }] })],
    ['a command for another bot', '23624', () => hex(random(32)), secret => ({ text: `/start@other_bot ${secret}` })]
  ])('deletes a private key sent as %s and keeps it out of storage, logs, AVE and every request', async (_path, tenantId, secret, message, field = 'message') => {
    const value = secret();
    const { inbox, requests, verifications, keys, fetched, stored, logged } = await deliver(tenantId, message(value), field);
    expect(inbox).toEqual({ command_type: 'secret_warning', payload_json: '{}', status: 'DONE' });
    // No verification is scheduled and no key kept, so nothing can reach AVE.
    expect([verifications, keys]).toEqual([[], []]);
    expect(requests.map(request => request.method)).toEqual(expect.arrayContaining(['deleteMessage', 'sendMessage']));
    expect(requests.find(request => request.method === 'deleteMessage').params.message_id).toBe('77');
    expect(requests.find(request => request.method === 'sendMessage').params.text).toMatch(/^I tried to delete your message because it looked like it held a private key .* If it was only a transaction hash, nothing else is needed\./);
    for (const piece of value.split(/[^0-9A-Za-z]+/).filter(word => word.length >= 16)) {
      for (const [where, text] of [['storage', stored], ['logs', logged], ['requests', JSON.stringify(requests)], ['fetches', fetched]]) expect(text.includes(piece), where).toBe(false);
    }
  });

  it('accepts a key of the real AVE shape on /setkey, encrypted and scheduled for verification', async () => {
    const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    // Synthetic: 64 mixed-case alphanumerics like a real AVE key, never a real one.
    const key = [...random(64)].map(byte => ALPHANUMERIC[byte % ALPHANUMERIC.length]).join('');
    const { inbox, verifications, keys, stored, logged } = await deliver('23621', { text: `/setkey ${key}` });
    expect(inbox).toMatchObject({ command_type: 'credential', payload_json: '{"source":"message"}' });
    expect(verifications).toHaveLength(1);
    expect(keys).toEqual(['ave-pending-api-key']);
    for (const text of [stored, logged]) expect(text.includes(key)).toBe(false);
  });

  it('answers unrecognized text with the hint in the sender\'s language and stores none of it', async () => {
    const words = `what does ${base58(random(12))} mean`;
    const { inbox, requests, stored, logged } = await deliver('23616', { text: words });
    expect(inbox).toEqual({ command_type: 'text', payload_json: '{}', status: 'DONE' });
    expect(requests.map(request => [request.method, request.params.text])).toEqual([['sendMessage', 'I only act on commands and replies to my prompts. Open 📡 Radar or ❓ Help.']]);
    for (const text of [stored, logged, JSON.stringify(requests)]) expect(text.includes(words.split(' ')[2])).toBe(false);
    expect(stored).toContain('"telegram.language","value_json":"\\"en\\""');
  });
});
