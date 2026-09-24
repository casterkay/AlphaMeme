import { NotificationPolicy } from './notification-policy.mjs';
import { userText } from '../render/telegram.mjs';
import { TelegramInbox } from './inbox.mjs';
import { TelegramOutbox } from './outbox.mjs';
import { createTelegramTransport } from './telegram-transport.mjs';
import { TelegramCommands } from './commands.mjs';
import { PersistentLive } from './live.mjs';
import { annotationVersion, nextReviewExpiry, reviewProjectionRevision } from './review.mjs';
import { createTelegramExport, readTelegramSnapshot } from './snapshot.mjs';
import { readTelegramStatistics } from './statistics.mjs';
import { scannerSettings } from '../scanner-settings.mjs';
import { normalizeGmgnApiKey } from '../gmgn-api-key.mjs';
import { gmgnRequestWeight } from '../providers/gmgn.mjs';
import { encryptSecret, decryptSecret } from '../util/crypto.mjs';
import { ensurePendingSigningKey, regeneratePendingSigningKey, signingSetupSnapshot, SigningKeyError } from '../auth/key-store.mjs';
import { prepareOnboardingVerification, verifyAndActivateOnboardingCredential, failOnboardingVerification, ConnectionError } from '../auth/connection.mjs';
import { SqliteControlStateStore } from '../storage/control-state.mjs';
import { readSchedulerStateInTransaction, writeSchedulerStateInTransaction, scheduleRecoverableScanTaskInTransaction } from '../storage/scheduler-state.mjs';
import { SqliteRecoverableScannerStore, restartRecoverableScanInTransaction, resumeRecoverableCheckpointsInTransaction } from '../storage/recoverable-scanner.mjs';
import { RecoverableScanner } from '../recoverable-scanner.mjs';

export class TelegramRuntime {
  constructor({ storage, env, tenantId, now = Date.now }) {
    Object.assign(this, { storage, env, tenantId, now });
    this.inbox = new TelegramInbox({ storage, tenantId, now });
    this.live = new PersistentLive({ storage, tenantId, settings: scannerSettings, now });
    this.control = new SqliteControlStateStore(storage, tenantId);
    this.notifications = new NotificationPolicy({ storage, tenantId, now });
    this.outbox = new TelegramOutbox({ storage, tenantId, now,
      transport: input => typeof env.TELEGRAM_BOT_TOKEN === 'string' && env.TELEGRAM_BOT_TOKEN.trim() ? createTelegramTransport({ botToken: env.TELEGRAM_BOT_TOKEN })(input) : Promise.resolve({ ok: false, kind: 'permanent', code: 'TELEGRAM_NOT_CONFIGURED' }),
      eligible: (row, payload) => this.deliveryEligible(row, payload),
      onConfirmedInTransaction: value => {
        this.commands.sessions.confirmPromptInTransaction(value);
        if (value.payload.notification) this.notifications.acknowledgeInTransaction(value.payload.notification);
        if (value.payload.token && value.payload.purpose !== 'prompt') this.saveRenderedProjection(value);
      }
    });
    this.commands = new TelegramCommands({ storage, tenantId, inbox: this.inbox, outbox: this.outbox, live: this.live, now,
      snapshot: (storage, tenant, at) => ({ ...readTelegramSnapshot(storage, tenant, at), stats: readTelegramStatistics(storage, tenant, at) }),
      controls: {
        snapshot: () => this.control.snapshot(), pause: () => this.control.pause(), disconnect: () => this.disconnect(), resume: () => this.resume(), setScanChains: chains => this.setScanChains(chains),
        annotationVersion: (token, field) => annotationVersion(storage, tenantId, token, field).version,
        exportRecords: () => createTelegramExport(this.commands.snapshot(storage, tenantId, now())),
        resetNotificationBaseline: () => this.resetNotificationBaseline(), initializeNotificationBaseline: () => this.resetNotificationBaseline(false)
      }
    });
  }

  get masterKey() {
    const value = this.env.MASTER_ENC_KEY;
    return typeof value === 'string' && value.trimStart().startsWith('{') ? JSON.parse(value) : value;
  }

  receive(receipt, payloadEnc = null) {
    return this.storage.transactionSync(() => {
      const result = this.inbox.receiveInTransaction(receipt, { payloadEnc, immediate: row => this.commands.immediateInTransaction(row) });
      return result;
    });
  }

  async answerCallback(receipt) {
    let result;
    try {
      result = await this.outbox.transport({ method: 'answerCallbackQuery', params: { callback_query_id: receipt.payload.callbackQueryId } });
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      result = { ok: false, code: 'TELEGRAM_CALLBACK_UNAVAILABLE' };
    }
    if (!result.ok) this.storage.sql.exec('INSERT INTO scheduler_state (tenant_id,key,value_json) VALUES (?,?,?) ON CONFLICT(tenant_id,key) DO UPDATE SET value_json=excluded.value_json', this.tenantId, 'telegram.callbackFailure', JSON.stringify({ at: this.now(), reason: result.code }));
  }

  async receiveCredential(receipt, text) {
    const key = normalizeGmgnApiKey(text.replace(/^\/setkey(?:@[A-Za-z0-9_]+)?\s*/i, ''));
    // Even invalid sensitive submissions are encrypted before durable intake.
    const encrypted = await encryptSecret(this.masterKey, this.tenantId, `telegram-inbox:${receipt.updateId}`, key || 'invalid');
    return this.storage.transactionSync(() => {
      const result = this.receive(receipt, encrypted);
      if (result.accepted) this.outbox.enqueueInTransaction({ id: `delete:${receipt.updateId}`, chatId: this.tenantId, method: 'deleteMessage', params: { message_id: receipt.sourceMessageId }, expiresAt: this.now() + 900_000 });
      return result;
    });
  }

  async runCommand(updateId) {
    if (!this.inbox.get(updateId)) throw Object.assign(new Error('Command task has no durable receipt'), { code: 'SCHEDULER_HANDLER_UNAVAILABLE' });
    const row = this.storage.transactionSync(() => this.inbox.beginInTransaction(updateId));
    if (!row) return { status: 'success', complete: true };
    let onboarding = null;
    try {
      if (row.command_type === 'credential') return await this.prepareCredential(row);
      if (row.command_type === 'command:onboard' && !JSON.parse(row.payload_json).arguments) onboarding = await ensurePendingSigningKey(this.keyOptions());
      if (row.command_type === 'callback') {
        const payload = JSON.parse(row.payload_json);
        const link = this.commands.sessions.resolveInTransaction({ tenantId: this.tenantId, actorUserId: row.actor_user_id, sourceMessageId: row.source_message_id, payload });
        if (link.action === 'onboard.regenerate') onboarding = await regeneratePendingSigningKey({ ...this.keyOptions(), expectedGeneration: link.params.generation, expectedConnectionGeneration: link.expectedConnectionGeneration });
        else if (link.action === 'panel.open' && link.params.panel === 'onboard') onboarding = await ensurePendingSigningKey(this.keyOptions());
        else if (['onboard','regenerate'].includes(link.session.panel) || ['onboard','regenerate'].includes(link.session.query.returnTo?.panel)) onboarding = await signingSetupSnapshot(this.keyOptions());
      }
      this.storage.transactionSync(() => {
        const current = this.inbox.get(updateId);
        if (!current || !['RECEIVED','RUNNING'].includes(current.status)) return;
        this.commands.processInTransaction(current, { onboarding });
      });
    } catch (error) {
      if (!(error instanceof ConnectionError) && !(error instanceof SigningKeyError) && error?.name !== 'ReviewConflict') throw error;
      this.storage.transactionSync(() => {
        this.commands.noticeInTransaction(updateId, this.commands.language === 'en' ? 'The action expired or changed. Reopen /radar.' : '操作已过期或发生变化，请重新打开 /radar。');
        this.inbox.finishInTransaction(updateId, 'FAILED', { reason: error.code });
      });
    }
    return { status: 'success', complete: true };
  }

  keyOptions() { return { storage: this.storage, masterKey: this.masterKey, tenantId: this.tenantId, now: this.now }; }

  async prepareCredential(row) {
    const key = await decryptSecret(this.masterKey, this.tenantId, `telegram-inbox:${row.update_id}`, row.payload_enc);
    const signing = await signingSetupSnapshot(this.keyOptions());
    if (!signing || !normalizeGmgnApiKey(key)) {
      this.storage.transactionSync(() => {
        this.commands.noticeInTransaction(row.update_id, this.commands.language === 'en' ? 'Use /onboard first, then submit a valid GMGN key. Check and delete the original message; deletion is not guaranteed.' : '请先使用 /onboard，再提交有效GMGN密钥。请检查并删除原消息；无法保证自动删除。');
        this.inbox.finishInTransaction(row.update_id, 'FAILED', { reason: !signing ? 'onboard_required' : 'invalid_key' });
      });
    } else {
      await prepareOnboardingVerification({ ...this.keyOptions(), updateId: row.update_id, apiKey: key, expectedSigningGeneration: signing.generation });
      // Verification has its own task. Do not keep preparing the same inbox command.
      this.storage.sql.exec('UPDATE inbox SET next_at = ? WHERE tenant_id=? AND update_id=?', row.expires_at, this.tenantId, row.update_id);
    }
    return { status: 'success', complete: true };
  }

  async verifyCredential(connectionGeneration, { request, gmgn }) {
    try {
      await verifyAndActivateOnboardingCredential({ ...this.keyOptions(), connectionGeneration, request, verify: (key, options) => gmgn.verifyApiKey(key, options), afterActivate: state => {
        restartRecoverableScanInTransaction(this.storage, this.tenantId, { keyEpoch: state.keyEpoch, controlEpoch: state.controlEpoch, now: this.now() });
        this.startInitialScans();
        this.resetNotificationBaseline();
        this.inbox.finishInTransaction(state.updateId, 'DONE');
        this.commands.noticeInTransaction(state.updateId, this.commands.language === 'en' ? 'GMGN connected: gmgn_****. Read-only; no trades. Check and delete your key message. Notifications remain under your control: /unmute.' : 'GMGN已连接：gmgn_****。只读，不执行交易。请检查并删除密钥消息。可使用 /unmute 开启提醒。', 'connected');
      } });
    } catch (error) {
      if (['GMGN_RATE_LIMITED','GMGN_REQUEST_DEFERRED','GMGN_TIMEOUT','GMGN_NETWORK_ERROR','SCHEDULER_REQUEST_TIMEOUT'].includes(error.code)) throw error;
      if (!(error instanceof ConnectionError) && !(error instanceof SigningKeyError) && !['GMGN_AUTH_FAILED','GMGN_PERMISSION_DENIED','GMGN_REQUEST_FAILED'].includes(error.code)) throw error;
      this.storage.transactionSync(() => {
        const row = this.storage.sql.exec("SELECT update_id FROM inbox WHERE tenant_id=? AND command_type='credential' AND generation=? AND status IN ('RECEIVED','RUNNING')", this.tenantId, connectionGeneration).toArray()[0];
        if (row) {
          failOnboardingVerification({ storage: this.storage, tenantId: this.tenantId, updateId: row.update_id, connectionGeneration });
          this.commands.noticeInTransaction(row.update_id, this.commands.language === 'en' ? 'Connection failed or expired; prior connection retained. Use /onboard to retry. Check and delete the key message.' : '连接失败或已过期，保留之前的连接。请使用 /onboard 重试，并检查删除密钥消息。', 'verification');
        }
      });
    }
    return { status: 'success', complete: true };
  }

  startInitialScans(chains = null) {
    const preferred = this.commands.preference('scanChains', [scannerSettings.chain]);
    const enabled = chains ?? preferred;
    const state = this.control.snapshot();
    const store = new SqliteRecoverableScannerStore(this.storage, this.tenantId);
    for (const chain of enabled) {
      const scheduler = readSchedulerStateInTransaction(this.storage, this.tenantId);
      const current = this.storage.sql.exec('SELECT cycle_id,key_epoch FROM cycle_checkpoint WHERE tenant_id=? AND chain=? ORDER BY updated_at DESC', this.tenantId, chain).toArray().find(row => row.key_epoch === state.keyEpoch && scheduler.tasks.some(task => task.id === `scan:${row.cycle_id}`));
      if (current) continue;
      const scanner = new RecoverableScanner({ store, settings: scannerSettings, now: this.now });
      const cycleId = `telegram:${chain}:${state.keyEpoch}:${this.now()}`;
      scanner.begin({ cycleId, chain, keyEpoch: state.keyEpoch, controlEpoch: state.controlEpoch, deadlineAt: this.now() + scannerSettings.auditCycleBudgetMs, afterBegin: () => scheduleRecoverableScanTaskInTransaction(this.storage, this.tenantId, cycleId, this.now(), gmgnRequestWeight('trenches')) });
    }
    this.control.ensureActiveChain(enabled[0]);
  }

  resume() {
    const scheduled = readSchedulerStateInTransaction(this.storage, this.tenantId).tasks.filter(task => task.kind === 'scan').map(task => task.id.slice(5));
    this.control.resumeWith(control => resumeRecoverableCheckpointsInTransaction(this.storage, this.tenantId, { cycleIds: scheduled, control, now: this.now() }), () => []);
    if (this.control.snapshot().configured) this.startInitialScans();
  }

  setScanChains(chains) {
    if (!Array.isArray(chains) || chains.length < 1 || chains.length > 3 || new Set(chains).size !== chains.length || chains.some(chain => !scannerSettings.supportedChains.includes(chain))) throw new TypeError('Invalid scan chain selection');
    this.commands.setPreference('scanChains', chains);
    this.commands.setPreference('scanChainsVersion', this.commands.preference('scanChainsVersion', 0) + 1);
    if (this.control.snapshot().configured) {
      this.startInitialScans(chains);
      this.control.setScanChains(chains, ({ control, cycleIds }) => resumeRecoverableCheckpointsInTransaction(this.storage, this.tenantId, { cycleIds, control, now: this.now(), allowPaused: true }));
    }
  }

  disconnect() {
    this.control.disconnect();
    this.storage.sql.exec("UPDATE inbox SET status='CANCELLED',payload_enc=NULL,next_at=NULL WHERE tenant_id=? AND command_type='credential' AND status IN ('RECEIVED','RUNNING')", this.tenantId);
  }

  resetNotificationBaseline(force = true) {
    this.notifications.baselineInTransaction(force);
    if (force) this.outbox.cancelPendingActionRequiredInTransaction();
  }

  actionableIssues() {
    const issues = [];
    if (this.outbox.issueRows().some(row => row.status === 'UNKNOWN' && row.ambiguous_retries >= 1 && row.delivery_class !== 'ACTION_REQUIRED')) issues.push({ key: 'delivery-uncertain', reason: 'DELIVERY_UNCERTAIN', nextAction: '/status' });
    const control = this.control.snapshot();
    const live = this.live.snapshot(control.live.focusChain ?? control.activeChain ?? 'robinhood');
    const auth = this.storage.sql.exec('SELECT value_json FROM scheduler_state WHERE tenant_id=? AND key=?', this.tenantId, 'telegram.providerAuth').toArray()[0];
    if (live.status === 'AUTH_REQUIRED' || (auth && JSON.parse(auth.value_json).keyEpoch === control.keyEpoch && JSON.parse(auth.value_json).unusable)) issues.push({ key: 'gmgn-unusable', reason: 'KEY_UNUSABLE', nextAction: '/onboard' });
    return issues;
  }

  deliveryEligible(row, payload) {
    if (payload.token && payload.projectionRevision !== reviewProjectionRevision(this.storage, this.tenantId, payload.token, this.now())) return false;
    return this.notifications.eligible(row, payload, { issues: this.actionableIssues() });
  }

  reconcileNotificationsInTransaction() {
    const { notifications } = this.notifications.reconcileInTransaction({ issues: this.actionableIssues() });
    for (const notification of notifications) {
      if (this.outbox.has(notification.id)) continue;
      const session = this.commands.sessions.createInTransaction('audits', this.control.snapshot().activeChain ?? 'robinhood');
      const en = this.commands.language === 'en';
      const title = en ? 'Action required' : '需要人工查看';
      const reason = notification.actionReason === 'CANDIDATE_NEW'
        ? (en ? 'On-chain gates passed; review X comments and replies.' : '链上门槛已通过，请核验X评论与回复。')
        : notification.actionReason === 'RISK_WORSENED'
          ? (en ? 'Risk or evidence worsened; review the updated evidence.' : '风险或证据恶化，请查看更新后的证据。')
          : notification.issue.reason === 'KEY_UNUSABLE' ? (en ? 'GMGN key is unusable; reconnect with /onboard.' : 'GMGN密钥不可用，请使用 /onboard 重新连接。')
            : (en ? 'Message delivery is unconfirmed; check /status.' : '消息投递结果不确定，请通过 /status 核对。');
      const lines = [`<b>${title}</b>`, reason];
      const keyboard = notification.members.map((token, index) => {
        const candidate = this.storage.sql.exec('SELECT symbol FROM candidates WHERE tenant_id=? AND chain=? AND address=?', this.tenantId, token.chain, token.address).toArray()[0];
        const label = `${index + 1}. ${candidate?.symbol || token.address.slice(-8)} · ${token.chain}`;
        lines.push(userText(label));
        return [{ text: `${index + 1}. ${(candidate?.symbol || token.address.slice(-8)).slice(0,30)}`, action: 'panel.open', params: { panel: 'detail' }, token: { chain: token.chain, address: token.address } }];
      });
      keyboard.push([{ text: en ? 'Status' : '运行状态', action: 'panel.open', params: { panel: 'status' } }, { text: en ? 'Mute alerts' : '关闭提醒', action: 'notifications.set', params: { value: false } }]);
      this.outbox.enqueueInTransaction({ id: notification.id, chatId: this.tenantId, method: 'sendMessage', params: { text: lines.join('\n'), parse_mode: 'HTML', reply_markup: { inline_keyboard: this.commands.sessions.bindKeyboardInTransaction(session, keyboard, this.control.snapshot()) }, link_preview_options: { is_disabled: true } }, sessionId: session.id, sessionVersion: session.version, deliveryClass: notification.deliveryClass, actionReason: notification.actionReason, notification, expiresAt: notification.expiresAt });
    }
  }

  saveRenderedProjection({ row, payload, result }) {
    const messageId = String(result?.message_id ?? payload.params.message_id);
    const value = payload.projectionRevision;
    this.storage.sql.exec('INSERT INTO scheduler_state (tenant_id,key,value_json) VALUES (?,?,?) ON CONFLICT(tenant_id,key) DO UPDATE SET value_json=excluded.value_json', this.tenantId, `telegram.rendered:${messageId}`, JSON.stringify(value));
  }

  reconcileRequestedPanelsInTransaction() {
    for (const row of this.outbox.requestedRows()) {
      const payload = this.outbox.payload(row);
      if (!payload?.token || !row.ui_session_id) continue;
      const session = this.commands.sessions.get(row.ui_session_id);
      if (!session || session.version !== payload.sessionVersion || session.expiresAt <= this.now()) continue;
      if (payload.projectionRevision === reviewProjectionRevision(this.storage, this.tenantId, payload.token, this.now())) continue;
      this.commands.renderInTransaction(this.commands.sessions.advanceInTransaction(session));
    }
  }

  reconcileCardsInTransaction() {
    const maps = this.storage.sql.exec('SELECT * FROM message_map WHERE tenant_id=?', this.tenantId).toArray();
    let nextAt = null;
    for (const map of maps) {
      const token = { chain: map.chain, address: map.address };
      const fingerprint = reviewProjectionRevision(this.storage, this.tenantId, token, this.now());
      const rendered = this.storage.sql.exec('SELECT value_json FROM scheduler_state WHERE tenant_id=? AND key=?', this.tenantId, `telegram.rendered:${map.message_id}`).toArray()[0];
      const session = map.ui_session_id ? this.commands.sessions.get(map.ui_session_id) : null;
      if (!session || !['detail','evidence'].includes(session.panel) || session.query.selectedToken?.address !== map.address || session.query.selectedToken?.chain !== map.chain) continue;
      if (!rendered || JSON.parse(rendered.value_json) !== fingerprint) {
        const pending = this.outbox.correctionRows(session.id).some(row => this.outbox.payload(row)?.projectionRevision === fingerprint);
        if (!pending) {
          const next = { ...session, version: session.version + 1, snapshotAt: this.now() };
          this.commands.sessions.saveInTransaction(next);
          this.commands.renderInTransaction(next, { deliveryClass: 'PANEL_UPDATE' });
        }
      }
      const expiry = nextReviewExpiry(this.storage, this.tenantId, token, this.now());
      if (expiry !== null && expiry > this.now()) nextAt = Math.min(nextAt ?? Infinity, expiry);
    }
    return nextAt;
  }

  reconcileInTransaction({ recover = false, tasks: suppliedTasks = null } = {}) {
    if (!this.storage.sql.exec('SELECT tenant_id FROM tenants WHERE tenant_id=?', this.tenantId).toArray().length) return suppliedTasks ?? readSchedulerStateInTransaction(this.storage, this.tenantId).tasks;
    this.inbox.reconcileInTransaction();
    const pending = this.storage.sql.exec("SELECT value_enc,generation FROM keys WHERE tenant_id=? AND name='gmgn-pending-api-key'", this.tenantId).toArray()[0];
    if (pending && JSON.parse(pending.value_enc).v === 2 && !this.storage.sql.exec("SELECT update_id FROM inbox WHERE tenant_id=? AND command_type='credential' AND generation=? AND status IN ('RECEIVED','RUNNING')", this.tenantId, pending.generation).toArray().length) this.storage.sql.exec("DELETE FROM keys WHERE tenant_id=? AND name='gmgn-pending-api-key' AND generation=?", this.tenantId, pending.generation);
    this.reconcileRequestedPanelsInTransaction();
    const correctionsAt = this.reconcileCardsInTransaction();
    this.reconcileNotificationsInTransaction();
    const state = readSchedulerStateInTransaction(this.storage, this.tenantId);
    const ownedOutbox = new Set(this.outbox.ids().map(row => `outbox:${row.id}`));
    const tasks = (suppliedTasks ?? state.tasks).filter(task => !ownedOutbox.has(task.id) && task.id !== 'live:subscription' && task.id !== 'telegram:corrections' && task.id !== 'telegram:expiry' && !task.id.startsWith('inbox:'));
    tasks.push(...state.tasks.filter(task => task.id.startsWith('inbox:')));
    const expiry = this.storage.sql.exec("SELECT MIN(expires_at) AS at FROM inbox WHERE tenant_id=? AND status IN ('RECEIVED','RUNNING')", this.tenantId).toArray()[0]?.at;
    if (Number.isSafeInteger(expiry)) tasks.push({ id: 'telegram:expiry', kind: 'local-control', dueAt: expiry, enabled: true, needsGmgn: false, gmgnWeight: 1 });
    if (correctionsAt !== null) tasks.push({ id: 'telegram:corrections', kind: 'local-control', dueAt: correctionsAt, enabled: true, needsGmgn: false, gmgnWeight: 1 });
    tasks.push(...this.live.reconcileInTransaction({ recoverRunning: recover }), ...this.outbox.reconcileInTransaction({ recoverSending: recover }));
    const current = readSchedulerStateInTransaction(this.storage, this.tenantId);
    writeSchedulerStateInTransaction(this.storage, this.tenantId, { ...current, tasks });
    this.commands.sessions.pruneInTransaction();
    return tasks;
  }
}
