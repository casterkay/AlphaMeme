import { env } from 'cloudflare:workers';
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('M2 Durable Object bindings', () => {
  it('binds every tenant-specific Radar RPC to the durable object tenant', async () => {
    const boundTenantId = '16000';
    const otherTenantId = '16001';
    const radar = env.RADAR.get(env.RADAR.idFromName(`radar:${boundTenantId}`));
    const admission = {
      nextAllowedAt: 0,
      backoffFactor: 1,
      lastRequestAt: 0,
      lastWeight: 1,
      successStreak: 0,
      spacingReadyAt: 0,
      keyEpoch: 0
    };

    await runInDurableObject(radar, async (instance, state) => {
      await instance.getStatus(boundTenantId);
      const crossTenantCalls = [
        () => instance.getStatus(otherTenantId),
        () => instance.getGmgnAdmissionState(otherTenantId),
        () => instance.setGmgnAdmissionState(otherTenantId, admission),
        () => instance.replaceSchedulerTasks({ tenantId: otherTenantId, tasks: [] }),
        () => instance.replaceSchedulerTaskSources({ tenantId: otherTenantId, sources: {} }),
        () => instance.replaceSchedulerEligibility({ tenantId: otherTenantId, eligibility: { paused: false, configured: false } }),
        () => instance.getSchedulerSnapshot(otherTenantId)
      ];

      for (const call of crossTenantCalls) {
        await expect(call()).rejects.toThrow('Radar Durable Object is already bound to a different tenant');
      }

      const tenantIds = state.storage.sql
        .exec('SELECT DISTINCT tenant_id FROM scheduler_state ORDER BY tenant_id')
        .toArray();
      expect(tenantIds).toEqual([{ tenant_id: boundTenantId }]);
    });
  });

  it('persists Radar admission state in its SQLite schema across eviction and isolates distinct object identities', async () => {
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

    await evictDurableObject(persistedRadar);
    expect(await persistedRadar.getGmgnAdmissionState(persistedTenantId)).toEqual(persistedState);

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
    expect(await registry.scheduledWake()).toEqual({
      registeredTenantCount: 2,
      selectedTenantCount: 2,
      nextCursor: null,
      wakeAcceptedCount: 0,
      wakeInactiveCount: 2,
      wakeFailedCount: 0
    });

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

  it('uses the registry watchdog page to restore a missing alarm without starting scheduler work', async () => {
    const tenantId = '16006';
    const registry = env.TENANT_REGISTRY.getByName('tenant-registry-watchdog');
    const radar = env.RADAR.get(env.RADAR.idFromName(`radar:${tenantId}`));
    const futureOutboxAt = Date.now() + 60_000;

    await registry.registerTenant(tenantId);
    await radar.replaceSchedulerTasks({
      tenantId,
      tasks: [{ id: 'outbox:watchdog', kind: 'outbox', dueAt: futureOutboxAt, enabled: true, needsGmgn: false }]
    });
    await runInDurableObject(radar, async (_instance, state) => {
      await state.storage.deleteAlarm();
      expect(await state.storage.getAlarm()).toBeNull();
    });

    expect(await registry.scheduledWake()).toEqual({
      registeredTenantCount: 1,
      selectedTenantCount: 1,
      nextCursor: null,
      wakeAcceptedCount: 1,
      wakeInactiveCount: 0,
      wakeFailedCount: 0
    });
    await runInDurableObject(radar, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBe(futureOutboxAt);
    });
    expect((await radar.getSchedulerSnapshot(tenantId)).runtime.inFlight).toBeNull();
  });

  it('bounds watchdog fan-out and resumes its durable registry cursor after eviction', async () => {
    const registry = env.TENANT_REGISTRY.getByName('tenant-registry-page');
    for (let suffix = 0; suffix <= 25; suffix += 1) {
      await registry.registerTenant(String(17000 + suffix));
    }

    expect(await registry.scheduledWake()).toEqual({
      registeredTenantCount: 26,
      selectedTenantCount: 25,
      nextCursor: '17024',
      wakeAcceptedCount: 0,
      wakeInactiveCount: 25,
      wakeFailedCount: 0
    });
    await evictDurableObject(registry);
    expect(await registry.scheduledWake()).toEqual({
      registeredTenantCount: 26,
      selectedTenantCount: 1,
      nextCursor: null,
      wakeAcceptedCount: 0,
      wakeInactiveCount: 1,
      wakeFailedCount: 0
    });
  });

  it('uses one durable alarm for persisted scheduler work and persists an unavailable step retry', async () => {
    const tenantId = '16005';
    const radar = env.RADAR.get(env.RADAR.idFromName(`radar:${tenantId}`));
    const futureOutboxAt = Date.now() + 60_000;

    await radar.replaceSchedulerTasks({
      tenantId,
      tasks: [{ id: 'outbox:future', kind: 'outbox', dueAt: futureOutboxAt, enabled: true, needsGmgn: false }]
    });

    await runInDurableObject(radar, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBe(futureOutboxAt);
      const rows = state.storage.sql
        .exec('SELECT tenant_id, key FROM scheduler_state WHERE tenant_id = ? ORDER BY key', tenantId)
        .toArray();
      expect(rows).toEqual([
        { tenant_id: tenantId, key: 'scheduler.instance.v1' },
        { tenant_id: tenantId, key: 'scheduler.runtime.v1' },
        { tenant_id: tenantId, key: 'scheduler.tasks.v1' }
      ]);
    });

    expect(await runDurableObjectAlarm(radar)).toBe(true);
    expect((await radar.getSchedulerSnapshot(tenantId)).tasks).toEqual([
      { id: 'outbox:future', kind: 'outbox', dueAt: futureOutboxAt, enabled: true, needsGmgn: false, gmgnWeight: 1 }
    ]);

    await runInDurableObject(radar, async (_instance, state) => {
      const commandDueAt = Date.now() - 1;
      state.storage.sql.exec(
        'INSERT INTO scheduler_state (tenant_id, key, value_json) VALUES (?, ?, ?) ON CONFLICT(tenant_id, key) DO UPDATE SET value_json = excluded.value_json',
        tenantId,
        'scheduler.tasks.v1',
        JSON.stringify({
          version: 1,
          tasks: [{ id: 'command:retry', kind: 'command', dueAt: commandDueAt, enabled: true, needsGmgn: false, gmgnWeight: 1 }]
        })
      );
      state.storage.sql.exec(
        'INSERT INTO scheduler_state (tenant_id, key, value_json) VALUES (?, ?, ?) ON CONFLICT(tenant_id, key) DO UPDATE SET value_json = excluded.value_json',
        tenantId,
        'scheduler.runtime.v1',
        JSON.stringify({
          version: 1,
          nextLeaseEpoch: 1,
          inFlight: null,
          eligibility: { paused: false, configured: false },
          fairness: { outbox: null },
          retries: {},
          checkpoints: {},
          lowPriorityWaitMs: {},
          lastScheduledAt: null,
          lastRearmErrorAt: 0
        })
      );
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    expect(await runDurableObjectAlarm(radar)).toBe(true);

    const scheduler = await radar.getSchedulerSnapshot(tenantId);
    expect(scheduler.runtime.inFlight).toBeNull();
    expect(scheduler.tasks).toHaveLength(1);
    expect(scheduler.tasks[0].dueAt).toBeGreaterThan(Date.now());
    expect(scheduler.runtime.retries['command:retry'].lastErrorCode).toBe('SCHEDULER_HANDLER_UNAVAILABLE');
  });
});
