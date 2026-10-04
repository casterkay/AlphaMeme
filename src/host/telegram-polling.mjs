import { setTimeout as sleep } from 'node:timers/promises';
import { logEvent } from './log.mjs';

const POLL_TIMEOUT_SECONDS = 50;
const REQUEST_TIMEOUT_MS = 10_000;
const ALLOWED_UPDATES = Object.freeze(['message', 'edited_message', 'callback_query']);
const OFFSET_KEY = 'telegram.offset';

export class TelegramApiError extends Error {
  constructor(method, status) {
    super(`Telegram ${method} failed with ${status}`);
    this.name = 'TelegramApiError';
    this.code = `TELEGRAM_${status}`;
  }
}

/**
 * Telegram long polling. Updates are handled in order; `receive` resolves
 * once an update is done (stored or declined) and throws on a transient
 * failure, which stops the batch. The stored offset confirms everything
 * through the last consecutively done update, so a failed one is fetched again.
 */
export class TelegramPoller {
  #botToken;
  #entries;
  #receive;
  #retryPauseMs;
  #stop = new AbortController();
  #loop = null;

  constructor({ botToken, entries, receive, retryPauseMs = 5_000 }) {
    this.#botToken = botToken;
    this.#entries = entries;
    this.#receive = receive;
    this.#retryPauseMs = retryPauseMs;
  }

  start() {
    this.#loop = this.#run();
  }

  async stop() {
    this.#stop.abort();
    await this.#loop;
  }

  async #run() {
    let webhookDeleted = false;
    while (!this.#stop.signal.aborted) {
      try {
        // Telegram refuses getUpdates while a webhook is set.
        if (!webhookDeleted) {
          await this.#call('deleteWebhook', { drop_pending_updates: false });
          webhookDeleted = true;
        }
        const offset = this.#entries.get(OFFSET_KEY);
        const updates = await this.#call('getUpdates', { offset, timeout: POLL_TIMEOUT_SECONDS, allowed_updates: ALLOWED_UPDATES }, (POLL_TIMEOUT_SECONDS + 10) * 1000);
        if (!Array.isArray(updates) || !updates.every(update => Number.isSafeInteger(update?.update_id))) {
          throw new TelegramApiError('getUpdates', 'RESPONSE_INVALID');
        }
        for (const update of updates) {
          const outcome = await this.#receiveOne(update);
          this.#entries.put(OFFSET_KEY, update.update_id + 1);
          logEvent('telegram_update', { updateId: update.update_id, outcome });
        }
      } catch (error) {
        if (this.#stop.signal.aborted) break;
        logEvent('telegram_poll_failed', { error });
        await sleep(this.#retryPauseMs, undefined, { signal: this.#stop.signal }).catch(error => {
          if (error.name !== 'AbortError') throw error;
        });
      }
    }
  }

  async #receiveOne(update) {
    try {
      return await this.#receive(update);
    } catch (error) {
      logEvent('telegram_update_failed', { updateId: update.update_id, error });
      throw error;
    }
  }

  async #call(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    const response = await fetch(`https://api.telegram.org/bot${this.#botToken}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.any([this.#stop.signal, AbortSignal.timeout(timeoutMs)])
    });
    let body;
    try {
      body = await response.json();
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      body = null;
    }
    if (body?.ok !== true) throw new TelegramApiError(method, body?.error_code ?? response.status);
    return body.result;
  }
}
