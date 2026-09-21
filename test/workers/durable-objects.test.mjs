import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('M2 Durable Object bindings', () => {
  it('persists Radar admission state in its SQLite schema and isolates distinct object identities', async () => {
    const persistedTenantId = '16001';
    const isolatedTenantId = '16002';
    const persistedState = {
      nextAllowedAt: 1_000,
      backoffFactor: 2,
      lastRequestAt: 900,
      lastWeight: 5,
      successStreak: 3,
      spacingReadyAt: 950,
      keyEpoch: 7
    };

    const persistedRadar = env.RADAR.get(env.RADAR.idFromName(`radar:${persistedTenantId}`));
    await persistedRadar.setGmgnAdmissionState(persistedTenantId, persistedState);

    const sameRadarIdentity = env.RADAR.get(env.RADAR.idFromName(`radar:${persistedTenantId}`));
    expect(await sameRadarIdentity.getGmgnAdmissionState(persistedTenantId)).toEqual(persistedState);

    await runInDurableObject(persistedRadar, async (_instance, state) => {
      const version = state.storage.sql
        .exec('SELECT value_json FROM preferences WHERE tenant_id = ? AND key = ?', '__schema__', 'schema.version')
        .one();
      const admitted = state.storage.sql
        .exec('SELECT value_json FROM scheduler_state WHERE tenant_id = ? AND key = ?', persistedTenantId, 'gmgn.admission.v1')
        .one();

      expect(JSON.parse(version.value_json)).toEqual({ version: 1 });
      expect(JSON.parse(admitted.value_json)).toEqual(persistedState);
      expect(state.storage.sql.databaseSize).toBeGreaterThan(0);
    });

    const isolatedRadar = env.RADAR.get(env.RADAR.idFromName(`radar:${isolatedTenantId}`));
    expect(await isolatedRadar.getGmgnAdmissionState(isolatedTenantId)).toEqual({
      nextAllowedAt: 0,
      backoffFactor: 1,
      lastRequestAt: 0,
      lastWeight: 1,
      successStreak: 0,
      spacingReadyAt: 0,
      keyEpoch: 0
    });

    await runInDurableObject(isolatedRadar, async (_instance, state) => {
      const persistedTenantRows = state.storage.sql
        .exec('SELECT tenant_id FROM scheduler_state WHERE tenant_id = ?', persistedTenantId)
        .toArray();
      expect(persistedTenantRows).toEqual([]);
    });
  });

  it('uses the TenantRegistry binding transactionally without duplicating a tenant route', async () => {
    const registry = env.TENANT_REGISTRY.getByName('tenant-registry');

    expect(await registry.registerTenant('16003')).toEqual({ tenantId: '16003' });
    expect(await registry.registerTenant('16003')).toEqual({ tenantId: '16003' });
    expect(await registry.registerTenant('16004')).toEqual({ tenantId: '16004' });
    expect(await registry.scheduledWake()).toEqual({ registeredTenantCount: 2 });

    await runInDurableObject(registry, async (_instance, state) => {
      const schema = state.storage.sql
        .exec('SELECT singleton, version FROM tenant_registry_schema')
        .one();
      const tenants = state.storage.sql
        .exec('SELECT tenant_id FROM tenant_registry ORDER BY tenant_id')
        .toArray();

      expect(schema).toEqual({ singleton: 1, version: 1 });
      expect(tenants).toEqual([{ tenant_id: '16003' }, { tenant_id: '16004' }]);
      expect(state.storage.sql.databaseSize).toBeGreaterThan(0);
    });
  });
});
