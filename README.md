# Meme雷达 · Cloudflare + Telegram 版

基于 [Meme雷达开源版](https://github.com/nhovongoc0-max/meme-radar) v0.1.10 的云端版本：
扫描器运行在 Cloudflare Workers（Durable Objects），通过 Telegram 机器人查看线索与接收提醒。
行情数据来自 AVE Data API，与上游一致。AVE Key 只读；可选的一键交易使用机器人为你生成的独立热钱包，每笔需确认报价。

A cloud edition of Meme Radar v0.1.10: the scanner runs on Cloudflare Workers
(Durable Objects) and you use it through a Telegram bot. Market data comes from
the AVE Data API, as upstream. The AVE key is read-only; optional one-tap trading
uses a separate hot wallet the bot generates for you, and every trade needs a confirmed quote.

## 工作方式 / How it works

- 一次扫描一条链，默认 **Arc**（可选 BNB Chain、Base、Ethereum、Robinhood；只支持 EVM 链）。
  One chain is scanned at a time; **Arc** by default (BNB Chain, Base, Ethereum and
  Robinhood are the other choices; only EVM chains are supported).
- 每轮读取该链的 AVE 热榜（100 条，5 个额度单位），用上游的 AVE 行情筛选（报价新鲜度、市值 1–15 万美元、
  流动性、币龄、5 分钟成交、已知风险字段）。通过筛选的代币立即成为**市场线索**并推送提醒。
  Each cycle reads the chain's AVE hot list and applies upstream's AVE market screen;
  every passing token becomes a **market lead** and alerts immediately.
- 在 Arc 上，每轮还读取链上新建的资金池（Uniswap v3/v4），在 DexScreener 上观察；
  5 分钟成交、买单与流动性达标后读取 AVE 行情（5 个额度单位）并与热榜一同筛选。
  读取使用 `ARC_RPC_URL`（与交易共用）；未设置时 /status 的来源显示“未配置”。
  On Arc each cycle also reads the pools the chain just created, watches them on
  DexScreener, and screens the ones that trade enough with the hot list (an AVE market
  read, 5 credits). It reads through `ARC_RPC_URL`, the RPC trading uses; without it
  the source shows as not configured. The RPC must serve `eth_getLogs` over 500-block
  ranges (Arc's public RPC does; Alchemy's free plan allows 10).
- 线索随后由 GoPlus 与 DexScreener 免费核验（Arc：GoPlus 链 5042、DexScreener `arc`）。
  貔貅、异常税率等一票否决会撤销线索并推送“风险恶化”。
  Leads are then checked on GoPlus and DexScreener; a fatal finding vetoes the lead
  and sends a "risk worsened" follow-up.
- AVE 不提供持有人、交易者或合约安全数据，因此线索只是行情观察，**安全性未核验不代表安全**。
  AVE has no holder, trader or contract-security data: a lead is a market
  observation, and unverified does not mean safe.

## 一键交易 / One-tap trading

- `/wallet` 生成专用 EVM 交易钱包（不会导入你的私钥），显示地址、余额和最近交易。**这是热钱包**：私钥加密保存在你的
  Durable Object 中并由机器人签名；只存入你愿意承担风险的小额资金。
  `/wallet` generates a dedicated EVM trading wallet (it never imports your key) and shows
  its address, balances and recent trades. **It is a hot wallet**: the bot keeps the key
  encrypted in your Durable Object and signs with it; fund it only with amounts you can lose.
- 代币详情提供 买 $10/$20/$50/自定义 与 卖 25%/50%/100%/自定义%。第一次点击获取 KyberSwap 报价并显示确认页
  （支出与换算、预计/最少获得、价格影响、滑点、Gas、单笔上限）；报价 30 秒后过期，过期确认会重新报价。
  Token details offer Buy $10/$20/$50/custom and Sell 25%/50%/100%/custom %. The first tap
  fetches a KyberSwap quote and shows a confirm screen; quotes expire after 30 s and an
  expired confirmation re-quotes instead of executing.
- 支持链：Arc（用 USDC 买入，Gas 也用 USDC）、BNB Chain、Base、Ethereum（用原生币买入）。Robinhood 不支持交易。
  Chains: Arc (buys spend USDC, which also pays gas), BNB Chain, Base and Ethereum (buys
  spend the native coin). Robinhood cannot trade.
- 安全核验否决（GoPlus 致命风险）的代币禁止买入，卖出不受限制。安全核验尚未完成的代币，买入前需先确认「是 / 否」。单笔买入上限默认 $100，滑点默认 5%，可在交易限额中调整。
  A token vetoed by the safety check cannot be bought; selling is never blocked. Buying a
  token the check has not verified yet first asks Yes/No. The per-trade buy cap defaults
  to $100 and slippage to 5%; both are adjustable under Trade limits.
- 费用：只有 DEX 路由费用和链上 Gas，机器人不收取任何费用。Fees: DEX routing and gas only; the bot charges 0.
- 导出私钥需二次确认，私钥只发送一次并在 60 秒后尝试删除；移除钱包会删除私钥，未导出时资金无法找回。
  `/disconnect` 只断开 AVE，不影响交易钱包。
  Key export needs a confirmation, sends the key once and tries to delete it after 60 s.
  Removing the wallet deletes its key; without an export its funds are unrecoverable.
  `/disconnect` disconnects AVE only and keeps the trading wallet.

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

每条链只有一个 RPC URL，链上读取与交易共用；设置后，用户在 /wallet 创建钱包即可在该链交易。
在 `wrangler.jsonc` 的 `vars` 中设置 RPC URL 与 `KYBER_CLIENT_ID`：
Each chain has one RPC URL, shared by chain reads and trading; once it is set, a user
who creates a wallet under /wallet can trade on that chain. Set the RPC URL and
`KYBER_CLIENT_ID` in `wrangler.jsonc` `vars`:

| Var | Meaning |
| --- | --- |
| `KYBER_CLIENT_ID` | `x-client-id` sent to the KyberSwap Aggregator; required once any chain is enabled |
| `ARC_RPC_URL`, `BSC_RPC_URL`, `BASE_RPC_URL`, `ETH_RPC_URL` | https JSON-RPC endpoint; empty disables that chain's reads and trading. A URL holding a provider key belongs in a secret instead of `vars` |
| `BSC_EXPLORER_URL`, `BASE_EXPLORER_URL`, `ETH_EXPLORER_URL` | optional; default bscscan.com, basescan.org, etherscan.io |
| `ARC_EXPLORER_URL` | optional, no default; without it Arc trades show the transaction hash only |

KyberSwap 的 Arc 路由（`arc` 网络标识与以 ERC-20 USDC 报价）尚未在线验证；启用 Arc 前请先小额试用。
KyberSwap's Arc routing (the `arc` slug and quoting ERC-20 USDC) is not yet verified
live; try a small amount before relying on it.

然后把 Telegram webhook 指向 `https://<worker>/webhook/telegram`，并带上相同的 `secret_token`。
Then point the Telegram webhook at `/webhook/telegram` with the same `secret_token`.

曾部署过 GMGN 版本的，请先 `npx wrangler delete` 再部署：数据库结构已升级到 v2，旧数据不迁移。
If you deployed the GMGN version, delete it first; the schema moved to v2 without a migration.

## 在 Telegram 中使用 / Using the bot

1. `/start`，然后 `/onboard`：登录 [AVE Cloud](https://cloud.ave.ai/login) 复制 Data API Key。
2. 发送 `/setkey <key>`：验证读取一次（5 个额度）后开始扫描 Arc。含密钥的消息会尝试删除，请自行确认已删除。
3. 线索提醒默认开启，`/mute` 可关闭或重新开启；`/radar` 查看最新线索；`/leads` 查看线索与核验；`/hot` 查看热榜；`/watchlist` 查看自选；`/performance` 查看筛选后表现；`/settings` 切换扫描链、提醒与交易限额；`/status` 查看运行与额度。
4. 粘贴代币合约地址即可实时查询（AVE 行情，再由 DexScreener 与 GoPlus 核验）；查询结果不算线索。
   Paste a token contract address for a live lookup (AVE market data, then DexScreener and GoPlus checks); a looked-up token is not a lead.
5. 可选：`/wallet` 创建交易钱包并充值，然后在代币详情中买卖。

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
