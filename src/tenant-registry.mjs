import { DurableObject } from 'cloudflare:workers';
import { normalizeTenantId } from './storage/gmgn-admission-state.mjs';
import { initializeTenantRegistrySchema } from './storage/tenant-registry-schema.mjs';
import { settleTenantWakes } from './tenant-watchdog.mjs';

const WATCHDOG_CURSOR_KEY = 'scheduler.watchdog.cursor.v1';
const WATCHDOG_PAGE_SIZE = 25;

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
    const cursor = await this.ctx.storage.get(WATCHDOG_CURSOR_KEY);
    if (cursor !== undefined && typeof cursor !== 'string') {
      throw new Error('tenant registry watchdog cursor is corrupt');
    }
    const rows = this.ctx.storage.sql
      .exec(
        'SELECT tenant_id FROM tenant_registry WHERE (? IS NULL OR tenant_id > ?) ORDER BY tenant_id LIMIT ?',
        cursor ?? null,
        cursor ?? null,
        WATCHDOG_PAGE_SIZE + 1
      )
      .toArray();
    const tenants = rows.slice(0, WATCHDOG_PAGE_SIZE).map(row => normalizeTenantId(row.tenant_id));
    const nextCursor = rows.length > tenants.length ? tenants.at(-1) : null;
    if (nextCursor === null) await this.ctx.storage.delete(WATCHDOG_CURSOR_KEY);
    else await this.ctx.storage.put(WATCHDOG_CURSOR_KEY, nextCursor);

    const results = await settleTenantWakes(tenants, tenantId => {
      const radar = this.env.RADAR.get(this.env.RADAR.idFromName(`radar:${tenantId}`));
      return radar.wake();
    });
    const fulfilled = results.filter(result => result.status === 'fulfilled').map(result => result.value);
    return {
      registeredTenantCount: Number(row?.count || 0),
      selectedTenantCount: tenants.length,
      nextCursor,
      wakeAcceptedCount: fulfilled.filter(result => result.accepted).length,
      wakeInactiveCount: fulfilled.filter(result => !result.accepted).length,
      wakeFailedCount: results.length - fulfilled.length
    };
  }
}
