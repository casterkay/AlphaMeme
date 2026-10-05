# VPS migration plan

Status: proposed, 2026-10-02.

## Why

Every keyless upstream throttles Cloudflare's shared egress IPs: GMGN banned
them (#29, #51), GoPlus answered `4029` until we added an app key (#110), and
the Arc public RPC and DexScreener now answer HTTP 429 to every or most
requests, while the same code reads both fine from a residential IP. Our own
load is tiny (about 8 Arc and 16 DexScreener requests a minute), so the fix
should be an egress IP of our own. A VPS gives one, plus long-lived connections
(Arc block subscriptions instead of 15 s polling) and no Workers CPU cap.

The residential comparison does not prove a VPS address fares better: provider
ranges can be throttled too. Step 0 below probes the candidate VPS first.

## Scope and non-goals

The service is single-tenant and stays that way for the foreseeable future.
Deferred on purpose: continuous replication (Litestream later), automated
rollback, organization-level hardening, multi-tenant scaling. Not deferred,
because they are cheap: no inbound ports except SSH (key-only), secrets in a
root-only env file, a nightly off-box backup (below), and a copy of
`MASTER_ENC_KEY` kept outside the VPS (a password manager): without it a lost
disk makes the encrypted trading wallet, and its funds, unrecoverable.

## Design

### One process, the existing code

The bot runs as one Node 24 process. `RadarAgent` and `TenantRegistry` stay as
they are and are constructed once, with a host-provided `ctx` and `env`:

| Cloudflare facility | Used by | Node host |
|---|---|---|
| `ctx.storage.sql.exec(...).toArray()` / `.one()` | all stores (≈190 calls) | `node:sqlite` `DatabaseSync`, prepared statement per call; same SQL dialect, no query changes |
| `ctx.storage.transactionSync(fn)`, nestable | ≈40 call sites; `receiveCredential` nests `receive` | outermost call `BEGIN IMMEDIATE` … `COMMIT`/`ROLLBACK`; nested calls `SAVEPOINT` … `RELEASE`/`ROLLBACK TO` + `RELEASE`, so an inner failure undoes only its own writes and still propagates |
| `ctx.storage.get/put/delete` | registry watchdog cursor (3 calls) | host state database (below) |
| `ctx.storage.setAlarm/deleteAlarm`, `alarm()` | scheduler | alarm time in the host state database + one timer (below) |
| `ctx.blockConcurrencyWhile` | schema init | awaited before the process accepts work |
| `ctx.waitUntil` | callback answers | fire, catch and log |
| `env.RADAR` / `env.TENANT_REGISTRY` stubs | worker routes, registry | objects returning the single instances |
| cron `* * * * *` → `scheduledWake` | watchdog | `setInterval` every 60 s |
| `import { DurableObject } from 'cloudflare:workers'` | 2 classes | a module hook mapping it to a plain base class while both hosts coexist |

The node test suite already runs the domain code on this kind of `node:sqlite`
adapter (`test/radar-agent.test.mjs`), so the SQL is the proven part.

Three database files, because each schema initializer accepts only its exact
table set: `radar.sqlite` (the tenant's `RadarAgent`), `registry.sqlite`
(`TenantRegistry`), and `host.sqlite` for what Cloudflare kept outside our
tables (each object's key-value entries and alarm time, the Telegram polling
offset). All in WAL mode with `synchronous=FULL`: writes are tiny and
fills/positions are audited facts.

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
proxy, and adds no delay: Telegram answers the open request as soon as an
update arrives. Each update goes through the same `parseTelegramUpdate` and
`receiveTelegramUpdate`/`receiveTelegramCredential` path as the webhook.

Updates are handled in order, and each ends in one of three ways:

- **stored** (accepted into the inbox) or **declined** (the parser ignores it,
  or the owner check rejects it): done;
- **transient failure** (storage or an unexpected error): stop the batch.

The offset is confirmed through the last consecutively done update (Telegram
confirms an update when `getUpdates` is called with a higher offset), so a
declined update is never redelivered and a failed one is retried. A crash
re-delivers unconfirmed updates; the inbox (keyed by `tenant_id, update_id`)
drops the duplicates. Polling start calls `deleteWebhook` (Telegram refuses
`getUpdates` while a webhook is set).
`/health` and `/status` stay, bound to localhost (reach them over SSH).

### Deployment

Docker image (Node 24, `npm ci --omit=dev`), run with Docker Compose,
`restart: unless-stopped`, one volume holding the database. Secrets and vars
(the same names as today's Worker secrets and `wrangler.jsonc` vars) come from
an env file. Deploy = `git pull && docker compose up -d --build`. Logs are the
same structured JSON lines, read with `docker compose logs`.

### Backup

Nightly, a host cron job runs `scripts/backup.mjs` inside the container. It
writes a consistent snapshot of each database with `VACUUM INTO` (safe while the
process runs), checks each copy (`PRAGMA integrity_check`, the schema
initializer's table check, row counts), and keeps the last 14 verified sets in
`data/backups`. Off the VPS, the owner pulls the newest verified set to their
machine over SSH with `scripts/pull-backup.sh`. The snapshots hold ciphertext
only; `MASTER_ENC_KEY` is kept separately (above). Restore = stop the
container, put the three files back (removing any `-wal`/`-shm` files beside
them), start. The backup PR includes a test that restores a snapshot and boots
the host from it.

A restore loses whatever happened after the snapshot. Before resuming trading
on restored state, reconcile the wallet's balances and recent transactions
against the chain, since the chain, not the restored database, is the source of
truth for fills.

## Cutover: a fresh start

No state moves (owner decision, 2026-10-05). The VPS starts on empty databases,
and its first Telegram sender becomes the owner, as on Cloudflare; the owner
connects the AVE key again with `/setkey`. Outcomes, leads and settings start
over.

The two hosts must never act at once: both would scan, alert, deliver and
possibly trade. So Cloudflare is frozen before the VPS starts:

0. **Probe** (done 2026-10-05): from the VPS, the production request pattern
   (Arc RPC, DexScreener, GoPlus without the app key) ran without a 429.
1. **Freeze Cloudflare**: deploy with `RUNTIME_DISABLED=1` and no cron. It
   refuses webhook updates and makes `alarm()` and `wake()` no-ops, so no scan,
   command, outbox delivery or trade step runs.
2. **Start the VPS**: `docker compose up -d --build` on empty `./data`. It
   deletes the webhook and polls, picking up the updates Telegram held.
3. **Reconnect** in the bot: `/start`, then `/setkey`.

```sh
# 1. Freeze: deploy with "RUNTIME_DISABLED": "1" and "crons": [] in wrangler.jsonc, then revert the edit.
npx wrangler deploy && git checkout wrangler.jsonc
# 2. On the VPS.
cd ~/AlphaMeme && git pull && sudo docker compose up -d --build
```

The Cloudflare data stays untouched. It still holds the old encrypted AVE key
and any trading wallet under the same `MASTER_ENC_KEY`, so a wallet created
there is recoverable from it if one ever turns out to hold funds.

## Slices (one PR each)

0. **Probe** (a script, no product code): the step 0 request pattern, run from
   the candidate VPS.
1. **Node host**: `src/host/` (storage adapter with nested transactions, the
   three databases, alarm runner, env and binding stubs, Telegram long polling,
   entry point), Dockerfile and Compose file, `scripts/backup.mjs`. Tests:
   adapter contract including nested commit and rollback, credential intake
   (`/setkey`) through the host, alarm persistence/no-overlap/retry/re-arm on
   boot, offset handling for stored, declined and failed updates, a full scan
   cycle with stubbed upstreams, backup then restore then boot. The Cloudflare
   deployment is unchanged.
2. **Disable switch** on the Cloudflare side, with tests.
3. **Cutover** (operations, no code): steps 1–3 above, then confirm in
   production that the Arc and DexScreener 429s are gone.
4. **Cleanup** once the VPS has run cleanly for a while: drop the
   `cloudflare:workers` hook and `extends DurableObject`, the webhook route,
   `wrangler.jsonc` and the workerd test suite (porting any test that still
   guards behaviour rather than Cloudflare glue).

## Decisions needed

- VPS provider and region (any small instance works: 1 vCPU, 1–2 GB RAM).
- Whether to keep the Cloudflare data after cleanup or delete the Worker.
