import { normalizeGmgnApiKey } from '../gmgn-api-key.mjs';
import { encryptSecret, decryptSecret } from '../util/crypto.mjs';
import { SIGNING_KEY_NAMES, signingRow, saveKey, decryptSigningKey } from './key-store.mjs';
import { normalizeTenantId } from '../storage/gmgn-admission-state.mjs';
import {
  activateCredentialInTransaction,
  beginCredentialVerificationInTransaction,
  ControlStateError,
  SqliteControlStateStore
} from '../storage/control-state.mjs';
import { decryptGmgnApiKey, encryptGmgnApiKey } from '../storage/gmgn-credential.mjs';
import { scheduleCredentialVerificationTaskInTransaction } from '../storage/scheduler-state.mjs';

const ACTIVE_KEY_NAME = 'gmgn-api-key';
const PENDING_KEY_NAME = 'gmgn-pending-api-key';

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

function pendingRow(storage, tenantId) {
  const rows = storage.sql.exec(
    'SELECT value_enc, generation FROM keys WHERE tenant_id = ? AND name = ?', tenantId, PENDING_KEY_NAME
  ).toArray();
  if (rows.length > 1) throw new ConnectionError('CONNECTION_PENDING_CORRUPT', 'pending credential has duplicate records');
  return rows[0] || null;
}

function generation(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ConnectionError('CONNECTION_GENERATION_INVALID', 'connection generation is invalid');
  }
  return value;
}

export async function prepareCredentialVerification({ storage, masterKey, tenantId: tenant, apiKey, now = Date.now } = {}) {
  requireStorage(storage);
  if (typeof now !== 'function') throw new ConnectionError('CONNECTION_CLOCK_INVALID', 'connection clock is invalid');
  const tenantId = normalizeTenantId(tenant);
  const preparedAt = nowTimestamp(now);
  const expectedConnectionGeneration = new SqliteControlStateStore(storage, tenantId).snapshot().connectionGeneration;
  // Encrypt before the local transaction. Activation later decrypts this pending
  // envelope and re-encrypts the verified credential for the active field.
  const valueEnc = await encryptGmgnApiKey(masterKey, tenantId, apiKey, { field: PENDING_KEY_NAME });
  return storage.transactionSync(() => {
    let state;
    try {
      state = beginCredentialVerificationInTransaction(storage, tenantId, expectedConnectionGeneration);
    } catch (error) {
      if (error instanceof ControlStateError) throw new ConnectionError(error.code, error.message);
      throw error;
    }
    storage.sql.exec(
      'INSERT INTO keys (tenant_id, name, value_enc, generation, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(tenant_id, name) DO UPDATE SET value_enc = excluded.value_enc, generation = excluded.generation, created_at = excluded.created_at',
      tenantId, PENDING_KEY_NAME, valueEnc, state.connectionGeneration, preparedAt
    );
    scheduleCredentialVerificationTaskInTransaction(storage, tenantId, state.connectionGeneration, preparedAt);
    return Object.freeze({ connectionGeneration: state.connectionGeneration, dueAt: preparedAt });
  });
}

export async function verifyAndActivatePendingCredential({
  storage,
  masterKey,
  tenantId: tenant,
  connectionGeneration,
  verify,
  request,
  afterActivate,
  now = Date.now
} = {}) {
  requireStorage(storage);
  if (typeof now !== 'function') throw new ConnectionError('CONNECTION_CLOCK_INVALID', 'connection clock is invalid');
  const tenantId = normalizeTenantId(tenant);
  const expectedGeneration = generation(connectionGeneration);
  if (typeof verify !== 'function' || typeof request !== 'function') {
    throw new ConnectionError('CONNECTION_VERIFIER_INVALID', 'credential verification requires the scheduler request capability');
  }
  const pending = pendingRow(storage, tenantId);
  if (!pending || generation(pending.generation) !== expectedGeneration) {
    throw new ConnectionError('CONNECTION_GENERATION_STALE', 'credential verification was superseded before it started');
  }
  const apiKey = await decryptGmgnApiKey(masterKey, tenantId, pending.value_enc, { field: PENDING_KEY_NAME });
  const afterDecrypt = pendingRow(storage, tenantId);
  if (!afterDecrypt || generation(afterDecrypt.generation) !== expectedGeneration) {
    throw new ConnectionError('CONNECTION_GENERATION_STALE', 'credential verification was superseded during decryption');
  }
  const result = await request(({ signal, timeoutMs }) => verify(apiKey, { signal, timeoutMs }));
  if (result?.verified !== true) throw new ConnectionError('GMGN_REQUEST_FAILED', 'credential verification did not complete');

  const afterVerification = pendingRow(storage, tenantId);
  if (!afterVerification || generation(afterVerification.generation) !== expectedGeneration) {
    throw new ConnectionError('CONNECTION_GENERATION_STALE', 'credential verification was superseded while waiting');
  }
  const activeValueEnc = await encryptGmgnApiKey(masterKey, tenantId, apiKey, { field: ACTIVE_KEY_NAME });

  return storage.transactionSync(() => {
    const current = pendingRow(storage, tenantId);
    if (!current || generation(current.generation) !== expectedGeneration) {
      throw new ConnectionError('CONNECTION_GENERATION_STALE', 'credential verification was superseded while waiting');
    }
    let state;
    try {
      state = activateCredentialInTransaction(storage, tenantId, { connectionGeneration: expectedGeneration }, afterActivate);
    } catch (error) {
      if (error instanceof ControlStateError) throw new ConnectionError(error.code, error.message);
      throw error;
    }
    storage.sql.exec(
      'INSERT INTO keys (tenant_id, name, value_enc, generation, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(tenant_id, name) DO UPDATE SET value_enc = excluded.value_enc, generation = excluded.generation, created_at = excluded.created_at',
      tenantId, ACTIVE_KEY_NAME, activeValueEnc, state.connectionGeneration, nowTimestamp(now)
    );
    storage.sql.exec('DELETE FROM keys WHERE tenant_id = ? AND name = ?', tenantId, PENDING_KEY_NAME);
    return Object.freeze({ configured: true, keyEpoch: state.keyEpoch, connectionGeneration: state.connectionGeneration });
  });
}

export const CONNECTION_KEY_NAMES = Object.freeze({ ACTIVE_KEY_NAME, PENDING_KEY_NAME });

// Production Telegram onboarding requires signing setup and a live durable
// command. The M2 API above remains the internal API-only migration path.

export const CREDENTIAL_CANDIDATE_TTL_MS = 15 * 60_000;

function liveCredentialCommand(storage, tenantId, updateId, timestamp) {
  const row = storage.sql.exec('SELECT status, command_type, received_at, expires_at, payload_enc, generation FROM inbox WHERE tenant_id = ? AND update_id = ?', tenantId, updateId).toArray()[0];
  if (!row || !['RECEIVED', 'RUNNING'].includes(row.status)
    || !['setkey', 'command:setkey', 'credential_verify', 'credential'].includes(row.command_type)) {
    throw new ConnectionError('CONNECTION_COMMAND_TERMINAL', 'credential command is no longer active');
  }
  if (!Number.isSafeInteger(row.expires_at) || row.expires_at <= timestamp
    || row.received_at + CREDENTIAL_CANDIDATE_TTL_MS <= timestamp) {
    throw new ConnectionError('CONNECTION_CANDIDATE_EXPIRED', 'credential submission expired; submit it again');
  }
  return row;
}

export async function prepareOnboardingVerification({ storage, masterKey, tenantId: tenant, updateId,
  apiKey, expectedSigningGeneration, now = Date.now } = {}) {
  requireStorage(storage);
  const tenantId = normalizeTenantId(tenant);
  const normalizedKey = normalizeGmgnApiKey(apiKey);
  if (!normalizedKey) throw new ConnectionError('GMGN_CREDENTIAL_INVALID', 'GMGN API key is invalid');
  const timestamp = nowTimestamp(now);
  const command = liveCredentialCommand(storage, tenantId, updateId, timestamp);
  const connectionGeneration = new SqliteControlStateStore(storage, tenantId).snapshot().connectionGeneration;
  const pending = signingRow(storage, tenantId);
  const signingField = pending ? SIGNING_KEY_NAMES.pending : SIGNING_KEY_NAMES.active;
  const signing = pending || signingRow(storage, tenantId, signingField);
  if (!signing) throw new ConnectionError('SIGNING_SETUP_REQUIRED', 'use /onboard to prepare a public key first');
  if (signing.generation !== generation(expectedSigningGeneration)) throw new ConnectionError('SIGNING_GENERATION_STALE', 'signing setup changed');
  const previousSubmission = pendingRow(storage, tenantId);
  if (previousSubmission && command.generation === previousSubmission.generation) {
    const previousCandidate = JSON.parse(await decryptSecret(masterKey, tenantId, PENDING_KEY_NAME, previousSubmission.value_enc));
    if (previousCandidate.updateId === updateId && previousCandidate.signingGeneration === signing.generation) {
      liveCredentialCommand(storage, tenantId, updateId, nowTimestamp(now));
      if (pendingRow(storage, tenantId)?.value_enc !== previousSubmission.value_enc
        || new SqliteControlStateStore(storage, tenantId).snapshot().connectionGeneration !== connectionGeneration
        || previousSubmission.generation !== connectionGeneration) throw new ConnectionError('CONNECTION_GENERATION_STALE', 'credential submission changed');
      return Object.freeze({ connectionGeneration, signingGeneration: signing.generation, dueAt: timestamp });
    }
  }
  const candidate = { apiKey: normalizedKey, updateId, signingField, signingGeneration: signing.generation,
    expiresAt: Math.min(command.expires_at, command.received_at + CREDENTIAL_CANDIDATE_TTL_MS) };
  const envelope = await encryptSecret(masterKey, tenantId, PENDING_KEY_NAME, JSON.stringify(candidate));
  return storage.transactionSync(() => {
    liveCredentialCommand(storage, tenantId, updateId, nowTimestamp(now));
    if (signingRow(storage, tenantId, signingField)?.value_enc !== signing.value_enc) throw new ConnectionError('SIGNING_GENERATION_STALE', 'signing setup changed');
    const state = beginCredentialVerificationInTransaction(storage, tenantId, connectionGeneration);
    const previous = pendingRow(storage, tenantId);
    if (previous) storage.sql.exec("UPDATE inbox SET status = 'CANCELLED', payload_enc = NULL, next_at = NULL WHERE tenant_id = ? AND generation = ? AND update_id != ? AND status IN ('RECEIVED', 'RUNNING') AND command_type IN ('setkey', 'command:setkey', 'credential_verify', 'credential')", tenantId, previous.generation, updateId);
    saveKey(storage, tenantId, PENDING_KEY_NAME, envelope, state.connectionGeneration, timestamp);
    storage.sql.exec('UPDATE inbox SET generation = ? WHERE tenant_id = ? AND update_id = ?', state.connectionGeneration, tenantId, updateId);
    scheduleCredentialVerificationTaskInTransaction(storage, tenantId, state.connectionGeneration, timestamp);
    return Object.freeze({ connectionGeneration: state.connectionGeneration, signingGeneration: signing.generation, dueAt: timestamp });
  });
}

export async function verifyAndActivateOnboardingCredential({ storage, masterKey, tenantId: tenant,
  connectionGeneration, verify, request, afterActivate, now = Date.now } = {}) {
  requireStorage(storage);
  const tenantId = normalizeTenantId(tenant);
  const expected = generation(connectionGeneration);
  if (typeof verify !== 'function' || typeof request !== 'function' || typeof afterActivate !== 'function') {
    throw new ConnectionError('CONNECTION_VERIFIER_INVALID', 'verification requires admission and atomic command completion');
  }
  const pending = pendingRow(storage, tenantId);
  if (!pending || pending.generation !== expected) throw new ConnectionError('CONNECTION_GENERATION_STALE', 'credential submission changed');
  const candidate = JSON.parse(await decryptSecret(masterKey, tenantId, PENDING_KEY_NAME, pending.value_enc));
  const signing = signingRow(storage, tenantId, candidate.signingField);
  function fence() {
    if (pendingRow(storage, tenantId)?.value_enc !== pending.value_enc
      || new SqliteControlStateStore(storage, tenantId).snapshot().connectionGeneration !== expected
      || !signing || signing.generation !== candidate.signingGeneration
      || signingRow(storage, tenantId, candidate.signingField)?.value_enc !== signing.value_enc) {
      throw new ConnectionError('CONNECTION_GENERATION_STALE', 'connection or signing setup changed');
    }
    const command = liveCredentialCommand(storage, tenantId, candidate.updateId, nowTimestamp(now));
    if (command.generation !== expected) throw new ConnectionError('CONNECTION_GENERATION_STALE', 'credential command changed');
    if (candidate.expiresAt <= nowTimestamp(now)) throw new ConnectionError('CONNECTION_CANDIDATE_EXPIRED', 'credential submission expired');
  }
  fence();
  const signingValue = await decryptSigningKey(masterKey, tenantId, signing, candidate.signingField);
  fence();
  const result = await request(({ signal, timeoutMs }) => {
    fence();
    return verify(candidate.apiKey, { signal, timeoutMs });
  });
  if (result?.verified !== true) throw new ConnectionError('GMGN_REQUEST_FAILED', 'credential verification failed');
  fence();
  const activeApiKey = await encryptSecret(masterKey, tenantId, ACTIVE_KEY_NAME, candidate.apiKey);
  const activeSigning = await encryptSecret(masterKey, tenantId, SIGNING_KEY_NAMES.active, JSON.stringify(signingValue));
  return storage.transactionSync(() => {
    fence();
    const state = activateCredentialInTransaction(storage, tenantId, { connectionGeneration: expected });
    saveKey(storage, tenantId, ACTIVE_KEY_NAME, activeApiKey, state.connectionGeneration, nowTimestamp(now));
    saveKey(storage, tenantId, SIGNING_KEY_NAMES.active, activeSigning, candidate.signingGeneration, nowTimestamp(now));
    storage.sql.exec('DELETE FROM keys WHERE tenant_id = ? AND name IN (?, ?)', tenantId, PENDING_KEY_NAME, SIGNING_KEY_NAMES.pending);
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
