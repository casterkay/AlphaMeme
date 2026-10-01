import { aveReadyAt, reserveAveRequest, validateAveAdmission } from './ave-admission.mjs';

const TASK_KINDS = Object.freeze(['local-control', 'command', 'credential', 'trade', 'lookup', 'scan', 'outbox']);
const TASK_PRIORITY = Object.freeze({
  'local-control': 0,
  command: 2,
  credential: 2,
  trade: 2,
  lookup: 2,
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

function runtimeEligibility(value) {
  if (!isPlainObject(value) || typeof value.paused !== 'boolean' || typeof value.configured !== 'boolean') {
    throw new SchedulerPolicyError('SCHEDULER_ELIGIBILITY_INVALID', 'scheduler eligibility must contain paused and configured booleans');
  }
  return value;
}

function runtimeControl(value) {
  if (!isPlainObject(value) || !isTimestamp(value.controlEpoch) || !isTimestamp(value.connectionGeneration)
    || (value.activeChain !== null && (typeof value.activeChain !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(value.activeChain)))) {
    throw new SchedulerPolicyError('SCHEDULER_CONTROL_STATE_INVALID', 'scheduler control state is invalid');
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
  if (!isPlainObject(value)) {
    throw new SchedulerPolicyError('SCHEDULER_RUNTIME_INVALID', 'scheduler runtime state has an unsupported shape');
  }
  const normalized = value;
  if (normalized.version !== 1 || !positiveInteger(normalized.nextLeaseEpoch)
    || !isPlainObject(normalized.eligibility) || !isPlainObject(normalized.fairness)
    || !isPlainObject(normalized.control) || !isPlainObject(normalized.retries) || !isPlainObject(normalized.checkpoints) || !isPlainObject(normalized.lowPriorityWaitMs)) {
    throw new SchedulerPolicyError('SCHEDULER_RUNTIME_INVALID', 'scheduler runtime state has an unsupported shape');
  }
  runtimeEligibility(normalized.eligibility);
  runtimeControl(normalized.control);
  retryState(normalized.retries);
  if (normalized.fairness.outbox !== null && typeof normalized.fairness.outbox !== 'string') {
    throw new SchedulerPolicyError('SCHEDULER_RUNTIME_INVALID', 'scheduler outbox fairness cursor is invalid');
  }
  if (normalized.inFlight !== null) {
    const lease = normalized.inFlight;
    if (!isPlainObject(lease) || typeof lease.taskId !== 'string' || !positiveInteger(lease.epoch)
      || !isTimestamp(lease.startedAt) || !isTimestamp(lease.leaseUntil)
      || !['external-request', 'local-transaction', 'unavailable'].includes(lease.mode)) {
      throw new SchedulerPolicyError('SCHEDULER_RUNTIME_INVALID', 'scheduler in-flight lease is invalid');
    }
  }
  return clone(normalized);
}

export function defaultSchedulerRuntime() {
  return {
    version: 1,
    nextLeaseEpoch: 1,
    inFlight: null,
    eligibility: { paused: false, configured: false },
    control: { controlEpoch: 0, connectionGeneration: 0, activeChain: null },
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
  if (typeof value.enabled !== 'boolean') {
    throw new SchedulerPolicyError('SCHEDULER_TASK_INVALID', 'scheduler task enabled field must be a boolean');
  }
  // The AVE credit units the task's next request costs; zero when it makes no AVE request.
  if (!isTimestamp(value.aveCost)) {
    throw new SchedulerPolicyError('SCHEDULER_TASK_COST_INVALID', 'scheduler task AVE cost must be a non-negative integer');
  }
  return Object.freeze({ id, kind, dueAt, enabled: value.enabled, aveCost: value.aveCost });
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

// Credential tasks verify a candidate key, whose reads spend its own allowance.
function isCandidateKeyRead(task) {
  return task.kind === 'credential';
}

export function taskDueAt(now, task, ave) {
  if (!isTimestamp(now)) throw new SchedulerPolicyError('SCHEDULER_NOW_INVALID', 'scheduler now must be a non-negative safe integer timestamp');
  const normalized = policyTask(task);
  const admissionReadyAt = normalized.aveCost > 0 ? aveReadyAt(ave, { candidateKey: isCandidateKeyRead(normalized) }) : 0;
  return Math.max(now, normalized.dueAt, admissionReadyAt);
}

export function nextDue(now, tasks, ave) {
  let next = null;
  for (const task of uniqueTasks(tasks)) {
    if (!task.enabled || task.running) continue;
    const dueAt = taskDueAt(now, task, ave);
    next = next === null ? dueAt : Math.min(next, dueAt);
  }
  return next;
}

export function schedulerEligibleTasks(tasks, eligibility) {
  const policy = runtimeEligibility(eligibility);
  return uniqueTasks(tasks).map(task => ({
    ...task,
    enabled: task.enabled && (task.kind !== 'scan' || (!policy.paused && policy.configured))
  }));
}

function lowPriorityChoice(tasks, cursor) {
  const ordered = [...tasks].sort((left, right) => left.id.localeCompare(right.id));
  if (!cursor) return ordered[0];
  return ordered.find(task => task.id > cursor) || ordered[0];
}

export function selectReadyTask(now, tasks, ave, fairness = { outbox: null }) {
  const ready = uniqueTasks(tasks)
    .filter(task => task.enabled && !task.running)
    .map(task => ({ task, dueAt: taskDueAt(now, task, ave) }))
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

function sourceTasks(rows, prefix, kind) {
  if (!Array.isArray(rows)) throw new SchedulerPolicyError('SCHEDULER_SOURCE_INVALID', `${prefix} scheduler source must be an array`);
  return rows.map(row => {
    if (!isPlainObject(row)) throw new SchedulerPolicyError('SCHEDULER_SOURCE_INVALID', `${prefix} scheduler source row must be an object`);
    return createTaskDescriptor({
      id: `${prefix}:${taskId(row.id)}`,
      kind,
      dueAt: row.dueAt,
      enabled: row.enabled === undefined ? true : row.enabled,
      aveCost: row.aveCost === undefined ? 0 : row.aveCost
    });
  });
}

export function deriveTaskDescriptors({ localControl = [], command = [], scan = [], inbox = [], outbox = [], cardRefresh = [] } = {}) {
  return uniqueTasks([
    ...sourceTasks(localControl, 'control', 'local-control'),
    ...sourceTasks(command, 'command', 'command'),
    ...sourceTasks(scan, 'scan', 'scan'),
    ...sourceTasks(inbox, 'inbox', 'command'),
    ...sourceTasks(outbox, 'outbox', 'outbox'),
    ...sourceTasks(cardRefresh, 'card', 'outbox')
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
  const hasNextAveCost = result.nextAveCost !== undefined;
  if (hasNextAveCost && !isTimestamp(result.nextAveCost)) {
    throw new SchedulerStepError('SCHEDULER_STEP_COST_INVALID', 'successful scheduler AVE cost must be a non-negative integer');
  }
  const hasNextTask = result.nextTask !== undefined;
  const nextTask = hasNextTask ? createTaskDescriptor(result.nextTask) : null;
  if (hasNextTask && result.complete) {
    throw new SchedulerStepError('SCHEDULER_STEP_RESULT_INVALID', 'completed scheduler work cannot replace its task');
  }
  return {
    complete: result.complete,
    hasDueAt,
    nextDueAt: result.nextDueAt,
    hasCheckpoint,
    checkpoint: result.checkpoint,
    hasNextAveCost,
    nextAveCost: result.nextAveCost,
    hasNextTask,
    nextTask
  };
}

function withRunning(tasks, inFlight) {
  return tasks.map(task => ({ ...task, running: inFlight?.taskId === task.id }));
}

function schedulerSnapshot(value) {
  if (!isPlainObject(value)) throw new SchedulerPolicyError('SCHEDULER_STORE_INVALID', 'scheduler store state must be an object');
  return {
    tasks: uniqueTasks(value.tasks).map(({ running: _running, ...task }) => task),
    runtime: normalizeSchedulerRuntime(value.runtime),
    ave: clone(validateAveAdmission(value.ave))
  };
}

export class OneAlarmScheduler {
  #handlers;
  #taskReconciler;

  constructor({ store, alarms, handlers = {}, taskReconciler = null, now = Date.now, leaseMs = 60_000, aveBudget, externalRequestTimeoutMs = 30_000, maxRetryAttempts = MAX_RETRY_ATTEMPTS } = {}) {
    if (!store || typeof store.read !== 'function' || typeof store.update !== 'function' || typeof store.runLocalTransaction !== 'function') {
      throw new SchedulerPolicyError('SCHEDULER_STORE_INVALID', 'scheduler store must expose synchronous read, update, and local transaction methods');
    }
    if (!alarms || typeof alarms.setAlarm !== 'function' || typeof alarms.deleteAlarm !== 'function') {
      throw new SchedulerPolicyError('SCHEDULER_ALARMS_INVALID', 'scheduler alarms must expose setAlarm and deleteAlarm methods');
    }
    if (typeof now !== 'function' || !positiveInteger(leaseMs) || !positiveInteger(aveBudget?.monthlyCu) || !positiveInteger(aveBudget?.resetDay)
      || !positiveInteger(externalRequestTimeoutMs) || externalRequestTimeoutMs >= leaseMs
      || !positiveInteger(maxRetryAttempts) || maxRetryAttempts > MAX_RETRY_ATTEMPTS
      || (taskReconciler !== null && typeof taskReconciler !== 'function')) {
      throw new SchedulerPolicyError('SCHEDULER_CONFIGURATION_INVALID', 'scheduler clock, lease, and AVE budget configuration are invalid');
    }
    this.store = store;
    this.alarms = alarms;
    this.#handlers = Object.freeze({ ...handlers });
    this.#taskReconciler = taskReconciler;
    this.now = now;
    this.leaseMs = leaseMs;
    this.aveBudget = aveBudget;
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
    const state = this.store.update(current => {
      const currentState = schedulerSnapshot(current);
      const tasks = this.#reconcileTasks(currentState.tasks);
      return { state: { ...currentState, tasks }, value: { ...currentState, tasks } };
    });
    const dueAt = nextDue(
      now,
      schedulerEligibleTasks(withRunning(state.tasks, state.runtime.inFlight), state.runtime.eligibility),
      state.ave
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
      const currentState = schedulerSnapshot(current);
      const state = { ...currentState, tasks: this.#reconcileTasks(currentState.tasks) };
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

  #reconcileTasks(tasks) {
    if (!this.#taskReconciler) return tasks;
    const reconciled = this.#taskReconciler(clone(tasks));
    if (reconciled && typeof reconciled.then === 'function') {
      throw new SchedulerPolicyError('SCHEDULER_RECONCILER_INVALID', 'scheduler task reconciliation must complete synchronously');
    }
    return uniqueTasks(reconciled).map(({ running: _running, ...task }) => task);
  }

  #claim() {
    const now = this.#now();
    return this.store.update(current => {
      const currentState = schedulerSnapshot(current);
      const state = { ...currentState, tasks: this.#reconcileTasks(currentState.tasks) };
      if (state.runtime.inFlight) {
        if (state.runtime.inFlight.leaseUntil > now) return { state, value: { busy: true } };
        return this.#failureState(state, state.runtime.inFlight, Object.assign(
          new SchedulerStepError('SCHEDULER_LEASE_EXPIRED', 'scheduler in-flight lease expired before completion'),
          { retryAfterMs: MIN_RETRY_MS }
        ), now, { recovered: true });
      }
      const eligible = schedulerEligibleTasks(withRunning(state.tasks, null), state.runtime.eligibility);
      const selected = selectReadyTask(now, eligible, state.ave, state.runtime.fairness);
      if (!selected) return { state, value: null };
      const handler = this.#handlers[selected.task.kind];
      if (handler !== undefined && (!isPlainObject(handler) || !['external-request', 'local-transaction'].includes(handler.mode) || typeof handler.run !== 'function')) {
        throw new SchedulerPolicyError('SCHEDULER_HANDLER_INVALID', 'scheduler handler has an invalid bounded-step contract');
      }
      const usableHandler = selected.task.aveCost > 0 && handler?.mode !== 'external-request' ? undefined : handler;
      const epoch = state.runtime.nextLeaseEpoch;
      let ave = state.ave;
      if (selected.task.aveCost > 0 && usableHandler) {
        const reservation = reserveAveRequest(now, state.ave, selected.task.aveCost, this.aveBudget, { candidateKey: isCandidateKeyRead(selected.task) });
        // An allowance that cannot pay for the request blocks admission until it resets.
        if (!reservation.reserved) return { state: { ...state, ave: reservation.state }, value: null };
        ave = reservation.state;
      }
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
        state: { tasks: state.tasks, runtime, ave },
        value: {
          ...selected,
          epoch,
          attempt: Number(state.runtime.retries[selected.task.id]?.attempts || 0) + 1,
          handlerMode: usableHandler?.mode || 'unavailable',
          unavailable: usableHandler === undefined
        }
      };
    });
  }

  async #runHandler(claim) {
    if (claim.unavailable) {
      throw new SchedulerStepError('SCHEDULER_HANDLER_UNAVAILABLE', `no bounded handler is registered for ${claim.task.kind}`);
    }
    const handler = this.#handlers[claim.task.kind];
    // A handler on its final attempt can end its work with a user-visible outcome instead of failing silently.
    const context = { task: clone(claim.task), epoch: claim.epoch, finalAttempt: claim.attempt >= this.maxRetryAttempts };
    if (handler.mode === 'external-request') {
      let requestCount = 0;
      let requestOpen = true;
      let requestPromise = null;
      let requestObserved = false;
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
            return Object.freeze({
              then: (...args) => {
                requestObserved = true;
                return requestPromise.then(...args);
              },
              catch: (...args) => {
                requestObserved = true;
                return requestPromise.catch(...args);
              },
              finally: (...args) => {
                requestObserved = true;
                return requestPromise.finally(...args);
              }
            });
          }
        });
        requestOpen = false;
        if (requestPromise) {
          try {
            await requestPromise;
          } catch (error) {
            if (!requestObserved) throw error;
          }
        }
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
      const currentTask = state.tasks.find(task => task.id === claim.task.id);
      const replacement = progress.hasNextTask
        ? progress.nextTask
        : {
            ...currentTask,
            ...(progress.hasDueAt ? { dueAt: progress.nextDueAt } : {}),
            ...(progress.hasNextAveCost ? { aveCost: progress.nextAveCost } : {})
          };
      const tasks = progress.complete
        ? state.tasks.filter(task => task.id !== claim.task.id)
        : progress.hasNextTask
          ? [...state.tasks.filter(task => task.id !== claim.task.id && task.id !== replacement.id), replacement]
          : state.tasks.map(task => task.id === claim.task.id ? replacement : task);
      const retries = { ...state.runtime.retries };
      delete retries[claim.task.id];
      const checkpoints = { ...state.runtime.checkpoints };
      delete checkpoints[claim.task.id];
      if (progress.hasCheckpoint && !progress.complete) {
        checkpoints[replacement.id] = progress.checkpoint;
      }
      const runtime = {
        ...state.runtime,
        inFlight: null,
        retries,
        fairness: claim.task.kind === LOW_PRIORITY_KIND
          ? {
              ...state.runtime.fairness,
              outbox: progress.complete ? null : progress.hasNextTask ? replacement.kind === LOW_PRIORITY_KIND ? replacement.id : null : claim.task.id
            }
          : state.runtime.fairness,
        checkpoints
      };
      return { state: { tasks, runtime, ave: state.ave }, value: { status: 'succeeded', taskId: claim.task.id } };
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
    // Logged before the state commits; a failed commit already throws loudly, so the line cannot hide a lost failure.
    console.warn(JSON.stringify({ event: 'scheduler_task_failed', taskId: task.id, taskKind: task.kind, errorCode: errorCode(error),
      httpStatus: Number.isSafeInteger(error?.status) ? error.status : null, attempt: attempts, exhausted }));
    return { state: { tasks, runtime, ave: state.ave }, value };
  }

  #ownsLease(runtime, claim) {
    return runtime.inFlight?.taskId === claim.task.id && runtime.inFlight.epoch === claim.epoch;
  }
}
