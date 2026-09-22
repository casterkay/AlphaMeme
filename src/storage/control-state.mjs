import { normalizeTenantId } from './gmgn-admission-state.mjs';
import {
  readSchedulerStateInTransaction,
  writeSchedulerStateInTransaction
} from './scheduler-state.mjs';

const SUPPORTED_CHAIN_IDS = new Set(['sol', 'bsc', 'base', 'eth', 'robinhood', 'arc', 'stable']);

export class ControlStateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ControlStateError';
    this.code = code;
  }
}

function chain(value) {
  if (typeof value !== 'string' || !SUPPORTED_CHAIN_IDS.has(value)) {
    throw new ControlStateError('CONTROL_CHAIN_INVALID', 'control chain is not supported');
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
    live: Object.freeze({ ...state.runtime.live }),
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
      control: { ...state.runtime.control, ...changes.control },
      live: { ...state.runtime.live, ...changes.live }
    },
    gmgn: { ...state.gmgn, ...changes.gmgn },
    tasks: changes.tasks || state.tasks
  };
}

export function assertCheckpointGeneration(storage, tenant, checkpoint) {
  const tenantId = normalizeTenantId(tenant);
  const state = readSchedulerStateInTransaction(storage, tenantId);
  const current = snapshot(state);
  if (!current.configured) throw new ControlStateError('CYCLE_CONNECTION_UNCONFIGURED', 'GMGN connection is not configured');
  if (checkpoint.keyEpoch !== current.keyEpoch) throw new ControlStateError('CYCLE_KEY_EPOCH_STALE', 'GMGN credential epoch changed while work was in flight');
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
    gmgn: { keyEpoch: increment(state.gmgn.keyEpoch, 'key epoch') },
    live: {}
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
    gmgn: {},
    live: {}
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
      gmgn: {},
      live: { leaseUntil: 0 }
    }));
  }

  resume() {
    return this.#update(state => nextControl(state, {
      eligibility: { paused: false },
      control: { controlEpoch: increment(state.runtime.control.controlEpoch, 'control epoch') },
      gmgn: {},
      live: {}
    }));
  }

  resumeWith(afterResume) {
    if (typeof afterResume !== 'function') {
      throw new ControlStateError('CONTROL_RESUME_INVALID', 'resume transition requires a checkpoint revalidation callback');
    }
    return this.storage.transactionSync(() => {
      const state = readSchedulerStateInTransaction(this.storage, this.tenantId);
      const next = nextControl(state, {
        eligibility: { paused: false },
        control: { controlEpoch: increment(state.runtime.control.controlEpoch, 'control epoch') },
        gmgn: {},
        live: {}
      });
      const control = snapshot(next);
      const value = afterResume(control);
      write(this.storage, this.tenantId, next);
      return Object.freeze({ control, value });
    });
  }

  switchChain(value) {
    const activeChain = chain(value);
    return this.#update(state => state.runtime.control.activeChain === activeChain ? state : nextControl(state, {
        eligibility: {},
        control: {
          controlEpoch: increment(state.runtime.control.controlEpoch, 'control epoch'),
          activeChain
        },
        gmgn: {},
        live: {},
        tasks: state.tasks
    }), {
      rebindCheckpointChainsExcept: state => state.runtime.control.activeChain,
      enableScanChain: activeChain
    });
  }

  ensureActiveChain(value) {
    const activeChain = chain(value);
    return this.#update(state => state.runtime.control.activeChain === null
      ? nextControl(state, { eligibility: {}, control: { activeChain }, gmgn: {}, live: {} })
      : state);
  }

  disconnect() {
    return this.#update(state => nextControl(state, {
      eligibility: { paused: true, configured: false },
      control: {
        controlEpoch: increment(state.runtime.control.controlEpoch, 'control epoch'),
        connectionGeneration: increment(state.runtime.control.connectionGeneration, 'connection generation')
      },
      gmgn: { keyEpoch: increment(state.gmgn.keyEpoch, 'key epoch') },
      live: { subscribed: false, leaseUntil: 0 },
      tasks: state.tasks.filter(task => !['scan', 'live', 'credential'].includes(task.kind))
    }), { discardCheckpoints: true, deleteKeys: true, cancelCredentialInbox: true });
  }

  activateCredential(expected) {
    return this.storage.transactionSync(() => activateCredentialInTransaction(this.storage, this.tenantId, expected));
  }

  #update(mutator, effects = {}) {
    return this.storage.transactionSync(() => {
      const state = readSchedulerStateInTransaction(this.storage, this.tenantId);
      let next = mutator(state);
      if (effects.deleteKeys) {
        this.storage.sql.exec('DELETE FROM keys WHERE tenant_id = ?', this.tenantId);
      }
      if (effects.discardCheckpoints) {
        this.storage.sql.exec('DELETE FROM cycle_checkpoint WHERE tenant_id = ?', this.tenantId);
      }
      if (effects.cancelCredentialInbox) {
        this.storage.sql.exec(
          "UPDATE inbox SET status = 'CANCELLED', payload_enc = NULL, payload_json = NULL, next_at = NULL WHERE tenant_id = ? AND status IN ('RECEIVED', 'RUNNING') AND LOWER(command_type) IN ('setkey', 'credential_verify')",
          this.tenantId
        );
      }
      const chainChanged = state.runtime.control.activeChain !== next.runtime.control.activeChain;
      if (effects.rebindCheckpointChainsExcept && chainChanged) {
        const outgoingChain = effects.rebindCheckpointChainsExcept(state);
        if (outgoingChain !== null) {
          this.storage.sql.exec(
            'UPDATE cycle_checkpoint SET control_epoch = ? WHERE tenant_id = ? AND chain <> ?',
            next.runtime.control.controlEpoch, this.tenantId, outgoingChain
          );
        }
      }
      if (effects.enableScanChain && chainChanged) {
        const checkpointChains = new Map(this.storage.sql.exec(
          'SELECT cycle_id, chain FROM cycle_checkpoint WHERE tenant_id = ?', this.tenantId
        ).toArray().map(row => [row.cycle_id, row.chain]));
        next = {
          ...next,
          tasks: next.tasks.map(task => task.kind === 'scan'
            ? { ...task, enabled: checkpointChains.get(task.id.slice('scan:'.length)) === effects.enableScanChain }
            : task)
        };
      }
      write(this.storage, this.tenantId, next);
      return snapshot(next);
    });
  }
}
