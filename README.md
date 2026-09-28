# Meme雷达 · Cloudflare + Telegram 版

基于 [Meme雷达开源版](https://github.com/nhovongoc0-max/meme-radar) v0.1.10 的云端版本：
扫描器运行在 Cloudflare Workers（Durable Objects），通过 Telegram 机器人查看线索与接收提醒。
行情数据来自 AVE Data API，与上游一致。只读研究：不持有钱包私钥，不签名、不下单。

A cloud edition of Meme Radar v0.1.10: the scanner runs on Cloudflare Workers
(Durable Objects) and you use it through a Telegram bot. Market data comes from
the AVE Data API, as upstream. Read-only research: no wallet keys, signing or orders.

## 工作方式 / How it works

- 一次扫描一条链，默认 **Arc**（可选 BNB Chain、Base、Ethereum、Solana、Robinhood）。
  One chain is scanned at a time; **Arc** by default.
- 每轮读取该链的 AVE 热榜（100 条，5 个额度单位），用上游的 AVE 行情筛选（报价新鲜度、市值 1–15 万美元、
  流动性、币龄、5 分钟成交、已知风险字段）。通过筛选的代币立即成为**市场线索**并推送提醒。
  Each cycle reads the chain's AVE hot list and applies upstream's AVE market screen;
  every passing token becomes a **market lead** and alerts immediately.
- 线索随后由 GoPlus 与 DexScreener 免费核验（Arc：GoPlus 链 5042、DexScreener `arc`）。
  貔貅、异常税率等一票否决会撤销线索、隐藏交易入口并推送“风险恶化”。
  Leads are then checked on GoPlus and DexScreener; a fatal finding vetoes the lead,
  hides its trade link and sends a "risk worsened" follow-up.
- AVE 不提供持有人、交易者或合约安全数据，因此线索只是行情观察，**安全性未核验不代表安全**。
  AVE has no holder, trader or contract-security data: a lead is a market
  observation, and unverified does not mean safe.
- 代币详情提供“在AVE交易”链接；交易在 AVE 页面由你自己确认。
  Token details link to AVE, where you confirm any trade yourself.

## 额度与节奏 / Credits and pacing

目标节奏为每 15 秒一轮。每个 AVE 请求在发送前预留额度：请求间隔至少 15 秒，并按
“剩余额度 ÷ 距离重置的时间”自动放慢，确保本期额度用到重置日。AVE 限流会指数退避，
额度耗尽会暂停到下一期；不会自动购买额度。

The target cadence is 15 seconds. Each AVE request reserves credits first: requests
stay at least 15 s apart and slow down so the remaining allowance lasts until it
resets. Rate limits back off; an exhausted quota pauses until the next period.

`wrangler.jsonc` 的 `vars` 设置额度 / Set the allowance in `wrangler.jsonc` `vars`:

- `AVE_MONTHLY_CU`：每月额度单位（免费版 1,000,000）/ monthly credit units.
- `AVE_CU_RESET_DAY`：每月重置日（UTC，1–28）。免费版的重置日**未经核实**，默认按每月 1 日，请改成你账户的实际日期。
  The UTC reset day; the free plan's day is unverified and defaults to the 1st.

Telegram `/status` 显示本期已用额度与下一次请求时间（本地估算，以 AVE 账户为准）。

## 部署 / Deploy

需要 **Cloudflare Workers Paid**（$5/月）：实测每次读取与解析 AVE 热榜约用 11–26 ms CPU，
超过 Free 计划的 10 ms 上限（见 [docs/spikes/AVE-EGRESS.md](docs/spikes/AVE-EGRESS.md)）。
Requires Workers Paid: a hot-list read measured 11–26 ms CPU, above Free's 10 ms.

```sh
npm ci
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put MASTER_ENC_KEY        # long random string; see docs/development/ONBOARDING-CRYPTO.md
npx wrangler secret put OPERATOR_TOKEN
npx wrangler secret put TELEGRAM_BOT_USERNAME # without @
npx wrangler deploy
TELEGRAM_BOT_TOKEN=... node scripts/telegram-register.mjs
```

然后把 Telegram webhook 指向 `https://<worker>/webhook/telegram`，并带上相同的 `secret_token`。
Then point the Telegram webhook at `/webhook/telegram` with the same `secret_token`.

曾部署过 GMGN 版本的，请先 `npx wrangler delete` 再部署：数据库结构已升级到 v2，旧数据不迁移。
If you deployed the GMGN version, delete it first; the schema moved to v2 without a migration.

## 在 Telegram 中使用 / Using the bot

1. `/start`，然后 `/onboard`：登录 [AVE Cloud](https://cloud.ave.ai/login) 复制 Data API Key。
2. 发送 `/setkey <key>`：验证读取一次（5 个额度）后开始扫描 Arc。含密钥的消息会尝试删除，请自行确认已删除。
3. `/unmute` 开启线索提醒；`/chains` 切换扫描链；`/feed` 查看热榜；`/audits` 查看线索与核验；`/status` 查看运行与额度。

`/help` 列出全部命令。运维细节见 [docs/TELEGRAM-M3-OPERATIONS.md](docs/TELEGRAM-M3-OPERATIONS.md)。

## 开发 / Development

```sh
npm test            # node:test contracts and Workers runtime tests
npx wrangler deploy --dry-run
```

## 许可 / License

源代码采用 [GNU Affero General Public License v3.0](LICENSE)（`AGPL-3.0-only`）。若修改后通过网络向他人提供服务，
须按许可证向这些用户提供对应源代码。第三方数据接口仍受各自服务条款约束。候选仅为行情观察线索，
不是安全保证、收益承诺或买入建议。
