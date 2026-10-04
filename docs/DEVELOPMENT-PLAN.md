# Development plan: screening, measurement and hosting

Status: accepted, 2026-10-02; updated 2026-10-03. It reconciles open issues #1, #2, #76 and #102–#107,
PR #112 and the VPS move (`docs/VPS-MIGRATION-PLAN.md`) into one sequence.
Live facts below were read from AVE, GoPlus, DexScreener and GeckoTerminal on
2026-10-02 and 2026-10-03.

## Principles

- **Alert as early as possible.** Most tokens live 15–20 minutes. A token with
  no obvious problem (high tax, trap, scam) is alerted in its first minutes, not
  after its run.
- **An alert never waits for a per-token read.** The hot-list screen uses only
  fields already in the AVE trending row. Everything that needs a per-token read
  runs after the alert and moves the token's safety verdict
  (`src/scoring/safety.mjs`: `PENDING → PASSED | INCOMPLETE | VETOED`), which
  edits the alert in place, as the GoPlus veto does today.
- **The deep audit is part of the system.** `deepScreen` stopped running when
  the scanner moved from GMGN to AVE (#52), only because its inputs vanished. Its
  checks are ported to the new sources, not deleted. This replaces #103's
  proposal to delete it.
- **Three states, never two.** Every rule answers `HIT | CLEAR | UNKNOWN`, as #1
  and #105 define. Unknown is never a pass.
- **Measure before enforcing.** New rules ship in shadow mode and are enforced
  only once outcomes (#102) show that they help.

## Decisions (owner)

Decisions 1–9 date from 2026-10-02, 10–13 from 2026-10-03.

1. **The `PASSED` badge is the end state.** There is no manual review step: #1's
   "memo" is `PASSED`, and K4 (a person states the launch reason) is dropped. The
   `X_REVIEW`/`QUALIFIED` manual-review path is removed (#103), once stored rows
   are checked.
2. **Checks without a data source run in shadow.** `PASSED` means "every
   enforced rule is clear". The token detail lists the checks that did not run,
   so a pass never implies more than was checked.
3. **Any launch platform is fine.** K1 (factory/platform allowlist) is dropped;
   `issue_platform` is kept only as displayed evidence.
4. **Robinhood stays a scan chain.** It is idle only because the bot is set to
   Arc. It still needs a secondary check source (defect 2).
5. **The buy–sell tax gap rule is removed** (PR #112). The 5% buy and sell
   limits remain.
6. **Arc may reach `PASSED` on distinct-seller evidence.** Where GoPlus omits
   `cannot_sell_all` (Arc), distinct sellers in the AVE row stand in for it, and
   the token detail labels the check as passed on that weaker evidence (defect
   1).
7. **New-pool promotions read DexScreener, not AVE.** The promoted row is built
   from the market the watch already fetched (defect 3).
8. **Promoted leads' outcomes wait for a DexScreener sampler.** Only AVE samples
   outcomes, so a lead promoted from DexScreener records no outcome and does not
   count in Performance until #102 adds DexScreener sampling. If the token later
   appears on the AVE hot list, that sighting records its AVE baseline and it is
   tracked normally; the baseline is then later than the alert, typically after
   the price has moved.
9. **A promoted Arc lead may stand in DexScreener sells for `cannot_sell_all`.**
   For a row promoted from DexScreener, at least one sell transaction in
   DexScreener's 24-hour window stands in for the field GoPlus omits on Arc,
   labeled as DexScreener's sell count (decision 6's counterpart for rows
   without AVE's distinct sellers). One source stands in per check, AVE's when
   AVE gave a count. Implemented (#119).
10. **The minimum age is 60 s**, not 5 minutes, on both discovery paths. The
    5-minute minimum fed the old deep audit's 5-minute candle observation; the
    other screen checks stay, and GoPlus still vetoes after the alert (#120).
11. **A promoted pool that fails the screen is rechecked every cycle**, whatever
    the reason, instead of waiting 30 minutes. Pools never screened go first,
    so one that keeps failing cannot starve new pools (#120).
12. **Young pools are read every cycle.** Pools under about 20 minutes old are
    re-read on DexScreener each cycle, with more than one request when needed,
    up to a fixed cap; older idle pools less often (#120).
13. **Each token's stage times are recorded**, from pool creation to alert
    delivery and the first complete GoPlus check, as structured logs and as
    facts on the lead, so latency tuning rests on data (#120).

## Where things stand

Discovery has two entrances, both screened by `aveDiscoveryScreen`:

- **Hot list:** AVE trending (one chain, every cycle).
- **New pools** (Arc only, `POOL_SOURCES`): chain logs find new pools → a
  DexScreener batch read watches them → up to two busy enough pools a cycle are
  promoted and screened from that DexScreener market, with no AVE request
  (`promotedRows`, `src/recoverable-scanner.mjs`). The token's first pool dates
  it; holders and taxes stay unknown.

A passing token becomes a lead and is alerted → GoPlus check (at most 3 per
cycle) → a fatal flag vetoes the lead and edits the alert. Nothing else runs
after the alert.

### How early alerts are (2026-10-03)

A passing token's alert is enqueued within seconds: the scheduler reconciles
notifications on every step. The delay is all before the screen:

- **The hot list finds tokens late.** It ranks by popularity. In a live Arc
  snapshot of 100 rows, 74 were 6–24 h old, 4 under 1 h, none under 5 minutes;
  the youngest (about 17 minutes) already had 441 buys in 5 minutes. AVE's
  "New" ranking lists no Arc tokens. The hot list confirms runs; it cannot
  catch launches.
- **The new-pool path is the only early path, and it is mostly down on
  Cloudflare**, where Arc's public RPC and DexScreener answer 429. The VPS move
  is therefore the precondition for early alerts, not only for GMGN.
- **Inside that path**, the 5-minute minimum age, a 30-minute lockout after one
  failed screen, and a watchlist that re-reads each pool only every few cycles
  added minutes more. Decisions 10–13 remove them (#120).

### Data each source gives

| Source | Cost and reach | Fields that matter for screening |
|---|---|---|
| AVE hot-list row | already paid (5 CU per list) | price, market cap, liquidity, 5 m/1 h/4 h/24 h buys, sells, **distinct buyers/sellers/makers**, buy/sell tax (≈80% of rows), holder count, launch time, `issue_platform` (Arc only). Its `is_honeypot`/`has_*`/`ave_risk_level` fields are marked "not in use" by AVE; `is_honeypot` was `false` on every row, even one with a 100% sell tax. |
| GoPlus `token_security` | free with the app key; eth, bsc, base, arc (no Robinhood) | contract flags, taxes, **top-10 holders** (percent, is_locked, is_contract, tag), **LP holders** (is_locked, percent), creator address and percent, owner address and percent, holder count, `honeypot_with_same_creator`. On Arc it returns **no `cannot_sell_all`** (6 of 6 tokens checked). |
| GMGN | keyed; blocked from Cloudflare egress; the old client listed arc and robinhood | rug ratio, insider/bundler/sniper rates, wash trading, holder and trader wallet tags, creator history, token security, candles. `deepScreen` was written against these shapes. |
| DexScreener | free, no key; **in use today** by the new-pool watch, which Cloudflare's egress gets 429s on ("New pools watched: Rate limited"). `DEX_CHAIN_IDS` covers arc, bsc, base, eth; DexScreener serves Robinhood too, but its id is not in our map yet. | per-pair price, liquidity, market cap, 5 m volume, buy/sell counts, pair creation time; batch reads. No candles, no holders, no taxes. |
| GeckoTerminal | free, no key, about 30 requests a minute; covers arc and robinhood | one-minute OHLCV candles per pool. |
| AVE per-token | 5–10 CU each (klines 10) | top-100 holders, pair swaps, candles, contract risk (a GoPlus derivative). |
| Chain logs | RPC | new pools on pinned factories (Arc). |

AVE's binding limit is request spacing, not credits. Admission
(`src/ave-admission.mjs`) keeps every AVE request at least 15 s apart and paces
spending so the 1,000,000 CU monthly allowance lasts the period. The hot list
alone fills that one-request-per-15 s slot (about 864,000 CU a month), so **every
other AVE read delays the hot list**: two promotions stretched a 15 s cycle to
about 45 s until they stopped reading AVE (defect 3). Credits run out only if requests cost more than 5 CU on average.

### Per-token data: chosen sources

The hot list keeps AVE's request slots; per-token reads come from free sources:

| Need | Source | Why |
|---|---|---|
| contract flags, holders, LP, creator | GoPlus | already fetched; holders and LP are in the payload we discard today |
| wallet-level checks (rug, bundler, insider, sniper, wash, wallet tags), creator history, Robinhood's security check | GMGN | the only source for these; it covers both Arc and Robinhood, and the old deep audit already parses it |
| candles (5-minute observation, chart risk) | GMGN; GeckoTerminal as fallback | both free; GeckoTerminal's limit fits leads, not the whole hot list |
| market snapshots for tokens off the hot list (#102 outcomes, #106 history, liquidity pulls) | DexScreener | free batch reads, and it sees tokens after they leave the hot list |
| AVE per-token reads | not used by default | only if GMGN and GeckoTerminal both fail; each one delays the hot list 15 s |

GMGN, DexScreener and GeckoTerminal all throttle Cloudflare's shared egress IPs,
so this choice depends on the VPS, which also unblocks the new-pool watch. GMGN is the riskiest: it has blocked clients
before, so its checks stay in shadow until it proves stable from the VPS IP.

Websockets (probed 2026-10-05, `docs/spikes/AVE-WEBSOCKET.md`): AVE's
websocket refuses our key ("Unauthorized"), so it cannot replace per-token REST
reads unless AVE grants access. Arc's RPC serves `eth_subscribe` `newHeads` at
`wss://rpc.mainnet.arc.io` without a key; on the VPS it can replace the
new-pool watch's 15 s log polling. It yields raw chain events, not priced
market data, so DexScreener still prices the pools.

### Known defects found while planning

1. **No Arc token can reach `PASSED`.** GoPlus never returns `cannot_sell_all` on
   Arc, `parseGoPlus` counts it as an unknown field, so every Arc check stays
   `INCOMPLETE`. Arc is the default chain. Distinct sellers in the AVE row are
   **not** a substitute: some wallets selling some amount does not rule out
   maximum-sell limits or rules that let holders sell only part of a balance,
   which is what `cannot_sell_all` catches. Fix (decision 6): on a chain where
   GoPlus omits the field, distinct sellers stand in for it, and the token
   detail labels the check as passed on that weaker evidence. A simulated sale
   of a holder's full balance (`eth_call` against the pool), which needs the Arc
   RPC the VPS move fixes, later replaces the stand-in with equivalent evidence.
2. **Robinhood has no secondary check.** GoPlus has no Robinhood chain id, so its
   leads stay unchecked. GMGN's token security is the candidate source.
3. **New-pool promotions delay the hot list** (fixed, #117). Each promotion took
   one of AVE's 15 s request slots (see the budget above). Fix (decision 7): the
   promoted row is built from the DexScreener market the watch already fetched.
   It carries everything the screen gates on (the token's first pool's creation
   stands in for launch time) except taxes, which stay unknown so GoPlus decides
   after the alert, and AVE's source clock, for which our read time stands in.
4. **Discovery is too slow for 15–20 minute tokens** (#120). See "How early
   alerts are" above; fix: decisions 10–13.

## How the issues fit

| Item | Disposition |
|---|---|
| PR #112 | Merged with #115 (AVE taxes at the screen, GoPlus tax veto, gap rule removed). |
| #120 discovery latency | **First**, before the foundation: alert speed is the product. Independent of the VPS, but it pays off once the new-pool path works there. |
| #105 rule table | **Foundation.** Every later rule lands as a row in it. Absorbs #76 (screen reasons localized from rule ids). |
| #103 remove GMGN code | **Rescoped:** delete the non-AVE `discoveryScreen` branch, the 1 m→5 m fallbacks and the `X_REVIEW`/`QUALIFIED` manual-review path (after checking stored rows); port the deep-audit checks into #105 instead of deleting them. |
| #102 outcomes | **Measurement**, needed before any shadow rule is enforced. Off-list price samples come from DexScreener. Its cohorts gain the per-rule verdicts from #105. |
| #104 holder distribution | **First post-alert audit slice**, from the GoPlus payload already fetched. |
| #106 snapshot history | Trend rules (#1 K2 holder growth, liquidity pull), fed by the hot list and DexScreener. Storage writes stop being a billing concern on the VPS. |
| #107 creator ledger | Creator from GoPlus `creator_address`, history from GMGN; GoPlus's `honeypot_with_same_creator` is a first signal at no cost. Single tenant (VPS plan), so the ledger is simply global. |
| #1 two-stage filter | Its rules become rule-table rows; placement below. K1 and K4 are dropped (decisions 1 and 3). |
| #2 Pons origin (Robinhood) | Later. It adds a new provider (Bitquery) and matters only while scanning Robinhood. |
| #60 unused DexScreener overlay | Unchanged: the unused overlay goes. The watch's DexScreener reader (`dexMarkets`) is the client that #102, #106 and promotions extend. |
| VPS move | Separate track owned by its own session. GMGN, DexScreener and GeckoTerminal depend on it, and so do early alerts: it unblocks the new-pool path. |

### #1's rules, placed

| Rule | Stage | Source | Note |
|---|---|---|---|
| D1 name blacklist | screen | row `name`/`symbol` | buildable now |
| D2 creator > 20 launches in 24 h | after alert | #107 ledger | needs per-token launch times, never a lifetime count |
| D3 bundler/insider > 30% | after alert | GMGN | GoPlus has no bundler tags |
| D4 can only buy | after alert, partly screen | GoPlus honeypot and `cannot_sell_all`; on Arc, row distinct sellers (labelled) | full-balance sell simulation after the VPS (defect 1) |
| D5 one-sided 5 m trading | screen | row | already enforced |
| D5b self-trading | after alert | GMGN | |
| K2 holders growing | screen | #106 history | |
| K3 two-way trading | screen | row | already enforced |

### `deepScreen`'s checks, ported

| Check | Source | Available |
|---|---|---|
| open source, honeypot, taxes | GoPlus | now (enforced) |
| owner renounced | GoPlus owner address | now |
| LP locked or burned ≥ 80% | GoPlus `lp_holders` | now; V3/V4 NFT positions need their own reading |
| top-10 ≤ 30%, dev ≤ 1% | GoPlus holders and creator percent, excluding pool/burn/locked | now |
| liquidity ≥ $8k | AVE row | now |
| empirical sellability | AVE row distinct sellers | now; on Arc it also stands in for `cannot_sell_all`, labelled as weaker evidence |
| sell-all on Arc | full-balance sell simulation over Arc RPC | after VPS, replacing the stand-in |
| 5-minute observation, chart risk | GMGN or GeckoTerminal candles | after VPS |
| rug ratio, insider, bundler, sniper, wash, wallet analysis, market behavior | GMGN | after VPS; shadow `UNKNOWN` until then |

## Sequence

Each step is one issue, one branch, one PR. Items in the same step can run in
parallel.

1. **Done:** PR #112 and #115; defects 1 and 3 (#118, #119).
   **Now:** #120, discovery latency (decisions 10–13).
2. **Foundation:** #105 rule table with a parity test over recorded rows,
   folding in #76 and rescoped #103. In parallel: #102's rejected cohort and
   cohort split, which need no new reads.
3. **Post-alert audit v1:** port the checks available now (#104 included) plus
   D1 at the screen, all in shadow; the token detail lists what did not run.
   #102 records their verdicts.
4. **After VPS cutover:** a GMGN spike from the VPS IP (reachable, chains, rate
   limits); extend the watch's DexScreener reader for #102's off-list samples;
   the Arc full-balance sell simulation (defect 1). Then the GMGN-backed checks
   and candles (GeckoTerminal if GMGN fails), in shadow, and Robinhood's
   secondary check (defect 2).
5. **History and reputation:** #106, then #107.
6. **Enforce:** switch rules whose outcomes support it from shadow to enforced,
   one PR per rule group. This repeats as outcome data accumulates.
7. **Later:** #2.

### Coordination with the VPS track

- Schema changes from #105/#106/#107 must not land between the VPS export and
  import. Land them before the export or after cutover.
- Screening work stays out of `src/host/`; the VPS work stays out of
  `src/scoring/` and `src/providers/`.

