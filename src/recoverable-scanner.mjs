import { CHART_RISK_VERSION } from './scoring/chart-risk.mjs';
import { deepScreen, discoveryScreen } from './scoring/index.mjs';
import { normalizeGmgnList, tokenInfoPrice, unwrapGmgn } from './providers/gmgn-normalize.mjs';
import { dueOutcomeJobs, horizons, sampleRejected } from './scoring/outcomes.mjs';
import { sha256Hex } from './util/crypto.mjs';
import { RecoverableScannerError, SCAN_PHASES } from './storage/recoverable-scanner.mjs';

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

function addressKey(value) {
  const address = String(value ?? '').trim();
  return /^0x[0-9a-f]{40}$/i.test(address) ? address.toLowerCase() : address;
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

function boundedRows(value) {
  return Array.isArray(value) ? clone(value.filter(row => row && typeof row === 'object').slice(0, 200)) : [];
}

function responseRecord(value, error, collectedAt) {
  return Object.freeze({
    collectedAt,
    ...(error ? { error: requestError(error) } : { value: clone(value) })
  });
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

function auditFromPartial(partial, now) {
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
    _meta: { complete, earlyExit: Boolean(partial.audit?.earlyExit), endpoints, auditedAt: now }
  };
}

function secondaryFromPartial(partial) {
  if (partial.secondary?.result) return partial.secondary.result;
  const responses = partial.secondary?.sources;
  if (!responses || !Object.keys(responses).length) return null;
  const sources = Object.fromEntries(SECONDARY_SOURCES.map(source => {
    const response = responses[source];
    return [source, response?.error ? { status: 'ERROR', errorCode: response.error.code } : { status: 'ERROR', errorCode: 'NORMALIZATION_MISSING' }];
  }));
  return {
    status: 'DEGRADED', complete: false, sources,
    market: { complete: false, websites: [] },
    security: { complete: false, verdict: 'UNKNOWN', fatal: [], unknownFields: ['tokenSecurity'], fields: {}, buyTax: null, sellTax: null },
    conflicts: []
  };
}

function queueSort(left, right) {
  return Number(right.priorityBand) - Number(left.priorityBand)
    || num(left.firstSeenAt) - num(right.firstSeenAt)
    || num(right.score) - num(left.score);
}

export function selectRecoverableAuditQueue(queue, availableAddresses, now, cycleNumber, limit) {
  const available = new Set([...availableAddresses].map(addressKey));
  const due = queue.filter(item => available.has(addressKey(item.address)) && num(item.nextAuditAt) <= now);
  const never = due.filter(item => !num(item.lastAuditedAt)).sort(queueSort);
  const rechecks = due.filter(item => num(item.lastAuditedAt)).sort(queueSort);
  const selected = [];
  while (selected.length < limit && (never.length || rechecks.length)) {
    const slot = cycleNumber + selected.length;
    const urgent = rechecks.findIndex(row => row.status === 'X_REVIEW' || row.watched);
    if (urgent >= 0 && slot % 3 !== 1) selected.push(...rechecks.splice(urgent, 1));
    else if (slot % 5 === 0 && never.length) {
      const oldest = never.reduce((left, right) => num(left.firstSeenAt) < num(right.firstSeenAt) ? left : right);
      selected.push(...never.splice(never.indexOf(oldest), 1));
    } else selected.push((slot % 3 === 0 ? rechecks.shift() : never.shift()) || rechecks.shift() || never.shift());
  }
  return selected.filter(Boolean);
}

function buildQueue(previous, prequalified, now, settings) {
  const byAddress = new Map((previous || []).map(item => [addressKey(item.address), { ...item }]));
  for (const { row, screen } of prequalified) {
    const old = byAddress.get(addressKey(row.address));
    byAddress.set(addressKey(row.address), {
      address: String(row.address),
      firstSeenAt: num(old?.firstSeenAt, now),
      lastSeenAt: now,
      lastAuditedAt: num(old?.lastAuditedAt),
      nextAuditAt: num(old?.nextAuditAt),
      attempts: num(old?.attempts),
      status: old?.status || 'QUEUED',
      priorityBand: Boolean(screen.priorityBand),
      score: screen.score,
      watched: Boolean(row._monitorOnly)
    });
  }
  return [...byAddress.values()].filter(item => now - num(item.lastSeenAt, item.firstSeenAt) <= settings.queueRetentionMs);
}

function nextAuditDelay(status, settings) {
  if (status === 'HARD_REJECT') return settings.hardRejectRecheckMs;
  if (status === 'X_REVIEW') return settings.chainPassRecheckMs;
  return settings.dynamicRecheckMs;
}

export function classifyRecoverableDeepResult(deep, auditMeta = {}) {
  const failed = new Set(deep?.failed || []);
  const unknown = new Set(deep?.blockingUnknownFields || deep?.unknownFields || []);
  const unknownCheck = name => {
    const prefixes = {
      openSource: ['openSource'], ownerRenounced: ['ownerRenounced', 'renouncedMint', 'renouncedFreezeAccount'],
      lpLocked: ['lockRate'], notHoneypot: ['honeypot', 'sellability.'], tax: ['buyTax', 'sellTax'],
      rug: ['rugRatio'], concentration: ['top10'], dev: ['devHold'], insider: ['insider'],
      bundler: ['bundler'], sniper: ['sniperHold'], wash: ['wash'], liquidity: ['liquidity'],
      wallets: ['holders.'], observation: ['candles'], chartRisk: ['chartRisk.']
    }[name] || [];
    return [...unknown].some(field => prefixes.some(prefix => field === prefix || field.startsWith(prefix)));
  };
  const transient = new Set(['wallets', 'observation', 'marketBehavior']);
  if (deep?.honeypotEvidence !== '检测到貔貅') transient.add('notHoneypot');
  const hardFailed = [...failed].filter(name => !transient.has(name) && !unknownCheck(name));
  const waitingFailed = [...failed].filter(name => transient.has(name) || unknownCheck(name));
  if (auditMeta.complete === false) waitingFailed.push('auditIncomplete');
  if (hardFailed.length) return { status: 'HARD_REJECT', hardFailed, waitingFailed };
  if (!deep?.chainPass || auditMeta.complete === false) return { status: 'WAIT_RECHECK', hardFailed, waitingFailed };
  return { status: 'X_REVIEW', hardFailed: [], waitingFailed: [] };
}

export function mergeRecoverableSecondaryClassification(baseClassification, secondary) {
  const base = baseClassification || { status: 'WAIT_RECHECK', hardFailed: [], waitingFailed: [] };
  if (!secondary) return { ...base, secondaryReason: '' };
  const sources = Object.values(secondary.sources || {});
  const supported = sources.some(source => source?.status !== 'UNSUPPORTED');
  const fatal = secondary.security?.verdict === 'FATAL';
  const blockingConflicts = (secondary.conflicts || []).filter(conflict => ['MARKET_MISMATCH', 'SECURITY_MISMATCH'].includes(conflict?.type));
  const incomplete = supported && (secondary.status !== 'COMPLETE' || secondary.security?.verdict === 'UNKNOWN');
  return {
    ...base,
    status: fatal ? 'HARD_REJECT' : base.status === 'X_REVIEW' && (incomplete || blockingConflicts.length) ? 'WAIT_RECHECK' : base.status,
    secondaryReason: fatal ? '第二安全源触发一票否决' : incomplete ? '第二数据源不完整，等待复查'
      : blockingConflicts.length ? '多源数据冲突，等待复查' : (!supported ? '当前链暂无第二数据源，仅供人工查看' : '')
  };
}

function publicToken(row, screen, chain) {
  const twitter = String(first(row.twitter, row.twitter_username, row.link?.twitter_username) || '');
  return {
    address: addressKey(row.address), chain, symbol: String(row.symbol || '?').slice(0, 30), name: String(row.name || '').slice(0, 80),
    marketCap: num(first(row.market_cap, row.usd_market_cap, row.mcp)), liquidity: num(row.liquidity),
    price: numberOrNull(first(row.price, row.price_usd, row.usd_price)), createdAt: num(first(row.creation_timestamp, row.created_timestamp, row.open_timestamp)),
    ageSec: screen.ageSec, priorityBand: screen.priorityBand, discoveryScore: screen.score,
    holders: num(row.holder_count), volume1h: num(first(row.volume_1h, row.volume)), buys: num(first(row.buys_24h, row.buys)),
    sells: num(first(row.sells_24h, row.sells)), twitter, gmgnUrl: String(row.link?.gmgn || '')
  };
}

function socialFrom(token) {
  return token.twitter
    ? { twitter: token.twitter, status: 'UNVERIFIED', score: 0, reason: '当前采用X人工复核模式' }
    : { twitter: '', status: 'FAIL', score: 0, reason: '没有X账号' };
}

async function reviewEvidence(candidate) {
  const security = candidate.deep?.security || {};
  return (await sha256Hex(JSON.stringify({
    status: candidate.status, checks: candidate.deep?.checks, failed: candidate.deep?.failed,
    owner: security.ownerRenounced, mint: security.renouncedMint, freeze: security.renouncedFreezeAccount,
    honeypot: security.honeypot, buyTax: security.buyTax, sellTax: security.sellTax,
    lock: security.lockRate, burned: security.lpBurned, secondary: candidate.secondary?.security?.verdict,
    conflicts: candidate.secondary?.conflicts, website: candidate.info?.website, twitter: candidate.info?.twitter
  }))).slice(0, 24);
}

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

export class RecoverableScanner {
  constructor({ store, settings, now = () => Date.now() }) {
    if (!store || typeof store.begin !== 'function' || typeof store.advance !== 'function') {
      throw new RecoverableScannerError('RECOVERABLE_SCANNER_STORE_INVALID', 'recoverable scanner requires a durable checkpoint store');
    }
    if (!settings || typeof settings !== 'object' || !Number.isSafeInteger(settings.maxDeepAuditsPerCycle)
      || !Number.isSafeInteger(settings.auditCycleBudgetMs) || !Number.isSafeInteger(settings.queueRetentionMs)) {
      throw new RecoverableScannerError('RECOVERABLE_SCANNER_SETTINGS_INVALID', 'recoverable scanner settings are incomplete');
    }
    this.store = store;
    this.settings = Object.freeze({ ...settings });
    this.now = now;
  }

  begin({ cycleId, chain, keyEpoch, controlEpoch, deadlineAt, partial = {}, afterBegin }) {
    const startedAt = this.now();
    return this.store.begin({ cycleId, chain, keyEpoch, controlEpoch, deadlineAt, phase: 'DISCOVER', tokenIndex: 0, endpointIndex: 0,
      partial: { ...clone(partial), startedAt, settings: clone(this.settings) }, updatedAt: startedAt, afterBegin });
  }

  checkpoint(cycleId) {
    return this.store.read(cycleId);
  }

  nextRequest(cycleId) {
    const checkpoint = this.checkpoint(cycleId);
    if (!checkpoint) throw new RecoverableScannerError('CYCLE_CHECKPOINT_MISSING', 'cycle checkpoint does not exist');
    if (checkpoint.deadlineAt !== null && this.now() >= checkpoint.deadlineAt && ['DISCOVER', 'AUDIT', 'SECONDARY', 'OUTCOMES_SAMPLE'].includes(checkpoint.phase)) {
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
        const completedAudit = auditFromPartial(partial, collectedAt);
        const completedDeep = deepScreen({ discovery: item.row, audit: completedAudit, nowMs: collectedAt }, {
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

    if (current.deadlineAt !== null && now >= current.deadlineAt && ['DISCOVER', 'AUDIT', 'SECONDARY', 'OUTCOMES_SAMPLE'].includes(current.phase)) {
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
      nextPhase = 'BUILD_QUEUE';
    } else if (current.phase === 'BUILD_QUEUE') {
      const prequalified = (partial.screened || []).filter(item => item.screen.pass).sort((left, right) =>
        Number(right.screen.priorityBand) - Number(left.screen.priorityBand) || right.screen.score - left.screen.score
      );
      const priorQueue = this.store.readAuditQueue(current.chain);
      const queue = buildQueue(priorQueue, prequalified, now, settings);
      const availableAddresses = new Set(prequalified.map(item => addressKey(item.row.address)));
      const selectedQueue = selectRecoverableAuditQueue(queue, availableAddresses, now, num(partial.scanCount) + 1, settings.maxDeepAuditsPerCycle);
      const byAddress = new Map(prequalified.map(item => [addressKey(item.row.address), item]));
      partial.queue = {
        rows: queue,
        selected: selectedQueue.map(item => ({ ...item, row: clone(byAddress.get(addressKey(item.address))?.row), screen: clone(byAddress.get(addressKey(item.address))?.screen) })),
        availableAddresses: [...availableAddresses]
      };
      partial.prequalifiedCount = prequalified.length;
      tokenIndex = 0;
      nextPhase = partial.queue.selected.length ? 'AUDIT' : 'OUTCOMES_SAMPLE';
    } else if (current.phase === 'OUTCOMES_SAMPLE') {
      const jobs = dueOutcomeJobs(typeof this.store.readOutcomes === 'function' ? this.store.readOutcomes(current.chain) : [], now);
      const job = jobs[0];
      if (job) {
        partial.outcomes = { job: { address: job.row.address, key: job.key, targetAt: job.targetAt } };
        nextPhase = 'OUTCOMES_SAMPLE';
      } else {
        delete partial.outcomes;
        partial.summary = { completedAt: now };
        nextPhase = 'SUMMARIZE';
      }
    } else if (current.phase === 'SUMMARIZE') {
      partial.summary = { ...(partial.summary || {}), completedAt: now, finalized: true };
      nextPhase = 'SUMMARIZE';
    } else {
      throw phaseError('current checkpoint phase does not have a local transition');
    }
    return this.store.advance({ expected: { phase: current.phase, keyEpoch: current.keyEpoch, controlEpoch: current.controlEpoch },
      next: { ...current, phase: nextPhase, tokenIndex, endpointIndex, partial, updatedAt: now } });
  }

  async commitClassification(cycleId) {
    const current = this.checkpoint(cycleId);
    if (!current) throw new RecoverableScannerError('CYCLE_CHECKPOINT_MISSING', 'cycle checkpoint does not exist');
    if (current.phase !== 'CLASSIFY_AND_COMMIT') throw phaseError('classification can only commit from CLASSIFY_AND_COMMIT');
    const item = current.partial.queue?.selected?.[current.tokenIndex];
    if (!item?.row || !item?.screen) throw phaseError('classification token cursor is exhausted');
    const now = this.now();
    const settings = current.partial.settings || this.settings;
    const audit = auditFromPartial(current.partial, now);
    const deep = deepScreen({ discovery: item.row, audit, nowMs: now }, { ...settings, chain: current.chain });
    const baseClassification = classifyRecoverableDeepResult(deep, audit._meta);
    const secondary = secondaryFromPartial(current.partial);
    const classification = mergeRecoverableSecondaryClassification(baseClassification, secondary);
    const token = publicToken(item.row, item.screen, current.chain);
    const freshPrice = tokenInfoPrice(audit.info);
    if (freshPrice) token.price = freshPrice;
    const candidate = {
      ...token,
      status: classification.status,
      auditedAt: now,
      staleAt: now + settings.staleCandidateMs,
      deep,
      social: socialFrom(token),
      secondary,
      decisionReason: [...(deep.chartRisk?.reasons || []), classification.secondaryReason, ...(deep.marketBehavior?.downgradeReasons || [])].filter(Boolean).join('；'),
      auditHealth: audit._meta,
      info: { twitter: token.twitter, website: String(first(audit.info?.link?.website, item.row.website, item.row.link?.website) || '') }
    };
    candidate.reviewEvidence = await reviewEvidence(candidate);
    const previousCandidate = typeof this.store.readCandidateReview === 'function'
      ? this.store.readCandidateReview(current.chain, candidate.address) : null;
    candidate.reviewRevision = previousCandidate?.reviewEvidence === candidate.reviewEvidence
      ? previousCandidate.reviewRevision : `${candidate.reviewEvidence}-${now}`;
    const queue = {
      ...item,
      lastAuditedAt: now,
      nextAuditAt: now + nextAuditDelay(candidate.status, settings),
      attempts: num(item.attempts) + 1,
      status: candidate.status
    };
    const riskExclusion = deep.chartRisk?.status === 'REJECT'
      ? { address: candidate.address, version: CHART_RISK_VERSION, codes: deep.chartRisk.codes, reasons: deep.chartRisk.reasons, at: now,
        details: { from: deep.chartRisk.from, to: deep.chartRisk.to } }
      : null;
    const outcomes = [];
    let outcome = candidate.status === 'X_REVIEW' && candidate.price > 0 ? {
      address: candidate.address, initialDecision: 'X_REVIEW', latestDecision: candidate.status, baselineAt: now, baselinePrice: candidate.price,
      lastAuditedAt: now, symbol: candidate.symbol, latestFailed: candidate.deep.failed, samples: {}
    } : null;
    if (candidate.status === 'HARD_REJECT' && candidate.price > 0 && typeof this.store.readOutcomes === 'function') {
      outcomes.push(...this.store.readOutcomes(current.chain));
      await sampleRejected(outcomes, candidate, now);
      outcome = outcomes.find(row => addressKey(row.address) === addressKey(candidate.address)) || null;
    }
    const nextTokenIndex = current.tokenIndex + 1;
    const partial = clone(current.partial);
    partial.lastCommittedAt = now;
    partial.lastCandidateAddress = candidate.address;
    const nextPhase = nextTokenIndex < (partial.queue?.selected?.length || 0) ? 'AUDIT' : 'OUTCOMES_SAMPLE';
    return this.store.commitClassification({
      expected: { phase: current.phase, keyEpoch: current.keyEpoch, controlEpoch: current.controlEpoch },
      next: { ...current, phase: nextPhase, tokenIndex: nextTokenIndex, endpointIndex: 0, partial, updatedAt: now },
      candidate,
      auditQueue: queue,
      riskExclusion,
      outcome,
      event: {
        effectType: candidate.status,
        type: candidate.status,
        message: `${candidate.symbol}：${candidate.status}`,
        data: { address: candidate.address, reviewRevision: candidate.reviewRevision },
        outbox: candidate.status === 'X_REVIEW' ? { payload: { chain: current.chain, address: candidate.address }, desiredRevision: candidate.reviewRevision } : undefined
      }
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
    const outcomes = this.store.readOutcomes(current.chain);
    const outcome = outcomes.find(row => addressKey(row.address) === addressKey(job.address));
    if (!outcome) throw new RecoverableScannerError('OUTCOME_MISSING', 'outcome sample target no longer exists');
    const progressed = outcomeWithSample(outcome, job, sample, error, collectedAt);
    const nextOutcomes = outcomes.map(row => addressKey(row.address) === addressKey(job.address) ? progressed : row);
    const nextJob = dueOutcomeJobs(nextOutcomes, collectedAt)[0];
    const partial = clone(current.partial);
    if (nextJob) partial.outcomes = { job: { address: nextJob.row.address, key: nextJob.key, targetAt: nextJob.targetAt } };
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
