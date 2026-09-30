import { voiceEligible, voiceKey, VOICE_TTL } from '../../public/voice-alerts.mjs';
import { DEFAULT_SCAN_CHAIN } from '../chains.mjs';
import { CHART_RISK_VERSION } from '../scoring/chart-risk.mjs';
import { readSchedulerStateInTransaction } from '../storage/scheduler-state.mjs';

const STATE_KEY = 'notification.baseline';
const EVENT_TTL = 30 * 60_000;
const ISSUE_REASONS = new Set(['KEY_UNUSABLE', 'UNRECOVERABLE_STATE', 'DELIVERY_UNCERTAIN']);
const decode = value => value == null ? null : JSON.parse(value);
// The last hold reason logged per lead, per Durable Object storage, so a steady state logs once, not on every reconcile.
const loggedHolds = new WeakMap();
const frozen = value => {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) frozen(child); Object.freeze(value); }
  return value;
};

/** Durable allowlist policy. Call reconciliation and outbox enqueue in the same transaction. */
export class NotificationPolicy {
  constructor({ storage, tenantId, now = Date.now }) { this.storage = storage; this.tenantId = tenantId; this.now = now; }
  query(sql, ...args) { return this.storage.sql.exec(sql, this.tenantId, ...args).toArray(); }
  read() { return decode(this.query('SELECT value_json FROM scheduler_state WHERE tenant_id=? AND key=?', STATE_KEY)[0]?.value_json); }
  write(value) { this.storage.sql.exec('INSERT INTO scheduler_state (tenant_id,key,value_json) VALUES (?,?,?) ON CONFLICT(tenant_id,key) DO UPDATE SET value_json=excluded.value_json WHERE value_json IS NOT excluded.value_json', this.tenantId, STATE_KEY, JSON.stringify(value)); }
  controls() {
    const preferences = Object.fromEntries(this.query('SELECT key,value_json FROM preferences WHERE tenant_id=?').map(row => [row.key, decode(row.value_json)]));
    const scanChain = readSchedulerStateInTransaction(this.storage, this.tenantId).runtime.control.activeChain ?? DEFAULT_SCAN_CHAIN;
    return { enabled: preferences['telegram.notifications'] !== false, chains: [scanChain] };
  }
  candidates() {
    const excluded = new Set(this.query('SELECT chain,address FROM risk_exclusions WHERE tenant_id=?').map(voiceKey));
    const marks = new Map(this.query('SELECT chain,address,decision FROM manual_marks WHERE tenant_id=?').map(row => [voiceKey(row), row.decision]));
    const favorites = new Set(this.query('SELECT chain,address FROM annotations WHERE tenant_id=? AND favorite=1').map(voiceKey));
    return this.query('SELECT chain,address,symbol,status,audited_at,stale_at,review_revision,deep_json,audit_health_json,audit_error FROM candidates WHERE tenant_id=?').map(row => {
      const deep = decode(row.deep_json), health = decode(row.audit_health_json), key = voiceKey(row);
      // An AVE market lead alerts as upstream's live lead does; a deep-audit pass needs its full evidence.
      const lead = row.status === 'LIVE_READY';
      return { chain: row.chain, address: row.address, symbol: row.symbol, status: row.status, auditedAt: row.audited_at, staleAt: row.stale_at, revision: row.review_revision,
        ...(lead ? { source: 'live' } : {}),
        qualified: lead ? !excluded.has(key) : row.status === 'X_REVIEW' && deep?.chainPass === true && !row.audit_error && health?.complete !== false && deep?.chartRisk?.pass === true && deep?.chartRisk?.version === CHART_RISK_VERSION && !excluded.has(key),
        ignored: marks.get(key) === 'ignored', approved: marks.get(key) === 'passed', favorite: favorites.has(key) };
    });
  }
  baselineInTransaction(force = false) {
    const previous = this.read();
    if (previous?.version === 1 && !force) return previous;
    const at = this.now(), chains = this.controls().chains;
    const quiet = Object.fromEntries(this.candidates().filter(row => chains.includes(row.chain) && voiceEligible(row, at) && !row.ignored).map(row => [voiceKey(row), at]));
    const state = { version: 1, initialized: true, at, generation: (previous?.generation || 0) + 1, sequence: previous?.sequence || 0, chains, quiet,
      notified: previous?.notified || {}, eventDedup: previous?.eventDedup || {}, riskNotified: previous?.riskNotified || {}, problemNotified: previous?.problemNotified || {}, pending: [], nextBatchAt: at };
    this.write(state);
    return structuredClone(state);
  }
  candidateEligible(row, chains) { return row && chains.includes(row.chain) && !row.ignored && voiceEligible(row, this.now()); }
  relevantRisk(row, state) { return row && (row.favorite || row.approved || Object.hasOwn(state.notified, voiceKey(row))); }

  eligible(outbox, payload, options) { return this.ineligibleReason(outbox, payload, options) === null; }

  /** Why an outbox row may not be sent now, or null when it may. */
  ineligibleReason(outbox, payload, { issues = [] } = {}) {
    if (['USER_RESPONSE', 'PANEL_UPDATE'].includes(outbox.delivery_class)) return null;
    const descriptor = payload.notification, state = this.read(), controls = this.controls();
    if (outbox.delivery_class !== 'ACTION_REQUIRED') return 'delivery_class_unknown';
    if (!controls.enabled) return 'alerts_off';
    if (!descriptor) return 'descriptor_missing';
    if (state?.generation !== descriptor.generation) return 'baseline_reset';
    if (descriptor.expiresAt <= this.now()) return 'expired';
    const persisted = state.pending.find(item => item.id === descriptor.id);
    if (!persisted || JSON.stringify(persisted) !== JSON.stringify(descriptor) || descriptor.actionReason !== outbox.action_reason) return 'no_longer_pending';
    if (descriptor.actionReason === 'ACCOUNT_ACTION_REQUIRED') return issues.some(issue => issue.key === descriptor.issue.key && issue.reason === descriptor.issue.reason && ISSUE_REASONS.has(issue.reason) && issue.nextAction === descriptor.issue.nextAction) ? null : 'issue_resolved';
    const current = new Map(this.candidates().map(row => [voiceKey(row), row]));
    if (descriptor.actionReason === 'CANDIDATE_NEW') {
      if (!descriptor.members.length) return 'no_members';
      for (const member of descriptor.members) {
        const row = current.get(voiceKey(member));
        if (!this.candidateEligible(row, controls.chains)) return 'lead_not_eligible';
        if (row.revision !== member.revision) return 'lead_revised';
      }
      return null;
    }
    if (descriptor.actionReason === 'RISK_WORSENED') {
      if (descriptor.members.length !== 1) return 'no_members';
      const row = current.get(voiceKey(descriptor.members[0]));
      if (!this.relevantRisk(row, state)) return 'risk_not_relevant';
      return row.revision === descriptor.members[0].revision ? null : 'lead_revised';
    }
    return 'action_reason_unknown';
  }

  // Logs each lead's hold reason once per change, so a silent lead can be explained from the logs.
  logHolds(rows, reasonFor) {
    if (!loggedHolds.has(this.storage)) loggedHolds.set(this.storage, new Map());
    const logged = loggedHolds.get(this.storage), seen = new Set();
    for (const row of rows) {
      const key = `${this.tenantId}:${voiceKey(row)}`, reason = reasonFor(row);
      seen.add(key);
      if (logged.get(key) === reason) continue;
      logged.set(key, reason);
      console.log(JSON.stringify({ event: 'notification_lead_held', chain: row.chain, address: row.address, reason }));
    }
    for (const key of logged.keys()) if (key.startsWith(`${this.tenantId}:`) && !seen.has(key)) logged.delete(key);
  }

  reconcileInTransaction({ issues = [] } = {}) {
    const state = this.baselineInTransaction(), now = this.now(), controls = this.controls();
    const rows = this.candidates(), current = new Map(rows.map(row => [voiceKey(row), row]));
    const corrections = this.query('SELECT chain,address,chat_id,message_id,rendered_revision FROM message_map WHERE tenant_id=?').flatMap(mapping => {
      const row = current.get(voiceKey(mapping));
      return row ? [{ chatId: mapping.chat_id, messageId: mapping.message_id, chain: mapping.chain, address: mapping.address, revision: row.revision }] : [];
    });
    const firstChains = controls.chains.filter(chain => !state.chains.includes(chain));
    for (const row of rows) if (this.candidateEligible(row, controls.chains)) {
      const key = voiceKey(row);
      if (firstChains.includes(row.chain) || row.auditedAt < state.at || Object.hasOwn(state.quiet, key)) state.quiet[key] = now;
    }
    state.chains = [...controls.chains];
    for (const [key, at] of Object.entries(state.quiet)) if (now - at >= VOICE_TTL) delete state.quiet[key];
    for (const [key, at] of Object.entries(state.eventDedup)) if (now - at >= EVENT_TTL) delete state.eventDedup[key];
    const activeIssues = new Set(issues.filter(issue => ISSUE_REASONS.has(issue.reason) && typeof issue.nextAction === 'string' && issue.nextAction).map(issue => issue.key));
    for (const key of Object.keys(state.problemNotified)) if (!activeIssues.has(key)) delete state.problemNotified[key];

    // Persist updated baseline before eligibility reads it; immutable batch membership never changes.
    this.write(state);
    state.pending = state.pending.filter(descriptor => this.eligible({ delivery_class: descriptor.deliveryClass, action_reason: descriptor.actionReason }, { notification: descriptor }, { issues }));
    const enqueue = (reason, members, issue = null) => {
      const descriptor = { id: `notification:${state.generation}:${++state.sequence}`, deliveryClass: 'ACTION_REQUIRED', actionReason: reason, members, createdAt: now, expiresAt: now + 10 * 60_000, generation: state.generation, ...(issue ? { issue } : {}) };
      state.pending.push(descriptor);
      for (const member of members) {
        const key = voiceKey(member);
        state.eventDedup[`${reason}:${key}`] = now;
        if (reason === 'CANDIDATE_NEW') state.quiet[key] = now;
        if (reason === 'RISK_WORSENED') state.riskNotified[`${key}:${member.revision}`] = now;
      }
      if (issue) state.problemNotified[issue.key] = now;
      return descriptor;
    };
    const eligibleRows = rows.filter(row => this.candidateEligible(row, controls.chains));
    const candidatePending = new Set(state.pending.filter(item => item.actionReason === 'CANDIDATE_NEW').flatMap(item => item.members.map(voiceKey)));
    const alerted = key => candidatePending.has(key) || (Number.isFinite(state.notified[key]) && now - state.notified[key] < VOICE_TTL)
      || Object.hasOwn(state.eventDedup, `CANDIDATE_NEW:${key}`);
    const newLeads = controls.enabled ? eligibleRows.filter(row => !Object.hasOwn(state.quiet, voiceKey(row)) && !alerted(voiceKey(row))) : [];
    const batch = newLeads.slice(0, 10), batchOpen = now >= state.nextBatchAt;
    const enqueued = new Set(batch.length && batchOpen ? batch.map(voiceKey) : []);
    this.logHolds(eligibleRows, row => {
      const key = voiceKey(row);
      return !controls.enabled ? 'alerts_off' : enqueued.has(key) || alerted(key) ? 'alerted' : Object.hasOwn(state.quiet, key) ? 'baseline_quiet'
        : !batch.some(item => voiceKey(item) === key) ? 'batch_full' : 'batch_interval';
    });
    if (controls.enabled) {
      if (enqueued.size) {
        const descriptor = enqueue('CANDIDATE_NEW', batch.map(row => ({ chain: row.chain, address: row.address, revision: row.revision })));
        console.log(JSON.stringify({ event: 'notification_enqueued', id: descriptor.id, actionReason: 'CANDIDATE_NEW', members: batch.length }));
        state.nextBatchAt = now + 60_000;
      }
      const events = this.query("SELECT id,at,chain,address FROM events WHERE tenant_id=? AND type='RISK_WORSENED' AND at>? ORDER BY at,id", Math.max(state.at, now - EVENT_TTL));
      for (const event of events) {
        if (!event.chain || !event.address) continue;
        const key = voiceKey(event), row = current.get(key), revisionKey = `${key}:${row?.revision}`;
        if (!this.relevantRisk(row, state) || !row.revision || state.riskNotified[revisionKey] || state.eventDedup[`RISK_WORSENED:${key}`]
          || state.pending.some(item => item.actionReason === 'RISK_WORSENED' && item.members.some(member => voiceKey(member) === key && member.revision === row.revision))) continue;
        enqueue('RISK_WORSENED', [{ chain: row.chain, address: row.address, revision: row.revision, eventId: event.id }]);
      }
      for (const issue of issues) {
        if (!activeIssues.has(issue.key) || state.problemNotified[issue.key] || state.pending.some(item => item.issue?.key === issue.key)) continue;
        enqueue('ACCOUNT_ACTION_REQUIRED', [], { key: issue.key, reason: issue.reason, nextAction: issue.nextAction });
      }
    }
    this.write(state);
    return frozen(structuredClone({ notifications: state.pending, corrections }));
  }

  acknowledgeInTransaction(descriptor) {
    const state = this.read();
    const persisted = state?.pending.find(item => item.id === descriptor.id);
    if (!persisted || JSON.stringify(persisted) !== JSON.stringify(descriptor)) return false;
    for (const member of descriptor.members) {
      const key = voiceKey(member);
      state.eventDedup[`${descriptor.actionReason}:${key}`] = this.now();
      if (descriptor.actionReason === 'CANDIDATE_NEW') { state.notified[key] = this.now(); state.quiet[key] = this.now(); }
      if (descriptor.actionReason === 'RISK_WORSENED') state.riskNotified[`${key}:${member.revision}`] = this.now();
    }
    if (descriptor.issue) state.problemNotified[descriptor.issue.key] = this.now();
    state.pending = state.pending.filter(item => item.id !== descriptor.id);
    this.write(state);
    return true;
  }
}
