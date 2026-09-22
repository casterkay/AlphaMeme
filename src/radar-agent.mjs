import { DurableObject } from 'cloudflare:workers';
import {
  normalizeTenantId,
  readGmgnAdmissionState,
  SqliteGmgnAdmissionStateStore,
  writeGmgnAdmissionState,
  writeGmgnAdmissionStateInTransaction
} from './storage/gmgn-admission-state.mjs';
import { initializeRadarSchema } from './storage/schema.mjs';
import { GmgnClient } from './providers/gmgn.mjs';
import { RecoverableScanner } from './recoverable-scanner.mjs';
import { executeRecoverableScanStep, recoverableRequestAdmission } from './recoverable-scan-executor.mjs';
import { externalRequestHandler, localTransactionHandler, OneAlarmScheduler, SchedulerStepError } from './scheduler.mjs';
import { readGmgnApiKey, saveGmgnApiKey } from './storage/gmgn-credential.mjs';
import { SqliteControlStateStore, assertCheckpointGeneration } from './storage/control-state.mjs';
import { prepareCredentialVerification, verifyAndActivatePendingCredential } from './auth/connection.mjs';
import { RecoverableScannerError, SqliteRecoverableScannerStore } from './storage/recoverable-scanner.mjs';
import {
  enableSchedulerEligibilityInTransaction,
  ensureSchedulerTenant,
  readSchedulerStateInTransaction,
  readSchedulerTenant,
  scheduleRecoverableScanTaskInTransaction,
  SqliteSchedulerStore,
  writeSchedulerStateInTransaction
} from './storage/scheduler-state.mjs';
import { validateTelegramReceipt } from './telegram-intake.mjs';

export class RadarAgent extends DurableObject {
  #schedulerHandlers;

  constructor(ctx, env) {
    super(ctx, env);
    this.schemaVersion = 0;
    ctx.blockConcurrencyWhile(async () => {
      this.schemaVersion = initializeRadarSchema(this.ctx.storage);
    });
    this.#schedulerHandlers = Object.freeze({});
  }

  async getStatus(value) {
    const tenantId = this.#boundTenantId(value);
    const control = new SqliteControlStateStore(this.ctx.storage, tenantId).snapshot();
    return {
      tenantId,
      schemaVersion: this.schemaVersion,
      lifecycle: 'SKELETON',
      gmgnAdmission: readGmgnAdmissionState(this.ctx.storage, tenantId),
      control
    };
  }

  async getGmgnAdmissionState(value) {
    return readGmgnAdmissionState(this.ctx.storage, this.#boundTenantId(value?.tenantId ?? value));
  }

  async setGmgnAdmissionState(value, nextState) {
    return writeGmgnAdmissionState(this.ctx.storage, this.#boundTenantId(value?.tenantId ?? value), nextState ?? value?.state);
  }

  async replaceSchedulerTasks(value) {
    const scheduler = this.#schedulerForTenant(value?.tenantId);
    return scheduler.replaceTasks(value?.tasks);
  }

  async replaceSchedulerTaskSources(value) {
    const scheduler = this.#schedulerForTenant(value?.tenantId);
    return scheduler.replaceTaskSources(value?.sources);
  }

  async replaceSchedulerEligibility(value) {
    const scheduler = this.#schedulerForTenant(value?.tenantId);
    return scheduler.replaceEligibility(value?.eligibility);
  }

  async getSchedulerSnapshot(value) {
    return this.#schedulerForTenant(value).snapshot();
  }

  async setRecoverableGmgnCredential(value) {
    const tenantId = this.#boundTenantId(value?.tenantId);
    return saveGmgnApiKey(this.ctx.storage, this.env.MASTER_ENC_KEY, tenantId, value?.apiKey, {
      afterWrite: () => {
        enableSchedulerEligibilityInTransaction(this.ctx.storage, tenantId);
        const current = readGmgnAdmissionState(this.ctx.storage, tenantId);
        writeGmgnAdmissionStateInTransaction(this.ctx.storage, tenantId, { ...current, keyEpoch: current.keyEpoch + 1 });
      }
    });
  }

  async prepareGmgnCredentialVerification(value) {
    const tenantId = this.#boundTenantId(value?.tenantId);
    const prepared = await prepareCredentialVerification({
      storage: this.ctx.storage,
      masterKey: this.env.MASTER_ENC_KEY,
      tenantId,
      apiKey: value?.apiKey
    });
    const dueAt = await this.#schedulerForTenant(tenantId).recomputeAlarm();
    return { ...prepared, dueAt };
  }

  async pause(value) {
    const tenantId = this.#boundTenantId(value?.tenantId);
    const control = new SqliteControlStateStore(this.ctx.storage, tenantId).pause();
    const dueAt = await this.#schedulerForTenant(tenantId).recomputeAlarm();
    return { ...control, dueAt };
  }

  async resume(value) {
    const tenantId = this.#boundTenantId(value?.tenantId);
    const controlStore = new SqliteControlStateStore(this.ctx.storage, tenantId);
    const control = controlStore.resume();
    const checkpoints = value?.cycleId
      ? [this.#recoverableScannerForCycle({ tenantId, cycleId: value.cycleId }).resumeCheckpoint(value.cycleId)]
      : this.#resumeRecoverableCycles(tenantId);
    const dueAt = await this.#schedulerForTenant(tenantId).recomputeAlarm();
    return { ...control, checkpoint: value?.cycleId ? checkpoints[0] : null, checkpoints, dueAt };
  }

  async switchChain(value) {
    const tenantId = this.#boundTenantId(value?.tenantId);
    const control = new SqliteControlStateStore(this.ctx.storage, tenantId).switchChain(value?.chain);
    const dueAt = await this.#schedulerForTenant(tenantId).recomputeAlarm();
    return { ...control, dueAt };
  }

  async disconnect(value) {
    const tenantId = this.#boundTenantId(value?.tenantId);
    const control = new SqliteControlStateStore(this.ctx.storage, tenantId).disconnect();
    const dueAt = await this.#schedulerForTenant(tenantId).recomputeAlarm();
    return { ...control, dueAt };
  }

  async beginRecoverableCycle(value) {
    const tenantId = this.#boundTenantId(value?.tenantId);
    const checkpoint = this.#recoverableScanner(tenantId, value?.settings).begin({
      ...value,
      afterBegin: current => scheduleRecoverableScanTaskInTransaction(
        this.ctx.storage,
        tenantId,
        current.cycleId,
        current.updatedAt + 1_000,
        recoverableRequestAdmission({ kind: 'DISCOVER', endpoint: 'trenches' }).gmgnWeight
      )
    });
    await this.#schedulerForTenant(tenantId).recomputeAlarm();
    return checkpoint;
  }

  async getRecoverableCycle(value) {
    const tenantId = this.#boundTenantId(value?.tenantId);
    return new SqliteRecoverableScannerStore(this.ctx.storage, tenantId).read(value?.cycleId);
  }

  async nextRecoverableScanRequest(value) {
    return this.#recoverableScannerForCycle(value).nextRequest(value?.cycleId);
  }

  async recordRecoverableScanRequest(value) {
    return this.#recoverableScannerForCycle(value).recordRequest(value?.cycleId, {
      value: value?.response,
      error: value?.error || null,
      collectedAt: value?.collectedAt
    });
  }

  async advanceRecoverableScan(value) {
    return this.#recoverableScannerForCycle(value).advanceLocal(value?.cycleId);
  }

  async commitRecoverableClassification(value) {
    return this.#recoverableScannerForCycle(value).commitClassification(value?.cycleId);
  }

  async recordRecoverableOutcomeSample(value) {
    return this.#recoverableScannerForCycle(value).recordOutcomeSample(value?.cycleId, {
      sample: value?.sample || null,
      error: value?.error || null,
      collectedAt: value?.collectedAt
    });
  }

  async wake() {
    const scheduler = this.#schedulerForPersistedTenant();
    if (!scheduler) return { accepted: false, reason: 'scheduler_not_initialized' };
    return scheduler.wake();
  }

  async receiveTelegramUpdate(value) {
    const receipt = validateTelegramReceipt(value);
    const existingTenant = this.ctx.storage.sql
      .exec('SELECT owner_user_id FROM tenants WHERE tenant_id = ?', receipt.tenantId)
      .toArray()[0];
    if (existingTenant && existingTenant.owner_user_id !== receipt.actorUserId) {
      return { accepted: false, reason: 'owner_mismatch' };
    }

    const store = new SqliteSchedulerStore(this.ctx.storage, receipt.tenantId);
    const result = store.recordTelegramInboxReceipt(receipt, Date.now());
    if (!result.accepted) return result;

    const dueAt = await this.#scheduler(store).recomputeAlarm();
    return { ...result, dueAt };
  }

  async alarm() {
    const scheduler = this.#schedulerForPersistedTenant();
    if (!scheduler) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await scheduler.alarm();
  }

  #schedulerForTenant(value) {
    return this.#scheduler(new SqliteSchedulerStore(this.ctx.storage, this.#boundTenantId(value)));
  }

  #boundTenantId(value) {
    return ensureSchedulerTenant(this.ctx.storage, normalizeTenantId(value));
  }

  #schedulerForPersistedTenant() {
    const tenantId = readSchedulerTenant(this.ctx.storage);
    return tenantId ? this.#scheduler(new SqliteSchedulerStore(this.ctx.storage, tenantId)) : null;
  }

  #recoverableScanner(tenantId, settings) {
    return new RecoverableScanner({
      store: new SqliteRecoverableScannerStore(this.ctx.storage, tenantId),
      settings
    });
  }

  #recoverableScannerForCycle(value) {
    const tenantId = this.#boundTenantId(value?.tenantId);
    const store = new SqliteRecoverableScannerStore(this.ctx.storage, tenantId);
    const checkpoint = store.read(value?.cycleId);
    if (!checkpoint) {
      const error = new Error('cycle checkpoint does not exist');
      error.code = 'CYCLE_CHECKPOINT_MISSING';
      throw error;
    }
    return new RecoverableScanner({ store, settings: checkpoint.partial.settings });
  }

  #resumeRecoverableCycles(tenantId) {
    const store = new SqliteRecoverableScannerStore(this.ctx.storage, tenantId);
    const checkpoints = [];
    for (const checkpoint of store.list()) {
      const scanner = new RecoverableScanner({ store, settings: checkpoint.partial.settings });
      try {
        checkpoints.push(scanner.resumeCheckpoint(checkpoint.cycleId));
      } catch (error) {
        if (!(error instanceof RecoverableScannerError) || ![
          'CYCLE_KEY_EPOCH_STALE', 'CYCLE_DEADLINE_EXPIRED', 'CYCLE_EVIDENCE_STALE'
        ].includes(error.code)) {
          throw error;
        }
        this.#discardRecoverableCycle(tenantId, checkpoint.cycleId);
      }
    }
    return checkpoints;
  }

  #discardRecoverableCycle(tenantId, cycleId) {
    this.ctx.storage.transactionSync(() => {
      const state = readSchedulerStateInTransaction(this.ctx.storage, tenantId);
      writeSchedulerStateInTransaction(this.ctx.storage, tenantId, {
        ...state,
        tasks: state.tasks.filter(task => task.id !== `scan:${cycleId}`)
      });
      this.ctx.storage.sql.exec('DELETE FROM cycle_checkpoint WHERE tenant_id = ? AND cycle_id = ?', tenantId, cycleId);
    });
  }

  #scheduler(store) {
    return new OneAlarmScheduler({
      store,
      alarms: {
        setAlarm: at => this.ctx.storage.setAlarm(at),
        deleteAlarm: () => this.ctx.storage.deleteAlarm()
      },
      handlers: {
        command: this.#receivedInboxHandler(store),
        credential: this.#credentialVerificationHandler(store),
        scan: this.#recoverableScanHandler(store),
        ...this.#schedulerHandlers
      },
      taskReconciler: tasks => this.#reconcileRecoverableScanTasks(store, tasks)
    });
  }

  #reconcileRecoverableScanTasks(store, tasks) {
    const scannerStore = new SqliteRecoverableScannerStore(this.ctx.storage, store.tenantId);
    return tasks.map(task => {
      if (task.kind !== 'scan' || !task.id.startsWith('scan:')) return task;
      const cycleId = task.id.slice('scan:'.length);
      const checkpoint = scannerStore.read(cycleId);
      if (!checkpoint) return task;
      const scanner = new RecoverableScanner({ store: scannerStore, settings: checkpoint.partial.settings });
      const admission = recoverableRequestAdmission(scanner.nextRequest(cycleId));
      return { ...task, needsGmgn: admission.needsGmgn, gmgnWeight: admission.gmgnWeight };
    });
  }

  #recoverableScanHandler(store) {
    return externalRequestHandler(async ({ task, request, gmgnReservation }) => {
      if (!task.id.startsWith('scan:')) {
        throw new SchedulerStepError('SCHEDULER_HANDLER_UNAVAILABLE', 'recoverable scan task identity is invalid');
      }
      const cycleId = task.id.slice('scan:'.length);
      const scanner = this.#recoverableScannerForCycle({ tenantId: store.tenantId, cycleId });
      const apiKey = await readGmgnApiKey(this.ctx.storage, this.env.MASTER_ENC_KEY, store.tenantId);
      const checkpoint = scanner.checkpoint(cycleId);
      assertCheckpointGeneration(this.ctx.storage, store.tenantId, checkpoint);
      const gmgn = new GmgnClient({
        apiKeyProvider: () => apiKey,
        legacyKeyProvider: () => '',
        admissionStateStore: new SqliteGmgnAdmissionStateStore(this.ctx.storage, store.tenantId),
        admissionReservation: gmgnReservation
      });
      return executeRecoverableScanStep({
        scanner,
        cycleId,
        gmgn,
        request,
        onFinalized: checkpoint => this.#startNextRecoverableCycle(store, scanner, checkpoint)
      });
    });
  }

  #startNextRecoverableCycle(store, scanner, checkpoint) {
    const summary = checkpoint.partial.summary;
    if (!summary || typeof summary.nextCycleId !== 'string' || !Number.isSafeInteger(summary.nextCycleAt)
      || !Number.isSafeInteger(summary.nextDeadlineAt) || !Number.isSafeInteger(summary.scanCount)) {
      throw new SchedulerStepError('RECOVERABLE_SCAN_SUMMARY_INVALID', 'recoverable scan summary cannot schedule its successor');
    }
    const schedulerState = store.read();
    if (schedulerState.runtime.eligibility.paused || !schedulerState.runtime.eligibility.configured) return null;
    const existing = scanner.checkpoint(summary.nextCycleId);
    const controlEpoch = Number.isSafeInteger(schedulerState.runtime.control?.controlEpoch)
      ? schedulerState.runtime.control.controlEpoch
      : checkpoint.controlEpoch;
    const successor = existing || scanner.begin({
      cycleId: summary.nextCycleId,
      chain: checkpoint.chain,
      keyEpoch: schedulerState.gmgn.keyEpoch,
      controlEpoch,
      deadlineAt: summary.nextDeadlineAt,
      partial: { rootCycleId: checkpoint.partial.rootCycleId, scanCount: summary.scanCount }
    });
    const admission = recoverableRequestAdmission({ kind: 'DISCOVER', endpoint: 'trenches' });
    return {
      checkpoint: successor,
      task: {
        id: `scan:${summary.nextCycleId}`,
        kind: 'scan',
        dueAt: summary.nextCycleAt,
        enabled: true,
        needsGmgn: admission.needsGmgn,
        gmgnWeight: admission.gmgnWeight
      }
    };
  }

  #credentialVerificationHandler(store) {
    return externalRequestHandler(async ({ task, request, gmgnReservation }) => {
      const match = /^credential:(\d+)$/.exec(task.id);
      if (!match) throw new SchedulerStepError('SCHEDULER_HANDLER_UNAVAILABLE', 'credential task identity is invalid');
      const gmgn = new GmgnClient({
        apiKeyProvider: () => '',
        legacyKeyProvider: () => '',
        admissionStateStore: new SqliteGmgnAdmissionStateStore(this.ctx.storage, store.tenantId),
        admissionReservation: gmgnReservation
      });
      const result = await verifyAndActivatePendingCredential({
        storage: this.ctx.storage,
        masterKey: this.env.MASTER_ENC_KEY,
        tenantId: store.tenantId,
        connectionGeneration: Number(match[1]),
        request,
        verify: (apiKey, options) => gmgn.verifyApiKey(apiKey, options)
      });
      return { status: 'success', complete: true, checkpoint: `credential:${result.connectionGeneration}` };
    });
  }

  #receivedInboxHandler(store) {
    return localTransactionHandler(({ task, transaction }) => {
      if (!task.id.startsWith('inbox:')) {
        throw new SchedulerStepError('SCHEDULER_HANDLER_UNAVAILABLE', `no bounded handler is registered for ${task.kind}`);
      }
      const updateId = task.id.slice('inbox:'.length);
      return transaction(() => {
        const status = store.telegramInboxStatus(updateId);
        if (status !== 'RECEIVED' && status !== 'RUNNING') return { status: 'success', complete: true };
        // M3 owns command execution. Until it is installed, retain the durable receipt without exhausting retries.
        return { status: 'success', complete: false, nextDueAt: Date.now() + 60_000 };
      });
    });
  }
}
