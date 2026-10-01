// The one safety verdict for a token, shared by trading, panels and alerts.
// Pure: callers pass the recorded candidate status and secondary check.

// Multi-source conflicts that keep a lead from passing until it is rechecked.
export const BLOCKING_CONFLICTS = Object.freeze(['MARKET_MISMATCH', 'SECURITY_MISMATCH']);

export const blockingConflicts = secondary => (secondary?.conflicts || []).filter(conflict => BLOCKING_CONFLICTS.includes(conflict?.type));

/**
 * VETOED: rejected, or GoPlus/DexScreener found a fatal flag. PENDING: no check
 * recorded yet. PASSED: a complete check without fatal flags or blocking
 * conflicts. INCOMPLETE: any other check (degraded, unknown or conflicted).
 */
export function safetyVerdict({ status, secondary }) {
  if (status === 'HARD_REJECT' || secondary?.security?.verdict === 'FATAL') return 'VETOED';
  if (!secondary) return 'PENDING';
  if (secondary.status === 'COMPLETE' && secondary.security?.verdict === 'NO_FATAL_FLAGS' && !blockingConflicts(secondary).length) return 'PASSED';
  return 'INCOMPLETE';
}
