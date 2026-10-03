import { tokenInfoPrice } from './providers/ave.mjs';
import { aggregateSecondarySources } from './providers/secondary.mjs';
import { discoveryScreen } from './scoring/screen.mjs';
import { DISCOVERY_REJECT, REJECTED_SAMPLE_DAILY_CAP, dueOutcomeJobs, hasAveOutcomeBaseline, horizons, sampledForRejection } from './scoring/outcomes.mjs';
import { safetyVerdict } from './scoring/safety.mjs';
import { addressKey, buildQueue, nextAuditDelay, publicToken, selectAuditQueue, socialFrom } from './scanner-parity.mjs';
import { RecoverableScannerError } from './storage/recoverable-scanner.mjs';
import { completeScannerSettings } from './scanner-settings.mjs';
import { POOL_SOURCES } from './providers/chain-logs.mjs';
import { nextWatchState, promotions, watchTargets } from './onchain-watch.mjs';

// One cycle reads the chain's AVE trending list, screens it with upstream's
// AVE market screen, and turns every passing token into a lead immediately.
// On a chain with pinned pool factories it also reads the new pools its logs
// created, watches them on DexScreener, and screens up to two that trade enough
// alongside the hot list, from the DexScreener market the watch already read.
// Leads then get the free GoPlus check; a fatal security finding vetoes the lead. No AVE token audit runs: beyond taxes, AVE has no
// holder, trader or contract-security data, so an AVE audit could never pass (upstream v0.1.10).
// The discovery requests for a cycle.
// A cycle reads new pools only when it began with the on-chain source configured.
function discoveryEndpoints(chain, partial) {
  return !POOL_SOURCES[chain] || partial.onchainOffReason !== null ? ['trending'] : ['trending', 'newPools', 'watch'];
}

// One-release upgrade step; remove once no checkpoint from before promotions stopped reading AVE remains.
// The previous release appended a `market:<n>` AVE read per promoted token after the watch, so its
// checkpoint can wait on DISCOVER past the last request. Its watch response and promotions are
// recorded, so it screens; any other cursor past the end has no local transition and fails loudly.
function pendingLegacyMarketRead(checkpoint) {
  const { discovery } = checkpoint.partial, endpoints = discoveryEndpoints(checkpoint.chain, checkpoint.partial);
  return checkpoint.phase === 'DISCOVER' && endpoints.length === 3 && Boolean(discovery?.responses?.watch)
    && Array.isArray(discovery.promoted) && checkpoint.endpointIndex >= 3 && checkpoint.endpointIndex < 3 + discovery.promoted.length;
}
const OUTCOME_SAMPLE_GRACE_MS = 25_000;
// Upstream samples an outcome horizon from a later hot-list quote within this lag.
const TRENDING_SAMPLE_GRACE_MS = 5 * 60_000;
const FEED_ROWS = 50;
const TRACKED_DECISIONS = new Set(['LIVE_READY', DISCOVERY_REJECT]);

function clone(value) {
  return structuredClone(value);
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function num(value, fallback = 0) {
  return numberOrNull(value) ?? fallback;
}

function tokenKey(chain, address) {
  return `${chain}:${addressKey(address)}`;
}

function requestError(error) {
  return {
    code: typeof error?.code === 'string' && error.code ? error.code : 'REQUEST_FAILED',
    message: typeof error?.message === 'string' && error.message ? error.message : '请求失败'
  };
}

function outcomeReadLimit(settings) {
  return settings.outcomeReadsPerCycle;
}

function candidateRetentionLimit(settings) {
  return settings.candidateRetentionMs;
}

function outcomeRetentionLimit(settings) {
  return settings.outcomeRetentionMs;
}

function outcomeSampleDeadline(checkpoint, now) {
  if (Number.isSafeInteger(checkpoint.partial.outcomeDeadlineAt) && checkpoint.partial.outcomeDeadlineAt >= 0) {
    return checkpoint.partial.outcomeDeadlineAt;
  }
  return (checkpoint.deadlineAt ?? now) + OUTCOME_SAMPLE_GRACE_MS;
}

function retainedOutcomes(outcomes, now, retentionMs) {
  return outcomes.filter(outcome => now - num(outcome.baselineAt) <= retentionMs);
}

function isCheckDeadlineBoundary(checkpoint, now) {
  return checkpoint.deadlineAt !== null && now >= checkpoint.deadlineAt
    && checkpoint.phase === 'SECONDARY' && checkpoint.tokenIndex > 0;
}

function responseRecord(value, error, collectedAt) {
  return Object.freeze({
    collectedAt,
    ...(error ? { error: requestError(error) } : { value: clone(value) })
  });
}

function checkpointEvidenceIsFresh(value, now, maximumAgeMs) {
  if (!value || typeof value !== 'object') return true;
  if (Number.isSafeInteger(value.collectedAt)) {
    if (value.collectedAt > now || now - value.collectedAt > maximumAgeMs) return false;
  }
  return Object.values(value).every(item => checkpointEvidenceIsFresh(item, now, maximumAgeMs));
}

function discoveryRows(discovery) {
  const rows = discovery?.responses?.trending?.value?.rows;
  return Array.isArray(rows) ? rows.filter(row => row && typeof row === 'object').slice(0, 100) : [];
}

// Promoted new pools as rows the screen reads, built from the DexScreener market the watch read.
// DexScreener dates pools, not tokens, and keeps no source clock: the token's first pool's creation
// stands in for launch time (age basis 'pool'; its deepest pool, shown, may be younger) and our read
// time for the source clock. It has no holder count, taxes or distinct traders, so those stay
// unknown; GoPlus checks taxes after the alert. Its 24-hour sell count is kept for that check.
function promotedRows(discovery, chain) {
  const watch = discovery?.responses?.watch?.value;
  const markets = new Map((watch?.markets || []).map(market => [market.address, market]));
  return (discovery?.promoted || []).map(address => markets.get(address)).map(market => ({
    address: market.address, chain, symbol: market.symbol, name: market.name, marketProvider: 'DEXSCREENER', discoverySource: 'newPool',
    price: market.priceUsd, market_cap: market.marketCap, liquidity: market.liquidity, holder_count: null, buy_tax: null, sell_tax: null,
    creation_timestamp: Math.floor(market.firstPairCreatedAt / 1000), launch_at: null, ageBasis: 'pool',
    pairAddress: market.pairAddress, poolCreatedAt: market.pairCreatedAt,
    volume_5m: market.volume5m, swaps_5m: market.swaps5m, buys_5m: market.buys5m, sells_5m: market.sells5m, sells_24h: market.sells24h,
    capturedAt: watch.capturedAt, sourceUpdatedAt: watch.capturedAt
  }));
}

function feedRow(row, screen) {
  return {
    address: String(row.address), symbol: String(row.symbol || '?').slice(0, 30), name: String(row.name || '').slice(0, 80),
    marketCap: numberOrNull(row.market_cap), liquidity: numberOrNull(row.liquidity), price: numberOrNull(row.price),
    createdAt: numberOrNull(screen.createdAt), ageBasis: screen.ageBasis || null, holders: numberOrNull(row.holder_count),
    volume5m: numberOrNull(row.volume_5m), buys5m: numberOrNull(row.buys_5m), sells5m: numberOrNull(row.sells_5m),
    priceChange5m: numberOrNull(row.price_change_percent5m), priorityBand: screen.priorityBand === true,
    pass: screen.pass === true, reasons: screen.reasons.slice(0, 3)
  };
}

// A lead's clock is its quote's observation time; retaining it never refreshes that evidence.
function leadCandidate(row, screen, chain, previous, observedAt, settings) {
  const token = publicToken(row, screen, chain);
  const qualifiedAt = previous?.status === 'LIVE_READY' && Number.isSafeInteger(previous.metadata?.qualifiedAt)
    ? previous.metadata.qualifiedAt : observedAt;
  const revision = previous?.status === 'LIVE_READY' ? previous.reviewRevision : `lead-${chain}-${qualifiedAt}`;
  return {
    ...token,
    status: 'LIVE_READY',
    auditedAt: observedAt,
    staleAt: observedAt + settings.liveLeadRetentionMs,
    reviewEvidence: revision,
    reviewRevision: revision,
    decisionReason: `市场线索：已通过 ${row.marketProvider === 'DEXSCREENER' ? 'DexScreener' : 'AVE'} 行情筛选，安全性待核验`,
    deep: {},
    social: socialFrom(token),
    info: { twitter: token.twitter, website: '' },
    metadata: { qualifiedAt, lastConfirmedAt: observedAt }
  };
}

function sampledOutcome(outcome, row, now) {
  const price = tokenInfoPrice(row, now), sampledAt = numberOrNull(row.sourceUpdatedAt);
  if (!(price > 0) || !(outcome.baselinePrice > 0) || !(sampledAt > 0) || sampledAt > now) return null;
  const samples = { ...(outcome.samples || {}) };
  let changed = false;
  for (const [key, windowMs] of Object.entries(horizons)) {
    const lagMs = sampledAt - outcome.baselineAt - windowMs;
    if (samples[key] || lagMs < 0 || lagMs > TRENDING_SAMPLE_GRACE_MS) continue;
    samples[key] = { at: sampledAt, targetAt: outcome.baselineAt + windowMs, lagMs, price, return: price / outcome.baselinePrice - 1,
      source: 'AVE_TRENDING', collectedAt: now };
    changed = true;
  }
  return changed ? { ...outcome, samples } : null;
}

function phaseError(message) {
  return new RecoverableScannerError('CYCLE_CHECKPOINT_PHASE_CONFLICT', message);
}

function checkpointCursor(checkpoint) {
  return {
    phase: checkpoint.phase,
    tokenIndex: checkpoint.tokenIndex,
    endpointIndex: checkpoint.endpointIndex,
    updatedAt: checkpoint.updatedAt,
    keyEpoch: checkpoint.keyEpoch,
    controlEpoch: checkpoint.controlEpoch
  };
}

function assertExpectedCursor(current, expected) {
  if (!expected) return;
  if (current.cycleId !== expected.cycleId || current.phase !== expected.phase
    || current.tokenIndex !== expected.tokenIndex || current.endpointIndex !== expected.endpointIndex
    || current.updatedAt !== expected.updatedAt || current.keyEpoch !== expected.keyEpoch
    || current.controlEpoch !== expected.controlEpoch) {
    throw new RecoverableScannerError('CYCLE_CHECKPOINT_CURSOR_CONFLICT', 'cycle request cursor changed while work was in flight');
  }
}

function outcomeWithSample(outcome, job, sample, error, now) {
  const next = clone(outcome);
  next.samples ||= {};
  next.sampleRetries ||= {};
  if (sample && Number.isFinite(sample.price) && sample.price > 0 && next.baselinePrice > 0
    && Number.isFinite(sample.at) && sample.at <= now && Math.abs(sample.at - job.targetAt) <= 60_000) {
    next.samples[job.key] = {
      ...clone(sample), targetAt: job.targetAt, lagMs: sample.at - job.targetAt, collectedAt: now,
      return: sample.price / next.baselinePrice - 1
    };
    delete next.sampleRetries[job.key];
  } else {
    const attempts = (next.sampleRetries[job.key]?.attempts || 0) + 1;
    next.sampleRetries[job.key] = {
      attempts,
      code: requestError(error).code,
      nextAt: now + Math.min(3_600_000, 120_000 * 2 ** Math.min(attempts - 1, 5))
    };
  }
  return next;
}

function outcomeKey(outcome, fallbackChain) {
  return tokenKey(outcome.chain || fallbackChain, outcome.address);
}

function settingsError() {
  return new RecoverableScannerError('RECOVERABLE_SCANNER_SETTINGS_INVALID', 'recoverable scanner settings are incomplete');
}

function validSettings(settings) {
  const positive = ['maxSecondaryChecksPerCycle', 'auditCycleBudgetMs', 'queueRetentionMs', 'scanIntervalMs',
    'candidateRetentionMs', 'outcomeRetentionMs', 'liveLeadRetentionMs', 'staleCandidateMs'];
  if (!completeScannerSettings(settings) || positive.some(key => !Number.isSafeInteger(settings[key]) || settings[key] <= 0)
    || !Number.isSafeInteger(settings.outcomeReadsPerCycle) || settings.outcomeReadsPerCycle < 0) throw settingsError();
  return settings;
}

export class RecoverableScanner {
  constructor({ store, settings, now = () => Date.now() }) {
    if (!store || typeof store.begin !== 'function' || typeof store.advance !== 'function') {
      throw new RecoverableScannerError('RECOVERABLE_SCANNER_STORE_INVALID', 'recoverable scanner requires a durable checkpoint store');
    }
    this.store = store;
    this.settings = Object.freeze({ ...validSettings(settings) });
    this.now = now;
  }

  // A cycle runs on the settings it began with. One begun by an earlier release, whose settings lack
  // a key this release reads, runs on this release's settings instead, never on an undefined threshold.
  #cycleSettings(checkpoint) {
    if (completeScannerSettings(checkpoint.partial.settings)) return checkpoint.partial.settings;
    console.log(JSON.stringify({ event: 'scan_settings_outdated', cycleId: checkpoint.cycleId }));
    return this.settings;
  }

  // Each cycle snapshots the scanner's settings, which callers take from the code (scannerSettings), never from an earlier cycle.
  // `onchainOffReason` is null when the on-chain source is configured, else the code source health shows.
  begin({ cycleId, chain, keyEpoch, controlEpoch, deadlineAt, partial = {}, onchainOffReason = 'ONCHAIN_NOT_CONFIGURED', afterBegin }) {
    const startedAt = this.now();
    return this.store.begin({ cycleId, chain, keyEpoch, controlEpoch, deadlineAt, phase: 'DISCOVER', tokenIndex: 0, endpointIndex: 0,
      partial: { ...clone(partial), rootCycleId: partial.rootCycleId || cycleId, startedAt, settings: clone(this.settings), onchainOffReason }, updatedAt: startedAt, afterBegin });
  }

  checkpoint(cycleId) {
    return this.store.read(cycleId);
  }

  resumeCheckpoint(cycleId) {
    if (typeof this.store.resumeCheckpoint !== 'function') {
      throw new RecoverableScannerError('RECOVERABLE_SCANNER_STORE_INVALID', 'recoverable scanner cannot resume a checkpoint');
    }
    const current = this.checkpoint(cycleId);
    if (!current) throw new RecoverableScannerError('CYCLE_CHECKPOINT_MISSING', 'cycle checkpoint does not exist');
    const now = this.now();
    return this.store.resumeCheckpoint({
      cycleId,
      now,
      evidenceFresh: checkpointEvidenceIsFresh(current.partial, now, this.settings.staleCandidateMs)
    });
  }

  nextRequest(cycleId) {
    const checkpoint = this.checkpoint(cycleId);
    if (!checkpoint) throw new RecoverableScannerError('CYCLE_CHECKPOINT_MISSING', 'cycle checkpoint does not exist');
    if (isCheckDeadlineBoundary(checkpoint, this.now())) {
      return Object.freeze({ kind: 'DEADLINE_EXPIRED', checkpoint });
    }
    if (checkpoint.phase === 'DISCOVER') {
      const endpoint = discoveryEndpoints(checkpoint.chain, checkpoint.partial)[checkpoint.endpointIndex];
      if (!endpoint) return null;
      const responses = checkpoint.partial.discovery?.responses || {}, state = () => this.store.readWatchState(checkpoint.chain);
      const params = endpoint === 'newPools' ? { cursor: state().cursor }
        : endpoint === 'watch' ? { addresses: watchTargets(state(), responses.newPools?.value?.pools || [], checkpoint.updatedAt) } : {};
      return Object.freeze({ kind: 'DISCOVER', endpoint, chain: checkpoint.chain, ...params, checkpoint });
    }
    if (checkpoint.phase === 'SECONDARY') {
      const item = checkpoint.partial.queue?.selected?.[checkpoint.tokenIndex];
      return item ? Object.freeze({ kind: 'SECONDARY', address: item.row.address, chain: checkpoint.chain, checkpoint }) : null;
    }
    if (checkpoint.phase === 'OUTCOMES_SAMPLE') {
      const now = this.now();
      if (now >= outcomeSampleDeadline(checkpoint, now)) return null;
      const outcome = checkpoint.partial.outcomes?.job;
      if (!outcome) return null;
      const stored = this.store.readOutcomes();
      const target = stored.find(row => outcomeKey(row, checkpoint.chain) === tokenKey(outcome.chain || checkpoint.chain, outcome.address));
      return hasAveOutcomeBaseline(target) ? Object.freeze({ kind: 'OUTCOMES_SAMPLE', ...clone(outcome), checkpoint }) : null;
    }
    return null;
  }

  recordRequest(cycleId, { value, error = null, collectedAt = this.now(), expectedCheckpoint = null }) {
    const current = this.checkpoint(cycleId);
    if (!current) throw new RecoverableScannerError('CYCLE_CHECKPOINT_MISSING', 'cycle checkpoint does not exist');
    assertExpectedCursor(current, expectedCheckpoint);
    const partial = clone(current.partial);
    const record = responseRecord(value, error, collectedAt);
    let nextPhase = current.phase;
    let endpointIndex = current.endpointIndex;

    if (current.phase === 'DISCOVER') {
      const endpoint = discoveryEndpoints(current.chain, current.partial)[endpointIndex];
      if (!endpoint) throw phaseError('discovery endpoint cursor is exhausted');
      partial.discovery ||= { responses: {} };
      partial.discovery.responses[endpoint] = record;
      partial.discovery.lastCollectedAt = collectedAt;
      if (endpoint === 'watch') {
        const markets = record.value?.markets || [];
        // The hot list screens its own tokens; a vetoed token never becomes a lead again.
        const excluded = new Set([...discoveryRows(partial.discovery).map(row => addressKey(row.address)),
          ...markets.map(market => market.address).filter(address => this.store.readCandidate(current.chain, address)?.status === 'HARD_REJECT')]);
        partial.discovery.promoted = promotions(this.store.readWatchState(current.chain), markets,
          { now: collectedAt, settings: this.#cycleSettings(current), excluded });
      }
      endpointIndex += 1;
      if (endpointIndex === discoveryEndpoints(current.chain, partial).length) {
        nextPhase = 'SCREEN';
        endpointIndex = 0;
      }
    } else if (current.phase === 'SECONDARY') {
      // One GoPlus read per token, whatever source cursor an older checkpoint holds.
      if (!partial.queue?.selected?.[current.tokenIndex]) throw phaseError('secondary token cursor is exhausted');
      partial.secondary = { sources: { goPlus: record }, lastCollectedAt: collectedAt };
      nextPhase = 'CLASSIFY_AND_COMMIT';
      endpointIndex = 0;
    } else {
      throw phaseError('current checkpoint phase does not accept a request response');
    }

    const expected = expectedCheckpoint || current;
    return this.store.advance({ expected: checkpointCursor(expected),
      next: { ...current, phase: nextPhase, tokenIndex: current.tokenIndex, endpointIndex, partial, updatedAt: collectedAt } });
  }

  advanceLocal(cycleId) {
    const current = this.checkpoint(cycleId);
    if (!current) throw new RecoverableScannerError('CYCLE_CHECKPOINT_MISSING', 'cycle checkpoint does not exist');
    const now = this.now();
    const partial = clone(current.partial);
    const settings = this.#cycleSettings(current);
    const expected = { phase: current.phase, keyEpoch: current.keyEpoch, controlEpoch: current.controlEpoch };
    let nextPhase;
    let tokenIndex = current.tokenIndex;

    if (isCheckDeadlineBoundary(current, now)) {
      partial.deadlineExpiredAt = now;
      delete partial.outcomes;
      partial.outcomeDeadlineAt = outcomeSampleDeadline(current, now);
      nextPhase = 'OUTCOMES_SAMPLE';
    } else if (pendingLegacyMarketRead(current)) {
      nextPhase = 'SCREEN';
    } else if (current.phase === 'SCREEN') {
      return this.#screen(current, partial, settings, now, expected);
    } else if (current.phase === 'BUILD_QUEUE') {
      const leads = (partial.leads || []).map(item => ({ row: item.row, screen: item.screen }));
      // A queued token is checked while it is a current lead or still stored, even after it leaves the hot list;
      // one that is neither can never be checked, so it leaves the queue instead of counting as due forever.
      const availableAddresses = new Set([...leads.map(item => item.row.address), ...this.store.readCandidateAddresses(current.chain)].map(addressKey));
      const queue = buildQueue(this.store.readAuditQueue(current.chain), leads, now, settings).filter(item => availableAddresses.has(addressKey(item.address)));
      const selected = selectAuditQueue(queue, availableAddresses, now, num(partial.scanCount) + 1, settings.maxSecondaryChecksPerCycle);
      const byAddress = new Map(leads.map(item => [addressKey(item.row.address), item]));
      // A stored token off the hot list is classified from its stored record, so it needs no hot-list row.
      const source = item => byAddress.get(addressKey(item.address)) ?? { row: { address: item.address }, screen: {} };
      partial.queue = {
        selected: selected.map(item => ({ ...item, row: clone(source(item).row), screen: clone(source(item).screen) }))
      };
      tokenIndex = 0;
      nextPhase = partial.queue.selected.length ? 'SECONDARY' : 'OUTCOMES_SAMPLE';
      if (nextPhase === 'OUTCOMES_SAMPLE') partial.outcomeDeadlineAt = outcomeSampleDeadline(current, now);
      return this.store.commitQueue({ expected, auditQueue: queue, next: { ...current, phase: nextPhase, tokenIndex, endpointIndex: 0, partial, updatedAt: now } });
    } else if (current.phase === 'OUTCOMES_SAMPLE') {
      partial.outcomeDeadlineAt = outcomeSampleDeadline(current, now);
      const jobs = now < partial.outcomeDeadlineAt && num(partial.outcomeReads) < outcomeReadLimit(settings)
        ? dueOutcomeJobs(retainedOutcomes(this.store.readOutcomes(), now, outcomeRetentionLimit(settings)), now) : [];
      const job = jobs[0];
      if (job) {
        partial.outcomes = { job: { chain: job.row.chain || current.chain, address: job.row.address, key: job.key, targetAt: job.targetAt } };
        nextPhase = 'OUTCOMES_SAMPLE';
      } else {
        delete partial.outcomes;
        partial.summary = { completedAt: now };
        nextPhase = 'SUMMARIZE';
      }
      return this.store.commitOutcomeSelection({ expected, next: { ...current, phase: nextPhase, tokenIndex, endpointIndex: 0, partial, updatedAt: now }, outcomeRetentionMs: outcomeRetentionLimit(settings) });
    } else if (current.phase === 'SUMMARIZE') {
      const scanCount = num(partial.scanCount) + 1;
      const rootCycleId = partial.rootCycleId || current.cycleId;
      const cycleSuffix = `:cycle:${scanCount + 1}`;
      const nextCycleAt = Math.max(now, num(partial.startedAt, current.updatedAt) + settings.scanIntervalMs);
      partial.scanCount = scanCount;
      partial.summary = {
        ...(partial.summary || {}),
        completedAt: now,
        finalized: true,
        scanCount,
        nextCycleId: `${String(rootCycleId).slice(0, 127 - cycleSuffix.length)}${cycleSuffix}`,
        nextCycleAt,
        nextDeadlineAt: nextCycleAt + settings.auditCycleBudgetMs
      };
      return this.store.commitSummary({
        expected,
        next: { ...current, phase: 'SUMMARIZE', tokenIndex, endpointIndex: 0, partial, updatedAt: now },
        candidateRetentionMs: candidateRetentionLimit(settings),
        outcomeRetentionMs: outcomeRetentionLimit(settings)
      });
    } else {
      throw phaseError('current checkpoint phase does not have a local transition');
    }
    return this.store.advance({ expected, next: { ...current, phase: nextPhase, tokenIndex, endpointIndex: 0, partial, updatedAt: now } });
  }

  #screen(current, partial, settings, now, expected) {
    const chain = current.chain;
    const record = partial.discovery?.responses?.trending;
    const trending = discoveryRows(partial.discovery), rows = [...trending, ...promotedRows(partial.discovery, chain)];
    const observedAt = num(record?.value?.capturedAt, num(record?.collectedAt, now));
    // A promoted row's clock is the watch's DexScreener read, not the hot list's.
    const observedFor = row => row.discoverySource === 'newPool' ? num(row.capturedAt, observedAt) : observedAt;
    const screened = rows.map(row => ({ row, screen: discoveryScreen(row, { ...settings, chain }, now / 1000) }));
    const leads = [], eliminated = [], events = [], rejected = [];
    for (const { row, screen } of screened) {
      const previous = this.store.readCandidate(chain, row.address);
      if (screen.pass && previous?.status !== 'HARD_REJECT') {
        const lead = leadCandidate(row, screen, chain, previous, observedFor(row), settings);
        leads.push({ row, screen, candidate: lead, previous });
        if (previous?.status !== 'LIVE_READY') {
          events.push({ address: lead.address, effectType: 'CANDIDATE_NEW', type: 'CANDIDATE_NEW',
            message: `${lead.symbol}：新市场线索，安全性待核验`, data: { address: lead.address, reviewRevision: lead.reviewRevision } });
        }
      } else if (!screen.pass && previous?.status === 'LIVE_READY') {
        // Failing a current screen ends a lead's live state; missing from one hot list does not.
        eliminated.push({ address: row.address, reasons: screen.reasons });
      } else if (!screen.pass && !previous) rejected.push({ row, screen });
    }
    // An AVE baseline is sampled only from AVE's hot list, never from a DexScreener quote.
    const rowsByAddress = new Map(trending.map(row => [addressKey(row.address), row]));
    const stored = new Map(this.store.readOutcomes(chain).map(outcome => [addressKey(outcome.address), outcome]));
    const candidateAddresses = new Set(this.store.readCandidateAddresses(chain).map(addressKey));
    // Changed or new outcome rows by token; only these are written.
    const outcomes = new Map();
    for (const [key, outcome] of stored) {
      const row = rowsByAddress.get(key);
      let next = row && TRACKED_DECISIONS.has(outcome.initialDecision) && hasAveOutcomeBaseline(outcome)
        ? sampledOutcome(outcome, row, now) || outcome : outcome;
      // A lead's verdict converges on its stored candidate every cycle; once the candidate is pruned, it keeps its last one.
      if (candidateAddresses.has(key)) {
        const verdict = safetyVerdict(this.store.readCandidate(chain, outcome.address));
        if (verdict !== outcome.latestDecision) next = { ...next, latestDecision: verdict };
      }
      if (next !== outcome) outcomes.set(key, next);
    }
    // Only AVE samples outcomes, so only an AVE quote is a baseline. A lead promoted from DexScreener is
    // tracked from its first sighting on the hot list, if any, until a DexScreener sampler exists (#102).
    for (const { row, candidate, previous } of leads) {
      const price = tokenInfoPrice(row, now), baselineAt = numberOrNull(row.sourceUpdatedAt), key = addressKey(candidate.address);
      const rejection = stored.get(key)?.initialDecision === DISCOVERY_REJECT ? stored.get(key) : null;
      if (row.marketProvider !== 'AVE' || (stored.has(key) && !rejection) || !(price > 0) || !(baselineAt > 0)) continue;
      // The token's final decision wins: a sampled rejection gives way to the lead it became, baselined at the alert.
      // The lead keeps any earlier check's evidence, so its verdict starts from that check.
      outcomes.set(key, { chain, address: candidate.address, symbol: candidate.symbol, initialDecision: 'LIVE_READY',
        latestDecision: safetyVerdict({ status: 'LIVE_READY', secondary: previous?.secondary, deep: previous?.deep }),
        baselineAt, baselinePrice: price, lastAuditedAt: observedAt, latestFailed: [], samples: {}, sampleRetries: {},
        sampling: 'ALL_LEADS', strategyVersion: 'ave-leads-v1',
        cohortMetadata: { baselineProvider: 'AVE', ...(rejection ? { rejectedAt: rejection.baselineAt } : {}) } });
    }
    // The control cohort: a stable sample of hot-list tokens the screen rejected, sampled like leads.
    let rejectedToday = [...stored.values()].filter(outcome => outcome.initialDecision === DISCOVERY_REJECT && now - outcome.baselineAt < 86_400_000).length;
    for (const { row, screen } of rejected) {
      const price = tokenInfoPrice(row, now), baselineAt = numberOrNull(row.sourceUpdatedAt), key = addressKey(row.address);
      if (rejectedToday >= REJECTED_SAMPLE_DAILY_CAP) break;
      if (row.marketProvider !== 'AVE' || stored.has(key) || outcomes.has(key) || !(price > 0) || !(baselineAt > 0)
        || !sampledForRejection(chain, row.address)) continue;
      rejectedToday += 1;
      outcomes.set(key, { chain, address: row.address, symbol: String(row.symbol || '?').slice(0, 30), initialDecision: DISCOVERY_REJECT, latestDecision: null,
        baselineAt, baselinePrice: price, lastAuditedAt: observedAt, latestFailed: screen.reasons, samples: {}, sampleRetries: {},
        sampling: 'FNV1A_MOD5', strategyVersion: 'ave-rejected-v1', cohortMetadata: { baselineProvider: 'AVE' } });
    }
    const discoveryError = record?.error || null;
    const feed = {
      at: now, observedAt: discoveryError ? null : observedAt, status: discoveryError ? discoveryError.code : 'READY',
      receivedCount: rows.length, leadCount: leads.length,
      rows: screened.map(({ row, screen }) => feedRow(row, screen))
        .sort((left, right) => Number(right.pass) - Number(left.pass) || num(right.volume5m) - num(left.volume5m)).slice(0, FEED_ROWS)
    };
    const sourceHealth = { discovery: { provider: 'AVE', complete: !discoveryError, checkedAt: now,
      trending: discoveryError ? { ok: false, code: discoveryError.code } : { ok: true, count: trending.length } } };
    let watchState = null;
    if (POOL_SOURCES[chain] && partial.onchainOffReason !== null) sourceHealth.discovery.newPools = { ok: false, code: partial.onchainOffReason };
    else if (POOL_SOURCES[chain]) {
      const { newPools, watch } = partial.discovery?.responses || {};
      const promoted = partial.discovery?.promoted || [];
      const passed = new Set(screened.filter(({ row, screen }) => row.discoverySource === 'newPool' && screen.pass).map(({ row }) => addressKey(row.address)));
      watchState = nextWatchState(this.store.readWatchState(chain), { newPools: newPools?.value ?? null, checked: watch?.value?.addresses || [],
        markets: watch?.value?.markets || [], promoted, rejected: promoted.filter(address => !passed.has(addressKey(address))), now });
      const endpoint = (response, count) => response?.error ? { ok: false, code: response.error.code } : { ok: true, count };
      Object.assign(sourceHealth.discovery, { newPools: endpoint(newPools, newPools?.value?.pools?.length ?? 0),
        watch: endpoint(watch, watchState.pools.length), promoted: { ok: true, count: promoted.length } });
    }
    partial.leads = leads.map(({ row, screen }) => ({ row, screen }));
    partial.prequalifiedCount = leads.length;
    partial.discoveredCount = rows.length;
    delete partial.discovery;
    return this.store.commitScreen({
      expected,
      leads: leads.map(item => item.candidate),
      eliminated,
      events,
      outcomes: [...outcomes.values()],
      feed,
      sourceHealth,
      watchState,
      next: { ...current, phase: 'BUILD_QUEUE', tokenIndex: 0, endpointIndex: 0, partial, updatedAt: now }
    });
  }

  async commitClassification(cycleId) {
    const current = this.checkpoint(cycleId);
    if (!current) throw new RecoverableScannerError('CYCLE_CHECKPOINT_MISSING', 'cycle checkpoint does not exist');
    if (current.phase !== 'CLASSIFY_AND_COMMIT') throw phaseError('classification can only commit from CLASSIFY_AND_COMMIT');
    const item = current.partial.queue?.selected?.[current.tokenIndex];
    if (!item?.row || !item?.screen) throw phaseError('classification token cursor is exhausted');
    const now = this.now();
    const settings = this.#cycleSettings(current);
    const stored = this.store.readCandidate(current.chain, item.row.address);
    const token = stored || leadCandidate(item.row, item.screen, current.chain, null, now, settings);
    // Seller evidence comes only from this cycle's row: a stored token off the hot list has none.
    // A promoted pool's row offers DexScreener's sell transactions instead of AVE's distinct sellers.
    const secondary = aggregateSecondarySources({ chain: current.chain, tokenAddress: token.address,
      sources: current.partial.secondary?.sources || {}, distinctSellers24h: item.row.sellers_24h,
      dexSells24h: item.row.marketProvider === 'DEXSCREENER' ? item.row.sells_24h : null });
    const supported = Object.values(secondary.sources).some(source => source?.status !== 'UNSUPPORTED');
    const vetoed = secondary.security?.verdict === 'FATAL';
    const secondaryReason = vetoed ? '第二安全源触发一票否决'
      : !supported ? '当前链暂无第二数据源，安全性未核验'
        : secondary.status !== 'COMPLETE' || secondary.security?.verdict === 'UNKNOWN' ? '第二数据源不完整，安全性未完全核验' : '';
    const wasLead = stored?.status === 'LIVE_READY';
    const candidate = vetoed
      ? { ...token, status: 'HARD_REJECT', auditedAt: now, staleAt: now + settings.staleCandidateMs,
        reviewEvidence: `veto-${current.chain}-${now}`, reviewRevision: `veto-${current.chain}-${now}` }
      : { ...token };
    candidate.secondary = secondary;
    candidate.decisionReason = [vetoed ? '' : token.decisionReason, secondaryReason].filter(Boolean).join('；');
    const queue = {
      ...item,
      lastAuditedAt: now,
      nextAuditAt: now + nextAuditDelay(candidate.status, settings),
      attempts: num(item.attempts) + 1,
      status: candidate.status
    };
    delete queue.row;
    delete queue.screen;
    const outcomes = this.store.readOutcomes(current.chain);
    const tracked = outcomes.find(row => addressKey(row.address) === addressKey(candidate.address));
    const outcome = tracked ? { ...tracked, latestDecision: safetyVerdict(candidate), lastAuditedAt: now } : null;
    const nextTokenIndex = current.tokenIndex + 1;
    const partial = clone(current.partial);
    partial.lastCommittedAt = now;
    partial.lastCandidateAddress = candidate.address;
    delete partial.secondary;
    const nextPhase = nextTokenIndex < (partial.queue?.selected?.length || 0) ? 'SECONDARY' : 'OUTCOMES_SAMPLE';
    if (nextPhase === 'OUTCOMES_SAMPLE') partial.outcomeDeadlineAt = outcomeSampleDeadline(current, now);
    const event = vetoed && wasLead
      ? {
          effectType: 'RISK_WORSENED',
          type: 'RISK_WORSENED',
          message: `${candidate.symbol}：第二安全源一票否决，线索已撤销`,
          data: { address: candidate.address, reviewRevision: candidate.reviewRevision }
        }
      : null;
    return this.store.commitClassification({
      expected: { phase: current.phase, keyEpoch: current.keyEpoch, controlEpoch: current.controlEpoch },
      next: { ...current, phase: nextPhase, tokenIndex: nextTokenIndex, endpointIndex: 0, partial, updatedAt: now },
      candidate,
      auditQueue: queue,
      outcome,
      event,
      sourceHealth: { lastSecondary: { complete: secondary.complete, checkedAt: now, sources: secondary.sources } }
    });
  }

  recordOutcomeSample(cycleId, { sample = null, error = null, collectedAt = this.now(), expectedCheckpoint = null }) {
    const current = this.checkpoint(cycleId);
    if (!current) throw new RecoverableScannerError('CYCLE_CHECKPOINT_MISSING', 'cycle checkpoint does not exist');
    assertExpectedCursor(current, expectedCheckpoint);
    if (current.phase !== 'OUTCOMES_SAMPLE') throw phaseError('outcome samples can only commit from OUTCOMES_SAMPLE');
    const job = current.partial.outcomes?.job;
    if (!job) throw phaseError('outcome sample checkpoint has no job');
    const outcomes = this.store.readOutcomes();
    const jobChain = job.chain || current.chain;
    const outcome = outcomes.find(row => outcomeKey(row, current.chain) === tokenKey(jobChain, job.address));
    if (!outcome) throw new RecoverableScannerError('OUTCOME_MISSING', 'outcome sample target no longer exists');
    if (!hasAveOutcomeBaseline(outcome)) throw new RecoverableScannerError('OUTCOME_PROVIDER_MISMATCH', 'outcome baseline is not AVE');
    const progressed = outcomeWithSample(outcome, job, sample, error, collectedAt);
    const nextOutcomes = outcomes.map(row => outcomeKey(row, current.chain) === tokenKey(jobChain, job.address) ? progressed : row);
    const partial = clone(current.partial);
    partial.outcomeReads = num(partial.outcomeReads) + 1;
    const nextJob = collectedAt < outcomeSampleDeadline(current, collectedAt)
      && partial.outcomeReads < outcomeReadLimit(this.#cycleSettings(current))
      ? dueOutcomeJobs(nextOutcomes, collectedAt)[0] : null;
    if (nextJob) partial.outcomes = { job: { chain: nextJob.row.chain || current.chain, address: nextJob.row.address, key: nextJob.key, targetAt: nextJob.targetAt } };
    else delete partial.outcomes;
    const expected = expectedCheckpoint || current;
    return this.store.commitOutcomeProgress({
      expected: checkpointCursor(expected),
      outcome: progressed,
      next: {
        ...current,
        phase: nextJob ? 'OUTCOMES_SAMPLE' : 'SUMMARIZE',
        tokenIndex: current.tokenIndex,
        endpointIndex: 0,
        partial,
        updatedAt: collectedAt
      }
    });
  }
}

