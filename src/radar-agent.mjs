import { TelegramRuntime } from './bot/runtime.mjs';
import { DurableObject } from 'cloudflare:workers';
import {
  normalizeTenantId,
  readGmgnAdmissionState,
  SqliteGmgnAdmissionStateStore,
  writeGmgnAdmissionState
} from './storage/gmgn-admission-state.mjs';
import { initializeRadarSchema } from './storage/schema.mjs';
import { GmgnClient } from './providers/gmgn.mjs';
import { RecoverableScanner } from './recoverable-scanner.mjs';
import { executeRecoverableScanStep, recoverableRequestAdmission } from './recoverable-scan-executor.mjs';
import { externalRequestHandler, localTransactionHandler, OneAlarmScheduler, SchedulerStepError } from './scheduler.mjs';
import { readGmgnApiKey } from './storage/gmgn-credential.mjs';
import { SqliteControlStateStore, assertCheckpointGeneration } from './storage/control-state.mjs';
import { prepareCredentialVerification, verifyAndActivatePendingCredential } from './auth/connection.mjs';
import {
  restartRecoverableScanInTransaction,
  resumeRecoverableCheckpointsInTransaction,
  SqliteRecoverableScannerStore
} from './storage/recoverable-scanner.mjs';
import {
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
      const tenantId = readSchedulerTenant(this.ctx.storage);
      if (tenantId) this.ctx.storage.transactionSync(() => this.#telegram(tenantId).reconcileInTransaction({ recover: true }));
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
    const scheduledCycleIds = new SqliteSchedulerStore(this.ctx.storage, tenantId).read().tasks
      .filter(task => task.kind === 'scan' && task.enabled && task.id.startsWith('scan:'))
      .map(task => task.id.slice('scan:'.length));
    const checkpointIds = [...new Set(value?.cycleId ? [value.cycleId, ...scheduledCycleIds] : scheduledCycleIds)];
    const now = Date.now();
    const resumed = new SqliteControlStateStore(this.ctx.storage, tenantId).resumeWith(
      control => resumeRecoverableCheckpointsInTransaction(this.ctx.storage, tenantId, { cycleIds: checkpointIds, control, now }),
      () => checkpointIds.map(cycleId => this.#recoverableScannerForCycle({ tenantId, cycleId }).checkpoint(cycleId))
    );
    const dueAt = await this.#schedulerForTenant(tenantId).recomputeAlarm();
    return { ...resumed.control, checkpoint: value?.cycleId ? resumed.value[0] : null, checkpoints: resumed.value, dueAt };
  }

  async switchChain(value) {
    const tenantId = this.#boundTenantId(value?.tenantId);
    const control = new SqliteControlStateStore(this.ctx.storage, tenantId).switchChain(value?.chain);
    const dueAt = await this.#schedulerForTenant(tenantId).recomputeAlarm();
    return { ...control, dueAt };
  }

  async setScanChains(value) {
    const tenantId = this.#boundTenantId(value?.tenantId);
    const now = Date.now();
    const control = new SqliteControlStateStore(this.ctx.storage, tenantId).setScanChains(value?.chains, ({ control, cycleIds }) =>
      resumeRecoverableCheckpointsInTransaction(this.ctx.storage, tenantId, { cycleIds, control, now, allowPaused: true })
    );
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
    new SqliteControlStateStore(this.ctx.storage, tenantId).ensureActiveChain(value?.chain);
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

    if (receipt.commandType === 'credential') throw new TypeError('Credential requires protected intake');
    const tenantId = this.#boundTenantId(receipt.tenantId);
    const result = this.#telegram(tenantId).receive(receipt);
    if (!result.accepted) return result;
    const dueAt = await this.#schedulerForTenant(tenantId).recomputeAlarm();
    if (receipt.payload.callbackQueryId) this.ctx.waitUntil(this.#telegram(tenantId).answerCallback(receipt));
    return { ...result, dueAt };
  }

  async receiveTelegramCredential(value, credentialText) {
    const receipt = validateTelegramReceipt(value);
    if (receipt.commandType !== 'credential') throw new TypeError('Protected intake requires credential metadata');
    const owner = this.ctx.storage.sql.exec('SELECT owner_user_id FROM tenants WHERE tenant_id=?', receipt.tenantId).toArray()[0];
    if (owner && owner.owner_user_id !== receipt.actorUserId) return { accepted: false, reason: 'owner_mismatch' };
    const tenantId = this.#boundTenantId(receipt.tenantId);
    const result = await this.#telegram(tenantId).receiveCredential(receipt, credentialText);
    const dueAt = await this.#schedulerForTenant(tenantId).recomputeAlarm();
    return { ...result, dueAt };
  }

  #telegram(tenantId) {
    return new TelegramRuntime({ storage: this.ctx.storage, env: this.env, tenantId });
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
        'local-control': localTransactionHandler(({ transaction }) => transaction(() => { this.#telegram(store.tenantId).reconcileCardsInTransaction(); return { status: 'success', complete: true }; })),
        command: externalRequestHandler(({ task }) => this.#telegram(store.tenantId).runCommand(task.id.slice('inbox:'.length))),
        outbox: externalRequestHandler(({ task, request }) => {
          const outbox = this.#telegram(store.tenantId).outbox;
          if (!outbox.rows().some(row => task.id === `outbox:${row.id}`)) throw new SchedulerStepError('SCHEDULER_HANDLER_UNAVAILABLE', 'Outbox task has no durable intent');
          return outbox.deliverOne(task.id.slice('outbox:'.length), { request });
        }),
        live: this.#liveHandler(store),
        credential: this.#credentialVerificationHandler(store),
        scan: this.#recoverableScanHandler(store),
        ...this.#schedulerHandlers
      },
      taskReconciler: tasks => this.#reconcileRecoverableScanTasks(store, this.#telegram(store.tenantId).reconcileInTransaction({ tasks }))
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
      const apiKey = await readGmgnApiKey(this.ctx.storage, this.#telegram(store.tenantId).masterKey, store.tenantId);
      const checkpoint = scanner.checkpoint(cycleId);
      assertCheckpointGeneration(this.ctx.storage, store.tenantId, checkpoint);
      const gmgn = new GmgnClient({
        apiKeyProvider: () => apiKey,
        legacyKeyProvider: () => '',
        admissionStateStore: new SqliteGmgnAdmissionStateStore(this.ctx.storage, store.tenantId),
        admissionReservation: gmgnReservation
      });
      const isGmgnRequest = recoverableRequestAdmission(scanner.nextRequest(cycleId)).needsGmgn;
      return executeRecoverableScanStep({
        scanner,
        cycleId,
        gmgn,
        request: operation => request(async options => {
          try {
            const result = await operation(options);
            if (isGmgnRequest) this.ctx.storage.sql.exec('INSERT INTO scheduler_state (tenant_id,key,value_json) VALUES (?,?,?) ON CONFLICT(tenant_id,key) DO UPDATE SET value_json=excluded.value_json', store.tenantId, 'telegram.providerAuth', JSON.stringify({ keyEpoch: checkpoint.keyEpoch, unusable: false }));
            return result;
          } catch (error) {
            if (['GMGN_AUTH_FAILED','GMGN_PERMISSION_DENIED','GMGN_API_KEY_INVALID'].includes(error.code)) this.ctx.storage.sql.exec('INSERT INTO scheduler_state (tenant_id,key,value_json) VALUES (?,?,?) ON CONFLICT(tenant_id,key) DO UPDATE SET value_json=excluded.value_json', store.tenantId, 'telegram.providerAuth', JSON.stringify({ keyEpoch: checkpoint.keyEpoch, unusable: true }));
            throw error;
          }
        }),
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
    this.ctx.storage.sql.exec('INSERT INTO scheduler_state (tenant_id,key,value_json) VALUES (?,?,?) ON CONFLICT(tenant_id,key) DO UPDATE SET value_json=excluded.value_json', store.tenantId, 'runtime.global', JSON.stringify({ scanCount: summary.scanCount, discoveredCount: checkpoint.partial.screened?.length ?? null, prequalifiedCount: checkpoint.partial.prequalifiedCount ?? null, lastAttemptAt: checkpoint.partial.startedAt, lastSuccessAt: summary.completedAt, nextCycleAt: summary.nextCycleAt }));
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
      const strict = this.ctx.storage.sql.exec("SELECT update_id FROM inbox WHERE tenant_id=? AND command_type='credential' AND generation=? AND status IN ('RECEIVED','RUNNING')", store.tenantId, Number(match[1])).toArray()[0];
      if (strict) return this.#telegram(store.tenantId).verifyCredential(Number(match[1]), { request, gmgn });
      const result = await verifyAndActivatePendingCredential({
        storage: this.ctx.storage,
        masterKey: this.env.MASTER_ENC_KEY,
        tenantId: store.tenantId,
        connectionGeneration: Number(match[1]),
        request,
        afterActivate: state => restartRecoverableScanInTransaction(this.ctx.storage, store.tenantId, {
          keyEpoch: state.keyEpoch,
          controlEpoch: state.controlEpoch,
          now: Date.now()
        }),
        verify: (apiKey, options) => gmgn.verifyApiKey(apiKey, options)
      });
      return { status: 'success', complete: true, checkpoint: `credential:${result.connectionGeneration}` };
    });
  }

  #liveHandler(store) {
    return externalRequestHandler(async ({ request, gmgnReservation }) => {
      const apiKey = await readGmgnApiKey(this.ctx.storage, this.#telegram(store.tenantId).masterKey, store.tenantId);
      const gmgn = new GmgnClient({ apiKeyProvider: () => apiKey, legacyKeyProvider: () => '', admissionStateStore: new SqliteGmgnAdmissionStateStore(this.ctx.storage, store.tenantId), admissionReservation: gmgnReservation });
      return this.#telegram(store.tenantId).live.pollOne({ request, gmgn });
    });
  }
}
