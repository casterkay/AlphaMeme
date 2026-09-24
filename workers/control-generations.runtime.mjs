import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { prepareCredentialVerification } from '../src/auth/connection.mjs';
import { GmgnClient } from '../src/providers/gmgn.mjs';
import { RecoverableScanner } from '../src/recoverable-scanner.mjs';
import { seedGmgnCredential } from './fixtures/gmgn-credential.mjs';
import { SqliteControlStateStore } from '../src/storage/control-state.mjs';
import { restartRecoverableScanInTransaction, SqliteRecoverableScannerStore } from '../src/storage/recoverable-scanner.mjs';
import {
  SqliteGmgnAdmissionStateStore,
  writeGmgnAdmissionState
} from '../src/storage/gmgn-admission-state.mjs';

const settings = Object.freeze({
  scanIntervalMs: 120_000,
  maxDeepAuditsPerCycle: 1,
  auditCycleBudgetMs: 60_000,
  queueRetentionMs: 60_000,
  staleCandidateMs: 60_000
});

async function configuredRadar(tenantId) {
  const radar = env.RADAR.get(env.RADAR.idFromName(`radar:${tenantId}`));
  await radar.replaceSchedulerEligibility({ tenantId, eligibility: { paused: false, configured: true } });
  return radar;
}

describe('Radar control generations', () => {
  it('makes a late scan response stale after pause without waiting for the scan task', async () => {
    const tenantId = '19100';
    const cycleId = 'pause-generation';
    const radar = await configuredRadar(tenantId);
    await radar.beginRecoverableCycle({ tenantId, cycleId, chain: 'sol', keyEpoch: 0, controlEpoch: 0, deadlineAt: Date.now() + 60_000, settings });

    const paused = await radar.pause({ tenantId });
    expect(paused.paused).toBe(true);
    expect(paused.controlEpoch).toBe(1);
    await runInDurableObject(radar, async instance => {
      await expect(instance.recordRecoverableScanRequest({ tenantId, cycleId, response: { completed: [] }, collectedAt: Date.now() }))
        .rejects.toMatchObject({ code: 'CYCLE_CONTROL_EPOCH_STALE' });
    });
    expect((await radar.getRecoverableCycle({ tenantId, cycleId })).endpointIndex).toBe(0);
  });

  it('does not commit a delayed provider scan response after pause', async () => {
    const tenantId = '19113';
    const cycleId = 'delayed-provider-pause';
    const radar = await configuredRadar(tenantId);
    await seedGmgnCredential(radar, tenantId);
    const status = await radar.getStatus(tenantId);
    await radar.beginRecoverableCycle({
      tenantId, cycleId, chain: 'sol', keyEpoch: status.control.keyEpoch,
      controlEpoch: status.control.controlEpoch, deadlineAt: Date.now() + 60_000, settings
    });
    const snapshot = await radar.getSchedulerSnapshot(tenantId);
    await radar.replaceSchedulerTasks({ tenantId, tasks: snapshot.tasks.map(task =>
      task.id === `scan:${cycleId}` ? { ...task, dueAt: Date.now() - 1 } : task
    ) });
    let pauseResult;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    try {
      await runInDurableObject(radar, async instance => {
        fetchSpy.mockImplementation(async () => {
          pauseResult = await instance.pause({ tenantId });
          return new Response(JSON.stringify({ code: 0, data: { completed: [] } }), { status: 200 });
        });
        await instance.alarm();
      });
      expect(pauseResult).toMatchObject({ paused: true, controlEpoch: 1 });
      await runInDurableObject(radar, async (_instance, state) => {
        expect(state.storage.sql.exec('SELECT COUNT(*) AS count FROM candidates WHERE tenant_id = ?', tenantId).one().count).toBe(0);
        expect(state.storage.sql.exec('SELECT COUNT(*) AS count FROM events WHERE tenant_id = ?', tenantId).one().count).toBe(0);
        expect(state.storage.sql.exec('SELECT COUNT(*) AS count FROM outbox WHERE tenant_id = ?', tenantId).one().count).toBe(0);
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('revalidates a paused checkpoint in a dedicated resume transition', async () => {
    const tenantId = '19101';
    const cycleId = 'resume-generation';
    const radar = await configuredRadar(tenantId);
    await radar.beginRecoverableCycle({ tenantId, cycleId, chain: 'sol', keyEpoch: 0, controlEpoch: 0, deadlineAt: Date.now() + 60_000, settings });
    await radar.pause({ tenantId });

    const resumed = await radar.resume({ tenantId, cycleId });
    expect(resumed.paused).toBe(false);
    expect(resumed.controlEpoch).toBe(2);
    expect(resumed.checkpoint.controlEpoch).toBe(2);
    await radar.recordRecoverableScanRequest({ tenantId, cycleId, response: { completed: [] }, collectedAt: Date.now() });
    expect((await radar.getRecoverableCycle({ tenantId, cycleId })).endpointIndex).toBe(1);
    const checkpoint = await radar.getRecoverableCycle({ tenantId, cycleId });

    const repeated = await radar.resume({ tenantId, cycleId });
    expect(repeated.controlEpoch).toBe(2);
    expect(repeated.checkpoint).toEqual(checkpoint);
  });

  it('keeps scanning paused when an explicit resume cannot revalidate its checkpoint', async () => {
    const tenantId = '19108';
    const cycleId = 'expired-resume';
    const radar = await configuredRadar(tenantId);
    await radar.beginRecoverableCycle({ tenantId, cycleId, chain: 'sol', keyEpoch: 0, controlEpoch: 0, deadlineAt: Date.now() + 60_000, settings });
    await radar.pause({ tenantId });

    await runInDurableObject(radar, async (instance, state) => {
      state.storage.sql.exec('UPDATE cycle_checkpoint SET deadline_at = ? WHERE tenant_id = ? AND cycle_id = ?', Date.now() - 1, tenantId, cycleId);
      await expect(instance.resume({ tenantId, cycleId })).rejects.toMatchObject({ code: 'CYCLE_DEADLINE_EXPIRED' });
    });
    expect((await radar.getStatus(tenantId)).control).toMatchObject({ paused: true, controlEpoch: 1 });
  });

  it.each([['19106', undefined], ['19121', 'resume-all-one']])('revalidates every enabled scan on resume for tenant %s', async (tenantId, cycleId) => {
    const radar = await configuredRadar(tenantId);
    await radar.beginRecoverableCycle({ tenantId, cycleId: 'resume-all-one', chain: 'sol', keyEpoch: 0, controlEpoch: 0, deadlineAt: Date.now() + 60_000, settings });
    await radar.beginRecoverableCycle({ tenantId, cycleId: 'resume-all-two', chain: 'base', keyEpoch: 0, controlEpoch: 0, deadlineAt: Date.now() + 60_000, settings });
    await radar.pause({ tenantId });

    const resumed = await radar.resume({ tenantId, cycleId });
    if (cycleId) expect(resumed.checkpoint.cycleId).toBe(cycleId);
    else expect(resumed.checkpoint).toBeNull();
    expect(resumed.checkpoints).toHaveLength(2);
    expect(resumed.checkpoints.map(checkpoint => checkpoint.controlEpoch)).toEqual([2, 2]);
  });

  it('resumes only the authoritative scheduled checkpoint after a successor handoff', async () => {
    const tenantId = '19111';
    const radar = await configuredRadar(tenantId);
    await radar.beginRecoverableCycle({ tenantId, cycleId: 'completed-cycle', chain: 'sol', keyEpoch: 0, controlEpoch: 0, deadlineAt: Date.now() + 60_000, settings });
    await radar.beginRecoverableCycle({ tenantId, cycleId: 'current-cycle', chain: 'sol', keyEpoch: 0, controlEpoch: 0, deadlineAt: Date.now() + 60_000, settings });
    const snapshot = await radar.getSchedulerSnapshot(tenantId);
    await radar.replaceSchedulerTasks({ tenantId, tasks: snapshot.tasks.filter(task => task.id === 'scan:current-cycle') });
    await radar.pause({ tenantId });

    const resumed = await radar.resume({ tenantId });
    expect(resumed.checkpoints).toHaveLength(1);
    expect(resumed.checkpoints[0].cycleId).toBe('current-cycle');
  });

  it('does not revalidate an expired disabled checkpoint on generic resume', async () => {
    const tenantId = '19114';
    const radar = await configuredRadar(tenantId);
    await radar.beginRecoverableCycle({ tenantId, cycleId: 'active-sol', chain: 'sol', keyEpoch: 0, controlEpoch: 0, deadlineAt: Date.now() + 60_000, settings });
    await radar.beginRecoverableCycle({ tenantId, cycleId: 'disabled-base', chain: 'base', keyEpoch: 0, controlEpoch: 0, deadlineAt: Date.now() + 60_000, settings });
    const scheduled = await radar.getSchedulerSnapshot(tenantId);
    await radar.replaceSchedulerTasks({ tenantId, tasks: scheduled.tasks.map(task =>
      task.id === 'scan:disabled-base' ? { ...task, enabled: false } : task
    ) });
    await runInDurableObject(radar, async (_instance, state) => {
      state.storage.sql.exec('UPDATE cycle_checkpoint SET deadline_at = ? WHERE tenant_id = ? AND cycle_id = ?', Date.now() - 1, tenantId, 'disabled-base');
    });
    await radar.pause({ tenantId });

    const resumed = await radar.resume({ tenantId });
    expect(resumed.checkpoints).toHaveLength(1);
    expect(resumed.checkpoints[0].cycleId).toBe('active-sol');
  });

  it('disconnect invalidates every generation while retaining the durable provider cooldown', async () => {
    const tenantId = '19102';
    const cycleId = 'disconnect-generation';
    const radar = await configuredRadar(tenantId);
    await radar.setGmgnAdmissionState({ tenantId, state: {
      nextAllowedAt: Date.now() + 60_000,
      backoffFactor: 2,
      lastRequestAt: Date.now(),
      lastWeight: 1,
      successStreak: 0,
      spacingReadyAt: Date.now() + 30_000,
      keyEpoch: 0
    } });
    await radar.beginRecoverableCycle({ tenantId, cycleId, chain: 'sol', keyEpoch: 0, controlEpoch: 0, deadlineAt: Date.now() + 60_000, settings });
    const disconnected = await radar.disconnect({ tenantId });
    expect(disconnected).toMatchObject({ paused: true, configured: false, keyEpoch: 1, controlEpoch: 1, connectionGeneration: 1 });
    expect(await radar.getRecoverableCycle({ tenantId, cycleId })).toBeNull();
    const admission = await radar.getGmgnAdmissionState({ tenantId });
    expect(admission).toMatchObject({ keyEpoch: 1, backoffFactor: 2 });
    expect(admission.nextAllowedAt).toBeGreaterThan(Date.now());
    await runInDurableObject(radar, async (_instance, state) => {
      expect(state.storage.sql.exec('SELECT COUNT(*) AS count FROM keys WHERE tenant_id = ?', tenantId).one().count).toBe(0);
    });
  });

  it('disconnect cancels every scanner task and clears credential verification payloads', async () => {
    const tenantId = '19105';
    const radar = await configuredRadar(tenantId);
    await radar.replaceSchedulerTasks({ tenantId, tasks: [
      { id: 'scan:local-stage', kind: 'scan', dueAt: Date.now(), enabled: true, needsGmgn: false, gmgnWeight: 1 },
      { id: 'live:subscription', kind: 'live', dueAt: Date.now(), enabled: true, needsGmgn: false, gmgnWeight: 1 },
      { id: 'credential:1', kind: 'credential', dueAt: Date.now(), enabled: true, needsGmgn: false, gmgnWeight: 1 },
      { id: 'outbox:retain', kind: 'outbox', dueAt: Date.now(), enabled: true, needsGmgn: false, gmgnWeight: 1 }
    ] });
    await runInDurableObject(radar, async (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO inbox (tenant_id, update_id, actor_user_id, command_type, payload_json, payload_enc, status, generation, received_at, attempts, next_at, expires_at, message_date, source_message_id, result_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        tenantId, '1', tenantId, 'setkey', '{"candidate":"redacted"}', 'ciphertext', 'RECEIVED', 1, Date.now(), 0, Date.now(), null, null, null, null
      );
    });

    const disconnected = await radar.disconnect({ tenantId });
    expect(disconnected.live).toEqual({ subscribed: false, leaseUntil: 0 });
    expect((await radar.getSchedulerSnapshot(tenantId)).tasks).toEqual([
      { id: 'outbox:retain', kind: 'outbox', dueAt: expect.any(Number), enabled: true, needsGmgn: false, gmgnWeight: 1 }
    ]);
    await runInDurableObject(radar, async (_instance, state) => {
      expect(state.storage.sql.exec(
        'SELECT status, payload_json, payload_enc, next_at FROM inbox WHERE tenant_id = ? AND update_id = ?', tenantId, '1'
      ).one()).toEqual({ status: 'CANCELLED', payload_json: null, payload_enc: null, next_at: null });
    });
  });

  it('switching the view chain preserves every scheduled scan', async () => {
    const tenantId = '19103';
    const radar = await configuredRadar(tenantId);
    await radar.beginRecoverableCycle({ tenantId, cycleId: 'switch-sol', chain: 'sol', keyEpoch: 0, controlEpoch: 0, deadlineAt: Date.now() + 60_000, settings });
    await radar.beginRecoverableCycle({ tenantId, cycleId: 'switch-base', chain: 'base', keyEpoch: 0, controlEpoch: 0, deadlineAt: Date.now() + 60_000, settings });
    const switched = await radar.switchChain({ tenantId, chain: 'base' });
    expect(switched).toMatchObject({ activeChain: 'base', controlEpoch: 0 });
    expect((await radar.getSchedulerSnapshot(tenantId)).tasks.filter(task => task.kind === 'scan')).toEqual([
      { id: 'scan:switch-sol', kind: 'scan', dueAt: expect.any(Number), enabled: true, needsGmgn: true, gmgnWeight: 2 },
      { id: 'scan:switch-base', kind: 'scan', dueAt: expect.any(Number), enabled: true, needsGmgn: true, gmgnWeight: 2 }
    ]);
  });

  it('switching views leaves every checkpoint generation unchanged', async () => {
    const tenantId = '19109';
    const radar = await configuredRadar(tenantId);
    await radar.beginRecoverableCycle({ tenantId, cycleId: 'sol-cycle', chain: 'sol', keyEpoch: 0, controlEpoch: 0, deadlineAt: Date.now() + 60_000, settings });
    await radar.beginRecoverableCycle({ tenantId, cycleId: 'base-cycle', chain: 'base', keyEpoch: 0, controlEpoch: 0, deadlineAt: Date.now() + 60_000, settings });

    await radar.switchChain({ tenantId, chain: 'base' });
    expect(await radar.getRecoverableCycle({ tenantId, cycleId: 'sol-cycle' })).toMatchObject({ controlEpoch: 0 });
    expect(await radar.getRecoverableCycle({ tenantId, cycleId: 'base-cycle' })).toMatchObject({ controlEpoch: 0 });
    expect((await radar.getSchedulerSnapshot(tenantId)).tasks.filter(task => task.kind === 'scan')).toEqual([
      { id: 'scan:sol-cycle', kind: 'scan', dueAt: expect.any(Number), enabled: true, needsGmgn: true, gmgnWeight: 2 },
      { id: 'scan:base-cycle', kind: 'scan', dueAt: expect.any(Number), enabled: true, needsGmgn: true, gmgnWeight: 2 }
    ]);
    await radar.switchChain({ tenantId, chain: 'sol' });
    expect(await radar.getRecoverableCycle({ tenantId, cycleId: 'sol-cycle' })).toMatchObject({ controlEpoch: 0 });
  });

  it('changes the scan set without accepting an earlier chain response', async () => {
    const tenantId = '19115';
    const radar = await configuredRadar(tenantId);
    await radar.beginRecoverableCycle({ tenantId, cycleId: 'set-sol', chain: 'sol', keyEpoch: 0, controlEpoch: 0, deadlineAt: Date.now() + 60_000, settings });
    await radar.beginRecoverableCycle({ tenantId, cycleId: 'set-base', chain: 'base', keyEpoch: 0, controlEpoch: 0, deadlineAt: Date.now() + 60_000, settings });
    await radar.beginRecoverableCycle({ tenantId, cycleId: 'set-eth', chain: 'eth', keyEpoch: 0, controlEpoch: 0, deadlineAt: Date.now() + 60_000, settings });

    await runInDurableObject(radar, async (instance, state) => {
      const scanner = new RecoverableScanner({
        store: new SqliteRecoverableScannerStore(state.storage, tenantId),
        settings
      });
      const request = scanner.nextRequest('set-sol');
      const changed = await instance.setScanChains({ tenantId, chains: ['base', 'eth'] });
      expect(changed.controlEpoch).toBe(1);
      let failure = null;
      try {
        scanner.recordRequest('set-sol', {
          value: { completed: [] }, collectedAt: Date.now(), expectedCheckpoint: request.checkpoint
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: 'CYCLE_CONTROL_EPOCH_STALE' });
    });
    expect((await radar.getSchedulerSnapshot(tenantId)).tasks.filter(task => task.kind === 'scan')).toEqual([
      { id: 'scan:set-sol', kind: 'scan', dueAt: expect.any(Number), enabled: false, needsGmgn: true, gmgnWeight: 2 },
      { id: 'scan:set-base', kind: 'scan', dueAt: expect.any(Number), enabled: true, needsGmgn: true, gmgnWeight: 2 },
      { id: 'scan:set-eth', kind: 'scan', dueAt: expect.any(Number), enabled: true, needsGmgn: true, gmgnWeight: 2 }
    ]);
    expect(await radar.getRecoverableCycle({ tenantId, cycleId: 'set-sol' })).toMatchObject({ controlEpoch: 0 });
    expect(await radar.getRecoverableCycle({ tenantId, cycleId: 'set-base' })).toMatchObject({ controlEpoch: 1 });
    expect(await radar.getRecoverableCycle({ tenantId, cycleId: 'set-eth' })).toMatchObject({ controlEpoch: 1 });
  });

  it('keeps an in-flight response valid when the requested scan set is unchanged', async () => {
    const tenantId = '19116';
    const radar = await configuredRadar(tenantId);
    await radar.beginRecoverableCycle({ tenantId, cycleId: 'unchanged-sol', chain: 'sol', keyEpoch: 0, controlEpoch: 0, deadlineAt: Date.now() + 60_000, settings });
    await radar.beginRecoverableCycle({ tenantId, cycleId: 'unchanged-base', chain: 'base', keyEpoch: 0, controlEpoch: 0, deadlineAt: Date.now() + 60_000, settings });
    await runInDurableObject(radar, async (instance, state) => {
      const scanner = new RecoverableScanner({ store: new SqliteRecoverableScannerStore(state.storage, tenantId), settings });
      const request = scanner.nextRequest('unchanged-sol');
      const unchanged = await instance.setScanChains({ tenantId, chains: ['base', 'sol'] });
      expect(unchanged.controlEpoch).toBe(0);
      scanner.recordRequest('unchanged-sol', {
        value: { completed: [] }, collectedAt: Date.now(), expectedCheckpoint: request.checkpoint
      });
    });
    expect((await radar.getRecoverableCycle({ tenantId, cycleId: 'unchanged-sol' })).endpointIndex).toBe(1);
  });

  it.each([
    ['deadline', '19117', 'CYCLE_DEADLINE_EXPIRED'],
    ['evidence', '19118', 'CYCLE_EVIDENCE_STALE']
  ])('rejects re-enabling a checkpoint with expired %s without changing controls', async (expired, tenantId, code) => {
    const radar = await configuredRadar(tenantId);
    await radar.beginRecoverableCycle({ tenantId, cycleId: 'fresh-sol', chain: 'sol', keyEpoch: 0, controlEpoch: 0, deadlineAt: Date.now() + 60_000, settings });
    await radar.beginRecoverableCycle({ tenantId, cycleId: 'stale-base', chain: 'base', keyEpoch: 0, controlEpoch: 0, deadlineAt: Date.now() + 60_000, settings });
    await radar.setScanChains({ tenantId, chains: ['sol'] });
    await runInDurableObject(radar, async (instance, state) => {
      if (expired === 'deadline') {
        state.storage.sql.exec('UPDATE cycle_checkpoint SET deadline_at = ? WHERE tenant_id = ? AND cycle_id = ?', Date.now() - 1, tenantId, 'stale-base');
      } else {
        const checkpoint = await instance.getRecoverableCycle({ tenantId, cycleId: 'stale-base' });
        state.storage.sql.exec('UPDATE cycle_checkpoint SET partial_json = ? WHERE tenant_id = ? AND cycle_id = ?',
          JSON.stringify({ ...checkpoint.partial, discovery: { collectedAt: Date.now() - settings.staleCandidateMs - 1 } }), tenantId, 'stale-base');
      }
      const before = await instance.getSchedulerSnapshot(tenantId);
      await expect(instance.setScanChains({ tenantId, chains: ['base'] })).rejects.toMatchObject({ code });
      expect(await instance.getSchedulerSnapshot(tenantId)).toEqual(before);
    });
  });

  it('revalidates only scheduled checkpoints when changing the scan set', async () => {
    const tenantId = '19119';
    const radar = await configuredRadar(tenantId);
    for (const [cycleId, chain] of [['history-sol', 'sol'], ['current-sol', 'sol'], ['current-base', 'base']]) {
      await radar.beginRecoverableCycle({ tenantId, cycleId, chain, keyEpoch: 0, controlEpoch: 0, deadlineAt: Date.now() + 60_000, settings });
    }
    const snapshot = await radar.getSchedulerSnapshot(tenantId);
    await radar.replaceSchedulerTasks({ tenantId, tasks: snapshot.tasks.filter(task => task.id !== 'scan:history-sol')
      .map(task => task.id === 'scan:current-base' ? { ...task, enabled: false } : task) });
    await runInDurableObject(radar, async (_instance, state) => {
      state.storage.sql.exec('UPDATE cycle_checkpoint SET deadline_at = ? WHERE tenant_id = ? AND cycle_id = ?', Date.now() - 1, tenantId, 'history-sol');
    });
    const changed = await radar.setScanChains({ tenantId, chains: ['sol', 'base'] });
    expect(changed.controlEpoch).toBe(1);
    expect(await radar.getRecoverableCycle({ tenantId, cycleId: 'history-sol' })).toMatchObject({ controlEpoch: 0 });
    expect((await radar.getSchedulerSnapshot(tenantId)).tasks.every(task => task.enabled)).toBe(true);
  });

  it('rejects an unscheduled chain rather than reporting a scan set that cannot run', async () => {
    const tenantId = '19120';
    const radar = await configuredRadar(tenantId);
    await radar.beginRecoverableCycle({ tenantId, cycleId: 'scheduled-sol', chain: 'sol', keyEpoch: 0, controlEpoch: 0, deadlineAt: Date.now() + 60_000, settings });
    await runInDurableObject(radar, async instance => {
      await expect(instance.setScanChains({ tenantId, chains: ['base'] })).rejects.toMatchObject({ code: 'CONTROL_SCAN_CHAIN_UNSCHEDULED' });
    });
    expect((await radar.getStatus(tenantId)).control.controlEpoch).toBe(0);
  });

  it('treats switching to the active chain as a no-op', async () => {
    const tenantId = '19112';
    const radar = await configuredRadar(tenantId);
    await radar.beginRecoverableCycle({ tenantId, cycleId: 'active-sol', chain: 'sol', keyEpoch: 0, controlEpoch: 0, deadlineAt: Date.now() + 60_000, settings });

    const switched = await radar.switchChain({ tenantId, chain: 'sol' });
    expect(switched.controlEpoch).toBe(0);
    expect(await radar.getRecoverableCycle({ tenantId, cycleId: 'active-sol' })).toMatchObject({ controlEpoch: 0 });
    expect((await radar.getSchedulerSnapshot(tenantId)).tasks.find(task => task.id === 'scan:active-sol')).toMatchObject({ enabled: true });
  });

  it('credential replacement recreates every chain scan from persisted settings', async () => {
    const tenantId = '19110';
    const radar = await configuredRadar(tenantId);
    await radar.beginRecoverableCycle({ tenantId, cycleId: 'sol-history', chain: 'sol', keyEpoch: 0, controlEpoch: 0, deadlineAt: Date.now() + 60_000, settings, partial: { rootCycleId: 'sol-rotation' } });
    await radar.beginRecoverableCycle({ tenantId, cycleId: 'sol-rotation', chain: 'sol', keyEpoch: 0, controlEpoch: 0, deadlineAt: Date.now() + 60_000, settings, partial: { rootCycleId: 'sol-rotation' } });
    await radar.beginRecoverableCycle({ tenantId, cycleId: 'base-rotation', chain: 'base', keyEpoch: 0, controlEpoch: 0, deadlineAt: Date.now() + 60_000, settings });
    await radar.switchChain({ tenantId, chain: 'base' });
    const beforeRotation = await radar.getSchedulerSnapshot(tenantId);
    await radar.replaceSchedulerTasks({ tenantId, tasks: beforeRotation.tasks
      .filter(task => task.id === 'scan:sol-rotation' || task.id === 'scan:base-rotation')
      .map(task => task.id === 'scan:sol-rotation' ? { ...task, enabled: false } : task) });

    await runInDurableObject(radar, async (_instance, state) => {
      const restarted = restartRecoverableScanInTransaction(state.storage, tenantId, {
        keyEpoch: 1,
        controlEpoch: 1,
        now: Date.now()
      });
      expect(restarted).toHaveLength(2);
    });
    const snapshot = await radar.getSchedulerSnapshot(tenantId);
    expect(snapshot.tasks.filter(task => task.kind === 'scan').map(task => ({ id: task.id, enabled: task.enabled })).sort((left, right) => left.id.localeCompare(right.id))).toEqual([
      { id: 'scan:base-rotation:rotation:1', enabled: true }, { id: 'scan:sol-rotation:rotation:1', enabled: false }
    ]);
    expect(await radar.getRecoverableCycle({ tenantId, cycleId: 'sol-rotation' })).toBeNull();
    expect(await radar.getRecoverableCycle({ tenantId, cycleId: 'sol-history' })).toBeNull();
    expect(await radar.getRecoverableCycle({ tenantId, cycleId: 'base-rotation' })).toBeNull();
  });

  it('a late successful credential verification cannot reconnect after disconnect', async () => {
    const tenantId = '19122';
    const radar = await configuredRadar(tenantId);
    let fetchStarted;
    let releaseFetch;
    const started = new Promise(resolve => { fetchStarted = resolve; });
    const released = new Promise(resolve => { releaseFetch = resolve; });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      fetchStarted();
      await released;
      return new Response(JSON.stringify({ code: 0, data: { rank: [] } }), { status: 200 });
    });

    try {
      await runInDurableObject(radar, async (instance, state) => {
        await prepareCredentialVerification({
          storage: state.storage, masterKey: env.MASTER_ENC_KEY, tenantId, apiKey: `gmgn_${'a'.repeat(32)}`
        });
        const alarm = instance.alarm();
        await started;
        expect(state.storage.sql.exec('SELECT name FROM keys WHERE tenant_id = ?', tenantId).toArray())
          .toEqual([{ name: 'gmgn-pending-api-key' }]);
        const disconnected = await instance.disconnect({ tenantId });
        releaseFetch();
        await alarm;

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect((await instance.getStatus(tenantId)).control).toMatchObject({
          configured: false, paused: true,
          keyEpoch: disconnected.keyEpoch,
          controlEpoch: disconnected.controlEpoch,
          connectionGeneration: disconnected.connectionGeneration
        });
        expect(state.storage.sql.exec('SELECT COUNT(*) AS count FROM keys WHERE tenant_id = ?', tenantId).one().count).toBe(0);
        expect((await instance.getSchedulerSnapshot(tenantId)).tasks.filter(task => task.kind === 'credential')).toEqual([]);
      });
    } finally {
      releaseFetch();
      fetchSpy.mockRestore();
    }
  });

  it('disconnect prevents an encrypted candidate from being persisted after its crypto await', async () => {
    const tenantId = '19104';
    const radar = await configuredRadar(tenantId);
    const originalEncrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    let encryptionStarted;
    let releaseEncryption;
    const started = new Promise(resolve => { encryptionStarted = resolve; });
    const release = new Promise(resolve => { releaseEncryption = resolve; });
    const encryptSpy = vi.spyOn(crypto.subtle, 'encrypt').mockImplementation(async (...args) => {
      encryptionStarted();
      await release;
      return originalEncrypt(...args);
    });

    try {
      await runInDurableObject(radar, async (_instance, state) => {
        const preparing = prepareCredentialVerification({
          storage: state.storage,
          masterKey: 'workers-runtime-test-master-key',
          tenantId,
          apiKey: `gmgn_${'a'.repeat(32)}`
        });
        await started;
        new SqliteControlStateStore(state.storage, tenantId).disconnect();
        releaseEncryption();
        await expect(preparing).rejects.toMatchObject({ code: 'CONNECTION_GENERATION_STALE' });
        expect(state.storage.sql.exec('SELECT COUNT(*) AS count FROM keys WHERE tenant_id = ?', tenantId).one().count).toBe(0);
        const runtime = state.storage.sql
          .exec('SELECT value_json FROM scheduler_state WHERE tenant_id = ? AND key = ?', tenantId, 'scheduler.runtime.v1')
          .one().value_json;
        expect(runtime).not.toContain('gmgn_');
      });
    } finally {
      encryptSpy.mockRestore();
    }
  });

  it('does not let a late GMGN response rewind a newer credential epoch or cooldown', async () => {
    const tenantId = '19107';
    const radar = await configuredRadar(tenantId);
    let startFetch;
    let finishFetch;
    const started = new Promise(resolve => { startFetch = resolve; });
    const finished = new Promise(resolve => { finishFetch = resolve; });

    await runInDurableObject(radar, async (_instance, state) => {
      const admissionStore = new SqliteGmgnAdmissionStateStore(state.storage, tenantId);
      const client = new GmgnClient({
        apiKeyProvider: () => `gmgn_${'a'.repeat(32)}`,
        admissionStateStore: admissionStore,
        minRequestGapMs: 1,
        fetch: async () => {
          startFetch();
          await finished;
          return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 });
        }
      });
      const request = client.tokenInfo('bsc', `0x${'1'.repeat(40)}`);
      await started;
      const cooldownUntil = Date.now() + 60_000;
      writeGmgnAdmissionState(state.storage, tenantId, {
        ...await admissionStore.read(),
        keyEpoch: 1,
        nextAllowedAt: cooldownUntil,
        spacingReadyAt: cooldownUntil,
        backoffFactor: 2
      });
      finishFetch();
      await request;

      expect(await admissionStore.read()).toMatchObject({
        keyEpoch: 1,
        nextAllowedAt: cooldownUntil,
        spacingReadyAt: cooldownUntil,
        backoffFactor: 2
      });
    });
  });
});
