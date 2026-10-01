# Telegram implementation and operations

This is the current runtime and operations guide. The implementation originated
from the [archived M3 interface contract](.archive/TELEGRAM-M3-INTERFACE-DESIGN.md),
but current behavior is authoritative here: data comes from the AVE Data API, one
chain is scanned at a time (Arc by default), and alerts are AVE market leads rather
than GMGN deep-audit passes. Current interface changes are tracked in the
[Telegram UX plan](TELEGRAM-UX-PLAN.md). Runtime implementation is in `src/bot/`,
`src/render/telegram.mjs`, `src/auth/connection.mjs`,
`src/recoverable-scanner.mjs` and `src/radar-agent.mjs`.

## Configuration

Keep these secrets out of source control: `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_WEBHOOK_SECRET`, `MASTER_ENC_KEY`, and `OPERATOR_TOKEN`.
Set `TELEGRAM_BOT_USERNAME` to the username verified with Telegram for this bot
(without `@`). Commands without a mention work without that setting; mentioned
commands are rejected until the username is configured. The worker does not
accept an AVE key from an environment fallback: each owner connects through
Telegram onboarding. `AVE_MONTHLY_CU` and `AVE_CU_RESET_DAY` in `wrangler.jsonc`
set the plan allowance that admission paces requests against.

Trading is configured by `vars`: `KYBER_CLIENT_ID` and one https RPC URL per chain
(`ARC_RPC_URL`, `BSC_RPC_URL`, `BASE_RPC_URL`, `ETH_RPC_URL`; empty disables the
chain), plus optional explorer bases (`ARC_EXPLORER_URL` has no default). The
config is parsed when the Telegram runtime starts; a malformed value fails every
request loudly rather than disabling a chain silently. The KyberSwap `arc` slug
and ERC-20 USDC quoting on Arc are unverified from the development sandbox and
need a live check before Arc trading is announced.

`MASTER_ENC_KEY` accepts the existing nonempty secret string or a JSON keyring
`{"activeVersion":"2","keys":{"1":"old material","2":"current material"}}`.
See [the credential boundary](development/ONBOARDING-CRYPTO.md) before rotation.

Register the private-chat command menu with the deployed bot's token supplied
through the environment:

```sh
node scripts/telegram-register.mjs
```

This registers the eight-command menu (`/radar`, `/leads`, `/hot`, `/watchlist`,
`/wallet`, `/performance`, `/settings`, `/help`) with `setMyCommands`: English for
the default and `en` scopes, Chinese for `zh`. No token is
accepted as a command-line argument or printed. Configure Telegram's webhook to
`/webhook/telegram` with the matching webhook secret after the isolated deployment
has been approved and verified. Registering a webhook or commands changes the
selected bot; the implementation task has not done this to an existing bot.

## Onboarding and key safety

Use `/onboard` for instructions: sign in to <https://cloud.ave.ai/login>, copy the
Data API key, then send `/setkey <key>`. Verification spends one 5-credit AVE read.

**The plaintext key passes through Telegram and may remain in chat history.**
The bot attempts deletion, but Telegram may forbid it. Check and delete the
original message yourself. The service persists only encrypted candidate/active
keys and never echoes a key. Failure during replacement preserves the prior
connection; `/disconnect` fences pending verification and removes the stored AVE
keys (the trading wallet stays). The AVE key is read-only; not investment advice.

中文：密钥明文会经过Telegram并可能留在聊天记录中。机器人会尝试删除，但无法保证删除；
请自行检查并删除原消息。服务端仅保存加密密钥，从不回显。失败的替换不会破坏之前的连接。
AVE密钥只读；交易钱包不受 /disconnect 影响；非投资建议。

## Behavior and recovery

- New commands create independent panels. Buttons edit their bound message;
  stale owner/message/session/domain versions cannot mutate current state.
- `/pause` and `/mute` control scanning and alerts independently. `/chains`
  switches the single scan chain; the old chain's research records stay.
  `/hot` shows the scanner's latest AVE hot list; it makes no extra requests.
- Rarer commands (`/start`, `/activity`, `/status`, `/chains`, `/pause`,
  `/resume`, `/mute`, `/lang`, `/note`, `/cancel`, `/export`, `/onboard`,
  `/setkey`, `/disconnect`) work but stay out of the menu; `/help` lists them.
  The retired slugs `/audits`, `/candidates`, `/feed`, `/saved`, `/stats` and
  `/events` have no aliases: like any unknown command they open Help.
- Every passing hot-list token becomes a lead and alerts at once. GoPlus and
  DexScreener then check it; a fatal finding vetoes the lead, blocks buying it and
  sends a "risk worsened" notice to anyone it alerted.
- Search and notes use a five-minute ForceReply prompt. Credentials are routed
  before note/search input and are never persisted as either.
- An uncertain Telegram send gets at most one automatic uncertain retry over its
  entire lifetime. A second uncertainty suspends it; `/status` exposes it. The
  system does not promise external exactly-once or guaranteed delivery.
- Only allowlisted actionable notifications are sent. Routine rank, outcome and
  scan changes stay in requested panels. Approval expiry and evidence revisions
  correct every mapped detail card, including while muted.
- `/export` sends the all-chain research whitelist. Exports above the service's
  10 MiB limit fail with an explicit message; no silent truncation is used.

## Trading operations

- Trades are `trade:<id>` rows in `scheduler_state`, executed by scheduler tasks of
  kind `trade` (one network request per step). States: QUOTING → QUOTED → CONFIRMED
  → [APPROVE_SIGNED → APPROVE_SENT → APPROVED] → SWAP_SIGNED → SWAP_SENT → FILLED,
  or FAILED, UNKNOWN, EXPIRED, CANCELLED. The newest 20 finished trades are kept.
- A signed transaction is persisted with its hash before it is broadcast. After a
  restart the identical raw transaction is rebroadcast; a step never signs twice.
  A broadcast without an answer is treated as sent and settled by its receipt.
- Receipts are polled every 3 s (the identical transaction is rebroadcast every
  fifth poll). No receipt within 10 minutes marks the trade UNKNOWN with its
  transaction link; nothing is replaced or re-signed automatically. Check the
  explorer and the wallet balance before trading again.
- Only an allowlisted node refusal (insufficient funds, nonce too low, intrinsic
  gas too low, underpriced or replacement underpriced, fee below base fee, invalid
  sender or chain id, over the block gas limit or fee cap) counts as "not
  broadcast", and then only when the transaction has no receipt. Every other
  answer (timeouts, 5xx, internal or unknown errors) is ambiguous: the trade stays
  sent, is polled and rebroadcast, and becomes UNKNOWN at the deadline.
- If the scheduler gives up on a trade step, the trade ends FAILED when nothing
  was signed and UNKNOWN otherwise; the wallet is free again either way.
- An UNKNOWN trade is rechecked from "Check the receipt again" or a wallet
  refresh: a receipt settles it, and a confirmed later nonce proves it can never
  mine (FAILED).
- Before quoting and again right before signing, the router calldata is decoded
  (MetaAggregationRouterV2 `swap`/`swapSimpleMode`, ABI in
  `src/trading/router-abi.mjs`) and refused unless it swaps exactly the requested
  tokens and amount to the wallet, for at least the minimum the confirm screen
  showed, with no fee receivers, no permit and zero flags. Nonzero flags from a
  live build are unverified and would refuse every swap; check this live first.
- Wallet removal is refused while a trade is open or UNKNOWN, and asks for an
  export first when the key was never exported and the last balance check saw
  funds.
- One trade executes per wallet at a time; a second confirmation is refused.
- Defaults (`TRADING_SETTINGS` in `src/trading/config.mjs`): 5% slippage
  (1/3/5/10/20%), $100 per-trade buy cap ($50/$100/$250/$500/$1000), 30 s quotes,
  10-minute swap deadline, 20% gas-limit buffer, exact approvals only when the
  allowance is short, sells of 100% use the balance read at quote time.

## Validation boundary

Node contracts, real Workers SQLite tests, command and delivery end-to-end tests,
type generation checks and a Wrangler dry build exercise the implementation
locally. Test provider and Telegram transports are hand-written stubs; they never
establish production network behavior. [AVE egress evidence](spikes/AVE-EGRESS.md)
records deployed reads from Workers egress, the 15-second cadence and per-read CPU.
[Live timing evidence](spikes/LIVE-TIMING.md) records why GMGN was abandoned: it
banned Cloudflare's shared Workers egress address.
