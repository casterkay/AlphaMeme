# AVE egress probe from Cloudflare Workers

**Status: egress and rate limit pass; CPU per alarm still to be read from the tail.** This decides whether the AVE migration
stays on Cloudflare Workers or falls back to the Fly.io host in #51.

GMGN banned the shared Workers egress IP (`docs/spikes/LIVE-TIMING.md`), so the
same failure must be ruled out for AVE before the provider is wired in. The
target is one chain, Arc, polled every 15 seconds on the AVE free plan.

## Questions and pass criteria

| Question | Pass |
| --- | --- |
| Does AVE answer reads from Workers egress? | Trending reads are `ok` (HTTP 200, body `status` 1, a token list) and the run ends `complete` |
| Does a 15-second cadence stay under AVE's rate limit? | No 429 across the full run |
| Is a second endpoint class treated the same? | The one token-details read is `ok` |
| Does one read-and-parse alarm fit the Workers Free CPU limit? | Tail `cpuTime` per alarm is well under 10 ms |

An isolated timeout or 5xx between successful reads is noted but is not a
failed verdict; any refusal, or a run stopped by three failures in a row, is.
A 401/403 whose body names the key is a credential problem; one that names the
address, a WAF or a block is an egress verdict. Record the body prefix either way.

## What the probe does

`workers/fixtures/ave-egress-probe.mjs` runs in one Durable Object per run. Each
alarm makes one `GET /v2/tokens/trending?chain=<chain>&current_page=0&page_size=100`
with the `X-API-KEY` header, reads at most 1 MiB, parses it, and records status,
latency, row count, `cf-ray`, and the egress address reported by `api.ipify.org`
(a separate connection, so it indicates the egress pool rather than proving the
AVE connection's source). After the first successful trending read it makes a
single `GET /v2/tokens/<token>-<chain>` read.

The first refusal ends the run: a 429, a 401/402/403, or an HTTP 200 whose body
is not a successful AVE envelope (`provider_error`). One refusal is the evidence,
and any further read could renew a ban. Its body prefix and any `Retry-After`,
`X-RateLimit-*` or `RateLimit-*` headers are kept. Other failures (5xx, timeouts,
network errors) delay the next read to 60 seconds and stop the run after three
in a row. A run also stops on completion or an operator stop, and an operator stop
that arrives while an alarm is waiting on AVE is kept.

Before reading, each alarm marks the run as reading. If an invocation dies after
that (for example on the CPU limit), Cloudflare retries the alarm within seconds;
the retry sees the mark and stops the run as `invocation_lost` instead of reading
again. Each sample is stored under its own key. The key is never logged and is
redacted from recorded bodies.

The default run is 120 trending reads at 15 seconds (30 minutes), about
**605 CU** of the free plan's 1,000,000.

## Run it

From the repository root after `npm ci`:

```sh
CONFIG=workers/fixtures/wrangler.ave-egress-probe.jsonc
npx wrangler deploy -c $CONFIG
PROBE_TOKEN=$(node -e 'console.log(crypto.randomUUID())')
printf %s "$PROBE_TOKEN" | npx wrangler secret put PROBE_TOKEN -c $CONFIG
npx wrangler secret put AVE_API_KEY -c $CONFIG   # paste your AVE Data API key

# In a second terminal, keep CPU evidence for the whole run:
npx wrangler tail -c workers/fixtures/wrangler.ave-egress-probe.jsonc --format json > ave-egress-tail.json

PROBE=https://meme-radar-ave-egress-probe.<your-subdomain>.workers.dev
RUN=$(node -e 'console.log(crypto.randomUUID())')
curl -X POST -H "Authorization: Bearer $PROBE_TOKEN" \
  -d '{"chain":"arc","samples":120,"intervalMs":15000}' "$PROBE/runs/$RUN/start"
```

Wait for the run to finish (about 30 minutes; `summary.stopReason` becomes
non-null). Do not paste the next block together with the one above: the run
would be stopped after its first read.

```sh
curl -H "Authorization: Bearer $PROBE_TOKEN" "$PROBE/runs/$RUN/result" > ave-egress-result.json

# Per invocation: kind, CPU ms, wall ms and outcome. Alarm rows are the reads.
node -e '
const text = require("fs").readFileSync("ave-egress-tail.json", "utf8");
for (const e of JSON.parse("[" + text.trim().replace(/\}\s*\{/g, "},{") + "]")) {
  const kind = e.event?.request ? e.event.request.method + " " + new URL(e.event.request.url).pathname
    : Object.keys(e.event ?? {}).join(",") || "alarm";
  console.log(e.executionModel, kind, "cpu=" + e.cpuTime, "wall=" + e.wallTime, e.outcome);
}'

npx wrangler delete -c $CONFIG   # afterwards
```

To end a run early: `curl -X POST -H "Authorization: Bearer $PROBE_TOKEN" "$PROBE/runs/$RUN/stop"`.

Options: `chain` is `bsc`, `eth`, `base`, `sol`, `robinhood` or `arc`;
`samples` 1–240; `intervalMs` 15,000–600,000. Each run id is single-use.

`chain` defaults to `arc`, the production chain. AVE's documentation lists only
`bsc`, `eth`, `base` and `solana`, and upstream dropped `arc` for lack of
evidence, but a deployed run on 2026-09-28 read Arc trending (100 rows, HTTP 200,
body `status` 1) and one Arc token-details read, both from Workers egress.

The result's `summary` gives the stop reason, the next scheduled alarm, outcome
counts, estimated CU, trending latency and alarm-delivery lag percentiles,
observed egress addresses and the first failure;
`samples` holds every read.

## Local verification

`node --test test/ave-egress-probe.test.mjs` covers authorization and routing,
option bounds and malformed start bodies, the healthy path, stopping on the first
429, in-body refusal, 401 or 402 with rate-limit headers kept, transient-failure
back-off and its reset, the body cap, a retried alarm after a lost invocation, an
operator stop during an in-flight alarm, credential redaction, timeouts and
transport failures. `wrangler dev` with this config ran one alarm end to end in
workerd with no compatibility flags; that sandbox cannot reach
`prod.ave-api.com`, so it produced no AVE evidence.

## Result

**2026-09-28, `bsc`, 120 samples at 15 s** (02:54–03:24 UTC, run started before
the default moved to `arc`):

- Stopped `complete`; 121 of 121 reads `ok` (120 trending with 100 rows each, one
  token details), no 429, no refusal, no rate-limit headers. About 605 CU.
- Trending latency p50 420 ms, p95 1,092 ms, max 1,174 ms. Latency is bimodal:
  62 reads under 500 ms, 58 over 900 ms. Bodies were 323–328 KB.
- Alarm delivery lag p50 1 ms, p95 2 ms, max 27 ms.
- Egress `2a06:98c0:3600::103` (Cloudflare Workers IPv6) on every read; all
  requests went through `SJC`.
- The top trending token did not change for the whole 30 minutes.
- No run stopped as `invocation_lost`, so no read was killed on the CPU limit.
  The per-invocation CPU times from the tail are still to be recorded.

**Arc, 3 samples, the same day:** trending returned HTTP 200, body `status` 1 and
100 rows (234 KB) in 961 ms, and one token-details read was `ok`, all from the
same egress address.

**Verdict:** AVE answers Workers egress and allows one trending read every 15
seconds, so the migration stays on Cloudflare Workers rather than Fly.io. The
account is on Workers Free, so the production alarm's CPU still has to fit the
10 ms limit; that needs the tail breakdown.
