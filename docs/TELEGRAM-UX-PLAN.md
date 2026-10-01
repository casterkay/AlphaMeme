# Telegram interface improvement plan

Status: approved plan, 2026-09-30. Nothing below is implemented yet.

Approved direction: sparse status emoji; a live AVE lookup when the owner pastes a
contract address; `/disconnect` removed from the command menu (the typed command
keeps its documented immediate behavior); user-facing names Radar, Leads, Hot list,
Watchlist, Performance, Activity, Status, Settings, Wallet; buying a token whose
safety check has not verified it asks for an explicit Yes/No confirmation instead
of being blocked (§3.9). The decisions are recorded in §7.

## 1. Goals

The bot currently narrates its internals: operator counters, data-model states,
full-precision numbers and second-resolution UTC stamps. The redesign answers the
owner's two real questions first — *is there anything for me?* and *is this token
safe to act on?* — and moves operator detail one tap deeper.

Principles applied to every screen:

- **Answer first, detail on demand.** Verdicts and counts before evidence.
- **One vocabulary.** A concept has one name in commands, titles, buttons and alerts.
- **Predictable navigation.** The same footer, in the same order, everywhere.
- **Show defaults silently.** Only non-default filters, sorts and searches are printed.
- **Never silent.** Every message the owner sends gets a visible response.
- **Warn once, in context.** Caveats appear where they apply, not on every screen.
- **Evidence stays exact.** Summaries are rounded; the Evidence pages keep full values.

Non-goals: changing screening, scoring, notification eligibility, trading
execution (beyond the unverified-buy acknowledgement in §3.9) or the durable
inbox/outbox/session model. Internal panel identifiers
(`feed`, `audits`, `saved`, `events`, `stats`) stay as they are because sessions
persist them; only user-facing labels and command slugs change.

## 2. Shared vocabulary and visual language

| Internal panel | English | 中文 | Command | Icon |
|---|---|---|---|---|
| `radar` | Radar | 雷达 | `/radar` (and `/start`) | 📡 |
| `audits` | Leads | 线索 | `/leads` | 🎯 |
| `feed` | Hot list | 热榜 | `/hot` | 🔥 |
| `saved` | Watchlist | 自选 | `/watchlist` | ⭐ |
| `stats` | Performance | 表现 | `/performance` | 📈 |
| `events` | Activity | 动态 | `/activity` | 🗂 |
| `status` | Status | 状态 | `/status` | 📊 |
| `settings` | Settings | 设置 | `/settings` | ⚙️ |
| `wallet` | Wallet | 钱包 | `/wallet` | 👛 |
| `help` | Help | 帮助 | `/help` | ❓ |
| `sources` | Sources | 来源 | — (from Status) | 🛜 |
| `delivery` | Delivery | 投递 | — (from Status) | 📭 |

Status icons (one table in `src/render/telegram.mjs`, the only source of icons):

| Meaning | Icon | Meaning | Icon |
|---|---|---|---|
| Scanning | 🟢 | Paused | ⏸ |
| Not connected | 🔌 | Alerts on / off | 🔔 / 🔕 |
| No failures found | ✅ | Needs review | ⚠️ |
| Vetoed | ⛔ | Checking | ⏳ |
| New lead | 🆕 | Key / account issue | 🔑 |

Safety verdicts have one wording everywhere: `safetyBadge(verdict, locale)` in
`src/render/telegram.mjs` renders `safetyVerdict` from `src/scoring/safety.mjs` (§3.9).

| Verdict | English | 中文 |
|---|---|---|
| `PASSED` | ✅ No failures found | ✅ 未发现问题 |
| `INCOMPLETE` | ⚠️ Needs review | ⚠️ 待复核 |
| `VETOED` | ⛔ Vetoed | ⛔ 已否决 |
| `PENDING` | ⏳ Checking | ⏳ 检查中 |

Rules: every icon marks a state or a destination; navigation buttons carry their
panel icon; no decorative emoji in body text.

### Formatting (`src/render/telegram.mjs`)

| Value | Now | Proposed (summaries) |
|---|---|---|
| Market cap, liquidity, volume | `$123.45678K` | `$123K`, `$1.23M`, `$12.3B` (3 significant digits) |
| Price | `$0.00001234567` | `$0.00001235` (4 significant digits) |
| Percent | `+12.345678%` | `+12.3%`; `+1,240%` at ≥ 100% |
| Counts | `2431` | `2,431` / `2,431` |
| Event time in rows | `2026-09-30 12:34:56 UTC` | `4m ago` / `4分钟前` |
| Panel footer | `Snapshot 2026-09-30 12:34:56 UTC` | `Updated 12:34 UTC` (date added when not today) |
| Chain | `arc` in alerts | `Arc` everywhere via `chainLabel` |

Evidence pages keep `numberText` at full precision and ISO timestamps: they are
the audit record.

### Standard footer

`[🔄 Refresh] [⬅ Back] [🏠 Home]`, in that order on every panel. Back is omitted
without a `returnTo`; Home is omitted on Radar; Refresh is omitted on static
panels (selectors, help). One helper (`footerRow`) builds it; panels stop
assembling their own.

## 3. Screen specifications

### 3.1 Command menu (`HELP_COMMANDS`, `scripts/telegram-register.mjs`)

Registered menu, in frequency order: `/radar`, `/leads`, `/hot`, `/watchlist`,
`/wallet`, `/performance`, `/settings`, `/help`.

Working but unlisted (documented in Help): `/start`, `/activity`, `/status`,
`/chains`, `/pause`, `/resume`, `/mute`, `/lang`, `/note`, `/cancel`, `/export`,
`/onboard`, `/setkey`, `/disconnect`.

Removed slugs: `/audits`, `/candidates`, `/feed`, `/saved`, `/stats`, `/events`.
They are not kept as aliases (no compatibility shims); an unknown command already
opens Help, which lists the new names. `TelegramInbox`'s `CONTROLS` set drops the
obsolete `feed` and `chains` entries only if `/chains` is confirmed not to need
control-watermark ordering (verify before removing).

The default `setMyCommands` scope becomes English; the `zh` scope stays Chinese
(matches §3.8 language detection).

### 3.2 Radar (home)

```
📡 Radar · Arc
🟢 Scanning · 🔔 Alerts on

Last 30 min: 4 leads · 1 vetoed
1. PEPE   $120K · 4m · +35%
2. DOGE2  $48K · 11m · −8%
3. ⛔ RUGME  vetoed

Updated 12:34 UTC
[1 PEPE] [2 DOGE2] [3 RUGME]
[🎯 Leads] [🔥 Hot list]
[⭐ Watchlist] [📈 Performance]
[👛 Wallet] [⚙️ Settings]
```

- Top three rows are the newest leads on the scan chain (vetoed shown last).
- Empty state: "No leads in the last 30 min. The radar checks the hot list every
  ~15 s." with `[🔥 Hot list]`.
- Operator counters (scan count, discovered/prefilter, queue/due) move to Status.
- The scan chain is changed in Settings; list panels keep their "View chain"
  selector because viewing is not scanning.
- Not-connected state is the onboarding screen (§3.8), not a crowded variant.

### 3.3 Settings (grouped)

```
⚙️ Settings
Scanning: 🟢 Arc
Alerts: 🔔 On
Trading: slippage 5% · cap $100
Language: English
AVE: connected

[🔗 Scan chain: Arc] [⏸ Pause scanning]
[🔕 Mute alerts]
[👛 Wallet] [🎚 Trade limits]
[🌐 Language] [🔑 AVE key]
[📊 Status] [📤 Export]
[🔌 Disconnect AVE]
[🏠 Home]
```

Disconnect sits alone on the last functional row and still opens its
confirmation panel.

### 3.4 Leads, Hot list, Watchlist (`listPanel`)

- Header shows only the chain plus non-default state, e.g. `Arc · Filter: Favorites
  · Search: "pepe"`.
- Lead row: `1. PEPE · ⏳ Checking` / `✅` / `⚠️` / `⛔`, then
  `$120K MC · $30K liq · 4m ago`. The "failed/unknown 0/3" counter moves to the detail
  screen as a verdict.
- Hot-list row: `1. PEPE ✅ passed screen` or the first reason, then
  `$120K · 18m old · 5m vol $12K · +35%`. Holders and buys/sells move to detail.
- Footer line: `1–5 of 12`. The hot-list note "refreshes on interaction" becomes
  part of the `Updated` footer.
- Keyboard: token buttons in pairs; `[🔗 Chain] [🔽 Filter] [↕️ Sort]` on one row;
  `[🔍 Search]` (plus `[✖ Clear]` when active); pagination `[◀] [▶]`; standard footer.
- Filter labels shorten: Leads, Needs X review, Rechecking, Approved, Ignored,
  Vetoed, Last 5 min, Favorites.

### 3.5 Token detail (`detailPanel`)

```
PEPE · Arc
✅ No failures found · checked 4m ago
MC $120K · Liq $30K · 2,431 holders
18m old · 5m +35% · 5m vol $12K
0x1234…abcd (full CA in <code>, tap to copy)
⭐ In watchlist · 📝 "watch dev wallet"

[Buy $10] [Buy $20] [Buy $50] [Buy …]
[Sell 25%] [Sell 50%] [Sell 100%] [Sell …]
[𝕏] [🌐 Site] [📊 Chart] [🔎 Evidence]
[⭐ Watch] [📝 Note] [🙈 Ignore]
[👍 Approve]                ← only when eligible today
[🔄 Refresh] [⬅ Back] [🏠 Home]
```

- Verdict line replaces the four-way slash counter: ⛔ "Vetoed: honeypot risk" /
  ⚠️ "1 blocking unknown, 3 fields unknown" / ⏳ "Safety check running" / ✅.
- Lead caveat stays, shortened, only for leads: "Market lead: safety not yet
  verified."
- Buy buttons show for every token except a vetoed one; on an unverified token a
  buy first asks the Yes/No confirmation of §3.9.
- Market line joins the hot-list row when the candidate lacks age/5m fields
  (verify which fields candidates retain; show only present facts).
- Link row omits missing buttons silently; the "some links unavailable" line goes.
- `📊 Chart` uses the DexScreener `pairUrl` already collected in `secondary.market`.
- The "manual approval does not change screening" disclaimer moves to Help.
- Evidence pages keep their structure and exact values; titles gain icons.

### 3.6 Selectors, Status, Activity, Performance

- Selectors lay out 2 choices per row (3 for time windows); the generic "view
  choices apply to this panel" line is replaced by one specific sentence per
  selector (only the chain selector needs one: "Viewing a chain does not change
  what is scanned.").
- Status keeps operator detail with relative times and icons, gains the counters
  removed from Radar, and links `[🗂 Activity] [🛜 Sources] [📭 Delivery]`. Sources
  uses 🛜, not Radar's 📡: no two destinations share an icon.
- Activity rows: `4m ago · 🆕 PEPE — new lead`; token buttons as today.
- Performance leads with plain language — "Tokens that passed the screen, 30 min
  later: median +4.2% (37 tokens)" — and moves the 50-sample and calibration gates
  into Coverage details. "Shadow observations; not executable returns" stays.

### 3.7 Alerts (`reconcileNotificationsInTransaction`)

New leads (one batched message, up to 10 as today):

```
🆕 2 new leads · Arc
1. PEPE — $120K MC · $30K liq · 4m old · +35%
2. DOGE2 — $48K MC · $9K liq · 1m old · +12%
Safety check still running; not verified.
[1 PEPE] [2 DOGE2]
[🎯 All leads] [🔕 Mute alerts]
```

Risk worsened:

```
⛔ PEPE failed the safety check · Arc
Honeypot risk reported by GoPlus.
Buying is blocked; selling still works.
[Open PEPE]
```

Account issues: "🔑 Your AVE key stopped working" `[🔑 Reconnect AVE]`;
"📭 Some messages may not have arrived" `[📊 Status]`.

The "Action required" title and the Status button are removed. Eligibility,
batching, deduplication and expiry are unchanged; only rendering changes. The
risk reason comes from the candidate's recorded veto reason through the existing
`reasonText` labels, never from upstream prose.

### 3.8 First run and onboarding

- **Language from Telegram.** Intake carries `from.language_code`; on tenant
  creation the language preference is seeded: `zh*` → Chinese, anything else →
  English. `/lang` still overrides. Existing tenants are unaffected.
- **Welcome (not connected):**

  ```
  👋 AlphaMeme radar
  Watches the Arc hot list for new meme tokens, checks their safety and alerts you.

  Step 1 · Get a free AVE Data API key
  Step 2 · Send /setkey <key>
  Your key is read-only; it can never trade. Delete the key message afterwards.

  [🔑 Get AVE key]  [❓ How it works]
  [🌐 中文]
  ```

- **Connected** becomes a panel instead of plain text: "✅ AVE connected ·
  Scanning Arc · 🔔 Alerts on. Delete your key message if it is still visible."
  `[📡 Open radar] [🔗 Change chain]`. Failure variants get `[🔑 Try again]`.
- **Help** becomes three pages: what the bot does (three lines), commands (menu
  commands, then "more"), safety (key handling, hot wallet, not investment advice).

### 3.9 Buying before the safety check has verified a token

Buying is never blocked merely because the safety check is pending or
incomplete; it asks once. Only a `FATAL` verdict still blocks buying (unchanged).

A token is **verified** when its recorded GoPlus/DexScreener check has status
`COMPLETE`, the security verdict `NO_FATAL_FLAGS` and no blocking source conflict
(`MARKET_MISMATCH`/`SECURITY_MISMATCH`), and its deep audit has no failed or
blocking-unknown field. Everything else — a lead whose check has not run yet, a
degraded, unknown or conflicted check, an open deep audit, a hot-list
row that never became a candidate, a pasted token whose lookup is still running —
is **unverified**. One pure function (`safetyVerdict({ status, secondary, deep })` in
`src/scoring/safety.mjs` → `VETOED | PASSED | INCOMPLETE | PENDING`) owns this rule
for panels, alerts and the engine; the engine's `safetyState` maps it, plus risk
exclusions, to `VERIFIED | UNVERIFIED | VETOED`.

Every buy path (preset buttons and the custom-amount reply) on an unverified
token edits the panel into a confirmation before any quote is requested:

```
⚠️ Safety check not finished
PEPE · Arc — buy $25?
GoPlus and DexScreener have not verified this token yet.
It could be a honeypot or carry hidden taxes.

[Yes] [No]
```

- **Yes** requests the quote with an acknowledgement; the normal quote screen
  follows and still needs ✅ Confirm. The quote screen repeats one line:
  "⚠️ Bought before the safety check verified it."
- **No** returns to the token detail; nothing is requested.
- The buttons are bound to the session version like every other callback, so a
  stale Yes cannot be replayed.
- If the check finishes while the question is open: `VERIFIED` → Yes simply
  proceeds; `VETOED` → Yes is refused with the existing veto message.

Defense in depth: `requestTradeInTransaction` takes `unverifiedAcknowledged` and
refuses an unverified buy without it (new refusal `UNVERIFIED`, which the command
layer turns into this confirmation). The confirmation is therefore a policy the
engine enforces, not only a UI step. Sells never ask.

### 3.10 Input and feedback

- **Prompts** name the token: "Reply with a note for PEPE (Arc), max 500
  characters. /cancel to stop."
- **Refusals become panel banners.** A trade refusal or invalid reply currently
  sends a separate message; instead the session carries a one-shot `notice`
  rendered as the panel's first line ("⚠️ Above your $100 cap. Change it in Trade
  limits.") and cleared on the next render. Expired-session notices remain
  messages because there is no panel to edit. (Callback toasts are not used: the
  callback is answered at intake, before the durable command runs.)
- **Unrecognized text** gets a reply instead of silence: "Paste a token contract
  address to look it up, or open 📡 Radar." `[📡 Radar] [❓ Help]`. The text itself
  is not persisted.

## 4. Pasted contract-address lookup

### 4.1 Intake classification (`src/telegram-intake.mjs`)

Plain, non-reply, non-command text is classified at the boundary, in this order:

1. **Secret-shaped** — PEM (existing), 64-hex with or without `0x` (EVM private
   key), or base58 decoding to 64 bytes (Solana secret key): receipt
   `command:secret_warning` with an empty payload, the message is queued for
   deletion, and the owner is told "That looked like a private key. I tried to
   delete it; never paste keys here." The text is never persisted.
2. **Token address** — `normalizeTokenAddress` succeeds for `eth` (EVM grammar)
   or `sol` (32-byte base58): receipt `lookup` with `{ family: 'evm'|'sol',
   address }` (normalized).
3. **Anything else** — receipt `text` with an empty payload (§3.10).

A random AVE API key cannot pass as a Solana address unless it is valid base58
of exactly 32 bytes; step 1 and the strict decode keep keys out of third-party
requests. Fuzz tests cover the classifier (§6).

### 4.2 Command handling (`src/bot/commands.mjs`)

1. **Chain.** Solana → `sol`. EVM → the scan chain when it is EVM; otherwise a
   chain picker of EVM scan chains.
2. **Known locally** (candidate, hot-list row, annotation or a fresh lookup on
   that chain) → open Token detail immediately; no credits spent.
3. **AVE not connected** → the onboarding panel with a line explaining lookups
   need AVE.
4. **Otherwise** → create the lookup record, open Token detail in state
   "⏳ Looking up on Arc…", and schedule its task.

### 4.3 Lookup task (new `src/lookup.mjs`, scheduler kind `lookup`)

Mirrors the trade step model: one external request per step, persisted after
each step, restart-safe. All steps are reads, so retries are safe; they use the
scheduler's existing limit and backoff.

| Step | Request | AVE cost |
|---|---|---|
| `DETAILS` | `AveClient.details(chain, address)` | 5 CU through the existing admission |
| `DEXSCREENER` | `SecondaryValidator.fetchSource('dexScreener')` | 0 |
| `GOPLUS` | `SecondaryValidator.fetchSource('goPlus')` | 0 |
| `DONE` | `aggregateSecondarySources` → verdict | — |

Terminal states: `DONE` (with `PASS`/`UNKNOWN`/`FATAL`), `NOT_FOUND` (detail
offers `[Try on BNB Chain] [Try on Base] …`), `FAILED` (reason label + `[🔄 Retry]`).
AVE rate-limit or quota waits show "⏳ Waiting for AVE capacity".

Each step re-renders the bound detail session as a `PANEL_UPDATE`, as wallet
balances do today.

Storage: `scheduler_state` rows `lookup:<chain>:<address>`, newest 20 retained,
24 h expiry. A repeat paste within 60 s reuses the record; one lookup runs at a
time per tenant; scheduler priority equals `command`.

### 4.4 Invariants

- A lookup is **not a lead**: it never enters `candidates`, notifications,
  outcomes/Performance, the audit queue or `/export`.
- It may be added to the Watchlist and noted (annotations are keyed by
  chain+address already).
- **Buying follows §3.9.** Buy buttons show in every state except a `FATAL`
  verdict; until the lookup reaches `DONE` with a verified result, a buy asks the
  Yes/No confirmation. `safetyState` reads the lookup record, so a `FATAL` lookup
  verdict is refused by `tradeVetoed` and by the engine's per-step veto recheck.
  Selling is always available.
- Detail shows the source and age: "AVE · 20s ago".

## 5. Delivery slices

One issue, branch, worktree and PR each; each PR gets an independent review.

| # | Issue | Slice | Depends on | Main files |
|---|---|---|---|---|
| 1 | #62 | Formatting, icons, footer helper | — | `render/telegram.mjs`, all panels (mechanical) |
| 2 | #63 | Names, menu, Radar, Settings, Status, Help | 1 | `panels.mjs`, `commands.mjs`, `inbox.mjs`, `scripts/telegram-register.mjs` |
| 3 | #64 | Alert cards | 1 | `runtime.mjs` |
| 4 | #65 | Lists, detail, selectors, Activity, Performance | 1 | `panels.mjs`, `trading-panels.mjs` |
| 5 | #66 | Unverified-buy confirmation (§3.9) | 1 | `trading/engine.mjs`, `commands.mjs`, `trading-panels.mjs` |
| 6 | #67 | First run, language detection, connect panel, banners, prompts, unrecognized text | 2 | `telegram-intake.mjs`, `inbox.mjs`, `commands.mjs`, `runtime.mjs` |
| 7 | #68 | Contract-address lookup | 4, 5, 6 | new `lookup.mjs`, `telegram-intake.mjs`, `commands.mjs`, `radar-agent.mjs`, `trading/engine.mjs` |

Slices 2, 3, 4 and 5 run in parallel after 1; slice 5 touches trading, so it gets
its own review even though its diff is small. Documentation (`TELEGRAM-M3-OPERATIONS.md`,
README command list) is updated in the slice that changes the behavior.

## 6. Validation

- **Formatting:** table-driven cases plus property tests (compact money is ≤ 4
  significant characters of mantissa, monotone in magnitude, never `NaN`; percent
  sign matches input sign).
- **Panels:** existing `telegram-panels` / `trading-panels` tests updated to the
  new copy; new assertions for footer order, default-state suppression, and every
  panel staying under `TELEGRAM_TEXT_BUDGET` with 10 max-length rows in both
  languages.
- **Alerts:** eligibility tests unchanged and still passing (proves rendering-only
  change); new rendering tests for batch, risk reason and account issues.
- **Intake:** fuzzing of the text classifier — no generated secret-shaped string is
  classified as a lookup, no `text`/`secret_warning` receipt carries the text, and
  every valid EVM/Solana address round-trips.
- **Unverified buy:** table-driven `safetyState` cases (no check, degraded,
  unknown, complete, fatal, hot-list-only, lookup running); engine refuses an
  unverified buy without the acknowledgement and accepts it with one; preset and
  custom-amount buys both show the confirmation; No requests nothing; a stale Yes
  after a session change is rejected; Yes after a `FATAL` verdict is refused;
  verified tokens and all sells skip the question.
- **Lookup:** stub AVE and secondary transports covering found/not-found,
  rate-limited wait, restart mid-step, repeat-paste reuse, confirmation while the
  lookup runs, `FATAL` blocking buy (engine and panel), and absence from
  notifications, stats and export.
- **End to end:** Workers runtime test — paste CA → detail updates through steps.
- Run the project's existing test, type-generation and Wrangler dry-build checks
  per slice.

## 7. Decisions (approved 2026-09-30)

1. Old command slugs are dropped, not aliased.
2. Non-Chinese Telegram users default to English.
3. Buying any unverified token — a lead, a hot-list row or a pasted token — asks
   a Yes/No confirmation (Yes left, No right) instead of being blocked; only a
   `FATAL` verdict blocks buying.
4. An EVM address is looked up on the scan chain first, with a picker for the rest.
