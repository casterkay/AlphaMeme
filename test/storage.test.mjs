import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicJson, readJsonWithBackup } from '../src/storage/store.mjs';
import { RadarControls, tokenKey } from '../src/storage/controls.mjs';

const temporaryDirectory = testContext => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meme-radar-storage-test-'));
  testContext.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
};

const evmAddress = number => `0x${number.toString(16).padStart(40, '0')}`;

test('the store keeps the last readable state as a backup', testContext => {
  const file = path.join(temporaryDirectory(testContext), 'state.json');
  atomicJson(file, { generation: 1 });
  atomicJson(file, { generation: 2 });
  fs.writeFileSync(file, 'not json');
  assert.deepEqual(readJsonWithBackup(file, {}), { value: { generation: 1 }, recovered: true });
});

test('controls validate supported chains and preserve note and favorite bounds', testContext => {
  const controls = new RadarControls(temporaryDirectory(testContext), ['bsc', 'sol'], 'bsc');
  assert.throws(() => controls.setChains(['eth']), { message: 'invalid_selection' });
  assert.throws(() => controls.annotate({ chain: 'bsc', address: evmAddress(1), favorite: false, note: 'x'.repeat(501) }), { message: 'invalid_annotation' });
  for (let number = 1; number <= 50; number++) {
    controls.annotate({ chain: 'bsc', address: evmAddress(number), favorite: true, note: '' });
  }
  assert.throws(() => controls.annotate({ chain: 'bsc', address: evmAddress(51), favorite: true, note: '' }), { message: 'favorite_limit' });
  assert.equal(tokenKey('sol', 'So11111111111111111111111111111111111111112'), 'sol:So11111111111111111111111111111111111111112');
});
