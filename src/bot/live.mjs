import { normalizeLiveRows } from '../live-normalize.mjs';
import { normalizeGmgnList } from '../providers/gmgn-normalize.mjs';
import { discoveryScreen } from '../scoring/index.mjs';
import { addressKey } from '../scanner-parity.mjs';
import { createTaskDescriptor } from '../scheduler.mjs';
import { readSchedulerStateInTransaction, writeSchedulerStateInTransaction } from '../storage/scheduler-state.mjs';

const CHAINS = new Set(['sol', 'bsc', 'base', 'eth', 'robinhood', 'arc', 'stable']);
const INTERVAL = 20_000;
const empty = () => ({ rows: [], status: 'WAITING', lastSuccessAt: null, pollCount: 0 });
const done = at => ({ status: 'success', complete: true, checkpoint: `live:${at}` });

/** Persistent tenant live subscription; callers own the shared scheduler and GMGN admission. */
export class PersistentLive {
  constructor({ storage, tenantId, settings, now = Date.now }) {
    if (!settings) throw new TypeError('Live scoring settings are required');
    this.storage = storage; this.tenantId = tenantId; this.settings = settings; this.now = now;
  }

  read(key, fallback = null) {
    const row = this.storage.sql.exec('SELECT value_json FROM scheduler_state WHERE tenant_id = ? AND key = ?', this.tenantId, key).toArray()[0];
    return row ? JSON.parse(row.value_json) : structuredClone(fallback);
  }

  write(key, value) {
    this.storage.sql.exec('INSERT INTO scheduler_state (tenant_id,key,value_json) VALUES (?,?,?) ON CONFLICT(tenant_id,key) DO UPDATE SET value_json=excluded.value_json', this.tenantId, key, JSON.stringify(value));
  }

  state() { return readSchedulerStateInTransaction(this.storage, this.tenantId); }
  save(state, changes) { writeSchedulerStateInTransaction(this.storage, this.tenantId, { ...state, runtime: { ...state.runtime, live: { ...state.runtime.live, ...changes } } }); }

  subscribeInTransaction(chain) {
    if (!CHAINS.has(chain)) throw new TypeError('Unsupported live chain');
    const state = this.state();
    this.save(state, { subscribed: true, focusChain: chain, generation: (state.runtime.live.generation || 0) + 1, nextPollAt: state.runtime.live.nextPollAt ?? this.now() });
    return this.snapshot(chain);
  }

  unsubscribeInTransaction() {
    const state = this.state();
    this.save(state, { subscribed: false, leaseUntil: 0, generation: (state.runtime.live.generation || 0) + 1 });
  }

  snapshot(chain) {
    if (!CHAINS.has(chain)) throw new TypeError('Unsupported live chain');
    const state = this.state();
    const cached = this.read(`live.snapshot:${chain}`, empty());
    const sameEpoch = cached.keyEpoch === undefined || cached.keyEpoch === state.gmgn.keyEpoch;
    return { ...(sameEpoch ? cached : empty()), chain, ...state.runtime.live, paused: state.runtime.eligibility.paused,
      intervalMs: INTERVAL, execution: false, stale: !sameEpoch || cached.lastSuccessAt === null || this.now() - cached.lastSuccessAt > 60_000 };
  }

  reconcileInTransaction({ recoverRunning = false } = {}) {
    let state = this.state();
    if (recoverRunning && state.runtime.live.running) { this.save(state, { running: null }); state = this.state(); }
    const live = state.runtime.live;
    if (!live.subscribed || !live.focusChain || live.running || state.runtime.eligibility.paused || !state.runtime.eligibility.configured) return [];
    return [createTaskDescriptor({ id: 'live:subscription', kind: 'live', dueAt: live.nextPollAt ?? this.now(), enabled: true, needsGmgn: true, gmgnWeight: 1 })];
  }

  async pollOne({ request, gmgn }) {
    const claim = this.storage.transactionSync(() => {
      const state = this.state();
      const live = state.runtime.live;
      if (!live.subscribed || !live.focusChain || live.running || state.runtime.eligibility.paused || !state.runtime.eligibility.configured || (live.nextPollAt ?? 0) > this.now()) return null;
      const startedAt = this.now(), scheduledAt = live.nextPollAt ?? startedAt;
      const claim = { chain: live.focusChain, startedAt, generation: live.generation || 0, keyEpoch: state.gmgn.keyEpoch, controlEpoch: state.runtime.control.controlEpoch };
      this.save(state, { leaseUntil: startedAt + 30_000, nextPollAt: startedAt + INTERVAL, running: claim });
      const cached = this.read(`live.snapshot:${claim.chain}`, empty());
      const prior = cached.keyEpoch === undefined || cached.keyEpoch === claim.keyEpoch ? cached : empty();
      this.write(`live.snapshot:${claim.chain}`, { ...prior, status: 'LOADING', scheduledAt, startedAt, lastAttemptAt: startedAt, pollLagMs: startedAt - scheduledAt, delayReason: startedAt > scheduledAt ? 'REQUEST_WAIT' : null, keyEpoch: claim.keyEpoch });
      return claim;
    });
    if (!claim) return done(this.now());
    let input, failure = null;
    try {
      const result = await request(({ signal, timeoutMs = 25_000 }) => gmgn.marketRank(claim.chain, '1m', {
        limit: 100, order_by: 'volume', direction: 'desc', min_created: '5m', min_marketcap: 10_000, max_marketcap: 500_000, min_liquidity: 3000,
        signal, deadline: this.now() + Math.min(25_000, timeoutMs)
      }));
      let payload = result;
      for (let i = 0; i < 3 && payload && !Array.isArray(payload) && payload.data != null; i++) payload = payload.data;
      if (!Array.isArray(payload) && !Array.isArray(payload?.rank)) failure = 'INVALID_RESPONSE';
      else input = normalizeGmgnList(result, ['rank']);
    } catch (error) {
      if (typeof error?.code !== 'string' && error?.name !== 'AbortError' && !(error instanceof TypeError)) throw error;
      failure = error.code === 'GMGN_RATE_LIMITED' ? 'RATE_LIMITED' : ['GMGN_AUTH_FAILED', 'GMGN_PERMISSION_DENIED'].includes(error.code) ? 'AUTH_REQUIRED' : 'REQUEST_FAILED';
    }
    this.storage.transactionSync(() => {
      const state = this.state(), live = state.runtime.live;
      if (live.running?.startedAt !== claim.startedAt || live.running?.generation !== claim.generation) return;
      this.save(state, { running: null });
      if (!live.subscribed || live.generation !== claim.generation || state.gmgn.keyEpoch !== claim.keyEpoch || state.runtime.control.controlEpoch !== claim.controlEpoch) return;
      const previous = this.read(`live.snapshot:${claim.chain}`, empty()), at = this.now();
      if (failure) {
        this.write(`live.snapshot:${claim.chain}`, { ...previous, status: failure, requestMs: at - claim.startedAt, delayReason: failure });
        this.save(this.state(), { nextPollAt: Math.max(live.nextPollAt, at + (failure === 'AUTH_REQUIRED' ? 60_000 : 30_000)) });
      } else {
        const rows = normalizeLiveRows(input, claim.chain, previous.rows, at, previous.lastSuccessAt !== null, this.settings);
        this.write(`live.snapshot:${claim.chain}`, { ...previous, rows, status: 'READY', lastSuccessAt: at, requestMs: at - claim.startedAt, pollCount: previous.pollCount + 1, receivedCount: input.length, filteredCount: input.length - rows.length });
        const accepted = new Set(rows.map(row => row.address));
        this.write(`live.audit:${claim.chain}`, { at, keyEpoch: claim.keyEpoch, rows: input.filter(row => row?.address && accepted.has(addressKey(row.address))).map(row => { const { volume, swaps, buys, sells, price_change_percent, ...audit } = row; return audit; }) });
        // Coalesce missed slots; only one immediate successor may run after a slow read.
        this.save(this.state(), { nextPollAt: Math.max(live.nextPollAt, at) });
      }
    });
    return done(this.now());
  }

  enqueueReviewInTransaction(chain, address, { snapshotAt, enabledChains }) {
    const snapshot = this.snapshot(chain), state = this.state();
    if (!Array.isArray(enabledChains) || !enabledChains.includes(chain)) return { accepted: false, reason: 'chain_not_scanning' };
    if (snapshot.stale || snapshot.lastSuccessAt !== snapshotAt || !state.runtime.eligibility.configured || snapshot.status === 'AUTH_REQUIRED') return { accepted: false, reason: 'stale_snapshot' };
    const id = addressKey(address), source = this.read(`live.audit:${chain}`);
    const row = source?.keyEpoch === state.gmgn.keyEpoch && source.rows.find(item => addressKey(item.address) === id);
    if (!row || !discoveryScreen(row, { ...this.settings, chain }, this.now() / 1000).pass) return { accepted: false, reason: 'outside_audit_scope' };
    if (this.storage.sql.exec('SELECT address FROM risk_exclusions WHERE tenant_id=? AND chain=? AND address=?', this.tenantId, chain, id).toArray().length) return { accepted: false, reason: 'risk_excluded' };
    const existing = this.storage.sql.exec('SELECT * FROM audit_queue WHERE tenant_id=? AND chain=? AND address=?', this.tenantId, chain, id).toArray()[0];
    if (existing?.status === 'HARD_REJECT' && existing.next_audit_at > this.now()) return { accepted: false, reason: 'risk_rejected' };
    const pending = this.read('live.requestedReviews', []).filter(item => item.keyEpoch === state.gmgn.keyEpoch && this.now() - item.at <= 600_000);
    if (pending.some(item => item.chain === chain && item.address === id)) return { accepted: true, queued: true };
    if (pending.length >= 12) return { accepted: false, reason: 'queue_full' };
    const screen = discoveryScreen(row, { ...this.settings, chain }, this.now() / 1000);
    this.storage.sql.exec('INSERT INTO audit_queue (tenant_id,chain,address,first_seen_at,last_seen_at,next_audit_at,attempts,status,priority_band,score,watched,details_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,chain,address) DO UPDATE SET last_seen_at=excluded.last_seen_at,next_audit_at=excluded.next_audit_at', this.tenantId, chain, id, this.now(), this.now(), this.now(), 0, 'QUEUED', screen.priorityBand ? 1 : 0, screen.score, 0, JSON.stringify({}));
    this.write('live.requestedReviews', [...pending, { chain, address: id, row: structuredClone(row), at: this.now(), keyEpoch: state.gmgn.keyEpoch }]);
    return { accepted: true, queued: true };
  }
}
