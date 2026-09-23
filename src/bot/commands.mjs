import { renderPanel } from './panels.mjs';
import { readTelegramSnapshot } from './snapshot.mjs';
import { TelegramSessions } from './sessions.mjs';
import { annotateInTransaction, ReviewConflict, setManualMarkInTransaction, reviewProjectionRevision } from './review.mjs';

const ROOTS = new Set(['start','radar','help','status','settings','chains','feed','audits','candidates','saved','events','stats','onboard']);
const CHAINS = ['sol','bsc','base','eth','robinhood','arc','stable'];
const CONCRETE_CHAIN_PANELS = new Set(['radar','feed','audits','stats']);
const CONTROL = new Set(['pause','resume','disconnect','mute','unmute']);
const text = (lang, zh, en) => lang === 'en' ? en : zh;

export class TelegramCommands {
  constructor({ storage, tenantId, inbox, outbox, live, controls, now = Date.now, snapshot = readTelegramSnapshot }) {
    Object.assign(this, { storage, tenantId, inbox, outbox, live, controls, now, snapshot });
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

  noticeInTransaction(updateId, message, suffix = 'notice') {
    this.outbox.enqueueInTransaction({ id: `${suffix}:${updateId}`, chatId: this.tenantId, method: 'sendMessage', params: { text: message, link_preview_options: { is_disabled: true } }, expiresAt: this.now() + 900_000 });
  }

  renderInTransaction(session, { onboarding = null, deliveryClass = 'USER_RESPONSE' } = {}) {
    const snapshot = this.snapshot(this.storage, this.tenantId, this.now());
    if (onboarding) snapshot.onboarding = onboarding;
    const rendered = renderPanel(snapshot, session, this.language);
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
    if (row.command_type === 'callback') {
      const payload = JSON.parse(row.payload_json);
      const link = this.storage.sql.exec('SELECT action FROM shortlinks WHERE tenant_id=? AND id=?', this.tenantId, payload.callbackId).toArray()[0];
      if (!['scan.pause','scan.resume','connection.disconnect','notifications.set','live.set'].includes(link?.action)) return false;
      this.processInTransaction(row);
      return true;
    }
    const command = row.command_type.replace(/^command:/, '');
    if (!CONTROL.has(command)) return false;
    const args = JSON.parse(row.payload_json).arguments ?? '';
    if (args) this.noticeInTransaction(row.update_id, `/${command}`);
    else this.applyControl(command);
    const session = this.sessions.createInTransaction('settings', this.controls.snapshot().activeChain ?? 'robinhood');
    this.renderInTransaction(session);
    this.inbox.finishInTransaction(row.update_id, 'DONE');
    return true;
  }

  applyControl(command) {
    if (command === 'pause') this.controls.pause();
    else if (command === 'resume') this.controls.resume();
    else if (command === 'disconnect') { this.controls.disconnect(); this.live.unsubscribeInTransaction(); }
    else if (command === 'mute' || command === 'unmute') {
      this.setPreference('notifications', command === 'unmute');
      this.setPreference('notificationsVersion', this.preference('notificationsVersion', 0) + 1);
      this.controls.resetNotificationBaseline?.();
    }
  }

  processInTransaction(row, { onboarding = null } = {}) {
    const payload = JSON.parse(row.payload_json);
    try {
      if (row.command_type === 'callback') this.callbackInTransaction(row, payload, onboarding);
      else if (row.command_type === 'reply') this.replyInTransaction(row, payload);
      else this.commandInTransaction(row, payload, onboarding);
      this.inbox.finishInTransaction(row.update_id, 'DONE');
    } catch (error) {
      if (!(error instanceof ReviewConflict)) throw error;
      this.noticeInTransaction(row.update_id, text(this.language, '内容或操作已失效，未执行旧操作。请使用 /radar 重新打开。', 'Content or action expired; the old action was not applied. Reopen with /radar.'));
      this.inbox.finishInTransaction(row.update_id, 'FAILED', { reason: error.code });
    }
  }

  commandInTransaction(row, payload, onboarding) {
    const command = row.command_type.replace(/^command:/, '');
    const args = payload.arguments ?? '';
    if (CONTROL.has(command)) return this.immediateInTransaction(row);
    const chain = this.controls.snapshot().activeChain ?? 'robinhood';
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
    if (command === 'setkey') return this.noticeInTransaction(row.update_id, text(this.language, '先使用 /onboard，然后提交 /setkey <key>。含密钥的消息可能留在聊天记录，请检查并删除。', 'Use /onboard, then /setkey <key>. Key messages may remain in chat history; check and delete them.'));
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
    if (!ROOTS.has(command)) return this.renderInTransaction(this.sessions.createInTransaction('help', chain));
    if (command === 'feed') {
      if (args && ![...CHAINS, 'off'].includes(args)) return this.noticeInTransaction(row.update_id, `/feed ${CHAINS.join(' | ')} | off`);
      if (args === 'off') this.live.unsubscribeInTransaction();
      else this.live.subscribeInTransaction(args || chain);
    } else if (args) return this.noticeInTransaction(row.update_id, `/${command}`);
    const panel = command === 'start' ? 'radar' : command === 'candidates' ? 'audits' : command;
    if (command === 'start') this.controls.initializeNotificationBaseline?.();
    const session = this.sessions.createInTransaction(panel, command === 'saved' || command === 'events' ? 'all' : command === 'feed' && CHAINS.includes(args) ? args : chain);
    this.renderInTransaction(session, { onboarding });
  }

  callbackInTransaction(row, payload, onboarding) {
    const binding = this.sessions.resolveInTransaction({ tenantId: this.tenantId, actorUserId: row.actor_user_id, sourceMessageId: row.source_message_id, payload });
    let { session, action, params, token } = binding;
    const control = this.controls.snapshot();
    if (/^(scan\.|live\.|chains\.save|notifications\.)/.test(action) && binding.expectedControlEpoch !== control.controlEpoch) throw new ReviewConflict('control_changed');
    if (/^(connection\.|onboard\.)/.test(action) && binding.expectedConnectionGeneration !== control.connectionGeneration && !(action === 'onboard.regenerate' && onboarding?.connectionGeneration === control.connectionGeneration)) throw new ReviewConflict('connection_changed');
    if (action === 'live.set' && params.expectedLiveGeneration !== (control.live.generation ?? 0)) throw new ReviewConflict('live_changed');
    if (['notifications.set','chains.save'].includes(action) && params.expectedPreferenceVersion !== this.preference(action === 'notifications.set' ? 'notificationsVersion' : 'scanChainsVersion', 0)) throw new ReviewConflict('settings_changed');
    let changes = {};
    if (action === 'panel.open') {
      const panel = params.panel;
      if (typeof panel !== 'string') throw new ReviewConflict('invalid_panel');
      const returnTo = structuredClone({ panel: session.panel, viewChain: session.viewChain, query: { ...session.query, pendingInput: undefined } });
      let ancestor = returnTo;
      for (let depth = 1; ancestor?.query?.returnTo; depth++) { if (depth >= 4) { delete ancestor.query.returnTo; break; } ancestor = ancestor.query.returnTo; }
      const viewChain = CONCRETE_CHAIN_PANELS.has(panel) && !CHAINS.includes(session.viewChain)
        ? (CHAINS.includes(control.activeChain) ? control.activeChain : 'robinhood')
        : session.viewChain;
      changes = { panel, viewChain, query: { ...session.query, schemaVersion: 1, page: 0, pendingInput: undefined, ...(params.query ?? {}), returnTo, ...(token ? { selectedToken: token } : {}) } };
    } else if (action === 'panel.back') {
      const origin = session.query.returnTo;
      changes = origin ? { panel: origin.panel, viewChain: origin.viewChain, query: origin.query } : { panel: 'radar', query: { schemaVersion: 1, page: 0 } };
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
    else if (action === 'notifications.set') { if (typeof params.value !== 'boolean') throw new ReviewConflict('invalid_notifications'); this.applyControl(params.value ? 'unmute' : 'mute'); }
    else if (action === 'live.set') {
      const chain = params.chain ?? session.viewChain;
      if (params.value !== false && !CHAINS.includes(chain)) throw new ReviewConflict('invalid_chain');
      if (params.value === false) this.live.unsubscribeInTransaction(); else this.live.subscribeInTransaction(chain);
    }
    else if (action === 'delivery.acknowledge') this.outbox.acknowledgeIssuesInTransaction();
    else if (action === 'connection.disconnect') { this.applyControl('disconnect'); changes = { panel: 'settings', query: {} }; }
    else if (action === 'language.set') { if (!['zh','en'].includes(params.value)) throw new ReviewConflict('invalid_language'); this.setPreference('language', params.value); changes = { panel: 'settings', query: {} }; }
    else if (action === 'chains.draft_set') {
      const current = session.query.draftChains ?? this.snapshot(this.storage, this.tenantId, this.now()).control.enabledChains;
      const draft = params.selected ? [...new Set([...current, params.value])] : current.filter(chain => chain !== params.value);
      if (draft.length > 3) throw new ReviewConflict('chain_limit');
      changes = { query: { ...session.query, draftChains: draft } };
    }
    else if (action === 'chains.save') this.controls.setScanChains(session.query.draftChains ?? this.snapshot(this.storage, this.tenantId, this.now()).control.enabledChains);
    else if (action === 'export.create') this.exportInTransaction(row.update_id);
    else if (action === 'audit.enqueue') {
      const queued = this.live.enqueueReviewInTransaction(token.chain, token.address, { snapshotAt: params.snapshotAt, enabledChains: this.snapshot(this.storage, this.tenantId, this.now()).control.enabledChains });
      this.noticeInTransaction(row.update_id, queued.accepted ? text(this.language, '已入队，等待额度。', 'Queued; awaiting capacity.') : text(this.language, '当前无法入队，请刷新活跃榜并检查扫描链与连接状态。', 'Cannot queue this token now; refresh the feed and check scan chains and connection.'));
    }
    else if (action === 'onboard.regenerate') { if (!onboarding) throw new ReviewConflict('onboarding_not_ready'); changes = { panel: 'onboard' }; }
    else throw new ReviewConflict('unsupported_action');
    session = this.sessions.advanceInTransaction(session, changes);
    this.renderInTransaction(session, { onboarding });
  }

  beginInputInTransaction(session, kind, token = null, expectedVersion = null) {
    if (!['search','note','note_target'].includes(kind)) throw new ReviewConflict('invalid_input');
    const outboxId = `prompt:${session.id}:${session.version + 1}`;
    const next = this.sessions.advanceInTransaction(session, { query: { ...session.query, pendingInput: { kind, target: token, expectedVersion, outboxId, promptMessageId: null, expiresAt: Math.min(this.now() + 300_000, session.expiresAt) } } });
    this.renderInTransaction(next);
    const instruction = kind === 'note' ? text(this.language, '请回复此消息，输入备注（最多500字符）。/cancel 取消。', 'Reply with a note (max 500 characters). /cancel.') : text(this.language, '请回复此消息，输入名称、简称或CA（最多128字符）。/cancel 取消。', 'Reply with a name, symbol or contract address (max 128 characters). /cancel.');
    this.outbox.enqueueInTransaction({ id: outboxId, chatId: this.tenantId, method: 'sendMessage', params: { text: `${token ? `${token.chain} ${token.address}\n` : ''}${instruction}`, reply_markup: { force_reply: true, selective: true } }, purpose: 'prompt', sessionId: next.id, sessionVersion: next.version, expiresAt: next.query.pendingInput.expiresAt });
  }

  replyInTransaction(row, payload) {
    const session = this.sessions.promptSession(payload.replyToMessageId);
    if (!session) throw new ReviewConflict('input_expired');
    const pending = session.query.pendingInput;
    const value = payload.text;
    if (typeof value !== 'string' || value.length > (pending.kind === 'note' ? 500 : 128)) {
      this.noticeInTransaction(row.update_id, text(this.language, '输入过长，请缩短后回复原提示。', 'Input is too long; shorten it and reply to the original prompt.')); return;
    }
    if (pending.kind === 'note_target') return this.resolveNoteInTransaction(session, value);
    if (pending.kind === 'note') annotateInTransaction(this.storage, this.tenantId, { token: pending.target, field: 'note', value, expectedVersion: pending.expectedVersion }, this.now());
    const { pendingInput, ...query } = session.query;
    this.renderInTransaction(this.sessions.advanceInTransaction(session, { query: { ...query, ...(pending.kind === 'search' ? { search: value, page: 0 } : {}) } }));
  }

  resolveNoteInTransaction(session, value) {
    const snapshot = this.snapshot(this.storage, this.tenantId, this.now());
    const rows = [...(snapshot.candidates ?? []), ...Object.values(snapshot.liveByChain ?? {}).flatMap(feed => feed.rows), ...(snapshot.annotations ?? [])];
    const unique = [...new Map(rows.map(row => [`${row.chain}:${row.address}`, row])).values()];
    const exact = unique.filter(row => row.address === value || (row.chain !== 'sol' && row.address?.toLowerCase() === value.toLowerCase()));
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
