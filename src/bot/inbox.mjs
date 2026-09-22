import { normalizeTenantId } from '../storage/gmgn-admission-state.mjs';
import { readSchedulerStateInTransaction, writeSchedulerStateInTransaction } from '../storage/scheduler-state.mjs';

const INPUT_TTL = 15 * 60_000;
const TOMBSTONE_TTL = 7 * 24 * 60 * 60_000;
const TERMINAL = new Set(['DONE', 'FAILED', 'CANCELLED']);
const CONTROLS = new Set(['pause', 'resume', 'disconnect', 'chains', 'feed', 'mute', 'unmute']);
const CREDENTIALS = new Set(['onboard', 'setkey', 'disconnect']);

/** A durable command log. Call transaction methods only inside storage.transactionSync. */
export class TelegramInbox {
  constructor({ storage, tenantId, now = Date.now }) {
    this.storage = storage;
    this.tenantId = normalizeTenantId(tenantId);
    this.now = now;
  }

  get(updateId) {
    return this.storage.sql.exec('SELECT * FROM inbox WHERE tenant_id = ? AND update_id = ?', this.tenantId, updateId).toArray()[0] || null;
  }

  /** payloadEnc is prepared outside the transaction; plaintext credentials never enter this API. */
  receiveInTransaction(receipt, { payloadEnc = null, immediate = null } = {}) {
    if (receipt.tenantId !== this.tenantId || receipt.actorUserId !== this.tenantId) throw new TypeError('Inbox owner mismatch');
    const now = this.now();
    const owner = this.storage.sql.exec('SELECT owner_user_id FROM tenants WHERE tenant_id = ?', this.tenantId).toArray()[0];
    if (owner && owner.owner_user_id !== receipt.actorUserId) return { accepted: false, reason: 'owner_mismatch' };
    const existing = this.get(receipt.updateId);
    if (existing) {
      if (existing.actor_user_id !== receipt.actorUserId || existing.command_type !== receipt.commandType) throw new TypeError('Inbox identity conflict');
      this.reconcileInTransaction();
      return { accepted: true, duplicate: true, status: existing.status };
    }
    if (!owner) this.storage.sql.exec('INSERT INTO tenants (tenant_id, owner_user_id, onboard_state, created_at) VALUES (?, ?, ?, ?)', this.tenantId, receipt.actorUserId, 'none', now);
    const command = receipt.commandType.replace(/^command:/, '');
    const sensitive = command === 'credential';
    if (sensitive && (typeof payloadEnc !== 'string' || !payloadEnc)) throw new TypeError('Credential intake requires ciphertext');
    if (!sensitive && payloadEnc !== null) throw new TypeError('Unexpected encrypted input');
    const groups = [...(CONTROLS.has(command) ? ['control'] : []), ...(sensitive || CREDENTIALS.has(command) ? ['credential'] : [])];
    const tooOld = groups.length > 0 && (!Number.isSafeInteger(receipt.messageDate) || receipt.messageDate * 1000 < now - INPUT_TTL || receipt.messageDate * 1000 > now + 60_000);
    const stale = !tooOld && groups.some(group => this.#olderThanWatermark(group, receipt));
    const status = tooOld || stale ? 'CANCELLED' : 'RECEIVED';
    this.storage.sql.exec(
      'INSERT INTO inbox (tenant_id, update_id, actor_user_id, command_type, payload_json, payload_enc, status, generation, received_at, attempts, next_at, expires_at, message_date, source_message_id, result_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      this.tenantId, receipt.updateId, receipt.actorUserId, receipt.commandType, JSON.stringify(receipt.payload), status === 'CANCELLED' ? null : payloadEnc,
      status, 1, now, 0, receipt.dueAt ?? now, now + INPUT_TTL, receipt.messageDate, receipt.sourceMessageId,
      status === 'CANCELLED' ? JSON.stringify({ reason: tooOld ? 'input_expired' : 'command_superseded' }) : null
    );
    if (status !== 'CANCELLED') {
      for (const group of groups) this.#watermark(group, { date: receipt.messageDate, updateId: receipt.updateId });
      if (immediate) immediate(this.get(receipt.updateId));
    }
    this.reconcileInTransaction();
    return { accepted: true, duplicate: false, status: this.get(receipt.updateId).status };
  }

  beginInTransaction(updateId) {
    const row = this.get(updateId);
    if (!row || TERMINAL.has(row.status)) return null;
    if (row.expires_at <= this.now()) {
      this.finishInTransaction(updateId, 'CANCELLED', { reason: 'input_expired' });
      return null;
    }
    this.storage.sql.exec('UPDATE inbox SET status = ?, attempts = attempts + 1 WHERE tenant_id = ? AND update_id = ?', 'RUNNING', this.tenantId, updateId);
    return this.get(updateId);
  }

  finishInTransaction(updateId, status, result = {}) {
    if (!TERMINAL.has(status)) throw new TypeError('Invalid terminal inbox state');
    const row = this.get(updateId);
    if (!row || TERMINAL.has(row.status)) return false;
    this.storage.sql.exec('UPDATE inbox SET status = ?, payload_enc = NULL, result_json = ?, next_at = NULL WHERE tenant_id = ? AND update_id = ?', status, JSON.stringify(result), this.tenantId, updateId);
    return true;
  }

  /** Rebuild command work from facts on every wake, including duplicate receipt recovery. */
  reconcileInTransaction() {
    const now = this.now();
    this.storage.sql.exec("UPDATE inbox SET status = 'CANCELLED', payload_enc = NULL, next_at = NULL, result_json = ? WHERE tenant_id = ? AND status IN ('RECEIVED', 'RUNNING') AND expires_at <= ?", JSON.stringify({ reason: 'input_expired' }), this.tenantId, now);
    this.storage.sql.exec("DELETE FROM inbox WHERE tenant_id = ? AND status IN ('DONE', 'FAILED', 'CANCELLED') AND received_at < ?", this.tenantId, now - TOMBSTONE_TTL);
    const rows = this.storage.sql.exec("SELECT update_id, next_at, received_at FROM inbox WHERE tenant_id = ? AND status IN ('RECEIVED', 'RUNNING') AND NOT (command_type = 'credential' AND next_at >= expires_at) ORDER BY received_at, rowid", this.tenantId).toArray();
    const state = readSchedulerStateInTransaction(this.storage, this.tenantId);
    // Only the oldest runnable command is exposed. Safety controls execute during intake.
    const runnable = rows[0];
    const tasks = state.tasks.filter(task => !task.id.startsWith('inbox:'));
    if (runnable) tasks.push({ id: `inbox:${runnable.update_id}`, kind: 'command', dueAt: runnable.next_at ?? runnable.received_at, enabled: true, needsGmgn: false, gmgnWeight: 1 });
    writeSchedulerStateInTransaction(this.storage, this.tenantId, { ...state, tasks });
    return tasks;
  }

  #olderThanWatermark(group, receipt) {
    const row = this.storage.sql.exec('SELECT value_json FROM preferences WHERE tenant_id = ? AND key = ?', this.tenantId, `telegram.watermark.${group}`).toArray()[0];
    if (!row) return false;
    const old = JSON.parse(row.value_json);
    return receipt.messageDate < old.date || (receipt.messageDate === old.date && BigInt(receipt.updateId) < BigInt(old.updateId));
  }

  #watermark(group, value) {
    this.storage.sql.exec('INSERT INTO preferences (tenant_id, key, value_json) VALUES (?, ?, ?) ON CONFLICT(tenant_id, key) DO UPDATE SET value_json = excluded.value_json', this.tenantId, `telegram.watermark.${group}`, JSON.stringify(value));
  }
}

export const TELEGRAM_INBOX_POLICY = Object.freeze({ inputTtlMs: INPUT_TTL, tombstoneTtlMs: TOMBSTONE_TTL });
