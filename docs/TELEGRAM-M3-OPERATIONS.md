# Telegram M3 implementation and validation

The implementation follows [the interface contract](TELEGRAM-M3-INTERFACE-DESIGN.md),
with the AVE changes below: data comes from the AVE Data API, one chain is scanned
at a time (Arc by default), and alerts are AVE market leads rather than deep-audit
passes. Runtime implementation is in `src/bot/`, `src/render/telegram.mjs`,
`src/auth/connection.mjs`, `src/recoverable-scanner.mjs` and `src/radar-agent.mjs`.

## Configuration

Keep these secrets out of source control: `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_WEBHOOK_SECRET`, `MASTER_ENC_KEY`, and `OPERATOR_TOKEN`.
Set `TELEGRAM_BOT_USERNAME` to the username verified with Telegram for this bot
(without `@`). Commands without a mention work without that setting; mentioned
commands are rejected until the username is configured. The worker does not
accept an AVE key from an environment fallback: each owner connects through
Telegram onboarding. `AVE_MONTHLY_CU` and `AVE_CU_RESET_DAY` in `wrangler.jsonc`
set the plan allowance that admission paces requests against.

`MASTER_ENC_KEY` accepts the existing nonempty secret string or a JSON keyring
`{"activeVersion":"2","keys":{"1":"old material","2":"current material"}}`.
See [the credential boundary](development/ONBOARDING-CRYPTO.md) before rotation.

Register the private-chat command menu with the deployed bot's token supplied
through the environment:

```sh
node scripts/telegram-register.mjs
```

This uses `setMyCommands` for default Chinese, Chinese and English. No token is
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
connection; `/disconnect` fences pending verification and removes stored keys.
Read-only research; no trades or investment advice.

中文：密钥明文会经过Telegram并可能留在聊天记录中。机器人会尝试删除，但无法保证删除；
请自行检查并删除原消息。服务端仅保存加密密钥，从不回显。失败的替换不会破坏之前的连接。
只读研究，不执行交易；非投资建议。

## Behavior and recovery

- New commands create independent panels. Buttons edit their bound message;
  stale owner/message/session/domain versions cannot mutate current state.
- `/pause` and `/mute` control scanning and alerts independently. `/chains`
  switches the single scan chain; the old chain's research records stay.
  `/feed` shows the scanner's latest AVE hot list; it makes no extra requests.
- Every passing hot-list token becomes a lead and alerts at once. GoPlus and
  DexScreener then check it; a fatal finding vetoes the lead, hides its AVE trade
  link and sends a "risk worsened" notice to anyone it alerted.
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

## Validation boundary

Node contracts, real Workers SQLite tests, command and delivery end-to-end tests,
type generation checks and a Wrangler dry build exercise the implementation
locally. Test provider and Telegram transports are hand-written stubs; they never
establish production network behavior. [AVE egress evidence](spikes/AVE-EGRESS.md)
records deployed reads from Workers egress, the 15-second cadence and per-read CPU.
[Live timing evidence](spikes/LIVE-TIMING.md) records why GMGN was abandoned: it
banned Cloudflare's shared Workers egress address.
