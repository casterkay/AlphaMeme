import { DurableObject } from 'cloudflare:workers';
import {
  normalizeTenantId,
  readGmgnAdmissionState,
  writeGmgnAdmissionState
} from './storage/gmgn-admission-state.mjs';
import { initializeRadarSchema } from './storage/schema.mjs';
import { localTransactionHandler, OneAlarmScheduler, SchedulerStepError } from './scheduler.mjs';
import { ensureSchedulerTenant, readSchedulerTenant, SqliteSchedulerStore } from './storage/scheduler-state.mjs';
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

  #scheduler(store) {
    return new OneAlarmScheduler({
      store,
      alarms: {
        setAlarm: at => this.ctx.storage.setAlarm(at),
        deleteAlarm: () => this.ctx.storage.deleteAlarm()
      },
      handlers: { command: this.#receivedInboxHandler(store), ...this.#schedulerHandlers }
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
