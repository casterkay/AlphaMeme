# Telegram credential boundary

The production entry points in `auth/connection.mjs` are
`prepareOnboardingVerification` and `verifyAndActivateOnboardingCredential`.
The earlier API-only functions remain the M2 internal migration interface;
Telegram must use the registration-key-aware entry points.

1. `ensurePendingSigningKey` creates or reuses a public key.
   `signingSetupSnapshot` exposes only public material and generations.
   Regeneration requires both observed signing and connection generations.
2. Intake encrypts the normalized submission with
   `encryptSecret(masterKey, tenantId, 'telegram-inbox:' + updateId, apiKey)`.
   Use the durable receipt time to set a 15-minute expiration. Delete the original
   Telegram message independently; never echo a key or put it in JSON payloads.
3. Preparation requires an active inbox row (`RECEIVED` or `RUNNING`), signing
   generation, and API key obtained from that encrypted receipt. It schedules
   verification in the existing admission queue. Duplicate preparation reuses
   the current verification generation.
4. Verification invokes `verify(apiKey, { signal, timeoutMs })` only through the
   supplied admission `request` capability. The pinned GMGN read contract uses
   exist-auth (`X-APIKEY`, `client_id`, and `timestamp`) and does not define a
   request-signature header. After remote success, command expiry/status,
   connection and signing generations are checked again. `afterActivate` must
   synchronously finish the inbox and write its response intent in the same
   SQLite transaction. A thrown exception rolls back all key and epoch changes.
5. Permanent failures and expiry call `failOnboardingVerification` with the
   command's own connection generation; this scrubs only its candidate. Admission
   deferrals are not permanent failures. Failed replacement keeps the old active
   connection. Activation preserves pause state and does not enable live or alerts.
6. Activation retains the encrypted registration key pair together with its
   generation so disconnect and replacement remain atomic. Regular provider reads
   use the verified API key; provider/checkpoint admission still enforces key epochs.

Secret envelopes bind tenant, field, format version and master-key version using
AES-GCM AAD with a random 96-bit nonce. The helper accepts a legacy master string
(as version `1`) or `{ activeVersion: '2', keys: { '1': old, '2': current } }`.
Application configuration must parse a JSON keyring secret before passing the
object; helper functions never read environment variables. Keep version `1`
material while reading existing v1 API records. Reencrypt records with the current
key version, verify migration completeness, then retire old material. An absent
version or authentication failure fails closed. Never log the keyring.

The caller owns expired inbox reconciliation, Telegram message deletion,
notification preferences, and response delivery. These functions do not perform
network calls outside the admission capability and never send Telegram messages.
