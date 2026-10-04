# AVE websocket probe

**Status: decided (negative). The production AVE key is refused on
`wss://wss.ave-api.xyz`; no per-token data was observed. Arc's own RPC exposes
a working websocket today.** This decides whether AVE's websocket can replace
the 15-second REST cadence (`docs/spikes/AVE-EGRESS.md`) for per-token tracking
of leads and outcome sampling — it cannot, with the current key.

AVE's REST API gives this account one request per 15 s, and the hot list
(`/v2/tokens/trending`) uses that whole slot, so per-token price/tx/kline data
for leads and outcome sampling would have to come from AVE's websocket or
elsewhere. AVE documents `wss://wss.ave-api.xyz` with JSON-RPC
`subscribe`/`unsubscribe` over topics `price`, `tx`/`multi_tx`, `kline`/`multi_kline`,
`liq`, plus a `ping` heartbeat (`https://ave-cloud.gitbook.io/data-api/llms-full.txt`).

## Questions and findings

| Question | Finding |
| --- | --- |
| Does the key get websocket access at all? | **No.** The TCP/TLS/HTTP upgrade succeeds (`open` fires), but the first JSON-RPC command gets back `{"error":{"code":-1,"message":"Unauthorized"}}` and the server closes the socket, close code `1008`, reason `Unauthorized`. |
| Is the `X-API-KEY` header the right mechanism? | Yes — confirmed by contrast: omitting the header entirely gets a *different*, more specific refusal, `{"error":{"code":-1,"message":"Missing API Key"}}` (close 1008 "Missing API Key"), so the server does read the header; this key is read and rejected, not ignored. Passing the key as a query string (`?X-API-KEY=` or `?key=`) instead of a header gets no response at all, just an abnormal close (code 1006). |
| Is Arc supported on the websocket? | Unknown — moot. Every subscribe attempt (price, multi_tx, kline, on real Arc pairs/tokens) was rejected before any data could flow, for any chain. |
| Message rate / latency / payload fields for `price`, `multi_tx`, `kline` on Arc | Not observed — no subscription ever succeeded. |
| Does the connection cost CU or count against REST spacing? | Unknown. AVE's docs have no usage/credits endpoint distinct from the data-returning ones, so there is no CU-free way to check consumption. The websocket host (`wss.ave-api.xyz`) is infrastructurally separate from the REST host (`prod.ave-api.com`), so an open-then-refused WS connection is very unlikely to consume a REST request slot, but this is inference, not a confirmed read. |
| Subscription-count limits per connection | Unknown — no subscription ever got far enough to hit one. |
| Arc RPC websocket (`rpc.mainnet.arc.io`) | **Works.** `wss://rpc.mainnet.arc.io` (the same host as the configured `ARC_RPC_URL`, no separate path) accepts `eth_subscribe` immediately, no auth. |

## What the probe did

Two short Node 24 scripts under `.agents/scratch/ws-probe/` (deleted after this
spike; `ws@8.22.0` installed there only, for the custom `X-API-KEY` upgrade
header that the global `WebSocket` cannot send):

- **AVE probe**: opened `wss://wss.ave-api.xyz` with the production
  `AVE_API_KEY` from `.dev.vars` as the `X-API-KEY` upgrade header, subscribed
  to `price` (5 Arc token-ids), `multi_tx` and `kline` `k1` (5 Arc
  tokens/pairs, one `subscribe` call each), and sent a JSON-RPC `ping` every
  30 s. The 5 Arc pairs came from DexScreener's free search API
  (`chainId=arc`), not AVE REST, to avoid spending the production account's
  15-second slot: `A` (`0xf798...0000`), `Arcade`/`ARC`, `Artificial Robot
  Cat`/`ARC`, `A Reward Coin`/`ARC`, `A Rare Coin`/`ARC`.
- A first 5-minute run produced **zero** messages of any kind — no subscribe
  ack, no data, no `pong`, no error, no close notification. That null result
  was a measurement gap, not a real "open and silent" connection: the script
  resolved its `open` promise and only registered the `message`/`close`
  listeners afterward, by which point the server's immediate `Unauthorized`
  message-and-close had already fired with no listener attached, and every
  later `ws.send()` (no callback given) silently no-ops once the socket is
  closed. A follow-up diagnostic with listeners attached before anything else
  reproduced the real sequence: `open` → `Unauthorized` message → `close 1008`,
  within milliseconds of the handshake completing.
- A second diagnostic varied the auth mechanism (header vs. two query-param
  forms vs. none at all) against the real endpoint to rule out "wrong
  mechanism" before concluding "no access": see the table above.
- **Arc RPC probe**: opened `wss://rpc.mainnet.arc.io` with no auth, called
  `eth_subscribe` with `["newHeads"]` and `["logs", {}]`. `newHeads` delivered
  234 blocks in 120 s (mean interval ≈507 ms — this chain's block time), full
  header fields. `logs` with an empty/no filter got `{"error":{"code":-32603,
  "message":"internal error"}}` on the subscribe call itself — an unfiltered
  `logs` subscription is apparently not supported server-side; a scoped filter
  (specific `address`/`topics`) was not tried and is the natural next step if
  this path is pursued.

## Implications for per-token tracking (leads and outcome sampling)

- AVE's websocket cannot be used today: this key has no WS entitlement. The
  REST-vs-WS auth contrast (`Missing API Key` vs `Unauthorized`) says the
  gateway is working as designed and simply hasn't granted this plan/key
  socket access — the fix is almost certainly asking in AVE's Telegram
  (`t.me/ave_ai_cloud`, named in their docs for plan upgrades) whether
  websocket access needs a separate grant or paid tier, not a client-side
  retry. Until that's resolved, per-token price/tx/kline data for leads and
  outcome sampling has no AVE-websocket path, and the system stays dependent
  on the one 15-second REST slot (`AVE-EGRESS.md`) for the hot list only.
- Arc's own RPC websocket is a real, already-available alternative for
  on-chain primitives: new-block cadence (~2/s) is far finer-grained than
  AVE's 15 s REST cadence, and `eth_subscribe("logs", {address, topics})`
  scoped to a specific pair/pool's swap-event topic would give near-real-time
  per-pool fills without AVE at all. It gives raw chain events, not AVE's
  already-priced-and-enriched `tx`/`kline` rows (USD price, maker tags, 24 h
  aggregates) — using it for outcome sampling would mean decoding swap events
  and pricing them, work AVE's websocket was meant to avoid.

## Unknowns left open

- Whether websocket access can be granted on the current key/plan at all, and
  at what cost (CU-metered, flat add-on, or a different tier) — needs AVE's
  own answer, not another probe.
- Real AVE websocket message rates, latency and payload shape for `price`,
  `multi_tx` and `kline` on Arc — blocked on the access question above.
- Whether an open-then-`Unauthorized`-closed AVE WS connection counts against
  anything (CU or the REST 15 s spacing) — inferred "no" from the separate
  hostname, not measured.
- A scoped (non-empty-filter) Arc `logs` subscription was not tried.
