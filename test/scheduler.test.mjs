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
import { defaultAveAdmission, recordAveResponse } from '../src/ave-admission.mjs';
import { AveError } from '../src/providers/ave.mjs';
import { RecoverableScanner } from '../src/recoverable-scanner.mjs';
import { executeRecoverableScanStep } from '../src/recoverable-scan-executor.mjs';
import { scannerSettings } from '../src/scanner-settings.mjs';

const NOW = 100_000;
// NOW falls in January 1970, so the allowance resets on 1 February 1970.
const PERIOD_END = Date.UTC(1970, 1, 1);
const BUDGET = Object.freeze({ monthlyCu: 1_000_000, resetDay: 1 });
const CONFIGURED = Object.freeze({ ...defaultSchedulerRuntime(), eligibility: { paused: false, configured: true } });

function task(id, kind, dueAt, options = {}) {
  return createTaskDescriptor({ id, kind, dueAt, enabled: true, aveCost: 0, ...options });
}

function admission(overrides = {}) {
  return { ...defaultAveAdmission(), ...overrides };
}

class MemorySchedulerStore {
  constructor({ tasks = [], runtime = defaultSchedulerRuntime(), ave = admission() } = {}) {
    this.value = { tasks: structuredClone(tasks), runtime: structuredClone(runtime), ave: structuredClone(ave) };
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
    instance: new OneAlarmScheduler({ store, alarms, now: () => NOW, aveBudget: BUDGET, ...options })
  };
}

// The checkpoint and commit methods RecoverableScanner calls, kept in memory.
class MemoryScanStore {
  constructor() {
    this.checkpoints = new Map();
    this.feeds = new Map();
  }

  begin({ afterBegin, ...value }) {
    const existing = this.read(value.cycleId);
    if (existing) return existing;
    const checkpoint = { tenantId: '1000', ...structuredClone(value) };
    this.checkpoints.set(checkpoint.cycleId, checkpoint);
    afterBegin?.(structuredClone(checkpoint));
    return structuredClone(checkpoint);
  }

  read(cycleId) {
    const checkpoint = this.checkpoints.get(cycleId);
    return checkpoint ? structuredClone(checkpoint) : null;
  }

  #write({ expected = {}, next }) {
    const current = this.checkpoints.get(next.cycleId);
    assert.ok(current, 'a committed checkpoint must exist');
    for (const field of ['phase', 'keyEpoch', 'controlEpoch']) {
      if (expected[field] !== undefined) assert.equal(current[field], expected[field]);
    }
    this.checkpoints.set(next.cycleId, { tenantId: '1000', ...structuredClone(next) });
    return this.read(next.cycleId);
  }

  advance(value) { return this.#write(value); }
  commitQueue(value) { return this.#write(value); }
  commitOutcomeSelection(value) { return this.#write(value); }
  commitOutcomeProgress(value) { return this.#write(value); }
  commitSummary(value) { return this.#write(value); }
  commitClassification(value) { return this.#write(value); }

  commitScreen(value) {
    this.feeds.set(value.next.chain, structuredClone(value.feed));
    return this.#write(value);
  }

  readCandidate() { return null; }
  readAuditQueue() { return []; }
  readOutcomes() { return []; }
}

function recoverableScanner({ now = () => NOW } = {}) {
  const store = new MemoryScanStore();
  return { store, scanner: new RecoverableScanner({ store, now, settings: { ...scannerSettings } }) };
}

function emptyTrending(counter = { calls: 0 }, now = () => NOW) {
  return {
    counter,
    ave: {
      trending: async () => {
        counter.calls += 1;
        return { rows: [], capturedAt: now() };
      }
    }
  };
}

test('nextDue delays only AVE-costing tasks until admission is ready', () => {
  const scan = task('scan', 'scan', 110_000, { aveCost: 5 });
  const outbox = task('outbox', 'outbox', 105_000);

  assert.equal(nextDue(NOW, [scan], admission()), 110_000);
  assert.equal(nextDue(NOW, [scan], admission({ spacingReadyAt: 90_000 })), 110_000);
  assert.equal(nextDue(NOW, [scan], admission({ spacingReadyAt: 150_000 })), 150_000);
  assert.equal(nextDue(NOW, [scan], admission({ spacingReadyAt: 150_000, blockedUntil: 170_000, blockReason: 'RATE_LIMITED' })), 170_000);
  assert.equal(nextDue(NOW, [scan, outbox], admission({ blockedUntil: 150_000, blockReason: 'QUOTA' })), 105_000);
  assert.equal(nextDue(NOW, [task('scan', 'scan', 110_000)], admission({ blockedUntil: 150_000, blockReason: 'BUDGET' })), 110_000);
  assert.equal(nextDue(NOW, [], admission({ blockedUntil: 150_000, blockReason: 'BUDGET' })), null);
});

test('paused or unconfigured policy excludes only scan work', () => {
  const tasks = [
    task('scan', 'scan', NOW, { aveCost: 5 }),
    task('credential', 'credential', NOW, { aveCost: 5 }),
    task('command', 'command', NOW),
    task('outbox', 'outbox', NOW)
  ];

  for (const eligibility of [{ paused: true, configured: true }, { paused: false, configured: false }]) {
    const eligible = schedulerEligibleTasks(tasks, eligibility);
    assert.deepEqual(eligible.filter(row => row.enabled).map(row => row.id), ['credential', 'command', 'outbox']);
  }
  assert.deepEqual(schedulerEligibleTasks(tasks, { paused: false, configured: true }).filter(row => row.enabled).length, 4);
  assert.equal(nextDue(NOW, schedulerEligibleTasks(tasks.slice(0, 1), { paused: true, configured: false }), admission()), null);
});

test('selection honors local-control, command, scan, then outbox priority and rotates low priority work', () => {
  const tasks = [
    task('outbox:a', 'outbox', NOW - 20),
    task('outbox:b', 'outbox', NOW - 10),
    task('scan', 'scan', NOW),
    task('command', 'command', NOW),
    task('control', 'local-control', NOW)
  ];

  assert.equal(selectReadyTask(NOW, tasks, admission(), { outbox: null }).task.id, 'control');
  assert.equal(selectReadyTask(NOW, tasks.filter(row => row.kind !== 'local-control'), admission(), { outbox: null }).task.id, 'command');
  assert.equal(selectReadyTask(NOW, tasks.filter(row => ['scan', 'outbox'].includes(row.kind)), admission(), { outbox: null }).task.id, 'scan');
  const low = selectReadyTask(NOW, tasks.filter(row => row.kind === 'outbox'), admission(), { outbox: 'outbox:a' });
  assert.equal(low.task.id, 'outbox:b');
  assert.equal(low.lowPriorityWaitMs, 10);
});

test('an AVE-blocked scan yields selection to ready work that makes no AVE request', () => {
  const tasks = [task('scan', 'scan', NOW, { aveCost: 5 }), task('outbox', 'outbox', NOW)];
  const blocked = admission({ blockedUntil: NOW + 1, blockReason: 'RATE_LIMITED' });
  assert.equal(selectReadyTask(NOW, tasks, blocked).task.id, 'outbox');
  assert.equal(selectReadyTask(NOW, tasks.slice(0, 1), blocked), null);
});

test('scheduler represents inbox, outbox, and card refresh sources as task descriptors that cost no AVE credits', () => {
  const tasks = deriveTaskDescriptors({
    inbox: [{ id: '42', dueAt: NOW }],
    outbox: [{ id: 'notify', dueAt: NOW + 1 }],
    cardRefresh: [{ id: 'card', dueAt: NOW + 2 }],
    scan: [{ id: 'cycle', dueAt: NOW + 3, aveCost: 5 }]
  });

  assert.deepEqual(tasks.map(row => [row.id, row.kind, row.aveCost]), [
    ['scan:cycle', 'scan', 5],
    ['inbox:42', 'command', 0],
    ['outbox:notify', 'outbox', 0],
    ['card:card', 'outbox', 0]
  ]);
});

test('task descriptors refuse the removed live kind and a missing, negative, or fractional AVE cost', () => {
  assert.throws(() => task('live', 'live', NOW), error => error.code === 'SCHEDULER_TASK_KIND_INVALID');
  for (const aveCost of [undefined, -1, 2.5, '5']) {
    assert.throws(
      () => createTaskDescriptor({ id: 'scan', kind: 'scan', dueAt: NOW, enabled: true, aveCost }),
      error => error.code === 'SCHEDULER_TASK_COST_INVALID',
      String(aveCost)
    );
  }
});

test('the scheduler refuses construction without a valid AVE budget or with more than five retry attempts', () => {
  for (const aveBudget of [undefined, { monthlyCu: 0, resetDay: 1 }, { monthlyCu: 1_000_000 }]) {
    assert.throws(() => scheduler({ aveBudget }), error => error.code === 'SCHEDULER_CONFIGURATION_INVALID', JSON.stringify(aveBudget));
  }
  assert.throws(() => scheduler({ maxRetryAttempts: 6 }), error => error.code === 'SCHEDULER_CONFIGURATION_INVALID');
  assert.throws(
    () => normalizeSchedulerRuntime({
      ...defaultSchedulerRuntime(),
      retries: {
        command: { attempts: 6, dueAt: NOW + 1_000, exhaustedAt: null, lastErrorCode: 'SCHEDULER_STEP_FAILED' }
      }
    }),
    error => error.code === 'SCHEDULER_RUNTIME_INVALID'
  );
});

test('a claimed AVE task reserves its credits and spacing before its request is sent', async () => {
  let observed = null;
  const { instance, store, alarms } = scheduler({
    store: new MemorySchedulerStore({ tasks: [task('scan', 'scan', NOW, { aveCost: 5 })], runtime: CONFIGURED }),
    handlers: {
      scan: externalRequestHandler(async ({ request }) => {
        await request(async () => { observed = store.read().ave; });
        return { status: 'success', complete: false, nextDueAt: NOW + 1 };
      })
    }
  });

  assert.deepEqual(await instance.alarm(), { status: 'succeeded', taskId: 'scan' });
  assert.deepEqual(observed, admission({ periodStartAt: 0, cuUsed: 5, lastRequestAt: NOW, spacingReadyAt: NOW + 15_000 }));
  assert.equal(store.read().ave.cuUsed, 5);
  assert.equal(store.read().tasks[0].dueAt, NOW + 1);
  assert.equal(alarms.at, NOW + 15_000);
});

test('a task that makes no AVE request spends no credits and ignores AVE spacing', async () => {
  const { instance, store, alarms } = scheduler({
    store: new MemorySchedulerStore({
      tasks: [task('command', 'command', NOW)],
      ave: admission({ spacingReadyAt: NOW + 60_000, blockedUntil: NOW + 60_000, blockReason: 'RATE_LIMITED' })
    }),
    handlers: {
      command: externalRequestHandler(async () => ({ status: 'success', complete: false, nextDueAt: NOW + 5 }))
    }
  });

  assert.deepEqual(await instance.alarm(), { status: 'succeeded', taskId: 'command' });
  assert.equal(store.read().ave.cuUsed, 0);
  assert.equal(alarms.at, NOW + 5);
});

test('an exhausted allowance blocks AVE work until the period resets while other work continues', async () => {
  let clock = NOW;
  const ran = [];
  const { instance, store, alarms } = scheduler({
    now: () => clock,
    store: new MemorySchedulerStore({
      tasks: [task('scan', 'scan', NOW, { aveCost: 5 }), task('outbox', 'outbox', NOW)],
      runtime: CONFIGURED,
      ave: admission({ periodStartAt: 0, cuUsed: BUDGET.monthlyCu - 4 })
    }),
    handlers: {
      scan: externalRequestHandler(async ({ request }) => {
        await request(async () => { ran.push('scan'); });
        return { status: 'success', complete: true };
      }),
      outbox: externalRequestHandler(async () => {
        ran.push('outbox');
        return { status: 'success', complete: true };
      })
    }
  });

  assert.deepEqual(await instance.alarm(), { status: 'idle', dueAt: NOW });
  assert.deepEqual(ran, []);
  assert.equal(store.read().runtime.inFlight, null);
  assert.deepEqual(
    (({ cuUsed, blockedUntil, blockReason }) => ({ cuUsed, blockedUntil, blockReason }))(store.read().ave),
    { cuUsed: BUDGET.monthlyCu - 4, blockedUntil: PERIOD_END, blockReason: 'BUDGET' }
  );

  assert.deepEqual(await instance.alarm(), { status: 'succeeded', taskId: 'outbox' });
  assert.deepEqual(ran, ['outbox']);
  assert.equal(alarms.at, PERIOD_END);

  clock = PERIOD_END - 1;
  assert.deepEqual(await instance.alarm(), { status: 'idle', dueAt: PERIOD_END });
  assert.deepEqual(ran, ['outbox']);

  clock = PERIOD_END;
  assert.deepEqual(await instance.alarm(), { status: 'succeeded', taskId: 'scan' });
  assert.deepEqual(ran, ['outbox', 'scan']);
  assert.equal(store.read().ave.periodStartAt, PERIOD_END);
  assert.equal(store.read().ave.cuUsed, 5);
  assert.equal(store.read().ave.blockReason, null);
});

test('the scheduler accepts an executor result, advances its checkpoint, and rearms the scan task for free local work', async () => {
  const { scanner } = recoverableScanner();
  const { ave, counter } = emptyTrending();
  scanner.begin({ cycleId: 'cycle-executor-scheduler', chain: 'sol', keyEpoch: 0, controlEpoch: 0, deadlineAt: NOW + 60_000 });
  const { instance, store, alarms } = scheduler({
    store: new MemorySchedulerStore({ tasks: [task('scan:cycle-executor-scheduler', 'scan', NOW, { aveCost: 5 })], runtime: CONFIGURED }),
    handlers: {
      scan: externalRequestHandler(({ task: scheduled, request }) => executeRecoverableScanStep({
        scanner, cycleId: scheduled.id.slice('scan:'.length), ave, request, now: () => NOW
      }))
    }
  });

  assert.deepEqual(await instance.alarm(), { status: 'succeeded', taskId: 'scan:cycle-executor-scheduler' });
  assert.equal(counter.calls, 1);
  assert.equal(scanner.checkpoint('cycle-executor-scheduler').phase, 'SCREEN');
  assert.equal(store.read().runtime.retries['scan:cycle-executor-scheduler'], undefined);
  assert.equal(store.read().tasks[0].aveCost, 0);
  assert.equal(store.read().tasks[0].dueAt, NOW + 1);
  assert.equal(store.read().ave.cuUsed, 5);
  // Screening costs no credits, so AVE spacing does not delay it.
  assert.equal(alarms.at, NOW + 1);
});

async function runEmptyCycle({ aveBudget }) {
  let clock = NOW;
  const { scanner, store: scanStore } = recoverableScanner({ now: () => clock });
  const { ave, counter } = emptyTrending(undefined, () => clock);
  scanner.begin({ cycleId: 'cycle-cadence', chain: 'sol', keyEpoch: 0, controlEpoch: 0, deadlineAt: NOW + 60_000 });
  const { instance, store, alarms } = scheduler({
    now: () => clock,
    aveBudget,
    store: new MemorySchedulerStore({ tasks: [task('scan:cycle-cadence', 'scan', NOW, { aveCost: 5 })], runtime: CONFIGURED }),
    handlers: {
      scan: externalRequestHandler(({ task: scheduled, request }) => executeRecoverableScanStep({
        scanner,
        cycleId: scheduled.id.slice('scan:'.length),
        ave,
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
            task: { id: `scan:${summary.nextCycleId}`, kind: 'scan', dueAt: summary.nextCycleAt, enabled: true, aveCost: 5 }
          };
        }
      }))
    }
  });

  // DISCOVER, SCREEN, BUILD_QUEUE, OUTCOMES_SAMPLE, then SUMMARIZE finalizes.
  for (let step = 0; step < 5; step += 1) {
    assert.deepEqual(await instance.alarm(), { status: 'succeeded', taskId: 'scan:cycle-cadence' });
    if (step < 4) {
      assert.equal(alarms.at, clock + 1);
      clock = alarms.at;
    }
  }
  return { scanner, scanStore, store, alarms, counter };
}

test('alarm-driven empty discovery spends one trending request and schedules the successor cycle at the scan interval', async () => {
  const { scanner, scanStore, store, alarms, counter } = await runEmptyCycle({ aveBudget: BUDGET });

  const finalized = scanner.checkpoint('cycle-cadence');
  const successorId = finalized.partial.summary.nextCycleId;
  assert.equal(counter.calls, 1);
  assert.equal(store.read().ave.cuUsed, 5);
  assert.deepEqual(finalized.partial.summary, {
    completedAt: NOW + 4,
    finalized: true,
    scanCount: 1,
    nextCycleId: successorId,
    nextCycleAt: NOW + scannerSettings.scanIntervalMs,
    nextDeadlineAt: NOW + scannerSettings.scanIntervalMs + scannerSettings.auditCycleBudgetMs
  });
  assert.equal(scanner.checkpoint(successorId).phase, 'DISCOVER');
  assert.equal(scanStore.feeds.get('sol').status, 'READY');
  assert.equal(scanStore.feeds.get('sol').receivedCount, 0);
  assert.deepEqual(store.read().tasks, [{
    id: `scan:${successorId}`, kind: 'scan', dueAt: NOW + scannerSettings.scanIntervalMs, enabled: true, aveCost: 5
  }]);
  assert.equal(alarms.at, Math.max(NOW + scannerSettings.scanIntervalMs, NOW + 15_000));
});

test('a small allowance stretches the successor cycle to the paced credit gap', async () => {
  const aveBudget = { monthlyCu: 1_000, resetDay: 1 };
  const { store, alarms } = await runEmptyCycle({ aveBudget });

  const pacedReadyAt = NOW + Math.ceil(5 * (PERIOD_END - NOW) / aveBudget.monthlyCu);
  assert.ok(pacedReadyAt > NOW + scannerSettings.scanIntervalMs);
  assert.equal(store.read().ave.spacingReadyAt, pacedReadyAt);
  assert.equal(store.read().tasks[0].dueAt, NOW + scannerSettings.scanIntervalMs);
  assert.equal(alarms.at, pacedReadyAt);
});

test('scheduler moves progress to a successor task without retaining completed task checkpoints', async () => {
  let clock = NOW;
  const { instance, store } = scheduler({
    now: () => clock,
    store: new MemorySchedulerStore({ tasks: [task('scan:0', 'scan', NOW)], runtime: CONFIGURED }),
    handlers: {
      scan: externalRequestHandler(async ({ task: scheduledTask }) => {
        const sequence = Number(scheduledTask.id.slice('scan:'.length));
        return {
          status: 'success',
          complete: false,
          checkpoint: `checkpoint:${sequence}`,
          nextTask: task(`scan:${sequence + 1}`, 'scan', clock + 1_000)
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
        return { status: 'success', complete: false, checkpoint: 'endpoint-error-recorded', nextDueAt: NOW + 1_000 };
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

test('a 429 recorded through recordAveResponse remains the admission boundary after the step fails', async () => {
  const retryAt = NOW + 300_000;
  const { instance, store, alarms } = scheduler({
    store: new MemorySchedulerStore({ tasks: [task('scan', 'scan', NOW, { aveCost: 5 })], runtime: CONFIGURED }),
    handlers: {
      scan: externalRequestHandler(async ({ request }) => {
        await request(() => {
          const error = new AveError('RATE_LIMITED', 429, retryAt);
          store.update(current => ({ state: { ...current, ave: recordAveResponse(NOW, current.ave, error, BUDGET) }, value: null }));
          throw error;
        });
        return { status: 'success', complete: true };
      })
    }
  });

  assert.deepEqual(await instance.alarm(), { status: 'failed', taskId: 'scan' });
  const ave = store.read().ave;
  assert.equal(ave.blockReason, 'RATE_LIMITED');
  assert.equal(ave.blockedUntil, retryAt);
  assert.equal(ave.backoffFactor, 2);
  assert.equal(store.read().runtime.retries.scan.lastErrorCode, 'AVE_RATE_LIMITED');
  assert.equal(store.read().tasks[0].dueAt, NOW + 1_000);
  assert.equal(alarms.at, retryAt);
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

test('the watchdog does not duplicate an active step, clear an AVE block, or unpause work', async () => {
  let release;
  let calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const blocked = admission({ blockedUntil: NOW + 60_000, blockReason: 'RATE_LIMITED', backoffFactor: 2 });
  const { instance, store, alarms } = scheduler({
    store: new MemorySchedulerStore({
      tasks: [task('command', 'command', NOW)],
      runtime: { ...defaultSchedulerRuntime(), eligibility: { paused: true, configured: false } },
      ave: blocked
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
  assert.deepEqual(store.read().ave, blocked);
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

test('an AVE task without an external-request handler fails its lease with backoff and spends no credits', async () => {
  for (const handlers of [{}, { scan: localTransactionHandler(() => ({ status: 'success', complete: true })) }]) {
    const { instance, store, alarms } = scheduler({
      store: new MemorySchedulerStore({ tasks: [task('scan', 'scan', NOW, { aveCost: 5 })], runtime: CONFIGURED }),
      handlers
    });

    assert.deepEqual(await instance.alarm(), { status: 'failed', taskId: 'scan' });
    assert.equal(store.read().runtime.inFlight, null);
    assert.equal(store.read().runtime.retries.scan.lastErrorCode, 'SCHEDULER_HANDLER_UNAVAILABLE');
    assert.deepEqual(store.read().ave, admission());
    assert.equal(store.read().tasks[0].dueAt, NOW + 1_000);
    assert.equal(alarms.at, NOW + 1_000);
  }
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
    store: new MemorySchedulerStore({ tasks: [task('scan', 'scan', NOW, { aveCost: 5 })] })
  });

  await instance.replaceEligibility({ paused: true, configured: false });
  assert.equal(alarms.at, null);
  assert.equal(alarms.deleteCalls, 1);
});
