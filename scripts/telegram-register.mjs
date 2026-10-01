import { telegramCommandDescriptions } from '../src/bot/panels.mjs';
import { createTelegramTransport } from '../src/bot/telegram-transport.mjs';

// The default scope is English; Chinese Telegram clients get the zh scope. The en
// scope is rewritten too so an earlier registration cannot leave stale commands.
const transport = createTelegramTransport({ botToken: process.env.TELEGRAM_BOT_TOKEN });
for (const language of ['', 'zh', 'en']) {
  const result = await transport({ method: 'setMyCommands', params: { commands: telegramCommandDescriptions(language === 'zh' ? 'zh' : 'en'), scope: { type: 'all_private_chats' }, ...(language ? { language_code: language } : {}) } });
  if (!result.ok) throw new Error(`Command registration failed: ${result.code}`);
}
console.log(JSON.stringify({ registered: true, scopes: ['default English', 'Chinese', 'English'] }));
