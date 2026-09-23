import { createTaskDescriptor } from '../scheduler.mjs';

const ACTIVE = new Set(['PENDING', 'SENDING', 'UNKNOWN']);
const METHODS = new Set(['sendMessage', 'editMessageText', 'editMessageReplyMarkup', 'deleteMessage', 'answerCallbackQuery', 'sendDocument']);
const TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60_000;
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
  ids() { return this.storage.sql.exec('SELECT id FROM outbox WHERE tenant_id = ?', this.tenantId).toArray(); }
  has(id) { return this.storage.sql.exec('SELECT id FROM outbox WHERE tenant_id = ? AND id = ? LIMIT 1', this.tenantId, id).toArray().length === 1; }
  activeRows() { return this.storage.sql.exec("SELECT rowid AS sequence, * FROM outbox WHERE tenant_id = ? AND status IN ('PENDING','SENDING','UNKNOWN') ORDER BY rowid", this.tenantId).toArray(); }
  issueRows() { return this.storage.sql.exec("SELECT rowid AS sequence, * FROM outbox WHERE tenant_id = ? AND status IN ('FAILED','UNKNOWN') ORDER BY rowid", this.tenantId).toArray(); }
  requestedRows() { return this.storage.sql.exec("SELECT rowid AS sequence, * FROM outbox WHERE tenant_id = ? AND delivery_class = 'USER_RESPONSE' AND status IN ('PENDING','CANCELLED') ORDER BY rowid", this.tenantId).toArray(); }
  correctionRows(sessionId) { return this.storage.sql.exec("SELECT rowid AS sequence, * FROM outbox WHERE tenant_id = ? AND ui_session_id = ? AND status IN ('PENDING','SENDING','UNKNOWN','FAILED') ORDER BY rowid", this.tenantId, sessionId).toArray(); }

  enqueueInTransaction(value) {
    const { id, eventId = null, chatId, method, params, expiresAt, deliveryClass = 'USER_RESPONSE', actionReason = null, sessionId = null, sessionVersion = null, desiredRevision = null, token = null, purpose = 'panel', notification = null, projectionRevision = null, nextAt = this.now() } = value;
    if (!id || !chatId || !METHODS.has(method) || !params || !Number.isSafeInteger(expiresAt) || !['USER_RESPONSE', 'ACTION_REQUIRED', 'PANEL_UPDATE'].includes(deliveryClass)) throw new TypeError('Invalid outbox intent');
    if (sessionVersion !== null && (!Number.isSafeInteger(sessionVersion) || sessionVersion < 0)) throw new TypeError('Invalid session version');
    const payload = JSON.stringify({ method, params: { ...params, ...(method === 'answerCallbackQuery' ? {} : { chat_id: String(chatId) }) }, expiresAt, sessionVersion, token, purpose, notification, projectionRevision });
    this.storage.sql.exec('INSERT INTO outbox (tenant_id,id,event_id,chat_id,payload_json,desired_revision,delivery_class,action_reason,ui_session_id,status,attempts,next_at,ambiguous_retries) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING', this.tenantId, id, eventId, String(chatId), payload, desiredRevision, deliveryClass, actionReason, sessionId, 'PENDING', 0, nextAt, 0);
    return this.storage.sql.exec('SELECT rowid AS sequence, * FROM outbox WHERE tenant_id = ? AND (id = ? OR (? IS NOT NULL AND event_id = ?)) LIMIT 1', this.tenantId, id, eventId, eventId).toArray()[0];
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

  terminalAt(payload) { return Math.max(this.now(), payload.expiresAt) + TERMINAL_RETENTION_MS; }

  cancel(row, payload) { this.update(row, 'CANCELLED', this.terminalAt(payload)); }

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

  entries(rows) { return rows.map(row => ({ row, payload: this.payload(row) })); }

  blockingIndex(entries) {
    const index = new Map();
    for (const entry of entries) {
      if (!entry.payload) continue;
      const key = messageKey(entry.row, entry.payload);
      if (key === null) continue;
      const value = index.get(key) || { hard: new Set(), earliestPending: Infinity };
      if (entry.row.status === 'SENDING' || entry.row.status === 'UNKNOWN') value.hard.add(entry.row.id);
      if (entry.row.status === 'PENDING') value.earliestPending = Math.min(value.earliestPending, entry.row.sequence);
      index.set(key, value);
    }
    return index;
  }

  blocked(entry, index) {
    const key = entry.payload && messageKey(entry.row, entry.payload);
    if (key === null) return false;
    const value = index.get(key);
    return Boolean(value && (value.hard.size > (value.hard.has(entry.row.id) ? 1 : 0) || value.earliestPending < entry.row.sequence));
  }

  pruneInTransaction() {
    this.storage.sql.exec("DELETE FROM outbox WHERE tenant_id = ? AND status IN ('SENT','CANCELLED') AND next_at IS NOT NULL AND next_at <= ?", this.tenantId, this.now());
  }

  acknowledgeIssuesInTransaction() {
    let acknowledged = 0;
    for (const row of this.issueRows()) {
      const payload = this.payload(row);
      if (payload?.params.message_id != null) {
        const messageId = String(payload.params.message_id);
        this.storage.sql.exec('DELETE FROM message_map WHERE tenant_id = ? AND chat_id = ? AND message_id = ?', this.tenantId, row.chat_id, messageId);
        this.storage.sql.exec('DELETE FROM scheduler_state WHERE tenant_id = ? AND key = ?', this.tenantId, `telegram.rendered:${messageId}`);
      }
      if (payload) this.cancel(row, payload);
      else this.update(row, 'CANCELLED', this.now() + TERMINAL_RETENTION_MS);
      this.storage.sql.exec('DELETE FROM scheduler_state WHERE tenant_id = ? AND key = ?', this.tenantId, `telegram.delivery:${row.id}`);
      acknowledged += 1;
    }
    return acknowledged;
  }

  cancelPendingActionRequiredInTransaction() {
    for (const row of this.activeRows()) {
      if (row.status !== 'PENDING' || row.delivery_class !== 'ACTION_REQUIRED') continue;
      const payload = this.payload(row);
      if (payload) this.cancel(row, payload); else this.update(row, 'FAILED');
    }
  }

  reconcileInTransaction({ recoverSending = false } = {}) {
    this.pruneInTransaction();
    if (recoverSending) for (const row of this.activeRows()) if (row.status === 'SENDING') this.update(row, 'UNKNOWN', this.now());
    for (const row of this.activeRows()) {
      if (!ACTIVE.has(row.status) || row.status === 'SENDING' || row.status === 'UNKNOWN') continue;
      const payload = this.payload(row);
      if (!payload) this.update(row, 'FAILED');
      else if (!this.valid(row, payload)) this.cancel(row, payload);
    }
    const entries = this.entries(this.activeRows());
    const blocking = this.blockingIndex(entries);
    return entries.filter(entry => entry.payload
      && (entry.row.status === 'PENDING' || (entry.row.status === 'UNKNOWN' && entry.row.ambiguous_retries < 1 && this.valid(entry.row, entry.payload)))
      && !this.blocked(entry, blocking))
      .map(({ row }) => createTaskDescriptor({ id: `outbox:${row.id}`, kind: 'outbox', dueAt: row.next_at ?? this.now(), enabled: true, needsGmgn: false, gmgnWeight: 1 }));
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
      const entries = this.entries(this.activeRows());
      const entry = entries.find(item => item.row.id === id);
      const row = entry?.row;
      if (!row || !['PENDING', 'UNKNOWN'].includes(row.status) || (row.next_at ?? 0) > this.now()) return null;
      const payload = entry.payload;
      if (!payload) { this.update(row, 'FAILED'); return null; }
      if (row.status === 'UNKNOWN' && row.ambiguous_retries >= 1) return null;
      if (!this.valid(row, payload)) { if (row.status !== 'UNKNOWN') this.cancel(row, payload); return null; }
      if (this.blocked(entry, this.blockingIndex(entries))) return null;
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
      const current = this.storage.sql.exec('SELECT * FROM outbox WHERE tenant_id = ? AND id = ?', this.tenantId, id).toArray()[0];
      if (current?.status !== 'SENDING' || current.attempts !== row.attempts) return;
      if (result.ok || result.kind === 'not-modified') {
        this.bind(row, payload, result.result);
        if (payload.purpose !== 'prompt' || this.valid(row, payload)) {
          const completion = this.onConfirmedInTransaction({ row: structuredClone(row), payload: structuredClone(payload), result: structuredClone(result.result ?? null) });
          if (completion && typeof completion.then === 'function') throw new TypeError('Outbox confirmation hook must be synchronous');
        }
        this.update(row, 'SENT', this.terminalAt(payload));
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

  issues() {
    const diagnostics = new Map(this.storage.sql.exec("SELECT key,value_json FROM scheduler_state WHERE tenant_id = ? AND key LIKE 'telegram.delivery:%'", this.tenantId).toArray().map(row => [row.key, JSON.parse(row.value_json)]));
    return this.issueRows().map(row => ({ status: row.status, deliveryClass: row.delivery_class, attempts: row.attempts, suspended: row.status === 'UNKNOWN' && row.ambiguous_retries >= 1, reason: diagnostics.get(`telegram.delivery:${row.id}`)?.code ?? null }));
  }
}
