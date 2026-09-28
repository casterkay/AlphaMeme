import { normalizeAveApiKey } from '../providers/ave.mjs';
import { encryptSecret, decryptSecret } from '../util/crypto.mjs';
import {
  activateCredentialInTransaction,
  beginCredentialVerificationInTransaction,
  ControlStateError,
  SqliteControlStateStore
} from '../storage/control-state.mjs';
import { scheduleCredentialVerificationTaskInTransaction } from '../storage/scheduler-state.mjs';
import { normalizeTenantId } from '../storage/tenant-id.mjs';

const ACTIVE_KEY_NAME = 'ave-api-key';
const PENDING_KEY_NAME = 'ave-pending-api-key';
export const CONNECTION_KEY_NAMES = Object.freeze({ ACTIVE_KEY_NAME, PENDING_KEY_NAME });
export const CREDENTIAL_CANDIDATE_TTL_MS = 15 * 60_000;

export class ConnectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ConnectionError';
    this.code = code;
  }
}

function requireStorage(storage) {
  if (!storage?.sql || typeof storage.transactionSync !== 'function') {
    throw new ConnectionError('CONNECTION_STORAGE_INVALID', 'connection state requires Durable Object SQLite storage');
  }
}

function nowTimestamp(now) {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) throw new ConnectionError('CONNECTION_CLOCK_INVALID', 'connection clock is invalid');
  return value;
}

function generation(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ConnectionError('CONNECTION_GENERATION_INVALID', 'connection generation is invalid');
  }
  return value;
}

function keyRow(storage, tenantId, name) {
  const rows = storage.sql.exec('SELECT value_enc, generation FROM keys WHERE tenant_id = ? AND name = ?', tenantId, name).toArray();
  if (rows.length > 1) throw new ConnectionError('CONNECTION_KEY_CORRUPT', 'credential has duplicate records');
  return rows[0] || null;
}

function saveKey(storage, tenantId, name, envelope, keyGeneration, now) {
  storage.sql.exec('INSERT INTO keys (tenant_id, name, value_enc, generation, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(tenant_id, name) DO UPDATE SET value_enc = excluded.value_enc, generation = excluded.generation, created_at = excluded.created_at', tenantId, name, envelope, keyGeneration, now);
}

/** The verified AVE key; never exposed outside the request it authorizes. */
export async function readAveApiKey(storage, masterKey, tenant) {
  requireStorage(storage);
  const tenantId = normalizeTenantId(tenant);
  const row = keyRow(storage, tenantId, ACTIVE_KEY_NAME);
  if (!row) throw new ConnectionError('AVE_CREDENTIAL_MISSING', 'AVE credential is not configured');
  const key = normalizeAveApiKey(await decryptSecret(masterKey, tenantId, ACTIVE_KEY_NAME, row.value_enc));
  if (!key) throw new ConnectionError('AVE_CREDENTIAL_CORRUPT', 'AVE credential plaintext is invalid');
  return key;
}

function liveCredentialCommand(storage, tenantId, updateId, timestamp) {
  const row = storage.sql.exec('SELECT status, command_type, received_at, expires_at, payload_enc, generation FROM inbox WHERE tenant_id = ? AND update_id = ?', tenantId, updateId).toArray()[0];
  if (!row || !['RECEIVED', 'RUNNING'].includes(row.status) || row.command_type !== 'credential') {
    throw new ConnectionError('CONNECTION_COMMAND_TERMINAL', 'credential command is no longer active');
  }
  if (!Number.isSafeInteger(row.expires_at) || row.expires_at <= timestamp
    || row.received_at + CREDENTIAL_CANDIDATE_TTL_MS <= timestamp) {
    throw new ConnectionError('CONNECTION_CANDIDATE_EXPIRED', 'credential submission expired; submit it again');
  }
  return row;
}

/** Store a submitted key as the pending candidate and schedule its verification read. */
export async function prepareOnboardingVerification({ storage, masterKey, tenantId: tenant, updateId, apiKey, aveCost, now = Date.now } = {}) {
  requireStorage(storage);
  const tenantId = normalizeTenantId(tenant);
  const normalizedKey = normalizeAveApiKey(apiKey);
  if (!normalizedKey) throw new ConnectionError('AVE_CREDENTIAL_INVALID', 'AVE API key is invalid');
  const timestamp = nowTimestamp(now);
  const command = liveCredentialCommand(storage, tenantId, updateId, timestamp);
  const connectionGeneration = new SqliteControlStateStore(storage, tenantId).snapshot().connectionGeneration;
  const previousSubmission = keyRow(storage, tenantId, PENDING_KEY_NAME);
  if (previousSubmission && command.generation === previousSubmission.generation) {
    const previousCandidate = JSON.parse(await decryptSecret(masterKey, tenantId, PENDING_KEY_NAME, previousSubmission.value_enc));
    if (previousCandidate.updateId === updateId) {
      liveCredentialCommand(storage, tenantId, updateId, nowTimestamp(now));
      if (keyRow(storage, tenantId, PENDING_KEY_NAME)?.value_enc !== previousSubmission.value_enc
        || new SqliteControlStateStore(storage, tenantId).snapshot().connectionGeneration !== connectionGeneration
        || previousSubmission.generation !== connectionGeneration) throw new ConnectionError('CONNECTION_GENERATION_STALE', 'credential submission changed');
      return Object.freeze({ connectionGeneration, dueAt: timestamp });
    }
  }
  const candidate = { apiKey: normalizedKey, updateId, expiresAt: Math.min(command.expires_at, command.received_at + CREDENTIAL_CANDIDATE_TTL_MS) };
  const envelope = await encryptSecret(masterKey, tenantId, PENDING_KEY_NAME, JSON.stringify(candidate));
  return storage.transactionSync(() => {
    liveCredentialCommand(storage, tenantId, updateId, nowTimestamp(now));
    let state;
    try {
      state = beginCredentialVerificationInTransaction(storage, tenantId, connectionGeneration);
    } catch (error) {
      if (error instanceof ControlStateError) throw new ConnectionError(error.code, error.message);
      throw error;
    }
    const previous = keyRow(storage, tenantId, PENDING_KEY_NAME);
    if (previous) storage.sql.exec("UPDATE inbox SET status = 'CANCELLED', payload_enc = NULL, next_at = NULL WHERE tenant_id = ? AND generation = ? AND update_id != ? AND status IN ('RECEIVED', 'RUNNING') AND command_type = 'credential'", tenantId, previous.generation, updateId);
    saveKey(storage, tenantId, PENDING_KEY_NAME, envelope, state.connectionGeneration, timestamp);
    storage.sql.exec('UPDATE inbox SET generation = ? WHERE tenant_id = ? AND update_id = ?', state.connectionGeneration, tenantId, updateId);
    scheduleCredentialVerificationTaskInTransaction(storage, tenantId, state.connectionGeneration, timestamp, aveCost);
    return Object.freeze({ connectionGeneration: state.connectionGeneration, dueAt: timestamp });
  });
}

/** Verify the pending key with one AVE read and activate it if nothing superseded it meanwhile. */
export async function verifyAndActivateOnboardingCredential({ storage, masterKey, tenantId: tenant,
  connectionGeneration, verify, request, afterActivate, now = Date.now } = {}) {
  requireStorage(storage);
  const tenantId = normalizeTenantId(tenant);
  const expected = generation(connectionGeneration);
  if (typeof verify !== 'function' || typeof request !== 'function' || typeof afterActivate !== 'function') {
    throw new ConnectionError('CONNECTION_VERIFIER_INVALID', 'verification requires admission and atomic command completion');
  }
  const pending = keyRow(storage, tenantId, PENDING_KEY_NAME);
  if (!pending || pending.generation !== expected) throw new ConnectionError('CONNECTION_GENERATION_STALE', 'credential submission changed');
  const candidate = JSON.parse(await decryptSecret(masterKey, tenantId, PENDING_KEY_NAME, pending.value_enc));
  function fence() {
    if (keyRow(storage, tenantId, PENDING_KEY_NAME)?.value_enc !== pending.value_enc
      || new SqliteControlStateStore(storage, tenantId).snapshot().connectionGeneration !== expected) {
      throw new ConnectionError('CONNECTION_GENERATION_STALE', 'connection changed');
    }
    const command = liveCredentialCommand(storage, tenantId, candidate.updateId, nowTimestamp(now));
    if (command.generation !== expected) throw new ConnectionError('CONNECTION_GENERATION_STALE', 'credential command changed');
    if (candidate.expiresAt <= nowTimestamp(now)) throw new ConnectionError('CONNECTION_CANDIDATE_EXPIRED', 'credential submission expired');
  }
  fence();
  const result = await request(({ signal, timeoutMs }) => {
    fence();
    return verify(candidate.apiKey, { signal, timeoutMs });
  });
  if (result?.verified !== true) throw new ConnectionError('AVE_REQUEST_FAILED', 'credential verification failed');
  fence();
  const activeApiKey = await encryptSecret(masterKey, tenantId, ACTIVE_KEY_NAME, candidate.apiKey);
  return storage.transactionSync(() => {
    fence();
    const state = activateCredentialInTransaction(storage, tenantId, { connectionGeneration: expected });
    saveKey(storage, tenantId, ACTIVE_KEY_NAME, activeApiKey, state.connectionGeneration, nowTimestamp(now));
    storage.sql.exec('DELETE FROM keys WHERE tenant_id = ? AND name = ?', tenantId, PENDING_KEY_NAME);
    afterActivate(Object.freeze({ ...state, updateId: candidate.updateId }));
    return Object.freeze({ configured: true, keyEpoch: state.keyEpoch, connectionGeneration: state.connectionGeneration, updateId: candidate.updateId });
  });
}

/** Caller supplies its already-classified permanent failure/expiry; no key is echoed. */
export function failOnboardingVerification({ storage, tenantId: tenant, updateId, connectionGeneration, status = 'FAILED' }) {
  const tenantId = normalizeTenantId(tenant);
  if (!['FAILED', 'CANCELLED'].includes(status)) throw new ConnectionError('CONNECTION_STATUS_INVALID', 'terminal credential status required');
  return storage.transactionSync(() => {
    storage.sql.exec("UPDATE inbox SET status = ?, payload_enc = NULL, next_at = NULL WHERE tenant_id = ? AND update_id = ? AND generation = ? AND status IN ('RECEIVED', 'RUNNING')", status, tenantId, updateId, generation(connectionGeneration));
    storage.sql.exec('DELETE FROM keys WHERE tenant_id = ? AND name = ? AND generation = ?', tenantId, PENDING_KEY_NAME, generation(connectionGeneration));
  });
}
