# Request-level live timing probe — issue #29 (partial evidence)

**Issue #29 remains open.** This probe demonstrates scheduling between individual
HTTP requests in local workerd. It does not establish deployed GMGN latency,
Durable Object alarm delivery latency, or invocation CPU time.

## Reproduction and scope

```sh
npm ci
node scripts/spikes/live-timing.mjs
```

The runner emits one JSON record per scenario. It uses the real `OneAlarmScheduler`
module inside workerd, a loopback HTTP server with controlled responses, actual
clock time, and actual fetch cancellation. There are no credentials or external
provider calls. Three scan reads represent three request-level checkpoints, not
one token-sized batch. The runner asserts that live runs between scan reads and
that all tasks terminate within 12 scheduler steps.

The local alarm adapter waits until the scheduler's requested alarm timestamp;
it is not Durable Object alarm delivery. The backing scheduler store is disposable
memory. These deliberate simplifications isolate request fairness, timeout, and
admission behavior; they do not prove crash recovery or real alarm performance.

Settings: compatibility date `2026-09-20`, no compatibility flags; default
scheduler request timeout 30,000 ms; default admission gap 1,100 ms; unit request
weight. A synthetic 429 uses a 2-second cooldown and doubles the admission
backoff, producing a 2,200 ms interval on following unit-weight requests. This
explicitly tests scheduler admission state, not the GMGN client's 429 parser.
The next live deadline is 10 ms after scenario start, placing it inside the first
scan read. The comparison target is 20,000 ms.

## Observed local measurements

Executed 2026-09-22 with Node 24.8.0, Miniflare 5.20260918.0-alpha,
workerd 1.20260918.1. Values below are measured milliseconds, not estimates.
CPU is unavailable because this local probe exposes no per-invocation CPU metric;
wall time must not be reported as CPU.

| Scenario | First scan request | Live request | Live lag | Scenario wall | CPU |
| --- | ---: | ---: | ---: | ---: | --- |
| Normal, 25 ms endpoint delay | 35 | 27 | 1,095 | 3,337 | Unavailable |
| Slow first read, scheduler timeout | 30,006 | 32 | 29,997 | 33,347 | Unavailable |
| First scan returns 429 | 30 | 30 | 2,024 | 8,672 | Unavailable |
| All three scan endpoints return 404 | 30 | 29 | 1,095 | 3,339 | Unavailable |

Exact live clock readings from that run (Unix milliseconds):

| Scenario | scheduledAt | startedAt | pollLagMs |
| --- | ---: | ---: | ---: |
| Normal | 1790087398295 | 1790087399390 | 1095 |
| Slow | 1790087401657 | 1790087431654 | 29997 |
| 429 | 1790087435012 | 1790087437036 | 2024 |
| Miss | 1790087443693 | 1790087444788 | 1095 |

Every scenario admitted live after the first scan attempt and before remaining
scan reads. The slow read emitted `SCHEDULER_REQUEST_TIMEOUT`; cancellation freed
the scheduler, and its retry ran after live. The 429 scenario respected the
cooldown and doubled admission interval instead of bypassing it for live. The
miss scenario yielded between all failed-source reads rather than combining
them into a token-sized step. Measured normal request-start gaps were
1,103 / 1,100 / 1,102 ms; post-cooldown gaps were 2,201 / 2,204 / 2,202 ms.

## Interpretation and remaining acceptance

The scheduler's outer 30-second ceiling can produce nearly 30 seconds of live
lag, exceeding the 20-second target. **This is not a production GMGN latency
measurement:** the current `GmgnClient` normally imposes its tighter 15-second
request timeout. This probe deliberately calls fetch directly to exercise the
scheduler's outer limit. It neither changes those timeouts nor concludes that
production's effective deadline is 30 seconds. Await time is visible in wall
latency even when CPU is not measured.

Before closing #29, choose an isolated deployed Worker and tenant, use an
explicitly supplied read-only GMGN test credential, and measure the actual
scheduler + provider + Durable Object alarm path. Capture the deployed revision,
effective timeout/weight/cooldown settings, all four scenarios, per-request
scheduled/start/end timestamps, and Cloudflare CPU/wall telemetry. Do not use this
probe's synthetic cooldown or host-process CPU as substitutes. If deployed live
lag violates the accepted 20-second boundary, return to design decision 4 with
the user before changing policy.

Read-only access check: the installed `wrangler whoami --json` reports one
standard Cloudflare account and OAuth permissions including Workers write and
tail read. No deployment, secret creation/read, account mutation, or provider
request was performed. Account access alone does not identify an approved
isolated target or supply a test credential.
