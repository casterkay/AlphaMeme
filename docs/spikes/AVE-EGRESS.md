# AVE egress probe from Cloudflare Workers

**Status: awaiting a deployed run.** This decides whether the AVE migration
stays on Cloudflare Workers or falls back to the Fly.io host in #51.

GMGN banned the shared Workers egress IP (`docs/spikes/LIVE-TIMING.md`), so the
same failure must be ruled out for AVE before the provider is wired in. The
target is one chain polled every 15 seconds on the AVE free plan.

## Questions and pass criteria

| Question | Pass |
| --- | --- |
| Does AVE answer reads from Workers egress? | Every trending read returns HTTP 200 with rows |
| Does a 15-second cadence stay under AVE's rate limit? | No 429 across the full run |
| Is a second endpoint class treated the same? | The one token-details read returns 200 |
| Does one read-and-parse alarm fit the Workers Free CPU limit? | Tail `cpuTime` per alarm is well under 10 ms |

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

It stops on completion, on any 401/402/403, or after three consecutive 429s; a
429 delays the next read to at least 60 seconds or the provider's `Retry-After`,
so a ban is observed, not renewed. The key is never logged and is redacted from
recorded bodies.

The default run is 120 trending reads at 15 seconds (30 minutes), about
**605 CU** of the free plan's 1,000,000.

## Run it

From the repository root after `npm ci`:

```sh
CONFIG=workers/fixtures/wrangler.ave-egress-probe.jsonc
npx wrangler deploy -c $CONFIG
npx wrangler secret put PROBE_TOKEN -c $CONFIG   # any random string
npx wrangler secret put AVE_API_KEY -c $CONFIG   # your AVE Data API key

# In a second terminal, keep CPU evidence for the whole run:
npx wrangler tail -c $CONFIG --format json > ave-egress-tail.json

PROBE=https://meme-radar-ave-egress-probe.<your-subdomain>.workers.dev
RUN=$(node -e 'console.log(crypto.randomUUID())')
curl -X POST -H "Authorization: Bearer $PROBE_TOKEN" \
  -d '{"chain":"bsc","samples":120,"intervalMs":15000}' "$PROBE/runs/$RUN/start"

# Any time; the run stops itself:
curl -H "Authorization: Bearer $PROBE_TOKEN" "$PROBE/runs/$RUN/result" > ave-egress-result.json
curl -X POST -H "Authorization: Bearer $PROBE_TOKEN" "$PROBE/runs/$RUN/stop"   # early stop

# Per-alarm CPU (ms):
grep -o '"cpuTime": *[0-9]*' ave-egress-tail.json | sort -t: -k2 -n | uniq -c

npx wrangler delete -c $CONFIG   # afterwards
```

Options: `chain` is `bsc`, `eth`, `base` or `sol`; `samples` 1–240;
`intervalMs` 15,000–600,000. Each run id is single-use.

The result's `summary` gives outcome counts, estimated CU, trending latency and
alarm-delivery lag percentiles, observed egress addresses and the first failure;
`samples` holds every read.

## Local verification

`node --test test/ave-egress-probe.test.mjs` covers authorization, option bounds,
the healthy path, 429 back-off and stop, credential redaction and transport
failures. `wrangler dev` with this config ran one alarm end to end in workerd with
no compatibility flags; that sandbox cannot reach `prod.ave-api.com`, so it
produced no AVE evidence.

## Result

_Fill in from `ave-egress-result.json` and the tail capture: Worker version,
date, chain, outcome counts, first failure body prefix, latency p50/p95, CPU per
alarm, and the verdict._
