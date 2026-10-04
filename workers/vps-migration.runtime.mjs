import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import worker from '../src/worker.mjs';
import { TelegramRuntime } from '../src/bot/runtime.mjs';
import { RADAR_TABLES } from '../src/storage/schema.mjs';
import { TENANT_REGISTRY_TABLES } from '../src/storage/tenant-registry-schema.mjs';

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

const exportRequest = (tenantId, token = OPERATOR) => new Request(`https://worker.test/export?tenant_id=${tenantId}`, token ? { headers: { authorization: `Bearer ${token}` } } : {});

// Every user table the object's database really holds, so completeness is checked against storage, not the export's own list.
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

describe('migration export', () => {
  it('requires the operator token and refuses when none is configured', async () => {
    expect((await worker.fetch(exportRequest('23010', null), webhookEnv)).status).toBe(401);
    expect((await worker.fetch(exportRequest('23010', 'wrong-token'), webhookEnv)).status).toBe(401);
    expect((await worker.fetch(exportRequest('23010', OPERATOR), { ...webhookEnv, OPERATOR_TOKEN: undefined })).status).toBe(401);
    expect((await worker.fetch(exportRequest('23010', ''), { ...webhookEnv, OPERATOR_TOKEN: '' })).status).toBe(401);
  });

  it('refuses a tenant the registry does not hold instead of creating its object', async () => {
    const response = await worker.fetch(exportRequest('23011'), disabledEnv);
    expect(response.status).toBe(404);
  });

  it('returns every table, key-value entry and alarm of both objects while the runtime is disabled', async () => {
    const tenantId = '23012';
    const radar = env.RADAR.get(env.RADAR.idFromName(`radar:${tenantId}`));
    const registry = env.TENANT_REGISTRY.getByName('tenant-registry');
    await registry.registerTenant(tenantId);
    const alarmAt = Date.now() + 3_600_000;

    // A disabled object takes /start and runs it by hand, so its reply stays queued and its alarm stays where it was set.
    await runInDurableObject(radar, async (instance, { storage }) => {
      instance.env = { ...instance.env, RUNTIME_DISABLED: '1' };
      const receipt = { tenantId, actorUserId: tenantId, updateId: '1', commandType: 'command:start', payload: { source: 'message', arguments: '' }, dueAt: Date.now() + 60_000, messageDate: 1_700_000_000, sourceMessageId: '10', locale: 'en' };
      expect(await instance.receiveTelegramUpdate(receipt)).toMatchObject({ accepted: true });
      await new TelegramRuntime({ storage, env: instance.env, tenantId }).runCommand('1');
      await storage.setAlarm(alarmAt);
      await storage.put('radar.entry', 'kept');
    });
    await runInDurableObject(registry, (_instance, { storage }) => storage.put('scheduler.watchdog.cursor.v1', tenantId));

    const response = await worker.fetch(exportRequest(tenantId), disabledEnv);
    expect(response.status).toBe(200);
    const exported = await response.json();

    expect(exported.tenantId).toBe(tenantId);
    expect(Object.keys(exported.radar.tables).sort()).toEqual(RADAR_TABLES.map(table => table.name).sort());
    expect(Object.keys(exported.registry.tables).sort()).toEqual(TENANT_REGISTRY_TABLES.map(table => table.name).sort());
    await runInDurableObject(radar, async (_instance, { storage }) => {
      expect(Object.keys(exported.radar.tables).sort()).toEqual(storedTables(storage));
      for (const name of storedTables(storage)) expect(exported.radar.tables[name].rows).toEqual(storage.sql.exec(`SELECT * FROM "${name}"`).toArray());
    });
    await runInDurableObject(registry, async (_instance, { storage }) => {
      expect(Object.keys(exported.registry.tables).sort()).toEqual(storedTables(storage));
      expect(exported.registry.tables.tenant_registry.rows).toContainEqual(expect.objectContaining({ tenant_id: tenantId }));
    });
    expect(exported.radar.entries).toEqual({ 'radar.entry': 'kept' });
    expect(exported.radar.alarmAt).toBe(alarmAt);
    expect(exported.registry.entries).toEqual({ 'scheduler.watchdog.cursor.v1': tenantId });
    expect(exported.radar.tables.keys.sql).toMatch(/^CREATE TABLE keys/);

    // The /start reply is queued, not delivered, so the tenant is not idle.
    const pending = exported.radar.tables.outbox.rows.map(row => ({ id: row.id, status: row.status, deliveryClass: row.delivery_class }));
    expect(pending.length).toBeGreaterThan(0);
    expect(exported.idle).toEqual({ idle: false, unconfirmedOutbox: pending, unsettledTrades: [] });
  });
});
