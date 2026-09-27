// Local dev entry: run the Node host with the same secrets the Worker/Fly runtime uses.
// Secrets are read from files and never echoed:
//   .dev.vars                              (OPERATOR_TOKEN, MASTER_ENC_KEY)
//   ~/.config/meme-radar/telegram.env      (TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET)
// Launch: node --import ./src/host/register.mjs ./scripts/local-run.mjs
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

function loadDotVars(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return; }
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    if (!process.env[key]) process.env[key] = t.slice(eq + 1).trim();
  }
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
loadDotVars(process.env.DEV_VARS || `${repoRoot}/.dev.vars`);
loadDotVars(process.env.TELEGRAM_ENV || `${homedir()}/.config/meme-radar/telegram.env`);
process.env.STORAGE_DIRECTORY = process.env.STORAGE_DIRECTORY || `${homedir()}/.config/meme-radar/state`;
process.env.PORT = process.env.PORT || '8080';

await import('../src/host/main.mjs');
