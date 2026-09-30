import { activateAveKey, releaseAveKey } from '../ave-admission.mjs';
import { isScanChain } from '../chains.mjs';
import { CONNECTION_KEY_NAMES } from '../auth/connection.mjs';
import {
  readSchedulerStateInTransaction,
  writeSchedulerStateInTransaction
} from './scheduler-state.mjs';
import { normalizeTenantId } from './tenant-id.mjs';

export class ControlStateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ControlStateError';
    this.code = code;
  }
}

function chain(value) {
  if (!isScanChain(value)) throw new ControlStateError('CONTROL_CHAIN_INVALID', 'control chain is not supported');
  return value;
}

function increment(value, name) {
  if (!Number.isSafeInteger(value) || value < 0 || value === Number.MAX_SAFE_INTEGER) {
    throw new ControlStateError('CONTROL_EPOCH_INVALID', `${name} cannot advance`);
  }
  return value + 1;
}

function snapshot(state) {
  return Object.freeze({
    paused: state.runtime.eligibility.paused,
    configured: state.runtime.eligibility.configured,
    controlEpoch: state.runtime.control.controlEpoch,
    connectionGeneration: state.runtime.control.connectionGeneration,
    activeChain: state.runtime.control.activeChain,
    keyEpoch: state.ave.keyEpoch
  });
}

function write(storage, tenantId, state) {
  return writeSchedulerStateInTransaction(storage, tenantId, state);
}

function nextControl(state, changes) {
  return {
    ...state,
    runtime: {
      ...state.runtime,
      eligibility: { ...state.runtime.eligibility, ...changes.eligibility },
      control: { ...state.runtime.control, ...changes.control }
    },
    ave: changes.ave || state.ave,
    tasks: changes.tasks || state.tasks
  };
}

export function assertCheckpointGeneration(storage, tenant, checkpoint) {
  const tenantId = normalizeTenantId(tenant);
  const state = readSchedulerStateInTransaction(storage, tenantId);
  const current = snapshot(state);
  if (!current.configured) throw new ControlStateError('CYCLE_CONNECTION_UNCONFIGURED', 'AVE connection is not configured');
  if (checkpoint.keyEpoch !== current.keyEpoch) throw new ControlStateError('CYCLE_KEY_EPOCH_STALE', 'AVE credential epoch changed while work was in flight');
  if (checkpoint.controlEpoch !== current.controlEpoch) throw new ControlStateError('CYCLE_CONTROL_EPOCH_STALE', 'control epoch changed while work was in flight');
  return current;
}

export function activateCredentialInTransaction(storage, tenant, expected, afterActivate) {
  const tenantId = normalizeTenantId(tenant);
  if (!expected || !Number.isSafeInteger(expected.connectionGeneration) || expected.connectionGeneration < 0) {
    throw new ControlStateError('CONNECTION_GENERATION_INVALID', 'credential activation generation is invalid');
  }
  const state = readSchedulerStateInTransaction(storage, tenantId);
  if (state.runtime.control.connectionGeneration !== expected.connectionGeneration) {
    throw new ControlStateError('CONNECTION_GENERATION_STALE', 'connection changed while credential verification was in flight');
  }
  const next = nextControl(state, {
    eligibility: { configured: true },
    control: {
      connectionGeneration: increment(state.runtime.control.connectionGeneration, 'connection generation')
    },
    ave: activateAveKey(state.ave)
  });
  write(storage, tenantId, next);
  if (afterActivate !== undefined) {
    if (typeof afterActivate !== 'function') throw new ControlStateError('CONNECTION_ACTIVATION_INVALID', 'credential activation hook is invalid');
    afterActivate(snapshot(next));
  }
  return snapshot(next);
}

export function beginCredentialVerificationInTransaction(storage, tenant, expectedConnectionGeneration) {
  const tenantId = normalizeTenantId(tenant);
  const state = readSchedulerStateInTransaction(storage, tenantId);
  if (!Number.isSafeInteger(expectedConnectionGeneration) || expectedConnectionGeneration < 0) {
    throw new ControlStateError('CONNECTION_GENERATION_INVALID', 'credential verification generation is invalid');
  }
  if (state.runtime.control.connectionGeneration !== expectedConnectionGeneration) {
    throw new ControlStateError('CONNECTION_GENERATION_STALE', 'connection changed while credential encryption was in flight');
  }
  const next = nextControl(state, {
    eligibility: {},
    control: {
      connectionGeneration: increment(state.runtime.control.connectionGeneration, 'connection generation')
    },
  });
  write(storage, tenantId, next);
  return snapshot(next);
}

export class SqliteControlStateStore {
  constructor(storage, tenant) {
    if (!storage?.sql || typeof storage.transactionSync !== 'function') {
      throw new ControlStateError('CONTROL_STORAGE_INVALID', 'control state requires Durable Object SQLite storage');
    }
    this.storage = storage;
    this.tenantId = normalizeTenantId(tenant);
  }

  snapshot() {
    return snapshot(readSchedulerStateInTransaction(this.storage, this.tenantId));
  }

  pause() {
    return this.#update(state => nextControl(state, {
      eligibility: { paused: true },
      control: { controlEpoch: increment(state.runtime.control.controlEpoch, 'control epoch') }
    }));
  }

  resumeWith(afterResume, whenActive) {
    if (typeof afterResume !== 'function' || typeof whenActive !== 'function') {
      throw new ControlStateError('CONTROL_RESUME_INVALID', 'resume transition requires checkpoint callbacks');
    }
    return this.storage.transactionSync(() => {
      const state = readSchedulerStateInTransaction(this.storage, this.tenantId);
      if (!state.runtime.eligibility.paused) {
        return Object.freeze({ control: snapshot(state), value: whenActive() });
      }
      const next = nextControl(state, {
        eligibility: { paused: false },
        control: { controlEpoch: increment(state.runtime.control.controlEpoch, 'control epoch') }
      });
      const control = snapshot(next);
      const value = afterResume(control);
      write(this.storage, this.tenantId, next);
      return Object.freeze({ control, value });
    });
  }

  /**
   * Scan one chain. Other chains' cycles are discarded (their research records
   * stay); the caller starts the selected chain's cycle in the same transaction.
   */
  selectScanChainInTransaction(value) {
    const activeChain = chain(value);
    const state = readSchedulerStateInTransaction(this.storage, this.tenantId);
    const checkpointChains = new Map(this.storage.sql.exec(
      'SELECT cycle_id, chain FROM cycle_checkpoint WHERE tenant_id = ?', this.tenantId
    ).toArray().map(row => [row.cycle_id, row.chain]));
    const otherCycle = task => task.kind === 'scan' && checkpointChains.get(task.id.slice('scan:'.length)) !== activeChain;
    if (state.runtime.control.activeChain === activeChain && !state.tasks.some(otherCycle)) return snapshot(state);
    for (const [cycleId, chainName] of checkpointChains) {
      if (chainName !== activeChain) this.storage.sql.exec('DELETE FROM cycle_checkpoint WHERE tenant_id = ? AND cycle_id = ?', this.tenantId, cycleId);
    }
    const next = nextControl(state, {
      eligibility: {},
      control: { activeChain, controlEpoch: increment(state.runtime.control.controlEpoch, 'control epoch') },
      tasks: state.tasks.filter(task => !otherCycle(task))
    });
    write(this.storage, this.tenantId, next);
    return snapshot(next);
  }

  selectScanChain(value) {
    return this.storage.transactionSync(() => this.selectScanChainInTransaction(value));
  }

  disconnect() {
    return this.#update(state => nextControl(state, {
      eligibility: { paused: true, configured: false },
      control: {
        controlEpoch: increment(state.runtime.control.controlEpoch, 'control epoch'),
        connectionGeneration: increment(state.runtime.control.connectionGeneration, 'connection generation')
      },
      ave: { ...releaseAveKey(state.ave), keyEpoch: increment(state.ave.keyEpoch, 'key epoch') },
      tasks: state.tasks.filter(task => !['scan', 'credential'].includes(task.kind))
    }), { discardCheckpoints: true, deleteKeys: true, cancelCredentialInbox: true });
  }

  #update(mutator, effects = {}) {
    return this.storage.transactionSync(() => {
      const state = readSchedulerStateInTransaction(this.storage, this.tenantId);
      const next = mutator(state);
      if (effects.deleteKeys) {
        // Disconnecting AVE deletes only AVE keys; the trading wallet is removed only under /wallet.
        this.storage.sql.exec('DELETE FROM keys WHERE tenant_id = ? AND name IN (?, ?)', this.tenantId, CONNECTION_KEY_NAMES.ACTIVE_KEY_NAME, CONNECTION_KEY_NAMES.PENDING_KEY_NAME);
      }
      if (effects.discardCheckpoints) {
        this.storage.sql.exec('DELETE FROM cycle_checkpoint WHERE tenant_id = ?', this.tenantId);
      }
      if (effects.cancelCredentialInbox) {
        this.storage.sql.exec(
          "UPDATE inbox SET status = 'CANCELLED', payload_enc = NULL, payload_json = NULL, next_at = NULL WHERE tenant_id = ? AND status IN ('RECEIVED', 'RUNNING') AND command_type IN ('credential', 'command:setkey')",
          this.tenantId
        );
      }
      write(this.storage, this.tenantId, next);
      return snapshot(next);
    });
  }
}
