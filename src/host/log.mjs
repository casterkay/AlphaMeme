/** One structured log line, as the Worker writes them; an error is reduced to its type and code, never its message. */
export function logEvent(event, { error, ...fields } = {}) {
  const line = { event, ...fields };
  if (error !== undefined) {
    line.errorType = error instanceof Error ? error.name : typeof error;
    if (typeof error?.code === 'string') line.errorCode = error.code;
  }
  (error === undefined ? console.log : console.error)(JSON.stringify(line));
}
