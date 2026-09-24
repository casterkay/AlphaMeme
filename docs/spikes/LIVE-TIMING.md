# Request-level live timing probe — issue #29

**Issue #29 remains open.** A deployed Durable Object probe demonstrates that
request-level scheduling keeps live lag below 20 seconds for a provider timeout
and missing sources. The production 30-second rate-limit floor produces 29.023
seconds of live lag.

A rerun on 2026-09-24 captured the nominal path's real result. The provider
rejects the deployed Worker's reads with `RATE_LIMIT_BANNED` and names the egress
IP, not the credential and not the request rate, as the reason. The free plan's
allowance is enforced against that shared egress IP, every attempt renews the ban,
and a nominal sample therefore cannot be captured from Cloudflare Workers while
that address carries the ban. Whether the M4 live target is reachable from this
platform at all is the open question.

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
| Real GMGN nominal path | 128 ms observed | Unavailable | >180,000 ms | 25 ms observed | 8 ms max observed | No sample; egress IP banned |

CPU values are Cloudflare Tail `cpuTime` values summed across the four alarm
invocations in each completed scenario. Cloudflare reported only 940 ms
`wallTime` for the alarm that awaited the 15,000 ms timeout, so tail `wallTime`
does not represent end-to-end latency while an invocation is suspended. The
scenario clock and request timestamps are the latency evidence; tail telemetry
is the CPU evidence. The 2026-09-24 rerun reproduced the completed scenarios
within the same range: three missing sources 21 ms total / 11 ms max, the
15-second timeout 8 / 2 ms, and the controlled 429 9 / 5 ms, against 20 / 9,
10 / 3 and 17 / 7 ms on 2026-09-23.

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
so a future run attributes each observation instead of inferring it. The table
above predates those fields; the 2026-09-24 rerun below recorded them.

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

The 2026-09-23 run did not complete within 180 seconds and recorded
`GMGN_RATE_LIMITED` for its one real attempt. The 2026-09-24 rerun reproduced that
shape with the fields the first run lacked, and identified it: the provider
returned a rate-limit ban whose window outlasted the run. The 09-23 record kept
only `outcome` and `errorCode`, which cannot separate that from a refusal the
client makes from its own cooldown without issuing a request — the reason the
probe now records `networkAttempted`.

## Credential and egress evidence (2026-09-24)

Four runs on one day separate the credential from the platform. The local reads
came from a Node process on a residential address, the rejected reads from a
deployed probe Worker; all used the same credential from the repository's
`.dev.vars`, the same route and the same query. No rate limit was deliberately
provoked.

| Time (UTC) | Egress | Request | Result |
| --- | --- | --- | --- |
| 09:09 | local Node | four `marketRank` reads, sol and bsc | 200, `code:0`, no rate-limit header |
| 11:28:11.991 | probe Worker, `cf-ray …-KIX` | one `marketRank` read | 429 `RATE_LIMIT_BANNED`, reset 11:33:02 |
| 11:33:03.002 | probe Worker | live retry, one second after that reset | 429 again, new reset 11:37:47 (+285 s) |
| 11:34:52 | local Node | the same `marketRank` read | 200, `code:0`, no rate-limit header |

The credential is not the restricted party: the same key, route and query
returned 200 from the local address sixty seconds after the Worker was banned.
The ban follows the egress address, which `cf-ray` resolves to a Cloudflare
Workers address (KIX).

The successful envelope was `{"code":0,"data":{"code":0,"data":{"rank":[...]}}}`,
and no successful response carried `x-ratelimit-reset` or any other rate-limit
header, matching the M1 observation that GMGN returns none on success. The client
path also measured roughly 700 ms slower than a raw `fetch` for the same request;
that was not a controlled comparison — separate processes, two samples each — so
it stays an unexplained observation rather than a finding.

### The real 429, captured

Status 429, headers `x-ratelimit-reset: 1790249582`, `x-request-id`,
`cf-ray …-KIX`, and no `Retry-After`. Body:

```json
{"code":429,"error":"RATE_LIMIT_BANNED",
 "message":"IP is temporarily banned due to repeated rate limit violations",
 "reset_at":1790249582,"tier":"free",
 "upgrade_message":"已达到当前套餐的限频上限，点击 …/ai?chain=bsc&tab=paid_plans 升级套餐，获得更高速率限制",
 "upgrade_url":"https://gmgn.ai/ai?chain=bsc&tab=paid_plans"}
```

This matches the contract derived from the provider's own client: the reset lives
in the `x-ratelimit-reset` header, `error` carries the machine-readable class, and
`upgrade_url`/`upgrade_message` accompany a plan limit. The body `reset_at` also
arrives; the provider's client reads neither it nor `Retry-After`.

### Why the request rate is not the cause

The published schedule is `calls/sec = plan weight / API weight`. The free plan
weight is 5 and `Market Trending` — the `/v1/market/rank` route that both the live
poll and discovery use — is API weight 3, so the allowance is about 1.67 calls/sec.
The live poll issues one call per 20 seconds (0.05 calls/sec), and the run that was
banned made exactly **one** request. A ban for "repeated rate limit violations"
cannot be earned at that volume. The egress is a shared Cloudflare Workers address
and its previous request from this project was a day earlier, so those violations
belong to other traffic on the same address.

The repository's internal weight table also disagrees with the published one:
`trending` is charged 1 here against a published 3, and `trenches` 3 against a
published 2. That makes internal pacing more permissive on the route every live
poll uses, but it is not a factor in a ban earned by one request.

### What this blocks

The live path cannot read from Cloudflare Workers while the egress address carries
this ban, and waiting alone does not clear it: the retry at 11:33:03 was issued
exactly at the advertised reset and was immediately re-banned for another 285
seconds. A "wake at the reset and try again" policy therefore renews the ban
indefinitely. The probe Worker was deleted after this capture to stop that loop.

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
