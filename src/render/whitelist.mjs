import { CHART_RISK_VERSION, applyRiskExclusion } from '../scoring/chart-risk.mjs';

const CHAIN_IDS = new Set(['sol', 'bsc', 'base', 'eth', 'robinhood', 'arc', 'stable']);
const CHECK_FIELDS = [
  'openSource', 'ownerRenounced', 'lpLocked', 'notHoneypot', 'tax', 'rug',
  'concentration', 'dev', 'insider', 'bundler', 'sniper', 'wash', 'liquidity',
  'wallets', 'observation', 'chartRisk', 'marketBehavior'
];

function finite(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function finiteOrNull(value) {
  const parsed = Number(value);
  return value !== null && value !== undefined && value !== '' && Number.isFinite(parsed) ? parsed : null;
}

function text(value, maxLength = 160) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLength);
}

export function publicMessage(value, fallback, maxLength = 160) {
  const message = text(value, maxLength);
  return /command failed|api[_ -]?key|authorization|bearer\s|private[_ -]?key|passphrase|secret|gmgn_[a-z0-9]{8,}/i.test(message)
    ? fallback
    : message;
}

function publicCode(value) {
  const code = text(value, 48).toUpperCase();
  return /^[A-Z0-9_]{1,48}$/.test(code) ? code : '';
}

function externalUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' ? url.href.slice(0, 500) : '';
  } catch {
    return '';
  }
}

export function publicError(status) {
  if (status === 'RATE_LIMITED') return 'GMGN请求频率超限，系统将自动等待并重试。';
  if (status === 'GMGN_AUTH_REQUIRED') return 'GMGN只读数据源尚未完成本机配置。';
  if (status === 'DEGRADED') return '本轮部分数据不完整，系统将自动复查。';
  if (status === 'ERROR' || status === 'STATE_ERROR') return '数据请求暂时失败，下一轮将自动重试。';
  return '';
}

export function publicChecks(source = {}) {
  return Object.fromEntries(CHECK_FIELDS.map(key => [key, source[key] === true]));
}

export function publicSecondary(source = {}) {
  const sourceStatus = row => ({
    status: text(row?.status, 24),
    errorCode: publicCode(row?.errorCode)
  });
  const market = source.market || {};
  const security = source.security || {};
  const fields = security.fields || {};
  const securityFields = {};
  for (const key of [
    'isHoneypot', 'openSource', 'mintable', 'ownerChangeBalance', 'hiddenOwner',
    'cannotSellAll', 'selfDestruct', 'externalCall', 'slippageModifiable',
    'personalSlippageModifiable', 'transferPausable', 'blacklisted',
    'tradingCooldown', 'freezable', 'closable', 'balanceMutableAuthority',
    'transferFeeUpgradable', 'nonTransferable'
  ]) {
    if (fields[key] === true || fields[key] === false || fields[key] === null) securityFields[key] = fields[key];
  }
  return {
    status: text(source.status, 24),
    complete: source.complete === true,
    checkedAt: finite(source.checkedAt),
    sources: {
      dexScreener: sourceStatus(source.sources?.dexScreener),
      goPlus: sourceStatus(source.sources?.goPlus)
    },
    market: {
      complete: market.complete === true,
      pairUrl: externalUrl(market.pairUrl),
      priceUsd: finiteOrNull(market.priceUsd),
      marketCap: finiteOrNull(market.marketCap),
      liquidityUsd: finiteOrNull(market.liquidityUsd),
      websites: Array.isArray(market.websites) ? market.websites.slice(0, 5).map(externalUrl).filter(Boolean) : []
    },
    security: {
      complete: security.complete === true,
      verdict: text(security.verdict, 32),
      fatal: Array.isArray(security.fatal) ? security.fatal.slice(0, 20).map(row => ({
        field: text(row?.field, 48),
        reason: text(row?.reason, 80)
      })) : [],
      unknownFields: Array.isArray(security.unknownFields) ? security.unknownFields.slice(0, 32).map(value => text(value, 48)) : [],
      fields: securityFields,
      buyTax: finiteOrNull(security.buyTax),
      sellTax: finiteOrNull(security.sellTax)
    },
    conflicts: Array.isArray(source.conflicts) ? source.conflicts.slice(0, 20).map(row => ({
      type: text(row?.type, 40),
      field: text(row?.field, 48),
      relativeDifference: finiteOrNull(row?.relativeDifference)
    })) : []
  };
}

export function publicCandidate(row = {}) {
  const earlyExit = row.auditHealth?.earlyExit === true;
  const deep = row.deep || {};
  const currentRules = deep.chartRisk?.version === CHART_RISK_VERSION;
  const security = deep.security || {};
  const wallets = deep.wallets || {};
  const observation = deep.observation || {};
  const sellability = deep.sellability || {};
  const social = row.social || {};
  const info = row.info || {};
  return {
    address: text(row.address, 80),
    chain: text(row.chain, 32),
    symbol: text(row.symbol || '?', 30),
    name: text(row.name, 80),
    marketCap: finite(row.marketCap),
    liquidity: finite(row.liquidity),
    price: finiteOrNull(row.price),
    createdAt: finite(row.createdAt),
    ageSec: finite(row.ageSec),
    priorityBand: row.priorityBand === true,
    discoveryScore: finite(row.discoveryScore),
    holders: finite(row.holders),
    volume1h: finite(row.volume1h),
    buys: finite(row.buys),
    sells: finite(row.sells),
    twitter: text(row.twitter, 80),
    gmgnUrl: externalUrl(row.gmgnUrl),
    status: ['X_REVIEW', 'QUALIFIED'].includes(row.status) && !currentRules ? 'WAIT_RECHECK' : text(row.status, 32),
    auditedAt: finite(row.auditedAt),
    staleAt: finite(row.staleAt),
    reviewRevision: text(row.reviewRevision, 64),
    auditHealth: { earlyExit },
    auditError: row.auditError ? '深度审计暂时失败，已进入等待复查。' : '',
    decisionReason: ['X_REVIEW', 'QUALIFIED'].includes(row.status) && !currentRules
      ? '风险规则已升级，等待重新核验' : text(row.decisionReason, 120),
    deep: {
      chainPass: deep.chainPass === true && currentRules,
      chartRisk: { version: finite(deep.chartRisk?.version), status: text(deep.chartRisk?.status, 32),
        pass: deep.chartRisk?.pass === true, from: finite(deep.chartRisk?.from), to: finite(deep.chartRisk?.to),
        reasons: (deep.chartRisk?.reasons || []).slice(0, 5).map(reason => text(reason, 100)) },
      failed: Array.isArray(deep.failed) ? deep.failed.slice(0, 32).map(value => text(value, 40)) : [],
      unknownFields: Array.isArray(deep.unknownFields) ? deep.unknownFields.slice(0, 48).map(value => text(value, 64)) : [],
      blockingUnknownFields: Array.isArray(deep.blockingUnknownFields) ? deep.blockingUnknownFields.slice(0, 48).map(value => text(value, 64)) : [],
      checks: publicChecks(deep.checks),
      honeypotEvidence: text(deep.honeypotEvidence, 80),
      security: {
        openSource: security.openSource === true || security.openSource === false ? security.openSource : text(security.openSource, 16),
        ownerRenounced: security.ownerRenounced === true || security.ownerRenounced === false ? security.ownerRenounced : text(security.ownerRenounced, 16),
        evmOwnerRenounced: security.evmOwnerRenounced === true || security.evmOwnerRenounced === false ? security.evmOwnerRenounced : null,
        renouncedMint: security.renouncedMint === true || security.renouncedMint === false ? security.renouncedMint : null,
        renouncedFreezeAccount: security.renouncedFreezeAccount === true || security.renouncedFreezeAccount === false ? security.renouncedFreezeAccount : null,
        honeypot: security.honeypot === true || security.honeypot === false ? security.honeypot : null,
        buyTax: finiteOrNull(security.buyTax),
        sellTax: finiteOrNull(security.sellTax),
        taxDifference: finiteOrNull(security.taxDifference),
        rugRatio: finiteOrNull(security.rugRatio),
        top10: finiteOrNull(security.top10),
        devHold: finiteOrNull(security.devHold),
        insider: finiteOrNull(security.insider),
        bundler: finiteOrNull(security.bundler),
        sniperHold: finiteOrNull(security.sniperHold),
        lockRate: finiteOrNull(security.lockRate),
        lpBurned: security.lpBurned === true,
        liquidity: finite(security.liquidity)
      },
      wallets: {
        sampled: earlyExit ? null : finite(wallets.sampled),
        ordinaryCount: earlyExit ? null : finite(wallets.ordinaryCount),
        ordinaryHoldRate: earlyExit ? null : finiteOrNull(wallets.ordinaryHoldRate),
        riskWalletCount: finite(wallets.riskWalletCount),
        botHoldRate: earlyExit ? null : finiteOrNull(wallets.botHoldRate),
        linkedHoldRate: earlyExit ? null : finiteOrNull(wallets.linkedHoldRate),
        duplicateCount: finite(wallets.duplicateCount),
        missingAddressCount: finite(wallets.missingAddressCount),
        invalidRateCount: finite(wallets.invalidRateCount),
        unknownFields: Array.isArray(wallets.unknownFields) ? wallets.unknownFields.slice(0, 32).map(value => text(value, 64)) : [],
        dataComplete: wallets.dataComplete === true,
        pass: wallets.pass === true
      },
      observation: {
        pass: observation.pass === true,
        status: text(observation.status, 24),
        reason: publicMessage(observation.reason, '盘面证据状态已更新。', 100),
        bars: finite(observation.bars),
        return5m: finiteOrNull(observation.return5m),
        maxDrawdown: finiteOrNull(observation.maxDrawdown),
        volumeConcentration: finiteOrNull(observation.volumeConcentration),
        totalVolume: finiteOrNull(observation.totalVolume),
        activeBars: finite(observation.activeBars),
        volumeChange: finiteOrNull(observation.volumeChange),
        volumeTrend: text(observation.volumeTrend, 24),
        decliningVolumeBars: finite(observation.decliningVolumeBars),
        invalidBars: finite(observation.invalidBars),
        duplicateBars: finite(observation.duplicateBars),
        continuous: observation.continuous === true,
        fresh: observation.fresh === true,
        latestClosedAt: finite(observation.latestClosedAt),
        stalenessMs: finite(observation.stalenessMs),
        unknownFields: Array.isArray(observation.unknownFields) ? observation.unknownFields.slice(0, 16).map(value => text(value, 64)) : []
      },
      sellability: {
        pass: sellability.pass === true,
        sells5m: finite(sellability.sells5m),
        sells24h: finite(sellability.sells24h),
        distinctSellers: earlyExit ? null : finite(sellability.distinctSellers),
        historicalDistinctSellers: finite(sellability.historicalDistinctSellers),
        windowSec: finite(sellability.windowSec),
        unknownFields: Array.isArray(sellability.unknownFields) ? sellability.unknownFields.slice(0, 16).map(value => text(value, 64)) : [],
        evidenceType: text(sellability.evidenceType, 48),
        evidenceNote: publicMessage(sellability.evidenceNote, '卖出证据仅作为经验参考。', 200)
      }
    },
    social: {
      status: text(social.status, 24),
      score: finite(social.score),
      reason: publicMessage(social.reason, 'X社区需要人工复核。', 160),
      twitter: text(social.twitter, 80)
    },
    info: {
      twitter: text(info.twitter, 80),
      website: externalUrl(info.website)
    },
    secondary: row.secondary && typeof row.secondary === 'object' ? publicSecondary(row.secondary) : null
  };
}

function publicRejected(row = {}) {
  return {
    address: text(row.address, 80),
    symbol: text(row.symbol || '?', 30),
    marketCap: finite(row.marketCap),
    liquidity: finite(row.liquidity),
    ageSec: finite(row.ageSec),
    createdAt: finite(row.createdAt),
    status: text(row.status, 32),
    stage: text(row.stage, 32),
    nextCheckAt: finite(row.nextCheckAt),
    reasons: Array.isArray(row.reasons) ? row.reasons.slice(0, 24).map(value => text(value, 80)) : []
  };
}

function publicEvent(event = {}) {
  const type = text(event.type, 32);
  const fixedMessage = type === 'ERROR'
    ? '数据请求暂时失败，系统会在下一轮重试。'
    : type === 'RATE_LIMITED'
      ? 'GMGN请求频率超限，系统已进入等待重试。'
      : type === 'AUTH'
        ? 'GMGN只读数据源尚未完成本机配置。'
        : publicMessage(event.message, '雷达状态已更新。', 160);
  return { at: finite(event.at), type, chain: text(event.chain, 32), message: fixedMessage };
}

function countSummary(source, allowedKeys) {
  const result = {};
  for (const key of allowedKeys) {
    if (source?.[key] !== undefined) result[key] = finite(source[key]);
  }
  return result;
}

function healthMessage(row = {}) {
  if (row.ok === true) return '';
  const code = publicCode(row.code || row.errorCode);
  if (/RATE_LIMIT/.test(code)) return 'GMGN请求频率受限，系统将自动重试。';
  if (/AUTH|UNAUTHORIZED/.test(code)) return 'GMGN只读授权无效或已失效。';
  if (/PERMISSION|FORBIDDEN/.test(code)) return 'GMGN当前权限无法读取该数据。';
  if (/TIMEOUT/.test(code)) return 'GMGN数据请求超时。';
  return 'GMGN数据请求暂时失败。';
}

function endpointHealth(row = {}) {
  return {
    ok: row.ok === true,
    count: finite(row.count),
    code: publicCode(row.code),
    message: healthMessage(row)
  };
}

function secondaryEndpointHealth(row = {}) {
  const status = text(row.status, 24).toUpperCase();
  const errorCode = publicCode(row.errorCode);
  const messages = {
    NO_DATA: '第二数据源暂未找到该代币。',
    ERROR: errorCode === 'TIMEOUT' ? '第二数据源请求超时。' : '第二数据源请求暂时失败。',
    UNSUPPORTED: '当前链尚无该第二数据源覆盖。'
  };
  return { ok: status === 'OK', status, code: errorCode, message: messages[status] || '' };
}

function publicSourceHealth(source = {}) {
  const result = {};
  if (source.discovery && typeof source.discovery === 'object') {
    result.discovery = {
      complete: source.discovery.complete === true,
      checkedAt: finite(source.discovery.checkedAt),
      trenches: endpointHealth(source.discovery.trenches),
      trending: endpointHealth(source.discovery.trending)
    };
  }
  if (source.lastAudit && typeof source.lastAudit === 'object') {
    const endpoints = {};
    for (const name of ['info', 'security', 'pool', 'holders', 'traders', 'candles']) {
      if (source.lastAudit.endpoints?.[name]) endpoints[name] = endpointHealth(source.lastAudit.endpoints[name]);
    }
    result.lastAudit = {
      complete: source.lastAudit.complete === true,
      checkedAt: finite(source.lastAudit.checkedAt || source.lastAudit.auditedAt),
      code: publicCode(source.lastAudit.code),
      endpoints
    };
  }
  if (source.lastSecondary && typeof source.lastSecondary === 'object') {
    result.lastSecondary = {
      complete: source.lastSecondary.complete === true,
      checkedAt: finite(source.lastSecondary.checkedAt),
      status: text(source.lastSecondary.status, 24),
      sources: {
        dexScreener: secondaryEndpointHealth(source.lastSecondary.sources?.dexScreener),
        goPlus: secondaryEndpointHealth(source.lastSecondary.sources?.goPlus)
      }
    };
  }
  return result;
}

function publicAuditQueueStats(source = {}) {
  return countSummary(source, [
    'total', 'retained', 'due', 'neverAudited', 'waitingRecheck', 'hardReject',
    'chainReview', 'estimatedMinutes', 'attempted', 'succeeded', 'failed', 'auditedThisCycle'
  ]);
}

function publicOutcomeSummary(source = {}) {
  return {
    ...countSummary(source, [
      'tracked', 'minimumSample', 'completed5m', 'completed15m', 'completed30m', 'completed1h',
      'completed2h', 'completed6h', 'completed24h'
    ]),
    calibrationReady: source.calibrationReady === true,
    averageReturn5m: finiteOrNull(source.averageReturn5m),
    averageReturn15m: finiteOrNull(source.averageReturn15m),
    averageReturn30m: finiteOrNull(source.averageReturn30m),
    averageReturn1h: finiteOrNull(source.averageReturn1h),
    averageReturn2h: finiteOrNull(source.averageReturn2h),
    averageReturn24h: finiteOrNull(source.averageReturn24h),
    note: text(source.note, 160)
    ,coverage: Object.fromEntries(['passed', 'rejected'].map(cohort => [cohort,
      Object.fromEntries(['m5','m15','m30','h1','h2','h6','h24'].map(key => {
        const row = source.coverage?.[cohort]?.[key] || {};
        return [key, { ...countSummary(row, ['eligible','completed','missing']), median: finiteOrNull(row.median), positiveRate: finiteOrNull(row.positiveRate) }];
      }))
    ]))
  };
}

export function toPublicStatus(source = {}) {
  const status = text(source.status, 32) || 'STARTING';
  const requestedActiveChain = text(source.activeChain || source.policy?.chain, 32).toLowerCase();
  const activeChain = CHAIN_IDS.has(requestedActiveChain) ? requestedActiveChain : 'robinhood';
  const requestedPendingChain = text(source.pendingChain, 32).toLowerCase();
  const priorityMarketCap = Array.isArray(source.policy?.priorityMarketCap)
    ? source.policy.priorityMarketCap.slice(0, 2).map(value => finite(value))
    : [];
  return {
    version: finite(source.version, 1),
    status,
    error: publicError(status),
    retryAt: finite(source.retryAt),
    generatedAt: finite(source.generatedAt),
    lastAttemptAt: finite(source.lastAttemptAt),
    lastSuccessAt: finite(source.lastSuccessAt),
    nextCycleAt: finite(source.nextCycleAt),
    lastCompleteSuccessAt: finite(source.lastCompleteSuccessAt),
    cycleStartedAt: finite(source.cycleStartedAt),
    scanInProgress: source.scanInProgress === true,
    lastCycleMs: finite(source.lastCycleMs),
    scanCount: finite(source.scanCount),
    discoveredCount: finite(source.discoveredCount),
    prequalifiedCount: finite(source.prequalifiedCount),
    activeChain,
    pendingChain: CHAIN_IDS.has(requestedPendingChain) ? requestedPendingChain : '',
    supportedChains: Array.isArray(source.supportedChains)
      ? source.supportedChains.slice(0, CHAIN_IDS.size).map(value => text(value, 32)).filter(value => CHAIN_IDS.has(value))
      : [],
    candidates: Array.isArray(source.candidates) ? source.candidates.slice(0, 100)
      .map(row => publicCandidate(applyRiskExclusion(row, source.riskExclusions, activeChain))) : [],
    rejected: Array.isArray(source.rejected) ? source.rejected.slice(0, 100).map(publicRejected) : [],
    events: Array.isArray(source.events) ? source.events.slice(0, 100).map(publicEvent) : [],
    xCapability: {
      available: source.xCapability?.available === true,
      backend: text(source.xCapability?.backend, 48),
      reason: publicMessage(source.xCapability?.reason, 'X社区需要人工复核。', 120)
    },
    sourceHealth: publicSourceHealth(source.sourceHealth),
    auditQueueStats: publicAuditQueueStats(source.auditQueueStats),
    outcomeSummary: publicOutcomeSummary(source.outcomeSummary),
    policy: {
      chain: text(source.policy?.chain, 32),
      priorityMarketCap,
      discoveryMarketCap: Array.isArray(source.policy?.discoveryMarketCap)
        ? source.policy.discoveryMarketCap.slice(0, 2).map(value => finite(value))
        : [],
      minimumAgeMinutes: finite(source.policy?.minimumAgeMinutes),
      scanIntervalMs: finite(source.policy?.scanIntervalMs),
      xReview: source.policy?.xReview === 'manual' ? 'manual' : '',
      execution: 'disabled'
    }
  };
}
