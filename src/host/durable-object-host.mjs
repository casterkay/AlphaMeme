import { DatabaseSync } from 'node:sqlite';
import { SqliteStorage } from './sqlite-storage.mjs';

// A single-process stand-in for Cloudflare Durable Objects. Each instance is one SQLite
// file plus a serialized input gate: fetch/alarm/RPC calls run one at a time per instance
// so they cannot interleave at await points, matching the DO input-gate guarantee.
export class DurableObjectHost {
  #entries;

  constructor({ storageDirectory }) {
    this.storageDirectory = storageDirectory;
    this.env = null;
    this.#entries = new Map();
  }

  setEnvironment(env) {
    this.env = env;
  }

  namespace(DurableObjectClass) {
    return Object.freeze({
      idFromName: name => String(name),
      get: id => this.#stub(DurableObjectClass, String(id)),
      getByName: name => this.#stub(DurableObjectClass, String(name))
    });
  }

  #stub(cls, name) {
    return new Proxy({}, {
      get: (_target, property) => {
        if (property === 'then' || typeof property !== 'string') return undefined;
        return (...args) => this.#call(cls, name, property, args);
      }
    });
  }

  #entry(cls, name) {
    let entry = this.#entries.get(name);
    if (!entry) {
      const database = new DatabaseSync(`${this.storageDirectory}/${name.replace(/[^a-zA-Z0-9._-]/g, '_')}.sqlite`);
      const alarms = {
        setAlarm: at => this.#setAlarm(name, at),
        deleteAlarm: () => this.#deleteAlarm(name)
      };
      const storage = new SqliteStorage({ database, alarms });
      const context = {
        storage,
        blockConcurrencyWhile: callback => {
          const promise = callback();
          entry.blocking.push(promise);
          return promise;
        },
        waitUntil: promise => { promise.catch(error => this.#logError(name, 'waitUntil', error)); }
      };
      entry = { cls, name, context, instance: null, blocking: [], queue: Promise.resolve(), alarmTimer: null, alarmAt: null };
      this.#entries.set(name, entry);
    }
    return entry;
  }

  async #call(cls, name, method, args) {
    const entry = this.#entry(cls, name);
    const run = entry.queue.then(async () => {
      if (!entry.instance) {
        entry.instance = new cls(entry.context, this.env);
        await Promise.all(entry.blocking);
      }
      if (typeof entry.instance[method] !== 'function') {
        throw new Error(`Durable Object ${name} has no method ${method}`);
      }
      return entry.instance[method](...args);
    });
    entry.queue = run.catch(() => {});
    return run;
  }

  #setAlarm(name, at) {
    const entry = this.#entries.get(name);
    if (!entry) return;
    this.#deleteAlarm(name);
    entry.alarmAt = at;
    const delay = Math.max(0, at - Date.now());
    entry.alarmTimer = setTimeout(() => {
      entry.alarmTimer = null;
      entry.alarmAt = null;
      this.#call(entry.cls, name, 'alarm', []).catch(error => this.#logError(name, 'alarm', error));
    }, delay);
    entry.alarmTimer.unref?.();
  }

  #deleteAlarm(name) {
    const entry = this.#entries.get(name);
    if (!entry) return;
    if (entry.alarmTimer) {
      clearTimeout(entry.alarmTimer);
      entry.alarmTimer = null;
    }
    entry.alarmAt = null;
  }

  #logError(name, stage, error) {
    console.error(JSON.stringify({ event: 'durable_object_host_error', instance: name, stage, errorType: error?.name || 'unknown', message: String(error?.message || error) }));
  }
}
