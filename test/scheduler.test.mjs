import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BoundedStepError,
  OneAlarmScheduler,
  createTaskDescriptor,
  defaultSchedulerRuntime,
  deriveTaskDescriptors,
  externalRequestHandler,
  localTransactionHandler,
  nextDue,
  normalizeSchedulerRuntime,
  schedulerEligibleTasks,
  selectReadyTask
} from '../src/scheduler.mjs';
import { GmgnClient } from '../src/providers/gmgn.mjs';
import { RecoverableScanner } from '../src/recoverable-scanner.mjs';
import { executeRecoverableScanStep } from '../src/recoverable-scan-executor.mjs';

const NOW = 100_000;

function task(id, kind, dueAt, options = {}) {
  return createTaskDescriptor({
    id,
    kind,
    dueAt,
    enabled: true,
    needsGmgn: false,
    ...options
  });
}

function admission(overrides = {}) {
  return {
    nextAllowedAt: 0,
    backoffFactor: 1,
    lastRequestAt: 0,
    lastWeight: 1,
    successStreak: 0,
    spacingReadyAt: 0,
    keyEpoch: 0,
    ...overrides
  };
}

class MemorySchedulerStore {
  constructor({ tasks = [], runtime = defaultSchedulerRuntime(), gmgn = admission() } = {}) {
    this.value = { tasks: structuredClone(tasks), runtime: structuredClone(runtime), gmgn: structuredClone(gmgn) };
    this.localTransactions = 0;
  }

  read() {
    return structuredClone(this.value);
  }

  update(mutator) {
    const update = mutator(this.read());
    this.value = structuredClone(update.state);
    return structuredClone(update.value);
  }

  runLocalTransaction(callback) {
    this.localTransactions += 1;
    return callback();
  }
}

class MemoryAlarm {
  constructor() {
    this.at = null;
    this.setCalls = [];
    this.deleteCalls = 0;
  }

  async setAlarm(at) {
    this.at = at;
    this.setCalls.push(at);
  }

  async deleteAlarm() {
    this.at = null;
    this.deleteCalls += 1;
  }
}

function scheduler(options = {}) {
  const store = options.store || new MemorySchedulerStore();
  const alarms = options.alarms || new MemoryAlarm();
  return {
    store,
    alarms,
    instance: new OneAlarmScheduler({
      store,
      alarms,
      now: () => NOW,
      minGmgnGapMs: 50,
      ...options
    })
  };
}

function recoverableScanner({ now = () => NOW } = {}) {
  const checkpoints = new Map();
  const store = {
    begin(value) {
      const checkpoint = { tenantId: '1000', ...structuredClone(value) };
      checkpoints.set(checkpoint.cycleId, checkpoint);
      return structuredClone(checkpoint);
    },
    read(cycleId) {
      const checkpoint = checkpoints.get(cycleId);
      return checkpoint ? structuredClone(checkpoint) : null;
    },
    advance({ expected, next }) {
      const current = checkpoints.get(next.cycleId);
      assert.equal(current.phase, expected.phase);
      checkpoints.set(next.cycleId, { tenantId: '1000', ...structuredClone(next) });
      return this.read(next.cycleId);
    },
    readRiskExclusions() {
      return [];
    },
    readAuditQueue() {
      return [];
    },
    readOutcomes() {
      return [];
    }
  };
  return new RecoverableScanner({
    store,
    now,
    settings: { scanIntervalMs: 120_000, maxDeepAuditsPerCycle: 1, auditCycleBudgetMs: 80_000, queueRetentionMs: 86_400_000 }
  });
}

test('nextDue ignores expired or zero cooldowns and delays only GMGN tasks', () => {
  const scan = task('scan', 'scan', 110_000, { needsGmgn: true });
  const live = task('live', 'live', 120_000, { needsGmgn: true });
  const outbox = task('outbox', 'outbox', 105_000);

  assert.equal(nextDue(NOW, [scan, live], admission()), 110_000);
  assert.equal(nextDue(NOW, [scan, live], admission({ nextAllowedAt: 90_000 })), 110_000);
  assert.equal(nextDue(NOW, [scan, live, outbox], admission({ nextAllowedAt: 150_000 })), 105_000);
  assert.equal(nextDue(NOW, [scan, live], admission({ nextAllowedAt: 150_000 })), 150_000);
  assert.equal(nextDue(NOW, [], admission({ nextAllowedAt: 150_000 })), null);
});

test('paused or unconfigured policy excludes only scan and live work', () => {
  const tasks = [
    task('scan', 'scan', NOW, { needsGmgn: true }),
    task('live', 'live', NOW, { needsGmgn: true }),
    task('command', 'command', NOW),
    task('outbox', 'outbox', NOW)
  ];

  const eligible = schedulerEligibleTasks(tasks, { paused: true, configured: false });
  assert.deepEqual(eligible.filter(row => row.enabled).map(row => row.id), ['command', 'outbox']);
  assert.equal(nextDue(NOW, eligible, admission()), NOW);
  assert.equal(nextDue(NOW, schedulerEligibleTasks(tasks.slice(0, 2), { paused: true, configured: false }), admission()), null);
});

test('selection honors local-control, live, command, scan, then outbox priority and rotates low priority work', () => {
  const tasks = [
    task('outbox:a', 'outbox', NOW - 20),
    task('outbox:b', 'outbox', NOW - 10),
    task('scan', 'scan', NOW),
    task('command', 'command', NOW),
    task('live', 'live', NOW),
    task('control', 'local-control', NOW)
  ];

  assert.equal(selectReadyTask(NOW, tasks, admission(), { outbox: null }).task.id, 'control');
  assert.equal(selectReadyTask(NOW, tasks.filter(row => row.kind !== 'local-control'), admission(), { outbox: null }).task.id, 'live');
  assert.equal(selectReadyTask(NOW, tasks.filter(row => !['local-control', 'live'].includes(row.kind)), admission(), { outbox: null }).task.id, 'command');
  assert.equal(selectReadyTask(NOW, tasks.filter(row => ['scan', 'outbox'].includes(row.kind)), admission(), { outbox: null }).task.id, 'scan');
  const low = selectReadyTask(NOW, tasks.filter(row => row.kind === 'outbox'), admission(), { outbox: 'outbox:a' });
  assert.equal(low.task.id, 'outbox:b');
  assert.equal(low.lowPriorityWaitMs, 10);
});

test('scheduler represents inbox, outbox, and card refresh sources as normal task descriptors', () => {
  const tasks = deriveTaskDescriptors({
    inbox: [{ id: '42', dueAt: NOW }],
    outbox: [{ id: 'notify', dueAt: NOW + 1 }],
    cardRefresh: [{ id: 'card', dueAt: NOW + 2 }]
  });

  assert.deepEqual(tasks.map(row => [row.id, row.kind, row.needsGmgn]), [
    ['inbox:42', 'command', false],
    ['outbox:notify', 'outbox', false],
    ['card:card', 'outbox', false]
  ]);
});

test('a claimed GMGN task reserves provider spacing before its first awaited request', async () => {
  let observedSpacingReadyAt = 0;
  const { instance, store } = scheduler({
    store: new MemorySchedulerStore({
      tasks: [task('live', 'live', NOW, { needsGmgn: true, gmgnWeight: 2 })],
      runtime: { ...defaultSchedulerRuntime(), eligibility: { paused: false, configured: true } }
    }),
    handlers: {
      live: externalRequestHandler(async ({ request }) => {
        await request(async () => {
          observedSpacingReadyAt = store.read().gmgn.spacingReadyAt;
        });
        return { status: 'success', complete: true };
      })
    }
  });

  await instance.alarm();
  assert.equal(observedSpacingReadyAt, NOW + 100);
  assert.equal(store.read().tasks.length, 0);
});

test('the scheduler accepts an executor result, advances its checkpoint, and rearms the scan task', async () => {
  const scanner = recoverableScanner();
  scanner.begin({ cycleId: 'cycle-executor-scheduler', chain: 'sol', keyEpoch: 0, controlEpoch: 0, deadlineAt: NOW + 60_000 });
  const { instance, store, alarms } = scheduler({
    store: new MemorySchedulerStore({
      tasks: [task('scan:cycle-executor-scheduler', 'scan', NOW, { needsGmgn: true, gmgnWeight: 3 })],
      runtime: { ...defaultSchedulerRuntime(), eligibility: { paused: false, configured: true } }
    }),
    handlers: {
      scan: externalRequestHandler(({ task, request }) => executeRecoverableScanStep({
        scanner,
        cycleId: task.id.slice('scan:'.length),
        gmgn: { trenches: async () => ({ completed: [] }) },
        request,
        now: () => NOW
      }))
    }
  });

  assert.deepEqual(await instance.alarm(), { status: 'succeeded', taskId: 'scan:cycle-executor-scheduler' });
  assert.equal(scanner.checkpoint('cycle-executor-scheduler').endpointIndex, 1);
  assert.equal(store.read().runtime.retries['scan:cycle-executor-scheduler'], undefined);
  assert.equal(store.read().tasks[0].needsGmgn, true);
  assert.equal(store.read().tasks[0].gmgnWeight, 3);
  assert.equal(store.read().tasks[0].dueAt, NOW + 1);
  assert.equal(alarms.at, NOW + 150);
});

test('alarm-driven empty discovery finalizes a future successor cycle', async () => {
  let clock = NOW;
  const scanner = recoverableScanner({ now: () => clock });
  scanner.begin({ cycleId: 'cycle-cadence', chain: 'sol', keyEpoch: 0, controlEpoch: 0, deadlineAt: NOW + 60_000 });
  let gmgnRequests = 0;
  const { instance, store, alarms } = scheduler({
    now: () => clock,
    store: new MemorySchedulerStore({
      tasks: [task('scan:cycle-cadence', 'scan', NOW, { needsGmgn: true, gmgnWeight: 3 })],
      runtime: { ...defaultSchedulerRuntime(), eligibility: { paused: false, configured: true } }
    }),
    handlers: {
      scan: externalRequestHandler(async ({ task, request }) => {
        const result = await executeRecoverableScanStep({
          scanner,
          cycleId: task.id.slice('scan:'.length),
          gmgn: {
            trenches: async () => { gmgnRequests += 1; return { completed: [] }; },
            marketRank: async () => { gmgnRequests += 1; return { rank: [] }; }
          },
          request,
          now: () => clock,
          onFinalized: checkpoint => {
            const summary = checkpoint.partial.summary;
            const successor = scanner.begin({
              cycleId: summary.nextCycleId,
              chain: checkpoint.chain,
              keyEpoch: checkpoint.keyEpoch,
              controlEpoch: checkpoint.controlEpoch,
              deadlineAt: summary.nextDeadlineAt,
              partial: { rootCycleId: checkpoint.partial.rootCycleId, scanCount: summary.scanCount }
            });
            return {
              checkpoint: successor,
              task: {
                id: `scan:${summary.nextCycleId}`,
                kind: 'scan',
                dueAt: summary.nextCycleAt,
                enabled: true,
                needsGmgn: true,
                gmgnWeight: 3
              }
            };
          }
        });
        return result;
      })
    }
  });

  for (let step = 0; step < 6; step += 1) {
    assert.deepEqual(await instance.alarm(), { status: 'succeeded', taskId: 'scan:cycle-cadence' });
    if (step < 5) clock = alarms.at;
  }

  const finalized = scanner.checkpoint('cycle-cadence');
  const successorId = finalized.partial.summary.nextCycleId;
  assert.equal(gmgnRequests, 2);
  assert.deepEqual(finalized.partial.summary, {
    completedAt: NOW + 154,
    finalized: true,
    scanCount: 1,
    nextCycleId: successorId,
    nextCycleAt: NOW + 120_000,
    nextDeadlineAt: NOW + 200_000
  });
  assert.equal(scanner.checkpoint(successorId).phase, 'DISCOVER');
  assert.deepEqual(store.read().tasks, [{
    id: `scan:${successorId}`,
    kind: 'scan',
    dueAt: NOW + 120_000,
    enabled: true,
    needsGmgn: true,
    gmgnWeight: 3
  }]);
  assert.equal(alarms.at, NOW + 120_000);
});

test('scheduler moves progress to a successor task without retaining completed task checkpoints', async () => {
  let clock = NOW;
  const { instance, store } = scheduler({
    now: () => clock,
    store: new MemorySchedulerStore({
      tasks: [task('scan:0', 'scan', NOW, { needsGmgn: true })],
      runtime: { ...defaultSchedulerRuntime(), eligibility: { paused: false, configured: true } }
    }),
    handlers: {
      scan: externalRequestHandler(async ({ task: scheduledTask }) => {
        const sequence = Number(scheduledTask.id.slice('scan:'.length));
        return {
          status: 'success',
          complete: false,
          checkpoint: `checkpoint:${sequence}`,
          nextTask: task(`scan:${sequence + 1}`, 'scan', clock + 1_000, { needsGmgn: true })
        };
      })
    }
  });

  for (let sequence = 0; sequence < 4; sequence += 1) {
    assert.deepEqual(await instance.alarm(), { status: 'succeeded', taskId: `scan:${sequence}` });
    assert.deepEqual(Object.keys(store.read().runtime.checkpoints), [`scan:${sequence + 1}`]);
    clock += 1_000;
  }
});

test('scheduler clears a terminal low-priority fairness cursor', async () => {
  const { instance, store } = scheduler({
    store: new MemorySchedulerStore({
      tasks: [task('outbox:terminal', 'outbox', NOW)],
      runtime: { ...defaultSchedulerRuntime(), fairness: { outbox: 'outbox:previous' } }
    }),
    handlers: { outbox: externalRequestHandler(async () => ({ status: 'success', complete: true })) }
  });

  await instance.alarm();
  assert.equal(store.read().runtime.fairness.outbox, null);
});

test('a GMGN client consumes the scheduler reservation without another delay or weighted charge', async () => {
  const waits = [];
  let fetches = 0;
  const store = new MemorySchedulerStore({
    tasks: [task('live', 'live', NOW, { needsGmgn: true, gmgnWeight: 5 })],
    runtime: { ...defaultSchedulerRuntime(), eligibility: { paused: false, configured: true } }
  });
  const admissionStateStore = {
    async read() {
      return store.read().gmgn;
    },
    async write(gmgn) {
      store.update(current => ({ state: { ...current, gmgn }, value: null }));
    }
  };
  const { instance } = scheduler({
    store,
    handlers: {
      live: externalRequestHandler(async ({ request, gmgnReservation }) => {
        const gmgn = new GmgnClient({
          apiKeyProvider: () => `gmgn_${'a'.repeat(32)}`,
          admissionStateStore,
          admissionReservation: gmgnReservation,
          now: () => NOW,
          minRequestGapMs: 50,
          wait: async delay => { waits.push(delay); },
          fetch: async () => {
            fetches += 1;
            return new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 });
          }
        });
        await request(() => gmgn.tokenTopHolders('bsc', `0x${'1'.repeat(40)}`, { limit: 1 }));
        return { status: 'success', complete: true };
      })
    }
  });

  await instance.alarm();
  assert.equal(fetches, 1);
  assert.deepEqual(waits, []);
  assert.equal(store.read().gmgn.lastWeight, 5);
  assert.equal(store.read().gmgn.spacingReadyAt, NOW + 250);
});

test('an external handler can persist a caught endpoint failure and complete its scheduler step', async () => {
  let persistedError = null;
  const { instance, store } = scheduler({
    store: new MemorySchedulerStore({ tasks: [task('command', 'command', NOW)] }),
    handlers: {
      command: externalRequestHandler(async ({ request }) => {
        try {
          await request(async () => {
            throw Object.assign(new Error('upstream unavailable'), { code: 'UPSTREAM_UNAVAILABLE' });
          });
        } catch (error) {
          persistedError = { code: error.code, message: error.message };
        }
        return {
          status: 'success',
          complete: false,
          checkpoint: 'endpoint-error-recorded',
          nextDueAt: NOW + 1_000
        };
      })
    }
  });

  assert.deepEqual(await instance.alarm(), { status: 'succeeded', taskId: 'command' });
  assert.deepEqual(persistedError, { code: 'UPSTREAM_UNAVAILABLE', message: 'upstream unavailable' });
  assert.equal(store.read().runtime.retries.command, undefined);
  assert.equal(store.read().tasks[0].dueAt, NOW + 1_000);
});

test('failure persists a future retry before recomputing the alarm', async () => {
  const { instance, store, alarms } = scheduler({
    store: new MemorySchedulerStore({ tasks: [task('command', 'command', NOW)] }),
    handlers: {
      command: localTransactionHandler(() => {
        throw Object.assign(new Error('temporary'), { retryAfterMs: 4_000 });
      })
    }
  });

  const result = await instance.alarm();
  assert.equal(result.status, 'failed');
  assert.equal(store.read().tasks[0].dueAt, NOW + 4_000);
  assert.equal(alarms.at, NOW + 4_000);
  assert.equal(store.read().runtime.inFlight, null);
});

test('a persisted GMGN cooldown remains the admission boundary after a rate-limit failure', async () => {
  const cooldownUntil = NOW + 60_000;
  const { instance, store, alarms } = scheduler({
    store: new MemorySchedulerStore({
      tasks: [task('live', 'live', NOW, { needsGmgn: true })],
      runtime: { ...defaultSchedulerRuntime(), eligibility: { paused: false, configured: true } }
    }),
    handlers: {
      live: externalRequestHandler(async ({ request }) => {
        await request(() => {
          store.update(current => ({
            state: { ...current, gmgn: { ...current.gmgn, nextAllowedAt: cooldownUntil, backoffFactor: 2, successStreak: 0 } },
            value: null
          }));
          throw Object.assign(new Error('rate limited'), { code: 'GMGN_RATE_LIMITED', retryAfterMs: 1_000 });
        });
        return { status: 'success', complete: true };
      })
    }
  });

  await instance.alarm();
  assert.equal(store.read().gmgn.nextAllowedAt, cooldownUntil);
  assert.equal(store.read().tasks[0].dueAt, NOW + 1_000);
  assert.equal(alarms.at, cooldownUntil);
});

test('retry exhaustion is terminal, observable, and cannot leave a due-now alarm', async () => {
  let clock = NOW;
  const { instance, store, alarms } = scheduler({
    store: new MemorySchedulerStore({ tasks: [task('command', 'command', NOW)] }),
    now: () => clock,
    maxRetryAttempts: 2
  });

  await instance.alarm();
  clock += 1_000;
  await instance.alarm();

  assert.equal(store.read().tasks[0].enabled, false);
  assert.deepEqual(store.read().runtime.retries.command, {
    attempts: 2,
    dueAt: null,
    exhaustedAt: NOW + 1_000,
    lastErrorCode: 'SCHEDULER_HANDLER_UNAVAILABLE'
  });
  assert.equal(alarms.at, null);
});

test('scheduler policy refuses more than five retry attempts', () => {
  assert.throws(
    () => scheduler({ maxRetryAttempts: 6 }),
    error => error instanceof Error && error.code === 'SCHEDULER_CONFIGURATION_INVALID'
  );

  assert.throws(
    () => normalizeSchedulerRuntime({
      ...defaultSchedulerRuntime(),
      retries: {
        command: { attempts: 6, dueAt: NOW + 1_000, exhaustedAt: null, lastErrorCode: 'SCHEDULER_STEP_FAILED' }
      }
    }),
    error => error instanceof Error && error.code === 'SCHEDULER_RUNTIME_INVALID'
  );
});

test('the watchdog does not duplicate an active step, clear cooldown, or unpause work', async () => {
  let release;
  let calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const { instance, store, alarms } = scheduler({
    store: new MemorySchedulerStore({
      tasks: [task('command', 'command', NOW)],
      runtime: { ...defaultSchedulerRuntime(), eligibility: { paused: true, configured: false } },
      gmgn: admission({ nextAllowedAt: NOW + 60_000 })
    }),
    handlers: {
      command: externalRequestHandler(async ({ request }) => {
        calls += 1;
        await request(() => gate);
        return { status: 'success', complete: true };
      })
    }
  });

  const running = instance.alarm();
  await new Promise(resolve => setImmediate(resolve));
  const wake = await instance.wake();
  assert.deepEqual(wake, { accepted: false, reason: 'step_in_flight' });
  assert.equal(calls, 1);
  assert.deepEqual(store.read().runtime.eligibility, { paused: true, configured: false });
  assert.equal(store.read().gmgn.nextAllowedAt, NOW + 60_000);
  assert.equal(alarms.setCalls.length, 0);

  release();
  await running;
});

test('a bounded external handler cannot issue a second request in one scheduler step', async () => {
  let calls = 0;
  const { instance, store } = scheduler({
    store: new MemorySchedulerStore({ tasks: [task('command', 'command', NOW)] }),
    handlers: {
      command: externalRequestHandler(async ({ request }) => {
        await request(async () => { calls += 1; });
        await request(async () => { calls += 1; });
        return { status: 'success', complete: true };
      })
    }
  });

  await instance.alarm();
  assert.equal(calls, 1);
  assert.equal(store.read().tasks[0].dueAt > NOW, true);
  assert.equal(store.read().runtime.retries.command.lastErrorCode, BoundedStepError.code);
});

test('a bounded external request times out before its lease can expire', async () => {
  const { instance, store } = scheduler({
    store: new MemorySchedulerStore({ tasks: [task('command', 'command', NOW)] }),
    leaseMs: 100,
    externalRequestTimeoutMs: 10,
    handlers: {
      command: externalRequestHandler(async ({ request }) => {
        await request(({ signal }) => new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }));
        return { status: 'success', complete: true };
      })
    }
  });

  await instance.alarm();
  assert.equal(store.read().runtime.inFlight, null);
  assert.equal(store.read().runtime.retries.command.lastErrorCode, 'SCHEDULER_REQUEST_TIMEOUT');
  assert.equal(store.read().tasks[0].dueAt, NOW + 1_000);
});

test('public property injection cannot replace the scheduler handler capability', async () => {
  let injectedCalls = 0;
  const { instance, store } = scheduler({
    store: new MemorySchedulerStore({ tasks: [task('command', 'command', NOW)] })
  });
  instance.handlers = {
    command: {
      mode: 'external-request',
      run: () => {
        injectedCalls += 1;
        return { status: 'success', complete: true };
      }
    }
  };

  await instance.alarm();
  assert.equal(injectedCalls, 0);
  assert.equal(store.read().runtime.retries.command.lastErrorCode, 'SCHEDULER_HANDLER_UNAVAILABLE');
});

test('scheduler capabilities expire with the handler and retain an unawaited request until it settles', async () => {
  let escapedRequest;
  let calls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { instance, store } = scheduler({
    store: new MemorySchedulerStore({ tasks: [task('command', 'command', NOW)] }),
    handlers: {
      command: externalRequestHandler(({ request }) => {
        escapedRequest = request;
        request(async () => {
          calls += 1;
          await gate;
        });
        return { status: 'success', complete: true };
      })
    }
  });

  const running = instance.alarm();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(store.read().runtime.inFlight?.taskId, 'command');

  release();
  await running;
  assert.throws(() => escapedRequest(() => { calls += 1; }), error =>
    error instanceof BoundedStepError && error.code === BoundedStepError.code);
  assert.equal(calls, 1);
});

test('scheduler rejects async local transaction callbacks before they escape the bounded transaction', async () => {
  const { instance, store } = scheduler({
    store: new MemorySchedulerStore({ tasks: [task('command', 'command', NOW)] }),
    handlers: {
      command: localTransactionHandler(({ transaction }) => {
        transaction(async () => {});
        return { status: 'success', complete: true };
      })
    }
  });

  await instance.alarm();
  assert.equal(store.read().tasks[0].dueAt > NOW, true);
  assert.equal(store.read().runtime.retries.command.lastErrorCode, BoundedStepError.code);
});

test('an unavailable GMGN handler claims a lease and persists backoff instead of rearming due-now work', async () => {
  const { instance, store, alarms } = scheduler({
    store: new MemorySchedulerStore({
      tasks: [task('live', 'live', NOW, { needsGmgn: true })],
      runtime: { ...defaultSchedulerRuntime(), eligibility: { paused: false, configured: true } }
    })
  });

  const result = await instance.alarm();
  assert.deepEqual(result, { status: 'failed', taskId: 'live' });
  assert.equal(store.read().runtime.inFlight, null);
  assert.equal(store.read().tasks[0].dueAt, NOW + 1_000);
  assert.equal(alarms.at, NOW + 1_000);
});

test('a concurrent alarm neither starts another step nor rearms around an active lease, and an expired lease recovers liveness', async () => {
  let clock = NOW;
  const activeLease = {
    taskId: 'command', epoch: 1, startedAt: NOW - 10, leaseUntil: NOW + 10, mode: 'external-request'
  };
  const { instance, store, alarms } = scheduler({
    store: new MemorySchedulerStore({
      tasks: [task('command', 'command', NOW), task('outbox', 'outbox', NOW)],
      runtime: { ...defaultSchedulerRuntime(), nextLeaseEpoch: 2, inFlight: activeLease }
    }),
    handlers: {
      command: externalRequestHandler(async () => ({ status: 'success', complete: true }))
    },
    now: () => clock
  });

  assert.deepEqual(await instance.alarm(), { status: 'busy' });
  assert.equal(alarms.setCalls.length, 0);
  assert.equal(store.read().runtime.inFlight.taskId, 'command');

  clock = NOW + 10;
  assert.deepEqual(await instance.alarm(), { status: 'recovered', dueAt: NOW + 10 });
  assert.equal(store.read().runtime.inFlight, null);
  assert.equal(store.read().tasks.find(row => row.id === 'command').dueAt, NOW + 1_010);
  assert.equal(alarms.at, NOW + 10);
});

test('no runnable task deletes the durable object alarm', async () => {
  const { instance, alarms } = scheduler({
    store: new MemorySchedulerStore({ tasks: [task('scan', 'scan', NOW, { needsGmgn: true })] })
  });

  await instance.replaceEligibility({ paused: true, configured: false });
  assert.equal(alarms.at, null);
  assert.equal(alarms.deleteCalls, 1);
});
