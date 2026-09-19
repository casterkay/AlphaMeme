# meme-radar → Cloudflare Worker + Telegram 重构计划

> 本计划只改本仓库（meme-radar）。不涉及 MemeHarness。
> 目标：把本地只读 Node web 应用，重构为 Cloudflare Worker 服务，Telegram bot 作为唯一用户界面。
> 状态：设计稿，已纳入本轮评审修订；本次只更新计划，不代表实现或平台 spike 已通过。

## 0. 已确认的决策

| # | 决策 | 含义 |
|---|---|---|
| 1 | 租户边界从第一天写进数据模型 | 所有表带 `tenant_id`，DO 按租户命名（`idFromName('radar:'+tenantId)`）；当前只跑一个租户，但模型按多租户隔离设计 |
| 2 | GMGN key 由用户经 `/onboard` 上传，后台自动 onboard | 生成公钥 → 用户去 `https://gmgn.ai/ai?tab=api_management` 建 Key → 回传 Key → 后台验证并加密存储（**不再走 Worker secret**） |
| 3 | Ed25519 onboarding 保留 | `/onboard` 在 DO 内生成本租户 Ed25519 密钥对，公钥发给用户；私钥只存本租户 DO |
| 4 | 保留 20s 后端轮询 | 保留 20 秒目标间隔与 30 秒 lease；Telegram 持久订阅替代浏览器心跳续租，限流或慢请求造成的延迟显式记录（见 §4.1） |
| 5 | Telegram 原生通知替代语音 | 删除 Web Speech 语音模块与桌面提醒，改用 Telegram 推送 |
| 6 | 保留 7 条链 | sol / bsc / base / eth / robinhood / arc / stable，扫描与判据逻辑不变 |
| 7 | 只改 meme-radar | 不动 MemeHarness |
| 8 | 不遵守 EDITION-BOUNDARY.md | 我们不是原作者，该文档的「专业服务不可接收用户 API Key」等约束不适用 |
| 9 | Telegram 复刻主要 web 界面，按需打开 | 活跃榜、表现验证、近30分钟深审等由 command 打开带 inline keyboard 的消息面板；仅需要人工查看的代币或信息主动推送，常规数据更新不推送 |

## 1. 铁律：什么必须原样保留

这次是**运行时与 UI 重构，不是产品逻辑重构**。以下一律原样移植，行为不变：

- `scoring.mjs`：`discoveryScreen` / `deepScreen` / `analyzeWallets` / `observeFiveMinutes` /
  `marketBehaviorScreen` / `empiricalSellability` / `knownRiskReasons`（含全部阈值与「未知字段永不通过」语义）
- `chart-risk.mjs`：`CHART_RISK_VERSION`、`chartRiskScreen`、`applyRiskExclusion`（版本失效语义）
- `outcomes.mjs`：7 个 horizon、`sampleRejected`（SHA256 mod 5 对照组）、`dueOutcomeJobs`、
  `collectOutcomeSamples`、`outcomeCoverage`、50 样本标定门槛
- `secondary.mjs`：DexScreener + GoPlus 两套规则、`buildConflicts` 冲突检测、FATAL 一票否决
- `scanner.mjs` 的循环语义：发现 → 初筛 → 建队 → 择时（紧急位 / 公平位）→ 深审 → 分类 →
  第二源 → 事件 → 影子样本；`reviewRevision`、`riskExclusions` 持久化、`classifyDeepResult` 的
  transient/unknown 分流、`mergeSecondaryClassification`
- `gmgn.mjs` 的限流模型：`requestWeight`（holders/traders 5、trenches 3、kline 2）、串行队列、
  `minRequestGapMs × weight × backoffFactor`、`nextAllowedAt` 冷却不绕过、TTL 缓存
- `live-discovery.mjs`：20s 目标轮询间隔、30s lease、1m trending、`normalizeLiveRows` 的过滤逻辑；
  lease 的续租责任从浏览器移到租户订阅调度器（§4.1），不依赖用户反复点刷新
- `public/index.html` 的人工标记：`passed` / `ignored`、撤销、revision 与新鲜度失效条件；
  从浏览器 localStorage 迁至租户持久状态（§5.2），不是仅搬 `RadarControls`

只换三样东西：

1. 运行时：Node 长驻进程 + `setTimeout` → Cloudflare Worker + Durable Object alarm
2. GMGN 传输：`child_process.execFile`（gmgn-cli）→ `fetch` 直连 OpenAPI
3. UI：浏览器（`public/` + `server.mjs` 路由）→ Telegram bot

## 2. 目标架构

```
Telegram  <── webhook(secret token) ──>  Worker fetch 入口 (src/worker.mjs)
   │  sendMessage / editMessageText            │
   └───────────────────────────────────────────┤
                                               ▼
                                    ┌──────────────────────────┐
                                    │ RadarAgent（每租户一个 DO） │
                                    │  ┌────────────────────┐  │
                                    │  │ 统一 alarm 调度器     │  │
                                    │  │  · 扫描循环(可恢复)   │  │
                                    │  │  · live 20s 轮询     │  │
                                    │  └─────────┬──────────┘  │
                                    │            ▼              │
                                    │  GMGN 串行队列 + 限流退避  │
                                    │  scoring/chart/outcomes   │
                                    │  secondary(DexS/GoPlus)  │
                                    │            ▼              │
                                    │  DO SQLite（状态/密钥/投递）│
                                    └──────────────────────────┘
                                               │
              GMGN OpenAPI (fetch, exist-auth) │  DexScreener · GoPlus
```

- 首版仅接受私聊；校验 `chat.type === "private"`、`String(from.id) === String(chat.id)`，
  已有租户还必须匹配 `owner_user_id`。群组、频道、匿名发送和无消息归属的 inline callback
  不进入租户命令处理。此规则是租户授权，不是注册门槛。
- 按租户分实例：`env.RADAR.idFromName("radar:" + tenantId)`，`tenantId = String(chat_id)`。
  每个租户一个 DO = 一个 GMGN 账户、一条串行请求队列、一套独立限流冷却。
  所有表仍显式带 `tenant_id`（租户边界从第一天写入数据模型，防串数）。
- 唯一租户调度钟 = DO alarm，统一安排扫描、live、命令续跑、outbox 重试与卡片过期刷新。
  GMGN 冷却只约束 GMGN 工作，不阻塞 `/status`、暂停、断开或 Telegram 投递。
- alarm 是持久调度，正常 eviction 不会删除 alarm。每分钟 watchdog 只修复异常退出、
  重试耗尽或重排程失败后的缺失/过期调度，不把 `getAlarm() === null` 当作没有运行中工作。
- 新增一个 `TenantRegistry` DO，按 `tenant_id` 保存路由登记（不含密钥、候选或用户正文），
  cron 分页读取登记并有界调用 `wake()`；不能枚举各租户内部的 `tenants` 表。授权首次接入时
  先幂等登记再调用租户 DO，失败不确认该 update。遗留空登记由 `wake()` 安全忽略。
  `wake()` 依据运行中标记与持久任务重算，不清除冷却，不恢复用户已暂停的扫描。

## 3. 文件级映射（保留 / 重写 / 删除）

### 3.1 原样移植（行为不变，只做 `node:crypto` → WebCrypto 等机械替换）

| 现文件 | 新位置 | 备注 |
|---|---|---|
| `src/scoring.mjs` | `src/scoring/index.mjs` | 纯函数，零 I/O；测试原样搬 |
| `src/chart-risk.mjs` | `src/scoring/chart-risk.mjs` | 同上 |
| `src/outcomes.mjs` | `src/scoring/outcomes.mjs` | WebCrypto 替换需传播 async 调用；拒绝组仍取 SHA256 **首字节** `% 5`，不能对整串 hex 取模；固定输入对照原实现 |
| `src/secondary.mjs` | `src/providers/secondary.mjs` | 已是纯 `fetch`，零改动 |
| `src/server.mjs` 的白名单部分 | `src/render/whitelist.mjs` | `toPublicStatus` / `publicCandidate` / `publicMessage` / `publicChecks` / `publicSecondary` / `publicError` 抽出；`Buffer` → `TextEncoder` |

### 3.2 重写 I/O 层（逻辑不变，载体换）

| 现文件 | 新位置 | 改什么 |
|---|---|---|
| `src/gmgn.mjs` | `src/providers/gmgn.mjs` | `execFile` → `fetch`；保留 `requestWeight`、串行队列、`nextAllowedAt`、`backoffFactor`、`cachedRead`、`discover`、`audit`、`priceAt`、`verifyApiKey`、错误翻译 `translateGmgnError` |
| `src/gmgn-readonly-worker.mjs` | 并入 `src/providers/gmgn.mjs` | 子进程桥删除；「只读白名单、无交易路由」这条不变量迁移为：只导出列明的 8 个数据读端点 + 读权限验证，类型/命名层禁止签名与下单 |
| `src/scanner.mjs` | `src/radar-agent.mjs`（DO 内） | `start()`/`stop()`/`switchChain`/`enqueueReview`/`cycle()` 的**调度部分**改用 alarm + 可恢复状态机；`cycle()` 内部判据调用不变 |
| `src/live-discovery.mjs` | `src/radar-agent.mjs`（DO 内） | `setTimeout` → alarm；20s 间隔、30s lease 与过滤保留；续租与请求级调度见 §4.1 |
| `src/gmgn-key-store.mjs` | `src/auth/key-store.mjs` | 文件系统 → DO SQLite 表 `keys`；Ed25519 生成走 WebCrypto（`crypto.subtle`），不支持则 `nodejs_compat` 的 `node:crypto`（见 §6） |
| `src/gmgn-connection.mjs` | `src/auth/connection.mjs` | `apply`/`disconnect`/`snapshot` 语义保留；`requestCycle` → `radarAgent.requestCycle()` RPC |
| `src/state.mjs` | `src/storage/radar-state.mjs` | `radar.json` → SQLite 表；`migrateState` 的「状态损坏即 fail-loud、不静默清零」语义保留 |
| `src/local-store.mjs` | `src/storage/store.mjs` + `src/storage/controls.mjs` | `atomicJson`/`readJsonWithBackup` → SQLite 事务；`RadarControls`（收藏/备注/链选择）→ 表 `annotations` + `preferences` |
| `public/index.html` 的人工标记函数 | `src/scoring/manual-review.mjs` + `src/storage/controls.mjs` | 提取 `backendDisposition` / `effectiveStatus` 与写入资格判断；标记写入 `manual_marks`，不随页面删除丢失 |
| `src/social.mjs` | `src/scoring/social.mjs` | 删 `execFile('agent-reach')` 的 `xCapability`；`socialGate` 保留（本就恒返回 `UNVERIFIED`，人工复核模式） |

### 3.3 删除（不再有本地运行时）

- `src/server.mjs` 的 HTTP 路由 / `isTrustedLocalRequest` / CSP / 安全头（白名单已抽出保留）
- `public/index.html`、`public/voice-alerts.mjs`、`public/voice-player.mjs`、`public/voice-ui.mjs`
- `src/windows-proxy.mjs`（Worker 无系统代理概念）
- `scripts/setup.mjs`、`scripts/open.mjs`、`scripts/supervise.mjs`、`scripts/wait-and-open.mjs`、
  `scripts/release-audit.mjs`（改为 Worker 版发布审计）
- `packaging/windows-portable/`、`安装并启动.bat`、`前台调试.bat`、`安装并启动.command`、
  `open-radar.command`、`start-radar.command`、`START-*.bat`、`START-HERE-WINDOWS.bat`、`TEST-WINDOWS.bat`
- `README-WINDOWS.txt`（合并进 README）

### 3.4 新增

- `wrangler.jsonc`：Worker 配置（name / main / compatibility_date / secrets 占位 / cron）；
  `RADAR → RadarAgent`、`TENANT_REGISTRY → TenantRegistry` 两个 binding，首次迁移将两类
  都列入 `new_sqlite_classes`；Worker 入口导出两类
- `src/worker.mjs`：入口——webhook 路由、operator HTTP（`/health`、`/status`）、cron `scheduled()`
- `src/radar-agent.mjs`：Durable Object（调度器 + 扫描状态机 + live 轮询 + 投递决策）
- `src/storage/schema.mjs`：版本化 SQLite DDL 与迁移
- `src/tenant-registry.mjs`：watchdog 使用的租户路由登记
- `src/bot/inbox.mjs`：update 持久接收、去重、命令恢复与加密敏感载荷
- `src/render/telegram.mjs`：Telegram HTML 渲染 + 内联键盘 + 候选卡排版 + 分片
- `src/bot/panels.mjs`：主要面板、分页/筛选/排序/搜索、导航与交互会话
- `src/bot/notification-policy.mjs`：仅需人工处理事项的推送 allowlist 与去重
- `src/bot/webhook.mjs`：update 解析、`X-Telegram-Bot-Api-Secret-Token` 校验、命令/回调路由
- `src/bot/commands.mjs`：命令与 callback 处理器
- `src/bot/outbox.mjs`：投递队列、event 去重、`message_map`、revision 编辑、退避重试
- `src/util/crypto.mjs`：SHA256 字节/hex、Ed25519 与 AEAD 加密封装
- `scripts/migrate-local-state.mjs`：一次性离线迁移工具（非应用运行时），见 §4.4

### 3.5 保留不动的非运行资产

- `.agents/`、`.claude/`、`.pi/` 下的 14 个 `gmgn-*` skills 与 `skills-lock.json`
  （这些是给**编码 agent** 用的，不是应用运行时依赖，与 Worker 无关）
- `LICENSE`（AGPL-3.0-only）、`THIRD_PARTY_NOTICES.md`、`SECURITY.md`、`CONTRIBUTING.md`
- `docs/EDITION-BOUNDARY.md`：不再作为设计约束（决策 8）。文件保留不删，但其「专业服务不可接收用户 API Key」等条目对本次重构无效。
- `test/` 中所有纯逻辑测试（移植后继续跑）

## 4. 三个运行时改造点

### 4.1 调度器：setTimeout → 统一 alarm 调度

原实现有两把钟：`scanner.start()` 的 `setTimeout`（`scanIntervalMs / 链数`）和
`live-discovery.arm()` 的 `setTimeout`（20s），共享同一个 `gmgn.nextAllowedAt` 冷却。

Worker 版合并为**一个调度器**（DO 内）。冷却时间是请求准入下界，不是独立任务：

```js
// 伪代码。tasks 由持久任务恢复；无工作时不保留过期时间戳。
function nextDue(now, tasks, gmgn) {
  const due = tasks.filter(t => t.enabled && !t.running).map(t => {
    const providerReadyAt = t.needsGmgn
      ? Math.max(gmgn.nextAllowedAt || 0, gmgn.spacingReadyAt || 0) : 0;
    return Math.max(now, t.dueAt, providerReadyAt);
  });
  return due.length ? Math.min(...due) : null;
}

async alarm() {
  // 一个调度步至多一个有超时的外部请求，或一个有界本地事务。
  // selectReadyTask 与准入预留在首个 await 前完成。
  try { await this.runOneReadyStep(); }
  finally { this.recomputeAlarm(); } // 无任务则 deleteAlarm，否则 setAlarm(nextDue)
}
```

- `nextAllowedAt = 0` 或已过去的冷却不得单独触发 alarm；未来冷却必须推迟所有 GMGN 读，
  包括验证新 Key。暂停/未配置时从可运行集合排除扫描和 live；命令与投递仍可运行。
  `/status` 与暂停/断开等纯本地控制在 RPC 内有界提交，不等待 alarm 中正在进行的网络读；
  其余命令的外部 I/O 由同一调度器续跑。
- 成功一步必须推进 checkpoint 或任务到期时间；失败必须持久化退避时间，再重排 alarm，
  不能把失败任务留在 `dueAt <= now` 造成空转。崩溃由平台重试/`wake()` 从持久记录恢复。
- 同时到期先处理暂停/断开等本地控制，再处理到期 live；其余命令续跑、扫描、outbox
  公平轮转。不得提前排入整批深审请求占满 provider 队列；低优先级工作记录等待时长。
- `outbox.next_at`、inbox 重试与卡片失效刷新都进入调度集合，不能依赖下一轮扫描唤醒。

**扫描循环可恢复化：**

保留现有判据、静态证据早退、第二源合并、紧急位/公平位及周期预算；把外部 I/O 拆到请求级：

```
DISCOVER(request_i) → SCREEN → BUILD_QUEUE
→ AUDIT(token_i, endpoint_i；静态证据齐备后判断是否早退)
→ SECONDARY(source_i) → CLASSIFY_AND_COMMIT
→ OUTCOMES_SAMPLE(job_i) → SUMMARIZE
```

- `cycle_checkpoint` 保存 `cycle_id`、链、`key_epoch`、控制代际 `control_epoch`、阶段、
  token/endpoint 游标、周期 deadline、响应采集时间和半成品。DO 重建不重置周期预算。
  过期证据按现有新鲜度规则处理，不能把恢复前后的数据伪装成同一时刻的新证据。
- 每次请求完成后持久保存响应或规范化错误、端点游标和 provider 状态，再调度下一步。
  完成一个 token 的分类时，在**同一个 SQLite 同步事务**内提交候选、audit_queue、
  risk_exclusions、outcome 初始基线/最新判定、events、outbox 意图和 checkpoint 推进。
  使用 `ctx.storage.transactionSync()`，事务中不做网络 I/O；不能先写候选、随后单独写事件。
- `(tenant_id, cycle_id, chain, address, effect_type)` 派生稳定 effect/event ID；重试 upsert
  不重复事件、不重置 outcome baseline。事务提交前崩溃全部回滚；提交后崩溃从新游标续跑。
  外部只读请求可能重复，业务副作用不可重复。outcome 每个 horizon 的样本/重试状态也与游标同事务。
- GMGN 持久状态包括 `nextAllowedAt`、`backoffFactor`、`lastRequestAt`、`lastWeight`、
  `successStreak`、`spacingReadyAt` 与 `keyEpoch`；请求发出前先持久预留间隔。
  响应中的 429 冷却必须先落盘，再准入下一请求；重启或换 Key 不缩短已知冷却。
- `/pause`、`/disconnect`、切链与凭据切换递增相应代际；每次 await 返回和提交前校验。
  旧代际响应不得更新候选、重新激活凭据或生成新通知；已观察到的 provider 冷却仍保留。
  暂停会挂起扫描，恢复时重新验证 checkpoint；断开或切换凭据废弃旧代际半成品。
- DO 单线程不阻止网络 await 期间的其他 RPC 进入。provider 保留显式串行队列，
  所有读（含 onboarding 验证）都经同一准入器；控制指令不能排在整轮扫描后面。
  `blockConcurrencyWhile` 只用于有界初始化，不包围外部网络调用或整轮扫描。

**live 订阅与 20 秒目标：**

- 将 `subscribed`、`focusChain`、`leaseUntil`、`nextPollAt`、暂停状态以及各链的上次
  规范化快照/采集时间持久化。原浏览器每 5 秒 `touch()` 的责任由订阅调度器承担。
- `/feed [chain]` 建立或更新订阅，默认当前选中链；一次只保持一个 focus，符合原 live 模型。
  `/feed off` 取消订阅；`/mute` 只关闭主动通知，不取消扫描或订阅。
- 有效订阅且未暂停、未断开时，调度器在每次到期 poll 前将 lease 续到 `now + 30s`。
  冷却或 eviction 后可依据持久订阅重新取得 lease；没有订阅时绝不自续租。
  `/pause` 停止续租，`/resume` 恢复已有订阅，`/disconnect` 清除订阅并取消未发出的 GMGN 工作。
- 每次实际 poll 开始时记 `nextPollAt = startedAt + 20s`；慢请求或冷却造成的过期时隙合并，
  不并发补跑、不突发追赶。请求级 slice 允许每次读后重新检查 live 到期，避免六读连跑挡住 live。
- 20 秒是目标间隔，不保证外部慢请求、429 或平台延迟下的精确墙钟周期。保留请求超时，
  记录 `scheduledAt` / `startedAt` / `pollLagMs` / `requestMs` / 延迟原因，并显示陈旧状态。
  不得为准点而绕过限流或静默改变超时、阈值、周期预算；以 §8 的可控时钟测试验收调度。

### 4.2 GMGN：子进程 → fetch

`gmgn.mjs` 的 `runNow` 现在 `execFileAsync(binary, [workerPath, ...args])`。改为直接 `fetch`：

- 认证用 exist-auth 模式：`X-APIKEY: <key>` + `client_id` + `timestamp` 查询参数（与 GMGN 官方
  客户端一致；本仓库原 gmgn-cli 内部即此协议）。
- 8 个数据读端点（`token info/security/pool`、`token holders/traders`、`market kline/trending/trenches`）
  逐一定义 URL 与 query 参数，**只读白名单就是这组方法本身**。
- `requestWeight`、显式串行队列、`nextAllowedAt`、退避因子与 TTL 缓存语义保留；
  请求间隔预留与代际检查按 §4.1 持久化。缓存失效按原 TTL/keyEpoch，冷启动 miss 可重读。
- `translateGmgnError` 保留（429/401/403/timeout/network 的翻译与 `retryAfterMs`），
  但 `error.stderr` 解析改为 `response.status` / `response.json().code`。
- 依赖变更：`package.json` 移除 `gmgn-cli` 运行时依赖（Worker 不能跑 Node 子进程）；端点的
  参数形态以 gmgn-cli 源码为**文档参考**，移植进 `providers/gmgn.mjs`。

### 4.3 状态：磁盘 JSON → DO SQLite

原 `radar.json` 整文件重写（每轮多次）+ `.bak` 备份。改为 DO SQLite（`ctx.storage.sql`），
每租户一个实例；多表原子性由显式同步事务保证，不能依靠「单线程」推断。所有租户业务表以 `tenant_id` 为前缀主键
（与 DO 实例一一对应，双保险防串数）：

```sql
CREATE TABLE IF NOT EXISTS tenants (
  tenant_id TEXT PRIMARY KEY,          -- telegram private chat_id
  owner_user_id TEXT NOT NULL,
  gmgn_api_key_enc TEXT,               -- 加密后的 GMGN API key（空=未配置）
  onboard_state TEXT,                  -- none / pending / verified
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS candidates (
  tenant_id TEXT NOT NULL, chain TEXT NOT NULL, address TEXT NOT NULL,
  symbol TEXT, name TEXT, info_json TEXT, review_evidence TEXT,
  status TEXT NOT NULL, priority_band INTEGER, discovery_score REAL,
  market_cap REAL, liquidity REAL, price REAL, created_at INTEGER, age_sec INTEGER,
  holders INTEGER, volume_1h REAL, buys INTEGER, sells INTEGER, twitter TEXT,
  audited_at INTEGER, stale_at INTEGER, review_revision TEXT, decision_reason TEXT,
  deep_json TEXT, secondary_json TEXT, social_json TEXT, audit_health_json TEXT,
  PRIMARY KEY (tenant_id, chain, address)
);

CREATE TABLE IF NOT EXISTS audit_queue (
  tenant_id TEXT NOT NULL, chain TEXT NOT NULL, address TEXT NOT NULL,
  first_seen_at INTEGER, last_seen_at INTEGER, last_audited_at INTEGER,
  next_audit_at INTEGER, attempts INTEGER, status TEXT,
  priority_band INTEGER, score REAL, watched INTEGER,
  PRIMARY KEY (tenant_id, chain, address)
);

CREATE TABLE IF NOT EXISTS outcomes (
  tenant_id TEXT NOT NULL, chain TEXT NOT NULL, address TEXT NOT NULL,
  initial_decision TEXT NOT NULL, latest_decision TEXT,
  baseline_at INTEGER, baseline_price REAL, last_audited_at INTEGER,
  symbol TEXT, latest_failed_json TEXT, sampling TEXT, strategy_version TEXT,
  samples_json TEXT, sample_retries_json TEXT,
  PRIMARY KEY (tenant_id, chain, address)
);

CREATE TABLE IF NOT EXISTS risk_exclusions (
  tenant_id TEXT NOT NULL, chain TEXT NOT NULL, address TEXT NOT NULL,
  version INTEGER, codes_json TEXT, reasons_json TEXT, at INTEGER,
  PRIMARY KEY (tenant_id, chain, address)
);

CREATE TABLE IF NOT EXISTS events (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, -- 稳定 effect ID
  at INTEGER NOT NULL, type TEXT NOT NULL,
  chain TEXT, address TEXT, message TEXT,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS annotations (
  tenant_id TEXT NOT NULL, chain TEXT NOT NULL, address TEXT NOT NULL,
  favorite INTEGER NOT NULL, note TEXT NOT NULL, updated_at INTEGER,
  PRIMARY KEY (tenant_id, chain, address)
);

CREATE TABLE IF NOT EXISTS manual_marks (
  tenant_id TEXT NOT NULL, chain TEXT NOT NULL, address TEXT NOT NULL,
  decision TEXT CHECK (decision IN ('passed', 'ignored')),
  marked_at INTEGER, review_revision TEXT, mark_version INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, chain, address)
); -- 撤销保留空 decision 与递增版本，防止旧按钮再次生效

CREATE TABLE IF NOT EXISTS inbox (
  tenant_id TEXT NOT NULL, update_id TEXT NOT NULL, actor_user_id TEXT NOT NULL,
  command_type TEXT NOT NULL, payload_json TEXT, payload_enc TEXT,
  status TEXT NOT NULL, generation INTEGER, received_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER, expires_at INTEGER,
  message_date INTEGER, source_message_id TEXT, result_json TEXT,
  PRIMARY KEY (tenant_id, update_id)
); -- payload_json 只放最小非敏感参数；setkey 正文仅存 payload_enc

CREATE TABLE IF NOT EXISTS preferences (
  tenant_id TEXT NOT NULL, key TEXT NOT NULL, value_json TEXT NOT NULL,
  PRIMARY KEY (tenant_id, key)
);  -- enabled_chains / retryAt / requestMetrics 等

CREATE TABLE IF NOT EXISTS scheduler_state (
  tenant_id TEXT NOT NULL, key TEXT NOT NULL, value_json TEXT NOT NULL,
  PRIMARY KEY (tenant_id, key)
);  -- provider 准入、代际、暂停、live 订阅/快照、任务 dueAt 与通知基线（见 §4.1/§5.3）

CREATE TABLE IF NOT EXISTS cycle_checkpoint (
  tenant_id TEXT NOT NULL, cycle_id TEXT NOT NULL, chain TEXT NOT NULL,
  key_epoch INTEGER NOT NULL, control_epoch INTEGER NOT NULL, deadline_at INTEGER,
  phase TEXT NOT NULL, token_index INTEGER, endpoint_index INTEGER,
  partial_json TEXT, updated_at INTEGER,
  PRIMARY KEY (tenant_id, cycle_id)
);

CREATE TABLE IF NOT EXISTS keys (
  tenant_id TEXT NOT NULL, name TEXT NOT NULL, value_enc TEXT NOT NULL,
  generation INTEGER NOT NULL, created_at INTEGER,
  PRIMARY KEY (tenant_id, name)
);  -- gmgn-signing-key / gmgn-pending-signing-key

CREATE TABLE IF NOT EXISTS outbox (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, event_id TEXT,
  chat_id TEXT NOT NULL, payload_json TEXT NOT NULL, desired_revision TEXT,
  delivery_class TEXT NOT NULL, action_reason TEXT, ui_session_id TEXT,
  status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER,
  ambiguous_retries INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, event_id)
);

CREATE TABLE IF NOT EXISTS message_map (
  tenant_id TEXT NOT NULL, chain TEXT NOT NULL, address TEXT NOT NULL,
  message_id TEXT NOT NULL, chat_id TEXT NOT NULL, rendered_revision TEXT,
  ui_session_id TEXT,
  PRIMARY KEY (tenant_id, chat_id, message_id)
);

CREATE TABLE IF NOT EXISTS ui_sessions (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, owner_user_id TEXT NOT NULL,
  chat_id TEXT NOT NULL, message_id TEXT, panel TEXT NOT NULL,
  view_chain TEXT, query_json TEXT NOT NULL, snapshot_at INTEGER,
  version INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, id)
); -- query_json: filter/sort/search/page/returnTo/pendingInput；仅 UI 状态

CREATE TABLE IF NOT EXISTS shortlinks (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL,
  chain TEXT, address TEXT, action TEXT NOT NULL, expected_control_epoch INTEGER,
  ui_session_id TEXT, expected_ui_version INTEGER, params_json TEXT, origin_message_id TEXT,
  review_revision TEXT, expected_mark_version INTEGER, expected_connection_generation INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER, PRIMARY KEY (tenant_id, id)
);
```

shortlinks 的 token action 必须有 chain/address；运行控制和 onboarding 按钮使用对应
epoch/generation，无 token 目标。TenantRegistry 另存 `tenant_id PRIMARY KEY` 与登记时间；
租户 schema version、导入 hash/完成标记保存于 `preferences` 的保留命名空间。

保留语义（与现实现一一对应）：

- `risk_exclusions` 不因切链 / 重启 / 候选过期自动清除（`applyRiskExclusion` 照旧）
- `outcomes` 缺失窗口记 `missing`，不补零（`collectOutcomeSamples` 照旧）
- 状态损坏 fail-loud：`radar-state.mjs` 加载时若表结构与预期不符抛错，不静默重建
- `annotations` 上限 50 收藏 / 500 条备注（`RadarControls` 语义）

### 4.4 状态迁移与字段完整性

- DDL 是持久化契约，实施时逐项对照 `state.value`、各链状态、`publicCandidate` 与导出字段；
  未列出的运行字段必须有明确 JSON 容器或专门列，不能因表结构简化而丢失。特别保留
  `reviewEvidence`（决定 revision 是否变化）、symbol/info、outcome cohort 元数据与通知基线。
- schema 使用显式版本与事务迁移；已知旧版本升级，未知版本/损坏 fail-loud，不能简单以
  `CREATE TABLE IF NOT EXISTS` 掩盖不兼容。部署前保留原始文件和迁移映射说明。
- 切换前暂停旧扫描，离线工具读取 `radar.json` / `preferences.json`（含正常备份恢复），
  合并旧浏览器导出的 `manualMarks`，按 chain + 规范化 address 导入指定租户。
  不导入明文密钥；目标经 `/onboard` 重新绑定。迁移包不包含 raw provider 响应或凭据。
- 迁移工具通过受 `OPERATOR_TOKEN` 保护的临时导入路径提交已验证数据；只允许暂停且空的
  目标租户，校验 owner、schema 和内容哈希。持久 import ID 使重复导入成为无操作；
  已成功的同 hash 重试返回既有结果，同 ID 不同 hash 拒绝；新导入的全部记录与完成标记
  同事务提交。完成后关闭新写入入口，保留重复 import ID 的结果查询。
- 比较迁移前后候选、risk exclusions、outcomes 基线/样本、收藏/备注、人工标记及导出内容。
  原文件保留至验收；不能把「暂时读不到文件」当成空历史。标记按原时间和 revision 重判有效性，
  绝不延长有效期。切换建立静默通知基线，不追播导入候选。

## 5. Telegram 唯一 UI：完整操作面

### 5.0 主要界面与交互契约（按现有 web UI 映射）

Telegram 复刻主要界面的信息与操作。使用命令打开消息面板，inline keyboard 完成导航、
切链、筛选、排序、分页和代币操作；不把原页面每次刷新转换成聊天推送。
后端采集、用户查询响应、主动提醒是三个独立通道：20s live 采集不意味着每 20s 发消息。

| 现有 web 界面 | command / 消息标题 | 信息与 inline keyboard |
|---|---|---|
| 总览、运行状态与六个统计卡 | `/start`、`/radar` → 雷达总览；`/status` → 运行状态 | 总览显示累计扫描轮次、本轮发现/初筛数、近30m深审/链上候选/有效人工通过数，保留各指标时间范围；按钮进入活跃榜、表现验证、深审、收藏、事件、设置。状态页显示来源状态、上次尝试/成功、下轮、新鲜度与队列进度；刷新/返回 |
| 即时发现 · 1分钟活跃榜 | `/feed [chain]` → 1分钟活跃榜 | 链、快照时间、新鲜度、榜单；MC/LP、1m成交额、买卖笔数、聪明钱/持有人、可比较窗口价格变化、币龄和审计状态；按钮：查看链、2–8万优先/1m成交额/最近新进榜、搜索、翻页、刷新、详情、申请深审、开启/关闭采集、返回 |
| 筛选后表现验证 | `/stats` → 筛选后表现验证 | 首页复刻跟踪数、30m/1h/2h/24h平均观察收益及完成数；详情提供全部7个 horizon 的 eligible/completed/missing、中位数、正收益比例与通过/拒绝组对照；按钮：查看链、窗口、组别、详情/总览、刷新、返回。50样本门槛按各窗口原逻辑展示，缺失不补零 |
| 近30分钟深度审计 | `/audits`（`/candidates` 为同面板别名）→ 近30分钟深度审计 | 严格按 auditedAt 过滤最近30m；搜索名称/简称/CA；筛选全部/链上候选/等待复查/人工通过/已忽略/已排除/5m内审计/收藏；排序最新审计/发现评分/市值升降/流动性；分页、刷新、代币详情、返回 |
| 代币审计详情、人工标记 | 从榜单/深审/提醒卡点击代币 | 完整 chain+CA、证据检查、未知/失败项、主/第二源冲突、审计时间/revision；官网/GMGN/X 链接；人工通过/撤销、忽略/取消忽略、收藏/取消收藏、备注、返回来源面板；只有 live 详情提供申请深审，沿用原资格检查 |
| 扫描设置与记录、GMGN连接 | `/settings`；`/chains` 直达扫描链选择 | 当前扫描1–3链、连接与暂停状态、提醒开关；按钮：选择/保存扫描链、onboard/更换Key、断开、暂停/恢复、提醒开关、导出、返回。查看链切换与修改扫描链分开，前者不改变扫描集合 |
| 收藏与备注 | `/saved` | 收藏与备注列表、分页/搜索、代币详情、编辑/取消收藏、返回；允许打开已不在近30m列表中的已有记录，显示陈旧标识 |
| 雷达事件 | `/events` | 默认最近12条，带时间/链/类型，可翻页或筛选；刷新/代币详情/返回。普通事件只在面板展示 |

交互规则：

- command 首次发送面板消息；同一面板的翻页/筛选/刷新优先 `editMessageText`/更新键盘，
  不每次新发。返回键保留来源的 chain/filter/sort/search/page。新 command 可开独立会话，
  不把两个面板的查看链或筛选状态串在一起。
- `ui_sessions` 持久保存面板类型、查询状态、消息归属与 version；按钮短 ID 绑定会话、
  owner、message_id 与 expected version。并发按钮采用版本检查，旧渲染不能覆盖新视图；
  重启后会话仍可恢复。过期按钮确认 callback 并给出重新打开面板入口，不执行陈旧写操作。
- 搜索/备注按钮创建有期限的输入状态，要求回复对应提示消息，并提供取消；回复必须匹配
  owner/chat/session，其他 command 不被吞作备注。含凭据的输入优先走受保护的 setkey 路径，
  不能写入搜索词、备注或 UI query_json。调用 `answerCallbackQuery` 及时结束按钮等待。
- 初始每页5条；长内容按 Telegram 消息限制分页到摘要/详情，动态文本转义。列表用编号短行
  与对应代币按钮，详情提供完整 CA；不得截断关键未知/失败项、时间范围或数据陈旧提示。
- live「自动更新」在 Telegram 中表示**后台采集**开关，不是自动发榜单；用户点击刷新读取
  最新已缓存快照。未就绪则显示等待/陈旧并给刷新键，不同步触发额外 GMGN 请求绕过调度。
  live 申请深审走原 `auditRow` / `enqueueReview`，只反馈入队状态，保留原快照/链/额度检查。
- 常规榜单、表现、事件、状态面板仅在 command/callback 时重新渲染。每张消息标注快照时间，
  不伪装持续实时；安全例外是已展示代币的风险变化/人工通过失效，应静默更正原卡片，
  不能由此自动发送整份榜单。token 卡片 `message_map` 与通用 `ui_sessions` 分开管理。
- `/stats` 是影子观察，保留原平均值与中位数各自标签，不能把观察收益写成可成交收益；
  默认查看链与 web 一致，不擅自合并跨链 cohort。无样本、部分缺失、Key未配置、暂停、
  限流、陈旧和空列表均有明确文案及可用导航，不能显示假零值或假成功。

### 5.1 命令表（BotFather 注册）

| 命令 | 原 web 操作 | 行为 |
|---|---|---|
| `/start`、`/radar` | 首页总览 | 打开总览与主要面板导航；首次给简短说明/配置入口 |
| `/help` | 帮助 | 列出命令与「只读、非投资建议」声明 |
| `/status` | telemetry 面板 | 打开运行状态消息，附刷新/设置/返回键 |
| `/settings` | 扫描设置与记录 | 打开设置面板，导航至链选择、连接、扫描、提醒和导出 |
| `/saved` | 收藏与备注 | 打开带搜索、分页、详情按钮的记录面板 |
| `/events` | 雷达事件 | 打开事件列表及刷新/筛选/分页按钮 |
| `/chains` | 扫描链选择 | 内联键盘多选 7 链（1–3 条），`setChains` 语义不变 |
| `/feed [chain\|off]` | 1分钟活跃榜 | 打开 §5.0 榜单与 inline keyboard，建立后台采集订阅；`off` 取消采集；采集更新不主动发消息 |
| `/audits`、`/candidates` | 近30分钟深度审计 | 同一面板入口，保留30m范围、完整筛选/排序/分页/详情操作 |
| `/note <符号或CA>` | 收藏备注 | 输入备注；按钮 `[收藏/取消收藏]` `[忽略/取消忽略]` |
| `/export` | 导出记录 | 发 `meme-radar-records.json`（白名单导出，不含 key） |
| `/stats` | 筛选后表现验证 | 打开原指标总览，按钮切换窗口、样本组和详情，按 §5.0 保留均值/中位/覆盖率/50样本门槛 |
| `/onboard` | GMGN 首次配置 | 生成 Ed25519 公钥 + 发送 `https://gmgn.ai/ai?tab=api_management` 引导（见 §6） |
| `/setkey <key>` | 回传 API Key | 归一化 + 读权限验证 + `activatePending` + 加密存储（后台自动 onboard）；也接受直接发 `gmgn_` 开头的明文 |
| `/pause` `/resume` | 暂停/恢复 | 停/启扫描与 live（key 已存储，仅暂停调度） |
| `/disconnect` | 清除并断开 API | 删除本租户 key 与私钥，持久禁用旧 key 回退（对应原「清除并断开」） |
| `/mute` `/unmute` | 关闭/开启提醒 | 控制推送去重后的通知开关 |

### 5.2 代币详情与待人工查看卡（查询和提醒复用）

复用 `whitelist.mjs` 的 `publicCandidate` 输出 + `publicMessage` 脱敏，渲染为：

```
🎯 <b>SYMBOL</b> (sol) · 待人工看 X
CA: <code>…</code>
市值 32.1K · 流动性 8.4K · 持仓 Top10 12%
税 buy 0% / sell 0% · LP 已锁 · 非貔貅
16 项检查：✅×12 ⚠️×2 ❌×0（未知字段如实列出）
[官网] [GMGN] [X]  |  [收藏/取消收藏] [备注]
[人工通过/撤销通过] [忽略/取消忽略]
```

- `shortlinks` 映射租户内 opaque ID 到 `(chain,address,action,reviewRevision,expectedMarkVersion)`，
  `callback_data` 如 `cb:<id>`，≤64 字节。回调必须验证私聊 owner、消息归属、短 ID 租户、
  action 与过期时间；失效按钮返回当前卡片，不执行旧操作。符号或 CA 有多链/多币歧义时先选币。
- 将原页面 `backendDisposition` / `effectiveStatus` / `canPass` 提取成可测试函数。
  `manual_marks` 保存 `decision`（passed/ignored）、`marked_at`、`review_revision` 和版本。
  人工通过有效条件沿用原逻辑：revision 非空且匹配、标记不足 24 小时、链上 disposition
  合格且审计年龄不超过 10 分钟。新建通过标记必须同时满足链上合格、审计新鲜及 revision
  匹配；撤销已有标记无需再次通过硬门。原页面 `canPass` 包含允许撤销的分支，不能把
  该分支误当成新建通过的权限，也不能只相信卡片上有按钮。
- 使用明确 set/clear 操作，不采用收到一次就翻转的 toggle。写入时比较 `expectedMarkVersion`，
  同事务递增版本、完成 inbox 记录并记录卡片更新意图。重复/过期按钮不能撤销新标记。
  `ignored` 保留原语义：直到取消忽略，不因审计 revision 改变而自动解除。
- revision 改变只使旧 `passed` 失效，原记录可保留用于展示失效原因。新鲜度/24h 到期也会失效，
  即使没有新审计也要调度卡片刷新；人工标记不改变审计判据、候选状态或影子样本分组。
- `/export` 包含白名单人工标记；通知资格检查读取持久 ignored 状态。人工复核标记与
  收藏/备注是不同模型，不能用 `annotations.favorite` 替代。
- `message_map` 按 token 查找其已展示的详情/提醒卡片（可有多张，不能只保存最后一个 message_id），
  会话切换离开该 token 后移除对应映射。投递前读取最新状态并渲染；同消息串行编辑，丢弃旧 revision
  的待发内容，编辑期间发生变化则完成后继续刷新最新版本，防止旧任务最终覆盖新风险。

### 5.3 主动推送边界（只发需要人工查看的代币和信息）

先由 `notification-policy.mjs` 判定是否需要人处理，再进入去重与 outbox。明确区分：

| 投递类别 | 允许内容 | 触发与呈现 |
|---|---|---|
| `USER_RESPONSE` | 命令/按钮打开的任何面板、操作结果、用户要求的导出 | 只响应对应交互；不受 mute 影响；优先编辑原面板 |
| `ACTION_REQUIRED` | 新进入 X_REVIEW 且符合原通知资格、未忽略的代币 | 提供需要人工核查的原因与查看X/检查证据/人工标记按钮；原30m事件去重和24h新候选抑制继续有效 |
| `ACTION_REQUIRED` | 已提醒/人工通过/收藏代币的风险或证据恶化，需要重新核验 | 给出具体变化与详情入口，按 token + 风险revision 去重；先更正已有卡片，必要的新提醒受 mute 控制 |
| `ACTION_REQUIRED` | 明确需要操作才能恢复的账户/服务问题 | 例如已配置Key失效须重新绑定、解密/状态损坏须部署方修复、UNKNOWN投递重试耗尽须核对；给出原因及可执行入口，同一未解决问题只提醒一次 |
| `PANEL_UPDATE` | 已展示代币的风险修正、人工标记失效 | 静默编辑旧卡片，不发送新榜单；编辑失败记录状态，不以重复新消息兜底刷屏 |
| 不主动投递 | 活跃榜变动、普通WAIT_RECHECK/HARD_REJECT、每轮扫描摘要、影子样本完成/收益更新、普通事件、例行状态、可自动恢复的429/DEGRADED | 仅更新后台状态，用户从对应 command 面板查看；不能因发生事件或存在outbox就绕过此规则 |

- routine 变成 actionable 必须有明确原因（凭据不可用、已停止且需人工修复、重试耗尽），
  不按错误码或「出现过DEGRADED」一概推送。恢复信息更新原问题状态/卡片，不独立广播。
  `/mute` 抑制全部 ACTION_REQUIRED 新消息，仍保留面板中的待处理项和安全更正。
- 所有自动发送任务持久标注 `delivery_class` 与 `action_reason`，发送前重查资格；没有
  allowlist 分类的后台事件不创建主动推送。UI查询结果不得被后台循环重复投递。

- 保留现有事件去重与新候选 24h 提醒抑制，但不能把语音资格 gate 套到所有事件：
  `CANDIDATE_NEW` / `RISK_WORSENED` 事件按 type + chain + CA 保留 30 分钟去重。
  `CANDIDATE_NEW` 使用 `voiceSnapshot`/`voiceEligible` 与 ignored 检查；`RISK_WORSENED`
  通常发生在候选退出 X_REVIEW 时，必须仍能编辑原卡片。每次 revision 变化独立产生
  卡片刷新意图，不受事件 30 分钟去重或新候选 24h 去重阻止。
- 新候选主动提醒每批最多每分钟一次，短摘要附逐币详情按钮；需要核验的原因不能省略。
  风险卡片更正与命令响应独立调度；相同未解决服务问题不按周期重复提醒。
- 首次 `/start`、断线恢复**不追播旧候选**；持久保存每链 initialized/quiet/notified 状态。
  DO eviction 只恢复该状态，不能等同用户新会话而再次静默掉尚未投递的新候选。
  用户恢复订阅/解除静音时重建基线并撤销过期主动提醒；命令响应与风险卡片更正不丢弃。
- `RATE_LIMITED` / `DEGRADED` / `AUTH_REQUIRED` 用 `publicError` 展示于状态与相关面板；
  只有符合上述 ACTION_REQUIRED 条件才主动提醒，普通冷却不会推送。
- 语音提醒（"亲爱的老板～我找到一枚不错的币"）→ 删除，改为原生通知；所有「仅提醒新进入
  X_REVIEW」的判定逻辑（`voiceSnapshot` 里的 qualified 条件）**保留**为新候选推送 gate

### 5.4 webhook 接收、去重与命令恢复

1. Worker 校验 secret header、载荷大小、支持的 update 类型与 §2 私聊身份；从 Telegram
   envelope 提取 chat/from，不能从 callback 字符串接受租户 ID。拒绝的群组/不支持 update
   不创建租户、不接收密钥，返回成功确认以避免无效重试；secret 不匹配返回 403。
2. 授权 update 先幂等登记路由，再交给租户 DO；以 `(tenant_id, update_id)` 插入 inbox，
   原子写入最小命令参数及 dueAt，并确保 alarm 已安排，才返回 HTTP 2xx。
   存储/排程失败返回可重试错误；重复 update 读取既有状态并补查调度，不重复创建操作。
   不能先 200 再靠 `waitUntil` 做唯一副作用。Telegram 的重试/乱序事实见 §11。
3. 状态为 `RECEIVED → RUNNING → DONE/FAILED/CANCELLED`；外部读失败用持久 next_at
   重试，重建时恢复未完成命令。同步本地变更、完成标记和回复 outbox 同事务；涉及外部
   验证的命令先保存代际/阶段，返回后再校验并提交。控制命令可取消运行中的长验证；
   它们的本地变更在接收 RPC 内完成，回复入 outbox，不等待外部读完成。
4. 同一租户的已接收状态变更按接收顺序处理，安全控制可优先使旧工作失效；不能仅保留
   最大 update_id 而丢弃乱序到达的其他命令。重复 ID 永不重放；过旧的凭据/控制命令
   不得逆转较新已接收的冲突操作。用持久代际和冲突命令水位判定，update_id 长期空闲
   后可能重新随机起始，不能假设跨会话永久递增。消息型冲突指令以 `(message.date,
   update_id)` 排序并分别保存凭据/运行控制水位；只在消息时间相同的情况下比较 ID。
   运行控制与密钥重新生成按钮绑定相应 expected epoch，复用旧按钮不能回退新状态。
5. `/setkey` 的原始 update 不落盘、不记录日志。只保存加密候选 key 与最小来源消息 ID；
   候选 Key 自收到起 15 分钟到期；任务终态或到期后清除敏感载荷。控制/凭据消息距发送
   超过 15 分钟则要求重发，所有操作按钮最长有效 15 分钟（更短的审计期限优先）。
   去重 tombstone 保留 7 天；到期任务先落 CANCELLED 再清除载荷，不得因去重清理
   重新接受旧凭据操作。`deleteMessage` 独立重试，
   删除失败不输出原文、不撤销已持久接收的命令。

### 5.5 outbox 的实际投递保证

- events/outbox 意图与业务提交原子，发送发生在事务外；稳定 ID 保证内部入队一次，
  **不承诺 Telegram 外部 exactly-once**。sendMessage 没有本计划可用的客户端幂等键，
  成功发送后、保存 message_id 前崩溃会产生不确定结果。
- 发送前持久记 `SENDING` 与尝试计数；成功后同事务记录 message_map 与 SENT。
  明确的可重试失败按 `retry_after`/退避重试；永久 4xx 标为 FAILED 并暴露原因；超时、连接断开或重启遗留 SENDING 记为 UNKNOWN。
  对每条逻辑消息最多自动重试一次 UNKNOWN，并在发送前持久增加 `ambiguous_retries`；
  再次不确定则挂起并在 `/status` 暴露。这个上限以可能漏送为代价，不能同时承诺必达。
- 发送前按当前 mute、候选资格、revision 与任务有效期重新判定；失效主动提醒取消，
  不在恢复时补播。批次 payload/成员与 ID 先持久化，重试不能重新拼装成另一批。
- UNKNOWN 挂起的卡片编辑不能随后放行另一份旧/新网络编辑而宣称有序；先暴露待核对
  状态，恢复时重新渲染最新版本。不得把网络结果不确定伪装成已保证远端最新。
- 同卡片编辑保持串行，成功保存 rendered_revision；「消息未修改」可视为该版本已应用，
  消息已被删除则清理映射，并仅在仍需要展示当前状态时生成替代卡片。
- 人工操作回复不受 `/mute` 阻止；outbox 的失败不会阻止暂停/断开或扫描状态持久提交。

## 6. 密钥与 onboarding（用户上传 + 后台自动 onboard）

**流程（每租户一次）：**

1. 用户在 Telegram 发 `/onboard`。
2. 该租户的 DO 生成 Ed25519 密钥对（pending），私钥加密存 `keys` 表
   （`gmgn-pending-signing-key`），公钥导出 SPKI PEM。为 pending 保存 generation；
   重复 update 或已有 pending 时复用同一公钥，不自动重新生成。显式重新生成按钮带旧
   generation，原子替换 pending 并取消旧代际验证；密钥生成 await 返回后也要校验代际。
3. Bot 回复引导：
   - 创建地址：`https://gmgn.ai/ai?tab=api_management`
   - 公钥（可复制）——GMGN 建 Key 时按需粘贴
   - 提示：建好 Key 后直接把 `gmgn_...` 发回来（或 `/setkey <key>`）
4. 用户回传 API Key。Bot：
   - 归一化（`normalizeGmgnApiKey`，非法格式直接拒）
   - 尝试 `deleteMessage` 删除用户含 Key 的消息（降低 Key 残留在聊天记录的风险；平台不允许则跳过）
   - 发一个轻量读请求验证读权限（对应原 `verifyApiKey` → `auth verify-read` → `getUserInfo`）
   - 成功返回后重查 pending generation、连接 generation 和命令状态；在同一事务内
     pending → signing、保存加密 API Key、递增 keyEpoch、完成 inbox、写入回复意图。
     事务完成后再允许新凭据扫描；失败不能出现「私钥已换而 API Key 未换」的半完成状态
   - 失败则保留旧 key / 旧状态，返回可读错误（对应原 `GmgnConnection.apply` 语义）
5. `/disconnect`：删除本租户 Key 与私钥，写持久禁用标记，旧 key 回退不生效（对应原
   `gmgn-key-store.disconnect`）。同事务递增连接/key/control 代际，取消待验证命令并删除其
   加密候选 Key，清理缓存/旧 checkpoint、取消 live 订阅；迟到验证成功不能恢复连接。

**存储：**
- `gmgn-api-key` 与 Ed25519 私钥都按租户存 DO（`tenants` / `keys` 表），**不再走 Worker secret**。
- 使用 Worker secret `MASTER_ENC_KEY` 对 API Key、私钥与 inbox 候选 Key 做 AEAD 加密；
  每次写入使用唯一随机 nonce，AAD 绑定 tenant/字段/版本，加密 envelope 保存 key version。
  解密失败 fail-closed；轮换须先支持旧/新版本解密，迁移核验后再退役旧主密钥。
  Worker secret 只保留 `TELEGRAM_BOT_TOKEN` / `TELEGRAM_WEBHOOK_SECRET` / `OPERATOR_TOKEN` / `MASTER_ENC_KEY`。
- Key 永不进日志、状态导出、Telegram 回显（回显只显示 `gmgn_****`）。

**Ed25519 兼容（决策 3）：**
- 私钥在只读扫描里「存在但不用」（只读走 API Key，不签名）；保留是为 GMGN Agent 绑定兼容，
  不因此添加 signed/trade 路由，执行仍永久关闭。
- 生成走 `crypto.subtle.generateKey({name:"Ed25519"})`；**先 spike 验证 Workers 支持**，
  否则回退 `nodejs_compat` 的 `node:crypto.generateKeyPairSync('ed25519')`。

## 7. 安全边界（云端版）

- webhook 来源验证、私聊 owner 授权、callback 归属与 inbox 幂等是四个独立检查，
  全部按 §2 / §5.4 执行。Telegram secret 只能证明投递来源，不能授权群成员操作同一个租户。
- operator HTTP（`/health` `/status`）：`Authorization: Bearer <OPERATOR_TOKEN>`（secret），fail-closed。
- 字段白名单：Telegram 渲染前过 `whitelist.mjs`，动态文本再做 HTML escape，URL 复用安全协议
  校验；不能把脱敏等同 HTML 转义。上游原始响应永不进 chat；`publicMessage` 正则
  脱敏 key/bearer/private/passphrase/gmgn_ 前缀串。
- 租户隔离：每租户一个 DO 实例 + 所有表 `tenant_id` 主键前缀，一个租户的状态/Key/队列互不可见。
- 密钥：GMGN API Key 与 Ed25519 私钥按租户加密落盘（`MASTER_ENC_KEY`）；公钥才可出 DO；
  日志不打印 key、token、私钥、完整 CA。
- 交易执行永久关闭：`providers/gmgn.mjs` 无签名 / 下单 / follow-wallet 方法。
- 许可：仓库仍为 AGPL-3.0-only（与 EDITION-BOUNDARY.md 无关；后者不再约束本设计，见决策 8）。

## 8. 分阶段里程碑

| 阶段 | 交付 | 验证标准 |
|---|---|---|
| **M0 抽取** | scoring/chart-risk 纯逻辑、带 I/O 的 outcomes/secondary provider 接口、manual-review 与白名单抽取；SHA256 字节/hex 兼容 | 先记录现有 16 个测试文件的基线；原测试在删除本地运行时前通过；首字节抽样/reviewEvidence 固定向量一致，async 调用方全部 await |
| **M1 provider** | fetch 读端点、显式串行队列、持久准入间隔、冷却、缓存、错误翻译 | 原 gmgn/risk-filters 测试适配通过；验证 Key 与审计并发提交仍单飞；429 与加权间隔跨重建不绕过 |
| **M2 DO 扫描器** | 请求级状态机、版本化 SQLite、原子 effect/checkpoint、TenantRegistry/wake；operator `/health` `/status` | 冷却/暂停无空转；故障注入验证事务前后恢复无缺失/重复 effect；临时凭据仅用隔离测试夹具，不增加生产注入接口 |
| **M3 Telegram 控制面** | 私聊授权、持久 inbox/outbox、onboard 原子激活、§5.0全套面板/inline keyboard/人工复核、导出与加密 | 重复/乱序 update、重复 callback、断开与验证竞争、群组拒绝、跨租户短 ID、到期人工标记均覆盖；任何重试不回显 Key；主要web界面均能由command打开并通过键盘完成操作 |
| **M4 live + 通知** | 持久订阅续租、20s 目标调度、live 快照恢复、通知allowlist/基线、revision 编辑与 `/stats` | 无用户交互仍持续轮询；冷却/慢读有可解释延迟且不补跑；mute/pause/feed off 语义分离；风险更正不被新候选 gate 抑制；后台常规变化零主动消息 |
| **M5 发布准备** | 离线迁移、完整故障矩阵、requestMetrics、Worker 发布审计、密钥轮换与部署文档；删除旧运行资产 | 迁移逐字段核对；UNKNOWN 投递受持久上限约束；最终 Workers 测试与构建通过；旧 UI/平台测试由对应新行为测试替代并说明，不静默删测 |

### 8.1 必须落实的验收场景

以下新增/扩展测试文件是实施契约；本次文档修订不代表这些测试已存在或通过。

| 测试文件 | 关键输入/故障 | 必须观察到的结果 |
|---|---|---|
| `test/scheduler.test.mjs` | now=100000，scan=110000、live=120000，冷却=0 或 90000 | 下一 alarm=110000，不能为 0/90000；冷却=150000 时 GMGN 工作不早于 150000，outbox=105000 仍可先跑 |
| `test/scheduler.test.mjs` | 暂停、无订阅、空队列；任务失败；watchdog 在 alarm 运行中进入 | 无工作时无 alarm；失败有未来退避；wake 不重复启动步骤或解除暂停 |
| `test/gmgn.test.mjs` | 审计/live/setkey 同时请求；加权请求发出后重建；429 后换 Key | 最大在途 GMGN 请求数为 1；恢复遵守持久 spacingReadyAt/nextAllowedAt，旧凭据结果不更新业务状态 |
| `test/radar-agent.test.mjs` | 在每个请求返回、token 事务提交前/后、重排 alarm 前注入崩溃 | 已提交候选有对应事件/基线/outbox；未提交全部回滚；重试 effect ID 不变；baseline 不重置 |
| `test/webhook.test.mjs` | 无效 secret、群组/频道、伪造 tenant 短 ID、非 owner；持久接收前失败 | 无越权读写；未持久接收不能返回成功确认；受支持的重复 update 不重复执行 |
| `test/inbox.test.mjs` | 重放 onboard/setkey；乱序冲突指令；验证等待中 disconnect；长期空闲后新 update ID | pending 公钥不被重放替换；旧命令不逆转新控制状态；断开后不复活；新会话合法命令不被最大 ID 误拒 |
| `test/manual-review.test.mjs` | revision 改变、标记 24h 到期、审计超过 10m、重复按钮、旧 mark_version | 人工通过失效且卡片刷新；ignored 直到主动撤销；旧按钮不能覆盖新标记；收藏与人工通过互不替代 |
| `test/live-discovery.test.mjs` | 开订阅后 120s 无消息；poll 间重建；关闭订阅/暂停；单读超时与429 | 可控瞬时响应下保持 20s 间隔和 30s lease；恢复保留 delta 基线；关闭后不续租；延迟记录且无突发补跑 |
| `test/telegram-outbox.test.mjs` | 发送成功后保存前崩溃；连续 UNKNOWN；旧 revision 编辑；mute 后恢复 | UNKNOWN 最多一次自动补发尝试，之后挂起；最终卡片是最新状态；不追播失效候选，风险更正仍执行 |
| `test/telegram-panels.test.mjs` | 同一web数据夹具打开总览/feed/stats/audits/saved/events/settings，翻页/排序/筛选/搜索/详情/返回，重建后再点击 | 主要信息、指标和30m范围与web一致；均带inline keyboard；编辑原消息，session不串状态；失效按钮不写入 |
| `test/notification-policy.test.mjs` | 连续多轮live榜单变化、样本完成、普通拒绝、429/DEGRADED；再输入新X_REVIEW、已关注币风险恶化、Key失效；开启mute | 常规变化主动发送数为0；仅allowlist生成带人工查看原因/入口的提醒；未解决问题不重复；mute下仅交互响应和旧卡片更正 |
| `test/migration.test.mjs` | 原 JSON+浏览器导出、重复 import ID、损坏/未知版本、缺失文件 | 候选/排除/样本/标记逐项一致；重复导入无操作；异常 fail-loud，原数据不覆盖 |

实施阶段验证命令（需先由对应里程碑添加文件与 package scripts）：

```sh
# 抽取前与 M0，记录原有基线；现有失败要报告来源，不能宣称全绿。
npm test
# M0/M1 后按实际迁移路径运行保留的逻辑测试。
node --test test/scoring.test.mjs test/risk-filters.test.mjs test/gmgn.test.mjs test/secondary.test.mjs
# M2 起新增 script：使用 @cloudflare/vitest-plugin 跑上述涉及 DO 的测试。
# package.json 中 test:workers = vitest run --config vitest.workers.config.mjs
npm run test:workers
# 最终构建：确认无子进程/文件系统运行时依赖，输出不包含凭据。
npx wrangler deploy --dry-run
```

新增 `vitest.workers.config.mjs`、Workers Vitest 集成和 Wrangler 开发依赖；纯 Node 与 Workers
测试文件分别配置 include/exclude，避免 Node test runner 收集 Workers 专用用例。
最终 `npm test` 聚合两类测试。平台真实 smoke test 另用隔离租户与只读测试 Key，
记录部署 revision、超时/冷却/live lag；dry-run 和模拟时钟通过不能替代 §9 的线上能力验证。

## 9. 风险与待验证 spike（进入对应里程碑前完成）

1. **Workers WebCrypto 是否支持 Ed25519**（`crypto.subtle.generateKey({name:"Ed25519"})`）。
   不支持则启用 `nodejs_compat` 用 `node:crypto`。**先 spike**（M3 之前）。
2. **GMGN 读端点（info/security/pool/holders/traders/kline/trending/trenches）的 exist-auth
   参数形态**：以 gmgn-cli 源码为准逐一对齐，避免"看起来对、实则 401"。
3. **DO alarm 的成本与上限**（M2/M4 前）：live 目标 20s 一次，但请求级扫描、命令、
   outbox 及卡片刷新会额外触发 alarm；测算完整负载与等待 I/O 的计费，不按每分钟三次估算。
   单租户成本需测算；若超预算，再回到决策 4 与用户确认（**默认不改**）。
4. **请求级 slice 与实际轮询延迟**（M2/M4 前）：测量单请求超时、加权间隔、live lag、
   CPU 与墙钟耗时；验证读请求之间 live 可以获得调度机会。await 不计 CPU 不代表墙钟
   无影响；记录慢读/429 的降级表现，不能以「一个 token 一片」替代请求级恢复验收。
5. **用户 Key 进聊天记录的残留风险**：`/setkey` 的明文必然在 Telegram 聊天记录里留痕。
   缓解：收到即 `deleteMessage`（平台允许时）+ 只存加密态 + 回显脱敏；无法完全消除，需在
   `/help` 明确提示。

## 10. 不做清单（明确排除，防止范围蔓延）

- 不做交易 / swap / 下单（执行永久关闭）。
- 首版不做注册门槛 / 计费 / 配额（多租户治理由部署方自定）；仍必须执行私聊 owner 授权。
- 不保留浏览器前端、语音合成、桌面提醒、Windows/macOS 便携包、本地 supervisor。
- 不改任何阈值、判据、7 链、20s 轮询、限流权重、未知字段语义。
- 不动 MemeHarness。

## 11. 平台依据与实施边界

- [Cloudflare Durable Objects 测试](https://developers.cloudflare.com/durable-objects/examples/testing-with-durable-objects/)：
  使用 `@cloudflare/vitest-plugin` 的 `cloudflareTest()`，在 Workers runtime 验证绑定与存储。
- [Cloudflare SQLite Storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)：
  用 `transactionSync()` 明确同步多表提交和回滚边界；SQL 游标在 await 前消费完。

- [Cloudflare Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)：每个 DO
  一个 alarm、至少一次执行与有限自动重试；重建可重跑 handler，`getAlarm()` 在执行中可能为空。
- [Cloudflare Durable Object State](https://developers.cloudflare.com/durable-objects/api/state/#blockconcurrencywhile)：
  外部 await 期间要考虑事件交错；`blockConcurrencyWhile` 有 30 秒超时，不能用来包长网络循环。
- [Telegram setWebhook](https://core.telegram.org/bots/api#setwebhook) 与
  [Update](https://core.telegram.org/bots/api#update)：非 2xx 会重试，update_id 用于去重/乱序处理，
  长期空闲后的起始 ID 可能随机变化；secret header 不是最终用户权限检查。

这些依据用于约束实现；GMGN fetch 参数、Workers 兼容性、成本与真实时序仍按 §9 验证。
