# Workers Ed25519 evidence — issue #24

Native Workers WebCrypto supports the onboarding key lifecycle. **No
`nodejs_compat` flag or Node crypto fallback is needed in `wrangler.jsonc`.**

The old local key store uses `node:crypto`, so its successful execution did not
establish Workers compatibility. This spike tests native WebCrypto directly and
also runs a separate workerd isolate without compatibility flags: the Vitest
harness itself enables Node compatibility and is insufficient evidence for the
flag decision on its own.

## Reproduce

From the repository root after `npm ci`:

```sh
node scripts/spikes/ed25519.mjs
npm run test:workers -- workers/ed25519.runtime.mjs
```

The first command uses the Miniflare version supplied by the locked Workers tool
chain and the explicit empty flag list shown below. The Worker source is
`workers/fixtures/ed25519-spike.mjs`; the Node runner only hosts the isolate and
asserts its result. All generation, encoding, import, signing, and verification
run inside workerd. No credentials, key material, or signatures are logged.

## Observed output

Executed 2026-09-22 with Node 24.8.0, Miniflare 5.20260918.0-alpha,
workerd 1.20260918.1, and the repository compatibility date:

```json
{
  "compatibilityDate": "2026-09-20",
  "compatibilityFlags": [],
  "algorithm": "Ed25519",
  "publicPemRoundTrip": true,
  "publicDerBytes": 44,
  "privateDerBytes": 48,
  "signatureBytes": 64,
  "validSignature": true,
  "originalPublicKeyAcceptsSignature": true,
  "alteredMessageRejected": true,
  "alteredSignatureRejected": true,
  "wrongKeyRejected": true,
  "privateExportRejected": true
}
```

Vitest 4.1.11 with `@cloudflare/vitest-plugin` 1.1.13:

```text
Test Files  1 passed (1)
     Tests  1 passed (1)
```

## Implementation contract

- Generate with `crypto.subtle.generateKey({ name: 'Ed25519' }, true,
  ['sign', 'verify'])`. Initial extractability is necessary to export the private
  key for encrypted persistence.
- Export the public key as `spki`; base64-wrap its DER bytes with
  `BEGIN PUBLIC KEY` / `END PUBLIC KEY` and 64-character lines. Reimport with
  `importKey('spki', der, { name: 'Ed25519' }, true, ['verify'])`.
- Export the private key as `pkcs8`; the analogous PEM label is `PRIVATE KEY`.
  After loading/decrypting, import with `extractable: false` and `['sign']`.
  The spike verifies private re-export fails with `InvalidAccessError`.
- Sign message bytes with `sign({ name: 'Ed25519' }, privateKey, bytes)` and verify
  with `verify({ name: 'Ed25519' }, publicKey, signature, bytes)`. No separate
  hash option is passed. The 64-byte signature remains valid after both PEM
  round-trips and fails for altered messages, altered signatures, and other keys.
- The fixture PEM decoder accepts only its own generated test data; it is not an
  external-input parser or a production credential service.

This is local Workers runtime evidence, not a deployed Worker or GMGN integration
check. Credential encryption, secret-message handling, and remote public-key
registration belong to onboarding implementation and its tests. The pinned GMGN
read contract uses exist-auth and does not define request signing. No bundle
fallback or configuration change was necessary, so no fallback bundle-size
comparison is applicable.
