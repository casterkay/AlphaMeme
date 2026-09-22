export function classifyDeepResult(deep, auditMeta = {}) {
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

export function mergeSecondaryClassification(baseClassification, secondary) {
  const base = baseClassification || { status: 'WAIT_RECHECK', hardFailed: [], waitingFailed: [] };
  if (!secondary) return { ...base, secondaryReason: '' };
  const sources = Object.values(secondary.sources || {});
  const supported = sources.some(source => source?.status !== 'UNSUPPORTED');
  const fatal = secondary.security?.verdict === 'FATAL';
  const blockingConflicts = (secondary.conflicts || []).filter(conflict =>
    ['MARKET_MISMATCH', 'SECURITY_MISMATCH'].includes(conflict?.type)
  );
  const incomplete = supported && (secondary.status !== 'COMPLETE' || secondary.security?.verdict === 'UNKNOWN');
  return {
    ...base,
    status: fatal
      ? 'HARD_REJECT'
      : base.status === 'X_REVIEW' && (incomplete || blockingConflicts.length)
        ? 'WAIT_RECHECK'
        : base.status,
    secondaryReason: fatal
      ? '第二安全源触发一票否决'
      : incomplete
        ? '第二数据源不完整，等待复查'
        : blockingConflicts.length
          ? '多源数据冲突，等待复查'
          : (!supported ? '当前链暂无第二数据源，仅供人工查看' : '')
  };
}
