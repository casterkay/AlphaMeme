import { telegramCommandRegistrations } from '../src/bot/panels.mjs';
import { createTelegramTransport } from '../src/bot/telegram-transport.mjs';

const transport = createTelegramTransport({ botToken: process.env.TELEGRAM_BOT_TOKEN });
for (const params of telegramCommandRegistrations()) {
  const result = await transport({ method: 'setMyCommands', params });
  if (!result.ok) throw new Error(`Command registration failed: ${result.code}`);
}
console.log(JSON.stringify({ registered: true, scopes: ['default English', 'Chinese', 'English'] }));
