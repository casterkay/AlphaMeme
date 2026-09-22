import {
  createTaskDescriptor,
  defaultSchedulerRuntime,
  normalizeSchedulerRuntime
} from '../scheduler.mjs';
import {
  normalizeTenantId,
  readGmgnAdmissionState,
  writeGmgnAdmissionStateInTransaction
} from './gmgn-admission-state.mjs';

const INSTANCE_KEY = 'scheduler.instance.v1';
const RUNTIME_KEY = 'scheduler.runtime.v1';
const TASKS_KEY = 'scheduler.tasks.v1';

export class SchedulerStateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SchedulerStateError';
    this.code = code;
  }
}

function clone(value) {
  return structuredClone(value);
}

function parseRecord(row, key, fallback) {
  if (!row) return clone(fallback);
  try {
    return JSON.parse(row.value_json);
  } catch (error) {
    throw new SchedulerStateError('SCHEDULER_STATE_CORRUPT', `${key} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readRecord(storage, tenantId, key, fallback) {
  const rows = storage.sql.exec('SELECT value_json FROM scheduler_state WHERE tenant_id = ? AND key = ?', tenantId, key).toArray();
  if (rows.length > 1) throw new SchedulerStateError('SCHEDULER_STATE_CORRUPT', `${key} has duplicate rows`);
  return parseRecord(rows[0], key, fallback);
}

function writeRecord(storage, tenantId, key, value) {
  storage.sql.exec(
    'INSERT INTO scheduler_state (tenant_id, key, value_json) VALUES (?, ?, ?) ON CONFLICT(tenant_id, key) DO UPDATE SET value_json = excluded.value_json',
    tenantId,
    key,
    JSON.stringify(value)
  );
}

function taskRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 || !Array.isArray(value.tasks)) {
    throw new SchedulerStateError('SCHEDULER_TASKS_INVALID', 'scheduler tasks state has an unsupported shape');
  }
  const ids = new Set();
  const tasks = value.tasks.map(task => {
    const normalized = createTaskDescriptor(task);
    if (ids.has(normalized.id)) throw new SchedulerStateError('SCHEDULER_TASKS_INVALID', 'scheduler task ids must be unique');
    ids.add(normalized.id);
    return { ...normalized };
  });
  return { version: 1, tasks };
}

function runtimeRecord(value) {
  return normalizeSchedulerRuntime(value);
}

function schedulerInstanceRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1 || Object.keys(value).length !== 1) {
    throw new SchedulerStateError('SCHEDULER_INSTANCE_INVALID', 'scheduler instance state has an unsupported shape');
  }
  return { version: 1 };
}

export function ensureSchedulerTenant(storage, value) {
  const tenantId = normalizeTenantId(value);
  storage.transactionSync(() => {
    const rows = storage.sql.exec('SELECT tenant_id, value_json FROM scheduler_state WHERE key = ? ORDER BY tenant_id', INSTANCE_KEY).toArray();
    if (rows.length === 0) {
      writeRecord(storage, tenantId, INSTANCE_KEY, { version: 1 });
      return;
    }
    if (rows.length !== 1 || rows[0].tenant_id !== tenantId) {
      throw new SchedulerStateError('SCHEDULER_TENANT_MISMATCH', 'Radar Durable Object is already bound to a different tenant');
    }
    schedulerInstanceRecord(parseRecord(rows[0], INSTANCE_KEY, null));
  });
  return tenantId;
}

export function readSchedulerTenant(storage) {
  const rows = storage.sql.exec('SELECT tenant_id, value_json FROM scheduler_state WHERE key = ? ORDER BY tenant_id', INSTANCE_KEY).toArray();
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new SchedulerStateError('SCHEDULER_TENANT_MISMATCH', 'Radar Durable Object has more than one scheduler tenant');
  schedulerInstanceRecord(parseRecord(rows[0], INSTANCE_KEY, null));
  return normalizeTenantId(rows[0].tenant_id);
}

export class SqliteSchedulerStore {
  constructor(storage, value) {
    this.storage = storage;
    this.tenantId = ensureSchedulerTenant(storage, value);
  }

  read() {
    const tasks = taskRecord(readRecord(this.storage, this.tenantId, TASKS_KEY, { version: 1, tasks: [] })).tasks;
    const runtime = runtimeRecord(readRecord(this.storage, this.tenantId, RUNTIME_KEY, defaultSchedulerRuntime()));
    const gmgn = readGmgnAdmissionState(this.storage, this.tenantId);
    return { tasks, runtime, gmgn };
  }

  update(mutator) {
    if (typeof mutator !== 'function') throw new SchedulerStateError('SCHEDULER_STATE_UPDATE_INVALID', 'scheduler state update must be a function');
    return this.storage.transactionSync(() => {
      const current = this.read();
      const update = mutator(clone(current));
      if (!update || typeof update !== 'object' || !update.state || typeof update.state !== 'object' || !Object.hasOwn(update, 'value')) {
        throw new SchedulerStateError('SCHEDULER_STATE_UPDATE_INVALID', 'scheduler update must return state and value');
      }
      const tasks = taskRecord({ version: 1, tasks: update.state.tasks }).tasks;
      const runtime = runtimeRecord(update.state.runtime);
      writeRecord(this.storage, this.tenantId, TASKS_KEY, { version: 1, tasks });
      writeRecord(this.storage, this.tenantId, RUNTIME_KEY, runtime);
      if (JSON.stringify(update.state.gmgn) !== JSON.stringify(current.gmgn)) {
        writeGmgnAdmissionStateInTransaction(this.storage, this.tenantId, update.state.gmgn);
      }
      return clone(update.value);
    });
  }

  runLocalTransaction(callback) {
    if (typeof callback !== 'function') throw new SchedulerStateError('SCHEDULER_TRANSACTION_INVALID', 'scheduler local transaction must be a function');
    return this.storage.transactionSync(callback);
  }

  recordTelegramInboxReceipt(receipt, receivedAt) {
    if (!receipt || typeof receipt !== 'object' || receipt.tenantId !== this.tenantId || !Number.isSafeInteger(receivedAt) || receivedAt < 0) {
      throw new SchedulerStateError('SCHEDULER_INBOX_RECEIPT_INVALID', 'Telegram inbox receipt is invalid');
    }
    return this.storage.transactionSync(() => {
      const current = this.read();
      const tenant = this.storage.sql.exec('SELECT owner_user_id FROM tenants WHERE tenant_id = ?', this.tenantId).toArray()[0];
      if (tenant && tenant.owner_user_id !== receipt.actorUserId) {
        return { accepted: false, reason: 'owner_mismatch' };
      }
      if (!tenant) {
        this.storage.sql.exec(
          'INSERT INTO tenants (tenant_id, owner_user_id, gmgn_api_key_enc, onboard_state, created_at) VALUES (?, ?, ?, ?, ?)',
          this.tenantId,
          receipt.actorUserId,
          null,
          'none',
          receivedAt
        );
      }

      const existing = this.storage.sql
        .exec('SELECT actor_user_id, command_type, status, next_at FROM inbox WHERE tenant_id = ? AND update_id = ?', this.tenantId, receipt.updateId)
        .toArray()[0];
      if (existing && (existing.actor_user_id !== receipt.actorUserId || existing.command_type !== receipt.commandType)) {
        throw new SchedulerStateError('SCHEDULER_INBOX_RECEIPT_CONFLICT', 'Telegram inbox update identity conflicts with its durable receipt');
      }
      if (!existing) {
        this.storage.sql.exec(
          'INSERT INTO inbox (tenant_id, update_id, actor_user_id, command_type, payload_json, payload_enc, status, generation, received_at, attempts, next_at, expires_at, message_date, source_message_id, result_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          this.tenantId,
          receipt.updateId,
          receipt.actorUserId,
          receipt.commandType,
          JSON.stringify(receipt.payload),
          null,
          'RECEIVED',
          1,
          receivedAt,
          0,
          receipt.dueAt,
          null,
          receipt.messageDate,
          receipt.sourceMessageId,
          null
        );
      }

      const keepScheduled = !existing || existing.status === 'RECEIVED' || existing.status === 'RUNNING';
      const dueAt = existing ? existing.next_at : receipt.dueAt;
      if (!Number.isSafeInteger(dueAt) || dueAt < 0) {
        throw new SchedulerStateError('SCHEDULER_INBOX_RECEIPT_INVALID', 'Telegram inbox receipt has an invalid durable due time');
      }
      const taskId = `inbox:${receipt.updateId}`;
      const task = { id: taskId, kind: 'command', dueAt, enabled: true, needsGmgn: false, gmgnWeight: 1 };
      const tasks = keepScheduled
        ? current.tasks.some(candidate => candidate.id === taskId)
          ? current.tasks.map(candidate => candidate.id === taskId ? task : candidate)
          : [...current.tasks, task]
        : current.tasks.filter(candidate => candidate.id !== taskId);
      writeRecord(this.storage, this.tenantId, TASKS_KEY, taskRecord({ version: 1, tasks }));
      return { accepted: true, duplicate: Boolean(existing) };
    });
  }

  telegramInboxStatus(updateId) {
    if (typeof updateId !== 'string' || !/^(0|[1-9]\d*)$/.test(updateId)) {
      throw new SchedulerStateError('SCHEDULER_INBOX_RECEIPT_INVALID', 'Telegram inbox update id is invalid');
    }
    const row = this.storage.sql
      .exec('SELECT status FROM inbox WHERE tenant_id = ? AND update_id = ?', this.tenantId, updateId)
      .toArray()[0];
    return row?.status || null;
  }
}

export function scheduleRecoverableScanTaskInTransaction(storage, tenant, cycleId, dueAt) {
  const tenantId = normalizeTenantId(tenant);
  if (typeof cycleId !== 'string' || !/^[a-z0-9][a-z0-9:_-]{0,127}$/i.test(cycleId)
    || !Number.isSafeInteger(dueAt) || dueAt < 0) {
    throw new SchedulerStateError('SCHEDULER_RECOVERABLE_TASK_INVALID', 'recoverable scanner task is invalid');
  }
  const current = taskRecord(readRecord(storage, tenantId, TASKS_KEY, { version: 1, tasks: [] }));
  const task = { id: `scan:${cycleId}`, kind: 'scan', dueAt, enabled: true, needsGmgn: true, gmgnWeight: 1 };
  const tasks = current.tasks.some(item => item.id === task.id)
    ? current.tasks.map(item => item.id === task.id ? task : item)
    : [...current.tasks, task];
  writeRecord(storage, tenantId, TASKS_KEY, taskRecord({ version: 1, tasks }));
  return task;
}

export const SCHEDULER_STATE_KEYS = Object.freeze({ INSTANCE_KEY, RUNTIME_KEY, TASKS_KEY });
