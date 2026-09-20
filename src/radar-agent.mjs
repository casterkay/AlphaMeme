import { DurableObject } from 'cloudflare:workers';
import {
  normalizeTenantId,
  readGmgnAdmissionState,
  writeGmgnAdmissionState
} from './storage/gmgn-admission-state.mjs';
import { initializeRadarSchema } from './storage/schema.mjs';

export class RadarAgent extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.schemaVersion = 0;
    ctx.blockConcurrencyWhile(async () => {
      this.schemaVersion = initializeRadarSchema(this.ctx.storage);
    });
  }

  async getStatus(value) {
    const tenantId = normalizeTenantId(value);
    return {
      tenantId,
      schemaVersion: this.schemaVersion,
      lifecycle: 'SKELETON',
      gmgnAdmission: readGmgnAdmissionState(this.ctx.storage, tenantId)
    };
  }

  async getGmgnAdmissionState(value) {
    return readGmgnAdmissionState(this.ctx.storage, value);
  }

  async setGmgnAdmissionState(value, nextState) {
    return writeGmgnAdmissionState(this.ctx.storage, value, nextState);
  }

  async wake() {
    return { accepted: false, reason: 'scheduler_not_implemented' };
  }

  async alarm() {
    // Scheduler ownership begins in #12. This skeleton deliberately has no alarm work.
  }
}
