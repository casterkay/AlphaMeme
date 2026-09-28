import { AVE_CU } from './providers/ave.mjs';
import { SecondaryValidator } from './providers/secondary.mjs';

function safeError(code) {
  return Object.assign(new Error(code), { code });
}

function cycleProgress(checkpoint) {
  return `${checkpoint.cycleId}:${checkpoint.phase}:${checkpoint.tokenIndex}:${checkpoint.endpointIndex}:${checkpoint.updatedAt}`;
}

/** The AVE credit units the scanner's next request costs; zero when it makes no AVE request. */
export function recoverableRequestCost(next) {
  if (next?.kind === 'DISCOVER') return AVE_CU.trending;
  if (next?.kind === 'OUTCOMES_SAMPLE') return AVE_CU.klines;
  return 0;
}

async function record(request, operation, onValue, onError) {
  let value;
  try {
    value = await request(operation);
  } catch (error) {
    return onError(error);
  }
  return onValue(value);
}

export async function executeRecoverableScanStep({ scanner, cycleId, ave, secondary = new SecondaryValidator(), request, onFinalized = null, now = Date.now }) {
  if (!scanner || typeof scanner.nextRequest !== 'function' || typeof scanner.advanceLocal !== 'function'
    || typeof scanner.recordRequest !== 'function' || typeof scanner.commitClassification !== 'function'
    || typeof scanner.recordOutcomeSample !== 'function' || !ave || !secondary || typeof secondary.fetchSource !== 'function'
    || typeof request !== 'function' || typeof now !== 'function' || (onFinalized !== null && typeof onFinalized !== 'function')) {
    throw new TypeError('Recoverable scan executor is invalid');
  }
  const next = scanner.nextRequest(cycleId);
  let result;
  let successor = null;
  let finalizationAttempted = false;
  const recordResponse = (value, error) => scanner.recordRequest(cycleId, { ...(error ? { error } : { value }), collectedAt: now(), expectedCheckpoint: next.checkpoint });
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
    if (next.endpoint !== 'trending') throw safeError('RECOVERABLE_SCAN_ENDPOINT_UNSUPPORTED');
    result = await record(request, ({ signal }) => ave.trending(next.checkpoint.chain, { signal }),
      value => recordResponse(value, null), error => recordResponse(null, error));
  } else if (next.kind === 'SECONDARY') {
    result = await record(request, ({ signal }) => secondary.fetchSource({ source: next.source, chain: next.chain, tokenAddress: next.address, signal }),
      value => recordResponse(value, null), error => recordResponse(null, error));
  } else if (next.kind === 'OUTCOMES_SAMPLE') {
    result = await record(request, ({ signal }) => ave.priceAt(next.address, next.targetAt, next.chain || next.checkpoint.chain, { signal }),
      sample => scanner.recordOutcomeSample(cycleId, { sample, collectedAt: now(), expectedCheckpoint: next.checkpoint }),
      error => scanner.recordOutcomeSample(cycleId, { error, collectedAt: now(), expectedCheckpoint: next.checkpoint }));
  } else {
    throw safeError('RECOVERABLE_SCAN_PHASE_UNSUPPORTED');
  }
  const checkpoint = result.checkpoint || result;
  if (!finalizationAttempted && checkpoint.phase === 'SUMMARIZE' && checkpoint.partial.summary?.finalized) {
    successor = await onFinalized?.(checkpoint) || null;
  }
  const successorCheckpoint = successor?.checkpoint || checkpoint;
  const complete = checkpoint.phase === 'SUMMARIZE' && checkpoint.partial.summary?.finalized === true && !successor;
  const nextAveCost = successor ? AVE_CU.trending : recoverableRequestCost(scanner.nextRequest(cycleId));
  return Object.freeze({
    status: 'success',
    complete,
    checkpoint: cycleProgress(successorCheckpoint),
    nextAveCost,
    ...(!complete && !successor ? { nextDueAt: Math.max(now() + 1, checkpoint.updatedAt + 1) } : {}),
    ...(successor ? { nextTask: successor.task } : {})
  });
}
