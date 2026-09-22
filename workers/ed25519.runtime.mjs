import { expect, it } from 'vitest';
import { runEd25519Spike } from './fixtures/ed25519-spike.mjs';

it('round-trips Ed25519 PEM keys in Workers and rejects tampered signatures and private re-export', async () => {
  expect(await runEd25519Spike()).toEqual({
    algorithm: 'Ed25519',
    publicPemRoundTrip: true,
    publicDerBytes: 44,
    privateDerBytes: 48,
    signatureBytes: 64,
    validSignature: true,
    originalPublicKeyAcceptsSignature: true,
    alteredMessageRejected: true,
    alteredSignatureRejected: true,
    wrongKeyRejected: true,
    privateExportRejected: true
  });
});
