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

## Data migration

All state lives in the tenant's `RadarAgent` database (including the encrypted
AVE key and trading wallet in `keys`) and the registry's. Ciphertext is bound
to tenant id, field and key version, not to Cloudflare, so it moves as-is with
the same `MASTER_ENC_KEY`.

The two hosts must never act at once: both would scan, alert, deliver and
possibly trade. So the old host stops completely before the final export, and
the new one starts only after it:

0. **Probe** (before any migration work is committed): from the chosen VPS, run
   the production request pattern for about 30 minutes: Arc `eth_blockNumber`
   + `eth_getLogs` every 15 s, DexScreener batch and pair reads at the radar's
   rate, GoPlus with the app key. Proceed only if the 429s are gone.
1. **Quiesce, then freeze Cloudflare**: pause scanning, place no trades, and
   wait until the outbox has no unconfirmed rows and no trade is submitted but
   unsettled. Then deploy the version with `RUNTIME_DISABLED=1` and no cron. It
   refuses webhook updates (Telegram keeps them for 24 hours), and makes
   `alarm()` and `wake()` no-ops, so no scan, command, outbox delivery or trade
   step runs.
2. **Check idle**: with the export route (read-only, step 3), confirm there is
   still no in-flight effect. If one slipped in, reconcile it by hand before
   continuing: a delivery whose outcome is unknown is flagged, not resent
   blindly; a submitted trade is settled from its transaction receipt on chain.
3. **Final export**, taken after the drain: a temporary operator-only route (operator token) returns
   every table's rows from both objects, their key-value entries and pending
   alarm time, as JSON. The file holds ciphertext, not plaintext, and is
   deleted after import.
4. **Import and verify** into the three VPS databases: row counts per table,
   schema checks, a first backup.
5. **Activate the VPS**: start the process (it deletes the webhook, then polls
   and picks up the updates Telegram held).

Commands for steps 1–4 (`$WORKER` is the Worker URL, `$TENANT` the tenant id):

```sh
# 1. In the bot: pause scanning, place no trades. Repeat until "idle": true.
curl -sS -H "authorization: Bearer $OPERATOR_TOKEN" "$WORKER/export?tenant_id=$TENANT" | jq .idle
# Freeze: deploy with "RUNTIME_DISABLED": "1" and "crons": [] in wrangler.jsonc, then revert the edit.
npx wrangler deploy && git checkout wrangler.jsonc
# Optional: remove the webhook now (pending updates kept), so held updates wait
# for getUpdates under Telegram's documented 24 hours instead of webhook retries.
curl -sS "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/deleteWebhook"
# 2–3. Export once more; its "idle" must still be true, else reconcile first.
curl -sS -H "authorization: Bearer $OPERATOR_TOKEN" "$WORKER/export?tenant_id=$TENANT" -o export.json
jq .idle export.json
# 4. On the VPS, into the empty data directory; prints row counts per table.
node scripts/import-export.mjs export.json /path/to/data && rm export.json
```

An alarm that comes due while disabled is consumed without running, so the
export may show none; the VPS host's first wake re-arms it from scheduler
state. `host.sqlite` holds `entries (object, key, value_json)` and
`alarms (object, at)`, with `object` `radar` or `registry`
(`scripts/import-export.mjs`).

The Cloudflare data stays untouched as a pre-migration snapshot. It is not a
rollback: once the VPS acts, that snapshot lacks every later command, delivery
and trade.

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
2. **Export and disable switch** on the Cloudflare side, with tests.
3. **Cutover** (operations, no code): steps 1–5 above, then confirm in
   production that the Arc and DexScreener 429s are gone.
4. **Cleanup** once the VPS has run cleanly for a while: drop the
   `cloudflare:workers` hook and `extends DurableObject`, the webhook route,
   `wrangler.jsonc` and the workerd test suite (porting any test that still
   guards behaviour rather than Cloudflare glue).

## Decisions needed

- VPS provider and region (any small instance works: 1 vCPU, 1–2 GB RAM).
- Whether to keep the Cloudflare data after cleanup or delete the Worker.
