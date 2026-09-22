const METHODS = new Set(['sendMessage', 'editMessageText', 'editMessageReplyMarkup', 'deleteMessage', 'answerCallbackQuery', 'sendDocument', 'setMyCommands']);

/** A redacted result: Telegram descriptions and request URLs never escape this boundary. */
export function createTelegramTransport({ botToken, fetchImpl = fetch, timeoutMs = 10_000 }) {
  if (typeof botToken !== 'string' || !botToken.trim()) throw new TypeError('Telegram bot token is required');
  return async ({ method, params, signal }) => {
    if (!METHODS.has(method)) throw new TypeError('Unsupported Telegram method');
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, method === 'sendDocument' ? 30_000 : timeoutMs);
    try {
      let body;
      let headers;
      if (method === 'sendDocument' && params.document && typeof params.document === 'object') {
        body = new FormData();
        for (const [key, value] of Object.entries(params)) {
          if (key === 'document') body.append(key, new Blob([value.content], { type: 'application/json' }), value.filename || 'radar.json');
          else body.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
        }
      } else {
        headers = { 'content-type': 'application/json' };
        body = JSON.stringify(params);
      }
      const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/${method}`, { method: 'POST', headers, body, signal: controller.signal });
      let value;
      try { value = await response.json(); } catch (error) {
        if (error instanceof SyntaxError || error instanceof TypeError || error?.name === 'AbortError') return { ok: false, kind: 'unknown', code: 'TELEGRAM_RESPONSE_UNREADABLE' };
        throw error;
      }
      if (response.ok && value?.ok === true) return { ok: true, result: value.result };
      const code = Number(value?.error_code || response.status);
      if (code === 400 && /message is not modified/i.test(value?.description || '')) return { ok: false, kind: 'not-modified', code: 'TELEGRAM_NOT_MODIFIED' };
      if (code === 400 && /message to (?:edit|delete) not found/i.test(value?.description || '')) return { ok: false, kind: 'deleted', code: 'TELEGRAM_MESSAGE_DELETED' };
      if (code === 429) return { ok: false, kind: 'retryable', code: 'TELEGRAM_RATE_LIMITED', retryAfterMs: Math.max(0, Number(value?.parameters?.retry_after) || 0) * 1000 };
      if (code >= 500) return { ok: false, kind: 'unknown', code: 'TELEGRAM_SERVER_UNCERTAIN' };
      return { ok: false, kind: 'permanent', code: 'TELEGRAM_REJECTED' };
    } catch (error) {
      if (error instanceof TypeError || error?.name === 'AbortError' || controller.signal.aborted) return { ok: false, kind: 'unknown', code: 'TELEGRAM_TRANSPORT_UNCERTAIN' };
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  };
}
