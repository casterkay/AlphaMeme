import { CHART_RISK_VERSION } from './scoring/chart-risk.mjs';
import { deepScreen, discoveryScreen } from './scoring/index.mjs';
import { normalizeGmgnList, tokenInfoPrice, unwrapGmgn } from './providers/gmgn-normalize.mjs';
import { dueOutcomeJobs, horizons, sampleRejected } from './scoring/outcomes.mjs';
import {
  classifyDeepResult as classifyRecoverableDeepResult,
  mergeSecondaryClassification as mergeRecoverableSecondaryClassification
} from './scoring/classification.mjs';
import { aggregateSecondarySources } from './providers/secondary.mjs';
import {
  addressKey,
  buildQueue,
  nextAuditDelay,
  publicToken,
  reviewRevision as reviewEvidence,
  selectAuditQueue,
  socialFrom
} from './scanner-parity.mjs';
import { RecoverableScannerError, SCAN_PHASES } from './storage/recoverable-scanner.mjs';
import { SqliteControlStateStore } from './storage/control-state.mjs';

const AUDIT_ENDPOINTS = Object.freeze(['info', 'security', 'pool', 'holders', 'traders', 'candles']);
const DISCOVERY_ENDPOINTS = Object.freeze(['trenches', 'trending']);
const SECONDARY_SOURCES = Object.freeze(['dexScreener', 'goPlus']);

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

function first(...values) {
  return values.find(value => value !== undefined && value !== null && value !== '');
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
  return Number.isSafeInteger(settings.outcomeReadsPerCycle) && settings.outcomeReadsPerCycle > 0
    ? settings.outcomeReadsPerCycle : 4;
}

function candidateRetentionLimit(settings) {
  return Number.isSafeInteger(settings.candidateRetentionMs) && settings.candidateRetentionMs > 0
    ? settings.candidateRetentionMs : 2 * 60 * 60_000;
}

function outcomeRetentionLimit(settings) {
  return Number.isSafeInteger(settings.outcomeRetentionMs) && settings.outcomeRetentionMs > 0
    ? settings.outcomeRetentionMs : 7 * 24 * 60 * 60_000;
}

function retainedOutcomes(outcomes, now, retentionMs) {
  return outcomes.filter(outcome => now - num(outcome.baselineAt) <= retentionMs);
}

function monitorItem(row) {
  return {
    row: {
      address: String(row.address),
      symbol: String(row.symbol || String(row.address).slice(0, 6)),
      name: String(row.name || ''),
      price: row.price,
      market_cap: row.marketCap,
      liquidity: row.liquidity,
      creation_timestamp: row.createdAt,
      _monitorOnly: true
    },
    screen: {
      mc: num(row.marketCap),
      liquidity: num(row.liquidity),
      ageSec: num(row.ageSec),
      priorityBand: true,
      score: 0
    }
  };
}

function isAuditDeadlineBoundary(checkpoint, now) {
  return checkpoint.deadlineAt !== null && now >= checkpoint.deadlineAt
    && checkpoint.phase === 'AUDIT' && checkpoint.endpointIndex === 0 && checkpoint.tokenIndex > 0;
}

function boundedRows(value) {
  return Array.isArray(value) ? clone(value.filter(row => row && typeof row === 'object').slice(0, 200)) : [];
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
  if (Array.isArray(discovery?.rows)) return boundedRows(discovery.rows);
  const trenches = discovery?.responses?.trenches?.error ? [] : normalizeGmgnList(discovery?.responses?.trenches?.value, ['completed']);
  const trending = discovery?.responses?.trending?.error ? [] : normalizeGmgnList(discovery?.responses?.trending?.value, ['rank']);
  const byAddress = new Map();
  for (const row of [...trenches, ...trending]) {
    if (!row?.address) continue;
    byAddress.set(addressKey(row.address), { ...(byAddress.get(addressKey(row.address)) || {}), ...row });
  }
  return boundedRows([...byAddress.values()]);
}

function auditValue(record, name) {
  if (!record || record.error) return name === 'holders' || name === 'traders' || name === 'candles' ? [] : {};
  return name === 'holders' || name === 'traders' || name === 'candles'
    ? normalizeGmgnList(record.value)
    : unwrapGmgn(record.value) || {};
}

function auditFromPartial(partial) {
  const responses = partial.audit?.responses || {};
  const endpoints = Object.fromEntries(AUDIT_ENDPOINTS.map(name => [name,
    responses[name]?.error ? { ok: false, ...responses[name].error } : responses[name] ? { ok: true } : { ok: false, code: 'NOT_REQUESTED', message: '端点尚未请求' }
  ]));
  const complete = AUDIT_ENDPOINTS.every(name => responses[name] && !responses[name].error);
  return {
    info: auditValue(responses.info, 'info'),
    security: auditValue(responses.security, 'security'),
    pool: auditValue(responses.pool, 'pool'),
    holders: auditValue(responses.holders, 'holders'),
    traders: auditValue(responses.traders, 'traders'),
    candles: auditValue(responses.candles, 'candles'),
    _meta: {
      complete,
      earlyExit: Boolean(partial.audit?.earlyExit),
      endpoints,
      auditedAt: Math.max(0, ...Object.values(responses).map(record =>
        Number.isSafeInteger(record?.collectedAt) && record.collectedAt >= 0 ? record.collectedAt : 0
      ))
    }
  };
}

function secondaryFromPartial(partial, { chain, address, primary }) {
  const responses = partial.secondary?.sources;
  if (partial.secondary?.result && Object.values(responses || {}).some(response => response?.value?.result)) {
    return partial.secondary.result;
  }
  if (responses && Object.keys(responses).length) {
    return aggregateSecondarySources({ chain, tokenAddress: address, primary, sources: responses });
  }
  return partial.secondary?.result || null;
}

export { classifyRecoverableDeepResult, mergeRecoverableSecondaryClassification };
export { selectAuditQueue as selectRecoverableAuditQueue };

function phaseError(message) {
  return new RecoverableScannerError('CYCLE_CHECKPOINT_PHASE_CONFLICT', message);
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

async function outcomeForClassification(store, chain, candidate, now) {
  const outcomes = typeof store.readOutcomes === 'function' ? store.readOutcomes(chain) : [];
  const existing = outcomes.find(row => addressKey(row.address) === addressKey(candidate.address));
  if (existing) {
    return {
      ...existing,
      latestDecision: candidate.status,
      latestFailed: clone(candidate.deep?.failed || []),
      lastAuditedAt: candidate.auditedAt
    };
  }
  if (candidate.status === 'X_REVIEW' && candidate.price > 0) {
    return {
      address: candidate.address,
      initialDecision: 'X_REVIEW',
      latestDecision: candidate.status,
      baselineAt: now,
      baselinePrice: candidate.price,
      lastAuditedAt: candidate.auditedAt,
      symbol: candidate.symbol,
      latestFailed: clone(candidate.deep?.failed || []),
      samples: {}
    };
  }
  if (candidate.status === 'HARD_REJECT' && candidate.price > 0 && typeof store.readOutcomes === 'function') {
    await sampleRejected(outcomes, candidate, now);
    return outcomes.find(row => addressKey(row.address) === addressKey(candidate.address)) || null;
  }
  return null;
}

export class RecoverableScanner {
  constructor({ store, settings, now = () => Date.now() }) {
    if (!store || typeof store.begin !== 'function' || typeof store.advance !== 'function') {
      throw new RecoverableScannerError('RECOVERABLE_SCANNER_STORE_INVALID', 'recoverable scanner requires a durable checkpoint store');
    }
    if (!settings || typeof settings !== 'object' || !Number.isSafeInteger(settings.maxDeepAuditsPerCycle)
      || !Number.isSafeInteger(settings.auditCycleBudgetMs) || !Number.isSafeInteger(settings.queueRetentionMs)
      || !Number.isSafeInteger(settings.scanIntervalMs)) {
      throw new RecoverableScannerError('RECOVERABLE_SCANNER_SETTINGS_INVALID', 'recoverable scanner settings are incomplete');
    }
    this.store = store;
    this.settings = Object.freeze({ ...settings });
    this.now = now;
  }

  begin({ cycleId, chain, keyEpoch, controlEpoch, deadlineAt, partial = {}, afterBegin }) {
    const startedAt = this.now();
    return this.store.begin({ cycleId, chain, keyEpoch, controlEpoch, deadlineAt, phase: 'DISCOVER', tokenIndex: 0, endpointIndex: 0,
      partial: { ...clone(partial), rootCycleId: partial.rootCycleId || cycleId, startedAt, settings: clone(this.settings) }, updatedAt: startedAt, afterBegin });
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
    const maximumAgeMs = Number.isSafeInteger(this.settings.staleCandidateMs) && this.settings.staleCandidateMs > 0
      ? this.settings.staleCandidateMs
      : 10 * 60_000;
    return this.store.resumeCheckpoint({
      cycleId,
      now,
      evidenceFresh: checkpointEvidenceIsFresh(current.partial, now, maximumAgeMs)
    });
  }

  validateResumeCheckpoint(cycleId) {
    const current = this.checkpoint(cycleId);
    if (!current) throw new RecoverableScannerError('CYCLE_CHECKPOINT_MISSING', 'cycle checkpoint does not exist');
    const now = this.now();
    const maximumAgeMs = Number.isSafeInteger(this.settings.staleCandidateMs) && this.settings.staleCandidateMs > 0
      ? this.settings.staleCandidateMs
      : 10 * 60_000;
    const control = new SqliteControlStateStore(this.store.storage, current.tenantId).snapshot();
    if (!control.configured) {
      throw new RecoverableScannerError('CYCLE_RESUME_NOT_ELIGIBLE', 'cycle cannot resume while scanning is disabled');
    }
    if (current.keyEpoch !== control.keyEpoch) {
      throw new RecoverableScannerError('CYCLE_KEY_EPOCH_STALE', 'cycle credential epoch cannot resume');
    }
    if (current.deadlineAt !== null && current.deadlineAt <= now) {
      throw new RecoverableScannerError('CYCLE_DEADLINE_EXPIRED', 'cycle deadline elapsed while paused');
    }
    if (!checkpointEvidenceIsFresh(current.partial, now, maximumAgeMs)) {
      throw new RecoverableScannerError('CYCLE_EVIDENCE_STALE', 'cycle evidence must be revalidated before resuming');
    }
    return current;
  }

  nextRequest(cycleId) {
    const checkpoint = this.checkpoint(cycleId);
    if (!checkpoint) throw new RecoverableScannerError('CYCLE_CHECKPOINT_MISSING', 'cycle checkpoint does not exist');
    if (isAuditDeadlineBoundary(checkpoint, this.now())) {
      return Object.freeze({ kind: 'DEADLINE_EXPIRED', checkpoint });
    }
    if (checkpoint.phase === 'DISCOVER') {
      const endpoint = DISCOVERY_ENDPOINTS[checkpoint.endpointIndex];
      return endpoint ? Object.freeze({ kind: 'DISCOVER', endpoint, checkpoint }) : null;
    }
    if (checkpoint.phase === 'AUDIT') {
      const item = checkpoint.partial.queue?.selected?.[checkpoint.tokenIndex];
      const endpoint = AUDIT_ENDPOINTS[checkpoint.endpointIndex];
      return item && endpoint ? Object.freeze({ kind: 'AUDIT', endpoint, address: item.row.address, chain: checkpoint.chain, checkpoint }) : null;
    }
    if (checkpoint.phase === 'SECONDARY') {
      const item = checkpoint.partial.queue?.selected?.[checkpoint.tokenIndex];
      const source = SECONDARY_SOURCES[checkpoint.endpointIndex];
      return item && source ? Object.freeze({ kind: 'SECONDARY', source, address: item.row.address, chain: checkpoint.chain, checkpoint }) : null;
    }
    if (checkpoint.phase === 'OUTCOMES_SAMPLE') {
      const outcome = checkpoint.partial.outcomes?.job;
      return outcome ? Object.freeze({ kind: 'OUTCOMES_SAMPLE', ...clone(outcome), checkpoint }) : null;
    }
    return null;
  }

  recordRequest(cycleId, { value, error = null, collectedAt = this.now() }) {
    const current = this.checkpoint(cycleId);
    if (!current) throw new RecoverableScannerError('CYCLE_CHECKPOINT_MISSING', 'cycle checkpoint does not exist');
    const partial = clone(current.partial);
    const record = responseRecord(value, error, collectedAt);
    let nextPhase = current.phase;
    let tokenIndex = current.tokenIndex;
    let endpointIndex = current.endpointIndex;

    if (current.phase === 'DISCOVER') {
      const endpoint = DISCOVERY_ENDPOINTS[endpointIndex];
      if (!endpoint) throw phaseError('discovery endpoint cursor is exhausted');
      partial.discovery ||= { responses: {} };
      partial.discovery.responses[endpoint] = record;
      partial.discovery.lastCollectedAt = collectedAt;
      endpointIndex += 1;
      if (endpointIndex === DISCOVERY_ENDPOINTS.length) {
        partial.discovery.rows = discoveryRows(partial.discovery);
        nextPhase = 'SCREEN';
        endpointIndex = 0;
      }
    } else if (current.phase === 'AUDIT') {
      const endpoint = AUDIT_ENDPOINTS[endpointIndex];
      if (!endpoint) throw phaseError('audit endpoint cursor is exhausted');
      partial.audit ||= { responses: {} };
      partial.audit.responses[endpoint] = record;
      partial.audit.lastCollectedAt = collectedAt;
      endpointIndex += 1;
      const item = partial.queue?.selected?.[tokenIndex];
      if (!item) throw phaseError('audit token cursor is exhausted');
      if (endpointIndex === 3 || endpointIndex === AUDIT_ENDPOINTS.length) {
        const completedAudit = auditFromPartial(partial);
        const completedDeep = deepScreen({ discovery: item.row, audit: completedAudit, nowMs: completedAudit._meta.auditedAt }, {
          ...(partial.settings || this.settings), chain: current.chain
        });
        if (classifyRecoverableDeepResult(completedDeep, completedAudit._meta).status === 'HARD_REJECT') {
          partial.audit.earlyExit = endpointIndex === 3;
          nextPhase = 'CLASSIFY_AND_COMMIT';
          endpointIndex = 0;
        }
      }
      if (endpointIndex === AUDIT_ENDPOINTS.length) {
        nextPhase = 'SECONDARY';
        endpointIndex = 0;
      }
    } else if (current.phase === 'SECONDARY') {
      const source = SECONDARY_SOURCES[endpointIndex];
      if (!source) throw phaseError('secondary source cursor is exhausted');
      partial.secondary ||= { sources: {} };
      partial.secondary.sources[source] = record;
      if (value?.result && typeof value.result === 'object' && !Array.isArray(value.result)) {
        partial.secondary.result = clone(value.result);
      }
      partial.secondary.lastCollectedAt = collectedAt;
      endpointIndex += 1;
      if (endpointIndex === SECONDARY_SOURCES.length) {
        nextPhase = 'CLASSIFY_AND_COMMIT';
        endpointIndex = 0;
      }
    } else {
      throw phaseError('current checkpoint phase does not accept a request response');
    }

    return this.store.advance({ expected: { phase: current.phase, keyEpoch: current.keyEpoch, controlEpoch: current.controlEpoch },
      next: { ...current, phase: nextPhase, tokenIndex, endpointIndex, partial, updatedAt: collectedAt } });
  }

  advanceLocal(cycleId) {
    const current = this.checkpoint(cycleId);
    if (!current) throw new RecoverableScannerError('CYCLE_CHECKPOINT_MISSING', 'cycle checkpoint does not exist');
    const now = this.now();
    const partial = clone(current.partial);
    const settings = partial.settings || this.settings;
    let nextPhase;
    let tokenIndex = current.tokenIndex;
    let endpointIndex = 0;

    if (isAuditDeadlineBoundary(current, now)) {
      partial.deadlineExpiredAt = now;
      delete partial.outcomes;
      nextPhase = 'SUMMARIZE';
    } else if (current.phase === 'SCREEN') {
      const exclusions = new Map(this.store.readRiskExclusions(current.chain).map(item => [tokenKey(current.chain, item.address), item]));
      partial.screened = discoveryRows(partial.discovery).map(row => {
        const screen = discoveryScreen(row, { ...settings, chain: current.chain }, now / 1000);
        const held = exclusions.get(tokenKey(current.chain, row.address));
        if (held) return { row, screen: { ...screen, pass: false, reasons: [...screen.reasons, ...(held.reasons || [])] } };
        return { row, screen };
      });
      partial.monitors = typeof this.store.readMonitorCandidates === 'function'
        ? this.store.readMonitorCandidates(current.chain, candidateRetentionLimit(settings), now).map(monitorItem) : [];
      const downgrades = typeof this.store.readCandidateReview === 'function'
        ? partial.screened.flatMap(({ row, screen }) => !screen.pass && this.store.readCandidateReview(current.chain, row.address)?.status === 'X_REVIEW'
          ? [{ address: row.address, reason: screen.reasons.join('；') }] : [])
        : [];
      nextPhase = 'BUILD_QUEUE';
      const next = { ...current, phase: nextPhase, tokenIndex, endpointIndex, partial, updatedAt: now };
      if (typeof this.store.commitScreen === 'function') {
        return this.store.commitScreen({
          expected: { phase: current.phase, keyEpoch: current.keyEpoch, controlEpoch: current.controlEpoch },
          downgrades,
          next
        });
      }
      return this.store.advance({ expected: { phase: current.phase, keyEpoch: current.keyEpoch, controlEpoch: current.controlEpoch }, next });
    } else if (current.phase === 'BUILD_QUEUE') {
      const prequalified = (partial.screened || []).filter(item => item.screen.pass).sort((left, right) =>
        Number(right.screen.priorityBand) - Number(left.screen.priorityBand) || right.screen.score - left.screen.score
      );
      const monitors = (partial.monitors || []).filter(item => !prequalified.some(candidate =>
        addressKey(candidate.row.address) === addressKey(item.row.address)
      ));
      const auditable = [...prequalified, ...monitors];
      const priorQueue = this.store.readAuditQueue(current.chain);
      const queue = buildQueue(priorQueue, auditable, now, settings);
      const availableAddresses = new Set(auditable.map(item => addressKey(item.row.address)));
      const selectedQueue = selectAuditQueue(queue, availableAddresses, now, num(partial.scanCount) + 1, settings.maxDeepAuditsPerCycle);
      const byAddress = new Map(auditable.map(item => [addressKey(item.row.address), item]));
      partial.queue = {
        rows: queue,
        selected: selectedQueue.map(item => ({ ...item, row: clone(byAddress.get(addressKey(item.address))?.row), screen: clone(byAddress.get(addressKey(item.address))?.screen) })),
        availableAddresses: [...availableAddresses]
      };
      partial.prequalifiedCount = prequalified.length;
      tokenIndex = 0;
      nextPhase = partial.queue.selected.length ? 'AUDIT' : 'OUTCOMES_SAMPLE';
      const next = { ...current, phase: nextPhase, tokenIndex, endpointIndex, partial, updatedAt: now };
      if (typeof this.store.commitQueue === 'function') {
        return this.store.commitQueue({
          expected: { phase: current.phase, keyEpoch: current.keyEpoch, controlEpoch: current.controlEpoch },
          auditQueue: queue,
          next
        });
      }
      return this.store.advance({ expected: { phase: current.phase, keyEpoch: current.keyEpoch, controlEpoch: current.controlEpoch }, next });
    } else if (current.phase === 'OUTCOMES_SAMPLE') {
      const jobs = num(partial.outcomeReads) < outcomeReadLimit(settings)
        ? dueOutcomeJobs(retainedOutcomes(typeof this.store.readOutcomes === 'function' ? this.store.readOutcomes() : [], now, outcomeRetentionLimit(settings)), now) : [];
      const job = jobs[0];
      if (job) {
        partial.outcomes = { job: { chain: job.row.chain || current.chain, address: job.row.address, key: job.key, targetAt: job.targetAt } };
        nextPhase = 'OUTCOMES_SAMPLE';
      } else {
        delete partial.outcomes;
        partial.summary = { completedAt: now };
        nextPhase = 'SUMMARIZE';
      }
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
      nextPhase = 'SUMMARIZE';
    } else {
      throw phaseError('current checkpoint phase does not have a local transition');
    }
    const next = { ...current, phase: nextPhase, tokenIndex, endpointIndex, partial, updatedAt: now };
    const expected = { phase: current.phase, keyEpoch: current.keyEpoch, controlEpoch: current.controlEpoch };
    if (current.phase === 'SUMMARIZE' && typeof this.store.commitSummary === 'function') {
      return this.store.commitSummary({
        expected,
        next,
        candidateRetentionMs: candidateRetentionLimit(settings),
        outcomeRetentionMs: outcomeRetentionLimit(settings)
      });
    }
    if (current.phase === 'OUTCOMES_SAMPLE' && typeof this.store.commitOutcomeSelection === 'function') {
      return this.store.commitOutcomeSelection({ expected, next, outcomeRetentionMs: outcomeRetentionLimit(settings) });
    }
    return this.store.advance({ expected, next });
  }

  async commitClassification(cycleId) {
    const current = this.checkpoint(cycleId);
    if (!current) throw new RecoverableScannerError('CYCLE_CHECKPOINT_MISSING', 'cycle checkpoint does not exist');
    if (current.phase !== 'CLASSIFY_AND_COMMIT') throw phaseError('classification can only commit from CLASSIFY_AND_COMMIT');
    const item = current.partial.queue?.selected?.[current.tokenIndex];
    if (!item?.row || !item?.screen) throw phaseError('classification token cursor is exhausted');
    const now = this.now();
    const settings = current.partial.settings || this.settings;
    const audit = auditFromPartial(current.partial);
    const deep = deepScreen({ discovery: item.row, audit, nowMs: audit._meta.auditedAt }, { ...settings, chain: current.chain });
    const baseClassification = classifyRecoverableDeepResult(deep, audit._meta);
    const token = publicToken(item.row, item.screen, current.chain);
    const freshPrice = tokenInfoPrice(audit.info);
    if (freshPrice) token.price = freshPrice;
    const primaryWebsite = String(first(audit.info?.link?.website, item.row.website, item.row.link?.website) || '');
    const secondary = secondaryFromPartial(current.partial, {
      chain: current.chain,
      address: token.address,
      primary: {
        market: { priceUsd: token.price, marketCap: token.marketCap, liquidityUsd: token.liquidity, website: primaryWebsite },
        security: {
          isHoneypot: deep.security?.honeypot,
          openSource: deep.security?.openSource,
          mintable: typeof deep.security?.renouncedMint === 'boolean' ? !deep.security.renouncedMint : undefined
        }
      }
    });
    const classification = mergeRecoverableSecondaryClassification(baseClassification, secondary);
    if (item.row._monitorOnly && classification.status === 'X_REVIEW') {
      classification.status = 'WAIT_RECHECK';
      classification.secondaryReason = '已离开发现范围，继续跟踪风险；不作为新的通过候选';
    }
    const evidenceAt = Math.max(audit._meta.auditedAt, secondary?.checkedAt || 0);
    const secondaryWebsite = secondary?.market?.websites?.[0] || '';
    const candidate = {
      ...token,
      status: classification.status,
      auditedAt: evidenceAt,
      staleAt: evidenceAt + settings.staleCandidateMs,
      deep,
      social: socialFrom(token),
      secondary,
      decisionReason: [...(deep.chartRisk?.reasons || []), classification.secondaryReason, ...(deep.marketBehavior?.downgradeReasons || [])].filter(Boolean).join('；'),
      auditHealth: audit._meta,
      info: { twitter: token.twitter, website: String(first(primaryWebsite, secondaryWebsite) || '') }
    };
    candidate.reviewEvidence = await reviewEvidence(candidate);
    const previousCandidate = typeof this.store.readCandidateReview === 'function'
      ? this.store.readCandidateReview(current.chain, candidate.address) : null;
    candidate.reviewRevision = previousCandidate?.reviewEvidence === candidate.reviewEvidence
      ? previousCandidate.reviewRevision : `${candidate.reviewEvidence}-${now}`;
    const queue = {
      ...item,
      lastAuditedAt: evidenceAt,
      nextAuditAt: now + nextAuditDelay(candidate.status, settings),
      attempts: num(item.attempts) + 1,
      status: candidate.status
    };
    const riskExclusion = deep.chartRisk?.status === 'REJECT'
      ? { address: candidate.address, version: CHART_RISK_VERSION, codes: deep.chartRisk.codes, reasons: deep.chartRisk.reasons, at: now,
        details: { from: deep.chartRisk.from, to: deep.chartRisk.to } }
      : null;
    const outcome = await outcomeForClassification(this.store, current.chain, candidate, now);
    const nextTokenIndex = current.tokenIndex + 1;
    const partial = clone(current.partial);
    partial.lastCommittedAt = now;
    partial.lastCandidateAddress = candidate.address;
    const nextPhase = nextTokenIndex < (partial.queue?.selected?.length || 0) ? 'AUDIT' : 'OUTCOMES_SAMPLE';
    if (nextPhase === 'AUDIT') {
      delete partial.audit;
      delete partial.secondary;
    }
    const event = candidate.status === 'X_REVIEW' && previousCandidate?.status !== 'X_REVIEW'
      ? {
          effectType: 'CANDIDATE_NEW',
          type: 'CANDIDATE_NEW',
          message: `${candidate.symbol}：新增链上候选，需人工复核`,
          data: { address: candidate.address, reviewRevision: candidate.reviewRevision },
          outbox: { payload: { chain: current.chain, address: candidate.address }, desiredRevision: candidate.reviewRevision }
        }
      : previousCandidate?.status === 'X_REVIEW' && candidate.status !== 'X_REVIEW'
        ? {
            effectType: 'RISK_WORSENED',
            type: 'RISK_WORSENED',
            message: `${candidate.symbol}：风险或证据状态恶化，请重新复核`,
            data: { address: candidate.address, reviewRevision: candidate.reviewRevision }
          }
        : null;
    return this.store.commitClassification({
      expected: { phase: current.phase, keyEpoch: current.keyEpoch, controlEpoch: current.controlEpoch },
      next: { ...current, phase: nextPhase, tokenIndex: nextTokenIndex, endpointIndex: 0, partial, updatedAt: now },
      candidate,
      auditQueue: queue,
      riskExclusion,
      outcome,
      event
    });
  }

  recordOutcomeSample(cycleId, { sample = null, error = null, collectedAt = this.now() }) {
    const current = this.checkpoint(cycleId);
    if (!current) throw new RecoverableScannerError('CYCLE_CHECKPOINT_MISSING', 'cycle checkpoint does not exist');
    if (current.phase !== 'OUTCOMES_SAMPLE') throw phaseError('outcome samples can only commit from OUTCOMES_SAMPLE');
    const job = current.partial.outcomes?.job;
    if (!job) throw phaseError('outcome sample checkpoint has no job');
    if (typeof this.store.readOutcomes !== 'function') {
      throw new RecoverableScannerError('RECOVERABLE_SCANNER_STORE_INVALID', 'recoverable scanner store cannot read outcomes');
    }
    const outcomes = this.store.readOutcomes();
    const jobChain = job.chain || current.chain;
    const outcome = outcomes.find(row => outcomeKey(row, current.chain) === tokenKey(jobChain, job.address));
    if (!outcome) throw new RecoverableScannerError('OUTCOME_MISSING', 'outcome sample target no longer exists');
    const progressed = outcomeWithSample(outcome, job, sample, error, collectedAt);
    const nextOutcomes = outcomes.map(row => outcomeKey(row, current.chain) === tokenKey(jobChain, job.address) ? progressed : row);
    const partial = clone(current.partial);
    partial.outcomeReads = num(partial.outcomeReads) + 1;
    const nextJob = partial.outcomeReads < outcomeReadLimit(partial.settings || this.settings)
      ? dueOutcomeJobs(nextOutcomes, collectedAt)[0] : null;
    if (nextJob) partial.outcomes = { job: { chain: nextJob.row.chain || current.chain, address: nextJob.row.address, key: nextJob.key, targetAt: nextJob.targetAt } };
    else delete partial.outcomes;
    return this.store.commitOutcomeProgress({
      expected: { phase: current.phase, keyEpoch: current.keyEpoch, controlEpoch: current.controlEpoch },
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

export const recoverableScannerProtocol = Object.freeze({
  phases: SCAN_PHASES,
  discoveryEndpoints: DISCOVERY_ENDPOINTS,
  auditEndpoints: AUDIT_ENDPOINTS,
  secondarySources: SECONDARY_SOURCES,
  outcomeHorizons: horizons
});
