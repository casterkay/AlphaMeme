import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decryptGmgnApiKey,
  encryptGmgnApiKey,
  GmgnCredentialError,
  readGmgnApiKey
} from '../src/storage/gmgn-credential.mjs';

const MASTER_KEY = 'test-master-key-used-only-for-credential-unit-tests';
const API_KEY = `gmgn_${'a'.repeat(32)}`;

class MemoryCredentialStorage {
  constructor() {
    this.rows = new Map();
    this.sql = { exec: (query, ...bindings) => this.#exec(query, bindings) };
  }

  #exec(query, bindings) {
    if (query.startsWith('SELECT value_enc FROM keys')) {
      const row = this.rows.get(bindings.join('\u0000'));
      return { toArray: () => row ? [{ value_enc: row.valueEnc }] : [] };
    }
    throw new Error(`unexpected credential SQL: ${query}`);
  }
}

test('GMGN credentials use unique AES-GCM envelopes bound to their tenant', async () => {
  const first = await encryptGmgnApiKey(MASTER_KEY, '1001', API_KEY);
  const second = await encryptGmgnApiKey(MASTER_KEY, '1001', API_KEY);

  assert.notEqual(first, second);
  assert.equal(first.includes(API_KEY), false);
  assert.equal(await decryptGmgnApiKey(MASTER_KEY, '1001', first), API_KEY);
  await assert.rejects(() => decryptGmgnApiKey(MASTER_KEY, '1002', first), error =>
    error instanceof GmgnCredentialError && error.code === 'GMGN_CREDENTIAL_DECRYPT_FAILED');
});

test('GMGN credential envelopes cannot be substituted between active and pending fields', async () => {
  const active = await encryptGmgnApiKey(MASTER_KEY, '1001', API_KEY, { field: 'gmgn-api-key' });
  const pending = await encryptGmgnApiKey(MASTER_KEY, '1001', API_KEY, { field: 'gmgn-pending-api-key' });

  await assert.rejects(() => decryptGmgnApiKey(MASTER_KEY, '1001', active, { field: 'gmgn-pending-api-key' }), error =>
    error instanceof GmgnCredentialError && error.code === 'GMGN_CREDENTIAL_DECRYPT_FAILED');
  await assert.rejects(() => decryptGmgnApiKey(MASTER_KEY, '1001', pending, { field: 'gmgn-api-key' }), error =>
    error instanceof GmgnCredentialError && error.code === 'GMGN_CREDENTIAL_DECRYPT_FAILED');
});

test('GMGN credential reads fail closed for missing master material, records, and corruption', async () => {
  const storage = new MemoryCredentialStorage();
  await assert.rejects(() => encryptGmgnApiKey('', '1001', API_KEY), error =>
    error instanceof GmgnCredentialError && error.code === 'GMGN_CREDENTIAL_MASTER_KEY_MISSING');
  await assert.rejects(() => readGmgnApiKey(storage, MASTER_KEY, '1001'), error =>
    error instanceof GmgnCredentialError && error.code === 'GMGN_CREDENTIAL_MISSING');

  storage.rows.set('1001\u0000gmgn-api-key', { valueEnc: await encryptGmgnApiKey(MASTER_KEY, '1001', API_KEY) });
  const row = storage.rows.get('1001\u0000gmgn-api-key');
  assert.equal(row.valueEnc.includes(API_KEY), false);
  assert.equal(await readGmgnApiKey(storage, MASTER_KEY, '1001'), API_KEY);

  storage.rows.set('1001\u0000gmgn-api-key', { ...row, valueEnc: '{not-json' });
  await assert.rejects(() => readGmgnApiKey(storage, MASTER_KEY, '1001'), error =>
    error instanceof GmgnCredentialError && error.code === 'GMGN_CREDENTIAL_CORRUPT');
  const envelope = await encryptGmgnApiKey(MASTER_KEY, '1001', API_KEY);
  await assert.rejects(() => decryptGmgnApiKey('', '1001', envelope), error =>
    error instanceof GmgnCredentialError && error.code === 'GMGN_CREDENTIAL_MASTER_KEY_MISSING');
});
