import { logEvent } from './log.mjs';

export const ALARM_RETRY_LIMIT = 6;
export const ALARM_RETRY_BASE_MS = 2_000;
// setTimeout fires at once for longer delays; a far alarm re-arms when this one wakes.
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * One Durable Object alarm: the time persists in `entries` under `key`, so a restart
 * re-arms it and fires a past-due alarm at once. The handler never overlaps
 * itself; an alarm set while it runs is armed after it finishes. A failed run
 * is retried 2 s, 4 s, … 64 s later, then dropped, as on Cloudflare.
 */
export class AlarmRunner {
  #entries;
  #key;
  #handler;
  #timer = null;
  #running = null;
  #active = false;
  #generation = 0;
  #failures = 0;

  constructor({ entries, key, handler }) {
    this.#entries = entries;
    this.#key = key;
    this.#handler = handler;
  }

  getAlarm() {
    return this.#entries.get(this.#key) ?? null;
  }

  setAlarm(at) {
    if (!Number.isSafeInteger(at)) throw new TypeError('alarm time must be an integer timestamp');
    this.#entries.put(this.#key, at);
    this.#generation += 1;
    this.#arm();
  }

  deleteAlarm() {
    this.#entries.delete(this.#key);
    this.#generation += 1;
    this.#arm();
  }

  start() {
    this.#active = true;
    this.#arm();
  }

  /** Stops arming and settles once a running handler has finished. */
  async stop() {
    this.#active = false;
    clearTimeout(this.#timer);
    await this.#running;
  }

  #arm() {
    clearTimeout(this.#timer);
    this.#timer = null;
    const at = this.getAlarm();
    if (!this.#active || this.#running || at === null) return;
    this.#timer = setTimeout(() => this.#fire(), Math.min(Math.max(at - Date.now(), 0), MAX_TIMER_MS));
  }

  #fire() {
    this.#timer = null;
    const at = this.getAlarm();
    if (at === null) return;
    if (at > Date.now()) {
      this.#arm();
      return;
    }
    // Recorded before the handler starts, so an alarm the handler sets waits for this run.
    this.#running = Promise.resolve().then(() => this.#run()).finally(() => {
      this.#running = null;
      this.#arm();
    });
  }

  async #run() {
    const generation = this.#generation;
    try {
      await this.#handler();
      this.#failures = 0;
      if (generation === this.#generation) this.#entries.delete(this.#key);
    } catch (error) {
      this.#failures += 1;
      if (this.#failures > ALARM_RETRY_LIMIT) {
        logEvent('alarm_dropped', { failures: this.#failures, error });
        this.#failures = 0;
        if (generation === this.#generation) this.#entries.delete(this.#key);
        return;
      }
      const retryAt = Date.now() + ALARM_RETRY_BASE_MS * 2 ** (this.#failures - 1);
      // An alarm the failed run set itself may come sooner than the retry.
      const current = generation === this.#generation ? null : this.getAlarm();
      this.#entries.put(this.#key, current === null ? retryAt : Math.min(current, retryAt));
      logEvent('alarm_failed', { failures: this.#failures, retryAt, error });
    }
  }
}
