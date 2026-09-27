// Deployed probe: can a Cloudflare Worker read AVE's Data API at the planned
// one-chain, 15-second cadence without being rate limited or IP banned, and how
// much CPU does one read-and-parse alarm cost? GMGN banned the shared Workers
// egress (docs/spikes/LIVE-TIMING.md), so this is measured before AVE is wired in.

const AVE_ORIGIN = 'https://prod.ave-api.com';
const EGRESS_ECHO_URL = 'https://api.ipify.org?format=json';
const AVE_CHAINS = Object.freeze({ bsc: 'bsc', eth: 'eth', base: 'base', sol: 'solana' });
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_BODY_BYTES = 1_048_576;
const BODY_PREFIX_CHARS = 300;
const RATE_LIMIT_FLOOR_MS = 60_000;
const MAX_CONSECUTIVE_RATE_LIMITS = 3;
const CU_BY_READ = Object.freeze({ trending: 5, details: 5 });
export const PROBE_LIMITS = Object.freeze({
  defaultSamples: 120, maxSamples: 240, defaultIntervalMs: 15_000, minIntervalMs: 15_000, maxIntervalMs: 600_000
});

function authorized(request, env) {
  return typeof env.PROBE_TOKEN === 'string'
    && env.PROBE_TOKEN.length > 0
    && request.headers.get('Authorization') === `Bearer ${env.PROBE_TOKEN}`;
}

export function parseRunOptions(body) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const unknown = Object.keys(input).filter(key => !['chain', 'samples', 'intervalMs'].includes(key));
  if (unknown.length) throw new RangeError(`unknown option: ${unknown.join(', ')}`);
  const chain = input.chain ?? 'bsc';
  const samples = input.samples ?? PROBE_LIMITS.defaultSamples;
  const intervalMs = input.intervalMs ?? PROBE_LIMITS.defaultIntervalMs;
  if (!Object.hasOwn(AVE_CHAINS, chain)) throw new RangeError(`chain must be one of ${Object.keys(AVE_CHAINS).join(', ')}`);
  if (!Number.isSafeInteger(samples) || samples < 1 || samples > PROBE_LIMITS.maxSamples) {
    throw new RangeError(`samples must be an integer from 1 to ${PROBE_LIMITS.maxSamples}`);
  }
  if (!Number.isSafeInteger(intervalMs) || intervalMs < PROBE_LIMITS.minIntervalMs || intervalMs > PROBE_LIMITS.maxIntervalMs) {
    throw new RangeError(`intervalMs must be an integer from ${PROBE_LIMITS.minIntervalMs} to ${PROBE_LIMITS.maxIntervalMs}`);
  }
  return { chain, samples, intervalMs };
}

// AVE nests lists under data/list/tokens at varying depths; mirror the upstream client's tolerance.
function listRows(raw) {
  for (let depth = 0; depth < 4; depth++) {
    if (Array.isArray(raw)) return raw;
    if (!raw || typeof raw !== 'object') return null;
    for (const key of ['list', 'tokens']) if (Array.isArray(raw[key])) return raw[key];
    raw = raw.data;
  }
  return null;
}

function tokenAddress(row) {
  const value = row?.token ?? row?.address;
  return typeof value === 'string' && /^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/.test(value) ? value : null;
}

function retryAfterMs(value, now) {
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

async function boundedText(response) {
  if (!response.body) return { text: '', bytes: 0, truncated: false };
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  let truncated = false;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_BODY_BYTES) { truncated = true; break; }
      chunks.push(part.value);
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  const joined = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return { text: new TextDecoder().decode(joined), bytes, truncated };
}

const redact = (text, secret) => secret ? text.split(secret).join('[redacted]') : text;

/** One AVE GET, recorded as evidence. Never throws: every outcome is a measurement. */
export async function readAve({ fetchImpl, apiKey, path, kind, now = Date.now }) {
  const startedAt = now();
  const sample = { kind, startedAt, durationMs: null, outcome: null, httpStatus: null };
  try {
    const response = await fetchImpl(AVE_ORIGIN + path, {
      method: 'GET',
      headers: { 'X-API-KEY': apiKey, Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    sample.httpStatus = response.status;
    sample.cfRay = response.headers.get('cf-ray');
    sample.server = response.headers.get('server');
    sample.retryAfterMs = retryAfterMs(response.headers.get('retry-after'), now());
    const body = await boundedText(response);
    sample.bodyBytes = body.bytes;
    if (!response.ok || body.truncated) {
      sample.outcome = body.truncated ? 'oversize' : response.status === 429 ? 'rate_limited'
        : response.status === 402 ? 'quota' : [401, 403].includes(response.status) ? 'rejected' : 'http_error';
      sample.bodyPrefix = redact(body.text, apiKey).slice(0, BODY_PREFIX_CHARS);
      return sample;
    }
    let parsed;
    try { parsed = JSON.parse(body.text); } catch {
      sample.outcome = 'invalid_json';
      sample.bodyPrefix = redact(body.text, apiKey).slice(0, BODY_PREFIX_CHARS);
      return sample;
    }
    sample.aveStatus = parsed?.status ?? null;
    const rows = listRows(parsed);
    sample.rows = rows ? rows.length : null;
    sample.firstToken = rows ? rows.map(tokenAddress).find(Boolean) ?? null : null;
    sample.outcome = 'ok';
  } catch (error) {
    sample.outcome = error?.name === 'TimeoutError' ? 'timeout' : 'network_error';
    sample.error = String(error?.name || 'Error');
  } finally {
    sample.durationMs = now() - startedAt;
  }
  return sample;
}

async function observeEgress(fetchImpl) {
  try {
    const response = await fetchImpl(EGRESS_ECHO_URL, { signal: AbortSignal.timeout(5_000) });
    const value = await response.json();
    return typeof value?.ip === 'string' ? value.ip.slice(0, 64) : null;
  } catch {
    return null;
  }
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
}

export function summarize(record) {
  const trending = record.samples.filter(sample => sample.kind === 'trending');
  const byOutcome = {};
  for (const sample of record.samples) byOutcome[sample.outcome] = (byOutcome[sample.outcome] || 0) + 1;
  const okDurations = trending.filter(sample => sample.outcome === 'ok').map(sample => sample.durationMs);
  const alarmLags = record.alarms.map(alarm => alarm.deliveryLagMs).filter(Number.isFinite);
  return {
    options: record.options,
    startedAt: record.startedAt,
    stoppedAt: record.stoppedAt,
    stopReason: record.stopReason,
    trendingAttempts: trending.length,
    byOutcome,
    // Counts successful reads only; whether AVE also bills rejected reads is not documented.
    estimatedCu: record.samples.filter(sample => sample.httpStatus !== null && sample.httpStatus < 400)
      .reduce((sum, sample) => sum + CU_BY_READ[sample.kind], 0),
    trendingLatencyMs: { p50: percentile(okDurations, 0.5), p95: percentile(okDurations, 0.95), max: percentile(okDurations, 1) },
    alarmDeliveryLagMs: { p50: percentile(alarmLags, 0.5), p95: percentile(alarmLags, 0.95), max: percentile(alarmLags, 1) },
    egressAddresses: [...new Set(record.samples.map(sample => sample.egress).filter(Boolean))],
    firstFailure: record.samples.find(sample => sample.outcome !== 'ok') || null
  };
}

export class AveEgressProbe {
  constructor(ctx, env, fetchImpl = (...args) => fetch(...args)) {
    this.ctx = ctx;
    this.env = env;
    this.fetchImpl = fetchImpl;
  }

  async fetch(request) {
    if (!authorized(request, this.env)) return new Response('unauthorized', { status: 401 });
    const action = new URL(request.url).pathname.split('/').filter(Boolean).at(-1);
    if (request.method === 'POST' && action === 'start') return this.#start(request);
    if (request.method === 'POST' && action === 'stop') {
      const record = await this.ctx.storage.get('record');
      if (!record) return new Response('not found', { status: 404 });
      if (!record.stoppedAt) this.#stop(record, 'operator');
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.put('record', record);
      return Response.json(summarize(record));
    }
    if (request.method === 'GET' && action === 'result') {
      const record = await this.ctx.storage.get('record');
      return record ? Response.json({ summary: summarize(record), samples: record.samples }) : new Response('not found', { status: 404 });
    }
    return new Response('not found', { status: 404 });
  }

  async #start(request) {
    if (typeof this.env.AVE_API_KEY !== 'string' || !this.env.AVE_API_KEY.trim()) {
      return new Response('AVE_API_KEY secret is not set', { status: 409 });
    }
    if (await this.ctx.storage.get('record')) return new Response('run already exists; use a new run id', { status: 409 });
    let options;
    try {
      options = parseRunOptions(await request.json().catch(() => ({})));
    } catch (error) {
      return new Response(error.message, { status: 400 });
    }
    const startedAt = Date.now();
    const record = {
      options, startedAt, stoppedAt: null, stopReason: null, nextAlarmAt: startedAt,
      consecutiveRateLimits: 0, detailsChecked: false, samples: [], alarms: []
    };
    await this.ctx.storage.put('record', record);
    await this.ctx.storage.setAlarm(startedAt);
    return Response.json(summarize(record), { status: 202 });
  }

  #stop(record, reason) {
    record.stoppedAt = Date.now();
    record.stopReason = reason;
    record.nextAlarmAt = null;
  }

  async alarm() {
    const record = await this.ctx.storage.get('record');
    if (!record || record.stoppedAt) return;
    const startedAt = Date.now();
    record.alarms.push({ scheduledAt: record.nextAlarmAt, startedAt, deliveryLagMs: startedAt - record.nextAlarmAt });
    const { chain, samples, intervalMs } = record.options;
    const apiChain = AVE_CHAINS[chain];
    const apiKey = this.env.AVE_API_KEY;

    const egress = await observeEgress(this.fetchImpl);
    const trending = await readAve({
      fetchImpl: this.fetchImpl, apiKey, kind: 'trending',
      path: `/v2/tokens/trending?chain=${apiChain}&current_page=0&page_size=100`
    });
    trending.egress = egress;
    record.samples.push(trending);

    // One token-details read per run shows whether a second endpoint class is treated differently.
    if (trending.outcome === 'ok' && !record.detailsChecked && trending.firstToken) {
      record.detailsChecked = true;
      const details = await readAve({
        fetchImpl: this.fetchImpl, apiKey, kind: 'details', path: `/v2/tokens/${trending.firstToken}-${apiChain}`
      });
      details.egress = egress;
      record.samples.push(details);
    }

    const attempts = record.samples.filter(sample => sample.kind === 'trending').length;
    let delayMs = intervalMs;
    if (trending.outcome === 'rate_limited') {
      record.consecutiveRateLimits += 1;
      // Back off instead of renewing a ban; the evidence is the first rejection, not a hundred.
      delayMs = Math.max(intervalMs, RATE_LIMIT_FLOOR_MS, trending.retryAfterMs || 0);
    } else {
      record.consecutiveRateLimits = 0;
    }

    if (['rejected', 'quota'].includes(trending.outcome)) this.#stop(record, trending.outcome);
    else if (record.consecutiveRateLimits >= MAX_CONSECUTIVE_RATE_LIMITS) this.#stop(record, 'rate_limited');
    else if (attempts >= samples) this.#stop(record, 'complete');
    else {
      record.nextAlarmAt = startedAt + delayMs;
      await this.ctx.storage.setAlarm(record.nextAlarmAt);
    }
    await this.ctx.storage.put('record', record);
    console.log(JSON.stringify({
      event: 'ave_probe_alarm', attempt: attempts, outcome: trending.outcome, httpStatus: trending.httpStatus,
      durationMs: trending.durationMs, rows: trending.rows ?? null, egress, stopReason: record.stopReason
    }));
  }
}

export default {
  async fetch(request, env) {
    if (!authorized(request, env)) return new Response('unauthorized', { status: 401 });
    const path = new URL(request.url).pathname.split('/').filter(Boolean);
    if (path.length !== 3 || path[0] !== 'runs') return new Response('not found', { status: 404 });
    const [, runId, action] = path;
    if (!/^[a-f0-9-]{36}$/.test(runId)) return new Response('invalid run id', { status: 400 });
    return env.AVE_EGRESS_PROBE.get(env.AVE_EGRESS_PROBE.idFromName(runId)).fetch(
      new Request(`https://probe.invalid/${action}`, request)
    );
  }
};
