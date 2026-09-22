import { OneAlarmScheduler, defaultSchedulerRuntime, createTaskDescriptor, externalRequestHandler } from './scheduler.mjs';

/** Local-only scheduler probe. Endpoint responses are synthetic; elapsed times are measured. */
export default {
  async fetch(request, env) {
    const scenario = new URL(request.url).pathname.slice(1);
    if (!['normal', 'slow', 'rate-limit', 'miss'].includes(scenario)) return new Response('invalid scenario', { status: 400 });
    const startedAt = Date.now();
    const liveScheduledAt = startedAt + 10;
    let value = {
      tasks: ['scan', 'live'].map(kind => createTaskDescriptor({ id: kind, kind,
        dueAt: kind === 'live' ? liveScheduledAt : startedAt, enabled: true, needsGmgn: true, gmgnWeight: 1 })),
      runtime: { ...defaultSchedulerRuntime(), eligibility: { paused: false, configured: true } },
      gmgn: { nextAllowedAt: 0, backoffFactor: 1, lastRequestAt: 0, lastWeight: 1, successStreak: 0, spacingReadyAt: 0, keyEpoch: 0 }
    };
    const store = {
      read: () => structuredClone(value),
      update(mutator) { const result = mutator(structuredClone(value)); value = structuredClone(result.state); return structuredClone(result.value); },
      runLocalTransaction: operation => operation()
    };
    let alarmAt = null;
    let scanCompleted = 0;
    let scanAttempt = 0;
    const requests = [];
    const timeoutMs = Number(env.REQUEST_TIMEOUT_MS);
    const handler = externalRequestHandler(async ({ task, request: admittedRequest }) => {
      const requestStartedAt = Date.now();
      const sequence = task.kind === 'scan' ? ++scanAttempt : 1;
      const measurement = { kind: task.kind, sequence, scheduledAt: task.dueAt, startedAt: requestStartedAt,
        pollLagMs: task.kind === 'live' ? requestStartedAt - liveScheduledAt : null };
      try {
        const response = await admittedRequest(({ signal }) => fetch(`${env.ORIGIN}/${scenario}/${task.kind}/${sequence}`, { signal }));
        await response.arrayBuffer();
        measurement.status = response.status;
        if (response.status === 429) {
          const cooldownMs = Number(response.headers.get('Retry-After')) * 1000;
          store.update(current => ({ state: { ...current, gmgn: { ...current.gmgn, nextAllowedAt: Date.now() + cooldownMs, backoffFactor: 2, successStreak: 0 } }, value: null }));
          throw Object.assign(new Error('synthetic endpoint rate limit'), { code: 'GMGN_RATE_LIMITED', retryAfterMs: cooldownMs });
        }
        if (task.kind === 'scan') scanCompleted += 1;
        return { status: 'success', complete: task.kind === 'live' || scanCompleted === 3,
          ...(task.kind === 'scan' && scanCompleted < 3 ? { checkpoint: `source:${scanCompleted}` } : {}) };
      } catch (error) {
        if (typeof error?.code !== 'string' && error?.name !== 'AbortError') throw error;
        measurement.errorCode = error.code || error.name;
        throw error;
      } finally {
        measurement.requestMs = Date.now() - requestStartedAt;
        requests.push(measurement);
      }
    });
    const scheduler = new OneAlarmScheduler({ store,
      alarms: { async setAlarm(at) { alarmAt = at; }, async deleteAlarm() { alarmAt = null; } },
      handlers: { scan: handler, live: handler }, externalRequestTimeoutMs: timeoutMs });
    await scheduler.recomputeAlarm();
    const steps = [];
    for (let count = 0; count < 12 && alarmAt !== null; count++) {
      if (alarmAt > Date.now()) await new Promise(resolve => setTimeout(resolve, alarmAt - Date.now()));
      steps.push(await scheduler.alarm());
    }
    return Response.json({ scenario, environment: 'local-workerd-loopback', requestTimeoutMs: timeoutMs,
      minRequestGapMs: 1100, liveTargetMs: 20000, requests, steps,
      complete: value.tasks.length === 0, cpuMs: null, cpuUnavailableReason: 'No per-invocation CPU telemetry in this local probe',
      wallMs: Date.now() - startedAt });
  }
};
