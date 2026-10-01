// Pasted contract-address lookups. A lookup is not a lead: its record lives in
// scheduler_state under `lookup:<chain>:<address>` and never enters candidates,
// notifications, outcomes, the audit queue or the export.
//
// DETAILS (AVE, 5 CU through admission) → DEXSCREENER → GOPLUS → DONE, or
// NOT_FOUND / FAILED. Each step makes one request and commits its outcome in one
// transaction; every step is a read, so a replayed step is harmless. The
// secondary sources only see an address AVE has confirmed as a token on that
// chain: NOT_FOUND and FAILED end the lookup first.
//
// A fatal GoPlus finding is a safety fact, not disposable state: the record keeps
// it as `veto` across reruns, and pruning never drops a vetoed record. Only a later
// run that reaches DONE with a complete GoPlus check free of fatal flags clears it.
import { normalizeTokenAddress } from './address.mjs';
import { isScanChain } from './chains.mjs';
import { ConnectionError } from './auth/connection.mjs';
import { AVE_CU } from './providers/ave.mjs';
import { aggregateSecondarySources, SecondaryValidator } from './providers/secondary.mjs';
import { safetyVerdict } from './scoring/safety.mjs';

export const LOOKUP_STATES = Object.freeze(['DETAILS', 'DEXSCREENER', 'GOPLUS', 'DONE', 'NOT_FOUND', 'FAILED']);
export const RUNNING_STATES = Object.freeze(new Set(['DETAILS', 'DEXSCREENER', 'GOPLUS']));
// Lookups run one at a time and each AVE read waits at least AVE_MINIMUM_GAP_MS (15 s)
// for admission, ahead of the scan: five waiting lookups already hold the scan back
// for over a minute and the last answer arrives that late, so more are refused.
// A clean check verifies a buy only while fresh; a veto never goes stale.
export const LOOKUP_SETTINGS = Object.freeze({ reuseMs: 60_000, expiryMs: 24 * 60 * 60_000, kept: 20, pending: 5, verifiedMs: 15 * 60_000 });
const PREFIX = 'lookup:';
const SECONDARY_STEPS = Object.freeze({ DEXSCREENER: ['dexScreener', 'GOPLUS'], GOPLUS: ['goPlus', 'DONE'] });
// AVE answers that end a lookup: the key or the request is refused, or the answer is unusable.
const AVE_REFUSALS = new Set(['AVE_AUTH', 'AVE_SCHEMA', 'AVE_SIZE', 'AVE_INPUT', 'AVE_CONFIG']);
// Admission already holds the next request back until AVE has capacity again; waiting is not a failure.
const AVE_WAITS = new Set(['AVE_RATE_LIMITED', 'AVE_QUOTA']);
const done = Object.freeze({ status: 'success', complete: true });

export class LookupError extends Error {
  constructor(code, message) { super(message); this.name = 'LookupError'; this.code = code; }
}

const corrupt = reason => new LookupError('LOOKUP_RECORD_CORRUPT', `lookup record is malformed: ${reason}`);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const time = value => Number.isSafeInteger(value) && value >= 0;
const check = (condition, reason) => { if (!condition) throw corrupt(reason); };

/** The record key of a token, or null when the chain or address is not one a lookup can hold. */
export function lookupKey(chain, address) {
  const normalized = isScanChain(chain) ? normalizeTokenAddress(address) : null;
  return normalized ? `${PREFIX}${chain}:${normalized}` : null;
}

// A run's task id names its start, so a retry the scheduler gave up on never blocks a later run.
const taskIdOf = record => `${PREFIX}${record.chain}:${record.address}:${record.startedAt}`;

export function validateLookup(record) {
  check(isObject(record) && record.version === 1, 'version');
  check(lookupKey(record.chain, record.address) === `${PREFIX}${record.chain}:${record.address}`, 'token');
  check(Number.isSafeInteger(record.revision) && record.revision >= 1, 'revision');
  check(LOOKUP_STATES.includes(record.state), 'state');
  check(time(record.startedAt) && time(record.updatedAt), 'timestamps');
  check(record.sessionId === null || (typeof record.sessionId === 'string' && /^[0-9a-f]{32}$/.test(record.sessionId)), 'session');
  check(record.market === null || (isObject(record.market) && time(record.market.capturedAt)), 'market');
  check(isObject(record.sources), 'sources');
  check(record.secondary === null || isObject(record.secondary), 'secondary');
  check(record.veto === null || (isObject(record.veto) && time(record.veto.checkedAt) && Array.isArray(record.veto.fatal) && record.veto.fatal.length > 0), 'veto');
  check(record.reason === null || (typeof record.reason === 'string' && /^[A-Z0-9_]{1,64}$/.test(record.reason)), 'reason');
  check(record.state === 'DETAILS' || record.state === 'NOT_FOUND' || record.state === 'FAILED' || record.market !== null, 'market missing after DETAILS');
  check((record.state === 'DONE') === (record.secondary !== null), 'secondary only when done');
  check((record.state === 'FAILED') === (record.reason !== null), 'reason only when failed');
  return record;
}

function parse(row) {
  let value;
  try { value = JSON.parse(row.value_json); } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw corrupt('not JSON');
  }
  validateLookup(value);
  if (`${PREFIX}${value.chain}:${value.address}` !== row.key) throw corrupt('key and token differ');
  return value;
}

// Rows already reported unreadable, so each is logged once per isolate.
const reportedUnreadable = new Set();

/**
 * Every readable lookup of the tenant, newest first, including expired ones not
 * yet pruned. A lookup is regenerable, so an unreadable row (corrupt, or from
 * another version) is skipped with one log line instead of stalling the tenant;
 * only safetyState, through readLookup, refuses to guess about one.
 */
export function listLookups(storage, tenantId) {
  return storage.sql.exec("SELECT key,value_json FROM scheduler_state WHERE tenant_id=? AND substr(key,1,7)='lookup:'", tenantId).toArray().flatMap(row => {
    try { return [parse(row)]; } catch (error) {
      if (!(error instanceof LookupError)) throw error;
      const reported = `${tenantId}:${row.key}`;
      if (!reportedUnreadable.has(reported)) { reportedUnreadable.add(reported); console.log(JSON.stringify({ event: 'lookup_record_unreadable', key: row.key, code: error.code })); }
      return [];
    }
  }).sort((left, right) => right.startedAt - left.startedAt || left.address.localeCompare(right.address));
}

/** The token's lookup while it is retained (a vetoed one always), or null; an unreadable record throws. */
export function readLookup(storage, tenantId, chain, address, now) {
  const key = lookupKey(chain, address);
  const row = key ? storage.sql.exec('SELECT key,value_json FROM scheduler_state WHERE tenant_id=? AND key=?', tenantId, key).toArray()[0] : null;
  const record = row ? parse(row) : null;
  return record && (record.veto || now - record.startedAt < LOOKUP_SETTINGS.expiryMs) ? record : null;
}

/** The shared safety verdict of a lookup: VETOED while a recorded veto stands, else PENDING until its checks finish. */
export function lookupVerdict(record) {
  return record?.veto ? 'VETOED' : safetyVerdict({ status: null, secondary: record?.secondary ?? null, deep: null });
}

/** Whether a clean lookup verifies a buy now: within LOOKUP_SETTINGS.verifiedMs of its GoPlus read. */
export function lookupVerified(record, now) {
  return lookupVerdict(record) === 'PASSED' && now - record.sources.goPlus.collectedAt <= LOOKUP_SETTINGS.verifiedMs;
}

// A finished run's effect on the veto: a fatal finding records one; only a
// complete GoPlus check free of fatal flags clears it; anything else keeps it.
function nextVeto(previous, secondary) {
  const { security } = secondary;
  if (security.verdict === 'FATAL') return { checkedAt: secondary.checkedAt, fatal: security.fatal.map(({ field, reason }) => ({ field, reason })) };
  return secondary.sources.goPlus?.status === 'OK' && security.complete && security.verdict === 'NO_FATAL_FLAGS' ? null : previous;
}

// The market facts a detail shows, from AVE's token row.
function marketFacts({ token, capturedAt }) {
  return {
    symbol: token.symbol, name: token.name, price: token.current_price_usd, marketCap: token.market_cap,
    liquidity: token.main_pair_tvl ?? token.tvl, holders: token.holders, createdAt: token.launch_at ?? token.created_at,
    priceChange5m: token.token_price_change_5m === null ? null : token.token_price_change_5m / 100,
    volume5m: token.token_tx_volume_usd_5m, capturedAt
  };
}

export class TokenLookups {
  constructor({ storage, tenantId, now = Date.now, onLookupInTransaction = () => {} }) {
    Object.assign(this, { storage, tenantId, now, onLookupInTransaction });
  }

  read(chain, address) { return readLookup(this.storage, this.tenantId, chain, address, this.now()); }

  /**
   * Bind a lookup of the token to a detail session. A running lookup, or one
   * started within the reuse window unless this is a retry, is reused; any other
   * is started afresh, unless LOOKUP_SETTINGS.pending lookups are already waiting.
   */
  startInTransaction({ chain, address, sessionId, retry = false }) {
    this.#pruneInTransaction();
    const now = this.now(), current = this.read(chain, address);
    if (current && (RUNNING_STATES.has(current.state) || (!retry && now - current.startedAt < LOOKUP_SETTINGS.reuseMs))) {
      return current.sessionId === sessionId ? current : this.#write(current, { sessionId });
    }
    if (listLookups(this.storage, this.tenantId).filter(record => RUNNING_STATES.has(record.state)).length >= LOOKUP_SETTINGS.pending) {
      throw new LookupError('LOOKUP_QUEUE_FULL', 'too many lookups are waiting');
    }
    const record = { version: 1, chain, address: normalizeTokenAddress(address), revision: 0, state: 'DETAILS', startedAt: now, updatedAt: now,
      sessionId, market: null, sources: {}, secondary: null, reason: null, veto: current?.veto ?? null };
    return this.#write(record, null, current?.revision ?? null);
  }

  /**
   * Scheduler tasks derived from the records: one lookup runs at a time, the
   * oldest first. A run whose step the scheduler gave up on ends FAILED here.
   */
  tasksInTransaction(retries = {}) {
    this.#pruneInTransaction();
    const running = listLookups(this.storage, this.tenantId).filter(record => RUNNING_STATES.has(record.state));
    for (const record of running) {
      const retry = retries[taskIdOf(record)];
      if (retry?.dueAt === null) this.onLookupInTransaction(this.#write(record, { state: 'FAILED', reason: retry.lastErrorCode.replace(/[^A-Z0-9_]/g, '').slice(0, 64) || 'STEP_FAILED' }));
    }
    const next = listLookups(this.storage, this.tenantId).filter(record => RUNNING_STATES.has(record.state)).at(-1);
    if (!next) return [];
    const id = taskIdOf(next), retry = retries[id];
    return [{ id, kind: 'lookup', dueAt: retry ? Math.max(next.updatedAt, retry.dueAt) : next.updatedAt, enabled: true, aveCost: next.state === 'DETAILS' ? AVE_CU.details : 0 }];
  }

  /**
   * Run one step. `details(chain, address, { signal })` is the admitted AVE read;
   * a refusal or an unusable answer ends the lookup, a rate-limit or quota answer
   * leaves it waiting on admission, and anything else is thrown for the scheduler's
   * bounded retry.
   */
  async runStep(taskId, { request, details, secondary = new SecondaryValidator() }) {
    const record = listLookups(this.storage, this.tenantId).find(item => taskIdOf(item) === taskId);
    if (!record || !RUNNING_STATES.has(record.state)) return done;
    if (record.state === 'DETAILS') {
      let answer;
      try {
        answer = await request(({ signal }) => details(record.chain, record.address, { signal }));
      } catch (error) {
        if (error?.code === 'AVE_NOT_FOUND') return this.#commit(record, { state: 'NOT_FOUND' });
        if (AVE_WAITS.has(error?.code)) return this.#commit(record, {});
        if (AVE_REFUSALS.has(error?.code) || error instanceof ConnectionError) return this.#commit(record, { state: 'FAILED', reason: error.code });
        throw error;
      }
      return this.#commit(record, { state: 'DEXSCREENER', market: marketFacts(answer) });
    }
    const [source, following] = SECONDARY_STEPS[record.state];
    let response;
    try {
      response = { value: await request(({ signal }) => secondary.fetchSource({ source, chain: record.chain, tokenAddress: record.address, signal })), collectedAt: this.now() };
    } catch (error) {
      // A source that does not answer in time is recorded as an error, as the scanner records it.
      if (error?.code !== 'SCHEDULER_REQUEST_TIMEOUT') throw error;
      response = { error: { code: 'TIMEOUT' }, collectedAt: this.now() };
    }
    const sources = { ...record.sources, [source]: response };
    if (following !== 'DONE') return this.#commit(record, { state: following, sources });
    const { market } = record;
    const checked = aggregateSecondarySources({ chain: record.chain, tokenAddress: record.address,
      primary: { market: { priceUsd: market.price, marketCap: market.marketCap, liquidityUsd: market.liquidity }, security: {} }, sources });
    return this.#commit(record, { state: 'DONE', sources, secondary: checked, veto: nextVeto(record.veto, checked) });
  }

  /** Commit a step's outcome unless the record changed since the step read it. */
  #commit(record, changes) {
    this.storage.transactionSync(() => {
      const current = this.read(record.chain, record.address);
      if (!current || current.revision !== record.revision) return;
      this.onLookupInTransaction(this.#write(current, changes));
    });
    return done;
  }

  #write(record, changes, expectedRevision = record.revision) {
    const key = lookupKey(record.chain, record.address);
    const stored = this.storage.sql.exec('SELECT key,value_json FROM scheduler_state WHERE tenant_id=? AND key=?', this.tenantId, key).toArray()[0];
    if ((stored ? parse(stored).revision : null) !== expectedRevision) throw new LookupError('LOOKUP_RECORD_CHANGED', 'lookup record changed');
    const next = validateLookup({ ...structuredClone(record), ...changes, revision: (expectedRevision ?? 0) + 1, updatedAt: this.now() });
    this.storage.sql.exec('INSERT INTO scheduler_state (tenant_id,key,value_json) VALUES (?,?,?) ON CONFLICT(tenant_id,key) DO UPDATE SET value_json=excluded.value_json', this.tenantId, key, JSON.stringify(next));
    return next;
  }

  // Keep the newest lookups within their expiry, and every vetoed one.
  #pruneInTransaction() {
    const now = this.now();
    listLookups(this.storage, this.tenantId).filter(record => !record.veto).forEach((record, index) => {
      if (index >= LOOKUP_SETTINGS.kept || now - record.startedAt >= LOOKUP_SETTINGS.expiryMs) {
        this.storage.sql.exec('DELETE FROM scheduler_state WHERE tenant_id=? AND key=?', this.tenantId, lookupKey(record.chain, record.address));
      }
    });
  }
}
