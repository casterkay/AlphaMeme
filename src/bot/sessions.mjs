import { readReview, annotationVersion, ReviewConflict } from './review.mjs';

const SESSION_TTL = 15 * 60_000;
// An alert keeps its buttons as long as its token is kept after alerting.
export const ALERT_SESSION_TTL = 7 * 24 * 60 * 60_000;
// Sessions of sent notifications: a new-lead alert (edited in place) and a one-off notice.
export const NOTIFICATION_PANELS = new Set(['alert', 'notice']);
const id = () => crypto.randomUUID().replaceAll('-', '');

/** Sessions contain navigation intent only; every render rereads domain facts. */
export class TelegramSessions {
  constructor({ storage, tenantId, now = Date.now }) { this.storage = storage; this.tenantId = tenantId; this.now = now; }

  get(sessionId) {
    const row = this.storage.sql.exec('SELECT * FROM ui_sessions WHERE tenant_id = ? AND id = ?', this.tenantId, sessionId).toArray()[0];
    return row ? { id: row.id, ownerUserId: row.owner_user_id, chatId: row.chat_id, messageId: row.message_id, panel: row.panel, viewChain: row.view_chain, query: JSON.parse(row.query_json), snapshotAt: row.snapshot_at, version: row.version, expiresAt: row.expires_at } : null;
  }

  createInTransaction(panel, viewChain, query = {}, { ttl = SESSION_TTL } = {}) {
    const session = { id: id(), ownerUserId: this.tenantId, chatId: this.tenantId, messageId: null, panel, viewChain, query: { schemaVersion: 1, page: 0, ...query, ...(panel === 'alert' ? { originAlertToken: query.selectedToken } : {}) }, snapshotAt: this.now(), version: 0, expiresAt: this.now() + ttl };
    this.saveInTransaction(session);
    return session;
  }

  saveInTransaction(session) {
    if (session.ownerUserId !== this.tenantId || session.chatId !== this.tenantId) throw new ReviewConflict('session_owner_mismatch');
    this.storage.sql.exec('INSERT INTO ui_sessions (tenant_id,id,owner_user_id,chat_id,message_id,panel,view_chain,query_json,snapshot_at,version,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,id) DO UPDATE SET message_id=excluded.message_id,panel=excluded.panel,view_chain=excluded.view_chain,query_json=excluded.query_json,snapshot_at=excluded.snapshot_at,version=excluded.version,expires_at=excluded.expires_at', this.tenantId, session.id, session.ownerUserId, session.chatId, session.messageId, session.panel, session.viewChain, JSON.stringify(session.query), session.snapshotAt, session.version, session.expiresAt);
  }

  advanceInTransaction(session, changes = {}) {
    const current = this.get(session.id);
    if (!current || current.version !== session.version) throw new ReviewConflict('session_changed');

    // The original alert identity survives Home and other navigation changes.
    const originAlertToken = current.query.originAlertToken ?? (current.panel === 'alert' ? current.query.selectedToken : null);
    const query = { ...(changes.query ?? current.query), ...(originAlertToken ? { originAlertToken } : {}) };
    const next = { ...current, ...changes, query, version: current.version + 1, snapshotAt: this.now(), expiresAt: Math.max(current.expiresAt, this.now() + SESSION_TTL) };
    this.saveInTransaction(next);
    return next;
  }

  bindKeyboardInTransaction(session, keyboard, control) {
    return keyboard.map(row => row.map(button => {
      if (button.url) return { text: button.text, url: button.url };
      const shortId = id();
      const token = button.token ?? button.params?.token ?? null;
      const review = token ? readReview(this.storage, this.tenantId, token) : null;
      const params = { ...(button.params ?? {}) };
      if (button.action === 'notifications.set') {
        const row = this.storage.sql.exec('SELECT value_json FROM preferences WHERE tenant_id=? AND key=?', this.tenantId, 'telegram.notificationsVersion').toArray()[0];
        params.expectedPreferenceVersion = row ? JSON.parse(row.value_json) : 0;
      }
      if (token && ['favorite.set', 'note.begin', 'note.clear'].includes(button.action)) params.expectedAnnotationVersion = annotationVersion(this.storage, this.tenantId, token, button.action === 'favorite.set' ? 'favorite' : 'note').version;
      this.storage.sql.exec('INSERT INTO shortlinks (tenant_id,id,chain,address,action,expected_control_epoch,ui_session_id,expected_ui_version,params_json,origin_message_id,review_revision,expected_mark_version,expected_connection_generation,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', this.tenantId, shortId, token?.chain ?? null, token?.address ?? null, button.action, control.controlEpoch, session.id, session.version, JSON.stringify(params), session.messageId, review?.candidate?.reviewRevision ?? null, review?.mark.version ?? null, control.connectionGeneration, session.expiresAt, this.now());
      return { text: button.text, callback_data: `cb:${shortId}` };
    }));
  }

  resolveInTransaction(receipt) {
    const link = this.storage.sql.exec('SELECT * FROM shortlinks WHERE tenant_id = ? AND id = ?', this.tenantId, receipt.payload.callbackId).toArray()[0];
    if (!link) throw new ReviewConflict('callback_expired');
    const session = this.get(link.ui_session_id);
    if (!session || session.ownerUserId !== receipt.actorUserId || session.chatId !== receipt.tenantId
      || !session.messageId || session.messageId !== receipt.sourceMessageId || link.origin_message_id !== receipt.sourceMessageId) throw new ReviewConflict('callback_owner_mismatch');
    if (session.expiresAt <= this.now() || link.expires_at <= this.now()) throw new ReviewConflict('callback_expired');
    // Safety corrections keep the original alert's navigation and mute buttons usable.
    // Token controls depend on the shown state and must reject stale callbacks.
    const params = JSON.parse(link.params_json);
    const notificationAction = (link.action === 'panel.open' && (session.panel === 'notice' || ['detail','audits'].includes(params.panel)))
      || (link.action === 'notifications.set' && params.value === false);
    if (session.version !== link.expected_ui_version && !(NOTIFICATION_PANELS.has(session.panel) && !session.query.tokenControls && notificationAction)) throw new ReviewConflict('session_changed');
    return { session, action: link.action, params, token: link.chain && link.address ? { chain: link.chain, address: link.address } : null, reviewRevision: link.review_revision, expectedMarkVersion: link.expected_mark_version, expectedControlEpoch: link.expected_control_epoch, expectedConnectionGeneration: link.expected_connection_generation };
  }

  promptSession(replyToMessageId) {
    const rows = this.storage.sql.exec('SELECT id FROM ui_sessions WHERE tenant_id = ? AND expires_at > ?', this.tenantId, this.now()).toArray();
    return rows.map(row => this.get(row.id)).find(session => session.query.pendingInput?.promptMessageId === replyToMessageId && session.query.pendingInput.expiresAt > this.now()) ?? null;
  }

  confirmPromptInTransaction({ row, payload, result }) {
    if (payload.purpose !== 'prompt' || !result?.message_id || !row.ui_session_id) return;
    const session = this.get(row.ui_session_id);
    if (!session || session.version !== payload.sessionVersion || session.query.pendingInput?.outboxId !== row.id) return;
    this.saveInTransaction({ ...session, query: { ...session.query, pendingInput: { ...session.query.pendingInput, promptMessageId: String(result.message_id) } } });
  }

  pruneInTransaction() {
    this.storage.sql.exec('DELETE FROM shortlinks WHERE tenant_id = ? AND expires_at <= ?', this.tenantId, this.now());
    // An expired alert is no longer corrected in place.
    for (const row of this.storage.sql.exec("SELECT m.message_id FROM message_map m JOIN ui_sessions s ON s.tenant_id = m.tenant_id AND s.id = m.ui_session_id WHERE m.tenant_id = ? AND (s.panel = 'alert' OR json_extract(s.query_json,'$.originAlertToken') IS NOT NULL) AND s.expires_at <= ?", this.tenantId, this.now()).toArray()) {
      this.storage.sql.exec('DELETE FROM message_map WHERE tenant_id = ? AND message_id = ?', this.tenantId, row.message_id);
      this.storage.sql.exec('DELETE FROM scheduler_state WHERE tenant_id = ? AND key = ?', this.tenantId, `telegram.rendered:${row.message_id}`);
    }
    // A shown token still needs safety correction after navigation expires.
    this.storage.sql.exec('DELETE FROM ui_sessions WHERE tenant_id = ? AND expires_at <= ? AND id NOT IN (SELECT ui_session_id FROM message_map WHERE tenant_id = ?)', this.tenantId, this.now() - SESSION_TTL, this.tenantId);
  }
}
