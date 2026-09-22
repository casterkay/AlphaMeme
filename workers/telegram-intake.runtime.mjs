import { env } from 'cloudflare:workers';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/worker.mjs';

function receipt({ tenantId = '18100', updateId = '1', commandType = 'command:start' } = {}) {
  return {
    tenantId,
    actorUserId: tenantId,
    updateId,
    commandType,
    payload: commandType === 'callback' ? { callbackId: 'action', callbackQueryId: 'query' } : { source: 'message', arguments: '' },
    dueAt: Date.now() + 60_000,
    messageDate: 1_700_000_000,
    sourceMessageId: '10'
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
      expect(state.storage.sql.exec('SELECT tenant_id, owner_user_id, onboard_state FROM tenants').toArray())
        .toEqual([{ tenant_id: '18100', owner_user_id: '18100', onboard_state: 'none' }]);
      expect(state.storage.sql.exec('SELECT update_id, command_type, payload_json, payload_enc, status, next_at FROM inbox').toArray())
        .toEqual([{ update_id: '1', command_type: 'command:start', payload_json: '{"source":"message","arguments":""}', payload_enc: null, status: 'RECEIVED', next_at: first.dueAt }]);
      expect(state.storage.sql.exec('SELECT value_json FROM scheduler_state WHERE tenant_id = ? AND key = ?', '18100', 'scheduler.tasks.v1').one())
        .toMatchObject({ value_json: expect.stringContaining('inbox:1') });
      expect(await state.storage.getAlarm()).toBe(first.dueAt);
    });
  });

  it('rejects a durable owner mismatch without adding an inbox row', async () => {
    const tenantId = '18101';
    const radar = env.RADAR.get(env.RADAR.idFromName(`radar:${tenantId}`));
    await runInDurableObject(radar, async (_instance, state) => {
      state.storage.sql.exec(
        'INSERT INTO tenants (tenant_id, owner_user_id, gmgn_api_key_enc, onboard_state, created_at) VALUES (?, ?, ?, ?, ?)',
        tenantId,
        'other-owner',
        null,
        'none',
        Date.now()
      );
    });

    await expect(radar.receiveTelegramUpdate(receipt({ tenantId }))).resolves.toEqual({ accepted: false, reason: 'owner_mismatch' });
    await runInDurableObject(radar, async (_instance, state) => {
      expect(state.storage.sql.exec('SELECT update_id FROM inbox').toArray()).toEqual([]);
      expect(state.storage.sql.exec('SELECT tenant_id FROM scheduler_state').toArray()).toEqual([]);
    });
  });

  it('rearms a received inbox task with its bounded local handler instead of exhausting retries', async () => {
    const radar = env.RADAR.get(env.RADAR.idFromName('radar:18105'));
    const pending = receipt({ tenantId: '18105', updateId: '5' });
    await radar.receiveTelegramUpdate(pending);

    await runInDurableObject(radar, async (_instance, state) => {
      const row = state.storage.sql
        .exec('SELECT value_json FROM scheduler_state WHERE tenant_id = ? AND key = ?', '18105', 'scheduler.tasks.v1')
        .one();
      const tasks = JSON.parse(row.value_json);
      tasks.tasks[0].dueAt = Date.now() - 1;
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
      expect(state.storage.sql.exec('SELECT status FROM inbox WHERE update_id = ?', '5').one()).toEqual({ status: 'RECEIVED' });
      const task = JSON.parse(state.storage.sql
        .exec('SELECT value_json FROM scheduler_state WHERE tenant_id = ? AND key = ?', '18105', 'scheduler.tasks.v1')
        .one().value_json).tasks[0];
      expect(task).toMatchObject({ id: 'inbox:5', kind: 'command', enabled: true });
      expect(task.dueAt).toBeGreaterThan(Date.now());
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
              expect(secret).toBe('/setkey gmgn_secret_value');
              expect(JSON.stringify(receipt)).not.toContain('gmgn_secret_value');
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
    const credential = { ...valid, update_id: 4, message: { ...valid.message, text: '/setkey gmgn_secret_value' } };
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
            schemaVersion: 1,
            gmgnAdmission: { nextAllowedAt: 1, spacingReadyAt: 2, backoffFactor: 1, keyEpoch: 0, lastRequestAt: 99 }
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
      schemaVersion: 1,
      gmgnAdmission: { nextAllowedAt: 1, spacingReadyAt: 2, backoffFactor: 1, keyEpoch: 0 }
    });
  });
});
