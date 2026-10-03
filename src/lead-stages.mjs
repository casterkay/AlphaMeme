// A lead's stage times, kept on its candidate (metadata.stages) as facts so discovery latency can be measured:
// the token's launch (AVE's launch time, or its first pool's creation) → first seen in the chain logs → first
// listed on DexScreener → first promotable → first screened → lead created → alert enqueued → alert delivered,
// and, alongside the alert, the first complete GoPlus check.

// The stage each one follows; an unknown predecessor defers to the one before it.
const FOLLOWS = Object.freeze({
  launchedAt: null, logSeenAt: 'launchedAt', listedAt: 'logSeenAt', promotableAt: 'listedAt', screenedAt: 'promotableAt',
  leadCreatedAt: 'screenedAt', alertEnqueuedAt: 'leadCreatedAt', alertDeliveredAt: 'alertEnqueuedAt', goPlusCompleteAt: 'leadCreatedAt'
});

function floor(stages, stage) {
  for (let before = FOLLOWS[stage]; before; before = FOLLOWS[before]) if (Object.hasOwn(stages, before)) return stages[before];
  return null;
}

/**
 * The stage record with `entries` (stage → time, in pipeline order) added. A recorded stage keeps its first
 * time; an unknown one stays absent, never zero; one earlier than the last known stage before it (another
 * clock's skew) stays unknown and is logged. So the record is monotonic along the pipeline, and what it adds is logged.
 */
export function withStages(stages, entries, { chain, address }) {
  const next = { ...stages }, added = {};
  for (const [stage, at] of Object.entries(entries)) {
    if (!Object.hasOwn(FOLLOWS, stage)) throw new TypeError(`unknown lead stage: ${stage}`);
    if (Object.hasOwn(next, stage) || !Number.isSafeInteger(at) || at <= 0) continue;
    const before = floor(next, stage);
    if (before !== null && at < before) {
      console.log(JSON.stringify({ event: 'lead_stage_out_of_order', chain, address, stage, at, before }));
      continue;
    }
    next[stage] = added[stage] = at;
  }
  if (Object.keys(added).length) console.log(JSON.stringify({ event: 'lead_stages', chain, address, stages: added }));
  return next;
}
