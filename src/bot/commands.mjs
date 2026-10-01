import { renderPanel } from './panels.mjs';
import { readTelegramSnapshot, tokenIdentity } from './snapshot.mjs';
import { NOTIFICATION_PANELS, TelegramSessions } from './sessions.mjs';
import { annotateInTransaction, ReviewConflict, setManualMarkInTransaction, reviewProjectionRevision } from './review.mjs';
import { DEFAULT_SCAN_CHAIN, SCAN_CHAINS as CHAINS } from '../chains.mjs';
import { TradeRefusal } from '../trading/engine.mjs';
import { LookupError, LOOKUP_SETTINGS } from '../lookup.mjs';
import { TRADING_SETTINGS } from '../trading/config.mjs';
import { parseUsdCents, parsePercent } from '../trading/amounts.mjs';
import { saveTradingWalletInTransaction, removeTradingWalletInTransaction, tradingWalletEnvelope, readTradingWallet } from '../trading/wallet.mjs';
import { button, chainLabel, ICONS } from '../render/telegram.mjs';

// Typed commands that open a panel. Retired slugs are deliberately absent: an
// unknown command opens Help, which lists the current names.
const COMMAND_PANELS = new Map(Object.entries({ start: 'radar', radar: 'radar', leads: 'audits', hot: 'feed', watchlist: 'saved', wallet: 'wallet', performance: 'stats', settings: 'settings', help: 'help', activity: 'events', status: 'status', chains: 'chains', onboard: 'onboard' }));
const ALL_CHAIN_PANELS = new Set(['saved','events']);
const CONCRETE_CHAIN_PANELS = new Set(['feed','audits','stats']);
const CONTROL = new Set(['pause','resume','disconnect','mute']);
const text = (lang, zh, en) => lang === 'en' ? en : zh;
const INPUT_KINDS = new Set(['search','note','note_target','trade_usd','trade_percent']);
const WALLET_PANELS = new Set(['wallet','wallet_export','wallet_remove']);
const REFUSALS = {
  NOT_TRADABLE: ['此链不支持交易。', 'Trading is not available on this chain.'],
  NO_WALLET: ['请先在 /wallet 创建交易钱包。', 'Create a trading wallet under /wallet first.'],
  INVALID_TOKEN: ['此代币无法交易。', 'This token cannot be traded.'],
  VETOED: ['安全核验未通过，已拒绝买入。卖出不受影响。', 'Safety check failed; the buy was refused. Selling is not affected.'],
  INVALID_AMOUNT: ['金额无效。', 'The amount is invalid.'],
  STATE_CHANGED: ['交易状态已变化，未执行旧操作。', 'The trade changed; the old action was not applied.'],
  BUSY: ['另一笔交易正在执行，请等待它完成后再确认。', 'Another trade is executing; confirm again after it finishes.'],
  TRADES_OPEN: ['仍有进行中或结果未知的交易，暂不能移除钱包。请打开钱包点击刷新，待回执确认结果后再试。', 'A trade is still open or its outcome unknown, so the wallet cannot be removed yet. Refresh the wallet until the receipts resolve it, then try again.'],
  EXPORT_FIRST: ['钱包仍有余额且私钥从未导出，请先导出私钥。', 'The wallet still holds funds and its key was never exported; export it first.']
};
/** How a prompt names a token: "PEPE (Arc)", or its address when no symbol is recorded. */
function tokenName(snapshot, token) {
  const rows = [...(snapshot.candidates ?? []), ...(snapshot.feedByChain?.[token.chain]?.rows ?? []), ...(snapshot.annotations ?? [])];
  const symbol = rows.find(row => row.chain === token.chain && row.address === token.address && row.symbol && row.symbol !== '?')?.symbol;
  return `${symbol ?? token.address} (${chainLabel(token.chain)})`;
}
const tradeView = (tradeId, returnTo) => ({ panel: 'trade', query: { schemaVersion: 1, page: 0, tradeId, returnTo } });
// An unverified buy waits for the owner's Yes; the session holds exactly the buy the engine refused.
const unverifiedQuestion = (request, returnTo) => ({ panel: 'trade_unverified', query: { schemaVersion: 1, page: 0, unverifiedBuy: request, returnTo } });

export class TelegramCommands {
  constructor({ storage, tenantId, inbox, outbox, controls, lookups, trading = null, now = Date.now, snapshot = readTelegramSnapshot }) {
    Object.assign(this, { storage, tenantId, inbox, outbox, controls, lookups, trading, now, snapshot });
    this.sessions = new TelegramSessions({ storage, tenantId, now });
  }

  preference(key, fallback) {
    const row = this.storage.sql.exec('SELECT value_json FROM preferences WHERE tenant_id = ? AND key = ?', this.tenantId, `telegram.${key}`).toArray()[0];
    return row ? JSON.parse(row.value_json) : fallback;
  }

  setPreference(key, value) {
    this.storage.sql.exec('INSERT INTO preferences (tenant_id,key,value_json) VALUES (?,?,?) ON CONFLICT(tenant_id,key) DO UPDATE SET value_json=excluded.value_json', this.tenantId, `telegram.${key}`, JSON.stringify(value));
  }

  get language() { return this.preference('language', 'zh'); }

  noticeInTransaction(updateId, message) {
    this.outbox.enqueueInTransaction({ id: `notice:${updateId}`, chatId: this.tenantId, method: 'sendMessage', params: { text: message, link_preview_options: { is_disabled: true } }, expiresAt: this.now() + 900_000 });
  }

  renderInTransaction(session, { deliveryClass = 'USER_RESPONSE', snapshot = this.snapshot(this.storage, this.tenantId, this.now()) } = {}) {
    const rendered = renderPanel(snapshot, session, this.language);
    // A notice is shown by exactly one render.
    if (session.query.notice !== undefined) {
      const { notice, ...query } = session.query;
      this.sessions.saveInTransaction({ ...session, query });
    }
    const control = this.controls.snapshot();
    const keyboard = session.expiresAt > this.now() ? this.sessions.bindKeyboardInTransaction(session, rendered.keyboard, control) : [];
    const token = rendered.token ?? (['detail','evidence'].includes(session.panel) ? session.query.selectedToken : null);
    const revision = token ? this.storage.sql.exec('SELECT review_revision FROM candidates WHERE tenant_id=? AND chain=? AND address=?', this.tenantId, token.chain, token.address).toArray()[0]?.review_revision ?? null : null;
    this.outbox.enqueueInTransaction({ id: `panel:${session.id}:${session.version}`, chatId: this.tenantId,
      method: session.messageId ? 'editMessageText' : 'sendMessage', params: { ...(session.messageId ? { message_id: session.messageId } : {}), text: rendered.text, parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard }, link_preview_options: { is_disabled: true } },
      sessionId: session.id, sessionVersion: session.version, desiredRevision: revision, token, projectionRevision: token ? reviewProjectionRevision(this.storage, this.tenantId, token, this.now()) : null, deliveryClass, expiresAt: deliveryClass === 'PANEL_UPDATE' ? this.now() + 900_000 : session.expiresAt });
    return session;
  }

  immediateInTransaction(row) {
    if (row.command_type === 'secret_warning') {
      this.secretWarningInTransaction(row);
      this.inbox.finishInTransaction(row.update_id, 'DONE');
      return true;
    }
    if (row.command_type === 'callback') {
      const payload = JSON.parse(row.payload_json);
      const link = this.storage.sql.exec('SELECT action FROM shortlinks WHERE tenant_id=? AND id=?', this.tenantId, payload.callbackId).toArray()[0];
      if (!['scan.pause','scan.resume','connection.disconnect','notifications.set'].includes(link?.action)) return false;
      this.processInTransaction(row);
      return true;
    }
    const command = row.command_type.replace(/^command:/, '');
    if (!CONTROL.has(command)) return false;
    const args = JSON.parse(row.payload_json).arguments ?? '';
    if (args) this.noticeInTransaction(row.update_id, `/${command}`);
    else this.applyControl(command);
    const session = this.sessions.createInTransaction('settings', this.controls.snapshot().activeChain ?? DEFAULT_SCAN_CHAIN);
    this.renderInTransaction(session);
    this.inbox.finishInTransaction(row.update_id, 'DONE');
    return true;
  }

  applyControl(command) {
    if (command === 'pause') this.controls.pause();
    else if (command === 'resume') this.controls.resume();
    else if (command === 'disconnect') this.controls.disconnect();
    // /mute toggles alerts, which are on until a tenant turns them off.
    else if (command === 'mute') this.setNotifications(this.preference('notifications', true) === false);
  }

  setNotifications(enabled) {
    this.setPreference('notifications', enabled);
    this.setPreference('notificationsVersion', this.preference('notificationsVersion', 0) + 1);
    this.controls.resetNotificationBaseline?.();
  }

  processInTransaction(row, prepared = null) {
    const payload = JSON.parse(row.payload_json);
    try {
      if (row.command_type === 'callback') this.callbackInTransaction(row, payload, prepared);
      else if (row.command_type === 'reply') this.replyInTransaction(payload);
      else if (row.command_type === 'lookup') this.lookupInTransaction(row, payload);
      else if (row.command_type === 'text') this.hintInTransaction(row);
      else this.commandInTransaction(row, payload);
      this.inbox.finishInTransaction(row.update_id, 'DONE');
    } catch (error) {
      if (!(error instanceof ReviewConflict)) throw error;
      this.noticeInTransaction(row.update_id, text(this.language, '内容或操作已失效，未执行旧操作。请使用 /radar 重新打开。', 'Content or action expired; the old action was not applied. Reopen with /radar.'));
      this.inbox.finishInTransaction(row.update_id, 'FAILED', { reason: error.code });
    }
  }

  /** A message that held a private key: delete it and say why. Intake already dropped its text. */
  secretWarningInTransaction(row) {
    this.outbox.enqueueInTransaction({ id: `delete:${row.update_id}`, chatId: this.tenantId, method: 'deleteMessage', params: { message_id: row.source_message_id }, expiresAt: this.now() + 900_000 });
    this.noticeInTransaction(row.update_id, text(this.language,
      '你的消息看起来含有私钥（64位十六进制、Solana私钥或PEM密钥），因此我尝试删除了它。如果那只是交易哈希，无需处理。切勿在此发送私钥；删除无法保证，请确认消息已消失。',
      'I tried to delete your message because it looked like it held a private key (64 hex characters, a Solana secret key or a PEM key). If it was only a transaction hash, nothing else is needed. Never send keys here; deletion is not guaranteed, so check that the message is gone.'));
  }

  /** A pasted contract address is looked up on the scan chain; the detail's chain buttons try the others. */
  lookupInTransaction(row, payload) {
    const chain = this.controls.snapshot().activeChain ?? DEFAULT_SCAN_CHAIN;
    // A refused lookup leaves the radar under its banner.
    const session = this.sessions.createInTransaction('radar', chain);
    this.renderInTransaction(this.sessions.advanceInTransaction(session, this.lookupChangesInTransaction(session, { chain, address: payload.address })));
  }

  /**
   * Session changes that show a pasted token: a token known locally opens at once
   * and spends nothing; otherwise a lookup is started (or reused) and bound to the
   * session, which needs AVE connected. A full lookup queue leaves the panel under a banner.
   */
  lookupChangesInTransaction(session, token, retry = false) {
    const snapshot = this.snapshot(this.storage, this.tenantId, this.now()), key = tokenIdentity(token.chain, token.address);
    const known = [...snapshot.candidates, ...(snapshot.feedByChain?.[token.chain]?.rows ?? []), ...snapshot.annotations].some(row => row.chain === token.chain && tokenIdentity(row.chain, row.address) === key);
    if (!known && !this.controls.snapshot().configured) {
      return { panel: 'onboard', query: { schemaVersion: 1, page: 0, notice: text(this.language, '查询代币需要先连接AVE。', 'Looking up a token needs AVE. Connect it first.') } };
    }
    if (!known) {
      try { this.lookups.startInTransaction({ ...token, sessionId: session.id, retry }); } catch (error) {
        if (error?.code !== 'LOOKUP_QUEUE_FULL' || !(error instanceof LookupError)) throw error;
        const max = LOOKUP_SETTINGS.pending;
        return { query: { ...session.query, notice: text(this.language, `已有${max}个查询在等待，请等其中一个完成后再试。`, `${max} lookups are already waiting; try again when one finishes.`) } };
      }
    }
    return { panel: 'detail', viewChain: token.chain, query: { schemaVersion: 1, page: 0, selectedToken: token } };
  }

  /** Text the bot does not act on gets a pointer instead of silence. Intake dropped the text itself. */
  hintInTransaction(row) {
    const L = (zh, en) => text(this.language, zh, en);
    const session = this.sessions.createInTransaction('radar', this.controls.snapshot().activeChain ?? DEFAULT_SCAN_CHAIN);
    const keyboard = [[button(`${ICONS.radar} ${L('雷达', 'Radar')}`, 'panel.open', { panel: 'radar' }), button(`${ICONS.help} ${L('帮助', 'Help')}`, 'panel.open', { panel: 'help' })]];
    this.outbox.enqueueInTransaction({ id: `hint:${row.update_id}`, chatId: this.tenantId, method: 'sendMessage',
      params: { text: L(`粘贴代币合约地址即可查询，或打开 ${ICONS.radar} 雷达。`, `Paste a token contract address to look it up, or open ${ICONS.radar} Radar.`), reply_markup: { inline_keyboard: this.sessions.bindKeyboardInTransaction(session, keyboard, this.controls.snapshot()) }, link_preview_options: { is_disabled: true } },
      sessionId: session.id, sessionVersion: session.version, expiresAt: session.expiresAt });
  }

  commandInTransaction(row, payload) {
    const command = row.command_type.replace(/^command:/, '');
    const args = payload.arguments ?? '';
    if (CONTROL.has(command)) return this.immediateInTransaction(row);
    const chain = this.controls.snapshot().activeChain ?? DEFAULT_SCAN_CHAIN;
    if (command === 'cancel') {
      if (args) return this.noticeInTransaction(row.update_id, '/cancel');
      for (const saved of this.storage.sql.exec('SELECT id FROM ui_sessions WHERE tenant_id=?', this.tenantId).toArray()) {
        const session = this.sessions.get(saved.id);
        if (session.query.pendingInput && (!payload.replyToMessageId || session.query.pendingInput.promptMessageId === payload.replyToMessageId)) {
          const { pendingInput, ...query } = session.query;
          this.renderInTransaction(this.sessions.advanceInTransaction(session, { query }));
        }
      }
      return;
    }
    if (command === 'lang') {
      if (args && !['zh','en'].includes(args)) return this.noticeInTransaction(row.update_id, '/lang zh | /lang en');
      if (args) this.setPreference('language', args);
      return this.renderInTransaction(this.sessions.createInTransaction(args ? 'settings' : 'language', chain));
    }
    if (command === 'setkey') return this.noticeInTransaction(row.update_id, text(this.language, '发送 /setkey <AVE API Key>。含密钥的消息可能留在聊天记录，请检查并删除。', 'Send /setkey <AVE API key>. Key messages may remain in chat history; check and delete them.'));
    if (command === 'export') {
      if (args) return this.noticeInTransaction(row.update_id, '/export');
      return this.exportInTransaction(row.update_id);
    }
    if (command === 'note') {
      if (args.length > 128) return this.noticeInTransaction(row.update_id, text(this.language, '请输入最多128字符的名称、简称或CA。', 'Use a name, symbol or contract address of at most 128 characters.'));
      const session = this.sessions.createInTransaction('saved', 'all');
      if (args) return this.resolveNoteInTransaction(session, args);
      return this.beginInputInTransaction(session, 'note_target');
    }
    const panel = COMMAND_PANELS.get(command);
    if (!panel) return this.renderInTransaction(this.sessions.createInTransaction('help', chain));
    if (args) return this.noticeInTransaction(row.update_id, `/${command}`);
    if (command === 'start') this.controls.initializeNotificationBaseline?.();
    const session = this.sessions.createInTransaction(panel, ALL_CHAIN_PANELS.has(panel) ? 'all' : chain);
    if (panel === 'wallet') this.trading?.requestBalancesInTransaction(session.id);
    this.renderInTransaction(session);
  }

  callbackInTransaction(row, payload, prepared = null) {
    const binding = this.sessions.resolveInTransaction({ tenantId: this.tenantId, actorUserId: row.actor_user_id, sourceMessageId: row.source_message_id, payload });
    let { session, action, params, token } = binding;
    const control = this.controls.snapshot();
    // A notification stays as sent, keeping its buttons; whatever they open arrives as a new message with no way back to it.
    const fromAlert = NOTIFICATION_PANELS.has(session.panel);
    // Muting from a days-old alert means "alerts off now", whatever changed since, so it skips the staleness checks.
    const muteFromAlert = fromAlert && action === 'notifications.set' && params.value === false;
    if (/^(scan\.|chains\.set|notifications\.)/.test(action) && !muteFromAlert && binding.expectedControlEpoch !== control.controlEpoch) throw new ReviewConflict('control_changed');
    if (/^connection\./.test(action) && binding.expectedConnectionGeneration !== control.connectionGeneration) throw new ReviewConflict('connection_changed');
    if (action === 'notifications.set' && !muteFromAlert && params.expectedPreferenceVersion !== this.preference('notificationsVersion', 0)) throw new ReviewConflict('settings_changed');
    let changes = {};
    const scanChain = CHAINS.includes(control.activeChain) ? control.activeChain : DEFAULT_SCAN_CHAIN;
    // Radar is the root: Home starts navigation afresh, on the scan chain, instead of stacking a path back.
    const home = { panel: 'radar', viewChain: scanChain, query: { schemaVersion: 1, page: 0 } };
    if (action === 'panel.open') {
      const panel = params.panel;
      if (typeof panel !== 'string' || NOTIFICATION_PANELS.has(panel)) throw new ReviewConflict('invalid_panel');
      const returnTo = structuredClone({ panel: session.panel, viewChain: session.viewChain, query: { ...session.query, pendingInput: undefined } });
      let ancestor = returnTo;
      for (let depth = 1; ancestor?.query?.returnTo; depth++) { if (depth >= 4) { delete ancestor.query.returnTo; break; } ancestor = ancestor.query.returnTo; }
      // A button opens the same scope as its command: the Watchlist and Activity span every chain.
      const viewChain = ALL_CHAIN_PANELS.has(panel) ? 'all' : CONCRETE_CHAIN_PANELS.has(panel) && !CHAINS.includes(session.viewChain) ? scanChain : session.viewChain;
      changes = panel === 'radar' ? home
        : { panel, viewChain, query: { ...(fromAlert ? {} : session.query), schemaVersion: 1, page: 0, pendingInput: undefined, ...(params.query ?? {}), ...(fromAlert ? {} : { returnTo }), ...(token ? { selectedToken: token } : {}) } };
    } else if (action === 'panel.back') {
      const origin = session.query.returnTo;
      changes = origin ? { panel: origin.panel, viewChain: origin.viewChain, query: origin.query } : home;
    } else if (action === 'panel.refresh') { /* Re-render current facts. */ }
    else if (action === 'page.set') changes = { query: { ...session.query, [session.panel === 'evidence' ? 'detailPage' : 'page']: params.page } };
    else if (action === 'view_chain.set') {
      if (![...CHAINS,'all'].includes(params.value)) throw new ReviewConflict('invalid_chain');
      changes = { viewChain: params.value, panel: session.query.returnTo?.panel ?? 'radar', query: { ...(session.query.returnTo?.query ?? {}), page: 0 } };
    } else if (['filter.set','sort.set','horizon.set','cohort.set'].includes(action)) {
      const field = action.split('.')[0];
      changes = { panel: session.query.returnTo?.panel ?? session.panel, query: { ...(session.query.returnTo?.query ?? session.query), [field]: params.value, page: 0 } };
    } else if (action === 'search.clear') changes = { query: { ...session.query, search: '', page: 0 } };
    else if (action === 'note.select') {
      const selected = this.sessions.advanceInTransaction(session, { panel: 'detail', viewChain: token.chain, query: { selectedToken: token } });
      return this.beginInputInTransaction(selected, 'note', token, this.controls.annotationVersion(token, 'note'));
    }
    else if (action === 'input.begin' || action === 'note.begin') return this.beginInputInTransaction(session, action === 'note.begin' ? 'note' : params.kind, token, params.expectedAnnotationVersion);
    else if (action === 'input.cancel') { const { pendingInput, ...query } = session.query; changes = { query }; }
    else if (['mark.set_passed','mark.set_ignored','mark.clear'].includes(action)) setManualMarkInTransaction(this.storage, this.tenantId, { token, decision: action === 'mark.clear' ? null : action === 'mark.set_passed' ? 'passed' : 'ignored', expectedMarkVersion: binding.expectedMarkVersion, reviewRevision: binding.reviewRevision }, this.now());
    else if (action === 'favorite.set' || action === 'note.clear') annotateInTransaction(this.storage, this.tenantId, { token, field: action === 'favorite.set' ? 'favorite' : 'note', value: action === 'favorite.set' ? params.value : '', expectedVersion: params.expectedAnnotationVersion }, this.now());
    else if (action === 'scan.pause' || action === 'scan.resume') this.applyControl(action.split('.')[1]);
    else if (action === 'notifications.set') { if (typeof params.value !== 'boolean') throw new ReviewConflict('invalid_notifications'); this.setNotifications(params.value); }
    else if (action === 'delivery.acknowledge') this.outbox.acknowledgeIssuesInTransaction();
    else if (action === 'connection.disconnect') { this.applyControl('disconnect'); changes = { panel: 'settings', query: {} }; }
    else if (action === 'language.set') { if (!['zh','en'].includes(params.value)) throw new ReviewConflict('invalid_language'); this.setPreference('language', params.value); changes = session.panel === 'language' ? { panel: 'settings', query: {} } : {}; }
    else if (action === 'chains.set') {
      if (!CHAINS.includes(params.value)) throw new ReviewConflict('invalid_chain');
      this.controls.selectScanChain(params.value);
      changes = { viewChain: params.value };
    }
    else if (action === 'export.create') this.exportInTransaction(row.update_id);
    else if (action === 'lookup.start') {
      if (!token) throw new ReviewConflict('invalid_token');
      changes = this.lookupChangesInTransaction(session, token, params.retry === true);
    }
    else if (/^(trade|trading|wallet)\./.test(action)) {
      changes = this.tradingActionInTransaction(row, session, action, params, token, prepared);
      if (changes === null) return;
    }
    else throw new ReviewConflict('unsupported_action');
    if (fromAlert) {
      const target = changes.panel ? changes : { panel: 'settings', viewChain: scanChain, query: {} };
      return this.renderInTransaction(this.sessions.createInTransaction(target.panel, target.viewChain ?? session.viewChain, target.query));
    }
    session = this.sessions.advanceInTransaction(session, changes);
    this.renderInTransaction(session);
  }

  tradingSettings() {
    return { slippageBps: this.preference('tradingSlippageBps', TRADING_SETTINGS.slippageBps), capUsd: this.preference('tradingBuyCapUsd', TRADING_SETTINGS.buyCapUsd) };
  }

  /** The banner explaining a trade refusal. */
  refusalNotice(refusal) {
    const cap = this.tradingSettings().capUsd;
    const message = refusal.code === 'OVER_CAP' ? [`超过单笔买入上限 $${cap}，已拒绝。可在交易限额中调整。`, `Above your per-trade buy cap of $${cap}; refused. Adjust it in Trade limits.`] : REFUSALS[refusal.code] ?? REFUSALS.STATE_CHANGED;
    return text(this.language, ...message);
  }

  /** Session changes for a trading action; a refusal leaves the panel as it was under a banner explaining it, except that an unverified buy becomes its Yes/No question. */
  tradingActionInTransaction(row, session, action, params, token, prepared) {
    if (!this.trading) throw new ReviewConflict('trading_unavailable');
    const returnTo = ['trade', 'trade_unverified'].includes(session.panel) ? session.query.returnTo : { panel: session.panel, viewChain: session.viewChain, query: { ...session.query, pendingInput: undefined } };
    const show = trade => tradeView(trade.id, returnTo);
    // A wallet action lands on the wallet, and Back leaves the wallet: it must never
    // reopen a spent dialog such as "Send the private key" or a removed wallet's warning.
    let exit = { panel: session.panel, viewChain: session.viewChain, query: session.query };
    while (exit && WALLET_PANELS.has(exit.panel)) exit = exit.query?.returnTo;
    const wallet = { panel: 'wallet', query: { schemaVersion: 1, page: 0, ...(exit ? { returnTo: { ...exit, query: { ...exit.query, pendingInput: undefined } } } : {}) } };
    try {
      if (action === 'trade.buy' || action === 'trade.sell') {
        if (!token) throw new ReviewConflict('invalid_token');
        const amount = action === 'trade.buy' ? { usdCents: Number.isSafeInteger(params.usd) ? params.usd * 100 : null } : { percent: params.percent };
        return show(this.startTradeInTransaction(session, token, action === 'trade.buy' ? 'buy' : 'sell', amount));
      }
      if (action === 'trade.acknowledge_unverified' || action === 'trade.decline_unverified') {
        const request = session.panel === 'trade_unverified' ? session.query.unverifiedBuy : null;
        if (!request) throw new ReviewConflict('invalid_confirmation');
        const back = { panel: returnTo.panel, viewChain: returnTo.viewChain, query: returnTo.query };
        if (action === 'trade.decline_unverified') return back;
        try {
          return show(this.startTradeInTransaction(session, { chain: request.chain, address: request.token }, 'buy', { usdCents: request.usdCents }, true));
        } catch (error) {
          // A refused Yes (vetoed meanwhile, or now above the cap) must not leave the question open.
          if (!(error instanceof TradeRefusal)) throw error;
          return { ...back, query: { ...back.query, notice: this.refusalNotice(error) } };
        }
      }
      if (action === 'trade.input') {
        if (!token || !['buy','sell'].includes(params.side)) throw new ReviewConflict('invalid_input');
        this.beginInputInTransaction(session, params.side === 'buy' ? 'trade_usd' : 'trade_percent', token);
        return null;
      }
      if (action === 'trade.confirm') return show(this.trading.confirmInTransaction(params.tradeId, this.tradingSettings()).trade);
      if (action === 'trade.cancel') { this.trading.cancelInTransaction(params.tradeId); return {}; }
      if (action === 'trade.requote') return show(this.trading.requoteInTransaction(params.tradeId, this.tradingSettings()));
      if (action === 'trade.recheck') { this.trading.recheckUnknownInTransaction(); return {}; }
      if (action === 'trading.slippage.set' || action === 'trading.cap.set') {
        const [key, choices] = action === 'trading.slippage.set' ? ['tradingSlippageBps', TRADING_SETTINGS.slippageChoicesBps] : ['tradingBuyCapUsd', TRADING_SETTINGS.buyCapChoicesUsd];
        if (!choices.includes(params.value)) throw new ReviewConflict('invalid_setting');
        this.setPreference(key, params.value);
        return {};
      }
      if (action === 'wallet.create') {
        if (!readTradingWallet(this.storage, this.tenantId)) {
          if (!prepared?.wallet) throw new ReviewConflict('wallet_unprepared');
          saveTradingWalletInTransaction(this.storage, this.tenantId, prepared.wallet, this.now());
        }
        this.trading.requestBalancesInTransaction(session.id);
        return wallet;
      }
      if (action === 'wallet.refresh') { this.trading.requestBalancesInTransaction(session.id); this.trading.recheckUnknownInTransaction(); return {}; }
      if (action === 'wallet.export') {
        const envelope = tradingWalletEnvelope(this.storage, this.tenantId);
        if (!envelope) throw new TradeRefusal('NO_WALLET');
        // The outbox keeps only the encrypted key; the transport decrypts it for this one send.
        this.outbox.enqueueInTransaction({ id: `wallet-export:${row.update_id}`, chatId: this.tenantId, method: 'sendMessage', params: { secret: envelope, parse_mode: 'HTML', link_preview_options: { is_disabled: true } }, purpose: 'secret', expiresAt: this.now() + 300_000 });
        return wallet;
      }
      if (action === 'wallet.remove') {
        this.trading.assertRemovableInTransaction();
        if (this.trading.exportRequiredBeforeRemoval()) throw new TradeRefusal('EXPORT_FIRST');
        this.outbox.cancelPendingSecretsInTransaction();
        removeTradingWalletInTransaction(this.storage, this.tenantId);
        return wallet;
      }
    } catch (error) {
      if (!(error instanceof TradeRefusal)) throw error;
      if (error.code === 'UNVERIFIED') return unverifiedQuestion(error.request, returnTo);
      return { query: { ...session.query, notice: this.refusalNotice(error) } };
    }
    throw new ReviewConflict('unsupported_action');
  }

  startTradeInTransaction(session, token, side, amount, unverifiedAcknowledged = false) {
    return this.trading.requestTradeInTransaction({ chain: token.chain, token: token.address, side, ...amount, sessionId: session.id, ...this.tradingSettings(), unverifiedAcknowledged });
  }

  beginInputInTransaction(session, kind, token = null, expectedVersion = null) {
    if (!INPUT_KINDS.has(kind)) throw new ReviewConflict('invalid_input');
    const outboxId = `prompt:${session.id}:${session.version + 1}`;
    const next = this.sessions.advanceInTransaction(session, { query: { ...session.query, pendingInput: { kind, target: token, expectedVersion, outboxId, promptMessageId: null, expiresAt: Math.min(this.now() + 300_000, session.expiresAt) } } });
    const snapshot = this.snapshot(this.storage, this.tenantId, this.now());
    this.renderInTransaction(next, { snapshot });
    const cap = this.tradingSettings().capUsd, name = token ? tokenName(snapshot, token) : null;
    const instruction = kind === 'note' ? text(this.language, `请回复 ${name} 的备注，最多500字符。/cancel 取消。`, `Reply with a note for ${name}, max 500 characters. /cancel to stop.`)
      : kind === 'trade_usd' ? text(this.language, `请回复买入 ${name} 的美元金额，最多2位小数，上限 $${cap}。/cancel 取消。`, `Reply with the USD amount of ${name} to buy, up to 2 decimals, cap $${cap}. /cancel to stop.`)
        : kind === 'trade_percent' ? text(this.language, `请回复卖出 ${name} 的比例，1–100的整数。/cancel 取消。`, `Reply with the percentage of ${name} to sell, a whole number 1–100. /cancel to stop.`)
          : text(this.language, '请回复名称、简称或CA，最多128字符。/cancel 取消。', 'Reply with a name, symbol or contract address, max 128 characters. /cancel to stop.');
    this.outbox.enqueueInTransaction({ id: outboxId, chatId: this.tenantId, method: 'sendMessage', params: { text: instruction, reply_markup: { force_reply: true, selective: true } }, purpose: 'prompt', sessionId: next.id, sessionVersion: next.version, expiresAt: next.query.pendingInput.expiresAt });
  }

  replyInTransaction(payload) {
    const session = this.sessions.promptSession(payload.replyToMessageId);
    if (!session) throw new ReviewConflict('input_expired');
    const pending = session.query.pendingInput;
    const value = payload.text;
    if (typeof value !== 'string' || value.length > (pending.kind === 'note' ? 500 : 128)) {
      return this.renderInTransaction(this.sessions.advanceInTransaction(session, { query: { ...session.query, notice: text(this.language, '输入过长，请缩短后回复原提示。', 'Input is too long; shorten it and reply to the original prompt.') } }));
    }
    if (pending.kind === 'note_target') return this.resolveNoteInTransaction(session, value);
    if (pending.kind === 'trade_usd' || pending.kind === 'trade_percent') return this.tradeReplyInTransaction(session, pending, value);
    if (pending.kind === 'note') annotateInTransaction(this.storage, this.tenantId, { token: pending.target, field: 'note', value, expectedVersion: pending.expectedVersion }, this.now());
    const { pendingInput, ...query } = session.query;
    this.renderInTransaction(this.sessions.advanceInTransaction(session, { query: { ...query, ...(pending.kind === 'search' ? { search: value, page: 0 } : {}) } }));
  }

  tradeReplyInTransaction(session, pending, value) {
    const buy = pending.kind === 'trade_usd';
    const amount = buy ? { usdCents: parseUsdCents(value) } : { percent: parsePercent(value) };
    if (Object.values(amount)[0] === null) {
      const notice = text(this.language, buy ? '金额无效：请回复如 25 或 12.5。' : '比例无效：请回复1–100的整数。', buy ? 'Invalid amount: reply like 25 or 12.5.' : 'Invalid percentage: reply with a whole number from 1 to 100.');
      return this.renderInTransaction(this.sessions.advanceInTransaction(session, { query: { ...session.query, notice } }));
    }
    const { pendingInput, ...query } = session.query;
    const returnTo = { panel: session.panel, viewChain: session.viewChain, query };
    let changes;
    try { changes = tradeView(this.startTradeInTransaction(session, pending.target, buy ? 'buy' : 'sell', amount).id, returnTo); } catch (error) {
      if (!(error instanceof TradeRefusal)) throw error;
      if (error.code !== 'UNVERIFIED') return this.renderInTransaction(this.sessions.advanceInTransaction(session, { query: { ...query, notice: this.refusalNotice(error) } }));
      changes = unverifiedQuestion(error.request, returnTo);
    }
    this.renderInTransaction(this.sessions.advanceInTransaction(session, changes));
  }

  resolveNoteInTransaction(session, value) {
    const snapshot = this.snapshot(this.storage, this.tenantId, this.now());
    const rows = [...(snapshot.candidates ?? []), ...Object.values(snapshot.feedByChain ?? {}).flatMap(feed => feed.rows), ...(snapshot.annotations ?? [])];
    const unique = [...new Map(rows.map(row => [`${row.chain}:${row.address}`, row])).values()];
    const exact = unique.filter(row => row.address?.toLowerCase() === value.toLowerCase());
    const symbol = unique.filter(row => row.symbol?.toLowerCase() === value.toLowerCase());
    const matches = exact.length ? exact : symbol.length ? symbol : unique.filter(row => [row.symbol,row.name,row.address].some(item => typeof item === 'string' && item.toLowerCase().includes(value.toLowerCase())));
    if (matches.length === 1) {
      const token = { chain: matches[0].chain, address: matches[0].address };
      const next = this.sessions.advanceInTransaction(session, { panel: 'detail', viewChain: token.chain, query: { selectedToken: token } });
      // Annotation version is read at prompt creation, not from an old detail projection.
      return this.beginInputInTransaction(next, 'note', token, this.controls.annotationVersion(token, 'note'));
    }
    this.renderInTransaction(this.sessions.advanceInTransaction(session, { panel: 'saved', query: { search: value, page: 0, noteTargetMatches: matches.map(row => ({ chain: row.chain, address: row.address })) } }));
  }

  exportInTransaction(updateId) {
    const data = this.controls.exportRecords();
    const content = JSON.stringify(data, null, 2);
    if (new TextEncoder().encode(content).byteLength > 10 * 1024 * 1024) return this.noticeInTransaction(updateId, text(this.language, '导出超过10MB限制，无法发送；请联系部署管理员。', 'Export exceeds the 10 MB limit and cannot be sent; contact the deployment administrator.'));
    this.outbox.enqueueInTransaction({ id: `export:${updateId}`, chatId: this.tenantId, method: 'sendDocument', params: { document: { filename: 'meme-radar-records.json', content } }, expiresAt: this.now() + 900_000 });
  }
}
