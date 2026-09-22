# Telegram interface — implementable M3 design

Status: implementation contract, 2026-09-22. M3 implementation includes the
formerly M4 dependencies; acceptance criteria remain required. See
[implementation and validation status](TELEGRAM-M3-OPERATIONS.md). Deployed timing
evidence (#29) remains a release blocker.

## 1. Evidence, scope, and milestone proposal

Checked the live [M3 milestone](https://github.com/casterkay/AlphaMeme/milestone/4),
[M4 milestone](https://github.com/casterkay/AlphaMeme/milestone/5), all their issues,
and [the refactor plan](CLOUDFLARE-TELEGRAM-REFACTOR.md), especially §§5–9.
GitHub redirects `casterkay/meme-radar` to `casterkay/AlphaMeme`. These are the
project milestones, not the upstream repository's milestones.

Local behavior was inspected at commit
`3c56715b8149132a0fb6ceeca1fe7b421b055c5e`, not a verified deployed revision:

- `public/index.html`: `render`, `renderLive`, `renderOutcomes`, `rowMatches`,
  `sortRows`, `renderTelemetry`, and the existing input controls.
- `src/scoring/manual-review.mjs`, `src/scoring/outcomes.mjs`,
  `src/live-discovery.mjs`, `src/scanner.mjs` (`summarizeOutcomes`).
- `src/render/whitelist.mjs`, `src/storage/controls.mjs`,
  `src/storage/schema.mjs`, `src/storage/control-state.mjs`,
  `src/telegram-intake.mjs`.

### Why M3's current wording is insufficient

M3 #22 requires every major panel, including feed and statistics, but M4 #26–29
owns the live subscription, notification policy, completed statistics, and live
timing evidence. A panel-only M3 cannot truthfully claim the complete working
interface. The user requested a proposal to bring those dependencies into M3.

| Current owner | Proposed M3 deliverable | Completion evidence |
|---|---|---|
| [#18](https://github.com/casterkay/AlphaMeme/issues/18) | Private-chat webhook authorization | Unauthorized updates cannot create/read/write tenants |
| [#19](https://github.com/casterkay/AlphaMeme/issues/19) | Durable inbox and input routing | Replay, reordering, cancellation, recovery, secret scrubbing |
| [#20](https://github.com/casterkay/AlphaMeme/issues/20) | Outbox, message ownership, bounded uncertainty | Crash tests, serial edits, UNKNOWN ceiling |
| [#21](https://github.com/casterkay/AlphaMeme/issues/21) | Onboarding and atomic credential activation | Generation races, failure preserves prior connection |
| [#22](https://github.com/casterkay/AlphaMeme/issues/22) | Every screen, commands, bilingual rendering, search, export | Web fixture parity and interaction tests |
| [#23](https://github.com/casterkay/AlphaMeme/issues/23) | Token cards, shortlinks, manual review | Stale/replayed callbacks, mark expiry and all-card correction |
| [#24](https://github.com/casterkay/AlphaMeme/issues/24) | Ed25519 spike before onboarding | Workers runtime generation/export/sign/verify evidence |
| [#25](https://github.com/casterkay/AlphaMeme/issues/25) | Key handling help and onboarding copy | Both languages disclose residual chat history risk |
| M4 [#26](https://github.com/casterkay/AlphaMeme/issues/26) → M3 | Persistent live subscription and recovery | No-interaction polling, lease and cooldown tests |
| M4 [#27](https://github.com/casterkay/AlphaMeme/issues/27) → M3 | Action-required notification policy | Routine update sends = 0; mute and baselines verified |
| M4 [#28](https://github.com/casterkay/AlphaMeme/issues/28) → M3 | Complete statistics panel | Seven windows and both cohorts match domain outputs |
| M4 [#29](https://github.com/casterkay/AlphaMeme/issues/29) → M3 | Request-level live timing spike | Real timings, revision/config, slow-read/429 results |

Proposed replacement M3 milestone text:

> Deliver the complete private-chat Telegram interface: authorized durable
> commands and callbacks, atomic onboarding and encrypted credentials, every
> primary panel in Chinese and English, manual review and records/export,
> persistent live collection, seven-window outcome statistics, and action-required
> notifications. Demonstrate web behavior parity, durable recovery, stale-action
> rejection, quiet routine updates, bounded delivery uncertainty, and measured
> live timing. Dependencies: M0–M2 contracts and Ed25519/platform spikes.

Move #26–29 without duplicating or renumbering them. Retire the emptied M4
milestone after the move is approved; retain M5 release/migration/security work.
Update refactor-plan §8 and affected issue dependencies together with that move.
Do not mark M3 complete by rendering placeholders for its newly included features.
Implementation adopts this scope; GitHub #26–29 now belong to M3. Deployed
timing acceptance remains open and M3 must not be marked complete before it passes.

### Design decisions that complete the existing contract

- Native Telegram text messages, inline keyboards, command menu, ForceReply
  inputs and a JSON document. No Mini App, custom web dashboard, chart image
  service, or new trading actions.
- Chinese is the default; `/lang en` selects English and `/lang zh` Chinese.
  Add `/lang` and `/cancel` to #22's command registration; `/lang` is already
  required by refactor-plan decision 10 but absent from its command table.
- Sessions and action buttons last at most 15 minutes. Input prompts last 5
  minutes, bounded by their parent session. Successful interaction can issue a
  fresh 15-minute session/button set; it never extends an old button's validity.
- Use UTC explicitly for bot-authored timestamps: Telegram does not supply the
  owner's timezone. Never infer timezone from language. Timezone settings are
  outside M3. Relative ages always say “at snapshot”; messages are not clocks.
- New tenants inherit the configured initial chain (currently Robinhood), not a
  newly invented Solana default. Notifications default off, matching the web;
  connection success offers an explicit enable action. Live starts with `/feed`.
- No product screen shows database IDs, epochs, raw revisions or update IDs.
  Evidence identity is bound internally and described as “Evidence updated at
  {time}” on screen. The full contract address is a public token identifier and
  is displayed in token details.

## 2. Navigation and native Telegram presentation

```text
/start or /radar → Overview
  ├─ Live feed → View chain / Order / Search → Live token detail → Queue audit
  ├─ Audits → View chain / Filter / Order / Search → Token detail
  │                                                ├─ Evidence pages
  │                                                ├─ Manual mark
  │                                                └─ Favorite / Note
  ├─ Statistics → View chain / Window / Cohort → Coverage details
  ├─ Saved → Search / Kind → Token detail (including historical records)
  ├─ Events → Chain / Type → Token detail when identifiable
  ├─ Status → Source detail / Delivery issues
  └─ Settings → Scan chains / Connection / Pause / Notifications / Language / Export
                └─ Onboard → Public key → Key submission → Verification result
```

Every root command creates an independent message session. Navigation inside that
session edits its message. A detail page remembers its immediate origin, including
chain, filter, sort, query and page. A Home button returns to that session's
overview. A new command does not reset another message's view.

Each screen consists of a bold title, scope/status, content, a snapshot footer,
then an inline keyboard. Examples below show one keyboard row per bracketed line;
`|` separates buttons. No simulated tabs, dropdowns or switches inside Telegram:
these are selector messages and explicit set actions. Use two buttons per row by
default, three only for compact navigation or chain choices. Long English labels
get their own row. Fonts, bubbles, colors and physical button heights belong to
the Telegram client, not to the bot specification.

Telegram message text must fit its 4,096-character limit after entity parsing;
use a conservative 3,500 UTF-16-code-unit text budget. Build escaped HTML from
structured blocks with `<b>`, `<code>`, `<pre>`, `<a>` and newlines. Never slice a
rendered HTML string. Use a maximum 900-unit document caption. Callback data is
ASCII `cb:<opaque-id>` and at most 64 UTF-8 bytes. External links use native URL
buttons; suppress link previews. Omit unavailable actions rather than inventing
disabled-button behavior. Explain the missing action in the message.

Lists contain five tokens per page. Events contain the latest 12 entries per
logical page, divided further if required by message length; show visible ranges.
Evidence is block-paginated. Repeat identity, audit age, disposition and counts of
failed/unknown checks on every evidence page. All critical evidence must remain
reachable; never silently cut off failure/unknown arrays to make text fit.

## 3. Command contract

Commands are lowercase and identical in both languages. Register localized
descriptions through `setMyCommands` (default Chinese and English language scope);
tenant language controls actual replies, regardless of Telegram client locale.
All root panels have inline navigation, even empty/error panels.

| Command | Chinese / English menu description | Exact result |
|---|---|---|
| `/start`, `/radar` | 雷达总览 / Radar overview | First-run explanation or current overview; no silent live/notification enable |
| `/help` | 帮助与密钥安全 / Help and key safety | Paged command help, privacy and read-only notice |
| `/status` | 运行状态 / Service status | Persisted scan/source/live/delivery state |
| `/settings` | 设置 / Settings | Operational settings; no scoring threshold editor |
| `/chains` | 选择扫描链 / Choose scan chains | Draft selection of 1–3 of seven chains, explicit Save |
| `/feed [chain\|off]` | 活跃榜与采集 / Live feed and collection | Open cached feed; valid chain sets the one subscription focus; `off` cancels subscription |
| `/audits`, `/candidates` | 近30分钟深审 / Audits from last 30 min | Same list, default all/newest, selected view chain |
| `/saved` | 收藏与备注 / Favorites and notes | All retained annotations, default all chains, newest annotation first |
| `/events` | 雷达事件 / Radar events | Latest 12 retained events, default all chains/types |
| `/stats` | 筛选后表现 / Post-screen performance | Selected-chain summary, never a cross-chain aggregate |
| `/note <symbol-or-CA>` | 编辑代币备注 / Edit a token note | Resolve token, show detail, then bounded reply prompt |
| `/export` | 导出记录 / Export records | Queue white-listed `meme-radar-records.json` document |
| `/onboard` | 连接GMGN / Connect GMGN | Create/reuse pending public key and show guide |
| `/setkey <key>` | 提交GMGN密钥 / Submit GMGN key | Sensitive intake, deletion attempt, asynchronous verification |
| `/pause` | 暂停扫描 / Pause scanning | Immediate durable pause; no confirmation step |
| `/resume` | 恢复扫描 / Resume scanning | Resume scan and existing subscription if credentials usable |
| `/disconnect` | 断开并删除密钥 / Disconnect and delete key | Explicit command executes immediately; UI button first opens confirmation |
| `/mute`, `/unmute` | 关闭提醒 / Mute alerts; 开启提醒 / Enable alerts | Set notification preference; unmute establishes a fresh baseline |
| `/lang [zh\|en]` | 选择语言 / Choose language | No argument opens selector; valid argument persists preference |
| `/cancel` | 取消输入 / Cancel input | Clear pending input in replied-to session; without a reply clear all own pending inputs |

Unknown commands return help without changing state. Unsupported arguments give
syntax plus valid choices, not a silent default. `/setkey` without an argument
shows usage without resubmitting an old key. `/note` without a target opens a
target-input prompt. Plain text is processed only as a credential or a reply to a
matching prompt; otherwise show “Use /radar or reply to the requested message.”
Accept command mentions only for this bot's verified username.

## 4. Overview and service status

### Overview

Illustrative values in all examples are design fixtures, not observed market data.

```text
雷达总览 · Solana
扫描运行中 · GMGN 已连接 · 提醒已关闭

累计成功扫描 128 轮
本轮发现 84 · 初筛通过 11
近30分钟：深审 18 · 链上候选 4 · 有效人工通过 2
队列 9 · 当前到期 3

快照 2026-09-22 14:32:10 UTC
只读研究，不执行交易。
[活跃榜 | 近30分钟深审]
[表现验证 | 收藏与备注]
[雷达事件 | 运行状态]
[查看链：Solana | 设置]
```

The six metrics retain their distinct scopes. Recent rows satisfy
`auditedAt >= snapshotAt - 30 min`; the candidate count uses `backendDisposition`,
while manual count uses `effectiveStatus` at snapshot time. Manual approval does
not subtract from the on-chain candidate count. A chain-filtered audit list does
use effective status, matching the web: an approved token is in the approved
filter, not also the unreviewed on-chain filter.

First use shows no synthetic metrics: “连接 GMGN 后开始扫描。只读研究，不执行交易。” /
“Connect GMGN to start scanning. Read-only research; no trading.” Buttons:
`[连接GMGN / Connect GMGN] [语言 / Language] [帮助 / Help]` plus saved/status
navigation when retained data exists. Disconnected returning tenants can inspect
their old data with explicit timestamps.

### Status

```text
运行状态
扫描：运行中 · 当前链 Solana
来源：GMGN 正常 · DexScreener 部分可用 · GoPlus 正常
上次尝试 14:32:00 UTC · 上次成功 14:32:08 UTC
下轮计划 14:34:00 UTC
审计队列 9 · 到期 3 · 本轮成功 4 / 失败 1
活跃榜：Solana 采集中 · 上次成功 14:32:05 UTC
目标间隔 20秒 · 最近延迟 5秒（请求等待）
消息投递：1项需核对
快照 2026-09-22 14:32:10 UTC
[来源详情 | 投递问题]
[刷新 | 设置]
[返回总览]
```

Source details show each source's last attempt/success, supported coverage,
sanitized reason and next retry only if scheduled. “Unsupported” is distinct
from failure and from unknown. Present current persisted progress; do not port
the browser's inferred “possibly scanning” heuristic. Unknown timestamps read
“尚无记录 / No record”; an absent schedule reads “未安排 / Not scheduled”.

Delivery issues list message purpose, token/chain if relevant, attempt time and
“发送结果不确定 / Delivery unconfirmed” or a sanitized permanent failure. Provide
Open current panel and Refresh, not an automatic “retry everything” button.
Opening a new requested panel abandons neither the historical uncertainty nor
its accounting, but provides a new independent current view. Do not claim an
uncertain old message is current. M5's additional metrics remain M5; the minimal
state needed to describe live lag and delivery uncertainty is required in M3.

## 5. Live feed

```text
1分钟活跃榜 · Solana
后台采集中 · 快照 14:32:05 UTC（快照时5秒前）
排序：2–8万市值优先 · 搜索：无

1. ORBIT · 未审计
市值 $32.1K · 流动性 $8.4K · 1m成交 $12.2K
买/卖 24/18 · 聪明钱/持有人 3/412
价格变化 +2.4% / 20秒 · 币龄 18分钟

…同样格式，最多5条…
第1–5条 / 前15条 · 规范化榜单共42条
采集目标20秒；本消息仅在操作时刷新。
[1 ORBIT | 2 LUMA]
[3 PICO | 4 NOVA]
[5 MOON]
[查看链 | 排序]
[搜索 | 清空搜索]
[下一页 | 刷新]
[关闭采集 | 返回总览]
```

Use the existing normalized live snapshot, not extra per-token reads. Apply
search, then the existing order, then retain the web's top 15, then paginate five
at a time. Show normalized total and displayed scope separately. Search matches
name/symbol/address substrings case-insensitively, as the web does; identity
normalization still preserves Solana address case.

Orders are `priority` (priority band then volume descending), `volume` (1m
volume descending), `new` (only `newAt` within 10 minutes, newest then volume).
The “新 / New” badge lasts two minutes; it is not the ten-minute filter. Ties
retain source order. Missing numeric values display “未知 / Unknown”; a delta
without a comparable previous snapshot reads “暂无可比窗口 / No comparable window”.
Show its actual `deltaWindowMs`, not an assumed 20-second window.

Opening `/feed [chain]` establishes subscription intent even while paused or
unconfigured, but no polling starts until eligible. It never resumes a paused
scanner. Existing `/feed off` cancels that intent. No duplicate subscriptions:
the tenant has one focus chain. A normal View chain selector changes only this
panel's view; when it differs from focus, show “当前采集 Base；Solana 仅显示缓存 /
Collecting Base; showing cached Solana” and `[采集此链 / Collect this chain]`.
This explicit button changes the focus. Switching view never edits scan chains.

Live detail uses the same token-detail renderer with a live-origin context. It
adds `[申请深审 / Queue audit]` only when the original `auditRow`/`enqueueReview`
checks pass: current usable snapshot (not older than 60 seconds), authenticated
provider, enabled scan chain, original prefilter, no blocking hard rejection and
existing queue/budget eligibility. Recheck at click time. Report “已入队，等待额度 /
Queued; awaiting capacity”, never “audit passed”. Duplicate requests report the
existing queue state. Other details never expose this audit action.

Polling maintains a 30-second lease, advances `nextPollAt` from actual start +
20 seconds and coalesces missed slots. Cooldown and slow reads remain visible;
Refresh reads cache and cannot bypass the GMGN queue. A snapshot over 60 seconds
old retains its data with “数据已陈旧 / Data stale”; no cached snapshot means
“等待首次采集 / Waiting for first collection”. Restarts preserve delta baselines.

## 6. Recent audits and selectors

```text
近30分钟深度审计 · Solana
14:02:10–14:32:10 UTC
全部审计 · 最新优先 · 搜索：无

1. ORBIT · 待人工看X · 审计于14:30:10
市值 $32.1K · 流动性 $8.4K · 发现评分 76
失败0项 · 未知0项
2. LUMA · 等待复查 · 审计于14:29:02
市值 $45.0K · 流动性 未知 · 发现评分 69
失败0项 · 未知2项
…最多5条…
第1–5条 / 共18条 · 队列9 / 到期3
[1 ORBIT | 2 LUMA]
[3 PICO | 4 NOVA]
[5 MOON]
[查看链 | 筛选]
[排序 | 搜索]
[下一页 | 刷新]
[返回总览]
```

All filters are applied inside the current 30-minute range, including favorites
and ignored. `/saved` is the deliberate route to older records. Cutoff is based
on `auditedAt`, not discovery time. Re-evaluate relative time boundaries on each
interaction; stamp the new snapshot and do not mix old totals with new rows.

| Filter key | Chinese | English |
|---|---|---|
| `all` | 全部审计 | All audits |
| `chain` | 链上候选 | On-chain candidates |
| `waiting` | 等待复查 | Waiting for recheck |
| `passed` | 人工通过 | Manually approved |
| `ignored` | 已忽略 | Ignored |
| `rejected` | 已排除 | Rejected |
| `fresh` | 5分钟内审计 | Audited within 5 min |
| `favorite` | 收藏 | Favorites |

Sort choices: `audit_desc` 最新审计 / Newest audit; `score_desc` 发现评分 /
Discovery score; `market_desc` 市值↓ / Market cap ↓; `market_asc` 市值↑ /
Market cap ↑; `liquidity_desc` 流动性↓ / Liquidity ↓. Preserve `sortRows`
comparators, including the deep-security liquidity preference and source-order
ties; any legacy fallback used for ordering must not become a displayed value.

Selectors edit the same message, indicate current choice with `✓`, and include
Cancel/Back. Choosing filter/order/chain/search resets page to one. Previous and
Next appear only when valid. Page is clamped after deletions/expiry, with totals
recomputed. Back from details restores the prior query; it cannot resurrect rows
that have aged out. Empty filtered results offer Clear search, All audits and Back.

## 7. Token detail, evidence and manual review

### Summary card

```text
ORBIT · Solana · 待人工看X
CA: <full contract address in code>
市值 $32.1K · 流动性 $8.4K · 持有人 412
审计 2026-09-22 14:30:10 UTC · 快照时2分钟前
链上硬门通过；请人工查看X社区评论与回复。
人工标记：未标记 · 收藏：否

证据：通过17项 · 未通过0项
阻断未知0项 · 其他未知0项 · 来源冲突0项
GMGN 正常 · 第二源完整
人工通过不会改变筛选结果或执行交易。
[查看X | GMGN]
[官网]
[检查证据 | 第二源]
[人工通过 | 忽略]
[收藏 | 备注]
[刷新 | 返回深审]
```

The example's 17 is illustrative and corresponds to the current whitelist's 17
check keys; never copy the plan's hard-coded “16 checks” illustration. Derive
passed and not-passed counts from actual check keys. Unknown fields are a separate
dimension and must not be subtracted to invent a disjoint “failed/unknown” check
partition. Distinguish explicitly reported failure codes from boolean checks
that did not pass. Unknown never implies safe.

Only validated HTTPS external links are shown, without embedded credentials.
Resolve X handles using the existing reserved-path validation. Opening X does
not mean it was reviewed. Missing official links say so and omit the URL button.
Token names, symbols, notes, provider reasons and URLs all pass whitelist/
sanitization then HTML escaping; no raw provider object reaches a renderer.

### Evidence pages

| Page | Required information |
|---|---|
| Blocking findings | All failure codes mapped to readable reasons; blocking/other unknowns; early-exit and stale-rule reasons |
| Contract and supply | Open source, owner/mint/freeze authority, honeypot evidence, buy/sell tax, LP lock/burn, rug evidence |
| Holders and wallets | Top10/dev/insider/bundler/sniper rates; ordinary wallet count/rate; bot/linked rates; completeness, sampled count and unknowns |
| Price and sellability | Observation status, window/end time/freshness, 5m return/drawdown/volume evidence; chart/market behavior findings; empirical sell counts and evidence limitations |
| Second sources | DexScreener and GoPlus coverage/status/checked times; market values, fatal fields, unknown fields and every source conflict |

Each page provides Previous/Next, Summary and Back. Large groups split into
numbered subpages with actual item totals. Page changes never reread GMGN.
If a saved token has no remaining audit, show address, annotation and “审计快照已
不再保留 / Audit snapshot no longer retained”; allow favorite/note/unignore or
clear an old pass, but not a new approval or invented historical evidence.

### Exact manual-mark transitions

Persist one decision `passed | ignored | null`, `marked_at`, `review_revision`
and increasing `mark_version` per tenant/chain/address. Adapt `marked_at` to
the existing pure helper's `mark.at` at the storage boundary.

| Current mark | Offered write | Commit rule and visible result |
|---|---|---|
| None | Set passed | Nonempty current revision; same revision as button; chain disposition; audit age ≤10m; expected mark version matches |
| None | Set ignored | Explicit ignored decision; suppressed new-candidate alerts; “已忽略 / Ignored” |
| Passed, valid or invalid | Clear passed | No fresh-audit gate; preserve tombstone with incremented version |
| Passed | Set ignored | Replace decision with ignored, not a second flag |
| Ignored | Clear ignored | Explicit clear; does not restore a prior passed decision |
| Ignored | Approve | First clear ignored, then use a freshly rendered approval action |

Favorite is independent and never means approved. New approval is not authorized
by `canPass` alone: its existing true branch for an old passed mark permits
revocation, not creation. No approval if revision is missing.

Valid passed means matching revision, `now - marked_at < 24h`, chain disposition,
and audit age `<=10m`. At exactly 10m it is still valid; the next instant is not.
At 24h it is invalid. If a new audit changes revision, mark invalid immediately;
if revision is unchanged and evidence is fresh again, derive validity using the
same existing helper rather than inventing a permanent revoked state. The
original mark remains until explicit clear/replace.

Every action is set/clear, never toggle. Compare expected mark version in the
same transaction that writes the mark, completes inbox and creates card-update
intent. Two competing cards cannot overwrite a later decision. A stale callback
answers “证据或标记已更新，请查看当前卡片 / Evidence or mark changed; review the
current card” and renders current state without applying the old write.

Expiry and revision changes update every mapped detail/reminder card, including
muted tenants. Schedule time-based refresh at the first invalid instant even
without a new audit. In-flight old renders cannot erase a newer risk correction.
Records and decision evidence remain immutable; rendered Telegram messages are
replaceable projections, not the event history.

## 8. Saved records, search, notes and export

Saved defaults to all annotated tokens across chains, ordered by `updatedAt`
descending. Filters: All records / Favorites / With notes; optional View chain
includes All chains. Five records/page; each includes symbol if known, chain,
short CA suffix for disambiguation, favorite state, note preview and audit age.
Detail always displays full CA. Missing audit evidence does not hide a saved item.

Favorite actions explicitly set true/false and preserve the latest note. Note
writes preserve the latest favorite. Use an annotation version in a documented
preferences namespace (or a versioned schema migration) to reject conflicting
same-field edits across sessions; compare it in the write transaction. Do not
send a stale full annotation from the panel back over current state.

Existing limits remain: 50 favorites, 500 annotation records, 500 UTF-16 code
units per note (`note.length` semantics). Report the specific limit and offer
Saved; never evict records. Empty trimmed note plus not-favorite removes the
annotation, retaining any required version tombstone. Clearing a note is explicit.

Search and note flow:

1. Persist `pendingInput` with type, prompt message ownership, target/query
   context, expected version, creation and expiry. Send a separate ForceReply
   prompt; it cannot share an inline keyboard. The panel exposes Cancel input.
2. Search prompt: “请回复此消息，输入名称、简称或CA（最多128字符）。/cancel 取消。” /
   “Reply with a name, symbol or contract address (max 128 characters). /cancel.”
   Match substrings of the current panel's available dataset; no remote lookup.
3. Note prompt identifies chain/full CA and displays existing sanitized note:
   “请回复此消息，输入备注（最多500字符）。/cancel 取消。” /
   “Reply with a note (max 500 characters). /cancel.”
4. Require matching owner/chat/reply-to prompt and live session. Validate length;
   on error retain input until expiry. Commit valid input and consume it once;
   update original panel with “已保存 / Saved” only after persistence.
5. Credentials take precedence over text inputs. Any credential-shaped text is
   diverted to protected intake or rejected/deleted as sensitive, never stored
   in query/note. Commands are routed as commands, not captured as input. A
   cancelled, expired, duplicate or mismatched reply cannot modify a record.

`/note` resolves over retained candidates/live/annotations. Prefer exact full CA
or exact symbol, otherwise offer matching names; zero matches gives “未找到，请从
列表选择代币 / Not found; choose a token from a list”. Multiple matches always
open a chain/symbol/address picker, including same-address multi-chain matches.
No arbitrary new token is audited as a side effect of entering an address.

Export is all retained tenant records across supported chains, independent of
the current filters. Preserve the existing white-listed per-chain export fields,
outcomes, annotations and add white-listed manual marks including original time,
revision and computed effective state. Add schema version and `exportedAt`.
Do not export tenant/chat/user/internal IDs, credentials, private/public onboarding
material, raw responses, inbox/outbox payloads or session queries. Revision is
allowed machine-readable evidence in export, not a product-screen identifier.
Persist a consistent sanitized export snapshot for retries, then send via
`sendDocument` as `meme-radar-records.json`. Confirmation reads “导出文件已准备 /
Export prepared” until delivery is known. Fail explicitly if it exceeds the
configured Telegram upload bound; never truncate records or invent a public link.

## 9. Statistics

```text
筛选后表现验证 · Solana
影子观察，不代表可成交收益。
链上通过组：跟踪86个历史样本
平均观察收益：
30分钟 +4.2% · 完成54
1小时 +3.1% · 完成51
2小时 +1.8% · 完成48
24小时 暂无 · 完成0
50样本门槛：30m已达；2h、24h未达
整体调参门槛：未达
快照 2026-09-22 14:32:10 UTC
[查看链 | 窗口：30分钟]
[组别：通过组 | 覆盖详情]
[刷新 | 返回总览]
```

The home summary retains `summarizeOutcomes`' passed-group tracked count and four
averages/completed counts. Selecting a group/window opens the detail view; it
does not silently relabel the fixed overview as a different cohort.

Window selector: 5m, 15m, 30m, 1h, 2h, 6h, 24h. Group selector: On-chain passed /
Rejected control / Compare. “Passed” means `initialDecision === X_REVIEW`, never
manual approval; rejected means the original `HARD_REJECT` sampled control.
Changing present disposition does not rewrite historical cohort membership.

Details show `eligible`, `completed`, `missing`, median and positive-return
percentage for the selected window/cohort from `outcomeCoverage`. Compare stacks
the two cohorts for the same window/chain. The seven-window overview is paged,
not cut off. Do not fabricate a 6h mean: the current summary projection supplies
6h coverage but no 6h average, and the design needs only the existing coverage
metrics there. Missing results never enter averages as zero. Eligibility begins
at baseline + horizon; the existing collector's additional 60-second delay can
legitimately produce temporary missing counts.

The backend's overall `calibrationReady` requires all required windows
(30m, 2h, 24h) to have at least 50 completed samples. The web also names each
individually ready window. Show both levels explicitly; one ready window must
not become an “overall ready” claim. Other windows remain observations and do
not redefine that gate. Empty eligible cohort: counts 0, rates/median “暂无 / No
samples”. Unavailable state: all values “不可用 / Unavailable”, not zero.

## 10. Events

Latest 12 retained events, newest first; include exact time, chain, readable type
and sanitized factual message. Default all chains/types; filters are All /
Candidates / Risk changes / Service, with explicit mapping to domain event types.
Unrecognized types remain visible under All using a safe “其他事件 / Other event”
label. Do not infer a new domain event from a translated string.

Each token-related row gets a numbered detail button only when chain/address
resolve; service events link to Status. Back restores filters/page. No events
means “尚无事件 / No events yet”, with Refresh and Home. The event record remains
historical; opening its token shows current evidence with a new snapshot time.
Routine events never produce unsolicited messages.

## 11. Settings, chain selection and control semantics

```text
设置
扫描链：Solana、Base（2/3）
GMGN：已连接 gmgn_****
扫描：运行中 · 提醒：已关闭
活跃榜：Solana 后台采集中
语言：中文
[选择扫描链 | GMGN连接]
[暂停扫描 | 开启提醒]
[语言 | 导出记录]
[运行状态 | 返回总览]
```

Scan-chain picker shows all seven (`sol`, `bsc`, `base`, `eth`, `robinhood`,
`arc`, `stable`) in catalog order and a session-local draft. Each button encodes
explicit Add or Remove for the current draft/version. Save validates 1–3 unique
chains against `setChains`; Cancel discards. At zero/four selections explain the
limit and do not commit. Viewing a disabled chain is allowed and does not enable
its scanner. Saving does not change this session's view or live focus; a now
disabled focus can still collect discovery, but audit requests explain that
scanning must be enabled. Keep provider cooldown across every control change.

| Action | Scanner | Live subscription / polling | New proactive alerts | Stored credentials/history |
|---|---|---|---|---|
| Pause | Stop new work; invalidate affected in-flight effects | Retain subscription, stop renewal/polling | No new scan findings; existing eligible policy still applies | Retain |
| Resume | Run if usable credentials | Resume only an existing subscription | Respect notification preference and current eligibility | Retain |
| Feed off | Unchanged | Clear subscription, stop renewal | Scanner alerts remain possible | Retain |
| Mute | Unchanged | Unchanged | Suppress all ACTION_REQUIRED | Retain; corrections and responses still work |
| Unmute | Unchanged | Unchanged | New baseline, no replay of old candidates | Retain |
| Disconnect | Disable and cancel old credential work | Clear subscription | Cancel invalid candidate work; do not alert about intentional disconnect | Delete API/signing/pending keys; retain research records |

Pause is not mute. Muting is not pause. Disconnect is not deletion of saved
research. Confirmation UI for the Disconnect button states those effects, with
`[断开并删除密钥 / Disconnect and delete key] [取消 / Cancel]`. The direct
`/disconnect` command already expresses explicit intent and executes immediately.
Regenerate public key also gets a confirmation explaining that the previous
pending public key stops being usable. No extra confirmation for harmless
navigation, pause, mute, favorites or clearing manual marks.

## 12. GMGN onboarding and connection states

Keep connection status orthogonal to pending setup. An existing active connection
can remain usable while a replacement key is pending or verification fails.

| State | Chinese / English | Actions |
|---|---|---|
| Unconfigured | 尚未连接GMGN / GMGN not connected | Connect, Help, Back |
| Preparing | 正在准备公钥 / Preparing public key | Status, Back; do not claim a key exists yet |
| Pending public key | 公钥已准备，请创建API Key / Public key ready; create API key | GMGN API management URL, Regenerate, Help, Back |
| Verifying | 正在验证只读权限 / Verifying read access | Status, Disconnect/cancel connection work |
| Waiting for quota | 等待请求额度，尚未验证 / Waiting for request capacity; not verified | Status, Disconnect |
| Verified | GMGN已连接 gmgn_**** / GMGN connected gmgn_**** | Overview, Scan chains, Feed, Enable alerts if muted |
| Invalid replacement | 新密钥验证失败；原连接保持原状态 / New key failed verification; prior connection unchanged | Retry with a new submission, Guide, Status |
| Expired submission | 密钥验证已超时，请重新提交 / Key verification expired; submit again | Guide, Status |
| Auth failure | 密钥不可用，请重新连接 / Key unavailable; reconnect | Onboard, Status |
| Decryption/state failure | 连接状态不可读取，请联系部署方 / Connection state unreadable; contact operator | Status, Help; no automatic overwrite/reset |

Onboarding message:

```text
连接 GMGN · 第1步：创建 API Key
1. 打开GMGN API管理，按要求粘贴以下公钥。
2. 创建只读Key后，回复 gmgn_… 或发送 /setkey <key>。

<SPKI PEM public key in preformatted text>

API Key明文会经过Telegram并可能留在聊天记录中。
我们会尝试删除含Key消息，但无法保证删除。请自行检查并删除。
服务端只保存加密Key；回显仅显示 gmgn_****。只读，不执行交易。
[打开GMGN API管理]
[重新生成公钥 | 帮助]
[返回设置]
```

English required copy:

> Create a read-only API key in GMGN API management using this public key when
> requested. Send the key starting with gmgn_ or use /setkey <key>. Your plaintext
> key passes through Telegram and may remain in chat history. We try to delete
> the message but cannot guarantee deletion; check and delete it yourself. The
> service stores the key encrypted and only displays gmgn_****. Read-only; no trades.

URL: `https://gmgn.ai/ai?tab=api_management`. Repeated `/onboard` reuses the same
pending public key. Reopening a guide is not rotation. Regenerate is bound to the
pending generation and atomically invalidates old verification. A `/setkey`
received without a pending or active signing setup is deleted/scrubbed and gives
“先使用 /onboard 创建绑定公钥 / Use /onboard to prepare your public key first”; it
is never silently attached to an unprepared generation.

Sensitive intake precedes search/note routing. Persist only encrypted candidate
key and minimum source IDs; candidate key expires 15 minutes after receipt.
Independently attempt message deletion; if forbidden, show the generic residual
risk reminder without echoing the message. Normalize and verify via the existing
lightweight read method in the same serialized GMGN admission queue. Success
must still match pending generation, connection generation and command state.
Activate API key and signing key atomically, then render success. Delayed success
after disconnect/regenerate cannot restore an old connection. Failed replacement
preserves prior state. A pause during verification remains paused after success;
successful onboarding does not silently enable notifications or live collection.

## 13. Notifications and safety corrections

All interactive replies/exports are USER_RESPONSE and work while muted. Background
notification generation is an allowlist, with durable classification/reason and
send-time eligibility checks; neither event existence nor an outbox row grants
notification eligibility by itself.

| Trigger | Presentation |
|---|---|
| Newly qualified X_REVIEW, original `voiceEligible`/snapshot gate, not ignored | ACTION_REQUIRED summary, at most one new-candidate batch/minute; token buttons |
| Risk/evidence worsens for a previously alerted, approved or favorite token | Correct all mapped cards first; eligible new ACTION_REQUIRED notice names the specific change |
| Key unusable, unrecoverable state, delivery uncertainty exhausted | One ACTION_REQUIRED notice per unresolved problem, with actual next action |
| Revision changes or manual-pass expiry on a shown token | PANEL_UPDATE: silent edit, even muted; no automatic replacement send on edit failure |
| Rank changes, ordinary wait/reject, samples/returns, scan summaries, recoverable 429 | No proactive message; show on requested panels |

New-candidate batch example:

```text
需要人工查看 · 2个代币
1. ORBIT · Solana：链上门槛已通过，请核验X评论与回复。
2. LUMA · Base：链上门槛已通过，请核验X评论与回复。
发现于 14:32 UTC · 不代表买入建议
[1 ORBIT | 2 LUMA]
[近30分钟深审 | 关闭提醒]
```

Batch summaries never claim continuing manual approval. Detail cards carry full
evidence and their own mapping. Preserve 30-minute event deduplication and the
24-hour new-candidate notification suppression. Risk revisions independently
schedule corrections; do not reuse new-candidate eligibility to suppress them.
Freeze batch membership/identity before dispatch; cancel stale batches and create
a new logical batch if needed, never mutate an ambiguous retry's membership.

Initial start, reconnection, resubscription and unmute establish the specified
quiet baseline and cancel stale candidate notifications. Restoring an evicted DO
restores its existing baseline and pending eligible work. No catch-up broadcast.
Recovery of a service issue updates its existing issue/card, not a new broadcast.

## 14. Bilingual vocabulary and exceptional states

All static titles, button labels, prompts, placeholders, command descriptions,
errors and success messages have `zh` and `en` dictionary entries. Known reason
codes get translated; third-party names/notes remain user content. An unknown
reason code shows a safe localized “证据不完整，请查看来源 / Incomplete evidence;
check the source” plus the sanitized available detail, never an invented cause.
Long English labels may use more rows; information and available actions match.

| Key / condition | Chinese | English | Recovery |
|---|---|---|---|
| `state.on_chain` | 链上候选，待人工看X | On-chain candidate; review X | Details / X |
| `state.waiting` | 等待复查 | Waiting for recheck | Evidence / Refresh |
| `state.rejected` | 已排除 | Rejected | Evidence |
| `state.manual_passed` | 人工通过 | Manually approved | Undo approval |
| `state.ignored` | 已忽略 | Ignored | Stop ignoring |
| `state.mark_expired` | 原人工通过已失效：{reason} | Prior approval is invalid: {reason} | Current evidence / Undo |
| `data.unknown` | 未知 | Unknown | Evidence |
| `data.no_samples` | 暂无样本 | No samples yet | Refresh / Back |
| `data.no_matches` | 没有符合条件的记录 | No matching records | Clear search / Reset filter |
| `data.stale` | 数据已陈旧；更新于{time} | Data stale; updated {time} | Refresh cache / Status |
| `data.partial` | 部分证据缺失，未视为通过 | Some evidence is missing; not treated as passed | Evidence |
| `control.paused` | 扫描已暂停，保留历史数据 | Scanning paused; history retained | Resume / Back |
| `provider.cooldown` | 请求额度受限，等待至{time} | Rate limited; waiting until {time} | Status / Back |
| `provider.auth` | GMGN密钥不可用，请重新连接 | GMGN key unavailable; reconnect | Onboard |
| `input.expired` | 输入已过期，请重新打开 | Input expired; reopen it | Reopen / Cancel |
| `callback.expired` | 按钮已过期，请重新打开面板 | Button expired; reopen the panel | Root command |
| `callback.changed` | 内容已更新，旧操作未执行 | Content changed; old action was not applied | Current panel |
| `write.failed` | 未能保存，请重试 | Could not save; try again | Retry fresh action |
| `delivery.unknown` | 消息发送结果不确定，请核对 | Message delivery unconfirmed; check it | Open current panel |
| `readonly.notice` | 只读研究，不执行交易；非投资建议 | Read-only research; no trades. Not investment advice. | Help |

Use sign-prefixed percentages, explicit USD, K/M display units with exact values
on evidence pages when available, and readable chain labels. Never round a
nonzero value into a misleading exact zero: use sufficient precision or `<…`.
Unknown and not-applicable are different. Language changes persist per tenant;
rerender the initiating panel and future interactions, not every historical
message. Existing buttons keep language-independent actions. Safety corrections
use the tenant's current language.

## 15. Interaction, storage and rendering contracts

### Authoritative state

Domain facts live in tenant SQLite. Sessions store navigation and input intent,
not duplicated candidate/outcome/connection truth. Telegram messages and
`message_map` are projections/delivery metadata. A whitelist DTO can preserve
validated field availability but must not become an alternative domain store.

`ui_sessions.query_json` is a versioned discriminated object, parsed once:

```text
schemaVersion: 1
filter, sort, search, page, detailSection, detailPage
cohort, horizon                     # only for statistics
returnTo: { panel, viewChain, query, snapshotAt }  # bounded navigation stack
selectedToken: { chain, address }   # only when a detail is displayed
draftChains, expectedControlEpoch  # only for scan-chain selector
pendingInput: { kind, promptMessageId, expiresAt, target, expectedVersion }
```

Return stack depth is bounded by the defined screen tree (at most four); replace
selector entries instead of accumulating an unbounded history. Token references
are identities, never trusted embedded evidence. Sanitized search is ≤128 units;
`pendingInput` contains no entered plaintext credential and no raw update. Sessions
expire at 15 minutes; expired sessions cannot authorize writes. Read-only reopening
creates a fresh session/version against current facts.

### Callback action families

| Actions | Required binding in addition to tenant/owner/chat/message/expiry |
|---|---|
| `panel.open`, `panel.refresh`, `panel.back`, `page.set` | Session + expected UI version; allowlisted destination/query |
| `view_chain.set`, `filter.set`, `sort.set`, `horizon.set`, `cohort.set` | Same; typed enum arguments |
| `input.begin`, `input.cancel`, `search.clear` | Session; kind and allowed target |
| `mark.set_passed`, `mark.set_ignored`, `mark.clear` | Token; current review revision; expected mark version; current gate for creating pass |
| `favorite.set`, `note.clear`, `note.begin` | Token; annotation concurrency version; explicit desired value |
| `audit.enqueue` | Token; live origin; snapshot identity; current admission/eligibility |
| `chains.draft_set`, `chains.save` | Draft/UI version; expected control epoch on Save |
| `scan.pause`, `scan.resume`, `live.set`, `notifications.set` | Explicit desired value and applicable control generation |
| `connection.disconnect`, `onboard.regenerate` | Connection generation; pending generation for regeneration |
| `language.set`, `export.create` | Session/version; validated language or export scope |

Opaque IDs contain no CA, API key or tenant claim. Resolve within the tenant
derived from Telegram's private-chat envelope. Each session version produces
fresh shortlinks bound to the eventual Telegram message ID. A sent message can
be clicked before the sender persists its ID: reject as not yet ready and ask
for a fresh interaction; never loosen message ownership to handle that race.

Answer `callback_query.id` promptly after intake/validation, including expired
buttons, without promising write success before commit. M3 must retain this
Telegram callback identifier in minimal sanitized receipt metadata: the current
M2 parser only retains the opaque action ID. Failure to answer the transient
callback is recorded but cannot repeat the durable business mutation.

For valid callbacks, validate again inside the mutation transaction, update
session version/domain state, complete inbox, enqueue reply/correction together.
During external await, no SQL cursor remains open and no concurrency lock wraps
network work. Mismatched version returns current state; it never reinterprets an
old ordinal button against a newly sorted list. Every token button binds its
actual chain/address, not just row number.

### Input and delivery state machines

```text
Update → authorize → persist inbox + due work → ensure alarm → HTTP 2xx
Inbox: RECEIVED → RUNNING → DONE | FAILED | CANCELLED
External verification: save phase/generations → read → compare → atomic commit

Outbox: PENDING → SENDING → SENT
                       ├─ retryable rejection → bounded scheduled retry
                       ├─ permanent rejection → FAILED
                       └─ uncertain → UNKNOWN → one automatic ambiguous retry
                                                └─ uncertain again → suspended
```

Preserve independent credential/control message watermarks by `(message.date,
update_id)` and the plan's 15-minute age checks/7-day dedup tombstones. A callback's
originating message date is not the click time: use shortlink issuance/expiry for
callback age, not the old message date. Duplicate updates return existing outcome
and reconcile scheduling. Pausing/disconnecting never waits for slow Telegram or
GMGN calls. Local controls commit even when their reply cannot be delivered.

Renderers are pure over an immutable, validated snapshot and locale. Their result
contains text, keyboard action descriptors, view version and optional token
mapping; they do not fetch, write SQL or mint authoritative state. The controller
persists action bindings and outbox intents. Delivery rereads current validity;
session-version ordering protects navigation and domain revisions protect cards.
Serialize every edit for a message, not just token edits. UNKNOWN edits block
later edits on that same message until reconciled; show uncertainty in Status.

For clear rejections, proposed delivery policy is five total attempts within the
logical task's expiry, with 1/2/4/8-second backoff and bounded jitter; a Telegram
`retry_after` is a minimum and is never shortened. Stop if it exceeds validity.
All API calls have a 10-second timeout (document upload 30 seconds). Transport
timeout/disconnect is ambiguous, not a clear rejection. The separate lifetime
`ambiguous_retries <= 1` ceiling always wins. Persist attempt counts before send.
These are delivery constants, not changes to GMGN timing or scoring policy.

“Message is not modified” confirms the intended version. A deleted interactive
message may be replaced only for an active user request. Failed background
corrections record an issue, never send repeated replacement cards. Leaving token
detail removes its message mapping; expired navigation can still receive safety
correction while the message continues to display that token. A scheduled
reconciler compares all mapped cards to current revision/effective mark state so
missed invalidation events do not preserve a falsely valid card indefinitely.

## 16. Known implementation seams, without hidden fallbacks

These are gaps between current code and the requested interface, not changes
implemented by this document.

| Observed gap / root cause | Required M3 treatment | Owner |
|---|---|---|
| `telegram-intake.mjs` is an M2 receipt stub: rejects credentials, drops command arguments and callback query ID, does not accept reply text | Extend the boundary for typed commands, protected credential intake, prompt replies and callback acknowledgment metadata; preserve authorization | #18/#19 |
| `publicCandidate` uses `finite(..., 0)` and `publicChecks` maps absent values to false | Add a validated availability-aware Telegram projection before coercion; distinguish not-passed checks from known failures; reuse whitelist, never read raw provider responses in renderer | #22/#23 |
| Current whitelist slices candidates/events/evidence collections | Paginate domain records then sanitize; add complete bounded evidence-page projection/counts; fail visibly on an unsupported cap rather than silently hiding findings | #22/#23 |
| Public status has web-specific local-machine errors and no UI session projection | Localize canonical states, expose current persisted progress and safe issue reasons; do not relabel unrecoverable corruption as auto-retry | #22 |
| SQL mark time is `marked_at`; pure manual helper expects `at`; `canPass` includes a revoke branch | Explicit adapter and separate create/clear predicates; no loosened scoring gate | #23 |
| Annotation writes accept full favorite/note objects without concurrency version | Transactional field-specific writes and persisted annotation version/tombstone; do not overwrite another session's edits | #22 |
| Schema v1 enforces exact table DDL and index set | Any structural addition requires an explicit versioned migration; use existing documented JSON containers where sufficient | #19–23 |
| Statistics' overall gate and per-window ready labels differ in scope | Render both exactly, including all-three-window overall readiness; no replacement formula | #28 → M3 |
| Live and stats are assigned to M4 while M3 promises complete panels | Move #26–29 into proposed M3 and update tracking before accepting M3 as complete | Milestone proposal |

Preserve the original seven chains, scanner scoring/classification, weighted
single-flight GMGN admission, outcome sampling, risk exclusion, time thresholds
and unknown-field semantics. Newly displayed availability must not alter whether
a token passes. Do not refactor unrelated legacy modules to implement a renderer.

## 17. Implementation order and file ownership

1. Finish M0–M2 prerequisites and #24 Ed25519 evidence. Reuse existing owner,
   scheduler, crypto and SQLite contracts; do not build a parallel control store.
2. #18/#19: validated webhook and durable inputs, then #20: delivery spine and
   callback acknowledgment. First slice is `/radar`, `/status`, `/pause` round trip.
3. #21/#25: onboarding and failure/recovery copy; verify a real isolated read key.
4. #22: pure bilingual renderer and sessions, overview/settings/chain controls,
   audits, selectors, inputs, saved/events/export. Add #23 cards and manual marks.
5. #26 → M3: cached feed presentation plus persistent collection and queue action;
   #28 → M3: outcome UI over the preserved cohort domain.
6. #27 → M3: allowlist, baselines, batch reminders and card reconciliation. Keep
   #23's expiry correctness and #20's revision delivery in their owning modules.
7. #29 → M3: measured timing, full interface acceptance and independent review.

Planned paths follow the refactor plan: `src/bot/{webhook,inbox,outbox,commands,
panels,notification-policy}.mjs`, `src/render/telegram.mjs`, and a small
`src/render/telegram-i18n.mjs` dictionary. Extend `src/render/whitelist.mjs` with
explicit safe projections. Use `src/auth/{connection,key-store}.mjs`,
`src/util/crypto.mjs`, `src/radar-agent.mjs`, existing scoring modules and storage
adapters. Do not duplicate the current intake parser after the boundary is moved;
update callers and remove the superseded interface in the same slice.

For multi-issue implementation, use one issue/branch/worktree and respect the
repository's independent-review contract. This design itself changes only docs;
it does not open PRs, post comments, reassign milestones, deploy or enable a bot.

## 18. Acceptance matrix and definition of done

| ID | Scenario | Required observable result | Issue / test owner |
|---|---|---|---|
| A01 | New private owner; group/channel/non-owner/inline-only callback | Private owner gets guide; rejected updates create no tenant or key | #18 / webhook |
| A02 | Duplicate/late/reordered updates; long idle then lower new update ID | Effects once, no credential/control rollback, no blanket max-ID discard | #19 / inbox |
| A03 | Storage/alarm failure before acknowledgment | No false HTTP success before durable receipt and scheduling | #19 / inbox |
| A04 | Every command, both locales, empty and populated fixtures | Correct panel/keyboard/copy; no internal identifiers or credentials | #22 / telegram-panels |
| A05 | Two independent panels; race page/filter buttons; DO reconstruction | No cross-session state; stale click cannot overwrite current view | #22 / telegram-panels |
| A06 | 30m/5m audit boundaries, every filter/order/search, Back after expiry | Web-equivalent rows/metrics; current totals; saved remains accessible | #22 / telegram-panels |
| A07 | Missing/false/zero values and early-exit audit evidence | Unknown differs from known zero/false; no hidden blocking items | #22/#23 / telegram-panels |
| A08 | Long multilingual text, HTML injection, malicious URL, many findings | Valid bounded HTML; all critical content paged; unsafe links absent | #22 / renderer |
| A09 | Stale revision/mark version, repeated approve/ignore/clear | Only valid set/clear commits; prior pass can always be cleared | #23 / manual-review |
| A10 | Exactly 10m then +1ms; exactly 24h; new revision; multiple cards; mute | Validity matches helper; all displayed cards corrected without new sends | #20/#23 / manual-review + outbox |
| A11 | Search/note wrong reply/session, expiry, command input, embedded key | No unintended write; no credential in notes/query/inbox plaintext | #19/#22 / inbox + panels |
| A12 | 51st favorite, 501st annotation, oversized note, racing note/favorite | Explicit bounds; field updates do not overwrite unrelated new state | #22 / panels |
| A13 | Ambiguous symbol/multi-chain CA; saved token without audit | Picker required; historical annotation available, approval unavailable | #22/#23 / panels |
| A14 | Repeated onboard; regeneration; bad key; disconnect during verify | Pending reuse; atomic swap; old connection preserved on failure; no resurrection | #21/#24 / inbox + crypto |
| A15 | Message deletion forbidden; expired verification; help in both languages | Generic residue warning, no key echo, encrypted candidate cleaned | #19/#21/#25 / inbox |
| A16 | Subscribe then 120s with no messages; eviction between polls | Persistent collection and delta baseline; no unsolicited rank messages | #26 / live-discovery |
| A17 | View-chain change, focus change, scan-chain Save, pause/off/mute | Each affects only the documented state; no hidden scan enable | #22/#26 / panels + live |
| A18 | Slow GMGN read/429; Refresh spam; duplicate Queue audit | Max in-flight 1, cooldown respected, visible lag, no burst catch-up or extra reads | #26/#29 / scheduler + live |
| A19 | All seven windows, both cohorts, missing samples, 49/50 gate boundaries | Existing summary/coverage values; all-three-window overall gate | #28 / panels + outcomes |
| A20 | Routine events/429/sample completion then eligible new candidate | Routine send count 0; actionable notice has reason and detail entry | #27 / notification-policy |
| A21 | First start/reconnect/resubscribe/unmute vs eviction | No backlog replay; eviction preserves eligible undelivered work | #27 / notification-policy |
| A22 | Send succeeds then local crash; second ambiguous attempt; old edit race | At most one UNKNOWN auto retry; suspend uncertain card; never claim newest remotely | #20 / telegram-outbox |
| A23 | Deleted card, permanent send failure, mute during queued alert | No background replacement spam; status exposes issue; invalid alerts cancelled | #20/#27 / outbox |
| A24 | Export under filtering, during updates, with secret-shaped notes | Consistent all-chain whitelist file, complete marks, no secrets/raw payload | #22 / panels + export |
| A25 | Lost invalidation event followed by reconciler | Derived card state converges or visible delivery issue remains | #20/#23/#27 / outbox |
| A26 | Real isolated deployment: normal/slow/429 live runs | Record deployed revision/config, request/lag/CPU/wall timings; assess spike limits | #29 |

Use hand-written provider/Telegram stubs and controlled clocks, plus real Workers
storage/alarm integration. Property-test callback/HTML boundaries and manual-mark
time/version invariants. The existing Node suite, Workers suite and
`npx wrangler deploy --dry-run` are required at implementation completion;
simulated checks do not replace the Ed25519/live platform evidence. M3 must not
claim timing success until #29 has measurements and any material result is resolved.

Design validation performed for this document: milestone/issue inventory read
from GitHub; web/scoring/storage/intake source inspection; command-to-screen and
issue-to-acceptance mapping. These are design checks, not passed runtime tests.
