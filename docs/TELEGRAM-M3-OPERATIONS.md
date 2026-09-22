# Telegram M3 implementation and validation

The implementation follows [the interface contract](TELEGRAM-M3-INTERFACE-DESIGN.md),
including the live, notification and seven-window statistics scope moved into M3.
Runtime implementation is in `src/bot/`, `src/render/telegram.mjs`,
`src/auth/key-store.mjs` and `src/radar-agent.mjs`.

## Configuration

Keep these secrets out of source control: `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_WEBHOOK_SECRET`, `MASTER_ENC_KEY`, and `OPERATOR_TOKEN`.
Set `TELEGRAM_BOT_USERNAME` to the username verified with Telegram for this bot
(without `@`). Commands without a mention work without that setting; mentioned
commands are rejected until the username is configured. The worker does not
accept a GMGN key from an environment fallback: each owner connects through
Telegram onboarding.

`MASTER_ENC_KEY` accepts the existing nonempty secret string or a JSON keyring
`{"activeVersion":"2","keys":{"1":"old material","2":"current material"}}`.
See [the credential boundary](development/ONBOARDING-CRYPTO.md) before rotation.
The public key is safe to display; private signing material is never exported.

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

Use `/onboard` to generate a tenant-specific Ed25519 public key. Create a read-only
GMGN API key at <https://gmgn.ai/ai?tab=api_management>, then send `/setkey <key>` or
a standalone key beginning with `gmgn_`.

**The plaintext key passes through Telegram and may remain in chat history.**
The bot attempts deletion, but Telegram may forbid it. Check and delete the
original message yourself. The service persists only encrypted candidate/active
keys, never echoes a submitted key, and displays only `gmgn_****`. Failure during
replacement preserves the prior connection; `/disconnect` fences pending
verification and removes stored keys. Read-only research; no trades or investment
advice.

中文：密钥明文会经过Telegram并可能留在聊天记录中。机器人会尝试删除，但无法保证删除；
请自行检查并删除原消息。服务端仅保存加密密钥，回显仅显示 `gmgn_****`。
失败的替换不会破坏之前的连接。只读研究，不执行交易；非投资建议。

## Behavior and recovery

- New commands create independent panels. Buttons edit their bound message;
  stale owner/message/session/domain versions cannot mutate current state.
- `/pause`, `/mute` and `/feed off` control scanning, alerts and collection
  independently. Live collection persists without chat activity, using the shared
  GMGN queue and a 20-second target, not a deadline guarantee.
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

Node contracts, real Workers SQLite tests, native Ed25519 workerd tests, command
and delivery end-to-end tests, type generation checks and a Wrangler dry build
exercise the implementation locally. Test provider and Telegram transports are
hand-written stubs; they never establish production network behavior.

[Ed25519 evidence](spikes/ED25519-WORKERS.md) proves native generation, PEM
round trips and signing/verification without `nodejs_compat`.
[Live timing evidence](spikes/LIVE-TIMING.md) reports actual local workerd/network
measurements and its limitations. **Issue #29 remains open until deployed GMGN,
DO-alarm timing and Cloudflare CPU measurements are captured.** The isolated
Worker target, GMGN test-credential source and Telegram test bot must be selected
before that deployment. No production bot or deployment is changed by local
verification.
