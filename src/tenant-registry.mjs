import { DurableObject } from 'cloudflare:workers';
import { normalizeTenantId } from './storage/gmgn-admission-state.mjs';
import { initializeTenantRegistrySchema } from './storage/tenant-registry-schema.mjs';

export class TenantRegistry extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      initializeTenantRegistrySchema(this.ctx.storage);
    });
  }

  async registerTenant(value) {
    const tenantId = normalizeTenantId(value);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        'INSERT INTO tenant_registry (tenant_id, registered_at) VALUES (?, ?) ON CONFLICT(tenant_id) DO NOTHING',
        tenantId,
        Date.now()
      );
    });
    return { tenantId };
  }

  async scheduledWake() {
    const row = this.ctx.storage.sql.exec('SELECT COUNT(*) AS count FROM tenant_registry').toArray()[0];
    return { registeredTenantCount: Number(row?.count || 0) };
  }
}
