export class TenantIdError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TenantIdError';
    this.code = 'TENANT_ID_INVALID';
  }
}

/** A tenant is one private Telegram chat; its id is the decimal String(chat_id). */
export function normalizeTenantId(value) {
  const tenantId = typeof value === 'string' ? value : String(value);
  if (!/^-?\d+$/.test(tenantId) || BigInt(tenantId).toString() !== tenantId) {
    throw new TenantIdError('tenant id must be the decimal String(chat_id) value');
  }
  return tenantId;
}
