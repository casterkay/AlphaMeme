# Development plan: screening, measurement and hosting

Status: accepted, 2026-10-02. It reconciles open issues #1, #2, #76 and #102–#107,
PR #112 and the VPS move (`docs/VPS-MIGRATION-PLAN.md`) into one sequence.
Live facts below were read from AVE, GoPlus, DexScreener and GeckoTerminal on
2026-10-02.

## Principles

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

## Decisions (owner, 2026-10-02)

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

## Where things stand

Pipeline: AVE hot list (every 15 s, one chain) → `aveDiscoveryScreen` → lead and
alert → GoPlus check (at most 3 per cycle) → a fatal flag vetoes the lead and
edits the alert. Nothing else runs after the alert.

### Data each source gives

| Source | Cost and reach | Fields that matter for screening |
|---|---|---|
| AVE hot-list row | already paid (5 CU per list) | price, market cap, liquidity, 5 m/1 h/4 h/24 h buys, sells, **distinct buyers/sellers/makers**, buy/sell tax (≈80% of rows), holder count, launch time, `issue_platform` (Arc only). Its `is_honeypot`/`has_*`/`ave_risk_level` fields are marked "not in use" by AVE; `is_honeypot` was `false` on every row, even one with a 100% sell tax. |
| GoPlus `token_security` | free with the app key; eth, bsc, base, arc (no Robinhood) | contract flags, taxes, **top-10 holders** (percent, is_locked, is_contract, tag), **LP holders** (is_locked, percent), creator address and percent, owner address and percent, holder count, `honeypot_with_same_creator`. On Arc it returns **no `cannot_sell_all`** (6 of 6 tokens checked). |
| GMGN | keyed; blocked from Cloudflare egress; the old client listed arc and robinhood | rug ratio, insider/bundler/sniper rates, wash trading, holder and trader wallet tags, creator history, token security, candles. `deepScreen` was written against these shapes. |
| DexScreener | free, no key; covers arc and robinhood; 429s from Cloudflare | per-pair price, liquidity, volume, buy/sell counts, pair creation time; batch reads. No candles, no holders. |
| GeckoTerminal | free, no key, about 30 requests a minute; covers arc and robinhood | one-minute OHLCV candles per pool. |
| AVE per-token | 5–10 CU each (klines 10) | top-100 holders, pair swaps, candles, contract risk (a GoPlus derivative). |
| Chain logs | RPC | new pools on pinned factories (Arc). |

AVE credit budget: 1,000,000 CU a month. The 15 s hot list on one chain alone is
about 864,000, which leaves about 136,000 CU (≈4,500 a day) for everything else.

### Per-token data: chosen sources

AVE credits stay with the hot list; per-token reads come from free sources:

| Need | Source | Why |
|---|---|---|
| contract flags, holders, LP, creator | GoPlus | already fetched; holders and LP are in the payload we discard today |
| wallet-level checks (rug, bundler, insider, sniper, wash, wallet tags), creator history, Robinhood's security check | GMGN | the only source for these; it covers both Arc and Robinhood, and the old deep audit already parses it |
| candles (5-minute observation, chart risk) | GMGN; GeckoTerminal as fallback | both free; GeckoTerminal's limit fits leads, not the whole hot list |
| market snapshots for tokens off the hot list (#102 outcomes, #106 history, liquidity pulls) | DexScreener | free batch reads, and it sees tokens after they leave the hot list |
| AVE per-token reads | not used by default | only if GMGN and GeckoTerminal both fail |

GMGN, DexScreener and GeckoTerminal all throttle Cloudflare's shared egress IPs,
so this choice depends on the VPS. GMGN is the riskiest: it has blocked clients
before, so its checks stay in shadow until it proves stable from the VPS IP.

### Known defects found while planning

1. **No Arc token can reach `PASSED`.** GoPlus never returns `cannot_sell_all` on
   Arc, `parseGoPlus` counts it as an unknown field, so every Arc check stays
   `INCOMPLETE`. Arc is the default chain. Fix: per-chain required fields, with
   sell-ability on Arc proven another way (distinct sellers from the AVE row).
2. **Robinhood has no secondary check.** GoPlus has no Robinhood chain id, so its
   leads stay unchecked. GMGN's token security is the candidate source.

## How the issues fit

| Item | Disposition |
|---|---|
| PR #112 | Merge first (AVE taxes at the screen, GoPlus tax veto, gap rule removed). |
| #105 rule table | **Foundation.** Every later rule lands as a row in it. Absorbs #76 (screen reasons localized from rule ids). |
| #103 remove GMGN code | **Rescoped:** delete the non-AVE `discoveryScreen` branch, the 1 m→5 m fallbacks and the `X_REVIEW`/`QUALIFIED` manual-review path (after checking stored rows); port the deep-audit checks into #105 instead of deleting them. |
| #102 outcomes | **Measurement**, needed before any shadow rule is enforced. Off-list price samples come from DexScreener. Its cohorts gain the per-rule verdicts from #105. |
| #104 holder distribution | **First post-alert audit slice**, from the GoPlus payload already fetched. |
| #106 snapshot history | Trend rules (#1 K2 holder growth, liquidity pull), fed by the hot list and DexScreener. Storage writes stop being a billing concern on the VPS. |
| #107 creator ledger | Creator from GoPlus `creator_address`, history from GMGN; GoPlus's `honeypot_with_same_creator` is a first signal at no cost. Single tenant (VPS plan), so the ledger is simply global. |
| #1 two-stage filter | Its rules become rule-table rows; placement below. K1 and K4 are dropped (decisions 1 and 3). |
| #2 Pons origin (Robinhood) | Later. It adds a new provider (Bitquery) and matters only while scanning Robinhood. |
| #60 unused DexScreener overlay | Unchanged: the overlay code goes; DexScreener's new uses get their own client. |
| VPS move | Separate track owned by its own session. GMGN, DexScreener and GeckoTerminal depend on it. |

### #1's rules, placed

| Rule | Stage | Source | Note |
|---|---|---|---|
| D1 name blacklist | screen | row `name`/`symbol` | buildable now |
| D2 creator > 20 launches in 24 h | after alert | #107 ledger | needs per-token launch times, never a lifetime count |
| D3 bundler/insider > 30% | after alert | GMGN | GoPlus has no bundler tags |
| D4 can only buy | after alert, partly screen | GoPlus honeypot; row distinct sellers | the row's sellers count also fixes Arc (defect 1) |
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
| empirical sellability | AVE row distinct sellers | now |
| 5-minute observation, chart risk | GMGN or GeckoTerminal candles | after VPS |
| rug ratio, insider, bundler, sniper, wash, wallet analysis, market behavior | GMGN | after VPS; shadow `UNKNOWN` until then |

## Sequence

Each step is one issue, one branch, one PR. Items in the same step can run in
parallel.

1. **Now:** merge PR #112. Fix defect 1 (Arc required fields).
2. **Foundation:** #105 rule table with a parity test over recorded rows,
   folding in #76 and rescoped #103. In parallel: #102's rejected cohort and
   cohort split, which need no new reads.
3. **Post-alert audit v1:** port the checks available now (#104 included) plus
   D1 at the screen, all in shadow; the token detail lists what did not run.
   #102 records their verdicts.
4. **After VPS cutover:** a GMGN spike from the VPS IP (reachable, chains, rate
   limits); a DexScreener client for #102's off-list samples. Then the GMGN-backed
   checks and candles (GeckoTerminal if GMGN fails), in shadow, and Robinhood's
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
