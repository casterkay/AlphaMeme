import { normalizeList } from './providers/gmgn.mjs';
import { config } from './config.mjs';
import { normalizeLiveRows as normalizeRows } from './live-normalize.mjs';

export const normalizeLiveRows = (input, chain, previous = [], at = Date.now(), initialized = false) => normalizeRows(input, chain, previous, at, initialized, config);
const identity = (chain, value) => chain === 'sol' ? value : value.toLowerCase();
const addressValid = (chain, value) => typeof value === 'string' && (chain === 'sol' ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ : /^0x[0-9a-f]{40}$/i).test(value);

export class LiveDiscovery {
  constructor({ gmgn, settings = config, now = Date.now, intervalMs = 5000, leaseMs = 30000, schedule = setTimeout, cancel = clearTimeout }) {
    this.gmgn = gmgn; this.settings = settings; this.now = now; this.intervalMs = intervalMs;
    this.leaseMs = leaseMs; this.schedule = schedule; this.cancel = cancel;
    this.states = new Map(); this.raw = new Map(); this.focus = ''; this.leaseUntil = 0;
    this.nextPollAt = 0; this.running = false; this.timer = null; this.stopped = false; this.epoch = gmgn.keyEpoch;
  }

  syncCredentials() {
    if (this.epoch !== this.gmgn.keyEpoch) {
      this.states.clear(); this.raw.clear(); this.epoch = this.gmgn.keyEpoch;
    }
  }

  touch(chain) {
    if (!this.settings.supportedChains.includes(chain)) throw new Error('unsupported_chain');
    this.syncCredentials(); this.focus = chain; this.leaseUntil = this.now() + this.leaseMs;
    if (!this.timer && !this.running && !this.stopped) this.arm();
    return this.snapshot(chain);
  }

  arm() {
    if (this.stopped || !this.focus || this.now() >= this.leaseUntil) return;
    const wait = Math.max(0, this.nextPollAt - this.now(), (this.gmgn.nextAllowedAt || 0) - this.now());
    this.timer = this.schedule(() => { this.timer = null; void this.poll(); }, wait);
    this.timer?.unref?.();
  }

  async poll() {
    if (this.running || this.stopped || !this.focus || this.now() >= this.leaseUntil) return;
    if (this.now() < this.nextPollAt || this.now() < (this.gmgn.nextAllowedAt || 0)) { this.arm(); return; }
    this.syncCredentials();
    const chain = this.focus, at = this.now(), epoch = this.gmgn.keyEpoch;
    const old = this.states.get(chain) || { rows: [], lastSuccessAt: 0, pollCount: 0 };
    this.running = true; this.nextPollAt = at + this.intervalMs;
    this.states.set(chain, { ...old, status: 'LOADING', lastAttemptAt: at });
    try {
      if (!await this.gmgn.configured()) {
        this.states.set(chain, { ...old, status: 'AUTH_REQUIRED', lastAttemptAt: at }); return;
      }
      const result = await this.gmgn.marketRank(chain, '1m', {
        limit: 100, order_by: 'volume', direction: 'desc', min_created: '5m',
        min_marketcap: 10_000, max_marketcap: 500_000, min_liquidity: 3_000,
        deadline: Date.now() + 25_000
      });
      if (this.stopped || epoch !== this.gmgn.keyEpoch) return;
      let payload = result;
      for (let i = 0; i < 3 && payload && !Array.isArray(payload) && payload.data != null; i++) payload = payload.data;
      if (!Array.isArray(payload) && !Array.isArray(payload?.rank)) throw new Error('invalid_live_response');
      const input = normalizeList(result, ['rank']);
      const now = this.now();
      const rows = normalizeLiveRows(input, chain, old.rows, now, old.lastSuccessAt > 0);
      this.states.set(chain, { rows, status: 'READY', lastAttemptAt: at, lastSuccessAt: now,
        requestMs: now - at, pollCount: old.pollCount + 1, receivedCount: input.length, filteredCount: Math.max(0, input.length - rows.length) });
      this.raw.set(chain, new Map(input.filter(row => row && addressValid(chain, row.address) && rows.some(x => identity(chain, row.address) === x.address))
        .map(row => [identity(chain, row.address), row])));
    } catch (error) {
      if (this.stopped || epoch !== this.gmgn.keyEpoch) return;
      const status = error.code === 'GMGN_RATE_LIMITED' ? 'RATE_LIMITED'
        : ['GMGN_AUTH_FAILED', 'GMGN_PERMISSION_DENIED'].includes(error.code) ? 'AUTH_REQUIRED' : 'ERROR';
      this.states.set(chain, { ...old, status, lastAttemptAt: at });
      this.nextPollAt = Math.max(this.nextPollAt, this.now() + (status === 'AUTH_REQUIRED' ? 60000 : status === 'ERROR' ? 30000 : error.retryAfterMs || 0));
    } finally { this.running = false; this.arm(); }
  }

  snapshot(chain) {
    this.syncCredentials();
    const state = this.states.get(chain) || { status: 'WAITING', rows: [], lastSuccessAt: 0, pollCount: 0 };
    return structuredClone({ ...state, chain, intervalMs: this.intervalMs, execution: false,
      nextPollAt: Math.max(this.nextPollAt, this.gmgn.nextAllowedAt || 0),
      status: this.gmgn.disabled ? 'AUTH_REQUIRED' : this.gmgn.nextAllowedAt > this.now() ? 'RATE_LIMITED' : state.status,
      stale: !state.lastSuccessAt || this.now() - state.lastSuccessAt > 60000 });
  }

  auditRow(chain, address) {
    this.syncCredentials();
    const snapshot = this.snapshot(chain);
    if (snapshot.stale || this.gmgn.disabled || snapshot.status === 'AUTH_REQUIRED') return null;
    const row = this.raw.get(chain)?.get(identity(chain, address));
    if (!row) return null;
    // Interval-specific counters must never masquerade as five-minute counters.
    const { volume, swaps, buys, sells, price_change_percent, ...audit } = row;
    return structuredClone(audit);
  }

  stop() { this.stopped = true; if (this.timer) this.cancel(this.timer); this.timer = null; }
}
