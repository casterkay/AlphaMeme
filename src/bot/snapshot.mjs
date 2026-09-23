import { publicCandidate } from '../render/whitelist.mjs';
import { CHART_RISK_VERSION, applyRiskExclusion } from '../scoring/chart-risk.mjs';
import { effectiveStatus } from '../scoring/manual-review.mjs';
import { readSchedulerStateInTransaction } from '../storage/scheduler-state.mjs';
import { scannerSettings } from '../scanner-settings.mjs';
import { normalizeTenantId } from '../storage/gmgn-admission-state.mjs';

export const TELEGRAM_CHAINS = Object.freeze(['sol', 'bsc', 'base', 'eth', 'robinhood', 'arc', 'stable']);
export const tokenIdentity = (chain, address) => `${chain}:${chain === 'sol' ? address : String(address).toLowerCase()}`;
const sensitive = /gmgn_|bearer\s|authorization|api[_ -]?key|private[_ -]?key|-----BEGIN .*KEY-----/i;

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
  row.chain = TELEGRAM_CHAINS.includes(source.chain) ? source.chain : '';
  row.address = safeTelegramText(source.address, 80);
  row.symbol = safeTelegramText(source.symbol, 30) || '?';
  row.name = safeTelegramText(source.name, 80);
  row.gmgnUrl = safeTelegramUrl(source.gmgnUrl);
  row.info.website = safeTelegramUrl(source.info?.website);
  row.status = template.status;
  row.deep.chainPass = template.deep.chainPass;
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
  row.auditError = source.auditError ? 'AUDIT_FAILED' : '';
  row.decisionReason = source.deep?.chartRisk?.version !== CHART_RISK_VERSION && ['X_REVIEW', 'QUALIFIED'].includes(source.status)
    ? 'STALE_RULES' : safeTelegramText(source.decisionReason, 120);
  for (const key of ['openSource', 'ownerRenounced']) row.deep.security[key] = typeof source.deep?.security?.[key] === 'boolean' ? source.deep.security[key] : null;
  if (source.auditHealth?.earlyExit) {
    for (const key of ['sampled', 'ordinaryCount', 'ordinaryHoldRate', 'botHoldRate', 'linkedHoldRate']) row.deep.wallets[key] = null;
    row.deep.sellability.distinctSellers = null;
  }
  if (source.secondary) {
    row.secondary = availabilityProjection(publicCandidate({ secondary: source.secondary }).secondary, source.secondary);
    row.secondary.market.pairUrl = safeTelegramUrl(source.secondary.market?.pairUrl);
    row.secondary.market.websites = (source.secondary.market?.websites || []).map(safeTelegramUrl).filter(Boolean);
  }
  return row;
}

export function projectTelegramLiveRow(source) {
  const fields = ['marketCap','liquidity','createdAt','price','volume1m','buys1m','sells1m','swaps1m','holders','smartMoney','observedAt','firstSeenAt','newAt','deltaWindowMs','priceDelta','holdersDelta','smartDelta'];
  return {
    chain: TELEGRAM_CHAINS.includes(source.chain) ? source.chain : '', address: safeTelegramText(source.address,80), symbol:safeTelegramText(source.symbol,30), name:safeTelegramText(source.name,80),
    ...Object.fromEntries(fields.map(key => [key, typeof source[key] === 'number' && Number.isFinite(source[key]) ? source[key] : null])),
    priorityBand:source.priorityBand === true, auditEligible:source.auditEligible === true,
    website:safeTelegramUrl(source.website),twitter:safeTelegramText(source.twitter,80),
    audit: source.audit ? { at:source.audit.at,status:safeTelegramText(source.audit.status,32) } : null
  };
}

function projectSourceHealth(source) {
  const endpoint = row => ({ ok:typeof row?.ok === 'boolean' ? row.ok : null,status:safeTelegramText(row?.status,32),code:safeTelegramText(row?.code || row?.errorCode,48),count:typeof row?.count === 'number' ? row.count : null });
  return Object.fromEntries(['discovery','lastAudit','lastSecondary'].filter(key => source[key]).map(key => {
    const row=source[key];
    return [key,{ complete:typeof row.complete === 'boolean' ? row.complete : null,checkedAt:typeof row.checkedAt === 'number' ? row.checkedAt : null,
      ...Object.fromEntries(['trenches','trending'].filter(field => row[field]).map(field => [field,endpoint(row[field])])),
      endpoints:Object.fromEntries(['info','security','pool','holders','traders','candles'].filter(field => row.endpoints?.[field]).map(field => [field,endpoint(row.endpoints[field])])),
      sources:Object.fromEntries(['dexScreener','goPlus'].filter(field => row.sources?.[field]).map(field => [field,endpoint(row.sources[field])])) }];
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
    const state = Object.fromEntries(read('scheduler_state').map(row => [row.key, json(row.value_json)]));
    const preferences = Object.fromEntries(read('preferences').map(row => [row.key, json(row.value_json)]));
    const checkpoints = read('cycle_checkpoint');
    const enabledCycles = new Set(scheduler.tasks.filter(task => task.kind === 'scan' && task.enabled).map(task => task.id.slice(5)));
    const enabledChains = [...new Set(checkpoints.filter(row => enabledCycles.has(row.cycle_id)).map(row => row.chain))];
    const exclusions = Object.fromEntries(read('risk_exclusions').map(row => [tokenIdentity(row.chain, row.address), { version: row.version, codes: json(row.codes_json, []), reasons: json(row.reasons_json, []), at: row.at }]));
    const candidates = read('candidates').map(candidateFromSql).map(row => projectTelegramCandidate(applyRiskExclusion(row, exclusions, row.chain)));
    const annotations = read('annotations').map(row => ({ chain: row.chain, address: row.address, favorite: row.favorite === 1, note: safeTelegramText(row.note, 500), updatedAt: row.updated_at }));
    const marks = read('manual_marks').map(row => ({ chain: row.chain, address: row.address, decision: row.decision, at: row.marked_at, reviewRevision: row.review_revision, version: row.mark_version }));
    const events = read('events').map(row => ({ at: row.at, chain: row.chain, address: row.address, type: safeTelegramText(row.type, 32), message: safeTelegramText(row.message, 500) }));
    const queue = read('audit_queue').map(row => ({ chain: row.chain, address: row.address, nextAuditAt: row.next_audit_at, status: row.status }));
    const delivery = storage.sql.exec("SELECT status,delivery_class,action_reason,next_at FROM outbox WHERE tenant_id = ? AND status IN ('UNKNOWN','FAILED') ORDER BY rowid", tenantId).toArray().map(row => ({ status: row.status, purpose: safeTelegramText(row.delivery_class, 32), reason: safeTelegramText(row.action_reason, 80), nextAt: row.next_at }));
    const global = state['runtime.global'] || {};
    const metrics = Object.fromEntries(['scanCount', 'discoveredCount', 'prequalifiedCount', 'lastAttemptAt', 'lastSuccessAt', 'nextCycleAt'].map(key => [key, typeof global[key] === 'number' ? global[key] : null]));
    const control = { ...scheduler.runtime.eligibility, ...scheduler.runtime.control, enabledChains: enabledChains.length ? enabledChains : (preferences['telegram.scanChains'] ?? [scannerSettings.chain]), notifications: preferences['telegram.notifications'] === true };
    return {
      at: now, language: preferences['telegram.language'] === 'en' ? 'en' : 'zh', control,
      candidates, annotations, marks, events, queue, delivery, metrics,
      sourceHealth: projectSourceHealth(state['runtime.sourceHealth'] || {}),
      live: { subscribed:scheduler.runtime.live.subscribed,focusChain:scheduler.runtime.live.focusChain,leaseUntil:scheduler.runtime.live.leaseUntil,nextPollAt:scheduler.runtime.live.nextPollAt },
      liveByChain: Object.fromEntries(TELEGRAM_CHAINS.filter(chain => state['live.snapshot:'+chain]?.keyEpoch === scheduler.gmgn.keyEpoch).map(chain => {
        const live=state['live.snapshot:'+chain];
        return [chain,{ rows:(live.rows || []).map(projectTelegramLiveRow),status:safeTelegramText(live.status,32),lastAttemptAt:live.lastAttemptAt,lastSuccessAt:live.lastSuccessAt,pollLagMs:live.pollLagMs,requestMs:live.requestMs,delayReason:safeTelegramText(live.delayReason,64) }];
      })),
      cooldownUntil: scheduler.gmgn.nextAllowedAt,
      outcomes: read('outcomes').map(row => ({ chain: row.chain, address: row.address, symbol: safeTelegramText(row.symbol, 30), initialDecision: row.initial_decision, latestDecision: row.latest_decision, baselineAt: row.baseline_at, baselinePrice: row.baseline_price, lastAuditedAt: row.last_audited_at, latestFailed: json(row.latest_failed_json, []).map(item => safeTelegramText(item, 80)), sampling: safeTelegramText(row.sampling, 32), strategyVersion: safeTelegramText(row.strategy_version, 32), samples: json(row.samples_json, {}) }))
    };
  });
}

/** Export explicit research fields only; no credentials, routing IDs or internal delivery state. */
export function createTelegramExport(snapshot) {
  return {
    schemaVersion: 1, exportedAt: snapshot.at,
    chains: Object.fromEntries(TELEGRAM_CHAINS.map(chain => [chain, {
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
