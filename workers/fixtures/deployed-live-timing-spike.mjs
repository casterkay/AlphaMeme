import { GmgnClient, responseEvidence, gmgnRequestWeight } from '../../src/providers/gmgn.mjs';
import {
  OneAlarmScheduler,
  createTaskDescriptor,
  defaultSchedulerRuntime,
  externalRequestHandler
} from '../../src/scheduler.mjs';

const SCENARIOS = new Set(['normal', 'slow', 'rate-limit', 'miss']);
const REQUEST_TIMEOUT_MS = 30_000;
const GMGN_TIMEOUT_MS = 15_000;

function authorized(request, env) {
  return typeof env.PROBE_TOKEN === 'string'
    && env.PROBE_TOKEN.length > 0
    && request.headers.get('Authorization') === `Bearer ${env.PROBE_TOKEN}`;
}

function initialRecord(scenario) {
  const startedAt = Date.now();
  const liveScheduledAt = startedAt + 1_000;
  return {
    scenario,
    startedAt,
    liveScheduledAt,
    state: {
      tasks: ['scan', 'live'].map(kind => createTaskDescriptor({
        id: kind,
        kind,
        dueAt: kind === 'live' ? liveScheduledAt : startedAt,
        enabled: true,
        needsGmgn: true,
        gmgnWeight: gmgnRequestWeight('marketRank')
      })),
      runtime: { ...defaultSchedulerRuntime(), eligibility: { paused: false, configured: true } },
      gmgn: {
        nextAllowedAt: 0,
        backoffFactor: 1,
        lastRequestAt: 0,
        lastWeight: 1,
        successStreak: 0,
        spacingReadyAt: 0,
        keyEpoch: 0
      }
    },
    nextAlarmAt: null,
    scanAttempt: 0,
    scanCompleted: 0,
    requests: [],
    alarmDeliveries: [],
    steps: [],
    completedAt: null
  };
}

function publicResult(record) {
  const complete = record.state.tasks.length === 0 && !record.state.runtime.inFlight;
  return {
    scenario: record.scenario,
    environment: 'cloudflare-workers-durable-object',
    compatibilityDate: '2026-09-20',
    compatibilityFlags: [],
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    gmgnTimeoutMs: GMGN_TIMEOUT_MS,
    minRequestGapMs: 1_100,
    liveTargetMs: 20_000,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    wallMs: record.completedAt ? record.completedAt - record.startedAt : null,
    requests: record.requests,
    alarmDeliveries: record.alarmDeliveries,
    steps: record.steps,
    complete
  };
}

// Every fetch the client makes goes through here, so a refusal the client makes before reaching
// the network stays distinguishable from a provider rejection in the recorded result.
function controlledFetch(record, capture) {
  return async (url, options) => {
    capture.attempted = true;
    let response;
    try {
      response = await respond(record, url, options);
    } catch (error) {
      capture.transportError = String(error?.name || error);
      throw error;
    }
    try {
      // Probe payloads are single-row market reads, so reading the clone for evidence is bounded.
      capture.response = responseEvidence(response, await response.clone().text());
    } catch {
      capture.response = responseEvidence(response, '');
    }
    return response;
  };
}

async function respond(record, url, options) {
  const firstScan = record.activeKind === 'scan' && record.activeSequence === 1;
  if (record.scenario === 'slow' && firstScan) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, GMGN_TIMEOUT_MS + 5_000);
      const abort = () => {
        clearTimeout(timer);
        reject(options.signal?.reason || new DOMException('Aborted', 'AbortError'));
      };
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener('abort', abort, { once: true });
    });
  }
  if (record.scenario === 'rate-limit' && firstScan) {
    return Response.json({ code: 429, error: 'RATE_LIMIT_EXCEEDED' }, {
      status: 429,
      headers: { 'Retry-After': '2' }
    });
  }
  if (record.scenario === 'miss' && record.activeKind === 'scan') {
    return Response.json({ code: 404, error: 'NOT_FOUND' }, { status: 404 });
  }
  if (record.scenario !== 'normal') return Response.json({ code: 0, data: { rank: [] } });
  return fetch(url, options);
}

function memoryStore(record) {
  return {
    read: () => structuredClone(record.state),
    update(mutator) {
      const result = mutator(structuredClone(record.state));
      record.state = structuredClone(result.state);
      return structuredClone(result.value);
    },
    runLocalTransaction: operation => operation()
  };
}

function admissionStore(record) {
  return {
    read: async () => structuredClone(record.state.gmgn),
    write: async next => {
      record.state = { ...record.state, gmgn: structuredClone(next) };
      return structuredClone(next);
    }
  };
}

export class LiveTimingProbe {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    if (!authorized(request, this.env)) return new Response('unauthorized', { status: 401 });
    const action = new URL(request.url).pathname.split('/').filter(Boolean).at(-1);
    if (request.method === 'POST' && SCENARIOS.has(action)) {
      const record = initialRecord(action);
      await this.ctx.storage.put('record', record);
      await this.#scheduler(record).recomputeAlarm();
      await this.ctx.storage.put('record', record);
      return Response.json(publicResult(record), { status: 202 });
    }
    if (request.method === 'GET' && action === 'result') {
      const record = await this.ctx.storage.get('record');
      return record ? Response.json(publicResult(record)) : new Response('not found', { status: 404 });
    }
    return new Response('not found', { status: 404 });
  }

  async alarm() {
    const record = await this.ctx.storage.get('record');
    if (!record || record.completedAt) return;
    const alarmStartedAt = Date.now();
    record.alarmDeliveries.push({
      scheduledAt: record.nextAlarmAt,
      startedAt: alarmStartedAt,
      deliveryLagMs: record.nextAlarmAt === null ? null : alarmStartedAt - record.nextAlarmAt
    });
    const result = await this.#scheduler(record).alarm();
    record.steps.push({ at: Date.now(), status: result.status, taskId: result.taskId || null });
    if (record.state.tasks.length === 0 && !record.state.runtime.inFlight) record.completedAt = Date.now();
    await this.ctx.storage.put('record', record);
    console.log(JSON.stringify({
      event: 'probe_alarm',
      scenario: record.scenario,
      alarm: record.alarmDeliveries.at(-1),
      step: record.steps.at(-1),
      request: record.requests.at(-1),
      complete: Boolean(record.completedAt)
    }));
  }

  #scheduler(record) {
    const store = memoryStore(record);
    const handler = externalRequestHandler(async ({ task, request, gmgnReservation }) => {
      const sequence = task.kind === 'scan' ? ++record.scanAttempt : 1;
      const requestStartedAt = Date.now();
      record.activeKind = task.kind;
      record.activeSequence = sequence;
      const cooldownAt = record.state.gmgn.nextAllowedAt || 0;
      const measurement = {
        kind: task.kind,
        sequence,
        source: record.scenario === 'normal' ? 'gmgn' : 'controlled',
        scheduledAt: task.dueAt,
        startedAt: requestStartedAt,
        pollLagMs: task.kind === 'live' ? requestStartedAt - record.liveScheduledAt : null,
        clientCooldownAt: cooldownAt,
        cooldownRemainingMs: Math.max(0, cooldownAt - requestStartedAt)
      };
      const capture = { attempted: false, response: null, transportError: null };
      const gmgn = new GmgnClient({
        timeoutMs: GMGN_TIMEOUT_MS,
        apiKeyProvider: () => this.env.GMGN_API_KEY,
        legacyKeyProvider: () => '',
        fetch: controlledFetch(record, capture),
        admissionStateStore: admissionStore(record),
        admissionReservation: gmgnReservation
      });
      try {
        const result = await request(({ signal, timeoutMs }) => gmgn.marketRank('bsc', '1m', {
          limit: 1,
          order_by: 'volume',
          direction: 'desc',
          signal,
          deadline: Date.now() + timeoutMs
        }));
        measurement.outcome = 'ok';
      } catch (error) {
        measurement.outcome = 'error';
        measurement.errorCode = String(error?.code || error?.name || 'UNKNOWN');
      } finally {
        measurement.requestMs = Date.now() - requestStartedAt;
        measurement.networkAttempted = capture.attempted;
        measurement.network = capture.response;
        measurement.transportError = capture.transportError;
        record.requests.push(measurement);
        delete record.activeKind;
        delete record.activeSequence;
      }
      if (task.kind === 'live') return { status: 'success', complete: true };
      record.scanCompleted += 1;
      return {
        status: 'success',
        complete: record.scanCompleted === 3,
        ...(record.scanCompleted < 3 ? { checkpoint: `source:${record.scanCompleted}` } : {})
      };
    });
    return new OneAlarmScheduler({
      store,
      alarms: {
        setAlarm: async at => {
          record.nextAlarmAt = at;
          await this.ctx.storage.setAlarm(at);
        },
        deleteAlarm: async () => {
          record.nextAlarmAt = null;
          await this.ctx.storage.deleteAlarm();
        }
      },
      handlers: { scan: handler, live: handler },
      externalRequestTimeoutMs: REQUEST_TIMEOUT_MS
    });
  }
}

export default {
  async fetch(request, env) {
    if (!authorized(request, env)) return new Response('unauthorized', { status: 401 });
    const path = new URL(request.url).pathname.split('/').filter(Boolean);
    if (path.length !== 3 || path[0] !== 'runs') return new Response('not found', { status: 404 });
    const [, runId, action] = path;
    if (!/^[a-f0-9-]{36}$/.test(runId)) return new Response('invalid run id', { status: 400 });
    return env.LIVE_TIMING_PROBE.get(env.LIVE_TIMING_PROBE.idFromName(runId)).fetch(
      new Request(`https://probe.invalid/${action}`, request)
    );
  }
};
