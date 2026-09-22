import { gmgnRequestWeight } from './providers/gmgn.mjs';
import { SecondaryValidator } from './providers/secondary.mjs';

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

function nextGmgnOperation(next) {
  if (next?.kind === 'DISCOVER') return next.endpoint === 'trenches' ? 'trenches' : 'marketRank';
  if (next?.kind === 'AUDIT') {
    return {
      info: 'tokenInfo', security: 'tokenSecurity', pool: 'tokenPoolInfo', holders: 'tokenTopHolders',
      traders: 'tokenTopTraders', candles: 'tokenKline'
    }[next.endpoint] || null;
  }
  return next?.kind === 'OUTCOMES_SAMPLE' ? 'tokenKline' : null;
}

export function recoverableRequestAdmission(next) {
  const operation = nextGmgnOperation(next);
  return Object.freeze(operation
    ? { needsGmgn: true, gmgnWeight: gmgnRequestWeight(operation) }
    : { needsGmgn: false, gmgnWeight: 1 });
}

async function recordGmgnRequest(scanner, cycleId, request, operation, now) {
  let value;
  try {
    value = await request(operation);
  } catch (error) {
    return scanner.recordRequest(cycleId, { error, collectedAt: now() });
  }
  return scanner.recordRequest(cycleId, { value, collectedAt: now() });
}

async function recordOutcomeRequest(scanner, cycleId, request, operation, now) {
  let sample;
  try {
    sample = await request(operation);
  } catch (error) {
    return scanner.recordOutcomeSample(cycleId, { error, collectedAt: now() });
  }
  return scanner.recordOutcomeSample(cycleId, { sample, collectedAt: now() });
}

async function recordSecondaryRequest(scanner, cycleId, request, operation, now) {
  let value;
  try {
    value = await request(operation);
  } catch (error) {
    return scanner.recordRequest(cycleId, { error, collectedAt: now() });
  }
  return scanner.recordRequest(cycleId, { value, collectedAt: now() });
}

export async function executeRecoverableScanStep({ scanner, cycleId, gmgn, secondary = new SecondaryValidator(), request, onFinalized = null, now = Date.now }) {
  if (!scanner || typeof scanner.nextRequest !== 'function' || typeof scanner.advanceLocal !== 'function'
    || typeof scanner.recordRequest !== 'function' || typeof scanner.commitClassification !== 'function'
    || typeof scanner.recordOutcomeSample !== 'function' || !gmgn || !secondary || typeof secondary.fetchSource !== 'function'
    || typeof request !== 'function' || typeof now !== 'function' || (onFinalized !== null && typeof onFinalized !== 'function')) {
    throw new TypeError('Recoverable scan executor is invalid');
  }
  const next = scanner.nextRequest(cycleId);
  let result;
  let successor = null;
  let finalizationAttempted = false;
  if (!next) {
    const checkpoint = scanner.checkpoint(cycleId);
    if (checkpoint.phase === 'CLASSIFY_AND_COMMIT') result = await scanner.commitClassification(cycleId);
    else if (checkpoint.phase === 'SUMMARIZE' && checkpoint.partial.summary?.finalized) {
      result = checkpoint;
      finalizationAttempted = true;
      successor = await onFinalized?.(checkpoint) || null;
    } else result = scanner.advanceLocal(cycleId);
  } else if (next.kind === 'DEADLINE_EXPIRED') {
    result = scanner.advanceLocal(cycleId);
  } else if (next.kind === 'DISCOVER') {
    result = await recordGmgnRequest(scanner, cycleId, request,
      ({ signal, timeoutMs }) => discoveryRequest(gmgn, next, signal, timeoutMs), now);
  } else if (next.kind === 'AUDIT') {
    result = await recordGmgnRequest(scanner, cycleId, request,
      ({ signal, timeoutMs }) => auditRequest(gmgn, next, signal, timeoutMs), now);
  } else if (next.kind === 'SECONDARY') {
    result = await recordSecondaryRequest(scanner, cycleId, request,
      ({ signal }) => secondary.fetchSource({
        source: next.source,
        chain: next.chain,
        tokenAddress: next.address,
        signal
      }), now);
  } else if (next.kind === 'OUTCOMES_SAMPLE') {
    result = await recordOutcomeRequest(scanner, cycleId, request,
      ({ signal, timeoutMs }) => gmgn.priceAt(next.address, next.targetAt, next.chain || next.checkpoint.chain, {
        deadline: requestDeadline(next.checkpoint, timeoutMs), signal
      }), now);
  } else {
    throw safeError('RECOVERABLE_SCAN_PHASE_UNSUPPORTED');
  }
  const checkpoint = result.checkpoint || result;
  if (!finalizationAttempted && checkpoint.phase === 'SUMMARIZE' && checkpoint.partial.summary?.finalized) {
    successor = await onFinalized?.(checkpoint) || null;
  }
  const successorCheckpoint = successor?.checkpoint || checkpoint;
  const complete = checkpoint.phase === 'SUMMARIZE' && checkpoint.partial.summary?.finalized === true && !successor;
  const admission = successor ? recoverableRequestAdmission({ kind: 'DISCOVER', endpoint: 'trenches' })
    : recoverableRequestAdmission(scanner.nextRequest(cycleId));
  return Object.freeze({
    status: 'success',
    complete,
    checkpoint: cycleProgress(successorCheckpoint),
    nextDueAt: complete ? undefined : successor?.task?.dueAt ?? Math.max(now() + 1, checkpoint.updatedAt + 1),
    nextNeedsGmgn: admission.needsGmgn,
    nextGmgnWeight: admission.gmgnWeight,
    ...(successor ? { nextTask: successor.task } : {})
  });
}
