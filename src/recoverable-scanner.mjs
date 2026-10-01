import { tokenInfoPrice } from './providers/ave.mjs';
import { aggregateSecondarySources } from './providers/secondary.mjs';
import { discoveryScreen } from './scoring/index.mjs';
import { blockingConflicts } from './scoring/safety.mjs';
import { dueOutcomeJobs, hasAveOutcomeBaseline, horizons } from './scoring/outcomes.mjs';
import { addressKey, buildQueue, nextAuditDelay, publicToken, selectAuditQueue, socialFrom } from './scanner-parity.mjs';
import { RecoverableScannerError } from './storage/recoverable-scanner.mjs';
import { POOL_SOURCES } from './providers/chain-logs.mjs';
import { nextWatchState, promotions, watchTargets } from './onchain-watch.mjs';

// One cycle reads the chain's AVE trending list, screens it with upstream's
// AVE market screen, and turns every passing token into a lead immediately.
// On a chain with pinned pool factories it also reads the new pools its logs
// created, watches them on DexScreener, and reads AVE's market row for up to
// two that trade enough, so they are screened alongside the hot list.
// Leads then get the free GoPlus and DexScreener checks; a fatal security
// finding vetoes the lead. No AVE token audit runs: AVE has no holder, trader
// or contract-security data, so an AVE audit could never pass (upstream v0.1.10).
// The discovery requests for a cycle; the AVE market reads follow from what the watch found.
// A cycle reads new pools only when it began with the on-chain source configured.
function discoveryEndpoints(chain, partial) {
  if (!POOL_SOURCES[chain] || partial.onchainDiscovery !== true) return ['trending'];
  return ['trending', 'newPools', 'watch', ...(partial.discovery?.promoted || []).map((_, index) => `market:${index}`)];
}
const SECONDARY_SOURCES = Object.freeze(['dexScreener', 'goPlus']);
const OUTCOME_SAMPLE_GRACE_MS = 25_000;
// Upstream samples an outcome horizon from a later hot-list quote within this lag.
const TRENDING_SAMPLE_GRACE_MS = 5 * 60_000;
const FEED_ROWS = 50;
const TRACKED_DECISIONS = new Set(['LIVE_READY', 'HARD_REJECT']);

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
    && checkpoint.phase === 'SECONDARY' && checkpoint.endpointIndex === 0 && checkpoint.tokenIndex > 0;
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

// AVE market rows for promoted new pools, after the hot list's own rows.
function promotedRows(discovery, trending) {
  const listed = new Set(trending.map(row => addressKey(row.address)));
  return Object.entries(discovery?.responses || {}).filter(([endpoint]) => endpoint.startsWith('market:'))
    .map(([, record]) => record.value?.row).filter(row => row && typeof row === 'object' && !listed.has(addressKey(row.address)))
    .map(row => ({ ...row, discoverySource: 'newPool' }));
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
    decisionReason: '市场线索：已通过 AVE 行情筛选，安全性待核验',
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
  if (!settings || typeof settings !== 'object' || positive.some(key => !Number.isSafeInteger(settings[key]) || settings[key] <= 0)
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

  begin({ cycleId, chain, keyEpoch, controlEpoch, deadlineAt, partial = {}, onchainDiscovery = false, afterBegin }) {
    const startedAt = this.now();
    return this.store.begin({ cycleId, chain, keyEpoch, controlEpoch, deadlineAt, phase: 'DISCOVER', tokenIndex: 0, endpointIndex: 0,
      partial: { ...clone(partial), rootCycleId: partial.rootCycleId || cycleId, startedAt, settings: clone(this.settings), onchainDiscovery }, updatedAt: startedAt, afterBegin });
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
        : endpoint === 'watch' ? { addresses: watchTargets(state(), responses.newPools?.value?.pools || [], checkpoint.updatedAt) }
          : endpoint.startsWith('market:') ? { address: checkpoint.partial.discovery.promoted[Number(endpoint.slice(7))] } : {};
      return Object.freeze({ kind: 'DISCOVER', endpoint, chain: checkpoint.chain, ...params, checkpoint });
    }
    if (checkpoint.phase === 'SECONDARY') {
      const item = checkpoint.partial.queue?.selected?.[checkpoint.tokenIndex];
      const source = SECONDARY_SOURCES[checkpoint.endpointIndex];
      return item && source ? Object.freeze({ kind: 'SECONDARY', source, address: item.row.address, chain: checkpoint.chain, checkpoint }) : null;
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
        const hotList = new Set(discoveryRows(partial.discovery).map(row => addressKey(row.address)));
        partial.discovery.promoted = promotions(this.store.readWatchState(current.chain), record.value?.markets || [],
          { now: collectedAt, settings: partial.settings || this.settings, hotList });
      }
      endpointIndex += 1;
      if (endpointIndex === discoveryEndpoints(current.chain, partial).length) {
        nextPhase = 'SCREEN';
        endpointIndex = 0;
      }
    } else if (current.phase === 'SECONDARY') {
      const source = SECONDARY_SOURCES[endpointIndex];
      if (!source) throw phaseError('secondary source cursor is exhausted');
      if (!partial.queue?.selected?.[current.tokenIndex]) throw phaseError('secondary token cursor is exhausted');
      partial.secondary ||= { sources: {} };
      partial.secondary.sources[source] = record;
      partial.secondary.lastCollectedAt = collectedAt;
      endpointIndex += 1;
      if (endpointIndex === SECONDARY_SOURCES.length) {
        nextPhase = 'CLASSIFY_AND_COMMIT';
        endpointIndex = 0;
      }
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
    const settings = partial.settings || this.settings;
    const expected = { phase: current.phase, keyEpoch: current.keyEpoch, controlEpoch: current.controlEpoch };
    let nextPhase;
    let tokenIndex = current.tokenIndex;

    if (isCheckDeadlineBoundary(current, now)) {
      partial.deadlineExpiredAt = now;
      delete partial.outcomes;
      partial.outcomeDeadlineAt = outcomeSampleDeadline(current, now);
      nextPhase = 'OUTCOMES_SAMPLE';
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
    const trending = discoveryRows(partial.discovery), rows = [...trending, ...promotedRows(partial.discovery, trending)];
    const observedAt = num(record?.value?.capturedAt, num(record?.collectedAt, now));
    // A promoted row's clock is its own AVE read, not the hot list's.
    const observedFor = row => row.discoverySource === 'newPool' ? num(row.capturedAt, observedAt) : observedAt;
    const screened = rows.map(row => ({ row, screen: discoveryScreen(row, { ...settings, chain }, now / 1000) }));
    const leads = [], eliminated = [], events = [];
    for (const { row, screen } of screened) {
      const previous = this.store.readCandidate(chain, row.address);
      if (screen.pass && previous?.status !== 'HARD_REJECT') {
        const lead = leadCandidate(row, screen, chain, previous, observedFor(row), settings);
        leads.push({ row, screen, candidate: lead });
        if (previous?.status !== 'LIVE_READY') {
          events.push({ address: lead.address, effectType: 'CANDIDATE_NEW', type: 'CANDIDATE_NEW',
            message: `${lead.symbol}：新市场线索，安全性待核验`, data: { address: lead.address, reviewRevision: lead.reviewRevision } });
        }
      } else if (!screen.pass && previous?.status === 'LIVE_READY') {
        // Failing a current screen ends a lead's live state; missing from one hot list does not.
        eliminated.push({ address: row.address, reasons: screen.reasons });
      }
    }
    const rowsByAddress = new Map(rows.map(row => [addressKey(row.address), row]));
    const stored = this.store.readOutcomes(chain);
    const outcomes = [];
    for (const outcome of stored) {
      const row = rowsByAddress.get(addressKey(outcome.address));
      if (!row || !TRACKED_DECISIONS.has(outcome.initialDecision) || !hasAveOutcomeBaseline(outcome)) continue;
      const sampled = sampledOutcome(outcome, row, now);
      if (sampled) outcomes.push(sampled);
    }
    const tracked = new Set(stored.map(outcome => addressKey(outcome.address)));
    for (const { row, candidate } of leads) {
      const price = tokenInfoPrice(row, now), baselineAt = numberOrNull(row.sourceUpdatedAt);
      if (tracked.has(addressKey(candidate.address)) || !(price > 0) || !(baselineAt > 0)) continue;
      outcomes.push({ chain, address: candidate.address, symbol: candidate.symbol, initialDecision: 'LIVE_READY', latestDecision: 'LIVE_READY',
        baselineAt, baselinePrice: price, lastAuditedAt: observedAt, latestFailed: [], samples: {}, sampleRetries: {},
        sampling: 'ALL_LEADS', strategyVersion: 'ave-leads-v1', cohortMetadata: { baselineProvider: 'AVE' } });
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
    if (POOL_SOURCES[chain] && partial.onchainDiscovery !== true) sourceHealth.discovery.newPools = { ok: false, code: 'ONCHAIN_NOT_CONFIGURED' };
    else if (POOL_SOURCES[chain]) {
      const { newPools, watch } = partial.discovery?.responses || {};
      watchState = nextWatchState(this.store.readWatchState(chain), { newPools: newPools?.value ?? null, checked: watch?.value?.addresses || [],
        markets: watch?.value?.markets || [], promoted: partial.discovery?.promoted || [], now });
      const endpoint = (response, count) => response?.error ? { ok: false, code: response.error.code } : { ok: true, count };
      Object.assign(sourceHealth.discovery, { newPools: endpoint(newPools, newPools?.value?.pools?.length ?? 0),
        watch: endpoint(watch, watchState.pools.length), promoted: { ok: true, count: (partial.discovery?.promoted || []).length } });
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
      outcomes,
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
    const settings = current.partial.settings || this.settings;
    const stored = this.store.readCandidate(current.chain, item.row.address);
    const token = stored || leadCandidate(item.row, item.screen, current.chain, null, now, settings);
    const secondary = aggregateSecondarySources({
      chain: current.chain,
      tokenAddress: token.address,
      primary: { market: { priceUsd: token.price, marketCap: token.marketCap, liquidityUsd: token.liquidity, website: token.info?.website || '' }, security: {} },
      sources: current.partial.secondary?.sources || {}
    });
    const supported = Object.values(secondary.sources).some(source => source?.status !== 'UNSUPPORTED');
    const vetoed = secondary.security?.verdict === 'FATAL';
    const secondaryReason = vetoed ? '第二安全源触发一票否决'
      : !supported ? '当前链暂无第二数据源，安全性未核验'
        : secondary.status !== 'COMPLETE' || secondary.security?.verdict === 'UNKNOWN' ? '第二数据源不完整，安全性未完全核验'
          : blockingConflicts(secondary).length ? '多源数据冲突，请人工复核' : '';
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
    const outcome = tracked ? { ...tracked, latestDecision: candidate.status, lastAuditedAt: now } : null;
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
      && partial.outcomeReads < outcomeReadLimit(partial.settings || this.settings)
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

