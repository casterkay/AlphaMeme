import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';

// Vitest requires Node compatibility internally; this separate isolate proves
// native WebCrypto works with the production Worker's empty compatibility flags.
const compatibilityDate = '2026-09-20';
const compatibilityFlags = [];
const runtime = new Miniflare({ workers: [{ config: {
  name: 'ed25519-spike',
  type: 'worker',
  compatibilityDate,
  compatibilityFlags,
  manifest: {
    mainModule: 'spike.mjs',
    modules: {
      'spike.mjs': {
        type: 'esm',
        contents: await readFile(new URL('../../workers/fixtures/ed25519-spike.mjs', import.meta.url), 'utf8')
      }
    }
  }
} }] });
try {
  const response = await runtime.dispatchFetch('https://ed25519.test/');
  assert.equal(response.status, 200);
  const evidence = await response.json();
  assert.equal(evidence.algorithm, 'Ed25519');
  assert.equal(evidence.signatureBytes, 64);
  for (const field of ['publicPemRoundTrip', 'validSignature', 'originalPublicKeyAcceptsSignature',
    'alteredMessageRejected', 'alteredSignatureRejected', 'wrongKeyRejected', 'privateExportRejected']) {
    assert.equal(evidence[field], true, field);
  }
  console.log(JSON.stringify({ compatibilityDate, compatibilityFlags, ...evidence }, null, 2));
} finally {
  await runtime.dispose();
}
