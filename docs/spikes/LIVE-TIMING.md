# Request-level live timing probe — issue #29

**Issue #29 remains open.** A deployed Durable Object probe demonstrates that
request-level scheduling keeps live lag below 20 seconds for a provider timeout
and missing sources. The production 30-second rate-limit floor produces 29.023
seconds of live lag.

The nominal path produced no steady-state sample. Its recorded
`GMGN_RATE_LIMITED` results cannot be attributed from the fields the probe kept
at the time, a credential re-check on 2026-09-24 returned HTTP 200 for the same
endpoint, and the run's own duration points at a long provider reset rather than
repeated short throttling. Attributing that result and capturing a nominal
deployed sample are what remain.

## Deployed probe

The probe ran on Cloudflare Workers on 2026-09-23. It used Worker version
`fdcb64a3-4f88-448e-acfc-b053c0ac8625`, compatibility date `2026-09-20`, no
compatibility flags, a 30,000 ms scheduler request ceiling, the production
`GmgnClient` 15,000 ms timeout, and the production 1,100 ms admission gap.
Every scheduler step ran in a separate Durable Object alarm invocation.

The normal scenario used `GmgnClient.marketRank()` against the real GMGN API.
The other scenarios passed controlled responses through the same client:

- Slow read withheld the first response until the client's 15-second timeout.
- Rate limit returned one 429 envelope, then valid empty envelopes.
- All-source miss returned three 404 envelopes; live received a valid empty envelope.

The controlled 429 carries no `x-ratelimit-reset` header and no body `reset_at`,
so it exercises the 30-second floor rather than a provider-declared deadline.

The controlled cases prevent intentional provider errors while exercising the
deployed scheduler, Durable Object alarms, client timeout/error translation,
admission state, and cooldown policy. The temporary Worker was deleted after
capture. The credential and generated probe token were supplied as secrets,
never logged, and removed from local temporary storage.

| Scenario | First scan | Live lag | Scenario wall | Alarm lag max | CPU total / max | Result |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 15-second client timeout | 15,000 ms | 14,043 ms | 17,243 ms | 27 ms | 10 / 3 ms | Within target |
| Controlled 429 | 0 ms | 29,023 ms | 34,423 ms | 21 ms | 17 / 7 ms | Exceeds target |
| Three missing sources | 0 ms | 120 ms | 3,320 ms | 20 ms | 20 / 9 ms | Within target |
| Real GMGN nominal path | 128 ms observed | Unavailable | >180,000 ms | 25 ms observed | 8 ms max observed | No sample; result not attributable |

CPU values are Cloudflare Tail `cpuTime` values summed across the four alarm
invocations in each completed scenario. Cloudflare reported only 940 ms
`wallTime` for the alarm that awaited the 15,000 ms timeout, so tail `wallTime`
does not represent end-to-end latency while an invocation is suspended. The
scenario clock and request timestamps are the latency evidence; tail telemetry
is the CPU evidence.

Exact completed-scenario timestamps (Unix milliseconds):

| Scenario | scheduledAt | startedAt | pollLagMs | completedAt |
| --- | ---: | ---: | ---: | ---: |
| Slow | 1790170027692 | 1790170041735 | 14043 | 1790170043935 |
| 429 | 1790170051064 | 1790170080087 | 29023 | 1790170084487 |
| Miss | 1790170023439 | 1790170023559 | 120 | 1790170025759 |

The deployed probe is reproducible with
`workers/fixtures/deployed-live-timing-spike.mjs` and its dedicated Wrangler
configuration. That configuration contains only the probe Durable Object: it
has no application Durable Object bindings, cron trigger, Telegram token, or
production route.

Every recorded attempt now carries `networkAttempted`, `clientCooldownAt`,
`cooldownRemainingMs`, the response status and headers, and a bounded body prefix,
so a future run attributes each observation instead of inferring it. The
completed-scenario table above predates those fields.

## Root cause, attribution, and decision

The 429 result is deterministic policy behavior rather than alarm delay. GMGN
error translation floors rate-limit recovery at 30 seconds, the shared admission
state sets `nextAllowedAt`, and the scheduler correctly prevents every GMGN task,
including live, from bypassing that cooldown. With live scheduled one second
after the first scan, its measured lag is therefore about 29 seconds.

Reducing that lag requires an explicit policy choice. Allowing live to bypass a
provider cooldown would violate the single shared admission boundary and could
extend or renew the upstream rate limit. Reducing the cooldown floor would make
live faster only when GMGN permits an earlier retry. The current implementation
keeps the conservative shared cooldown and reports the missed 20-second target.

The real nominal path supplied no steady-state sample. The run did not complete
within 180 seconds, and every recorded attempt carried `GMGN_RATE_LIMITED`. Those
records cannot be attributed: the probe kept only `outcome` and `errorCode` at the
time, and the client produces that same code from its own persisted cooldown
without issuing a request, so the field alone does not prove that GMGN rejected
anything. The run's duration is the stronger clue. With the 30-second floor, one
live poll plus three scan sources complete in roughly 90 seconds, so a run still
incomplete at 180 seconds implies a longer reset than the floor — the range the
message-derived wait caps at five minutes. A reset deadline beyond five minutes is
now reported as `GMGN_RATE_LIMIT_BLOCKED` rather than as an ordinary rate limit,
so a rerun names that case instead of describing it as a restricted credential.

## Credential re-check (2026-09-24)

Run from a local Node process against the live API using the request shape the
probe used, with the credential from the repository's `.dev.vars`. Four requests
were issued; no rate limit was deliberately provoked.

| # | Request | Result | Latency | Rate-limit headers |
| ---: | --- | --- | ---: | --- |
| 1 | raw `fetch`, sol, `limit=1` | 200, `code:0`, rank rows | 611 ms | none |
| 2 | raw `fetch`, bsc, `limit=1`, `order_by=volume` | 200, `code:0`, rank rows | 556 ms | none |
| 3 | `GmgnClient.marketRank`, same as 2 | success, `metrics.rateLimits: 0` | 1,360 ms | not exposed |
| 4 | `GmgnClient.marketRank`, same as 2 | success, `metrics.rateLimits: 0` | 1,244 ms | not exposed |

The envelope was `{"code":0,"data":{"code":0,"data":{"rank":[...]}}}`, and no
response carried `x-ratelimit-reset` or any other rate-limit header, matching the
M1 observation that GMGN returns none on success.

What this establishes: this endpoint, this request shape and this credential are
not restricted now, and the production client path reports no rate limit for a
live response. What it does not establish: which credential the deployed probe
used, that credential's state on 2026-09-23, or the shape of a real 429, which
has still never been observed. Four requests in one process are evidence about
this credential at this time, not a steady-state sample.

The client path measured roughly 700 ms slower than a raw `fetch` for the same
request. That was not a controlled comparison — separate processes, two samples
each — so it is recorded as an unexplained local observation, not a finding.

## Local comparison

The earlier local workerd probe remains available through
`node scripts/spikes/live-timing.mjs`. It uses a loopback server and an in-memory
alarm adapter, so its values are comparison data only:

| Scenario | Live lag | Scenario wall |
| --- | ---: | ---: |
| Normal | 1,095 ms | 3,337 ms |
| 30-second scheduler timeout | 29,997 ms | 33,347 ms |
| Synthetic two-second 429 | 2,024 ms | 8,672 ms |
| All-source miss | 1,095 ms | 3,339 ms |

The deployed results supersede these local values for Durable Object alarm and
CPU conclusions.
