const DISCOVERY_FILTERS = Object.freeze({
  min_created: '5m', max_created: '10080m', min_marketcap: 10_000,
  max_marketcap: 150_000, min_liquidity: 3_000
});

function safeError(code) {
  return Object.assign(new Error(code), { code });
}

function cycleProgress(checkpoint) {
  return `${checkpoint.cycleId}:${checkpoint.phase}:${checkpoint.tokenIndex}:${checkpoint.endpointIndex}:${checkpoint.updatedAt}`;
}

function requestDeadline(checkpoint, timeoutMs) {
  const deadline = checkpoint.deadlineAt === null ? Infinity : checkpoint.deadlineAt;
  return Math.min(deadline, Date.now() + timeoutMs);
}

async function discoveryRequest(gmgn, next, signal, timeoutMs) {
  if (next.endpoint === 'trenches') {
    return gmgn.trenches(next.checkpoint.chain, {
      types: ['completed'],
      limit: 80,
      filters: { max_rug_ratio: 0.3, max_bundler_rate: 0.3, max_insider_ratio: 0.3, ...DISCOVERY_FILTERS },
      deadline: requestDeadline(next.checkpoint, timeoutMs),
      signal
    });
  }
  if (next.endpoint === 'trending') {
    return gmgn.marketRank(next.checkpoint.chain, '5m', {
      limit: 100,
      order_by: 'volume',
      direction: 'desc',
      ...DISCOVERY_FILTERS,
      deadline: requestDeadline(next.checkpoint, timeoutMs),
      signal
    });
  }
  throw safeError('RECOVERABLE_SCAN_ENDPOINT_UNSUPPORTED');
}

async function auditRequest(gmgn, next, signal, timeoutMs) {
  const options = { deadline: requestDeadline(next.checkpoint, timeoutMs), signal };
  switch (next.endpoint) {
    case 'info': return gmgn.tokenInfo(next.chain, next.address, options);
    case 'security': return gmgn.tokenSecurity(next.chain, next.address, options);
    case 'pool': return gmgn.tokenPoolInfo(next.chain, next.address, options);
    case 'holders': return gmgn.tokenTopHolders(next.chain, next.address, { limit: 100, ...options });
    case 'traders': return gmgn.tokenTopTraders(next.chain, next.address, { limit: 50, ...options });
    case 'candles': {
      const to = Math.floor(Date.now() / 1_000) * 1_000;
      return gmgn.tokenKline(next.chain, next.address, '1m', to - 20 * 60_000, to, options);
    }
    default: throw safeError('RECOVERABLE_SCAN_ENDPOINT_UNSUPPORTED');
  }
}

export async function executeRecoverableScanStep({ scanner, cycleId, gmgn, request, now = Date.now }) {
  if (!scanner || typeof scanner.nextRequest !== 'function' || typeof scanner.advanceLocal !== 'function'
    || typeof scanner.recordRequest !== 'function' || typeof scanner.commitClassification !== 'function'
    || typeof scanner.recordOutcomeSample !== 'function' || !gmgn || typeof request !== 'function' || typeof now !== 'function') {
    throw new TypeError('Recoverable scan executor is invalid');
  }
  const next = scanner.nextRequest(cycleId);
  let result;
  if (!next) {
    const checkpoint = scanner.checkpoint(cycleId);
    result = checkpoint.phase === 'CLASSIFY_AND_COMMIT'
      ? await scanner.commitClassification(cycleId)
      : scanner.advanceLocal(cycleId);
  } else if (next.kind === 'DEADLINE_EXPIRED') {
    result = scanner.advanceLocal(cycleId);
  } else if (next.kind === 'DISCOVER') {
    const value = await request(({ signal, timeoutMs }) => discoveryRequest(gmgn, next, signal, timeoutMs));
    result = scanner.recordRequest(cycleId, { value, collectedAt: now() });
  } else if (next.kind === 'AUDIT') {
    const value = await request(({ signal, timeoutMs }) => auditRequest(gmgn, next, signal, timeoutMs));
    result = scanner.recordRequest(cycleId, { value, collectedAt: now() });
  } else if (next.kind === 'SECONDARY') {
    result = scanner.recordRequest(cycleId, { error: safeError('SECONDARY_SOURCE_UNAVAILABLE'), collectedAt: now() });
  } else if (next.kind === 'OUTCOMES_SAMPLE') {
    const value = await request(({ signal, timeoutMs }) => gmgn.priceAt(next.address, next.targetAt, next.checkpoint.chain, {
      deadline: requestDeadline(next.checkpoint, timeoutMs), signal
    }));
    result = scanner.recordOutcomeSample(cycleId, { sample: value, collectedAt: now() });
  } else {
    throw safeError('RECOVERABLE_SCAN_PHASE_UNSUPPORTED');
  }
  const checkpoint = result.checkpoint || result;
  return Object.freeze({
    complete: checkpoint.phase === 'SUMMARIZE',
    checkpoint: cycleProgress(checkpoint),
    nextDueAt: checkpoint.phase === 'SUMMARIZE' ? undefined : Math.max(now() + 1, checkpoint.updatedAt + 1)
  });
}
