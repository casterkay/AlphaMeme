import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import worker from '../src/worker.mjs';

const OPERATOR = 'test-operator-token';
const webhookEnv = { ...env, TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret', OPERATOR_TOKEN: OPERATOR };
const disabledEnv = { ...webhookEnv, RUNTIME_DISABLED: '1' };

function startUpdate(tenantId, updateId = 1) {
  return new Request('https://worker.test/webhook/telegram', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'test-webhook-secret' },
    body: JSON.stringify({ update_id: updateId, message: { message_id: 7, date: Math.floor(Date.now() / 1000), chat: { id: Number(tenantId), type: 'private' }, from: { id: Number(tenantId) }, text: '/start' } })
  });
}

// Every user table the object's database really holds.
function storedTables(storage) {
  return storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE '__cf_%' AND name != '__miniflare_do_name' ORDER BY name").toArray().map(row => row.name);
}

async function everythingStored(storage) {
  const rows = storedTables(storage).map(name => storage.sql.exec(`SELECT * FROM "${name}"`).toArray());
  return JSON.stringify([rows, [...(await storage.list())], await storage.getAlarm()]);
}

describe('RUNTIME_DISABLED', () => {
  it('refuses webhook updates with a retryable status before routing them', async () => {
    const touched = vi.fn();
    const fakeEnv = { ...disabledEnv, TENANT_REGISTRY: { getByName: touched }, RADAR: { idFromName: touched, get: touched } };
    const response = await worker.fetch(startUpdate('23000'), fakeEnv);
    expect(response.status).toBe(503);
    expect(touched).not.toHaveBeenCalled();
  });

  it('turns the radar alarm and wake into no-ops that change nothing stored', async () => {
    const tenantId = '23001';
    expect((await worker.fetch(startUpdate(tenantId), webhookEnv)).status).toBe(200);
    const radar = env.RADAR.get(env.RADAR.idFromName(`radar:${tenantId}`));
    const fetch = vi.spyOn(globalThis, 'fetch');
    try {
      await runInDurableObject(radar, async (instance, { storage }) => {
        instance.env = { ...instance.env, RUNTIME_DISABLED: '1' };
        await storage.setAlarm(Date.now() - 1);
        const before = await everythingStored(storage);
        await instance.alarm();
        expect(await instance.wake()).toEqual({ accepted: false, reason: 'runtime_disabled' });
        expect(await everythingStored(storage)).toBe(before);
      });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  it('turns the registry watchdog wake into a no-op', async () => {
    const registry = env.TENANT_REGISTRY.getByName('tenant-registry');
    await registry.registerTenant('23002');
    await runInDurableObject(registry, async (instance, { storage }) => {
      instance.env = { ...instance.env, RUNTIME_DISABLED: '1', RADAR: { idFromName: () => { throw new Error('woke a radar'); } } };
      const before = await everythingStored(storage);
      expect(await instance.scheduledWake()).toEqual({ disabled: true });
      expect(await everythingStored(storage)).toBe(before);
    });
  });
});
