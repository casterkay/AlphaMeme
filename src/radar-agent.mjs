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
import { SqliteRecoverableScannerStore } from './storage/recoverable-scanner.mjs';
import {
  enableSchedulerEligibilityInTransaction,
  ensureSchedulerTenant,
  readSchedulerTenant,
  scheduleRecoverableScanTaskInTransaction,
  SqliteSchedulerStore
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
    return {
      tenantId,
      schemaVersion: this.schemaVersion,
      lifecycle: 'SKELETON',
      gmgnAdmission: readGmgnAdmissionState(this.ctx.storage, tenantId)
    };
  }

  async getGmgnAdmissionState(value) {
    return readGmgnAdmissionState(this.ctx.storage, this.#boundTenantId(value));
  }

  async setGmgnAdmissionState(value, nextState) {
    return writeGmgnAdmissionState(this.ctx.storage, this.#boundTenantId(value), nextState);
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

  #scheduler(store) {
    return new OneAlarmScheduler({
      store,
      alarms: {
        setAlarm: at => this.ctx.storage.setAlarm(at),
        deleteAlarm: () => this.ctx.storage.deleteAlarm()
      },
      handlers: {
        command: this.#receivedInboxHandler(store),
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
