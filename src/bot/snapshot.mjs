import { publicCandidate } from '../render/whitelist.mjs';
import { CHART_RISK_VERSION, applyRiskExclusion } from '../scoring/chart-risk.mjs';
import { effectiveStatus } from '../scoring/manual-review.mjs';
import { DEFAULT_SCAN_CHAIN, SCAN_CHAINS } from '../chains.mjs';
import { readSchedulerStateInTransaction } from '../storage/scheduler-state.mjs';
import { listLookups, lookupVerdict, lookupVerified, LOOKUP_SETTINGS } from '../lookup.mjs';
import { normalizeTenantId } from '../storage/tenant-id.mjs';

export const tokenIdentity = (chain, address) => `${chain}:${String(address).toLowerCase()}`;
const sensitive = /bearer\s|authorization|api[_ -]?key|private[_ -]?key|-----BEGIN .*KEY-----/i;

export function safeTelegramText(value, maximum = 500) {
  const text = String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  return sensitive.test(text) ? '[redacted]' : text.slice(0, maximum);
}

export function safeTelegramUrl(value) {
  if (typeof value !== 'string' || value.length > 500 || sensitive.test(value)) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
  } catch (error) {
    if (error instanceof TypeError) return '';
    throw error;
  }
}

// Preserve the public whitelist's fields, but retain absence instead of its web-only coercions.
function availabilityProjection(template, source) {
  if (Array.isArray(template)) {
    if (!Array.isArray(source)) return [];
    if (source.length > 10_000) throw new RangeError('Telegram evidence exceeds supported item count');
    return source.map(value => template.length && typeof template[0] === 'object'
      ? availabilityProjection(template[0], value) : safeTelegramText(value, 500));
  }
  if (template !== null && typeof template === 'object') {
    return Object.fromEntries(Object.entries(template).map(([key, value]) => [key, availabilityProjection(value, source?.[key])]));
  }
  if (typeof template === 'number' || template === null) {
    return source !== null && source !== undefined && source !== '' && typeof source !== 'boolean' && Number.isFinite(Number(source)) ? Number(source) : null;
  }
  if (typeof template === 'boolean') return typeof source === 'boolean' ? source : null;
  return safeTelegramText(source, 500);
}

export function projectTelegramCandidate(source) {
  const template = publicCandidate(source);
  const row = availabilityProjection(template, source);
  row.chain = SCAN_CHAINS.includes(source.chain) ? source.chain : '';
  row.address = safeTelegramText(source.address, 80);
  row.symbol = safeTelegramText(source.symbol, 30) || '?';
  row.name = safeTelegramText(source.name, 80);
  row.info.website = safeTelegramUrl(source.info?.website);
  row.status = template.status;
  row.deep.chainPass = template.deep.chainPass;
  row.deep.blockingUnknownFields = template.deep.blockingUnknownFields;
  row.deep.chartRisk.codes = (source.deep?.chartRisk?.codes || []).map(value => safeTelegramText(value,80));
  row.deep.chartRisk.unknownFields = (source.deep?.chartRisk?.unknownFields || []).map(value => safeTelegramText(value,120));
  row.deep.security.wash = typeof source.deep?.security?.wash === 'boolean' ? source.deep.security.wash : null;
  row.deep.security.creatorStatus = safeTelegramText(source.deep?.security?.creatorStatus,32);
  const behavior = source.deep?.marketBehavior || {};
  row.deep.marketBehavior = {
    pass:typeof behavior.pass === 'boolean' ? behavior.pass : null,status:safeTelegramText(behavior.status,32),
    ...Object.fromEntries(['downgradeReasons','warnings','strengths','unknownFields'].map(key => [key,(behavior[key] || []).map(value => safeTelegramText(value,500))])),
    evidence:Object.fromEntries(['smartWallets','renownedWallets','taggedSmartWallets','taggedRenownedWallets','sampledTaggedWallets','holderCount','holderSampleDistinct','swaps5m','buys5m','sells5m','volume5m','priceChange5m','swapsPerHolder5m','swapCountConsistent','holderSampleConsistent','sellBuyRatio','ageSec','creatorStatus','creatorLaunchCount','creatorCreatedCount','creatorGraduatedCount','creatorOpenRatio','creatorDeletedPosts','creatorPromotedTokens'].map(key => [key,typeof behavior.evidence?.[key] === 'number' || typeof behavior.evidence?.[key] === 'boolean' ? behavior.evidence[key] : key === 'creatorStatus' ? safeTelegramText(behavior.evidence?.[key],32) : null]))
  };
  row.reviewRevision = safeTelegramText(source.reviewRevision, 64);
  // When a lead first qualified; rechecks keep it. Only the stored metadata carries it.
  if (Number.isSafeInteger(source.metadata?.qualifiedAt)) row.qualifiedAt = source.metadata.qualifiedAt;
  // When a lead last failed the screen, and why; it stays stored, no longer live.
  if (Number.isSafeInteger(source.metadata?.screenFailedAt)) row.screenFailedAt = source.metadata.screenFailedAt;
  if (Array.isArray(source.metadata?.screenReasons)) row.screenReasons = source.metadata.screenReasons.slice(0, 3).map(value => safeTelegramText(value, 120));
  if (Number.isSafeInteger(source.alertedAt)) row.alertedAt = source.alertedAt;
  row.auditError = source.auditError ? 'AUDIT_FAILED' : '';
  row.decisionReason = source.deep?.chartRisk?.version !== CHART_RISK_VERSION && ['X_REVIEW', 'QUALIFIED'].includes(source.status)
    ? 'STALE_RULES' : safeTelegramText(source.decisionReason, 120);
  for (const key of ['openSource', 'ownerRenounced']) row.deep.security[key] = typeof source.deep?.security?.[key] === 'boolean' ? source.deep.security[key] : null;
  if (source.auditHealth?.earlyExit) {
    for (const key of ['sampled', 'ordinaryCount', 'ordinaryHoldRate', 'botHoldRate', 'linkedHoldRate']) row.deep.wallets[key] = null;
    row.deep.sellability.distinctSellers = null;
  }
  if (source.secondary) row.secondary = projectSecondary(source.secondary);
  return row;
}

const projectSecondary = source => availabilityProjection(publicCandidate({ secondary: source }).secondary, source);

/** A pasted token's lookup: its progress, AVE market facts and, once done, its check. */
export function projectTelegramLookup(record, now) {
  const market = record.market || {};
  const numbers = ['price','marketCap','liquidity','holders','createdAt','priceChange5m','volume5m','capturedAt'];
  return {
    chain: record.chain, address: record.address, state: record.state, startedAt: record.startedAt, reason: record.reason,
    // The step a failed run stopped at: AVE until it confirmed the token, then GoPlus.
    failedStep: record.state !== 'FAILED' ? null : !record.market ? 'DETAILS' : 'GOPLUS',
    symbol: safeTelegramText(market.symbol, 30), name: safeTelegramText(market.name, 80), website: safeTelegramUrl(market.website),
    ...Object.fromEntries(numbers.map(key => [key, typeof market[key] === 'number' && Number.isFinite(market[key]) ? market[key] : null])),
    verdict: lookupVerdict(record),
    // A clean check that is too old to verify a buy (safetyState's rule), so a buy asks again.
    stale: lookupVerdict(record) === 'PASSED' && !lookupVerified(record, now),
    secondary: record.secondary ? projectSecondary(record.secondary) : null,
    veto: record.veto && { checkedAt: record.veto.checkedAt, fields: record.veto.fatal.map(item => safeTelegramText(item.field, 48)) }
  };
}

export function projectTelegramFeedRow(source, chain) {
  const numbers = ['marketCap','liquidity','price','createdAt','holders','volume5m','buys5m','sells5m','priceChange5m'];
  return {
    chain, address: safeTelegramText(source.address,80), symbol:safeTelegramText(source.symbol,30), name:safeTelegramText(source.name,80),
    ...Object.fromEntries(numbers.map(key => [key, typeof source[key] === 'number' && Number.isFinite(source[key]) ? source[key] : null])),
    ageBasis: safeTelegramText(source.ageBasis,16), priorityBand:source.priorityBand === true, pass:source.pass === true,
    reasons:(source.reasons || []).slice(0,3).map(value => safeTelegramText(value,120))
  };
}

function projectSourceHealth(source) {
  const endpoint = row => ({ ok:typeof row?.ok === 'boolean' ? row.ok : null,status:safeTelegramText(row?.status,32),code:safeTelegramText(row?.code || row?.errorCode,48),count:typeof row?.count === 'number' ? row.count : null });
  return Object.fromEntries(['discovery','lastSecondary'].filter(key => source[key]).map(key => {
    const row=source[key];
    return [key,{ complete:typeof row.complete === 'boolean' ? row.complete : null,checkedAt:typeof row.checkedAt === 'number' ? row.checkedAt : null,
      ...Object.fromEntries(['trending','newPools','watch','promoted'].filter(field => row[field]).map(field => [field,endpoint(row[field])])),
      sources:Object.fromEntries(['goPlus'].filter(field => row.sources?.[field]).map(field => [field,endpoint(row.sources[field])])) }];
  }));
}

function json(value, fallback = {}) {
  return value === null || value === undefined ? fallback : JSON.parse(value);
}

function candidateFromSql(row) {
  const result = {};
  for (const [key, value] of Object.entries(row)) {
    if (key.endsWith('_json')) result[key.slice(0, -5).replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = json(value);
    else if (!['tenant_id', 'review_evidence', 'metadata_json'].includes(key)) result[key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = value;
  }
  result.priorityBand = row.priority_band === 1;
  return result;
}

/** Read one synchronous, consistent tenant projection; never decrypt key material. */
export function readTelegramSnapshot(storage, tenant, now = Date.now()) {
  const tenantId = normalizeTenantId(tenant);
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('Invalid Telegram snapshot time');
  return storage.transactionSync(() => {
    const read = table => storage.sql.exec(`SELECT * FROM ${table} WHERE tenant_id = ?`, tenantId).toArray();
    const scheduler = readSchedulerStateInTransaction(storage, tenantId);
    // Lookups are read through listLookups, which skips an unreadable one.
    const state = Object.fromEntries(read('scheduler_state').filter(row => !row.key.startsWith('lookup:')).map(row => [row.key, json(row.value_json)]));
    const preferences = Object.fromEntries(read('preferences').map(row => [row.key, json(row.value_json)]));
    const exclusions = Object.fromEntries(read('risk_exclusions').map(row => [tokenIdentity(row.chain, row.address), { version: row.version, codes: json(row.codes_json, []), reasons: json(row.reasons_json, []), at: row.at }]));
    // When each token was last alerted; its alert keeps it findable.
    const notified = state['notification.baseline']?.notified || {};
    const candidates = read('candidates').map(candidateFromSql).map(row => projectTelegramCandidate({ ...applyRiskExclusion(row, exclusions, row.chain), alertedAt: notified[tokenIdentity(row.chain, row.address)] }));
    const annotations = read('annotations').map(row => ({ chain: row.chain, address: row.address, favorite: row.favorite === 1, note: safeTelegramText(row.note, 500), updatedAt: row.updated_at }));
    const marks = read('manual_marks').map(row => ({ chain: row.chain, address: row.address, decision: row.decision, at: row.marked_at, reviewRevision: row.review_revision, version: row.mark_version }));
    const events = read('events').map(row => ({ at: row.at, chain: row.chain, address: row.address, type: safeTelegramText(row.type, 32), message: safeTelegramText(row.message, 500) }));
    const queue = read('audit_queue').map(row => ({ chain: row.chain, address: row.address, nextAuditAt: row.next_audit_at, status: row.status }));
    const delivery = storage.sql.exec("SELECT status,delivery_class,action_reason,next_at FROM outbox WHERE tenant_id = ? AND status IN ('UNKNOWN','FAILED') ORDER BY rowid", tenantId).toArray().map(row => ({ status: row.status, purpose: safeTelegramText(row.delivery_class, 32), reason: safeTelegramText(row.action_reason, 80), nextAt: row.next_at }));
    const global = state['runtime.global'] || {};
    const metrics = Object.fromEntries(['scanCount', 'discoveredCount', 'prequalifiedCount', 'lastAttemptAt', 'lastSuccessAt', 'nextCycleAt'].map(key => [key, typeof global[key] === 'number' ? global[key] : null]));
    const control = { ...scheduler.runtime.eligibility, ...scheduler.runtime.control, scanChain: scheduler.runtime.control.activeChain ?? DEFAULT_SCAN_CHAIN, notifications: preferences['telegram.notifications'] !== false };
    return {
      at: now, language: preferences['telegram.language'] === 'en' ? 'en' : 'zh', control,
      candidates, annotations, marks, events, queue, delivery, metrics,
      lookups: listLookups(storage, tenantId).filter(record => record.veto || now - record.startedAt < LOOKUP_SETTINGS.expiryMs).map(record => projectTelegramLookup(record, now)),
      sourceHealth: projectSourceHealth(state['runtime.sourceHealth'] || {}),
      feedByChain: Object.fromEntries(SCAN_CHAINS.filter(chain => state['feed.snapshot:'+chain]).map(chain => {
        const feed=state['feed.snapshot:'+chain];
        return [chain,{ rows:(feed.rows || []).map(row => projectTelegramFeedRow(row, chain)),status:safeTelegramText(feed.status,32),at:feed.at,observedAt:feed.observedAt,receivedCount:feed.receivedCount,leadCount:feed.leadCount }];
      })),
      ave: { cuUsed: scheduler.ave.cuUsed, periodStartAt: scheduler.ave.periodStartAt, blockedUntil: scheduler.ave.blockedUntil,
        blockReason: scheduler.ave.blockReason, readyAt: Math.max(scheduler.ave.spacingReadyAt, scheduler.ave.blockedUntil) },
      outcomes: read('outcomes').map(row => ({ chain: row.chain, address: row.address, symbol: safeTelegramText(row.symbol, 30), initialDecision: row.initial_decision, latestDecision: row.latest_decision, baselineAt: row.baseline_at, baselinePrice: row.baseline_price, lastAuditedAt: row.last_audited_at, latestFailed: json(row.latest_failed_json, []).map(item => safeTelegramText(item, 80)), sampling: safeTelegramText(row.sampling, 32), strategyVersion: safeTelegramText(row.strategy_version, 32), samples: json(row.samples_json, {}) }))
    };
  });
}

/** Export explicit research fields only; no credentials, routing IDs or internal delivery state. */
export function createTelegramExport(snapshot) {
  return {
    schemaVersion: 1, exportedAt: snapshot.at,
    chains: Object.fromEntries(SCAN_CHAINS.map(chain => [chain, {
      candidates: snapshot.candidates.filter(row => row.chain === chain).map(projectTelegramCandidate),
      outcomes: (snapshot.outcomes || []).filter(row => row.chain === chain).map(row => ({ chain, address: row.address, symbol: safeTelegramText(row.symbol, 30), initialDecision: row.initialDecision, latestDecision: row.latestDecision, baselineAt: row.baselineAt, baselinePrice: row.baselinePrice, lastAuditedAt: row.lastAuditedAt, samples: Object.fromEntries(['m5','m15','m30','h1','h2','h6','h24'].filter(key => row.samples?.[key]).map(key => [key, Object.fromEntries(['at','price','return','targetAt','lagMs','collectedAt','source','missing','reason'].filter(field => row.samples[key][field] !== undefined).map(field => [field, ['reason','source'].includes(field) ? safeTelegramText(row.samples[key][field],120) : field === 'missing' ? row.samples[key][field] === true : typeof row.samples[key][field] === 'number' && Number.isFinite(row.samples[key][field]) ? row.samples[key][field] : null]))])) })),
      annotations: snapshot.annotations.filter(row => row.chain === chain).map(row => ({ chain, address: row.address, favorite: row.favorite, note: safeTelegramText(row.note, 500), updatedAt: row.updatedAt })),
      manualMarks: snapshot.marks.filter(row => row.chain === chain).map(mark => {
        const candidate = snapshot.candidates.find(row => tokenIdentity(chain, row.address) === tokenIdentity(chain, mark.address));
        return { chain, address: mark.address, decision: mark.decision, at: mark.at, reviewRevision: mark.reviewRevision, effectiveState: candidate ? effectiveStatus(candidate, mark, snapshot.at) : mark.decision === 'ignored' ? 'ignored' : 'unavailable' };
      }),
      events: snapshot.events.filter(row => row.chain === chain).map(row => ({ at: row.at, chain, address: row.address, type: row.type, message: safeTelegramText(row.message, 500) }))
    }]))
  };
}
