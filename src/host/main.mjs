import './cloudflare-hook.mjs';
import { logEvent } from './log.mjs';

const { startHost } = await import('./host.mjs');

const PORT = 8787;
const dataDir = process.env.RADAR_DATA_DIR;
if (!dataDir) throw new TypeError('RADAR_DATA_DIR is required');

const host = await startHost({ dataDir, vars: process.env, port: PORT });
logEvent('host_started', { port: host.port, schemaVersion: host.radar.schemaVersion });

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, async () => {
    logEvent('host_stopping', { signal });
    await host.stop();
    logEvent('host_stopped');
  });
}
