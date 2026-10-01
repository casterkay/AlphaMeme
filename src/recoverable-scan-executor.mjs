import { AVE_CU } from './providers/ave.mjs';
import { ChainLogs } from './providers/chain-logs.mjs';
import { SecondaryValidator, fetchDexMarkets } from './providers/secondary.mjs';

function safeError(code) {
  return Object.assign(new Error(code), { code });
}

function cycleProgress(checkpoint) {
  return `${checkpoint.cycleId}:${checkpoint.phase}:${checkpoint.tokenIndex}:${checkpoint.endpointIndex}:${checkpoint.updatedAt}`;
}

/** The AVE credit units the scanner's next request costs; zero when it makes no AVE request. */
export function recoverableRequestCost(next) {
  if (next?.kind === 'DISCOVER') return next.endpoint === 'trending' ? AVE_CU.trending : next.endpoint.startsWith('market:') ? AVE_CU.details : 0;
  if (next?.kind === 'OUTCOMES_SAMPLE') return AVE_CU.klines;
  return 0;
}

function discoveryOperation(next, { ave, chainLogs, dexMarkets }) {
  const chain = next.checkpoint.chain;
  if (next.endpoint === 'trending') return ({ signal }) => ave.trending(chain, { signal });
  if (next.endpoint === 'newPools') return ({ signal }) => chainLogs.newPools(chain, { cursor: next.cursor, signal });
  if (next.endpoint === 'watch') return async ({ signal }) => next.addresses.length
    ? { addresses: next.addresses, ...await dexMarkets(chain, next.addresses, { signal }) } : { addresses: [], markets: [] };
  if (next.endpoint.startsWith('market:')) return ({ signal }) => ave.market(chain, next.address, { signal });
  throw safeError('RECOVERABLE_SCAN_ENDPOINT_UNSUPPORTED');
}

// What the new-pool source found; no address or key, only counts and block numbers.
function logDiscovery(next, value) {
  if (next.endpoint === 'newPools') console.log(JSON.stringify({ event: 'onchain_poll', chain: next.checkpoint.chain, fromBlock: value.fromBlock, toBlock: value.toBlock, head: value.head, pools: value.pools.length }));
  if (value.skippedBlocks > 0) console.log(JSON.stringify({ event: 'onchain_gap_skipped', chain: next.checkpoint.chain, skippedBlocks: value.skippedBlocks }));
  if (next.endpoint.startsWith('market:')) console.log(JSON.stringify({ event: 'pool_promoted', chain: next.checkpoint.chain, address: next.address }));
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

export async function executeRecoverableScanStep({ scanner, cycleId, ave, secondary = new SecondaryValidator(), chainLogs = new ChainLogs({ apiKey: null }), dexMarkets = fetchDexMarkets, request, onFinalized = null, now = Date.now }) {
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
    result = await record(request, discoveryOperation(next, { ave, chainLogs, dexMarkets }),
      value => { logDiscovery(next, value); return recordResponse(value, null); }, error => recordResponse(null, error));
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
