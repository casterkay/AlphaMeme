const GMGN_ADMISSION_STATE_KEY = 'gmgn.admission.v1';

const DEFAULT_STATE = Object.freeze({
  nextAllowedAt: 0,
  backoffFactor: 1,
  lastRequestAt: 0,
  lastWeight: 1,
  successStreak: 0,
  spacingReadyAt: 0,
  keyEpoch: 0
});

export class GmgnAdmissionStateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GmgnAdmissionStateError';
    this.code = code;
  }
}

export function normalizeTenantId(value) {
  const tenantId = typeof value === 'string' ? value : String(value);
  if (!/^-?\d+$/.test(tenantId) || BigInt(tenantId).toString() !== tenantId) {
    throw new GmgnAdmissionStateError('GMGN_ADMISSION_TENANT_INVALID', 'tenant id must be the decimal String(chat_id) value');
  }
  return tenantId;
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validateState(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GmgnAdmissionStateError(code, 'GMGN admission state must be an object');
  const expectedKeys = Object.keys(DEFAULT_STATE).sort();
  const keys = Object.keys(value).sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new GmgnAdmissionStateError(code, 'GMGN admission state has an unsupported shape');
  }
  if (!isNonNegativeInteger(value.nextAllowedAt) || !Number.isFinite(value.backoffFactor) || value.backoffFactor < 1
    || !isNonNegativeInteger(value.lastRequestAt) || !isPositiveInteger(value.lastWeight)
    || !isNonNegativeInteger(value.successStreak) || !isNonNegativeInteger(value.spacingReadyAt)
    || !isNonNegativeInteger(value.keyEpoch)) {
    throw new GmgnAdmissionStateError(code, 'GMGN admission state contains an invalid value');
  }
  return Object.freeze({ ...value });
}

export function defaultGmgnAdmissionState() {
  return { ...DEFAULT_STATE };
}

export function readGmgnAdmissionState(storage, value) {
  const tenantId = normalizeTenantId(value);
  const row = storage.sql.exec('SELECT value_json FROM scheduler_state WHERE tenant_id = ? AND key = ?', tenantId, GMGN_ADMISSION_STATE_KEY).toArray()[0];
  if (!row) return defaultGmgnAdmissionState();
  try {
    return { ...validateState(JSON.parse(row.value_json), 'GMGN_ADMISSION_STATE_CORRUPT') };
  } catch (error) {
    if (error instanceof GmgnAdmissionStateError) throw error;
    throw new GmgnAdmissionStateError('GMGN_ADMISSION_STATE_CORRUPT', `GMGN admission state is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function writeGmgnAdmissionState(storage, value, nextState) {
  const tenantId = normalizeTenantId(value);
  const state = validateState(nextState, 'GMGN_ADMISSION_STATE_INVALID');
  storage.transactionSync(() => {
    storage.sql.exec(
      'INSERT INTO scheduler_state (tenant_id, key, value_json) VALUES (?, ?, ?) ON CONFLICT(tenant_id, key) DO UPDATE SET value_json = excluded.value_json',
      tenantId,
      GMGN_ADMISSION_STATE_KEY,
      JSON.stringify(state)
    );
  });
  return { ...state };
}

// This satisfies GmgnClient's existing durable admission-state boundary. Wiring
// it into the provider lifecycle belongs to the later scheduler work.
export class SqliteGmgnAdmissionStateStore {
  constructor(storage, tenantId) {
    this.storage = storage;
    this.tenantId = normalizeTenantId(tenantId);
  }

  async read() {
    return readGmgnAdmissionState(this.storage, this.tenantId);
  }

  async write(nextState) {
    writeGmgnAdmissionState(this.storage, this.tenantId, nextState);
  }
}
