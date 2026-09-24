import { mkdirSync } from 'node:fs';
import { DurableObjectHost } from './durable-object-host.mjs';
import { createServer, startScheduledLoop } from './server.mjs';
import worker, { RadarAgent, TenantRegistry } from '../worker.mjs';

const storageDirectory = process.env.STORAGE_DIRECTORY || '/data';
mkdirSync(storageDirectory, { recursive: true });

const requiredSecrets = ['OPERATOR_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'TELEGRAM_BOT_TOKEN', 'MASTER_ENC_KEY'];
const missing = requiredSecrets.filter(name => !process.env[name]);
if (missing.length) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

const host = new DurableObjectHost({ storageDirectory });

const env = {
  OPERATOR_TOKEN: process.env.OPERATOR_TOKEN,
  TELEGRAM_WEBHOOK_SECRET: process.env.TELEGRAM_WEBHOOK_SECRET,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_BOT_USERNAME: process.env.TELEGRAM_BOT_USERNAME || '',
  MASTER_ENC_KEY: process.env.MASTER_ENC_KEY,
  RADAR: host.namespace(RadarAgent),
  TENANT_REGISTRY: host.namespace(TenantRegistry)
};

host.setEnvironment(env);

const port = Number(process.env.PORT || 8080);
const hostname = process.env.HOST || '0.0.0.0';
const server = createServer({ worker, env });
server.listen(port, hostname, () => {
  console.log(JSON.stringify({ event: 'server_started', port, storageDirectory }));
});
startScheduledLoop({ worker, env });

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ event: 'shutdown', signal }));
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
