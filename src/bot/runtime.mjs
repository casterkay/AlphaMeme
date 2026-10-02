import { NotificationPolicy } from './notification-policy.mjs';
import { alertCard } from './alerts.mjs';
import { renderPanel } from './panels.mjs';
import { ALERT_SESSION_TTL } from './sessions.mjs';
import { TelegramInbox } from './inbox.mjs';
import { TelegramOutbox } from './outbox.mjs';
import { createTelegramTransport } from './telegram-transport.mjs';
import { TelegramCommands } from './commands.mjs';
import { annotationVersion, nextReviewExpiry, reviewProjectionRevision } from './review.mjs';
import { createTelegramExport, projectTelegramCandidate, readTelegramSnapshot } from './snapshot.mjs';
import { readTelegramStatistics } from './statistics.mjs';
import { scannerSettings } from '../scanner-settings.mjs';
import { aveCreditsUsed, parseAveBudget } from '../ave-admission.mjs';
import { DEFAULT_SCAN_CHAIN } from '../chains.mjs';
import { AVE_CU, normalizeAveApiKey, verifyAveApiKey } from '../providers/ave.mjs';
import { onchainOffReason } from '../providers/chain-logs.mjs';
import { encryptSecret, decryptSecret } from '../util/crypto.mjs';
import { CONNECTION_KEY_NAMES, prepareOnboardingVerification, verifyAndActivateOnboardingCredential, failOnboardingVerification, ConnectionError } from '../auth/connection.mjs';
import { SqliteControlStateStore } from '../storage/control-state.mjs';
import { readSchedulerStateInTransaction, writeSchedulerStateInTransaction, scheduleRecoverableScanTaskInTransaction } from '../storage/scheduler-state.mjs';
import { SqliteRecoverableScannerStore, restartRecoverableScanInTransaction, resumeRecoverableCheckpointsInTransaction } from '../storage/recoverable-scanner.mjs';
import { RecoverableScanner } from '../recoverable-scanner.mjs';
import { SecretError } from '../util/crypto.mjs';
import { chainRpcUrls, parseTradingConfig, TRADING_SETTINGS } from '../trading/config.mjs';
import { TradingEngine } from '../trading/engine.mjs';
import { TokenLookups } from '../lookup.mjs';
import { generateTradingWallet, readTradingWallet, revealTradingKey, markTradingWalletExportedInTransaction } from '../trading/wallet.mjs';

// Only the fields a panel shows; never raw transactions, calldata or routes.
function projectTrade(trade) {
  const tx = value => value && { hash: value.hash, sentAt: value.sentAt };
  const { route: _route, approval, swap, quote, ...rest } = trade;
  return { ...rest, approval: tx(approval), swap: tx(swap), quote: quote && (({ data: _data, ...fields }) => fields)(quote) };
}

export class TelegramRuntime {
  constructor({ storage, env, tenantId, now = Date.now }) {
    Object.assign(this, { storage, env, tenantId, now });
    this.tradingConfig = parseTradingConfig(env);
    this.trading = new TradingEngine({ storage, tenantId, now, config: this.tradingConfig, masterKey: () => this.masterKey,
      onTradeInTransaction: trade => this.presentTradeInTransaction(trade), onBalancesInTransaction: state => this.presentBalancesInTransaction(state) });
    this.lookups = new TokenLookups({ storage, tenantId, now, onLookupInTransaction: record => this.presentLookupInTransaction(record) });
    this.inbox = new TelegramInbox({ storage, tenantId, now });
    this.control = new SqliteControlStateStore(storage, tenantId);
    this.notifications = new NotificationPolicy({ storage, tenantId, now });
    this.outbox = new TelegramOutbox({ storage, tenantId, now,
      transport: input => typeof env.TELEGRAM_BOT_TOKEN === 'string' && env.TELEGRAM_BOT_TOKEN.trim() ? createTelegramTransport({ botToken: env.TELEGRAM_BOT_TOKEN })(input) : Promise.resolve({ ok: false, kind: 'permanent', code: 'TELEGRAM_NOT_CONFIGURED' }),
      ineligibleReason: (row, payload) => this.deliveryIneligibleReason(row, payload),
      reveal: params => this.revealSecretParams(params),
      onConfirmedInTransaction: value => {
        if (value.payload.purpose === 'secret') this.afterSecretSentInTransaction(value);
        this.commands.sessions.confirmPromptInTransaction(value);
        if (value.payload.notification) this.notifications.acknowledgeInTransaction(value.payload.notification);
        if (value.payload.token && value.payload.purpose !== 'prompt' && value.payload.method !== 'editMessageReplyMarkup') this.saveRenderedProjection(value);
      },
      onFailedInTransaction: value => { if (value.payload.notification) this.notifications.failInTransaction(value.payload.notification); }
    });
    this.commands = new TelegramCommands({ storage, tenantId, inbox: this.inbox, outbox: this.outbox, lookups: this.lookups, trading: this.trading, now,
      snapshot: (storage, tenant, at) => {
        const snapshot = readTelegramSnapshot(storage, tenant, at), aveBudget = parseAveBudget(env);
        // Spending rolls into a new period only on the next request; show the period as it is now.
        const ave = { ...snapshot.ave, cuUsed: aveCreditsUsed(at, snapshot.ave, aveBudget) };
        return { ...snapshot, ave, stats: readTelegramStatistics(storage, tenant, at), aveBudget, trading: this.tradingSnapshot() };
      },
      controls: {
        snapshot: () => this.control.snapshot(), pause: () => this.control.pause(), disconnect: () => this.disconnect(), resume: () => this.resume(), selectScanChain: chain => this.selectScanChain(chain),
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

  tradingSnapshot() {
    const chains = this.tradingConfig.chains;
    const exportRow = this.storage.sql.exec("SELECT status FROM outbox WHERE tenant_id=? AND substr(id,1,14)='wallet-export:' ORDER BY rowid DESC LIMIT 1", this.tenantId).toArray()[0];
    const setting = (key, fallback, maximum) => {
      const value = this.commands.preference(key, fallback);
      if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new TypeError(`trading preference ${key} is malformed`);
      return value;
    };
    return {
      chains: Object.keys(chains),
      chainFacts: Object.fromEntries(Object.entries(chains).map(([chain, facts]) => [chain, { nativeSymbol: facts.nativeSymbol, quoteDecimals: facts.quoteDecimals }])),
      explorers: Object.fromEntries(Object.entries(chains).map(([chain, facts]) => [chain, facts.explorerUrl])),
      wallet: readTradingWallet(this.storage, this.tenantId),
      settings: { slippageBps: setting('tradingSlippageBps', TRADING_SETTINGS.slippageBps, 5000), capUsd: setting('tradingBuyCapUsd', TRADING_SETTINGS.buyCapUsd, 1_000_000) },
      trades: this.trading.trades().slice(0, 10).map(projectTrade),
      balances: this.trading.balances(),
      exportIssue: ['UNKNOWN', 'FAILED'].includes(exportRow?.status),
      removal: { tradesOpen: this.trading.trades().some(trade => !['FILLED', 'FAILED', 'EXPIRED', 'CANCELLED'].includes(trade.state)), exportRequired: this.trading.exportRequiredBeforeRemoval() }
    };
  }

  /** Decrypt an export for exactly one send; the plaintext never reaches storage or logs. */
  async revealSecretParams(params) {
    if (params.secret === undefined) return params;
    const { secret, ...rest } = params;
    if (typeof secret !== 'string') return null;
    let privateKey;
    try { privateKey = await revealTradingKey(this.masterKey, this.tenantId, secret); } catch (error) {
      if (error instanceof SecretError || error?.code === 'TRADE_WALLET_CORRUPT') return null;
      throw error;
    }
    const en = this.commands.language === 'en';
    const text = en
      ? `<b>Trading wallet private key</b>\n<code>${privateKey}</code>\n\nAnyone with this key controls the wallet's funds. Store it offline and never share it. This message will be deleted in 60 seconds (deletion is not guaranteed); delete it yourself too.`
      : `<b>交易钱包私钥</b>\n<code>${privateKey}</code>\n\n任何拿到此私钥的人都能控制钱包资金。请离线保存，切勿分享。此消息将在60秒后删除（无法保证删除），请同时自行删除。`;
    return { ...rest, text };
  }

  afterSecretSentInTransaction({ row, result }) {
    this.outbox.forgetSecretInTransaction(row.id);
    if (result?.message_id != null) {
      markTradingWalletExportedInTransaction(this.storage, this.tenantId, this.now());
      const at = this.now() + TRADING_SETTINGS.exportDeleteAfterMs;
      this.outbox.enqueueInTransaction({ id: `delete:${row.id}`, chatId: this.tenantId, method: 'deleteMessage', params: { message_id: result.message_id }, purpose: 'cleanup', nextAt: at, expiresAt: at + 24 * 60 * 60_000 });
    }
  }

  /** Show a trade's new state on the panel that tracks it, or report its end in a message. */
  presentTradeInTransaction(trade) {
    const session = trade.sessionId ? this.commands.sessions.get(trade.sessionId) : null;
    if (session?.panel === 'trade' && session.query.tradeId === trade.id) {
      this.commands.renderInTransaction(this.commands.sessions.advanceInTransaction(session), { deliveryClass: 'PANEL_UPDATE' });
      return;
    }
    if (!['FILLED', 'FAILED', 'UNKNOWN'].includes(trade.state) || trade.confirmedAt === null) return;
    const next = this.commands.sessions.createInTransaction('trade', trade.chain, { tradeId: trade.id });
    this.commands.renderInTransaction(next, { deliveryClass: 'PANEL_UPDATE' });
  }

  /** Each lookup step re-renders the token detail it is bound to, while that detail is still open. */
  presentLookupInTransaction(record) {
    const session = record.sessionId ? this.commands.sessions.get(record.sessionId) : null;
    const shown = session?.query.selectedToken;
    if (session?.panel === 'detail' && session.expiresAt > this.now() && shown?.chain === record.chain && shown.address === record.address) {
      this.commands.renderInTransaction(this.commands.sessions.advanceInTransaction(session), { deliveryClass: 'PANEL_UPDATE' });
    }
  }

  presentBalancesInTransaction(state) {
    const session = state.sessionId ? this.commands.sessions.get(state.sessionId) : null;
    if (session?.panel === 'wallet' && session.expiresAt > this.now()) this.commands.renderInTransaction(this.commands.sessions.advanceInTransaction(session), { deliveryClass: 'PANEL_UPDATE' });
  }

  /** Work a callback needs before its transaction: generating and encrypting a new wallet key. */
  async prepareCallback(row) {
    if (row.command_type !== 'callback') return null;
    const link = this.storage.sql.exec('SELECT action FROM shortlinks WHERE tenant_id=? AND id=?', this.tenantId, JSON.parse(row.payload_json).callbackId).toArray()[0];
    if (link?.action !== 'wallet.create' || readTradingWallet(this.storage, this.tenantId)) return null;
    return { wallet: await generateTradingWallet(this.masterKey, this.tenantId) };
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
    const key = normalizeAveApiKey(text.replace(/^\/setkey(?:@[A-Za-z0-9_]+)?\s*/i, ''));
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
    try {
      if (row.command_type === 'credential') return await this.prepareCredential(row);
      const prepared = await this.prepareCallback(row);
      this.storage.transactionSync(() => {
        const current = this.inbox.get(updateId);
        if (!current || !['RECEIVED','RUNNING'].includes(current.status)) return;
        this.commands.processInTransaction(current, prepared);
      });
    } catch (error) {
      if (!(error instanceof ConnectionError) && error?.name !== 'ReviewConflict') throw error;
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
    if (!normalizeAveApiKey(key)) {
      this.storage.transactionSync(() => {
        this.presentConnectionInTransaction({ outcome: 'invalid' });
        this.inbox.finishInTransaction(row.update_id, 'FAILED', { reason: 'invalid_key' });
      });
    } else {
      await prepareOnboardingVerification({ ...this.keyOptions(), updateId: row.update_id, apiKey: key, aveCost: AVE_CU.details });
      // Verification has its own task. Do not keep preparing the same inbox command.
      this.storage.sql.exec('UPDATE inbox SET next_at = ? WHERE tenant_id=? AND update_id=?', row.expires_at, this.tenantId, row.update_id);
    }
    return { status: 'success', complete: true };
  }

  async verifyCredential(connectionGeneration, { request, fetchImpl, finalAttempt = false }) {
    try {
      await verifyAndActivateOnboardingCredential({ ...this.keyOptions(), connectionGeneration, request, verify: (key, { signal }) => verifyAveApiKey(key, { fetchImpl, now: this.now, signal }), afterActivate: state => {
        restartRecoverableScanInTransaction(this.storage, this.tenantId, { keyEpoch: state.keyEpoch, controlEpoch: state.controlEpoch, now: this.now() });
        this.startScan();
        this.resetNotificationBaseline();
        this.inbox.finishInTransaction(state.updateId, 'DONE');
        this.presentConnectionInTransaction({ outcome: 'connected' });
      } });
    } catch (error) {
      // A transient failure retries the verification until its final attempt; a refusal ends it.
      const transient = ['AVE_RATE_LIMITED','AVE_TIMEOUT','AVE_NETWORK','AVE_UPSTREAM','AVE_ABORTED','SCHEDULER_REQUEST_TIMEOUT'].includes(error.code);
      if (transient && !finalAttempt) throw error;
      if (!transient && !(error instanceof ConnectionError) && !['AVE_AUTH','AVE_QUOTA','AVE_SCHEMA','AVE_SIZE','AVE_CONFIG','AVE_INPUT'].includes(error.code)) throw error;
      this.storage.transactionSync(() => {
        const row = this.storage.sql.exec("SELECT update_id FROM inbox WHERE tenant_id=? AND command_type='credential' AND generation=? AND status IN ('RECEIVED','RUNNING')", this.tenantId, connectionGeneration).toArray()[0];
        if (row) {
          failOnboardingVerification({ storage: this.storage, tenantId: this.tenantId, updateId: row.update_id, connectionGeneration });
          this.presentConnectionInTransaction({ outcome: 'failed', reason: error.code ?? null, retryAt: error.retryAt ?? null });
        }
      });
    }
    return { status: 'success', complete: true };
  }

  /** Answer a key submission with the connection panel for its result. */
  presentConnectionInTransaction(result) {
    this.commands.renderInTransaction(this.commands.sessions.createInTransaction('connection', this.control.snapshot().activeChain ?? DEFAULT_SCAN_CHAIN, result));
  }

  /** Start the scan chain's cycle unless one already runs for the current key. */
  startScan() {
    const control = this.control.selectScanChainInTransaction(this.control.snapshot().activeChain ?? DEFAULT_SCAN_CHAIN);
    const chain = control.activeChain;
    const scheduler = readSchedulerStateInTransaction(this.storage, this.tenantId);
    const current = this.storage.sql.exec('SELECT cycle_id,key_epoch FROM cycle_checkpoint WHERE tenant_id=? AND chain=? ORDER BY updated_at DESC', this.tenantId, chain).toArray()
      .find(row => row.key_epoch === control.keyEpoch && scheduler.tasks.some(task => task.id === `scan:${row.cycle_id}`));
    if (current) return;
    const scanner = new RecoverableScanner({ store: new SqliteRecoverableScannerStore(this.storage, this.tenantId), settings: scannerSettings, now: this.now });
    const cycleId = `telegram:${chain}:${control.keyEpoch}:${this.now()}`;
    scanner.begin({ cycleId, chain, keyEpoch: control.keyEpoch, controlEpoch: control.controlEpoch, deadlineAt: this.now() + scannerSettings.auditCycleBudgetMs,
      onchainOffReason: onchainOffReason(chain, chainRpcUrls(this.env)), afterBegin: () => scheduleRecoverableScanTaskInTransaction(this.storage, this.tenantId, cycleId, this.now(), AVE_CU.trending) });
  }

  resume() {
    const scheduled = readSchedulerStateInTransaction(this.storage, this.tenantId).tasks.filter(task => task.kind === 'scan').map(task => task.id.slice(5));
    this.control.resumeWith(control => resumeRecoverableCheckpointsInTransaction(this.storage, this.tenantId, { cycleIds: scheduled, control, now: this.now() }), () => []);
    if (this.control.snapshot().configured) this.startScan();
  }

  selectScanChain(chain) {
    this.control.selectScanChainInTransaction(chain);
    if (this.control.snapshot().configured) this.startScan();
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
    const auth = this.storage.sql.exec('SELECT value_json FROM scheduler_state WHERE tenant_id=? AND key=?', this.tenantId, 'telegram.providerAuth').toArray()[0];
    if (auth && JSON.parse(auth.value_json).keyEpoch === control.keyEpoch && JSON.parse(auth.value_json).unusable) issues.push({ key: 'ave-unusable', reason: 'KEY_UNUSABLE', nextAction: '/onboard' });
    return issues;
  }

  deliveryIneligibleReason(row, payload) {
    // A new-lead alert is corrected after it is sent instead of cancelled before.
    if (payload.token && !payload.notification && payload.projectionRevision !== reviewProjectionRevision(this.storage, this.tenantId, payload.token, this.now())) return 'projection_changed';
    return this.notifications.ineligibleReason(row, payload, { issues: this.actionableIssues() });
  }

  // Recorded facts for a risk notice. They are optional: an unreadable one is left out, never allowed to drop the notice.
  riskTokenInTransaction(member) {
    const candidate = this.storage.sql.exec('SELECT symbol,secondary_json FROM candidates WHERE tenant_id=? AND chain=? AND address=?', this.tenantId, member.chain, member.address).toArray()[0];
    let security = null;
    try { security = candidate?.secondary_json == null ? null : JSON.parse(candidate.secondary_json)?.security; } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      console.log(JSON.stringify({ event: 'alert_fact_unreadable', chain: member.chain, address: member.address, fact: 'secondary' }));
    }
    return { chain: member.chain, address: member.address, symbol: candidate?.symbol ?? '',
      fatal: Array.isArray(security?.fatal) ? security.fatal.filter(item => typeof item?.field === 'string').map(item => ({ field: item.field, value: security.fields?.[item.field] ?? null })) : [] };
  }

  // The token's alert message, which a later notice about it replies to.
  alertMessageId(token) {
    const row = this.storage.sql.exec("SELECT message_id FROM ui_sessions WHERE tenant_id=? AND message_id IS NOT NULL AND expires_at>? AND ((json_extract(query_json,'$.originAlertToken.chain')=? AND json_extract(query_json,'$.originAlertToken.address')=?) OR (panel='alert' AND json_extract(query_json,'$.selectedToken.chain')=? AND json_extract(query_json,'$.selectedToken.address')=?)) ORDER BY rowid DESC LIMIT 1", this.tenantId, this.now(), token.chain, token.address, token.chain, token.address).toArray()[0];
    return row ? Number(row.message_id) : null;
  }

  // The facts new-lead alerts render from. An unreadable record never holds an alert back: the alert then shows the plain columns only.
  alertSnapshotInTransaction(tokens) {
    try { return readTelegramSnapshot(this.storage, this.tenantId, this.now()); } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      console.log(JSON.stringify({ event: 'alert_fact_unreadable', fact: 'snapshot' }));
      const candidates = tokens.flatMap(token => this.storage.sql.exec('SELECT chain,address,symbol,status,market_cap,liquidity,created_at,audited_at,review_revision FROM candidates WHERE tenant_id=? AND chain=? AND address=?', this.tenantId, token.chain, token.address).toArray())
        .map(row => projectTelegramCandidate({ chain: row.chain, address: row.address, symbol: row.symbol, status: row.status, marketCap: row.market_cap, liquidity: row.liquidity, createdAt: row.created_at, auditedAt: row.audited_at, reviewRevision: row.review_revision }));
      return { at: this.now(), candidates, feedByChain: {}, annotations: [], marks: [] };
    }
  }

  // A new lead gets its own alert, which is edited in place as its checks finish; risk and account notices are sent once.
  // Every alert's buttons last as long as the alert, and what they open arrives as a new message.
  reconcileNotificationsInTransaction() {
    const { notifications } = this.notifications.reconcileInTransaction({ issues: this.actionableIssues() });
    const leads = notifications.filter(item => item.actionReason === 'CANDIDATE_NEW' && !this.outbox.has(item.id)).map(item => item.members[0]);
    const snapshot = leads.length ? this.alertSnapshotInTransaction(leads) : null;
    for (const notification of notifications) {
      if (this.outbox.has(notification.id)) continue;
      const scanChain = this.control.snapshot().activeChain ?? DEFAULT_SCAN_CHAIN, member = notification.members[0];
      const token = member && { chain: member.chain, address: member.address };
      const panel = notification.actionReason === 'CANDIDATE_NEW' ? 'alert' : 'notice';
      const session = this.commands.sessions.createInTransaction(panel, token?.chain ?? scanChain, token ? { selectedToken: token } : {}, { ttl: ALERT_SESSION_TTL });
      let rendered, params = {};
      if (notification.actionReason === 'CANDIDATE_NEW') {
        rendered = renderPanel(snapshot, session, this.commands.language);
      } else {
        rendered = alertCard(notification, notification.members.map(item => this.riskTokenInTransaction(item)), { locale: this.commands.language });
        const replyTo = token ? this.alertMessageId(token) : null;
        if (replyTo !== null) params = { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } };
      }
      const tracked = notification.actionReason === 'CANDIDATE_NEW' ? { token, projectionRevision: reviewProjectionRevision(this.storage, this.tenantId, token, this.now()) } : {};
      this.outbox.enqueueInTransaction({ id: notification.id, chatId: this.tenantId, method: 'sendMessage', params: { ...params, text: rendered.text, parse_mode: 'HTML', reply_markup: { inline_keyboard: this.commands.sessions.bindKeyboardInTransaction(session, rendered.keyboard, this.control.snapshot()) }, link_preview_options: { is_disabled: true } }, sessionId: session.id, sessionVersion: session.version, deliveryClass: notification.deliveryClass, actionReason: notification.actionReason, notification, expiresAt: notification.expiresAt, ...tracked });
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
      const session = map.ui_session_id ? this.commands.sessions.get(map.ui_session_id) : null;
      if (!session || !['alert','detail','evidence'].includes(session.panel) || session.query.selectedToken?.address !== map.address || session.query.selectedToken?.chain !== map.chain) continue;
      // An alert keeps the last facts it showed once its token is no longer stored.
      if (session.panel === 'alert' && !this.storage.sql.exec('SELECT 1 FROM candidates WHERE tenant_id=? AND chain=? AND address=?', this.tenantId, map.chain, map.address).toArray().length) continue;
      const fingerprint = reviewProjectionRevision(this.storage, this.tenantId, token, this.now());
      const rendered = this.storage.sql.exec('SELECT value_json FROM scheduler_state WHERE tenant_id=? AND key=?', this.tenantId, `telegram.rendered:${map.message_id}`).toArray()[0];
      if (!rendered || JSON.parse(rendered.value_json) !== fingerprint) {
        const pending = this.outbox.correctionRows(session.id).some(row => this.outbox.payload(row)?.projectionRevision === fingerprint);
        if (!pending) {
          // An unreadable record skips this correction, logged, rather than stopping every reconcile.
          let snapshot;
          try { snapshot = this.commands.snapshot(this.storage, this.tenantId, this.now()); } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
            console.log(JSON.stringify({ event: 'card_correction_skipped', chain: map.chain, address: map.address, reason: 'record_unreadable' }));
            continue;
          }
          const next = { ...session, version: session.version + 1, snapshotAt: this.now() };
          this.commands.sessions.saveInTransaction(next);
          this.commands.renderInTransaction(next, { deliveryClass: 'PANEL_UPDATE', snapshot });
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
    // A pending key whose submission ended is never verified; drop it.
    const pending = this.storage.sql.exec('SELECT generation FROM keys WHERE tenant_id=? AND name=?', this.tenantId, CONNECTION_KEY_NAMES.PENDING_KEY_NAME).toArray()[0];
    if (pending && !this.storage.sql.exec("SELECT update_id FROM inbox WHERE tenant_id=? AND command_type='credential' AND generation=? AND status IN ('RECEIVED','RUNNING')", this.tenantId, pending.generation).toArray().length) this.storage.sql.exec('DELETE FROM keys WHERE tenant_id=? AND name=? AND generation=?', this.tenantId, CONNECTION_KEY_NAMES.PENDING_KEY_NAME, pending.generation);
    this.reconcileRequestedPanelsInTransaction();
    const correctionsAt = this.reconcileCardsInTransaction();
    this.reconcileNotificationsInTransaction();
    const state = readSchedulerStateInTransaction(this.storage, this.tenantId);
    const ownedOutbox = new Set(this.outbox.ids().map(row => `outbox:${row.id}`));
    const tasks = (suppliedTasks ?? state.tasks).filter(task => !ownedOutbox.has(task.id) && task.id !== 'telegram:corrections' && task.id !== 'telegram:expiry' && !task.id.startsWith('inbox:') && task.kind !== 'trade' && task.kind !== 'lookup');
    tasks.push(...this.trading.tasksInTransaction(state.runtime.retries), ...this.lookups.tasksInTransaction(state.runtime.retries));
    this.outbox.scrubSecretsInTransaction();
    tasks.push(...state.tasks.filter(task => task.id.startsWith('inbox:')));
    const expiry = this.storage.sql.exec("SELECT MIN(expires_at) AS at FROM inbox WHERE tenant_id=? AND status IN ('RECEIVED','RUNNING')", this.tenantId).toArray()[0]?.at;
    if (Number.isSafeInteger(expiry)) tasks.push({ id: 'telegram:expiry', kind: 'local-control', dueAt: expiry, enabled: true, aveCost: 0 });
    if (correctionsAt !== null) tasks.push({ id: 'telegram:corrections', kind: 'local-control', dueAt: correctionsAt, enabled: true, aveCost: 0 });
    tasks.push(...this.outbox.reconcileInTransaction({ recoverSending: recover }));
    const current = readSchedulerStateInTransaction(this.storage, this.tenantId);
    writeSchedulerStateInTransaction(this.storage, this.tenantId, { ...current, tasks });
    this.commands.sessions.pruneInTransaction();
    return tasks;
  }
}
