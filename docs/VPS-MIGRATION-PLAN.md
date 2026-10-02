# VPS migration plan

Status: proposed, 2026-10-02.

## Why

Every keyless upstream throttles Cloudflare's shared egress IPs: GMGN banned
them (#29, #51), GoPlus answered `4029` until we added an app key (#110), and
the Arc public RPC and DexScreener now answer HTTP 429 to every or most
requests, while the same code reads both fine from a residential IP. Our own
load is tiny (about 8 Arc and 16 DexScreener requests a minute), so the fix is
an egress IP of our own. A VPS gives one, plus long-lived connections (Arc
block subscriptions instead of 15 s polling) and no Workers CPU cap.

## Scope and non-goals

The service is single-tenant and stays that way for the foreseeable future.
Deferred on purpose: backups (Litestream later), rollback beyond keeping the
Cloudflare data untouched, organization-level hardening, multi-tenant scaling.
Not deferred, because they are cheap: no inbound ports except SSH (key-only),
secrets in a root-only env file.

## Design

### One process, the existing code

The bot runs as one Node 24 process. `RadarAgent` and `TenantRegistry` stay as
they are and are constructed once, with a host-provided `ctx` and `env`:

| Cloudflare facility | Used by | Node host |
|---|---|---|
| `ctx.storage.sql.exec(...).toArray()` / `.one()` | all stores (≈190 calls) | `node:sqlite` `DatabaseSync`, prepared statement per call; same SQL dialect, no query changes |
| `ctx.storage.transactionSync(fn)` | ≈40 call sites | `BEGIN IMMEDIATE` … `COMMIT` / `ROLLBACK` |
| `ctx.storage.get/put/delete` | registry watchdog cursor (3 calls) | a `kv` table |
| `ctx.storage.setAlarm/deleteAlarm`, `alarm()` | scheduler | persisted alarm time + one timer (below) |
| `ctx.blockConcurrencyWhile` | schema init | awaited before the process accepts work |
| `ctx.waitUntil` | callback answers | fire, catch and log |
| `env.RADAR` / `env.TENANT_REGISTRY` stubs | worker routes, registry | objects returning the single instances |
| cron `* * * * *` → `scheduledWake` | watchdog | `setInterval` every 60 s |
| `import { DurableObject } from 'cloudflare:workers'` | 2 classes | a module hook mapping it to a plain base class while both hosts coexist |

The node test suite already runs the domain code on exactly this kind of
`node:sqlite` adapter (`test/radar-agent.test.mjs`), so the storage layer is the
proven part. One database file, WAL mode, `synchronous=FULL`: writes are tiny
and fills/positions are audited facts.

### Concurrency: what Durable Objects guaranteed, and how it holds

- Storage calls are synchronous, so nothing interleaves inside a transaction,
  as today.
- Async methods interleave only at network awaits, as they already do inside a
  Durable Object (input gates do not cover `fetch`).
- Output gates (no network effect before the write is durable): a synchronous
  `COMMIT` with `synchronous=FULL` is durable before the next statement runs.
- At most one `alarm()` at a time: the alarm runner never re-enters; an alarm
  set while one runs is armed after it finishes.
- A failed `alarm()` is retried with backoff (2 s doubling, 6 tries, like
  Cloudflare's); the 60 s watchdog wake recovers anything beyond that.
- The alarm time is persisted, so a restart re-arms it and fires a past-due
  alarm immediately.

### Telegram: long polling instead of the webhook

`getUpdates` long polling needs no inbound HTTPS, so no domain, TLS or reverse
proxy. Each update goes through the same `parseTelegramUpdate` and
`receiveTelegramUpdate`/`receiveTelegramCredential` path as the webhook. The
offset advances only after the update is accepted, so a crash re-delivers, and
the inbox (keyed by `tenant_id, update_id`) drops the duplicate. Polling start
calls `deleteWebhook` (Telegram refuses `getUpdates` while a webhook is set).
`/health` and `/status` stay, bound to localhost (reach them over SSH).

### Deployment

Docker image (Node 24, `npm ci --omit=dev`), run with Docker Compose,
`restart: unless-stopped`, one volume holding the database. Secrets and vars
(the same names as today's Worker secrets and `wrangler.jsonc` vars) come from
an env file. Deploy = `git pull && docker compose up -d --build`. Logs are the
same structured JSON lines, read with `docker compose logs`.

## Data migration

All state lives in the tenant's `RadarAgent` SQLite database (including the
encrypted AVE key and trading wallet in `keys`) and the registry's. Ciphertext
is bound to tenant id, field and key version, not to Cloudflare, so it moves
as-is with the same `MASTER_ENC_KEY`.

1. Pause scanning in Telegram (the paused state migrates too).
2. Export: a temporary operator-only route (operator token) returns every
   table's rows from both objects, plus the pending alarm time, as JSON. The
   file holds ciphertext, not plaintext, but is still deleted after import.
3. Import into the VPS database, verify row counts per table, start the
   process (it deletes the webhook and begins polling), resume scanning.
4. Stop Cloudflare from acting: deploy a version with the cron removed and
   `RUNTIME_DISABLED=1`, which makes `alarm()` and `wake()` no-ops. The two
   hosts must never run at once: both would scan, alert and possibly trade.
   The Cloudflare data stays untouched as the fallback.

## Slices (one PR each)

1. **Node host**: `src/host/` (storage adapter, alarm runner, env and binding
   stubs, Telegram long polling, entry point), Dockerfile and Compose file.
   Tests: adapter contract, alarm persistence/no-overlap/retry/re-arm on boot,
   long-poll offset acknowledged only after acceptance, a full scan cycle on the
   Node host with stubbed upstreams. The Cloudflare deployment is unchanged.
2. **Export and disable switch** on the Cloudflare side, with tests.
3. **Cutover** (operations, no code): VPS setup, export/import, verification
   against production behaviour (the Arc and DexScreener 429s should be gone),
   disable Cloudflare.
4. **Cleanup** once the VPS has run cleanly for a while: drop the
   `cloudflare:workers` hook and `extends DurableObject`, the webhook route,
   `wrangler.jsonc` and the workerd test suite (porting any test that still
   guards behaviour rather than Cloudflare glue).

## Decisions needed

- VPS provider and region (any small instance works: 1 vCPU, 1–2 GB RAM).
- Whether to keep the Cloudflare data after cleanup or delete the Worker.
