import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { normalizeSecurity } from './replay.mjs';
import { readJson, writeJson } from './security.mjs';

/** A positive honeypot finding wins; otherwise use a conclusive provider flag. */
export function mergeSecurity(gmgn, goplus, ave) {
  const rows = [gmgn, goplus, ave].map(normalizeSecurity);
  const flags = rows.map(row => row.honeypot);
  return {
    is_honeypot: flags.includes(true) ? true : flags.includes(false) ? false : null,
    buy_tax: rows.slice(0, 2).find(row => row.buyTax !== null)?.buyTax ?? null,
    sell_tax: rows.slice(0, 2).find(row => row.sellTax !== null)?.sellTax ?? null
  };
}

/** Supplement unresolved GMGN inputs using current contract reports, never entry screening. */
export async function supplementSecurity(snapshots, { cacheDirectory, aveApiKey, onProgress = () => {}, fetchImpl = fetch, goPlusIntervalMs = 2100, aveIntervalMs = 15000 }) {
  await mkdir(cacheDirectory, { recursive: true });
  const results = {};
  let nextGoPlus = 0, nextAve = 0, complete = 0;
  const stopped = new Set();
  const query = async (provider, token) => {
    const path = join(cacheDirectory, `${provider}-${token}.json`);
    const cached = await readJson(path);
    if (cached) return cached;
    if (stopped.has(provider)) return null;
    const now = Date.now();
    await sleep(Math.max(0, (provider === 'goplus' ? nextGoPlus : nextAve) - now));
    if (provider === 'goplus') nextGoPlus = Date.now() + goPlusIntervalMs;
    else nextAve = Date.now() + aveIntervalMs;
    const url = provider === 'goplus'
      ? `https://api.gopluslabs.io/api/v1/token_security/5042?contract_addresses=${token}`
      : `https://prod.ave-api.com/v2/contracts/${token}-arc`;
    const response = await fetchImpl(url, { headers: provider === 'ave' ? { 'X-API-KEY': aveApiKey } : {}, signal: AbortSignal.timeout(15000) });
    const body = await response.json();
    const ok = response.ok && Number(provider === 'goplus' ? body.code : body.status) === 1;
    if (response.status === 429 || response.status === 401 || response.status === 403 || (!ok && /too many|limit|quota|credit|auth/i.test(String(body.message ?? body.msg)))) {
      stopped.add(provider);
      onProgress({ phase: 'supplement_unavailable', provider, http: response.status, code: body.code ?? body.status });
      return null;
    }
    const data = ok ? provider === 'goplus' ? body.result?.[token.toLowerCase()] ?? null : body.data ?? null : null;
    const snapshot = { capturedAt: new Date().toISOString(), status: data ? 'ok' : 'unavailable', data };
    await writeJson(path, snapshot);
    return snapshot;
  };
  for (const [token, snapshot] of Object.entries(snapshots)) {
    const original = snapshot.providers?.gmgn ?? snapshot;
    let goplus = snapshot.providers?.goplus ?? null, ave = snapshot.providers?.ave ?? null;
    if (Object.values(normalizeSecurity(original.data)).some(value => value === null)) {
      goplus ||= await query('goplus', token);
      if (mergeSecurity(original.data, goplus?.data, null).is_honeypot === null && aveApiKey) ave ||= await query('ave', token);
    }
    results[token] = { ...snapshot, data: mergeSecurity(original.data, goplus?.data, ave?.data), providers: { gmgn: original, goplus, ave } };
    if (++complete % 20 === 0 || complete === Object.keys(snapshots).length) onProgress({ phase: 'supplement', complete, total: Object.keys(snapshots).length });
  }
  return results;
}
