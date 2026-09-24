# Fly.io 运行时部署

自用单租户运行时，部署在 Fly.io 的一台 `shared-cpu-1x`（256MB）上，用**独立 IPv4**
摆脱 GMGN 对 Cloudflare Workers 共享出口 IP 的封禁。依据 #29 的实测结论与 #50 的
决策；证据见 [spikes/LIVE-TIMING.md](spikes/LIVE-TIMING.md)。

## 为什么不用 Cloudflare 出口

GMGN 对 Cloudflare Workers 的共享出口 IP 下发 `RATE_LIMIT_BANNED`，且每次尝试续期
（+285s），"到点重试"是死亡循环。同一 key、同一路由从住宅 IP 返回 200，说明封禁在
出口地址而非 key 或速率。详情见 `docs/spikes/LIVE-TIMING.md`「Credential and egress
evidence」一节。

## 架构

新增 `src/host/`（**不改动现有 Cloudflare 代码**），复用 `src/worker.mjs`、
`src/radar-agent.mjs`、`src/tenant-registry.mjs` 原代码：

- `register.mjs` + `cloudflare-workers-shim.mjs`：Node 模块钩子把 `cloudflare:workers`
  解析为 `class DurableObject`，以 `node --import ./src/host/register.mjs` 启动。
- `durable-object-host.mjs`：每个 DO 实例一个 SQLite 文件 + 串行化输入闸门
  （fetch/alarm/RPC 逐条排队，不在 await 点交错）；`setAlarm` → `setTimeout` →
  `instance.alarm()`。
- `sqlite-storage.mjs`：`node:sqlite` 适配 `sql.exec(...).toArray()`、
  `transactionSync`、KV `get/put/delete`（藏在被 schema 契约排除的 `_cf_KV` 表）。
- `server.mjs`：`node:http` → 标准 `Request` → `worker.fetch(request, env)` → `Response`；
  另起 60 秒循环调用 `scheduled()`（对应 `wrangler.jsonc` 的 cron 看门狗）。
- `main.mjs`：入口，读 secret、初始化 schema、绑定端口、处理 SIGTERM。

Cloudflare 部署路径保持可用，两者共享同一份 `src/worker.mjs`，无代码漂移。

## Secret 清单

这些值通过 `fly secrets set` 注入，**绝不进 `fly.toml` 或镜像**：

- `OPERATOR_TOKEN` — `/health` `/status` 的 Bearer 授权。
- `TELEGRAM_WEBHOOK_SECRET` — webhook 的 `X-Telegram-Bot-Api-Secret-Token` 校验。
- `TELEGRAM_BOT_TOKEN` — outbox 发消息用。
- `MASTER_ENC_KEY` — 加密存储 GMGN key 的密钥（字符串或 JSON keyring）。

`TELEGRAM_BOT_USERNAME` 是非 secret 配置（`fly.toml` 的 `[env]` 或 `fly secrets` 均可）。
GMGN key **不走环境变量**，经 Telegram `/onboard` 由用户上传、加密存储。

## 首次部署

```sh
fly auth login
fly apps create meme-radar                 # 或自定义名字
fly volumes create radar_data --size 1 --region nrt
fly ips allocate-v4 --dedicated            # 独立 IPv4，摆脱共享出口
fly secrets set OPERATOR_TOKEN TELEGRAM_WEBHOOK_SECRET TELEGRAM_BOT_TOKEN MASTER_ENC_KEY
                                           # 交互式逐项输入，不回显
fly deploy
```

部署后配置 Telegram webhook 指向 `https://<app>.fly.dev/webhook/telegram`，并带上
匹配的 `TELEGRAM_WEBHOOK_SECRET`。**切换前先 `wrangler deployments list` 确认旧
Cloudflare 部署已停用**，避免两个运行时同时消费同一 bot 的 update。

GMGN key：单租户自用，最省事是切换后在 Telegram 里重新 `/onboard`。若要用同一
`MASTER_ENC_KEY` 迁移已加密的行，需从原 DO 导出（额外步骤，非必需）。

## 卷与备份

SQLite 存在挂载到 `/data` 的 Fly Volume `radar_data` 上；Fly 本地磁盘是临时的，必须挂卷。
单机无 HA（自用可接受）。备份：

```sh
fly ssh console -C "sqlite3 /data/radar_*.sqlite '.backup /data/backup.sqlite'"
# 或定期 fly volumes snapshots list / create
```

## 升级

代码推送到分支后 `fly deploy` 即可；宿主与 Cloudflare 共享同一份 `src/worker.mjs`，
升级不会让两套代码漂移。

## 回滚

把 Telegram webhook 指回 Cloudflare 部署即可，代码零改动；必要时 `fly scale count 0`
停机（卷与 IP 保留）。

## 验证

- `curl https://<app>.fly.dev/health -H "Authorization: Bearer $OPERATOR_TOKEN"` 应返回
  `{"ok":true,"service":"meme-radar","lifecycle":"SKELETON"}`。
- Telegram `/status`、`/feed bsc` 观察 5 秒节拍与真实延迟（`pollLagMs`/`requestMs`）。
- `fly logs` 确认 GMGN 请求来自 Fly 出口且返回 200，不再出现 `RATE_LIMIT_BANNED`。

成本：1 台 `shared-cpu-1x` 256MB 常驻 ≈ $2.02/月 + 独立 IPv4 $2.00/月（+ 卷 $0.15/GB-月、
出网 $0.02/GB）≈ **$4/月**。
