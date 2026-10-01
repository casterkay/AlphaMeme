// The one safety verdict for a token, shared by trading, panels and alerts.
// Pure: callers pass the recorded candidate status and secondary check.

// Multi-source conflicts that keep a lead from passing until it is rechecked.
export const BLOCKING_CONFLICTS = Object.freeze(['MARKET_MISMATCH', 'SECURITY_MISMATCH']);

export const blockingConflicts = secondary => (secondary?.conflicts || []).filter(conflict => BLOCKING_CONFLICTS.includes(conflict?.type));

// Deep-audit unknowns that block. An audit recorded before the blocking split
// has only unknownFields, and every one of them blocks.
export const blockingUnknownFields = deep => Array.isArray(deep?.blockingUnknownFields) ? deep.blockingUnknownFields
  : Array.isArray(deep?.unknownFields) ? deep.unknownFields : [];

/**
 * VETOED: rejected, or GoPlus/DexScreener found a fatal flag. PENDING: no check
 * recorded yet. PASSED: a complete check without fatal flags or blocking
 * conflicts, and no failed or blocking-unknown deep-audit field. INCOMPLETE:
 * anything else (a degraded, unknown or conflicted check, or an open deep audit).
 */
export function safetyVerdict({ status, secondary, deep = null }) {
  if (status === 'HARD_REJECT' || secondary?.security?.verdict === 'FATAL') return 'VETOED';
  if (!secondary) return 'PENDING';
  // A hard deep failure is already HARD_REJECT; what remains here is waiting or unknown.
  const auditOpen = (deep?.failed?.length ?? 0) > 0 || blockingUnknownFields(deep).length > 0;
  if (!auditOpen && secondary.status === 'COMPLETE' && secondary.security?.verdict === 'NO_FATAL_FLAGS' && !blockingConflicts(secondary).length) return 'PASSED';
  return 'INCOMPLETE';
}
