import { DurableObject } from 'cloudflare:workers';
import {
  normalizeTenantId,
  readGmgnAdmissionState,
  writeGmgnAdmissionState
} from './storage/gmgn-admission-state.mjs';
import { initializeRadarSchema } from './storage/schema.mjs';
import { OneAlarmScheduler } from './scheduler.mjs';
import { ensureSchedulerTenant, readSchedulerTenant, SqliteSchedulerStore } from './storage/scheduler-state.mjs';

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
      handlers: this.#schedulerHandlers
    });
  }
}
