const MAXIMUM_MANUAL_PASS_AGE_MS = 24 * 60 * 60_000;
const MAXIMUM_AUDIT_AGE_MS = 10 * 60_000;

function candidateAuditAge(row, now) {
  return row?.auditedAt ? Math.max(0, now - Number(row.auditedAt)) : Number.POSITIVE_INFINITY;
}

export function backendDisposition(row) {
  if (row.status === 'X_REVIEW' || row.status === 'QUALIFIED') return 'chain';
  if (row.status === 'WAIT_RECHECK') return 'waiting';
  if (row.status === 'HARD_REJECT' || row.status === 'REJECTED') return 'rejected';
  if (row.deep && row.deep.chainPass) return 'chain';
  return 'rejected';
}

export function effectiveStatus(row, mark, now = Date.now()) {
  if (mark?.decision === 'ignored') return 'ignored';
  if (mark?.decision === 'passed' && mark.reviewRevision && mark.reviewRevision === row.reviewRevision
    && now - mark.at < MAXIMUM_MANUAL_PASS_AGE_MS && backendDisposition(row) === 'chain'
    && candidateAuditAge(row, now) <= MAXIMUM_AUDIT_AGE_MS) return 'passed';
  return backendDisposition(row);
}

export function canPass(row, mark, now = Date.now()) {
  return backendDisposition(row) === 'chain' && candidateAuditAge(row, now) <= MAXIMUM_AUDIT_AGE_MS
    || mark?.decision === 'passed';
}
