import assert from 'node:assert/strict';
import test from 'node:test';
import { encryptSecret, decryptSecret } from '../src/util/crypto.mjs';
import { encryptGmgnApiKey, decryptGmgnApiKey } from '../src/storage/gmgn-credential.mjs';

const old = { activeVersion: '1', keys: { '1': 'old-material' } };
const rotated = { activeVersion: '2', keys: { '1': 'old-material', '2': 'new-material' } };

test('master rotation reads both versions while writing only the new version', async () => {
  const previous = await encryptSecret(old, '21', 'telegram-inbox:123', 'secret');
  const current = await encryptSecret(rotated, '21', 'telegram-inbox:123', 'secret');
  assert.equal(JSON.parse(current).keyVersion, '2');
  assert.equal(await decryptSecret(rotated, '21', 'telegram-inbox:123', previous), 'secret');
  assert.equal(await decryptSecret(rotated, '21', 'telegram-inbox:123', current), 'secret');
  assert.notEqual(current, await encryptSecret(rotated, '21', 'telegram-inbox:123', 'secret'));
  await assert.rejects(decryptSecret(old, '21', 'telegram-inbox:123', current));
});

test('AEAD rejects tenant, field, version substitution and retired key material', async () => {
  const encrypted = await encryptSecret(old, '21', 'signing', 'secret');
  await assert.rejects(decryptSecret(rotated, '22', 'signing', encrypted));
  await assert.rejects(decryptSecret(rotated, '21', 'other', encrypted));
  await assert.rejects(decryptSecret(rotated, '21', 'signing', JSON.stringify({ ...JSON.parse(encrypted), keyVersion: '2' })));
  await assert.rejects(decryptSecret({ activeVersion: '2', keys: { '2': 'new-material' } }, '21', 'signing', encrypted));
});

test('rotation retains explicit version-one legacy API decryption and current API reader support', async () => {
  const apiKey = `gmgn_${'a'.repeat(32)}`;
  const legacy = await encryptGmgnApiKey('old-material', '21', apiKey);
  assert.equal(await decryptGmgnApiKey(rotated, '21', legacy), apiKey);
  const current = await encryptSecret(rotated, '21', 'gmgn-api-key', apiKey);
  assert.equal(await decryptGmgnApiKey(rotated, '21', current), apiKey);
});
