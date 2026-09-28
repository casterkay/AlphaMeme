# Telegram credential boundary

The entry points in `auth/connection.mjs` are `prepareOnboardingVerification`,
`verifyAndActivateOnboardingCredential`, `failOnboardingVerification` and
`readAveApiKey`. An AVE Data API key is the only credential; there is no signing
key and no environment fallback.

1. `/setkey <key>` is diverted before any command parsing. Intake encrypts the
   normalized submission with
   `encryptSecret(masterKey, tenantId, 'telegram-inbox:' + updateId, apiKey)` and
   sets a 15-minute expiration from the durable receipt time. The original
   Telegram message is deleted independently; a key is never echoed or put in
   JSON payloads.
2. Preparation requires an active inbox row (`RECEIVED` or `RUNNING`) and the key
   from that encrypted receipt. It stores the candidate as `ave-pending-api-key`
   and schedules one verification task (a 5-credit details read). The candidate
   spends its own allowance: its read waits only for request spacing, ignores
   the active key's cooldowns and budget, and its answer is never recorded into
   the active key's admission state. Duplicate preparation reuses the current
   verification generation.
3. Verification calls `verify(apiKey, { signal, timeoutMs })` only through the
   supplied admission `request` capability; it reads AVE token details for WBNB
   on BSC. Before and after that read, the command's expiry and status and the
   connection generation are checked again. `afterActivate` must synchronously
   finish the inbox and write its response intent in the same SQLite transaction;
   a thrown exception rolls back all key and epoch changes.
4. Permanent failures (`AVE_AUTH`, `AVE_QUOTA`, schema or size errors) and expiry
   call `failOnboardingVerification` with the command's own connection
   generation; this scrubs only its candidate. Rate limits, timeouts and network
   errors retry. A failed replacement keeps the old active key. Activation
   preserves pause state and does not enable alerts.
5. Activation stores the key as `ave-api-key` and starts a new key epoch with
   its own allowance (credits used reset to 0, cooldowns cleared); scan reads
   use that key, and admission and checkpoints still enforce key epochs.
   `/disconnect` also clears cooldowns, which belong to the dropped key.

Secret envelopes bind tenant, field, format version and master-key version using
AES-GCM AAD with a random 96-bit nonce. `MASTER_ENC_KEY` is a nonempty string
(version `1`) or a JSON keyring
`{ "activeVersion": "2", "keys": { "1": old, "2": current } }`. Application
configuration parses a JSON keyring before passing it; helper functions never
read environment variables. To rotate, add the new version as active, re-enter
keys with `/setkey` (or re-encrypt records with the current version), verify, then
retire old material. An absent version or authentication failure fails closed.
Never log the keyring.

The caller owns expired inbox reconciliation, Telegram message deletion,
notification preferences and response delivery. These functions make no network
call outside the admission capability and never send Telegram messages.
