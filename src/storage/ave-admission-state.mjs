import { defaultAveAdmission, validateAveAdmission } from '../ave-admission.mjs';
import { normalizeTenantId } from './tenant-id.mjs';

export const AVE_ADMISSION_STATE_KEY = 'ave.admission.v1';

export class AveAdmissionStateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AveAdmissionStateError';
    this.code = code;
  }
}

export function readAveAdmissionState(storage, tenant) {
  const tenantId = normalizeTenantId(tenant);
  const row = storage.sql.exec('SELECT value_json FROM scheduler_state WHERE tenant_id = ? AND key = ?', tenantId, AVE_ADMISSION_STATE_KEY).toArray()[0];
  if (!row) return defaultAveAdmission();
  let value;
  try {
    value = JSON.parse(row.value_json);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new AveAdmissionStateError('AVE_ADMISSION_STATE_CORRUPT', 'AVE admission state is not valid JSON');
  }
  return { ...validateAveAdmission(value) };
}

/** Call inside the transaction that read the state being replaced. */
export function writeAveAdmissionStateInTransaction(storage, tenant, next) {
  const tenantId = normalizeTenantId(tenant);
  const state = validateAveAdmission(next);
  storage.sql.exec(
    'INSERT INTO scheduler_state (tenant_id, key, value_json) VALUES (?, ?, ?) ON CONFLICT(tenant_id, key) DO UPDATE SET value_json = excluded.value_json',
    tenantId, AVE_ADMISSION_STATE_KEY, JSON.stringify(state)
  );
  return { ...state };
}
