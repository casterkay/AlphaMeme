const TASK_KINDS = Object.freeze(['local-control', 'live', 'command', 'scan', 'outbox']);
const TASK_PRIORITY = Object.freeze({
  'local-control': 0,
  live: 1,
  command: 2,
  scan: 3,
  outbox: 4
});
const LOW_PRIORITY_KIND = 'outbox';
const MIN_RETRY_MS = 1_000;
const MAX_RETRY_MS = 5 * 60_000;
const MAX_RETRY_ATTEMPTS = 5;

export class SchedulerPolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SchedulerPolicyError';
    this.code = code;
  }
}

export class SchedulerStepError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SchedulerStepError';
    this.code = code;
  }
}

export class BoundedStepError extends SchedulerStepError {
  static code = 'SCHEDULER_STEP_BUDGET_EXCEEDED';

  constructor(message) {
    super(BoundedStepError.code, message);
    this.name = 'BoundedStepError';
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function clone(value) {
  return structuredClone(value);
}

function taskId(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9:_-]{0,127}$/i.test(value)) {
    throw new SchedulerPolicyError('SCHEDULER_TASK_ID_INVALID', 'scheduler task id must be a stable non-empty identifier');
  }
  return value;
}

function taskKind(value) {
  if (!TASK_KINDS.includes(value)) {
    throw new SchedulerPolicyError('SCHEDULER_TASK_KIND_INVALID', 'scheduler task kind is not supported');
  }
  return value;
}

function taskTimestamp(value) {
  if (!isTimestamp(value)) {
    throw new SchedulerPolicyError('SCHEDULER_TASK_DUE_INVALID', 'scheduler task dueAt must be a non-negative safe integer timestamp');
  }
  return value;
}

function validateGmgnAdmission(value) {
  if (!isPlainObject(value) || !isTimestamp(value.nextAllowedAt) || !isTimestamp(value.spacingReadyAt)
    || !Number.isFinite(value.backoffFactor) || value.backoffFactor < 1
    || !isTimestamp(value.lastRequestAt) || !positiveInteger(value.lastWeight)
    || !isTimestamp(value.successStreak) || !isTimestamp(value.keyEpoch)) {
    throw new SchedulerPolicyError('SCHEDULER_GMGN_ADMISSION_INVALID', 'GMGN admission state is invalid');
  }
  return value;
}

function runtimeEligibility(value) {
  if (!isPlainObject(value) || typeof value.paused !== 'boolean' || typeof value.configured !== 'boolean') {
    throw new SchedulerPolicyError('SCHEDULER_ELIGIBILITY_INVALID', 'scheduler eligibility must contain paused and configured booleans');
  }
  return value;
}

function retryState(value) {
  for (const [id, retry] of Object.entries(value)) {
    taskId(id);
    if (!isPlainObject(retry) || !positiveInteger(retry.attempts) || retry.attempts > MAX_RETRY_ATTEMPTS
      || typeof retry.lastErrorCode !== 'string' || !retry.lastErrorCode) {
      throw new SchedulerPolicyError('SCHEDULER_RUNTIME_INVALID', 'scheduler retry state is invalid');
    }
    const exhausted = retry.dueAt === null;
    if ((!exhausted && !isTimestamp(retry.dueAt)) || (exhausted && !isTimestamp(retry.exhaustedAt)) || (!exhausted && retry.exhaustedAt !== null)) {
      throw new SchedulerPolicyError('SCHEDULER_RUNTIME_INVALID', 'scheduler retry timing state is invalid');
    }
  }
}

export function normalizeSchedulerRuntime(value) {
  if (!isPlainObject(value) || value.version !== 1 || !positiveInteger(value.nextLeaseEpoch)
    || !isPlainObject(value.eligibility) || !isPlainObject(value.fairness)
    || !isPlainObject(value.retries) || !isPlainObject(value.checkpoints) || !isPlainObject(value.lowPriorityWaitMs)) {
    throw new SchedulerPolicyError('SCHEDULER_RUNTIME_INVALID', 'scheduler runtime state has an unsupported shape');
  }
  runtimeEligibility(value.eligibility);
  retryState(value.retries);
  if (value.fairness.outbox !== null && typeof value.fairness.outbox !== 'string') {
    throw new SchedulerPolicyError('SCHEDULER_RUNTIME_INVALID', 'scheduler outbox fairness cursor is invalid');
  }
  if (value.inFlight !== null) {
    const lease = value.inFlight;
    if (!isPlainObject(lease) || typeof lease.taskId !== 'string' || !positiveInteger(lease.epoch)
      || !isTimestamp(lease.startedAt) || !isTimestamp(lease.leaseUntil)
      || !['external-request', 'local-transaction', 'unavailable'].includes(lease.mode)) {
      throw new SchedulerPolicyError('SCHEDULER_RUNTIME_INVALID', 'scheduler in-flight lease is invalid');
    }
  }
  return clone(value);
}

export function defaultSchedulerRuntime() {
  return {
    version: 1,
    nextLeaseEpoch: 1,
    inFlight: null,
    eligibility: { paused: false, configured: false },
    fairness: { outbox: null },
    retries: {},
    checkpoints: {},
    lowPriorityWaitMs: {},
    lastScheduledAt: null,
    lastRearmErrorAt: 0
  };
}

export function createTaskDescriptor(value) {
  if (!isPlainObject(value)) throw new SchedulerPolicyError('SCHEDULER_TASK_INVALID', 'scheduler task must be an object');
  const id = taskId(value.id);
  const kind = taskKind(value.kind);
  const dueAt = taskTimestamp(value.dueAt);
  if (typeof value.enabled !== 'boolean' || typeof value.needsGmgn !== 'boolean') {
    throw new SchedulerPolicyError('SCHEDULER_TASK_INVALID', 'scheduler task enabled and needsGmgn fields must be booleans');
  }
  const gmgnWeight = value.gmgnWeight === undefined ? 1 : value.gmgnWeight;
  if (!positiveInteger(gmgnWeight)) {
    throw new SchedulerPolicyError('SCHEDULER_TASK_WEIGHT_INVALID', 'scheduler task GMGN weight must be a positive integer');
  }
  return Object.freeze({ id, kind, dueAt, enabled: value.enabled, needsGmgn: value.needsGmgn, gmgnWeight });
}

function policyTask(value) {
  const descriptor = createTaskDescriptor(value);
  if (value.running !== undefined && typeof value.running !== 'boolean') {
    throw new SchedulerPolicyError('SCHEDULER_TASK_RUNNING_INVALID', 'scheduler task running must be a boolean when supplied');
  }
  return { ...descriptor, running: value.running === true };
}

function uniqueTasks(tasks) {
  if (!Array.isArray(tasks)) throw new SchedulerPolicyError('SCHEDULER_TASKS_INVALID', 'scheduler tasks must be an array');
  const ids = new Set();
  const normalized = tasks.map(policyTask);
  for (const task of normalized) {
    if (ids.has(task.id)) throw new SchedulerPolicyError('SCHEDULER_TASK_ID_DUPLICATE', 'scheduler task ids must be unique');
    ids.add(task.id);
  }
  return normalized;
}

export function providerReadyAt(gmgn) {
  validateGmgnAdmission(gmgn);
  return Math.max(gmgn.nextAllowedAt, gmgn.spacingReadyAt);
}

export function taskDueAt(now, task, gmgn) {
  if (!isTimestamp(now)) throw new SchedulerPolicyError('SCHEDULER_NOW_INVALID', 'scheduler now must be a non-negative safe integer timestamp');
  const normalized = policyTask(task);
  const admissionReadyAt = normalized.needsGmgn ? providerReadyAt(gmgn) : 0;
  return Math.max(now, normalized.dueAt, admissionReadyAt);
}

export function nextDue(now, tasks, gmgn) {
  let next = null;
  for (const task of uniqueTasks(tasks)) {
    if (!task.enabled || task.running) continue;
    const dueAt = taskDueAt(now, task, gmgn);
    next = next === null ? dueAt : Math.min(next, dueAt);
  }
  return next;
}

export function schedulerEligibleTasks(tasks, eligibility) {
  const policy = runtimeEligibility(eligibility);
  return uniqueTasks(tasks).map(task => ({
    ...task,
    enabled: task.enabled && (!['scan', 'live'].includes(task.kind) || (!policy.paused && policy.configured))
  }));
}

function lowPriorityChoice(tasks, cursor) {
  const ordered = [...tasks].sort((left, right) => left.id.localeCompare(right.id));
  if (!cursor) return ordered[0];
  return ordered.find(task => task.id > cursor) || ordered[0];
}

export function selectReadyTask(now, tasks, gmgn, fairness = { outbox: null }) {
  const ready = uniqueTasks(tasks)
    .filter(task => task.enabled && !task.running)
    .map(task => ({ task, dueAt: taskDueAt(now, task, gmgn) }))
    .filter(entry => entry.dueAt <= now);
  if (!ready.length) return null;

  const priority = Math.min(...ready.map(entry => TASK_PRIORITY[entry.task.kind]));
  const candidates = ready.filter(entry => TASK_PRIORITY[entry.task.kind] === priority);
  const entry = priority === TASK_PRIORITY[LOW_PRIORITY_KIND]
    ? candidates.find(candidate => candidate.task.id === lowPriorityChoice(candidates.map(candidate => candidate.task), fairness.outbox)?.id)
    : candidates.sort((left, right) => left.task.dueAt - right.task.dueAt || left.task.id.localeCompare(right.task.id))[0];
  const lowPriorityWaitMs = entry.task.kind === LOW_PRIORITY_KIND ? now - entry.task.dueAt : null;
  return { task: clone(entry.task), dueAt: entry.dueAt, lowPriorityWaitMs };
}

function sourceTasks(rows, prefix, kind, defaults) {
  if (!Array.isArray(rows)) throw new SchedulerPolicyError('SCHEDULER_SOURCE_INVALID', `${prefix} scheduler source must be an array`);
  return rows.map(row => {
    if (!isPlainObject(row)) throw new SchedulerPolicyError('SCHEDULER_SOURCE_INVALID', `${prefix} scheduler source row must be an object`);
    return createTaskDescriptor({
      id: `${prefix}:${taskId(row.id)}`,
      kind,
      dueAt: row.dueAt,
      enabled: row.enabled === undefined ? true : row.enabled,
      needsGmgn: row.needsGmgn === undefined ? defaults.needsGmgn : row.needsGmgn,
      gmgnWeight: row.gmgnWeight === undefined ? 1 : row.gmgnWeight
    });
  });
}

export function deriveTaskDescriptors({ localControl = [], live = [], command = [], scan = [], inbox = [], outbox = [], cardRefresh = [] } = {}) {
  return uniqueTasks([
    ...sourceTasks(localControl, 'control', 'local-control', { needsGmgn: false }),
    ...sourceTasks(live, 'live', 'live', { needsGmgn: true }),
    ...sourceTasks(command, 'command', 'command', { needsGmgn: false }),
    ...sourceTasks(scan, 'scan', 'scan', { needsGmgn: true }),
    ...sourceTasks(inbox, 'inbox', 'command', { needsGmgn: false }),
    ...sourceTasks(outbox, 'outbox', 'outbox', { needsGmgn: false }),
    ...sourceTasks(cardRefresh, 'card', 'outbox', { needsGmgn: false })
  ]).map(({ running: _running, ...task }) => task);
}

export function externalRequestHandler(run) {
  if (typeof run !== 'function') throw new SchedulerPolicyError('SCHEDULER_HANDLER_INVALID', 'external scheduler handler must be a function');
  return Object.freeze({ mode: 'external-request', run });
}

export function localTransactionHandler(run) {
  if (typeof run !== 'function') throw new SchedulerPolicyError('SCHEDULER_HANDLER_INVALID', 'local scheduler handler must be a function');
  return Object.freeze({ mode: 'local-transaction', run });
}

function nextRetryDelay(error, attempts) {
  const requested = Number(error?.retryAfterMs);
  const exponential = MIN_RETRY_MS * (2 ** Math.min(attempts - 1, 8));
  const delay = Number.isFinite(requested) && requested > 0 ? requested : exponential;
  return Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, Math.ceil(delay)));
}

function errorCode(error) {
  return typeof error?.code === 'string' && error.code ? error.code : 'SCHEDULER_STEP_FAILED';
}

function checkpointChanged(previous, next) {
  if (typeof next !== 'string' || next.length === 0 || next.length > 512) {
    throw new SchedulerStepError('SCHEDULER_STEP_CHECKPOINT_INVALID', 'successful scheduler checkpoints must be non-empty bounded strings');
  }
  return previous !== next;
}

function successProgress(result, previousCheckpoint, now) {
  if (!isPlainObject(result) || result.status !== 'success' || typeof result.complete !== 'boolean') {
    throw new SchedulerStepError('SCHEDULER_STEP_RESULT_INVALID', 'scheduler handler must return an explicit success result');
  }
  const hasDueAt = result.nextDueAt !== undefined;
  if (hasDueAt && (!isTimestamp(result.nextDueAt) || result.nextDueAt <= now)) {
    throw new SchedulerStepError('SCHEDULER_STEP_DUE_INVALID', 'successful scheduler task rescheduling must use a future dueAt');
  }
  const hasCheckpoint = result.checkpoint !== undefined;
  if (hasCheckpoint && !checkpointChanged(previousCheckpoint, result.checkpoint)) {
    throw new SchedulerStepError('SCHEDULER_STEP_NO_PROGRESS', 'scheduler checkpoint must advance');
  }
  if (!result.complete && !hasDueAt && !hasCheckpoint) {
    throw new SchedulerStepError('SCHEDULER_STEP_NO_PROGRESS', 'successful scheduler step must advance a checkpoint or dueAt');
  }
  return { complete: result.complete, hasDueAt, nextDueAt: result.nextDueAt, hasCheckpoint, checkpoint: result.checkpoint };
}

function withRunning(tasks, inFlight) {
  return tasks.map(task => ({ ...task, running: inFlight?.taskId === task.id }));
}

function schedulerSnapshot(value) {
  if (!isPlainObject(value)) throw new SchedulerPolicyError('SCHEDULER_STORE_INVALID', 'scheduler store state must be an object');
  return {
    tasks: uniqueTasks(value.tasks).map(({ running: _running, ...task }) => task),
    runtime: normalizeSchedulerRuntime(value.runtime),
    gmgn: clone(validateGmgnAdmission(value.gmgn))
  };
}

export function reserveGmgnAdmission(now, gmgn, task, minGmgnGapMs) {
  const normalizedTask = policyTask(task);
  if (!normalizedTask.needsGmgn) return clone(validateGmgnAdmission(gmgn));
  if (!positiveInteger(minGmgnGapMs) || providerReadyAt(gmgn) > now) {
    throw new SchedulerPolicyError('SCHEDULER_GMGN_RESERVATION_INVALID', 'GMGN admission cannot be reserved before it is ready');
  }
  return {
    ...gmgn,
    lastRequestAt: Math.max(gmgn.lastRequestAt, now),
    lastWeight: normalizedTask.gmgnWeight,
    spacingReadyAt: Math.max(gmgn.spacingReadyAt, now + minGmgnGapMs * normalizedTask.gmgnWeight * gmgn.backoffFactor)
  };
}

export class OneAlarmScheduler {
  #handlers;

  constructor({ store, alarms, handlers = {}, now = Date.now, leaseMs = 60_000, minGmgnGapMs = 1_100, externalRequestTimeoutMs = 30_000, maxRetryAttempts = MAX_RETRY_ATTEMPTS } = {}) {
    if (!store || typeof store.read !== 'function' || typeof store.update !== 'function' || typeof store.runLocalTransaction !== 'function') {
      throw new SchedulerPolicyError('SCHEDULER_STORE_INVALID', 'scheduler store must expose synchronous read, update, and local transaction methods');
    }
    if (!alarms || typeof alarms.setAlarm !== 'function' || typeof alarms.deleteAlarm !== 'function') {
      throw new SchedulerPolicyError('SCHEDULER_ALARMS_INVALID', 'scheduler alarms must expose setAlarm and deleteAlarm methods');
    }
    if (typeof now !== 'function' || !positiveInteger(leaseMs) || !positiveInteger(minGmgnGapMs)
      || !positiveInteger(externalRequestTimeoutMs) || externalRequestTimeoutMs >= leaseMs
      || !positiveInteger(maxRetryAttempts) || maxRetryAttempts > MAX_RETRY_ATTEMPTS) {
      throw new SchedulerPolicyError('SCHEDULER_CONFIGURATION_INVALID', 'scheduler clock, lease, and GMGN spacing configuration are invalid');
    }
    this.store = store;
    this.alarms = alarms;
    this.#handlers = Object.freeze({ ...handlers });
    this.now = now;
    this.leaseMs = leaseMs;
    this.minGmgnGapMs = minGmgnGapMs;
    this.externalRequestTimeoutMs = externalRequestTimeoutMs;
    this.maxRetryAttempts = maxRetryAttempts;
  }

  snapshot() {
    return schedulerSnapshot(this.store.read());
  }

  async replaceTasks(tasks) {
    const nextTasks = uniqueTasks(tasks).map(({ running: _running, ...task }) => task);
    this.store.update(current => ({
      state: { ...schedulerSnapshot(current), tasks: nextTasks },
      value: { taskCount: nextTasks.length }
    }));
    return this.recomputeAlarm();
  }

  async replaceTaskSources(sources) {
    return this.replaceTasks(deriveTaskDescriptors(sources));
  }

  async replaceEligibility(value) {
    const eligibility = runtimeEligibility(value);
    this.store.update(current => {
      const state = schedulerSnapshot(current);
      return {
        state: { ...state, runtime: { ...state.runtime, eligibility: clone(eligibility) } },
        value: clone(eligibility)
      };
    });
    return this.recomputeAlarm();
  }

  async recomputeAlarm() {
    const now = this.#now();
    const state = this.snapshot();
    const dueAt = nextDue(
      now,
      schedulerEligibleTasks(withRunning(state.tasks, state.runtime.inFlight), state.runtime.eligibility),
      state.gmgn
    );
    try {
      if (dueAt === null) await this.alarms.deleteAlarm();
      else await this.alarms.setAlarm(dueAt);
      this.store.update(current => {
        const next = schedulerSnapshot(current);
        return {
          state: { ...next, runtime: { ...next.runtime, lastScheduledAt: dueAt, lastRearmErrorAt: 0 } },
          value: dueAt
        };
      });
      return dueAt;
    } catch (error) {
      this.store.update(current => {
        const next = schedulerSnapshot(current);
        return {
          state: { ...next, runtime: { ...next.runtime, lastRearmErrorAt: now } },
          value: null
        };
      });
      throw error;
    }
  }

  async alarm() {
    const claim = this.#claim();
    if (!claim) {
      const dueAt = await this.recomputeAlarm();
      return { status: 'idle', dueAt };
    }
    if (claim.busy) return { status: 'busy' };
    if (claim.recovered) {
      const dueAt = await this.recomputeAlarm();
      return { status: 'recovered', dueAt };
    }
    try {
      const result = await this.#runHandler(claim);
      return this.#succeed(claim, result);
    } catch (error) {
      return this.#fail(claim, error);
    } finally {
      await this.recomputeAlarm();
    }
  }

  async wake() {
    const now = this.#now();
    const result = this.store.update(current => {
      const state = schedulerSnapshot(current);
      if (state.runtime.inFlight && state.runtime.inFlight.leaseUntil > now) {
        return { state, value: { accepted: false, reason: 'step_in_flight' } };
      }
      if (state.runtime.inFlight) {
        return this.#failureState(state, state.runtime.inFlight, Object.assign(
          new SchedulerStepError('SCHEDULER_LEASE_EXPIRED', 'scheduler in-flight lease expired before completion'),
          { retryAfterMs: MIN_RETRY_MS }
        ), now, { accepted: true, reason: 'expired_lease_recovered' });
      }
      return { state, value: { accepted: true, reason: 'rearmed' } };
    });
    if (!result.accepted) return result;
    const dueAt = await this.recomputeAlarm();
    return { ...result, dueAt };
  }

  #now() {
    const now = this.now();
    if (!isTimestamp(now)) throw new SchedulerPolicyError('SCHEDULER_NOW_INVALID', 'scheduler clock returned an invalid timestamp');
    return now;
  }

  #claim() {
    const now = this.#now();
    return this.store.update(current => {
      const state = schedulerSnapshot(current);
      if (state.runtime.inFlight) {
        if (state.runtime.inFlight.leaseUntil > now) return { state, value: { busy: true } };
        return this.#failureState(state, state.runtime.inFlight, Object.assign(
          new SchedulerStepError('SCHEDULER_LEASE_EXPIRED', 'scheduler in-flight lease expired before completion'),
          { retryAfterMs: MIN_RETRY_MS }
        ), now, { recovered: true });
      }
      const eligible = schedulerEligibleTasks(withRunning(state.tasks, null), state.runtime.eligibility);
      const selected = selectReadyTask(now, eligible, state.gmgn, state.runtime.fairness);
      if (!selected) return { state, value: null };
      const handler = this.#handlers[selected.task.kind];
      if (handler !== undefined && (!isPlainObject(handler) || !['external-request', 'local-transaction'].includes(handler.mode) || typeof handler.run !== 'function')) {
        throw new SchedulerPolicyError('SCHEDULER_HANDLER_INVALID', 'scheduler handler has an invalid bounded-step contract');
      }
      const usableHandler = selected.task.needsGmgn && handler?.mode !== 'external-request' ? undefined : handler;
      const epoch = state.runtime.nextLeaseEpoch;
      const gmgn = selected.task.needsGmgn && usableHandler?.mode === 'external-request'
        ? reserveGmgnAdmission(now, state.gmgn, selected.task, this.minGmgnGapMs)
        : state.gmgn;
      const runtime = {
        ...state.runtime,
        nextLeaseEpoch: epoch + 1,
        inFlight: {
          taskId: selected.task.id,
          epoch,
          startedAt: now,
          leaseUntil: now + this.leaseMs,
          mode: usableHandler?.mode || 'unavailable'
        },
        lowPriorityWaitMs: selected.lowPriorityWaitMs === null
          ? state.runtime.lowPriorityWaitMs
          : { ...state.runtime.lowPriorityWaitMs, [selected.task.id]: selected.lowPriorityWaitMs }
      };
      return {
        state: { tasks: state.tasks, runtime, gmgn },
        value: { ...selected, epoch, handlerMode: usableHandler?.mode || 'unavailable', unavailable: usableHandler === undefined }
      };
    });
  }

  async #runHandler(claim) {
    if (claim.unavailable) {
      throw new SchedulerStepError('SCHEDULER_HANDLER_UNAVAILABLE', `no bounded handler is registered for ${claim.task.kind}`);
    }
    const handler = this.#handlers[claim.task.kind];
    const context = { task: clone(claim.task), epoch: claim.epoch };
    if (handler.mode === 'external-request') {
      let requestCount = 0;
      let requestOpen = true;
      let requestPromise = null;
      try {
        const result = await handler.run({
          ...context,
          request: operation => {
            if (!requestOpen) throw new BoundedStepError('scheduler external request capability has expired');
            if (typeof operation !== 'function') throw new SchedulerStepError('SCHEDULER_REQUEST_INVALID', 'scheduler external request must be a function');
            requestCount += 1;
            if (requestCount > 1) throw new BoundedStepError('a scheduler step may make at most one external request');
            const controller = new AbortController();
            let timeoutId;
            const timeout = new Promise((resolve, reject) => {
              timeoutId = setTimeout(() => {
                const error = new SchedulerStepError('SCHEDULER_REQUEST_TIMEOUT', 'scheduler external request timed out');
                controller.abort(error);
                reject(error);
              }, this.externalRequestTimeoutMs);
            });
            const operationResult = Promise.resolve().then(() => operation({
              signal: controller.signal,
              timeoutMs: this.externalRequestTimeoutMs
            }));
            requestPromise = Promise.race([operationResult, timeout]).finally(() => clearTimeout(timeoutId));
            return requestPromise;
          }
        });
        requestOpen = false;
        if (requestPromise) await requestPromise;
        return result;
      } finally {
        requestOpen = false;
      }
    }
    let transactionCount = 0;
    let transactionOpen = true;
    try {
      const result = handler.run({
        ...context,
        transaction: operation => {
          if (!transactionOpen) throw new BoundedStepError('scheduler local transaction capability has expired');
          if (typeof operation !== 'function') throw new SchedulerStepError('SCHEDULER_TRANSACTION_INVALID', 'scheduler local transaction must be a function');
          transactionCount += 1;
          if (transactionCount > 1) throw new BoundedStepError('a scheduler step may run at most one bounded local transaction');
          const transactionResult = this.store.runLocalTransaction(() => {
            const callbackResult = operation();
            if (callbackResult && typeof callbackResult.then === 'function') {
              throw new BoundedStepError('local scheduler transaction callbacks must complete synchronously');
            }
            return callbackResult;
          });
          if (transactionResult && typeof transactionResult.then === 'function') {
            throw new BoundedStepError('local scheduler transactions must complete synchronously');
          }
          return transactionResult;
        }
      });
      if (result && typeof result.then === 'function') {
        throw new BoundedStepError('local scheduler handlers must complete synchronously inside their bounded transaction');
      }
      return result;
    } finally {
      transactionOpen = false;
    }
  }

  #succeed(claim, result) {
    const now = this.#now();
    return this.store.update(current => {
      const state = schedulerSnapshot(current);
      if (!this.#ownsLease(state.runtime, claim)) return { state, value: { status: 'stale' } };
      const previousCheckpoint = state.runtime.checkpoints[claim.task.id];
      const progress = successProgress(result, previousCheckpoint, now);
      const tasks = progress.complete
        ? state.tasks.filter(task => task.id !== claim.task.id)
        : state.tasks.map(task => task.id === claim.task.id && progress.hasDueAt ? { ...task, dueAt: progress.nextDueAt } : task);
      const retries = { ...state.runtime.retries };
      delete retries[claim.task.id];
      const runtime = {
        ...state.runtime,
        inFlight: null,
        retries,
        fairness: claim.task.kind === LOW_PRIORITY_KIND
          ? { ...state.runtime.fairness, outbox: claim.task.id }
          : state.runtime.fairness,
        checkpoints: progress.hasCheckpoint
          ? { ...state.runtime.checkpoints, [claim.task.id]: progress.checkpoint }
          : state.runtime.checkpoints
      };
      return { state: { tasks, runtime, gmgn: state.gmgn }, value: { status: 'succeeded', taskId: claim.task.id } };
    });
  }

  #fail(claim, error) {
    const now = this.#now();
    return this.store.update(current => {
      const state = schedulerSnapshot(current);
      if (!this.#ownsLease(state.runtime, claim)) return { state, value: { status: 'stale' } };
      return this.#failureState(state, { taskId: claim.task.id }, error, now, { status: 'failed', taskId: claim.task.id });
    });
  }

  #failureState(state, lease, error, now, value) {
    const task = state.tasks.find(item => item.id === lease.taskId);
    if (!task) return { state: { ...state, runtime: { ...state.runtime, inFlight: null } }, value };
    const previousAttempts = Number(state.runtime.retries[task.id]?.attempts || 0);
    const attempts = previousAttempts + 1;
    const exhausted = attempts >= this.maxRetryAttempts;
    const dueAt = now + nextRetryDelay(error, attempts);
    const tasks = state.tasks.map(item => item.id === task.id
      ? exhausted ? { ...item, enabled: false } : { ...item, dueAt }
      : item);
    const runtime = {
      ...state.runtime,
      inFlight: null,
      retries: {
        ...state.runtime.retries,
        [task.id]: {
          attempts,
          dueAt: exhausted ? null : dueAt,
          exhaustedAt: exhausted ? now : null,
          lastErrorCode: errorCode(error)
        }
      }
    };
    return { state: { tasks, runtime, gmgn: state.gmgn }, value };
  }

  #ownsLease(runtime, claim) {
    return runtime.inFlight?.taskId === claim.task.id && runtime.inFlight.epoch === claim.epoch;
  }
}
