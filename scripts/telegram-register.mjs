import { telegramCommandRegistrations } from '../src/bot/panels.mjs';
import { createTelegramTransport } from '../src/bot/telegram-transport.mjs';

const transport = createTelegramTransport({ botToken: process.env.TELEGRAM_BOT_TOKEN });
const registrations = telegramCommandRegistrations();
for (const params of registrations) {
  const result = await transport({ method: 'setMyCommands', params });
  if (!result.ok) throw new Error(`Command registration failed: ${result.code}`);
}
console.log(JSON.stringify({ registered: true, scopes: registrations.map(params => params.language_code ?? 'default') }));
