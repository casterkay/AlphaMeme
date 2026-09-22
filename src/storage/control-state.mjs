import { normalizeTenantId } from './gmgn-admission-state.mjs';
import {
  readSchedulerStateInTransaction,
  writeSchedulerStateInTransaction
} from './scheduler-state.mjs';

export class ControlStateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ControlStateError';
    this.code = code;
  }
}

function chain(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(value)) {
    throw new ControlStateError('CONTROL_CHAIN_INVALID', 'control chain must be a normalized identifier');
  }
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
    keyEpoch: state.gmgn.keyEpoch
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
    gmgn: { ...state.gmgn, ...changes.gmgn },
    tasks: changes.tasks || state.tasks
  };
}

export function assertCheckpointGeneration(storage, tenant, checkpoint) {
  const tenantId = normalizeTenantId(tenant);
  const state = readSchedulerStateInTransaction(storage, tenantId);
  const current = snapshot(state);
  if (!current.configured && current.keyEpoch === 0 && current.controlEpoch === 0
    && current.connectionGeneration === 0 && current.activeChain === null
    && checkpoint.keyEpoch === 0 && checkpoint.controlEpoch === 0) {
    // This is the pre-control bootstrap record used by M2's isolated scanner
    // fixtures. Production scan tasks remain ineligible until configured.
    return current;
  }
  if (!current.configured) throw new ControlStateError('CYCLE_CONNECTION_UNCONFIGURED', 'GMGN connection is not configured');
  if (checkpoint.keyEpoch !== current.keyEpoch) throw new ControlStateError('CYCLE_KEY_EPOCH_STALE', 'GMGN credential epoch changed while work was in flight');
  if (checkpoint.controlEpoch !== current.controlEpoch) throw new ControlStateError('CYCLE_CONTROL_EPOCH_STALE', 'control epoch changed while work was in flight');
  return current;
}

export function activateCredentialInTransaction(storage, tenant, expected) {
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
    gmgn: { keyEpoch: increment(state.gmgn.keyEpoch, 'key epoch') }
  });
  write(storage, tenantId, next);
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
    gmgn: {}
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
      control: { controlEpoch: increment(state.runtime.control.controlEpoch, 'control epoch') },
      gmgn: {}
    }));
  }

  resume() {
    return this.#update(state => nextControl(state, {
      eligibility: { paused: false },
      control: { controlEpoch: increment(state.runtime.control.controlEpoch, 'control epoch') },
      gmgn: {}
    }));
  }

  switchChain(value) {
    const activeChain = chain(value);
    return this.#update(state => nextControl(state, {
      eligibility: {},
      control: {
        controlEpoch: increment(state.runtime.control.controlEpoch, 'control epoch'),
        activeChain
      },
      gmgn: {},
      tasks: state.tasks
    }));
  }

  disconnect() {
    return this.#update(state => nextControl(state, {
      eligibility: { paused: true, configured: false },
      control: {
        controlEpoch: increment(state.runtime.control.controlEpoch, 'control epoch'),
        connectionGeneration: increment(state.runtime.control.connectionGeneration, 'connection generation')
      },
      gmgn: { keyEpoch: increment(state.gmgn.keyEpoch, 'key epoch') },
      tasks: state.tasks.filter(task => !task.needsGmgn)
    }), { discardCheckpoints: true, deleteKeys: true });
  }

  activateCredential(expected) {
    return this.storage.transactionSync(() => activateCredentialInTransaction(this.storage, this.tenantId, expected));
  }

  #update(mutator, effects = {}) {
    return this.storage.transactionSync(() => {
      const state = readSchedulerStateInTransaction(this.storage, this.tenantId);
      const next = mutator(state);
      if (effects.deleteKeys) {
        this.storage.sql.exec('DELETE FROM keys WHERE tenant_id = ?', this.tenantId);
      }
      if (effects.discardCheckpoints) {
        this.storage.sql.exec('DELETE FROM cycle_checkpoint WHERE tenant_id = ?', this.tenantId);
      }
      write(this.storage, this.tenantId, next);
      return snapshot(next);
    });
  }
}
