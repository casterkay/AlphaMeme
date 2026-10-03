export function backendDisposition(row) {
  // A market lead passed the AVE screen only; its security is not verified.
  if (row.status === 'LIVE_READY') return 'lead';
  if (row.status === 'WAIT_RECHECK') return 'waiting';
  return 'rejected';
}

export function effectiveStatus(row, mark) {
  return mark?.decision === 'ignored' ? 'ignored' : backendDisposition(row);
}
