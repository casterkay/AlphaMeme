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
  // Encrypt before the local transaction. The candidate envelope is already bound
  // to the destination credential field, so activation is a synchronous row move.
  const valueEnc = await encryptGmgnApiKey(masterKey, tenantId, apiKey);
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
  const apiKey = await decryptGmgnApiKey(masterKey, tenantId, pending.value_enc);
  const result = await request(({ signal, timeoutMs }) => verify(apiKey, { signal, timeoutMs }));
  if (result?.verified !== true) throw new ConnectionError('GMGN_REQUEST_FAILED', 'credential verification did not complete');

  return storage.transactionSync(() => {
    const current = pendingRow(storage, tenantId);
    if (!current || generation(current.generation) !== expectedGeneration) {
      throw new ConnectionError('CONNECTION_GENERATION_STALE', 'credential verification was superseded while waiting');
    }
    let state;
    try {
      state = activateCredentialInTransaction(storage, tenantId, { connectionGeneration: expectedGeneration });
    } catch (error) {
      if (error instanceof ControlStateError) throw new ConnectionError(error.code, error.message);
      throw error;
    }
    storage.sql.exec(
      'INSERT INTO keys (tenant_id, name, value_enc, generation, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(tenant_id, name) DO UPDATE SET value_enc = excluded.value_enc, generation = excluded.generation, created_at = excluded.created_at',
      tenantId, ACTIVE_KEY_NAME, current.value_enc, state.connectionGeneration, nowTimestamp(now)
    );
    storage.sql.exec('DELETE FROM keys WHERE tenant_id = ? AND name = ?', tenantId, PENDING_KEY_NAME);
    return Object.freeze({ configured: true, keyEpoch: state.keyEpoch, connectionGeneration: state.connectionGeneration });
  });
}

export const CONNECTION_KEY_NAMES = Object.freeze({ ACTIVE_KEY_NAME, PENDING_KEY_NAME });
