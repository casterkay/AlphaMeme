import http from 'node:http';

const MAX_BODY_BYTES = 1024 * 1024;
const SKIP_HEADERS = new Set([
  'host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive',
  'upgrade', 'te', 'trailer', 'proxy-connection', 'expect', 'accept-encoding'
]);

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    request.on('data', chunk => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks, total)));
    request.on('error', reject);
  });
}

// Adapt node:http to the standard Request/Response contract the Worker export expects.
export function createServer({ worker, env }) {
  return http.createServer(async (req, res) => {
    try {
      const method = req.method || 'GET';
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined || SKIP_HEADERS.has(name.toLowerCase())) continue;
        if (Array.isArray(value)) for (const item of value) headers.append(name, item);
        else headers.append(name, value);
      }
      const hasBody = method !== 'GET' && method !== 'HEAD';
      const body = hasBody ? await readBody(req) : null;
      const request = new Request(url, { method, headers, ...(body && body.length ? { body } : {}) });
      const response = await worker.fetch(request, env);
      const bytes = Buffer.from(await response.arrayBuffer());
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(bytes);
    } catch (error) {
      console.error(JSON.stringify({ event: 'http_request_failed', path: req.url, errorType: error?.name || 'unknown', message: String(error?.message || error) }));
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal_error' }));
    }
  });
}

// Reconcile tenants on the same cadence as the Worker cron trigger ("* * * * *").
export function startScheduledLoop({ worker, env, intervalMs = 60_000 }) {
  const tick = async () => {
    try {
      await worker.scheduled({ cron: '* * * * *' }, env);
    } catch (error) {
      console.error(JSON.stringify({ event: 'scheduled_watchdog_failed', errorType: error?.name || 'unknown', message: String(error?.message || error) }));
    }
  };
  void tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return timer;
}
