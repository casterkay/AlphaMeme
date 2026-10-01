import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { prepareOnboardingVerification } from '../src/auth/connection.mjs';
import { AVE_CU } from '../src/providers/ave.mjs';
import { RecoverableScanner } from '../src/recoverable-scanner.mjs';
import { scannerSettings } from '../src/scanner-settings.mjs';
import { SqliteControlStateStore } from '../src/storage/control-state.mjs';
import { restartRecoverableScanInTransaction, SqliteRecoverableScannerStore } from '../src/storage/recoverable-scanner.mjs';
import { encryptSecret } from '../src/util/crypto.mjs';

const settings = Object.freeze({
  ...scannerSettings,
  scanIntervalMs: 120_000,
  auditCycleBudgetMs: 60_000,
  queueRetentionMs: 60_000,
  staleCandidateMs: 60_000
});
const apiKey = 'ave-control-generation-key';
const emptyTrending = () => ({ rows: [], capturedAt: Date.now() });
const trendingUrl = 'https://prod.ave-api.com/v2/tokens/trending?chain=arc&current_page=0&page_size=100';

function jsonResponse(value) {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

function arcTrendingBody() {
  const nowSec = Math.floor(Date.now() / 1000);
  return { status: 1, data: { tokens: [{
    token: `0x${'7'.repeat(40)}`, chain: 'arc', symbol: 'LATE', current_price_usd: '0.5', market_cap: '50000',
    main_pair_tvl: '12000', token_tx_volume_usd_5m: '800', updated_at: nowSec - 1, launch_at: nowSec - 600
  }] } };
}

async function configuredRadar(tenantId, chain = 'arc') {
  const radar = env.RADAR.get(env.RADAR.idFromName(`radar:${tenantId}`));
  await radar.replaceSchedulerEligibility({ tenantId, eligibility: { paused: false, configured: true } });
  await radar.selectScanChain({ tenantId, chain });
  return radar;
}

/** Begin a cycle on the selected scan chain at the current generations. */
async function beginCycle(radar, tenantId, cycleId, extra = {}) {
  const { control } = await radar.getStatus(tenantId);
  return radar.beginRecoverableCycle({
    tenantId, cycleId, chain: control.activeChain, keyEpoch: control.keyEpoch, controlEpoch: control.controlEpoch,
    deadlineAt: Date.now() + 60_000, settings, ...extra
  });
}

// Each tenant gets its own key so a test can tell its requests from other tenants' scans in this isolate.
const tenantKey = tenantId => `ave-key-${tenantId}`;

async function seedAveCredential(radar, tenantId) {
  await runInDurableObject(radar, async (_instance, state) => {
    const envelope = await encryptSecret(env.MASTER_ENC_KEY, tenantId, 'ave-api-key', tenantKey(tenantId));
    state.storage.sql.exec('INSERT INTO keys (tenant_id, name, value_enc, generation, created_at) VALUES (?, ?, ?, ?, ?)', tenantId, 'ave-api-key', envelope, 0, Date.now());
  });
}

async function makeScanDue(radar, tenantId, cycleId) {
  const snapshot = await radar.getSchedulerSnapshot(tenantId);
  await radar.replaceSchedulerTasks({ tenantId, tasks: snapshot.tasks.map(task =>
    task.id === `scan:${cycleId}` ? { ...task, dueAt: Date.now() - 1 } : task
  ) });
}

function scanTasks(snapshot) {
  return snapshot.tasks.filter(task => task.kind === 'scan');
}

describe('Radar control generations', () => {
  it('makes a late scan response stale after pause without waiting for the scan task', async () => {
    const tenantId = '19100';
    const cycleId = 'pause-generation';
    const radar = await configuredRadar(tenantId);
    const checkpoint = await beginCycle(radar, tenantId, cycleId);

    const paused = await radar.pause({ tenantId });
    expect(paused.paused).toBe(true);
    expect(paused.controlEpoch).toBe(checkpoint.controlEpoch + 1);
    await runInDurableObject(radar, async instance => {
      await expect(instance.recordRecoverableScanRequest({ tenantId, cycleId, response: emptyTrending(), collectedAt: Date.now() }))
        .rejects.toMatchObject({ code: 'CYCLE_CONTROL_EPOCH_STALE' });
    });
    expect(await radar.getRecoverableCycle({ tenantId, cycleId })).toMatchObject({ phase: 'DISCOVER', endpointIndex: 0 });
  });

  it('does not commit a delayed AVE trending response after pause', async () => {
    const tenantId = '19113';
    const cycleId = 'delayed-provider-pause';
    const radar = await configuredRadar(tenantId);
    await seedAveCredential(radar, tenantId);
    await beginCycle(radar, tenantId, cycleId);
    await makeScanDue(radar, tenantId, cycleId);
    let pauseResult;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    try {
      await runInDurableObject(radar, async instance => {
        fetchSpy.mockImplementation(async (url, init) => {
          if (init?.headers?.['X-API-KEY'] === tenantKey(tenantId)) pauseResult = await instance.pause({ tenantId });
          return jsonResponse(arcTrendingBody());
        });
        await instance.alarm();
      });
      expect(fetchSpy.mock.calls.filter(([, init]) => init?.headers?.['X-API-KEY'] === tenantKey(tenantId)).map(([url]) => String(url))).toEqual([trendingUrl]);
      expect(pauseResult).toMatchObject({ paused: true });
      const checkpoint = await radar.getRecoverableCycle({ tenantId, cycleId });
      expect(checkpoint.phase).toBe('DISCOVER');
      expect(checkpoint.partial.discovery).toBeUndefined();
      await runInDurableObject(radar, async (_instance, state) => {
        for (const table of ['candidates', 'events', 'outbox']) {
          expect(state.storage.sql.exec(`SELECT COUNT(*) AS count FROM ${table} WHERE tenant_id = ?`, tenantId).one().count).toBe(0);
        }
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('records a late AVE answer onto the current admission state instead of rewinding a newer cooldown', async () => {
    const tenantId = '19107';
    const cycleId = 'late-admission';
    const radar = await configuredRadar(tenantId);
    await seedAveCredential(radar, tenantId);
    await beginCycle(radar, tenantId, cycleId);
    await makeScanDue(radar, tenantId, cycleId);
    let fetchStarted;
    let releaseFetch;
    const started = new Promise(resolve => { fetchStarted = resolve; });
    const released = new Promise(resolve => { releaseFetch = resolve; });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (init?.headers?.['X-API-KEY'] === tenantKey(tenantId)) {
        fetchStarted();
        await released;
      }
      return jsonResponse({ status: 1, data: { tokens: [] } });
    });

    try {
      await runInDurableObject(radar, async instance => {
        const alarm = instance.alarm();
        await started;
        const reserved = await instance.getAveAdmissionState(tenantId);
        expect(reserved.cuUsed).toBe(AVE_CU.trending);
        const cooldownUntil = Date.now() + 60_000;
        await instance.setAveAdmissionState({ tenantId, state: {
          ...reserved, blockedUntil: cooldownUntil, blockReason: 'RATE_LIMITED', backoffFactor: 4, successStreak: 7
        } });
        releaseFetch();
        await alarm;

        expect(await instance.getAveAdmissionState(tenantId)).toMatchObject({
          cuUsed: AVE_CU.trending, blockedUntil: cooldownUntil, blockReason: 'RATE_LIMITED', backoffFactor: 4, successStreak: 8
        });
      });
      // The answer was committed; later local steps may already have advanced the cycle.
      const checkpoint = await radar.getRecoverableCycle({ tenantId, cycleId });
      expect(checkpoint.phase).not.toBe('DISCOVER');
      expect(checkpoint.controlEpoch).toBe((await radar.getStatus(tenantId)).control.controlEpoch);
    } finally {
      releaseFetch();
      fetchSpy.mockRestore();
    }
  });

  it('revalidates a paused checkpoint in a dedicated resume transition', async () => {
    const tenantId = '19101';
    const cycleId = 'resume-generation';
    const radar = await configuredRadar(tenantId);
    const begun = await beginCycle(radar, tenantId, cycleId);
    await radar.pause({ tenantId });

    const resumed = await radar.resume({ tenantId, cycleId });
    expect(resumed.paused).toBe(false);
    expect(resumed.controlEpoch).toBe(begun.controlEpoch + 2);
    expect(resumed.checkpoint.controlEpoch).toBe(resumed.controlEpoch);
    await radar.recordRecoverableScanRequest({ tenantId, cycleId, response: emptyTrending(), collectedAt: Date.now() });
    const checkpoint = await radar.getRecoverableCycle({ tenantId, cycleId });
    expect(checkpoint.phase).toBe('SCREEN');

    const repeated = await radar.resume({ tenantId, cycleId });
    expect(repeated.controlEpoch).toBe(resumed.controlEpoch);
    expect(repeated.checkpoint).toEqual(checkpoint);
  });

  it('keeps scanning paused when an explicit resume cannot revalidate its checkpoint', async () => {
    const tenantId = '19108';
    const cycleId = 'expired-resume';
    const radar = await configuredRadar(tenantId);
    await beginCycle(radar, tenantId, cycleId);
    const paused = await radar.pause({ tenantId });

    await runInDurableObject(radar, async (instance, state) => {
      state.storage.sql.exec('UPDATE cycle_checkpoint SET deadline_at = ? WHERE tenant_id = ? AND cycle_id = ?', Date.now() - 1, tenantId, cycleId);
      await expect(instance.resume({ tenantId, cycleId })).rejects.toMatchObject({ code: 'CYCLE_DEADLINE_EXPIRED' });
    });
    expect((await radar.getStatus(tenantId)).control).toMatchObject({ paused: true, controlEpoch: paused.controlEpoch });
  });

  it.each([['19106', undefined], ['19121', 'resume-all-one']])('revalidates every enabled scan on resume for tenant %s', async (tenantId, cycleId) => {
    const radar = await configuredRadar(tenantId);
    await beginCycle(radar, tenantId, 'resume-all-one');
    await beginCycle(radar, tenantId, 'resume-all-two');
    await radar.pause({ tenantId });

    const resumed = await radar.resume({ tenantId, cycleId });
    if (cycleId) expect(resumed.checkpoint.cycleId).toBe(cycleId);
    else expect(resumed.checkpoint).toBeNull();
    expect(resumed.checkpoints.map(checkpoint => [checkpoint.cycleId, checkpoint.controlEpoch])).toEqual([
      ['resume-all-one', resumed.controlEpoch], ['resume-all-two', resumed.controlEpoch]
    ]);
  });

  it('resumes only the authoritative scheduled checkpoint after a successor handoff', async () => {
    const tenantId = '19111';
    const radar = await configuredRadar(tenantId);
    await beginCycle(radar, tenantId, 'completed-cycle');
    await beginCycle(radar, tenantId, 'current-cycle');
    const snapshot = await radar.getSchedulerSnapshot(tenantId);
    await radar.replaceSchedulerTasks({ tenantId, tasks: snapshot.tasks.filter(task => task.id === 'scan:current-cycle') });
    await radar.pause({ tenantId });

    const resumed = await radar.resume({ tenantId });
    expect(resumed.checkpoints.map(checkpoint => checkpoint.cycleId)).toEqual(['current-cycle']);
  });

  it('does not revalidate an expired disabled checkpoint on generic resume', async () => {
    const tenantId = '19114';
    const radar = await configuredRadar(tenantId);
    await beginCycle(radar, tenantId, 'active-arc');
    await beginCycle(radar, tenantId, 'disabled-arc');
    const scheduled = await radar.getSchedulerSnapshot(tenantId);
    await radar.replaceSchedulerTasks({ tenantId, tasks: scheduled.tasks.map(task =>
      task.id === 'scan:disabled-arc' ? { ...task, enabled: false } : task
    ) });
    await runInDurableObject(radar, async (_instance, state) => {
      state.storage.sql.exec('UPDATE cycle_checkpoint SET deadline_at = ? WHERE tenant_id = ? AND cycle_id = ?', Date.now() - 1, tenantId, 'disabled-arc');
    });
    await radar.pause({ tenantId });

    const resumed = await radar.resume({ tenantId });
    expect(resumed.checkpoints.map(checkpoint => checkpoint.cycleId)).toEqual(['active-arc']);
  });

  it('disconnect invalidates every generation and drops the key cooldown while keeping spacing and spend', async () => {
    const tenantId = '19102';
    const cycleId = 'disconnect-generation';
    const radar = await configuredRadar(tenantId);
    const cooldownUntil = Date.now() + 60_000, begunSpacing = Date.now() + 30_000;
    await radar.setAveAdmissionState({ tenantId, state: {
      keyEpoch: 0, periodStartAt: 0, cuUsed: 40, lastRequestAt: Date.now(), spacingReadyAt: begunSpacing,
      blockedUntil: cooldownUntil, blockReason: 'RATE_LIMITED', backoffFactor: 2, successStreak: 0
    } });
    await seedAveCredential(radar, tenantId);
    const begun = await beginCycle(radar, tenantId, cycleId);
    const disconnected = await radar.disconnect({ tenantId });
    expect(disconnected).toMatchObject({
      paused: true, configured: false, keyEpoch: 1, controlEpoch: begun.controlEpoch + 1, connectionGeneration: 1
    });
    expect(await radar.getRecoverableCycle({ tenantId, cycleId })).toBeNull();
    expect(scanTasks(await radar.getSchedulerSnapshot(tenantId))).toEqual([]);
    expect(await radar.getAveAdmissionState({ tenantId })).toMatchObject({
      keyEpoch: 1, cuUsed: 40, spacingReadyAt: begunSpacing, blockedUntil: 0, blockReason: null, backoffFactor: 1
    });
    await runInDurableObject(radar, async (_instance, state) => {
      expect(state.storage.sql.exec('SELECT COUNT(*) AS count FROM keys WHERE tenant_id = ?', tenantId).one().count).toBe(0);
    });
  });

  it('disconnect cancels every scanner and credential task and clears credential verification payloads', async () => {
    const tenantId = '19105';
    const radar = await configuredRadar(tenantId);
    // Far-future due times keep the platform alarm from running these tasks mid-test.
    const dueAt = Date.now() + 3_600_000;
    await radar.replaceSchedulerTasks({ tenantId, tasks: [
      { id: 'scan:local-stage', kind: 'scan', dueAt, enabled: true, aveCost: 0 },
      { id: 'credential:1', kind: 'credential', dueAt, enabled: true, aveCost: AVE_CU.details },
      { id: 'outbox:retain', kind: 'outbox', dueAt, enabled: true, aveCost: 0 }
    ] });
    await runInDurableObject(radar, async (_instance, state) => {
      state.storage.sql.exec(
        'INSERT INTO inbox (tenant_id, update_id, actor_user_id, command_type, payload_json, payload_enc, status, generation, received_at, attempts, next_at, expires_at, message_date, source_message_id, result_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        tenantId, '1', tenantId, 'credential', '{"source":"message"}', 'ciphertext', 'RECEIVED', 1, Date.now(), 0, Date.now() + 3_600_000, Date.now() + 3_600_000, null, null, null
      );
    });

    await radar.disconnect({ tenantId });
    expect((await radar.getSchedulerSnapshot(tenantId)).tasks).toEqual([
      { id: 'outbox:retain', kind: 'outbox', dueAt, enabled: true, aveCost: 0 }
    ]);
    await runInDurableObject(radar, async (_instance, state) => {
      expect(state.storage.sql.exec(
        'SELECT status, payload_json, payload_enc, next_at FROM inbox WHERE tenant_id = ? AND update_id = ?', tenantId, '1'
      ).one()).toEqual({ status: 'CANCELLED', payload_json: null, payload_enc: null, next_at: null });
    });
  });

  it('selecting another scan chain drops the previous chain cycle and fences its in-flight response', async () => {
    const tenantId = '19115';
    const radar = await configuredRadar(tenantId);
    const begun = await beginCycle(radar, tenantId, 'set-arc');

    await runInDurableObject(radar, async (instance, state) => {
      const scanner = new RecoverableScanner({ store: new SqliteRecoverableScannerStore(state.storage, tenantId), settings });
      const request = scanner.nextRequest('set-arc');
      const changed = await instance.selectScanChain({ tenantId, chain: 'bsc' });
      expect(changed).toMatchObject({ activeChain: 'bsc', controlEpoch: begun.controlEpoch + 1 });
      expect(() => scanner.recordRequest('set-arc', {
        value: emptyTrending(), collectedAt: Date.now(), expectedCheckpoint: request.checkpoint
      })).toThrow(expect.objectContaining({ code: 'CYCLE_CHECKPOINT_MISSING' }));
    });
    expect(scanTasks(await radar.getSchedulerSnapshot(tenantId))).toEqual([]);
    expect(await radar.getRecoverableCycle({ tenantId, cycleId: 'set-arc' })).toBeNull();
  });

  it('rejects an unsupported scan chain without changing controls', async () => {
    const tenantId = '19120';
    const radar = await configuredRadar(tenantId);
    const before = (await radar.getStatus(tenantId)).control;
    await runInDurableObject(radar, async instance => {
      await expect(instance.selectScanChain({ tenantId, chain: 'stable' })).rejects.toMatchObject({ code: 'CONTROL_CHAIN_INVALID' });
    });
    expect((await radar.getStatus(tenantId)).control).toEqual(before);
  });

  it('treats selecting the active scan chain as a no-op that keeps in-flight work valid', async () => {
    const tenantId = '19112';
    const radar = await configuredRadar(tenantId);
    const begun = await beginCycle(radar, tenantId, 'active-arc');

    await runInDurableObject(radar, async (instance, state) => {
      const scanner = new RecoverableScanner({ store: new SqliteRecoverableScannerStore(state.storage, tenantId), settings });
      const request = scanner.nextRequest('active-arc');
      expect((await instance.selectScanChain({ tenantId, chain: 'arc' })).controlEpoch).toBe(begun.controlEpoch);
      scanner.recordRequest('active-arc', { value: emptyTrending(), collectedAt: Date.now(), expectedCheckpoint: request.checkpoint });
    });
    expect(await radar.getRecoverableCycle({ tenantId, cycleId: 'active-arc' })).toMatchObject({ phase: 'SCREEN', controlEpoch: begun.controlEpoch });
    expect(scanTasks(await radar.getSchedulerSnapshot(tenantId))).toEqual([expect.objectContaining({ id: 'scan:active-arc', enabled: true })]);
  });

  it('credential replacement restarts every scheduled scan from persisted settings under the new key epoch', async () => {
    const tenantId = '19110';
    const radar = await configuredRadar(tenantId);
    await beginCycle(radar, tenantId, 'arc-history', { partial: { rootCycleId: 'arc-rotation' } });
    await beginCycle(radar, tenantId, 'arc-rotation', { partial: { rootCycleId: 'arc-rotation', scanCount: 3 } });
    await beginCycle(radar, tenantId, 'arc-paused');
    const beforeRotation = await radar.getSchedulerSnapshot(tenantId);
    await radar.replaceSchedulerTasks({ tenantId, tasks: beforeRotation.tasks
      .filter(task => task.id !== 'scan:arc-history')
      .map(task => task.id === 'scan:arc-paused' ? { ...task, enabled: false } : task) });

    await runInDurableObject(radar, async (_instance, state) => {
      const restarted = restartRecoverableScanInTransaction(state.storage, tenantId, { keyEpoch: 1, controlEpoch: 5, now: Date.now() });
      expect(restarted.map(checkpoint => [checkpoint.cycleId, checkpoint.keyEpoch, checkpoint.controlEpoch, checkpoint.partial.scanCount])).toEqual(expect.arrayContaining([
        ['arc-rotation:rotation:1', 1, 5, 3], ['arc-paused:rotation:1', 1, 5, 0]
      ]));
      expect(restarted).toHaveLength(2);
    });
    const snapshot = await radar.getSchedulerSnapshot(tenantId);
    expect(scanTasks(snapshot).map(task => ({ id: task.id, enabled: task.enabled, aveCost: task.aveCost })).sort((left, right) => left.id.localeCompare(right.id))).toEqual([
      { id: 'scan:arc-paused:rotation:1', enabled: false, aveCost: AVE_CU.trending },
      { id: 'scan:arc-rotation:rotation:1', enabled: true, aveCost: AVE_CU.trending }
    ]);
    for (const cycleId of ['arc-history', 'arc-rotation', 'arc-paused']) {
      expect(await radar.getRecoverableCycle({ tenantId, cycleId })).toBeNull();
    }
  });

  it('a late successful /setkey verification cannot reconnect after disconnect', async () => {
    const tenantId = '19122';
    const radar = env.RADAR.get(env.RADAR.idFromName(`radar:${tenantId}`));
    let fetchStarted;
    let releaseFetch;
    const started = new Promise(resolve => { fetchStarted = resolve; });
    const released = new Promise(resolve => { releaseFetch = resolve; });
    const verificationReads = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (init?.headers?.['X-API-KEY'] !== apiKey) return jsonResponse({ status: 1, data: { tokens: [] } });
      verificationReads.push(String(url));
      fetchStarted();
      await released;
      return jsonResponse({ status: 1, data: { token: { token: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', chain: 'bsc', current_price_usd: '600' }, pairs: [] } });
    });

    try {
      await runInDurableObject(radar, async (instance, state) => {
        const now = Date.now();
        const accepted = await instance.receiveTelegramCredential({
          tenantId, actorUserId: tenantId, updateId: '1', commandType: 'credential', payload: { source: 'message' },
          dueAt: now, messageDate: Math.floor(now / 1000), sourceMessageId: '10', locale: 'zh'
        }, `/setkey ${apiKey}`);
        expect(accepted.accepted).toBe(true);

        // Run scheduler steps until the credential task's AVE read is in flight.
        let alarm = null;
        for (let step = 0; step < 10 && !alarm; step++) {
          const running = instance.alarm();
          if (await Promise.race([started.then(() => true), running.then(() => false)])) alarm = running;
        }
        expect(alarm).not.toBeNull();
        expect(state.storage.sql.exec('SELECT name FROM keys WHERE tenant_id = ?', tenantId).toArray())
          .toEqual([{ name: 'ave-pending-api-key' }]);
        const disconnected = await instance.disconnect({ tenantId });
        releaseFetch();
        await alarm;

        expect(verificationReads).toEqual(['https://prod.ave-api.com/v2/tokens/0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c-bsc']);
        expect((await instance.getStatus(tenantId)).control).toMatchObject({
          configured: false, paused: true,
          keyEpoch: disconnected.keyEpoch,
          controlEpoch: disconnected.controlEpoch,
          connectionGeneration: disconnected.connectionGeneration
        });
        expect(state.storage.sql.exec('SELECT COUNT(*) AS count FROM keys WHERE tenant_id = ?', tenantId).one().count).toBe(0);
        expect(state.storage.sql.exec('SELECT COUNT(*) AS count FROM cycle_checkpoint WHERE tenant_id = ?', tenantId).one().count).toBe(0);
        expect((await instance.getSchedulerSnapshot(tenantId)).tasks.filter(task => ['credential', 'scan'].includes(task.kind))).toEqual([]);
        expect(state.storage.sql.exec('SELECT status FROM inbox WHERE tenant_id = ? AND update_id = ?', tenantId, '1').one().status).toBe('CANCELLED');
      });
    } finally {
      releaseFetch();
      fetchSpy.mockRestore();
    }
  });

  it.each([
    ['disconnect', '19104', 'CONNECTION_COMMAND_TERMINAL'],
    ['a newer submission', '19123', 'CONNECTION_GENERATION_STALE']
  ])('%s prevents an encrypted candidate from being persisted after its crypto await', async (mutation, tenantId, code) => {
    const radar = env.RADAR.get(env.RADAR.idFromName(`radar:${tenantId}`));
    await radar.replaceSchedulerEligibility({ tenantId, eligibility: { paused: false, configured: false } });
    const originalEncrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    let encryptionStarted;
    let releaseEncryption;
    const started = new Promise(resolve => { encryptionStarted = resolve; });
    const release = new Promise(resolve => { releaseEncryption = resolve; });
    let blocked = false;
    const encryptSpy = vi.spyOn(crypto.subtle, 'encrypt').mockImplementation(async (...args) => {
      if (!blocked) {
        blocked = true;
        encryptionStarted();
        await release;
      }
      return originalEncrypt(...args);
    });

    try {
      await runInDurableObject(radar, async (_instance, state) => {
        const now = Date.now();
        const options = { storage: state.storage, masterKey: env.MASTER_ENC_KEY, tenantId, aveCost: AVE_CU.details };
        for (const updateId of ['1', '2']) {
          state.storage.sql.exec("INSERT INTO inbox (tenant_id, update_id, actor_user_id, command_type, payload_enc, status, received_at, expires_at) VALUES (?, ?, ?, 'credential', 'sealed', 'RECEIVED', ?, ?)", tenantId, updateId, tenantId, now, now + 900_000);
        }
        const preparing = prepareOnboardingVerification({ ...options, updateId: '1', apiKey });
        await started;
        if (mutation === 'disconnect') new SqliteControlStateStore(state.storage, tenantId).disconnect();
        else await prepareOnboardingVerification({ ...options, updateId: '2', apiKey: 'ave-newer-submission-key' });
        const afterMutation = state.storage.sql.exec('SELECT name, generation FROM keys WHERE tenant_id = ?', tenantId).toArray();
        releaseEncryption();
        await expect(preparing).rejects.toMatchObject({ code });
        expect(state.storage.sql.exec('SELECT name, generation FROM keys WHERE tenant_id = ?', tenantId).toArray()).toEqual(afterMutation);
        expect(afterMutation).toEqual(mutation === 'disconnect' ? [] : [{ name: 'ave-pending-api-key', generation: 1 }]);
        const tasks = state.storage.sql
          .exec('SELECT value_json FROM scheduler_state WHERE tenant_id = ? AND key = ?', tenantId, 'scheduler.tasks.v1')
          .one().value_json;
        expect(tasks).not.toContain(apiKey);
      });
    } finally {
      releaseEncryption();
      encryptSpy.mockRestore();
    }
  });
});
