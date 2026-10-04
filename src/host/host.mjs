import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { RadarAgent } from '../radar-agent.mjs';
import { TenantRegistry } from '../tenant-registry.mjs';
import worker from '../worker.mjs';
import { parseTelegramUpdate } from '../telegram-intake.mjs';
import { readSchedulerTenant } from '../storage/scheduler-state.mjs';
import { AlarmRunner } from './alarm.mjs';
import { logEvent } from './log.mjs';
import { hostEntries, initializeHostSchema } from './state.mjs';
import { DATABASE_FILES, openDatabase, sqliteStorage } from './storage.mjs';
import { TelegramPoller } from './telegram-polling.mjs';

const WATCHDOG_INTERVAL_MS = 60_000;

/**
 * Runs the radar in this process: one RadarAgent and one TenantRegistry over
 * the three databases in `dataDir`, their alarm, the watchdog wake, Telegram
 * long polling, and the Worker's operator routes on 127.0.0.1:`port`.
 */
export async function startHost({ dataDir, vars, port, telegramRetryPauseMs }) {
  if (typeof vars.TELEGRAM_BOT_TOKEN !== 'string' || !vars.TELEGRAM_BOT_TOKEN.trim()) throw new TypeError('TELEGRAM_BOT_TOKEN is required');
  mkdirSync(dataDir, { recursive: true });
  const databases = Object.fromEntries(Object.entries(DATABASE_FILES).map(([name, file]) => [name, openDatabase(join(dataDir, file))]));
  const storage = Object.fromEntries(Object.entries(databases).map(([name, db]) => [name, sqliteStorage(db)]));
  initializeHostSchema(storage.host);

  const background = new Set();
  const runInBackground = (promise, failureEvent) => {
    const settled = promise.then(() => {}, error => logEvent(failureEvent, { error }));
    background.add(settled);
    settled.finally(() => background.delete(settled));
  };
  const ready = [];
  const context = (name, alarm) => ({
    storage: {
      ...storage[name],
      ...asyncEntries(hostEntries(storage.host, name)),
      ...(alarm && {
        getAlarm: async () => alarm.getAlarm(),
        setAlarm: async at => alarm.setAlarm(at),
        deleteAlarm: async () => alarm.deleteAlarm()
      })
    },
    blockConcurrencyWhile: callback => {
      const done = callback();
      ready.push(done);
      return done;
    },
    waitUntil: promise => runInBackground(promise, 'background_task_failed')
  });

  // The bindings resolve every name to the one instance: the service is single-tenant.
  let radar, registry;
  const env = {
    ...vars,
    RADAR: { idFromName: name => name, get: () => radar },
    TENANT_REGISTRY: { idFromName: name => name, get: () => registry, getByName: () => registry }
  };
  const alarm = new AlarmRunner({ entries: hostEntries(storage.host, 'host'), key: 'radar.alarm', handler: () => radar.alarm() });
  registry = new TenantRegistry(context('registry'), env);
  radar = new RadarAgent(context('radar', alarm), env);
  await Promise.all(ready);

  const server = createServer((request, response) => serveOperatorRoute(request, response, env));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  alarm.start();

  const watchdog = setInterval(() => runInBackground(
    registry.scheduledWake().then(result => logEvent('scheduler_watchdog', result)),
    'scheduler_watchdog_failed'
  ), WATCHDOG_INTERVAL_MS);

  // The service is single-tenant: once the radar belongs to an owner, other senders are declined.
  const poller = new TelegramPoller({
    botToken: vars.TELEGRAM_BOT_TOKEN,
    entries: hostEntries(storage.host, 'host'),
    retryPauseMs: telegramRetryPauseMs,
    async receive(update) {
      const parsed = parseTelegramUpdate(update, { botUsername: vars.TELEGRAM_BOT_USERNAME });
      if (!['accepted', 'credential'].includes(parsed.kind)) return 'declined';
      const owner = readSchedulerTenant(storage.radar);
      if (owner && owner !== parsed.receipt.tenantId) return 'declined';
      await registry.registerTenant(parsed.receipt.tenantId);
      const result = parsed.kind === 'credential'
        ? await radar.receiveTelegramCredential(parsed.receipt, parsed.credentialText)
        : await radar.receiveTelegramUpdate(parsed.receipt);
      return result.accepted ? 'stored' : 'declined';
    }
  });
  poller.start();

  return {
    radar,
    registry,
    storage,
    alarm,
    port: server.address().port,
    async stop() {
      clearInterval(watchdog);
      server.closeAllConnections();
      await Promise.all([poller.stop(), alarm.stop(), new Promise(resolve => server.close(resolve))]);
      await Promise.all(background);
      for (const db of Object.values(databases)) db.close();
    }
  };
}

function asyncEntries(entries) {
  return {
    get: async key => entries.get(key),
    put: async (key, value) => entries.put(key, value),
    delete: async key => entries.delete(key)
  };
}

// /health, /status and the other operator routes, answered by the Worker's own
// handler. No request body is passed on: the Telegram webhook route is unused here.
async function serveOperatorRoute(request, response, env) {
  try {
    const answer = await worker.fetch(new Request(new URL(request.url, 'http://127.0.0.1'), { method: request.method, headers: request.headers }), env);
    response.writeHead(answer.status, Object.fromEntries(answer.headers));
    response.end(Buffer.from(await answer.arrayBuffer()));
  } catch (error) {
    logEvent('operator_route_failed', { error });
    response.writeHead(500).end();
  }
}
