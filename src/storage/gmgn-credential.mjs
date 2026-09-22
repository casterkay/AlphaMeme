import { decryptSecret, encryptSecret, SecretError } from '../util/crypto.mjs';
import { normalizeGmgnApiKey } from '../gmgn-api-key.mjs';
import { normalizeTenantId } from './gmgn-admission-state.mjs';

const CREDENTIAL_NAME = 'gmgn-api-key';
const ENVELOPE_VERSION = 1;
const NONCE_BYTES = 12;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export class GmgnCredentialError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GmgnCredentialError';
    this.code = code;
  }
}

function bytesToBase64url(value) {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64urlToBytes(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new GmgnCredentialError('GMGN_CREDENTIAL_CORRUPT', 'GMGN credential ciphertext is corrupt');
  }
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
    return Uint8Array.from(atob(padded), byte => byte.charCodeAt(0));
  } catch {
    throw new GmgnCredentialError('GMGN_CREDENTIAL_CORRUPT', 'GMGN credential ciphertext is corrupt');
  }
}

function requireMasterKey(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new GmgnCredentialError('GMGN_CREDENTIAL_MASTER_KEY_MISSING', 'GMGN credential master key is unavailable');
  }
  return value;
}

function credentialField(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value)) {
    throw new GmgnCredentialError('GMGN_CREDENTIAL_FIELD_INVALID', 'GMGN credential field is invalid');
  }
  return value;
}

function associatedData(tenantId, field) {
  const credentialName = credentialField(field);

  // Keep the established active-record binding readable; pending credentials
  // use a distinct field-bound namespace and therefore cannot be substituted.
  return encoder.encode(credentialName === CREDENTIAL_NAME
    ? `meme-radar:gmgn-api-key:v${ENVELOPE_VERSION}:${tenantId}`
    : `meme-radar:gmgn-credential:v${ENVELOPE_VERSION}:${credentialName}:${tenantId}`);
}

async function encryptionKey(masterKey) {
  const material = await crypto.subtle.digest('SHA-256', encoder.encode(`meme-radar:gmgn-credential-key:v${ENVELOPE_VERSION}:${requireMasterKey(masterKey)}`));
  return crypto.subtle.importKey('raw', material, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function parseEnvelope(value) {
  try {
    const envelope = JSON.parse(value);
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
      || envelope.v !== ENVELOPE_VERSION || Object.keys(envelope).length !== 3
      || !(typeof envelope.n === 'string') || !(typeof envelope.c === 'string')) {
      throw new Error('invalid envelope');
    }
    const nonce = base64urlToBytes(envelope.n);
    const ciphertext = base64urlToBytes(envelope.c);
    if (nonce.byteLength !== NONCE_BYTES || ciphertext.byteLength < 17) throw new Error('invalid envelope lengths');
    return { nonce, ciphertext };
  } catch (error) {
    if (error instanceof GmgnCredentialError) throw error;
    throw new GmgnCredentialError('GMGN_CREDENTIAL_CORRUPT', 'GMGN credential ciphertext is corrupt');
  }
}

function credentialRow(storage, tenantId) {
  const rows = storage.sql.exec(
    'SELECT value_enc FROM keys WHERE tenant_id = ? AND name = ?', tenantId, CREDENTIAL_NAME
  ).toArray();
  if (rows.length > 1) throw new GmgnCredentialError('GMGN_CREDENTIAL_CORRUPT', 'GMGN credential has duplicate records');
  return rows[0] || null;
}

export async function encryptGmgnApiKey(masterKey, tenant, value, { field = CREDENTIAL_NAME } = {}) {
  const tenantId = normalizeTenantId(tenant);
  const apiKey = normalizeGmgnApiKey(value);
  if (!apiKey) throw new GmgnCredentialError('GMGN_CREDENTIAL_INVALID', 'GMGN API key is invalid');
  if (typeof masterKey === 'object' && masterKey !== null) {
    return encryptSecret(masterKey, tenantId, credentialField(field), apiKey);
  }
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: associatedData(tenantId, field), tagLength: 128 },
    await encryptionKey(masterKey),
    encoder.encode(apiKey)
  );
  return JSON.stringify({ v: ENVELOPE_VERSION, n: bytesToBase64url(nonce), c: bytesToBase64url(new Uint8Array(ciphertext)) });
}

export async function decryptGmgnApiKey(masterKey, tenant, valueEnc, { field = CREDENTIAL_NAME } = {}) {
  const tenantId = normalizeTenantId(tenant);
  if (typeof valueEnc !== 'string') throw new GmgnCredentialError('GMGN_CREDENTIAL_CORRUPT', 'GMGN credential ciphertext is corrupt');
  let version;
  try { version = JSON.parse(valueEnc)?.v; } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new GmgnCredentialError('GMGN_CREDENTIAL_CORRUPT', 'GMGN credential ciphertext is corrupt');
  }
  if (version === 2) {
    let value;
    try { value = await decryptSecret(masterKey, tenantId, credentialField(field), valueEnc); } catch (error) {
      if (!(error instanceof SecretError)) throw error;
      throw new GmgnCredentialError('GMGN_CREDENTIAL_DECRYPT_FAILED', 'GMGN credential could not be decrypted');
    }
    const apiKey = normalizeGmgnApiKey(value);
    if (!apiKey) throw new GmgnCredentialError('GMGN_CREDENTIAL_CORRUPT', 'GMGN credential plaintext is invalid');
    return apiKey;
  }
  const legacyMasterKey = typeof masterKey === 'object' && masterKey !== null ? masterKey.keys?.['1'] : masterKey;
  const { nonce, ciphertext } = parseEnvelope(valueEnc);
  let plaintext;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: associatedData(tenantId, field), tagLength: 128 },
      await encryptionKey(legacyMasterKey),
      ciphertext
    );
  } catch (error) {
    if (error instanceof GmgnCredentialError) throw error;
    throw new GmgnCredentialError('GMGN_CREDENTIAL_DECRYPT_FAILED', 'GMGN credential could not be decrypted');
  }
  const apiKey = normalizeGmgnApiKey(decoder.decode(plaintext));
  if (!apiKey) throw new GmgnCredentialError('GMGN_CREDENTIAL_CORRUPT', 'GMGN credential plaintext is invalid');
  return apiKey;
}

export async function readGmgnApiKey(storage, masterKey, tenant) {
  if (!storage?.sql) throw new GmgnCredentialError('GMGN_CREDENTIAL_STORAGE_INVALID', 'GMGN credential storage is unavailable');
  const tenantId = normalizeTenantId(tenant);
  const row = credentialRow(storage, tenantId);
  if (!row) throw new GmgnCredentialError('GMGN_CREDENTIAL_MISSING', 'GMGN credential is not configured');
  return decryptGmgnApiKey(masterKey, tenantId, row.value_enc);
}

export const GMGN_CREDENTIAL_PROTOCOL = Object.freeze({ name: CREDENTIAL_NAME, version: ENVELOPE_VERSION });
