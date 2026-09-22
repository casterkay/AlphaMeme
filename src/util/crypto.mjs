const encoder = new TextEncoder();

export async function sha256Bytes(input) {
  const bytes = typeof input === 'string' ? encoder.encode(input) : input;
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
}

export async function sha256Hex(input) {
  return Array.from(await sha256Bytes(input), byte => byte.toString(16).padStart(2, '0')).join('');
}

export class SecretError extends Error {
  constructor(code) { super(code); this.name = 'SecretError'; this.code = code; }
}

function keyring(masterKey) {
  if (typeof masterKey === 'string' && masterKey.length) return { activeVersion: '1', keys: { '1': masterKey } };
  if (!masterKey || typeof masterKey.activeVersion !== 'string' || !masterKey.keys
    || typeof masterKey.keys[masterKey.activeVersion] !== 'string' || !masterKey.keys[masterKey.activeVersion]) {
    throw new SecretError('SECRET_MASTER_KEY_INVALID');
  }
  return masterKey;
}

function binding(tenantId, field, version) {
  if (typeof tenantId !== 'string' || !/^[0-9]+$/.test(tenantId)
    || typeof field !== 'string' || !field || field.length > 128) throw new SecretError('SECRET_BINDING_INVALID');
  return encoder.encode(JSON.stringify(['meme-radar', 2, tenantId, field, version]));
}

function base64(bytes) { return btoa(String.fromCharCode(...bytes)); }
function unbase64(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new SecretError('SECRET_ENVELOPE_INVALID');
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}

async function secretKey(material) {
  if (typeof material !== 'string' || !material) throw new SecretError('SECRET_KEY_VERSION_UNAVAILABLE');
  return crypto.subtle.importKey('raw', await sha256Bytes(`meme-radar:secret:v2:${material}`), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** Encrypt UTF-8 text with tenant, field, envelope and master-key-version binding. */
export async function encryptSecret(masterKey, tenantId, field, plaintext) {
  if (typeof plaintext !== 'string' || !plaintext) throw new SecretError('SECRET_PLAINTEXT_INVALID');
  const ring = keyring(masterKey);
  const keyVersion = ring.activeVersion;
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce,
    additionalData: binding(tenantId, field, keyVersion) }, await secretKey(ring.keys[keyVersion]), encoder.encode(plaintext));
  return JSON.stringify({ v: 2, keyVersion, nonce: base64(nonce), ciphertext: base64(new Uint8Array(ciphertext)) });
}

/** Decryption fails closed if any bound field or key version differs. */
export async function decryptSecret(masterKey, tenantId, field, envelope) {
  const ring = keyring(masterKey);
  let value;
  try { value = JSON.parse(envelope); } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new SecretError('SECRET_ENVELOPE_INVALID');
  }
  if (!value || value.v !== 2 || typeof value.keyVersion !== 'string' || Object.keys(value).length !== 4) {
    throw new SecretError('SECRET_ENVELOPE_INVALID');
  }
  const nonce = unbase64(value.nonce);
  const ciphertext = unbase64(value.ciphertext);
  if (nonce.length !== 12 || ciphertext.length < 17) throw new SecretError('SECRET_ENVELOPE_INVALID');
  try {
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce,
      additionalData: binding(tenantId, field, value.keyVersion) }, await secretKey(ring.keys[value.keyVersion]), ciphertext);
    return new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
  } catch (error) {
    if (!(error instanceof DOMException) && !(error instanceof TypeError)) throw error;
    throw new SecretError('SECRET_DECRYPT_FAILED');
  }
}
