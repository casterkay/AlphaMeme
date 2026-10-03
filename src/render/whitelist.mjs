import { CHART_RISK_VERSION } from '../scoring/chart-risk.mjs';
import { blockingUnknownFields } from '../scoring/safety.mjs';

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
  return /command failed|api[_ -]?key|authorization|bearer\s|private[_ -]?key|passphrase|secret/i.test(message)
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

export function publicChecks(source = {}) {
  return Object.fromEntries(CHECK_FIELDS.map(key => [key, source[key] === true]));
}

export function publicSecondary(source = {}) {
  const sourceStatus = row => ({
    status: text(row?.status, 24),
    errorCode: publicCode(row?.errorCode)
  });
  const security = source.security || {};
  const fields = security.fields || {};
  // The one stand-in source a check recorded for cannot_sell_all, if any.
  const standIn = security.standIns?.cannotSellAll;
  const standInKey = ['distinctSellers24h', 'dexSells24h'].find(key => Number.isSafeInteger(standIn?.[key]));
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
    sources: { goPlus: sourceStatus(source.sources?.goPlus) },
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
      sellTax: finiteOrNull(security.sellTax),
      ...(standInKey ? { standIns: { cannotSellAll: { [standInKey]: standIn[standInKey] } } } : {})
    }
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
    status: text(row.status, 32),
    auditedAt: finite(row.auditedAt),
    staleAt: finite(row.staleAt),
    reviewRevision: text(row.reviewRevision, 64),
    auditHealth: { earlyExit },
    auditError: row.auditError ? '深度审计暂时失败，已进入等待复查。' : '',
    decisionReason: text(row.decisionReason, 120),
    deep: {
      chainPass: deep.chainPass === true && currentRules,
      chartRisk: { version: finite(deep.chartRisk?.version), status: text(deep.chartRisk?.status, 32),
        pass: deep.chartRisk?.pass === true, from: finite(deep.chartRisk?.from), to: finite(deep.chartRisk?.to),
        reasons: (deep.chartRisk?.reasons || []).slice(0, 5).map(reason => text(reason, 100)) },
      failed: Array.isArray(deep.failed) ? deep.failed.slice(0, 32).map(value => text(value, 40)) : [],
      unknownFields: Array.isArray(deep.unknownFields) ? deep.unknownFields.slice(0, 48).map(value => text(value, 64)) : [],
      blockingUnknownFields: blockingUnknownFields(deep).slice(0, 48).map(value => text(value, 64)),
      checks: publicChecks(deep.checks),
      honeypotEvidence: text(deep.honeypotEvidence, 80),
      security: {
        openSource: security.openSource === true || security.openSource === false ? security.openSource : text(security.openSource, 16),
        ownerRenounced: security.ownerRenounced === true || security.ownerRenounced === false ? security.ownerRenounced : text(security.ownerRenounced, 16),
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
