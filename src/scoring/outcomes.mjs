import { sha256Bytes } from '../util/crypto.mjs';

// A market lead (LIVE_READY) is the only screen pass.
const PASSED_DECISIONS = Object.freeze(['LIVE_READY']);
export const horizons = Object.freeze({ m5: 300_000, m15: 900_000, m30: 1800_000, h1: 3600_000, h2: 7200_000, h6: 21600_000, h24: 86400_000 });
const MAX_SAMPLE_ATTEMPTS = 3;
const MAX_SAMPLE_LATENESS_MS = 24 * 3600_000;
const PAUSE_CODES = new Set(['AVE_RATE_LIMITED', 'AVE_BUDGET', 'AVE_HOURLY_BUDGET', 'AVE_TOTAL_BUDGET', 'AVE_QUOTA', 'AVE_DISCOVERY_RESERVE', 'AVE_ABORTED', 'AVE_CHANGED', 'AVE_DISABLED']);

export const hasAveOutcomeBaseline = row => row?.cohortMetadata?.baselineProvider === 'AVE';

export async function sampleRejected(outcomes, candidate, now) {
  if (candidate.status !== 'HARD_REJECT' || !(candidate.price > 0)) return outcomes;
  if (outcomes.some(row => row.address === candidate.address)) return outcomes;
  // Stable 1-in-5 sampling, independent of subsequent returns or popularity.
  const hash = await sha256Bytes(`${candidate.chain}:${candidate.address}`);
  if (hash[0] % 5 || outcomes.filter(row => row.initialDecision === 'HARD_REJECT').length >= 200) return outcomes;
  outcomes.push({ chain: candidate.chain, address: candidate.address, symbol: candidate.symbol,
    baselineAt: now, baselinePrice: candidate.price, initialDecision: 'HARD_REJECT',
    latestDecision: candidate.status, latestFailed: candidate.deep?.failed || [], samples: {},
    sampling: 'SHA256_MOD5', strategyVersion: 'radar-v3',
    cohortMetadata: { baselineProvider: candidate.marketProvider || 'LEGACY_UNKNOWN' } });
  return outcomes;
}

export function dueOutcomeJobs(outcomes, now) {
  return outcomes.filter(hasAveOutcomeBaseline).flatMap(row => Object.entries(horizons).filter(([key, duration]) =>
    !row.samples?.[key] && now >= row.baselineAt + duration + 60_000
    && now >= (row.sampleRetries?.[key]?.nextAt || 0)
    && (row.sampleRetries?.[key]?.attempts || 0) < MAX_SAMPLE_ATTEMPTS
    && now - (row.baselineAt + duration) <= MAX_SAMPLE_LATENESS_MS
  ).map(([key, duration]) => ({ row, key, targetAt: row.baselineAt + duration })))
    .sort((a, b) => (a.row.sampleRetries?.[a.key]?.attempts || 0) - (b.row.sampleRetries?.[b.key]?.attempts || 0) || a.targetAt - b.targetAt);
}

export function selectOutcomeJobs(scopes, { enabledChains = [], provider = 'AVE', limit = 0, now = Date.now() } = {}) {
  if (provider !== 'AVE' || !Number.isInteger(limit) || limit <= 0) return [];
  const enabled = new Set(enabledChains);
  return Object.entries(scopes).filter(([chain]) => enabled.has(chain))
    .flatMap(([chain, rows]) => dueOutcomeJobs(rows.filter(row => !row.chain || row.chain === chain), now)
      .map(job => ({ ...job, chain })))
    .sort((a, b) => (a.row.sampleRetries?.[a.key]?.attempts || 0) - (b.row.sampleRetries?.[b.key]?.attempts || 0) || a.targetAt - b.targetAt)
    .slice(0, limit);
}

export async function collectOutcomeSamples(outcomes, provider, chain, { limit = 4, now = Date.now, deadline = Infinity, onlyKey, signal } = {}) {
  if (typeof provider.priceAt !== 'function') return outcomes;
  if (!Number.isInteger(limit) || limit <= 0) return outcomes;
  // Retained records with no explicit source remain readable but cannot gain AVE samples.
  for (const job of dueOutcomeJobs(outcomes, now()).filter(job => !onlyKey || job.key === onlyKey).slice(0, limit)) {
    if (signal?.aborted || now() >= deadline || provider.disabled || provider.nextAllowedAt > now()) break;
    const { row, key, targetAt } = job;
    let sample, errorCode = 'NO_CANDLE';
    try { sample = await provider.priceAt(row.address, targetAt, row.chain || chain, { signal }); }
    catch (error) {
      if (signal?.aborted) break;
      if (PAUSE_CODES.has(error?.code)) {
        row.sampleRetries ||= {};
        row.sampleRetries[key] = { attempts: row.sampleRetries[key]?.attempts || 0, code: error.code,
          nextAt: Math.max(now() + 120_000, Number(error.retryAt) || 0) };
        break;
      }
      errorCode = 'READ_FAILED';
    }
    if (signal?.aborted) break;
    row.samples ||= {};
    row.sampleRetries ||= {};
    if (sample && Number.isFinite(sample.price) && sample.price > 0 && row.baselinePrice > 0
      && Math.abs(sample.at - targetAt) <= 60_000 && sample.at <= now()) {
      row.samples[key] = { ...sample, targetAt, lagMs: sample.at - targetAt, collectedAt: now(), return: sample.price / row.baselinePrice - 1 };
      delete row.sampleRetries[key];
    } else {
      const attempts = (row.sampleRetries[key]?.attempts || 0) + 1;
      row.sampleRetries[key] = { attempts, code: errorCode, nextAt: now() + Math.min(3600_000, 120_000 * 2 ** Math.min(attempts - 1, 5)) };
    }
  }
  return outcomes;
}

export function outcomeCoverage(outcomes, now = Date.now()) {
  const cohort = decision => {
    const rows = outcomes.filter(row => decision.includes(row.initialDecision));
    return Object.fromEntries(Object.entries(horizons).map(([key, duration]) => {
      const eligible = rows.filter(row => now >= row.baselineAt + duration);
      const values = eligible.map(row => row.samples?.[key]?.return).filter(Number.isFinite).sort((a, b) => a - b);
      const n = values.length;
      return [key, { eligible: eligible.length, completed: n, missing: eligible.length - n,
        median: n ? (values[Math.floor((n - 1) / 2)] + values[Math.floor(n / 2)]) / 2 : null,
        positiveRate: n ? values.filter(x => x > 0).length / n : null }];
    }));
  };
  return { passed: cohort(PASSED_DECISIONS), rejected: cohort(['HARD_REJECT']) };
}

export const REQUIRED_CALIBRATION_WINDOWS = Object.freeze(['m30', 'h2', 'h24']);

export function summarizeOutcomes(outcomes, now = Date.now()) {
  const rows = (Array.isArray(outcomes) ? outcomes : []).filter(item => PASSED_DECISIONS.includes(item?.initialDecision));
  const completed = Object.fromEntries(Object.keys(horizons).map(key => [key, rows.filter(item => item.samples?.[key]).length]));
  return {
    tracked: rows.length,
    minimumSample: 50,
    calibrationReady: REQUIRED_CALIBRATION_WINDOWS.every(key => completed[key] >= 50),
    completed5m: completed.m5,
    completed15m: completed.m15,
    completed30m: completed.m30,
    completed1h: completed.h1,
    completed2h: completed.h2,
    completed6h: completed.h6,
    completed24h: completed.h24,
    note: '影子验证，仅衡量筛选结果，不代表可成交收益'
    ,coverage: outcomeCoverage(outcomes || [], now)
  };
}
