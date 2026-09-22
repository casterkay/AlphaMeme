import { createTaskDescriptor } from '../scheduler.mjs';

const ACTIVE = new Set(['PENDING', 'SENDING', 'UNKNOWN']);
const METHODS = new Set(['sendMessage', 'editMessageText', 'editMessageReplyMarkup', 'deleteMessage', 'answerCallbackQuery', 'sendDocument']);
const messageKey = (row, payload) => payload.params.message_id == null ? null : `${row.chat_id}:${payload.params.message_id}`;
const success = id => ({ status: 'success', checkpoint: `outbox:${id}`, complete: true });

/** Tenant-local durable delivery. Call enqueueInTransaction inside the business transaction. */
export class TelegramOutbox {
  constructor({ storage, tenantId, transport, now = Date.now, eligible = () => true, onConfirmedInTransaction = () => {} }) {
    this.storage = storage;
    this.tenantId = tenantId;
    this.transport = transport;
    this.now = now;
    this.eligible = eligible;
    this.onConfirmedInTransaction = onConfirmedInTransaction;
  }

  rows() { return this.storage.sql.exec('SELECT rowid AS sequence, * FROM outbox WHERE tenant_id = ? ORDER BY rowid', this.tenantId).toArray(); }

  enqueueInTransaction(value) {
    const { id, eventId = null, chatId, method, params, expiresAt, deliveryClass = 'USER_RESPONSE', actionReason = null, sessionId = null, sessionVersion = null, desiredRevision = null, token = null, purpose = 'panel', notification = null, projectionRevision = null, nextAt = this.now() } = value;
    if (!id || !chatId || !METHODS.has(method) || !params || !Number.isSafeInteger(expiresAt) || !['USER_RESPONSE', 'ACTION_REQUIRED', 'PANEL_UPDATE'].includes(deliveryClass)) throw new TypeError('Invalid outbox intent');
    if (sessionVersion !== null && (!Number.isSafeInteger(sessionVersion) || sessionVersion < 0)) throw new TypeError('Invalid session version');
    const payload = JSON.stringify({ method, params: { ...params, ...(method === 'answerCallbackQuery' ? {} : { chat_id: String(chatId) }) }, expiresAt, sessionVersion, token, purpose, notification, projectionRevision });
    this.storage.sql.exec('INSERT INTO outbox (tenant_id,id,event_id,chat_id,payload_json,desired_revision,delivery_class,action_reason,ui_session_id,status,attempts,next_at,ambiguous_retries) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING', this.tenantId, id, eventId, String(chatId), payload, desiredRevision, deliveryClass, actionReason, sessionId, 'PENDING', 0, nextAt, 0);
    return this.rows().find(row => row.id === id || (eventId !== null && row.event_id === eventId));
  }

  update(row, status, nextAt = null, code = null) {
    this.storage.sql.exec('UPDATE outbox SET status = ?, next_at = ? WHERE tenant_id = ? AND id = ?', status, nextAt, this.tenantId, row.id);
    if (code !== null) this.storage.sql.exec('INSERT INTO scheduler_state (tenant_id,key,value_json) VALUES (?,?,?) ON CONFLICT(tenant_id,key) DO UPDATE SET value_json=excluded.value_json', this.tenantId, `telegram.delivery:${row.id}`, JSON.stringify({ code, at: this.now() }));
  }

  payload(row) {
    const value = JSON.parse(row.payload_json);
    if (!METHODS.has(value?.method) || !value.params || !Number.isSafeInteger(value.expiresAt)) return null;
    return value;
  }

  valid(row, payload) {
    if (payload.expiresAt <= this.now()) return false;
    if (row.ui_session_id && payload.sessionVersion !== null) {
      const session = this.storage.sql.exec('SELECT * FROM ui_sessions WHERE tenant_id = ? AND id = ?', this.tenantId, row.ui_session_id).toArray()[0];
      if (!session || session.version !== payload.sessionVersion) return false;
    }
    if (payload.token && row.desired_revision) {
      const candidate = this.storage.sql.exec('SELECT review_revision FROM candidates WHERE tenant_id = ? AND chain = ? AND address = ?', this.tenantId, payload.token.chain, payload.token.address).toArray()[0];
      if (!candidate || candidate.review_revision !== row.desired_revision) return false;
    }
    const allowed = this.eligible(structuredClone(row), structuredClone(payload));
    if (typeof allowed !== 'boolean') throw new TypeError('Outbox eligibility must return a synchronous boolean');
    return allowed;
  }

  blocked(row, payload, rows) {
    const key = messageKey(row, payload);
    return key !== null && rows.some(other => {
      if (other.id === row.id) return false;
      const otherPayload = this.payload(other);
      return otherPayload && messageKey(other, otherPayload) === key && (other.status === 'SENDING' || other.status === 'UNKNOWN' || (other.sequence < row.sequence && other.status === 'PENDING'));
    });
  }

  reconcileInTransaction({ recoverSending = false } = {}) {
    if (recoverSending) for (const row of this.rows()) if (row.status === 'SENDING') this.update(row, 'UNKNOWN', this.now());
    for (const row of this.rows()) {
      if (!ACTIVE.has(row.status) || row.status === 'SENDING' || row.status === 'UNKNOWN') continue;
      const payload = this.payload(row);
      if (!payload) this.update(row, 'FAILED');
      else if (!this.valid(row, payload)) this.update(row, 'CANCELLED');
    }
    const rows = this.rows();
    return rows.filter(row => {
      const payload = this.payload(row);
      return payload && (row.status === 'PENDING' || (row.status === 'UNKNOWN' && row.ambiguous_retries < 1 && this.valid(row, payload))) && !this.blocked(row, payload, rows);
    }).map(row => createTaskDescriptor({ id: `outbox:${row.id}`, kind: 'outbox', dueAt: row.next_at ?? this.now(), enabled: true, needsGmgn: false, gmgnWeight: 1 }));
  }

  bind(row, payload, result) {
    if (payload.purpose !== 'panel') return;
    const messageId = result?.message_id ?? payload.params.message_id;
    if (messageId == null) return;
    if (row.ui_session_id) {
      this.storage.sql.exec('UPDATE ui_sessions SET message_id = ? WHERE tenant_id = ? AND id = ?', String(messageId), this.tenantId, row.ui_session_id);
      this.storage.sql.exec('UPDATE shortlinks SET origin_message_id = ? WHERE tenant_id = ? AND ui_session_id = ? AND origin_message_id IS NULL', String(messageId), this.tenantId, row.ui_session_id);
    }
    this.storage.sql.exec('DELETE FROM message_map WHERE tenant_id = ? AND chat_id = ? AND message_id = ?', this.tenantId, row.chat_id, String(messageId));
    if (payload.token && payload.method !== 'deleteMessage') this.storage.sql.exec('INSERT INTO message_map (tenant_id,chain,address,message_id,chat_id,rendered_revision,ui_session_id) VALUES (?,?,?,?,?,?,?)', this.tenantId, payload.token.chain, payload.token.address, String(messageId), row.chat_id, row.desired_revision, row.ui_session_id);
  }

  async deliverOne(id, { request }) {
    const claim = this.storage.transactionSync(() => {
      const rows = this.rows();
      const row = rows.find(item => item.id === id);
      if (!row || !['PENDING', 'UNKNOWN'].includes(row.status) || (row.next_at ?? 0) > this.now()) return null;
      const payload = this.payload(row);
      if (!payload) { this.update(row, 'FAILED'); return null; }
      if (row.status === 'UNKNOWN' && row.ambiguous_retries >= 1) return null;
      if (!this.valid(row, payload)) { if (row.status !== 'UNKNOWN') this.update(row, 'CANCELLED'); return null; }
      if (this.blocked(row, payload, rows)) return null;
      const ambiguous = row.ambiguous_retries + (row.status === 'UNKNOWN' ? 1 : 0);
      this.storage.sql.exec('UPDATE outbox SET status = ?, attempts = ?, ambiguous_retries = ?, next_at = NULL WHERE tenant_id = ? AND id = ?', 'SENDING', row.attempts + 1, ambiguous, this.tenantId, row.id);
      return { row: { ...row, attempts: row.attempts + 1, ambiguous_retries: ambiguous }, payload };
    });
    if (!claim) return success(id);
    const { row, payload } = claim;
    let result;
    try { result = await request(({ signal }) => this.transport({ method: payload.method, params: structuredClone(payload.params), signal })); }
    catch (error) {
      if (error?.code !== 'SCHEDULER_REQUEST_TIMEOUT' && !(error instanceof TypeError) && error?.name !== 'AbortError') throw error;
      result = { ok: false, kind: 'unknown' };
    }
    this.storage.transactionSync(() => {
      // A lease recovery can supersede a late network completion; it cannot prove delivery ordering.
      const current = this.rows().find(item => item.id === id);
      if (current?.status !== 'SENDING' || current.attempts !== row.attempts) return;
      if (result.ok || result.kind === 'not-modified') {
        this.bind(row, payload, result.result);
        if (payload.purpose !== 'prompt' || this.valid(row, payload)) {
          const completion = this.onConfirmedInTransaction({ row: structuredClone(row), payload: structuredClone(payload), result: structuredClone(result.result ?? null) });
          if (completion && typeof completion.then === 'function') throw new TypeError('Outbox confirmation hook must be synchronous');
        }
        this.update(row, 'SENT');
      }
      else if (result.kind === 'unknown') this.update(row, 'UNKNOWN', this.now() + 1000, 'DELIVERY_UNCERTAIN');
      else if (result.kind === 'retryable') {
        const nextAt = this.now() + Math.max(1000 * 2 ** (row.attempts - 1), result.retryAfterMs || 0);
        this.update(row, row.attempts < 5 && nextAt < payload.expiresAt ? 'PENDING' : 'FAILED', nextAt);
      } else {
        if (result.kind === 'deleted') this.storage.sql.exec('DELETE FROM message_map WHERE tenant_id = ? AND chat_id = ? AND message_id = ?', this.tenantId, row.chat_id, String(payload.params.message_id));
        this.update(row, 'FAILED', null, result.kind === 'deleted' ? 'MESSAGE_DELETED' : 'DELIVERY_REJECTED');
      }
    });
    return success(id);
  }

  issues() { return this.rows().filter(row => ['FAILED', 'UNKNOWN'].includes(row.status)).map(row => ({ status: row.status, deliveryClass: row.delivery_class, attempts: row.attempts, suspended: row.status === 'UNKNOWN' && row.ambiguous_retries >= 1, reason: JSON.parse(this.storage.sql.exec('SELECT value_json FROM scheduler_state WHERE tenant_id = ? AND key = ?', this.tenantId, `telegram.delivery:${row.id}`).toArray()[0]?.value_json || 'null')?.code ?? null })); }
}
