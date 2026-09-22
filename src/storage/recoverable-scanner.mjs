import { normalizeTenantId } from './gmgn-admission-state.mjs';
import { assertCheckpointGeneration, SqliteControlStateStore } from './control-state.mjs';
import {
  readSchedulerStateInTransaction,
  scheduleRecoverableScanTaskInTransaction,
  writeSchedulerStateInTransaction
} from './scheduler-state.mjs';

export const SCAN_PHASES = Object.freeze([
  'DISCOVER', 'SCREEN', 'BUILD_QUEUE', 'AUDIT', 'SECONDARY',
  'CLASSIFY_AND_COMMIT', 'OUTCOMES_SAMPLE', 'SUMMARIZE'
]);

const NOTIFICATION_EFFECT_TYPES = new Set(['CANDIDATE_NEW', 'RISK_WORSENED']);
const NOTIFICATION_DEDUP_WINDOW_MS = 30 * 60_000;
const MAX_PUBLIC_CANDIDATES = 200;

export class RecoverableScannerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RecoverableScannerError';
    this.code = code;
  }
}

function clone(value) {
  return structuredClone(value);
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RecoverableScannerError('CYCLE_CHECKPOINT_INVALID', `${name} must be a positive safe integer`);
  }
  return value;
}

function nonnegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RecoverableScannerError('CYCLE_CHECKPOINT_INVALID', `${name} must be a non-negative safe integer`);
  }
  return value;
}

function timestamp(value, name, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RecoverableScannerError('CYCLE_CHECKPOINT_INVALID', `${name} must be a non-negative safe integer`);
  }
  return value;
}

function cycleId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value)) {
    throw new RecoverableScannerError('CYCLE_CHECKPOINT_INVALID', 'cycle id must be a stable bounded identifier');
  }
  return value;
}

function chain(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(value)) {
    throw new RecoverableScannerError('CYCLE_CHECKPOINT_INVALID', 'chain must be a normalized identifier');
  }
  return value;
}

function phase(value) {
  if (!SCAN_PHASES.includes(value)) {
    throw new RecoverableScannerError('CYCLE_CHECKPOINT_PHASE_INVALID', 'cycle checkpoint phase is not supported');
  }
  return value;
}

function index(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RecoverableScannerError('CYCLE_CHECKPOINT_INVALID', `${name} must be a non-negative safe integer`);
  }
  return value;
}

function json(value, name) {
  if (value === undefined) return {};
  try {
    return clone(value);
  } catch (error) {
    throw new RecoverableScannerError('CYCLE_CHECKPOINT_JSON_INVALID', `${name} is not structured-cloneable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseJson(value, name) {
  try {
    const parsed = JSON.parse(value);
    if (parsed === null) throw new Error('must not be null');
    return parsed;
  } catch (error) {
    throw new RecoverableScannerError('CYCLE_CHECKPOINT_CORRUPT', `${name} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function checkpointPartial(value, name) {
  const parsed = parseJson(value, name);
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RecoverableScannerError('CYCLE_CHECKPOINT_CORRUPT', `${name} must be an object`);
  }
  return parsed;
}

function atMostOne(rows, name) {
  if (rows.length > 1) throw new RecoverableScannerError('CYCLE_CHECKPOINT_CORRUPT', `${name} has duplicate rows`);
  return rows[0] || null;
}

function stablePart(value) {
  return encodeURIComponent(String(value));
}

function canonicalAddress(chainName, value) {
  const address = String(value || '').trim();
  return chainName === 'sol' ? address : address.toLowerCase();
}

// A deterministic tuple is preferable to a random UUID: retrying the same
// completed token must address the same durable effects.
export function stableEffectId(tenantId, cycle, chainName, address, effectType) {
  const normalizedTenantId = normalizeTenantId(tenantId);
  cycleId(cycle);
  chain(chainName);
  if (typeof address !== 'string' || !address.trim()) {
    throw new RecoverableScannerError('EFFECT_ID_INVALID', 'effect address must be a non-empty string');
  }
  if (typeof effectType !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(effectType)) {
    throw new RecoverableScannerError('EFFECT_ID_INVALID', 'effect type must be a stable upper-case identifier');
  }
  return `effect:${stablePart(normalizedTenantId)}:${stablePart(cycle)}:${stablePart(chainName)}:${stablePart(address)}:${effectType}`;
}

export function checkpointFromRow(row) {
  if (!row) return null;
  return Object.freeze({
    tenantId: normalizeTenantId(row.tenant_id),
    cycleId: cycleId(row.cycle_id),
    chain: chain(row.chain),
    keyEpoch: nonnegativeInteger(row.key_epoch, 'key epoch'),
    controlEpoch: nonnegativeInteger(row.control_epoch, 'control epoch'),
    deadlineAt: timestamp(row.deadline_at, 'deadline', { nullable: true }),
    phase: phase(row.phase),
    tokenIndex: index(row.token_index, 'token index'),
    endpointIndex: index(row.endpoint_index, 'endpoint index'),
    partial: checkpointPartial(row.partial_json, 'cycle checkpoint partial'),
    updatedAt: timestamp(row.updated_at, 'updated at')
  });
}

function checkpointInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RecoverableScannerError('CYCLE_CHECKPOINT_INVALID', 'cycle checkpoint must be an object');
  }
  return {
    cycleId: cycleId(value.cycleId),
    chain: chain(value.chain),
    keyEpoch: nonnegativeInteger(value.keyEpoch, 'key epoch'),
    controlEpoch: nonnegativeInteger(value.controlEpoch, 'control epoch'),
    deadlineAt: timestamp(value.deadlineAt, 'deadline', { nullable: true }),
    phase: phase(value.phase),
    tokenIndex: index(value.tokenIndex ?? 0, 'token index'),
    endpointIndex: index(value.endpointIndex ?? 0, 'endpoint index'),
    partial: json(value.partial, 'cycle checkpoint partial'),
    updatedAt: timestamp(value.updatedAt, 'updated at')
  };
}

function checkpointEqual(left, right) {
  return left.cycleId === right.cycleId && left.chain === right.chain
    && left.keyEpoch === right.keyEpoch && left.controlEpoch === right.controlEpoch
    && left.deadlineAt === right.deadlineAt;
}

function existingCheckpoint(storage, tenantId, currentCycleId) {
  return checkpointFromRow(atMostOne(storage.sql.exec(
    'SELECT tenant_id, cycle_id, chain, key_epoch, control_epoch, deadline_at, phase, token_index, endpoint_index, partial_json, updated_at FROM cycle_checkpoint WHERE tenant_id = ? AND cycle_id = ?',
    tenantId, currentCycleId
  ).toArray(), 'cycle checkpoint'));
}

function pruneSupersededFinalizedCheckpoints(storage, tenantId, next) {
  const rootCycleId = next.partial.rootCycleId;
  if (typeof rootCycleId !== 'string' || !rootCycleId) return;
  const rows = storage.sql.exec(
    'SELECT cycle_id, phase, partial_json FROM cycle_checkpoint WHERE tenant_id = ? AND chain = ? AND cycle_id <> ?',
    tenantId, next.chain, next.cycleId
  ).toArray();
  for (const row of rows) {
    if (row.phase !== 'SUMMARIZE') continue;
    const partial = checkpointPartial(row.partial_json, 'completed cycle checkpoint partial');
    if (partial.rootCycleId !== rootCycleId || partial.summary?.nextCycleId === next.cycleId) continue;
    storage.sql.exec('DELETE FROM cycle_checkpoint WHERE tenant_id = ? AND cycle_id = ?', tenantId, row.cycle_id);
  }
}

function pruneExpiredOutcomes(storage, tenantId, now, retentionMs) {
  storage.sql.exec(
    'DELETE FROM outcomes WHERE tenant_id = ? AND (baseline_at IS NULL OR baseline_at < ?)',
    tenantId, now - retentionMs
  );
}

function restartCycleId(rootCycleId, keyEpoch) {
  const suffix = `:rotation:${keyEpoch}`;
  return `${String(rootCycleId).slice(0, 127 - suffix.length)}${suffix}`;
}

export function restartRecoverableScanInTransaction(storage, tenant, { keyEpoch, controlEpoch, now } = {}) {
  const tenantId = normalizeTenantId(tenant);
  nonnegativeInteger(keyEpoch, 'key epoch');
  nonnegativeInteger(controlEpoch, 'control epoch');
  timestamp(now, 'restart time');
  const checkpoints = storage.sql.exec(
    'SELECT tenant_id, cycle_id, chain, key_epoch, control_epoch, deadline_at, phase, token_index, endpoint_index, partial_json, updated_at FROM cycle_checkpoint WHERE tenant_id = ? ORDER BY updated_at DESC, cycle_id',
    tenantId
  ).toArray().map(checkpointFromRow);
  const scheduler = readSchedulerStateInTransaction(storage, tenantId);
  const activeTasks = new Map(scheduler.tasks
    .filter(task => task.kind === 'scan' && task.id.startsWith('scan:'))
    .map(task => [task.id.slice('scan:'.length), task]));
  const activeCheckpoints = checkpoints.filter(checkpoint => activeTasks.has(checkpoint.cycleId));
  const tasks = scheduler.tasks.filter(task => task.kind !== 'scan');
  storage.sql.exec('DELETE FROM cycle_checkpoint WHERE tenant_id = ?', tenantId);
  if (!activeCheckpoints.length) {
    writeSchedulerStateInTransaction(storage, tenantId, { ...scheduler, tasks });
    return [];
  }
  writeSchedulerStateInTransaction(storage, tenantId, { ...scheduler, tasks });
  return activeCheckpoints.map(selected => {
    const settings = selected.partial.settings;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)
      || !Number.isSafeInteger(settings.auditCycleBudgetMs) || settings.auditCycleBudgetMs <= 0) {
      throw new RecoverableScannerError('RECOVERABLE_SCANNER_SETTINGS_INVALID', 'restart requires persisted scanner settings');
    }
    const checkpoint = checkpointInput({
      cycleId: restartCycleId(selected.partial.rootCycleId || selected.cycleId, keyEpoch),
      chain: selected.chain,
      keyEpoch,
      controlEpoch,
      deadlineAt: now + settings.auditCycleBudgetMs,
      phase: 'DISCOVER',
      tokenIndex: 0,
      endpointIndex: 0,
      partial: { rootCycleId: selected.partial.rootCycleId || selected.cycleId, scanCount: selected.partial.scanCount || 0, startedAt: now, settings },
      updatedAt: now
    });
    storage.sql.exec(
      'INSERT INTO cycle_checkpoint (tenant_id, cycle_id, chain, key_epoch, control_epoch, deadline_at, phase, token_index, endpoint_index, partial_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      tenantId, checkpoint.cycleId, checkpoint.chain, checkpoint.keyEpoch, checkpoint.controlEpoch, checkpoint.deadlineAt,
      checkpoint.phase, checkpoint.tokenIndex, checkpoint.endpointIndex, JSON.stringify(checkpoint.partial), checkpoint.updatedAt
    );
    scheduleRecoverableScanTaskInTransaction(storage, tenantId, checkpoint.cycleId, now, 3, activeTasks.get(selected.cycleId).enabled);
    return Object.freeze({ tenantId, ...checkpoint });
  });
}

function checkpointEvidenceFresh(value, now, maximumAgeMs) {
  if (!value || typeof value !== 'object') return true;
  if (Number.isSafeInteger(value.collectedAt)
    && (value.collectedAt > now || now - value.collectedAt > maximumAgeMs)) return false;
  return Object.values(value).every(item => checkpointEvidenceFresh(item, now, maximumAgeMs));
}

export function resumeRecoverableCheckpointsInTransaction(storage, tenant, { cycleIds, control, now, allowPaused = false } = {}) {
  const tenantId = normalizeTenantId(tenant);
  if (!Array.isArray(cycleIds)) {
    throw new RecoverableScannerError('CYCLE_CHECKPOINT_INVALID', 'resume cycle ids are invalid');
  }
  timestamp(now, 'resume time');
  if (!control || (!allowPaused && control.paused) || !control.configured) {
    throw new RecoverableScannerError('CYCLE_RESUME_NOT_ELIGIBLE', 'cycle cannot resume while scanning is disabled');
  }
  const checkpoints = cycleIds.map(value => existingCheckpoint(storage, tenantId, cycleId(value)));
  for (const checkpoint of checkpoints) {
    if (!checkpoint) throw new RecoverableScannerError('CYCLE_CHECKPOINT_MISSING', 'cycle checkpoint does not exist');
    if (checkpoint.keyEpoch !== control.keyEpoch) {
      throw new RecoverableScannerError('CYCLE_KEY_EPOCH_STALE', 'cycle credential epoch cannot resume');
    }
    if (checkpoint.deadlineAt !== null && checkpoint.deadlineAt <= now) {
      throw new RecoverableScannerError('CYCLE_DEADLINE_EXPIRED', 'cycle deadline elapsed while paused');
    }
    const staleCandidateMs = checkpoint.partial.settings?.staleCandidateMs;
    const maximumAgeMs = Number.isSafeInteger(staleCandidateMs) && staleCandidateMs > 0 ? staleCandidateMs : 10 * 60_000;
    if (!checkpointEvidenceFresh(checkpoint.partial, now, maximumAgeMs)) {
      throw new RecoverableScannerError('CYCLE_EVIDENCE_STALE', 'cycle evidence must be revalidated before resuming');
    }
  }
  for (const checkpoint of checkpoints) {
    storage.sql.exec(
      'UPDATE cycle_checkpoint SET control_epoch = ?, updated_at = ? WHERE tenant_id = ? AND cycle_id = ?',
      control.controlEpoch, now, tenantId, checkpoint.cycleId
    );
  }
  return checkpoints.map(checkpoint => existingCheckpoint(storage, tenantId, checkpoint.cycleId));
}

function assertCurrent(storage, tenantId, current, expected) {
  if (!current) throw new RecoverableScannerError('CYCLE_CHECKPOINT_MISSING', 'cycle checkpoint does not exist');
  if (expected.phase !== undefined && current.phase !== expected.phase) {
    throw new RecoverableScannerError('CYCLE_CHECKPOINT_PHASE_CONFLICT', 'cycle checkpoint phase changed while work was in flight');
  }
  if (expected.keyEpoch !== undefined && current.keyEpoch !== expected.keyEpoch) {
    throw new RecoverableScannerError('CYCLE_KEY_EPOCH_STALE', 'cycle checkpoint key epoch changed while work was in flight');
  }
  if (expected.controlEpoch !== undefined && current.controlEpoch !== expected.controlEpoch) {
    throw new RecoverableScannerError('CYCLE_CONTROL_EPOCH_STALE', 'cycle checkpoint control epoch changed while work was in flight');
  }
  if ((expected.tokenIndex !== undefined && current.tokenIndex !== expected.tokenIndex)
    || (expected.endpointIndex !== undefined && current.endpointIndex !== expected.endpointIndex)
    || (expected.updatedAt !== undefined && current.updatedAt !== expected.updatedAt)) {
    throw new RecoverableScannerError('CYCLE_CHECKPOINT_CURSOR_CONFLICT', 'cycle request cursor changed while work was in flight');
  }
  try {
    assertCheckpointGeneration(storage, tenantId, current);
  } catch (error) {
    if (error?.code === 'CYCLE_KEY_EPOCH_STALE' || error?.code === 'CYCLE_CONTROL_EPOCH_STALE') {
      throw new RecoverableScannerError(error.code, error.message);
    }
    throw error;
  }
}

function eventInput(value, tenantId, currentCycleId, chainName, address, now) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const effectType = value.effectType;
  const id = stableEffectId(tenantId, currentCycleId, chainName, address, effectType);
  if (typeof value.type !== 'string' || !value.type) {
    throw new RecoverableScannerError('EFFECT_INVALID', 'event type must be a non-empty string');
  }
  return {
    id,
    at: timestamp(value.at ?? now, 'event at'),
    type: value.type,
    message: typeof value.message === 'string' ? value.message : '',
    data: json(value.data, 'event data')
  };
}

function candidateInput(value, tenantId, chainName) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.address !== 'string' || !value.address) {
    throw new RecoverableScannerError('CANDIDATE_INVALID', 'candidate address is required');
  }
  if (value.chain !== undefined && value.chain !== chainName) {
    throw new RecoverableScannerError('CANDIDATE_INVALID', 'candidate chain must match the checkpoint chain');
  }
  if (typeof value.status !== 'string' || !value.status) {
    throw new RecoverableScannerError('CANDIDATE_INVALID', 'candidate status is required');
  }
  return { ...json(value, 'candidate'), address: canonicalAddress(chainName, value.address), tenantId, chain: chainName };
}

function queueInput(value, tenantId, chainName) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.address !== 'string' || !value.address) {
    throw new RecoverableScannerError('AUDIT_QUEUE_INVALID', 'audit queue address is required');
  }
  return { ...json(value, 'audit queue'), address: canonicalAddress(chainName, value.address), tenantId, chain: chainName };
}

function exclusionInput(value, tenantId, chainName) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.address !== 'string' || !value.address) {
    throw new RecoverableScannerError('RISK_EXCLUSION_INVALID', 'risk exclusion address is required');
  }
  return { ...json(value, 'risk exclusion'), address: canonicalAddress(chainName, value.address), tenantId, chain: chainName };
}

function outcomeInput(value, tenantId, chainName, { allowCrossChain = false } = {}) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.address !== 'string' || !value.address) {
    throw new RecoverableScannerError('OUTCOME_INVALID', 'outcome address is required');
  }
  if (typeof value.initialDecision !== 'string' || !value.initialDecision) {
    throw new RecoverableScannerError('OUTCOME_INVALID', 'outcome initial decision is required');
  }
  const outcomeChain = value.chain === undefined ? chainName : chain(value.chain);
  if (!allowCrossChain && outcomeChain !== chainName) {
    throw new RecoverableScannerError('OUTCOME_INVALID', 'classification outcomes must remain on the checkpoint chain');
  }
  return { ...json(value, 'outcome'), address: canonicalAddress(outcomeChain, value.address), tenantId, chain: outcomeChain };
}

function screenDowngradeInput(value, chainName) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.address !== 'string' || !value.address.trim()
    || typeof value.reason !== 'string' || !value.reason.trim()) {
    throw new RecoverableScannerError('SCREEN_DOWNGRADE_INVALID', 'screen downgrade requires an address and reason');
  }
  return { address: canonicalAddress(chainName, value.address), reason: value.reason.trim() };
}

function stringOrNull(value) {
  return typeof value === 'string' ? value : null;
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function integerOrNull(value) {
  return Number.isSafeInteger(value) ? value : null;
}

export class SqliteRecoverableScannerStore {
  constructor(storage, tenantId, { afterClassification = null } = {}) {
    if (!storage?.sql || typeof storage.transactionSync !== 'function') {
      throw new RecoverableScannerError('RECOVERABLE_SCANNER_STORAGE_INVALID', 'recoverable scanner requires Durable Object SQLite storage');
    }
    if (afterClassification !== null && typeof afterClassification !== 'function') throw new TypeError('Classification hook must be synchronous');
    this.afterClassification = afterClassification;
    this.storage = storage;
    this.tenantId = normalizeTenantId(tenantId);
  }

  read(currentCycleId) {
    return existingCheckpoint(this.storage, this.tenantId, cycleId(currentCycleId));
  }

  list() {
    return this.storage.sql.exec(
      'SELECT tenant_id, cycle_id, chain, key_epoch, control_epoch, deadline_at, phase, token_index, endpoint_index, partial_json, updated_at FROM cycle_checkpoint WHERE tenant_id = ? ORDER BY cycle_id',
      this.tenantId
    ).toArray().map(checkpointFromRow);
  }

  begin(value) {
    const afterBegin = value?.afterBegin;
    if (afterBegin !== undefined && typeof afterBegin !== 'function') {
      throw new RecoverableScannerError('CYCLE_CHECKPOINT_INVALID', 'cycle checkpoint begin hook is invalid');
    }
    const next = checkpointInput(value);
    return this.storage.transactionSync(() => {
      const current = existingCheckpoint(this.storage, this.tenantId, next.cycleId);
      if (current) {
        if (!checkpointEqual(current, next)) {
          throw new RecoverableScannerError('CYCLE_CHECKPOINT_CONFLICT', 'cycle id already belongs to another immutable cycle');
        }
        afterBegin?.(current);
        return current;
      }
      this.storage.sql.exec(
        'INSERT INTO cycle_checkpoint (tenant_id, cycle_id, chain, key_epoch, control_epoch, deadline_at, phase, token_index, endpoint_index, partial_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        this.tenantId, next.cycleId, next.chain, next.keyEpoch, next.controlEpoch, next.deadlineAt,
        next.phase, next.tokenIndex, next.endpointIndex, JSON.stringify(next.partial), next.updatedAt
      );
      pruneSupersededFinalizedCheckpoints(this.storage, this.tenantId, next);
      afterBegin?.({ tenantId: this.tenantId, ...next });
      return Object.freeze({ tenantId: this.tenantId, ...next });
    });
  }

  resumeCheckpoint(value) {
    const currentCycleId = cycleId(value?.cycleId);
    const now = timestamp(value?.now, 'resume time');
    return this.storage.transactionSync(() => {
      const current = existingCheckpoint(this.storage, this.tenantId, currentCycleId);
      if (!current) throw new RecoverableScannerError('CYCLE_CHECKPOINT_MISSING', 'cycle checkpoint does not exist');
      const control = new SqliteControlStateStore(this.storage, this.tenantId).snapshot();
      if (control.paused || !control.configured) {
        throw new RecoverableScannerError('CYCLE_RESUME_NOT_ELIGIBLE', 'cycle cannot resume while scanning is disabled');
      }
      if (current.keyEpoch !== control.keyEpoch) {
        throw new RecoverableScannerError('CYCLE_KEY_EPOCH_STALE', 'cycle credential epoch cannot resume');
      }
      if (current.deadlineAt !== null && current.deadlineAt <= now) {
        throw new RecoverableScannerError('CYCLE_DEADLINE_EXPIRED', 'cycle deadline elapsed while paused');
      }
      if (value?.evidenceFresh !== true) {
        throw new RecoverableScannerError('CYCLE_EVIDENCE_STALE', 'cycle evidence must be revalidated before resuming');
      }
      this.storage.sql.exec(
        'UPDATE cycle_checkpoint SET control_epoch = ?, updated_at = ? WHERE tenant_id = ? AND cycle_id = ?',
        control.controlEpoch, now, this.tenantId, currentCycleId
      );
      return existingCheckpoint(this.storage, this.tenantId, currentCycleId);
    });
  }

  advance(value) {
    const next = checkpointInput(value.next);
    const expected = value.expected || {};
    return this.storage.transactionSync(() => {
      const current = existingCheckpoint(this.storage, this.tenantId, next.cycleId);
      assertCurrent(this.storage, this.tenantId, current, expected);
      if (!checkpointEqual(current, next)) {
        throw new RecoverableScannerError('CYCLE_CHECKPOINT_IMMUTABLE_CONFLICT', 'cycle identity and epochs cannot change after creation');
      }
      this.storage.sql.exec(
        'UPDATE cycle_checkpoint SET phase = ?, token_index = ?, endpoint_index = ?, partial_json = ?, updated_at = ? WHERE tenant_id = ? AND cycle_id = ?',
        next.phase, next.tokenIndex, next.endpointIndex, JSON.stringify(next.partial), next.updatedAt, this.tenantId, next.cycleId
      );
      return Object.freeze({ tenantId: this.tenantId, ...next });
    });
  }

  commitQueue(value) {
    const next = checkpointInput(value.next);
    const expected = value.expected || {};
    if (!Array.isArray(value.auditQueue)) {
      throw new RecoverableScannerError('AUDIT_QUEUE_INVALID', 'audit queue must be an array');
    }
    const auditQueue = value.auditQueue.map(item => queueInput(item, this.tenantId, next.chain));
    return this.storage.transactionSync(() => {
      const current = existingCheckpoint(this.storage, this.tenantId, next.cycleId);
      assertCurrent(this.storage, this.tenantId, current, expected);
      if (!checkpointEqual(current, next)) {
        throw new RecoverableScannerError('CYCLE_CHECKPOINT_IMMUTABLE_CONFLICT', 'cycle identity and epochs cannot change after creation');
      }
      this.storage.sql.exec('DELETE FROM audit_queue WHERE tenant_id = ? AND chain = ?', this.tenantId, next.chain);
      for (const row of auditQueue) {
        this.storage.sql.exec(
          `INSERT INTO audit_queue (tenant_id, chain, address, first_seen_at, last_seen_at, last_audited_at, next_audit_at, attempts, status, priority_band, score, watched, details_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          row.tenantId, row.chain, row.address, integerOrNull(row.firstSeenAt), integerOrNull(row.lastSeenAt),
          integerOrNull(row.lastAuditedAt), integerOrNull(row.nextAuditAt), integerOrNull(row.attempts),
          stringOrNull(row.status), row.priorityBand ? 1 : 0, numberOrNull(row.score), row.watched ? 1 : 0,
          JSON.stringify(row.details || {})
        );
      }
      this.storage.sql.exec(
        'UPDATE cycle_checkpoint SET phase = ?, token_index = ?, endpoint_index = ?, partial_json = ?, updated_at = ? WHERE tenant_id = ? AND cycle_id = ?',
        next.phase, next.tokenIndex, next.endpointIndex, JSON.stringify(next.partial), next.updatedAt, this.tenantId, next.cycleId
      );
      return Object.freeze({ tenantId: this.tenantId, ...next });
    });
  }

  commitSummary(value) {
    const next = checkpointInput(value.next);
    const expected = value.expected || {};
    const candidateRetentionMs = positiveInteger(value.candidateRetentionMs, 'candidate retention');
    const outcomeRetentionMs = positiveInteger(value.outcomeRetentionMs, 'outcome retention');
    return this.storage.transactionSync(() => {
      const current = existingCheckpoint(this.storage, this.tenantId, next.cycleId);
      assertCurrent(this.storage, this.tenantId, current, expected);
      if (!checkpointEqual(current, next)) {
        throw new RecoverableScannerError('CYCLE_CHECKPOINT_IMMUTABLE_CONFLICT', 'cycle identity and epochs cannot change after creation');
      }
      const retentionBoundary = next.updatedAt - candidateRetentionMs;
      this.storage.sql.exec(
        `DELETE FROM candidates
         WHERE tenant_id = ? AND chain = ?
           AND address NOT IN (SELECT address FROM annotations WHERE tenant_id = ? AND chain = ? AND favorite = 1)
           AND (audited_at IS NULL OR audited_at < ?)`,
        this.tenantId, next.chain, this.tenantId, next.chain, retentionBoundary
      );
      this.storage.sql.exec(
        `DELETE FROM candidates
         WHERE tenant_id = ? AND chain = ? AND address NOT IN (
           SELECT address FROM candidates
           WHERE tenant_id = ? AND chain = ?
           ORDER BY CASE status WHEN 'X_REVIEW' THEN 3 WHEN 'WAIT_RECHECK' THEN 2 WHEN 'HARD_REJECT' THEN 1 ELSE 0 END DESC,
                    priority_band DESC, discovery_score DESC, address ASC
           LIMIT ?
         )`,
        this.tenantId, next.chain, this.tenantId, next.chain, MAX_PUBLIC_CANDIDATES
      );
      pruneExpiredOutcomes(this.storage, this.tenantId, next.updatedAt, outcomeRetentionMs);
      this.storage.sql.exec(
        'UPDATE cycle_checkpoint SET phase = ?, token_index = ?, endpoint_index = ?, partial_json = ?, updated_at = ? WHERE tenant_id = ? AND cycle_id = ?',
        next.phase, next.tokenIndex, next.endpointIndex, JSON.stringify(next.partial), next.updatedAt, this.tenantId, next.cycleId
      );
      return Object.freeze({ tenantId: this.tenantId, ...next });
    });
  }

  commitOutcomeSelection(value) {
    const next = checkpointInput(value.next);
    const expected = value.expected || {};
    const outcomeRetentionMs = positiveInteger(value.outcomeRetentionMs, 'outcome retention');
    return this.storage.transactionSync(() => {
      const current = existingCheckpoint(this.storage, this.tenantId, next.cycleId);
      assertCurrent(this.storage, this.tenantId, current, { ...expected, phase: expected.phase ?? 'OUTCOMES_SAMPLE' });
      if (!checkpointEqual(current, next)) {
        throw new RecoverableScannerError('CYCLE_CHECKPOINT_IMMUTABLE_CONFLICT', 'cycle identity and epochs cannot change after creation');
      }
      pruneExpiredOutcomes(this.storage, this.tenantId, next.updatedAt, outcomeRetentionMs);
      this.storage.sql.exec(
        'UPDATE cycle_checkpoint SET phase = ?, token_index = ?, endpoint_index = ?, partial_json = ?, updated_at = ? WHERE tenant_id = ? AND cycle_id = ?',
        next.phase, next.tokenIndex, next.endpointIndex, JSON.stringify(next.partial), next.updatedAt, this.tenantId, next.cycleId
      );
      return Object.freeze({ tenantId: this.tenantId, ...next });
    });
  }

  commitScreen(value) {
    const next = checkpointInput(value.next);
    const expected = value.expected || {};
    if (!Array.isArray(value.downgrades)) {
      throw new RecoverableScannerError('SCREEN_DOWNGRADE_INVALID', 'screen downgrades must be an array');
    }
    const downgrades = [...new Map(value.downgrades
      .map(item => screenDowngradeInput(item, next.chain))
      .map(item => [item.address, item])).values()];
    return this.storage.transactionSync(() => {
      const current = existingCheckpoint(this.storage, this.tenantId, next.cycleId);
      assertCurrent(this.storage, this.tenantId, current, expected);
      if (!checkpointEqual(current, next)) {
        throw new RecoverableScannerError('CYCLE_CHECKPOINT_IMMUTABLE_CONFLICT', 'cycle identity and epochs cannot change after creation');
      }
      for (const downgrade of downgrades) {
        const row = atMostOne(this.storage.sql.exec(
          'SELECT deep_json FROM candidates WHERE tenant_id = ? AND chain = ? AND address = ? AND status = ?',
          this.tenantId, next.chain, downgrade.address, 'X_REVIEW'
        ).toArray(), 'screen downgrade candidate');
        if (!row) continue;
        const deep = parseJson(row.deep_json, 'candidate deep state');
        this.storage.sql.exec(
          'UPDATE candidates SET status = ?, deep_json = ?, decision_reason = ? WHERE tenant_id = ? AND chain = ? AND address = ? AND status = ?',
          'WAIT_RECHECK', JSON.stringify({ ...deep, chainPass: false }), downgrade.reason,
          this.tenantId, next.chain, downgrade.address, 'X_REVIEW'
        );
        this.storage.sql.exec(
          'UPDATE audit_queue SET status = ? WHERE tenant_id = ? AND chain = ? AND address = ?',
          'WAIT_RECHECK', this.tenantId, next.chain, downgrade.address
        );
      }
      this.storage.sql.exec(
        'UPDATE cycle_checkpoint SET phase = ?, token_index = ?, endpoint_index = ?, partial_json = ?, updated_at = ? WHERE tenant_id = ? AND cycle_id = ?',
        next.phase, next.tokenIndex, next.endpointIndex, JSON.stringify(next.partial), next.updatedAt, this.tenantId, next.cycleId
      );
      return Object.freeze({ tenantId: this.tenantId, ...next });
    });
  }

  readRiskExclusions(chainName) {
    return this.storage.sql.exec(
      'SELECT address, version, codes_json, reasons_json, at, details_json FROM risk_exclusions WHERE tenant_id = ? AND chain = ?',
      this.tenantId, chain(chainName)
    ).toArray().map(row => ({
      chain: chainName,
      address: row.address,
      version: row.version,
      codes: parseJson(row.codes_json, 'risk exclusion codes'),
      reasons: parseJson(row.reasons_json, 'risk exclusion reasons'),
      at: row.at,
      ...parseJson(row.details_json, 'risk exclusion details')
    }));
  }

  readRequestedReviews(chainName, keyEpoch, now) {
    const record = this.storage.sql.exec('SELECT value_json FROM scheduler_state WHERE tenant_id = ? AND key = ?', this.tenantId, 'live.requestedReviews').toArray()[0];
    const requests = record ? parseJson(record.value_json, 'live review requests') : [];
    if (!Array.isArray(requests)) throw new RecoverableScannerError('LIVE_REVIEW_REQUESTS_INVALID', 'live review requests must be an array');
    return requests.filter(item => item.chain === chainName && item.keyEpoch === keyEpoch && item.row?.address
      && item.at <= now && now - item.at <= 600_000);
  }

  readAuditQueue(chainName) {
    return this.storage.sql.exec(
      'SELECT address, first_seen_at, last_seen_at, last_audited_at, next_audit_at, attempts, status, priority_band, score, watched, details_json FROM audit_queue WHERE tenant_id = ? AND chain = ?',
      this.tenantId, chain(chainName)
    ).toArray().map(row => ({
      address: row.address,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      lastAuditedAt: row.last_audited_at,
      nextAuditAt: row.next_audit_at,
      attempts: row.attempts,
      status: row.status,
      priorityBand: Boolean(row.priority_band),
      score: row.score,
      watched: Boolean(row.watched),
      ...parseJson(row.details_json, 'audit queue details')
    }));
  }

  readCandidateReview(chainName, address) {
    const normalizedChain = chain(chainName);
    const rows = this.storage.sql.exec(
      'SELECT review_evidence, review_revision, status FROM candidates WHERE tenant_id = ? AND chain = ? AND address = ?',
      this.tenantId, normalizedChain, canonicalAddress(normalizedChain, address)
    ).toArray();
    const row = atMostOne(rows, 'candidate review');
    return row ? { reviewEvidence: row.review_evidence, reviewRevision: row.review_revision, status: row.status } : null;
  }

  readMonitorCandidates(chainName, candidateRetentionMs = null, now = null) {
    const normalizedChain = chain(chainName);
    const hasRetentionBoundary = Number.isSafeInteger(candidateRetentionMs) && candidateRetentionMs > 0
      && Number.isSafeInteger(now) && now >= candidateRetentionMs;
    const retentionBoundary = hasRetentionBoundary ? now - candidateRetentionMs : 0;
    return this.storage.sql.exec(
      `SELECT c.address, c.symbol, c.name, c.price, c.market_cap, c.liquidity, c.created_at, c.age_sec
       FROM candidates c
       LEFT JOIN annotations a
         ON a.tenant_id = c.tenant_id AND a.chain = c.chain AND a.address = c.address
       WHERE c.tenant_id = ? AND c.chain = ?
         AND ((c.status = 'X_REVIEW' AND (? = 0 OR c.audited_at >= ?)) OR a.favorite = 1)
       UNION ALL
       SELECT a.address, NULL, NULL, NULL, NULL, NULL, NULL, NULL
       FROM annotations a
       LEFT JOIN candidates c
         ON c.tenant_id = a.tenant_id AND c.chain = a.chain AND c.address = a.address
       WHERE a.tenant_id = ? AND a.chain = ? AND a.favorite = 1 AND c.address IS NULL
       ORDER BY 1`,
      this.tenantId, normalizedChain, hasRetentionBoundary ? 1 : 0, retentionBoundary, this.tenantId, normalizedChain
    ).toArray().map(row => ({
      address: row.address,
      symbol: row.symbol,
      name: row.name,
      price: row.price,
      marketCap: row.market_cap,
      liquidity: row.liquidity,
      createdAt: row.created_at,
      ageSec: row.age_sec
    }));
  }

  readOutcomes(chainName = null) {
    const normalizedChain = chainName === null ? null : chain(chainName);
    const rows = normalizedChain === null
      ? this.storage.sql.exec(
        'SELECT chain, address, initial_decision, latest_decision, baseline_at, baseline_price, last_audited_at, symbol, latest_failed_json, sampling, strategy_version, samples_json, sample_retries_json, cohort_metadata_json FROM outcomes WHERE tenant_id = ?',
        this.tenantId
      ).toArray()
      : this.storage.sql.exec(
        'SELECT chain, address, initial_decision, latest_decision, baseline_at, baseline_price, last_audited_at, symbol, latest_failed_json, sampling, strategy_version, samples_json, sample_retries_json, cohort_metadata_json FROM outcomes WHERE tenant_id = ? AND chain = ?',
        this.tenantId, normalizedChain
      ).toArray();
    return rows.map(row => ({
      chain: row.chain,
      address: row.address,
      initialDecision: row.initial_decision,
      latestDecision: row.latest_decision,
      baselineAt: row.baseline_at,
      baselinePrice: row.baseline_price,
      lastAuditedAt: row.last_audited_at,
      symbol: row.symbol,
      latestFailed: parseJson(row.latest_failed_json, 'outcome latest failures'),
      sampling: row.sampling,
      strategyVersion: row.strategy_version,
      samples: parseJson(row.samples_json, 'outcome samples'),
      sampleRetries: parseJson(row.sample_retries_json, 'outcome sample retries'),
      cohortMetadata: parseJson(row.cohort_metadata_json, 'outcome cohort metadata')
    }));
  }

  commitClassification(value) {
    const expected = value.expected || {};
    const next = checkpointInput(value.next);
    const candidate = candidateInput(value.candidate, this.tenantId, next.chain);
    const auditQueue = queueInput(value.auditQueue, this.tenantId, next.chain);
    const exclusion = exclusionInput(value.riskExclusion, this.tenantId, next.chain);
    const outcome = outcomeInput(value.outcome, this.tenantId, next.chain);
    let event = eventInput(value.event, this.tenantId, next.cycleId, next.chain, candidate.address, next.updatedAt);

    return this.storage.transactionSync(() => {
      const current = existingCheckpoint(this.storage, this.tenantId, next.cycleId);
      assertCurrent(this.storage, this.tenantId, current, { ...expected, phase: expected.phase ?? 'CLASSIFY_AND_COMMIT' });
      if (!checkpointEqual(current, next)) {
        throw new RecoverableScannerError('CYCLE_CHECKPOINT_IMMUTABLE_CONFLICT', 'cycle identity and epochs cannot change after creation');
      }

      this.storage.sql.exec(
        `INSERT INTO candidates (tenant_id, chain, address, symbol, name, info_json, review_evidence, status, priority_band, discovery_score, market_cap, liquidity, price, created_at, age_sec, holders, volume_1h, buys, sells, twitter, gmgn_url, audited_at, stale_at, review_revision, decision_reason, audit_error, deep_json, secondary_json, social_json, audit_health_json, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, chain, address) DO UPDATE SET
           symbol = excluded.symbol, name = excluded.name, info_json = excluded.info_json, review_evidence = excluded.review_evidence,
           status = excluded.status, priority_band = excluded.priority_band, discovery_score = excluded.discovery_score,
           market_cap = excluded.market_cap, liquidity = excluded.liquidity, price = excluded.price, created_at = excluded.created_at,
           age_sec = excluded.age_sec, holders = excluded.holders, volume_1h = excluded.volume_1h, buys = excluded.buys,
           sells = excluded.sells, twitter = excluded.twitter, gmgn_url = excluded.gmgn_url, audited_at = excluded.audited_at,
           stale_at = excluded.stale_at, review_revision = excluded.review_revision, decision_reason = excluded.decision_reason,
           audit_error = excluded.audit_error, deep_json = excluded.deep_json, secondary_json = excluded.secondary_json,
           social_json = excluded.social_json, audit_health_json = excluded.audit_health_json, metadata_json = excluded.metadata_json`,
        candidate.tenantId, candidate.chain, candidate.address, stringOrNull(candidate.symbol), stringOrNull(candidate.name),
        JSON.stringify(candidate.info || {}), stringOrNull(candidate.reviewEvidence), candidate.status, candidate.priorityBand ? 1 : 0,
        numberOrNull(candidate.discoveryScore), numberOrNull(candidate.marketCap), numberOrNull(candidate.liquidity), numberOrNull(candidate.price),
        integerOrNull(candidate.createdAt), numberOrNull(candidate.ageSec), integerOrNull(candidate.holders), numberOrNull(candidate.volume1h),
        integerOrNull(candidate.buys), integerOrNull(candidate.sells), stringOrNull(candidate.twitter), stringOrNull(candidate.gmgnUrl),
        integerOrNull(candidate.auditedAt), integerOrNull(candidate.staleAt), stringOrNull(candidate.reviewRevision),
        stringOrNull(candidate.decisionReason), stringOrNull(candidate.auditError), JSON.stringify(candidate.deep || {}),
        JSON.stringify(candidate.secondary || null), JSON.stringify(candidate.social || {}), JSON.stringify(candidate.auditHealth || {}),
        JSON.stringify(candidate.metadata || {})
      );

      this.storage.sql.exec(
        `INSERT INTO audit_queue (tenant_id, chain, address, first_seen_at, last_seen_at, last_audited_at, next_audit_at, attempts, status, priority_band, score, watched, details_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, chain, address) DO UPDATE SET
           first_seen_at = excluded.first_seen_at, last_seen_at = excluded.last_seen_at, last_audited_at = excluded.last_audited_at,
           next_audit_at = excluded.next_audit_at, attempts = excluded.attempts, status = excluded.status,
           priority_band = excluded.priority_band, score = excluded.score, watched = excluded.watched, details_json = excluded.details_json`,
        auditQueue.tenantId, auditQueue.chain, auditQueue.address, integerOrNull(auditQueue.firstSeenAt), integerOrNull(auditQueue.lastSeenAt),
        integerOrNull(auditQueue.lastAuditedAt), integerOrNull(auditQueue.nextAuditAt), integerOrNull(auditQueue.attempts),
        stringOrNull(auditQueue.status), auditQueue.priorityBand ? 1 : 0, numberOrNull(auditQueue.score), auditQueue.watched ? 1 : 0,
        JSON.stringify(auditQueue.details || {})
      );

      if (exclusion) {
        this.storage.sql.exec(
          `INSERT INTO risk_exclusions (tenant_id, chain, address, version, codes_json, reasons_json, at, details_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(tenant_id, chain, address) DO UPDATE SET
             version = excluded.version, codes_json = excluded.codes_json, reasons_json = excluded.reasons_json,
             at = excluded.at, details_json = excluded.details_json`,
          exclusion.tenantId, exclusion.chain, exclusion.address, integerOrNull(exclusion.version), JSON.stringify(exclusion.codes || []),
          JSON.stringify(exclusion.reasons || []), integerOrNull(exclusion.at), JSON.stringify(exclusion.details || {})
        );
      }

      if (outcome) {
        this.storage.sql.exec(
          `INSERT INTO outcomes (tenant_id, chain, address, initial_decision, latest_decision, baseline_at, baseline_price, last_audited_at, symbol, latest_failed_json, sampling, strategy_version, samples_json, sample_retries_json, cohort_metadata_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(tenant_id, chain, address) DO UPDATE SET
             latest_decision = excluded.latest_decision, last_audited_at = excluded.last_audited_at, symbol = excluded.symbol,
             latest_failed_json = excluded.latest_failed_json, samples_json = excluded.samples_json,
             sample_retries_json = excluded.sample_retries_json, cohort_metadata_json = excluded.cohort_metadata_json`,
          outcome.tenantId, outcome.chain, outcome.address, outcome.initialDecision, stringOrNull(outcome.latestDecision),
          integerOrNull(outcome.baselineAt), numberOrNull(outcome.baselinePrice), integerOrNull(outcome.lastAuditedAt),
          stringOrNull(outcome.symbol), JSON.stringify(outcome.latestFailed || []), stringOrNull(outcome.sampling),
          stringOrNull(outcome.strategyVersion), JSON.stringify(outcome.samples || {}), JSON.stringify(outcome.sampleRetries || {}),
          JSON.stringify(outcome.cohortMetadata || {})
        );
      }

      if (event && NOTIFICATION_EFFECT_TYPES.has(event.type)) {
        const recent = this.storage.sql.exec(
          'SELECT 1 FROM events WHERE tenant_id = ? AND type = ? AND chain = ? AND address = ? AND at > ? LIMIT 1',
          this.tenantId, event.type, next.chain, candidate.address, event.at - NOTIFICATION_DEDUP_WINDOW_MS
        ).toArray()[0];
        if (recent) event = null;
      }

      if (event) {
        this.storage.sql.exec(
          'INSERT INTO events (tenant_id, id, at, type, chain, address, message, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(tenant_id, id) DO NOTHING',
          this.tenantId, event.id, event.at, event.type, next.chain, candidate.address, event.message, JSON.stringify(event.data)
        );

      }

      this.storage.sql.exec(
        'UPDATE cycle_checkpoint SET phase = ?, token_index = ?, endpoint_index = ?, partial_json = ?, updated_at = ? WHERE tenant_id = ? AND cycle_id = ?',
        next.phase, next.tokenIndex, next.endpointIndex, JSON.stringify(next.partial), next.updatedAt, this.tenantId, next.cycleId
      );
      const consumed = (current.partial.liveReviewRequests || []).find(item => item.chain === next.chain && item.address === candidate.address);
      if (consumed) {
        const record = this.storage.sql.exec('SELECT value_json FROM scheduler_state WHERE tenant_id = ? AND key = ?', this.tenantId, 'live.requestedReviews').toArray()[0];
        if (record) {
          const pending = parseJson(record.value_json, 'live review requests');
          const remaining = pending.filter(item => !(item.chain === consumed.chain && item.address === consumed.address && item.at === consumed.at && item.keyEpoch === consumed.keyEpoch));
          this.storage.sql.exec('UPDATE scheduler_state SET value_json = ? WHERE tenant_id = ? AND key = ?', JSON.stringify(remaining), this.tenantId, 'live.requestedReviews');
        }
      }
      const completion = this.afterClassification?.();
      if (completion && typeof completion.then === 'function') throw new TypeError('Classification hook must be synchronous');
      return Object.freeze({ checkpoint: { tenantId: this.tenantId, ...next }, effectId: event?.id || null });
    });
  }

  commitOutcomeProgress(value) {
    const next = checkpointInput(value.next);
    const expected = value.expected || {};
    const outcome = outcomeInput(value.outcome, this.tenantId, next.chain, { allowCrossChain: true });
    if (!outcome) throw new RecoverableScannerError('OUTCOME_INVALID', 'outcome progress requires an outcome');
    return this.storage.transactionSync(() => {
      const current = existingCheckpoint(this.storage, this.tenantId, next.cycleId);
      assertCurrent(this.storage, this.tenantId, current, { ...expected, phase: expected.phase ?? 'OUTCOMES_SAMPLE' });
      if (!checkpointEqual(current, next)) {
        throw new RecoverableScannerError('CYCLE_CHECKPOINT_IMMUTABLE_CONFLICT', 'cycle identity and epochs cannot change after creation');
      }
      const result = this.storage.sql.exec(
        'UPDATE outcomes SET latest_decision = ?, last_audited_at = ?, latest_failed_json = ?, samples_json = ?, sample_retries_json = ?, cohort_metadata_json = ? WHERE tenant_id = ? AND chain = ? AND address = ?',
        stringOrNull(outcome.latestDecision), integerOrNull(outcome.lastAuditedAt), JSON.stringify(outcome.latestFailed || []),
        JSON.stringify(outcome.samples || {}), JSON.stringify(outcome.sampleRetries || {}), JSON.stringify(outcome.cohortMetadata || {}),
        this.tenantId, outcome.chain, outcome.address
      );
      if (result.rowsWritten !== undefined && result.rowsWritten !== 1) {
        throw new RecoverableScannerError('OUTCOME_MISSING', 'outcome disappeared before its sample checkpoint could commit');
      }
      this.storage.sql.exec(
        'UPDATE cycle_checkpoint SET phase = ?, token_index = ?, endpoint_index = ?, partial_json = ?, updated_at = ? WHERE tenant_id = ? AND cycle_id = ?',
        next.phase, next.tokenIndex, next.endpointIndex, JSON.stringify(next.partial), next.updatedAt, this.tenantId, next.cycleId
      );
      return Object.freeze({ checkpoint: { tenantId: this.tenantId, ...next } });
    });
  }
}
