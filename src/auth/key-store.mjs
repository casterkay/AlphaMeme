import { encryptSecret, decryptSecret } from '../util/crypto.mjs';
import { normalizeTenantId } from '../storage/gmgn-admission-state.mjs';
import { beginCredentialVerificationInTransaction, SqliteControlStateStore } from '../storage/control-state.mjs';

export class SigningKeyError extends Error {
  constructor(code) { super(code); this.name = 'SigningKeyError'; this.code = code; }
}

export const SIGNING_KEY_NAMES = Object.freeze({ pending: 'gmgn-pending-signing-key', active: 'gmgn-signing-key' });

export function signingRow(storage, tenantId, name = SIGNING_KEY_NAMES.pending) {
  return storage.sql.exec('SELECT value_enc, generation FROM keys WHERE tenant_id = ? AND name = ?', tenantId, name).toArray()[0] || null;
}

export function saveKey(storage, tenantId, name, envelope, generation, now) {
  storage.sql.exec('INSERT INTO keys (tenant_id, name, value_enc, generation, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(tenant_id, name) DO UPDATE SET value_enc = excluded.value_enc, generation = excluded.generation, created_at = excluded.created_at', tenantId, name, envelope, generation, now);
}

function pem(der, label) {
  return `-----BEGIN ${label}-----\n${btoa(String.fromCharCode(...new Uint8Array(der))).match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
}

export async function decryptSigningKey(masterKey, tenantId, row, name) {
  const value = JSON.parse(await decryptSecret(masterKey, tenantId, name, row.value_enc));
  if (typeof value.publicKey !== 'string' || typeof value.privateKey !== 'string') throw new SigningKeyError('SIGNING_KEY_CORRUPT');
  return value;
}

async function prepareSigningKey({ storage, masterKey, tenantId: tenant, now = Date.now, expectedGeneration, expectedConnectionGeneration }, regenerate) {
  const tenantId = normalizeTenantId(tenant);
  const connection = new SqliteControlStateStore(storage, tenantId).snapshot().connectionGeneration;
  const existing = signingRow(storage, tenantId);
  if (!regenerate && existing) {
    const value = await decryptSigningKey(masterKey, tenantId, existing, SIGNING_KEY_NAMES.pending);
    if (signingRow(storage, tenantId)?.value_enc !== existing.value_enc) throw new SigningKeyError('SIGNING_GENERATION_STALE');
    return Object.freeze({ publicKey: value.publicKey, generation: existing.generation, connectionGeneration: connection });
  }
  if (regenerate && (!existing || existing.generation !== expectedGeneration || connection !== expectedConnectionGeneration)) throw new SigningKeyError('SIGNING_GENERATION_STALE');
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const value = {
    publicKey: pem(await crypto.subtle.exportKey('spki', pair.publicKey), 'PUBLIC KEY'),
    privateKey: pem(await crypto.subtle.exportKey('pkcs8', pair.privateKey), 'PRIVATE KEY')
  };
  const envelope = await encryptSecret(masterKey, tenantId, SIGNING_KEY_NAMES.pending, JSON.stringify(value));
  return storage.transactionSync(() => {
    const current = signingRow(storage, tenantId);
    if ((current?.value_enc ?? null) !== (existing?.value_enc ?? null)) throw new SigningKeyError('SIGNING_GENERATION_STALE');
    const state = beginCredentialVerificationInTransaction(storage, tenantId, connection);
    saveKey(storage, tenantId, SIGNING_KEY_NAMES.pending, envelope, state.connectionGeneration, now());
    const candidate = signingRow(storage, tenantId, 'gmgn-pending-api-key');
    if (candidate) storage.sql.exec("UPDATE inbox SET status = 'CANCELLED', payload_enc = NULL, next_at = NULL WHERE tenant_id = ? AND generation = ? AND status IN ('RECEIVED', 'RUNNING') AND command_type IN ('setkey', 'command:setkey', 'credential_verify')", tenantId, candidate.generation);
    storage.sql.exec('DELETE FROM keys WHERE tenant_id = ? AND name = ?', tenantId, 'gmgn-pending-api-key');
    return Object.freeze({ publicKey: value.publicKey, generation: state.connectionGeneration, connectionGeneration: state.connectionGeneration });
  });
}

export const ensurePendingSigningKey = options => prepareSigningKey(options, false);
export const regeneratePendingSigningKey = options => prepareSigningKey(options, true);

/** Public-only projection used by Telegram panels; never exposes private material. */
export async function signingSetupSnapshot({ storage, masterKey, tenantId: tenant }) {
  const tenantId = normalizeTenantId(tenant);
  const pending = signingRow(storage, tenantId);
  const name = pending ? SIGNING_KEY_NAMES.pending : SIGNING_KEY_NAMES.active;
  const row = pending || signingRow(storage, tenantId, name);
  if (!row) return null;
  const value = await decryptSigningKey(masterKey, tenantId, row, name);
  if (signingRow(storage, tenantId, name)?.value_enc !== row.value_enc) throw new SigningKeyError('SIGNING_GENERATION_STALE');
  return Object.freeze({ publicKey: value.publicKey, generation: row.generation, pending: Boolean(pending),
    connectionGeneration: new SqliteControlStateStore(storage, tenantId).snapshot().connectionGeneration });
}
