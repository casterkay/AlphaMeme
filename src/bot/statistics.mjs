import { normalizeTenantId } from '../storage/gmgn-admission-state.mjs';
import { REQUIRED_CALIBRATION_WINDOWS, summarizeOutcomes } from '../scoring/outcomes.mjs';

export const STATISTICS_CHAINS = Object.freeze(['sol', 'bsc', 'base', 'eth', 'robinhood', 'arc', 'stable']);
const completionFields = Object.freeze({ m30: 'completed30m', h2: 'completed2h', h24: 'completed24h' });

export class StatisticsError extends Error {
  constructor(code) { super(code); this.name = 'StatisticsError'; this.code = code; }
}

function samplesFromRow(row) {
  if (row.samples_json === null) return {};
  let samples;
  try { samples = JSON.parse(row.samples_json); } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new StatisticsError('STATISTICS_SAMPLES_CORRUPT');
  }
  if (!samples || typeof samples !== 'object' || Array.isArray(samples)) throw new StatisticsError('STATISTICS_SAMPLES_CORRUPT');
  return samples;
}

/**
 * Read the complete retained, tenant-scoped outcome cohorts from one SQL snapshot.
 * Missing samples remain missing; a failed read throws so the panel can distinguish
 * unavailable storage from a successfully read empty cohort.
 * @param {{sql: {exec: Function}}} storage
 * @param {string} tenant
 * @param {number} now
 * @returns {Record<string, object>}
 */
export function readTelegramStatistics(storage, tenant, now = Date.now()) {
  if (!storage?.sql || typeof storage.sql.exec !== 'function') throw new StatisticsError('STATISTICS_STORAGE_UNAVAILABLE');
  if (!Number.isSafeInteger(now) || now < 0) throw new StatisticsError('STATISTICS_CLOCK_INVALID');
  const tenantId = normalizeTenantId(tenant);
  const rows = storage.sql.exec(
    'SELECT chain, initial_decision, baseline_at, samples_json FROM outcomes WHERE tenant_id = ?', tenantId
  ).toArray();
  const byChain = Object.fromEntries(STATISTICS_CHAINS.map(chain => [chain, []]));
  for (const row of rows) {
    if (!Object.hasOwn(byChain, row.chain) || !Number.isSafeInteger(row.baseline_at) || row.baseline_at < 0) {
      throw new StatisticsError('STATISTICS_OUTCOME_CORRUPT');
    }
    byChain[row.chain].push({ initialDecision: row.initial_decision, baselineAt: row.baseline_at, samples: samplesFromRow(row) });
  }
  return Object.fromEntries(STATISTICS_CHAINS.map(chain => {
    const summary = summarizeOutcomes(byChain[chain], now);
    return [chain, {
      available: true,
      generatedAt: now,
      ...summary,
      readyWindows: REQUIRED_CALIBRATION_WINDOWS.filter(window => summary[completionFields[window]] >= summary.minimumSample)
    }];
  }));
}
