import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';

const requestTimeoutMs = 30_000;
const timers = new Set();
const server = createServer((request, response) => {
  const [, scenario, kind, sequence] = request.url.split('/');
  const firstScan = kind === 'scan' && sequence === '1';
  const delayMs = scenario === 'slow' && firstScan ? requestTimeoutMs + 1000 : 25;
  const timer = setTimeout(() => {
    timers.delete(timer);
    if (response.destroyed) return;
    if (scenario === 'rate-limit' && firstScan) response.writeHead(429, { 'Retry-After': '2' });
    else response.writeHead(scenario === 'miss' && kind === 'scan' ? 404 : 200);
    response.end('{}');
  }, delayMs);
  timers.add(timer);
  response.on('close', () => { clearTimeout(timer); timers.delete(timer); });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const sources = await Promise.all(['workers/fixtures/live-timing-spike.mjs', 'src/scheduler.mjs'].map(path => readFile(new URL(`../../${path}`, import.meta.url), 'utf8')));
const runtime = new Miniflare({ workers: [{ config: {
  name: 'local-live-timing-spike', type: 'worker', compatibilityDate: '2026-09-20', compatibilityFlags: [],
  env: { ORIGIN: { type: 'text', value: origin }, REQUEST_TIMEOUT_MS: { type: 'text', value: String(requestTimeoutMs) } },
  manifest: { mainModule: 'spike.mjs', modules: {
    'spike.mjs': { type: 'esm', contents: sources[0] }, 'scheduler.mjs': { type: 'esm', contents: sources[1] }
  } }
} }] });
try {
  for (const scenario of ['normal', 'slow', 'rate-limit', 'miss']) {
    const response = await runtime.dispatchFetch(`https://spike.test/${scenario}`);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.complete, true, `${scenario} must complete within bounded steps`);
    const firstLive = result.requests.findIndex(row => row.kind === 'live');
    assert(firstLive > 0 && result.requests.slice(firstLive + 1).some(row => row.kind === 'scan'), 'live must run between scan requests');
    assert.equal(result.cpuMs, null);
    console.log(JSON.stringify(result));
  }
} finally {
  await runtime.dispose();
  for (const timer of timers) clearTimeout(timer);
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
