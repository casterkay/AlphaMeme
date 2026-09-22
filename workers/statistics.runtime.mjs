import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { readTelegramStatistics } from '../src/bot/statistics.mjs';

it('reads seven-window statistics from Durable Object SQLite without Node dependencies', async () => {
  const tenantId = '28901';
  const radar = env.RADAR.get(env.RADAR.idFromName(`radar:${tenantId}`));
  await radar.replaceSchedulerEligibility({ tenantId, eligibility: { configured: false, paused: false } });
  await runInDurableObject(radar, async (_instance, state) => {
    state.storage.sql.exec('INSERT INTO outcomes (tenant_id, chain, address, initial_decision, baseline_at, samples_json) VALUES (?, ?, ?, ?, ?, ?)',
      tenantId, 'sol', 'sample-address', 'X_REVIEW', 1000, JSON.stringify({ h6: { return: 0.25 } }));
    const stats = readTelegramStatistics(state.storage, tenantId, 90_000_000);
    expect(Object.keys(stats.sol.coverage.passed)).toEqual(['m5', 'm15', 'm30', 'h1', 'h2', 'h6', 'h24']);
    expect(stats.sol.coverage.passed.h6).toEqual({ eligible: 1, completed: 1, missing: 0, median: 0.25, positiveRate: 1 });
    expect(stats.sol.averageReturn30m).toBeNull();
    expect(stats.sol.calibrationReady).toBe(false);
    expect(readTelegramStatistics(state.storage, '28902', 90_000_000).sol.tracked).toBe(0);
  });
});
