import { sha256Bytes } from '../util/crypto.mjs';

export const horizons = Object.freeze({ m5: 300_000, m15: 900_000, m30: 1800_000, h1: 3600_000, h2: 7200_000, h6: 21600_000, h24: 86400_000 });

export async function sampleRejected(outcomes, candidate, now) {
  if (candidate.status !== 'HARD_REJECT' || !(candidate.price > 0)) return outcomes;
  if (outcomes.some(row => row.address === candidate.address)) return outcomes;
  // Stable 1-in-5 sampling, independent of subsequent returns or popularity.
  const hash = await sha256Bytes(`${candidate.chain}:${candidate.address}`);
  if (hash[0] % 5 || outcomes.filter(row => row.initialDecision === 'HARD_REJECT').length >= 200) return outcomes;
  outcomes.push({ chain: candidate.chain, address: candidate.address, symbol: candidate.symbol,
    baselineAt: now, baselinePrice: candidate.price, initialDecision: 'HARD_REJECT',
    latestDecision: candidate.status, latestFailed: candidate.deep?.failed || [], samples: {},
    sampling: 'SHA256_MOD5', strategyVersion: 'radar-v3' });
  return outcomes;
}

export function dueOutcomeJobs(outcomes, now) {
  return outcomes.flatMap(row => Object.entries(horizons).filter(([key, duration]) =>
    !row.samples?.[key] && now >= row.baselineAt + duration + 60_000
    && now >= (row.sampleRetries?.[key]?.nextAt || 0)
  ).map(([key, duration]) => ({ row, key, targetAt: row.baselineAt + duration })))
    .sort((a, b) => (a.row.sampleRetries?.[a.key]?.attempts || 0) - (b.row.sampleRetries?.[b.key]?.attempts || 0) || a.targetAt - b.targetAt);
}

export async function collectOutcomeSamples(outcomes, gmgn, chain, { limit = 4, now = Date.now, deadline = Infinity } = {}) {
  if (typeof gmgn.priceAt !== 'function') return outcomes;
  for (const job of dueOutcomeJobs(outcomes, now()).slice(0, limit)) {
    if (now() >= deadline || gmgn.disabled || gmgn.nextAllowedAt > now()) break;
    const { row, key, targetAt } = job;
    let sample, errorCode = 'NO_CANDLE';
    try { sample = await gmgn.priceAt(row.address, targetAt, row.chain || chain); }
    catch (error) { errorCode = error?.code === 'GMGN_RATE_LIMITED' ? 'RATE_LIMITED' : 'READ_FAILED'; }
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
    if (errorCode === 'RATE_LIMITED') break;
  }
  return outcomes;
}

export function outcomeCoverage(outcomes, now = Date.now()) {
  const cohort = decision => {
    const rows = outcomes.filter(row => row.initialDecision === decision);
    return Object.fromEntries(Object.entries(horizons).map(([key, duration]) => {
      const eligible = rows.filter(row => now >= row.baselineAt + duration);
      const values = eligible.map(row => row.samples?.[key]?.return).filter(Number.isFinite).sort((a, b) => a - b);
      const n = values.length;
      return [key, { eligible: eligible.length, completed: n, missing: eligible.length - n,
        median: n ? (values[Math.floor((n - 1) / 2)] + values[Math.floor(n / 2)]) / 2 : null,
        positiveRate: n ? values.filter(x => x > 0).length / n : null }];
    }));
  };
  return { passed: cohort('X_REVIEW'), rejected: cohort('HARD_REJECT') };
}

export const REQUIRED_CALIBRATION_WINDOWS = Object.freeze(['m30', 'h2', 'h24']);

export function summarizeOutcomes(outcomes, now = Date.now()) {
  const numberOrNull = value => {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const rows = (Array.isArray(outcomes) ? outcomes : []).filter(item => item?.initialDecision === 'X_REVIEW');
  const average = key => {
    const values = rows.map(item => numberOrNull(item.samples?.[key]?.return)).filter(value => value !== null);
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  };
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
    averageReturn5m: average('m5'),
    averageReturn15m: average('m15'),
    averageReturn30m: average('m30'),
    averageReturn1h: average('h1'),
    averageReturn2h: average('h2'),
    averageReturn24h: average('h24'),
    note: '影子验证，仅衡量筛选结果，不代表可成交收益'
    ,coverage: outcomeCoverage(outcomes || [], now)
  };
}
