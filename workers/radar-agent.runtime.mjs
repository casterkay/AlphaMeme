import { env } from 'cloudflare:workers';
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { stableEffectId } from '../src/storage/recoverable-scanner.mjs';

const settings = Object.freeze({
  maxDeepAuditsPerCycle: 1,
  auditCycleBudgetMs: 80_000,
  queueRetentionMs: 24 * 60 * 60_000,
  staleCandidateMs: 10 * 60_000,
  dynamicRecheckMs: 2 * 60_000,
  chainPassRecheckMs: 5 * 60_000,
  hardRejectRecheckMs: 6 * 60 * 60_000,
  minAgeSec: 5 * 60,
  maxAgeSec: 7 * 86400,
  discoveryMinMarketCap: 10_000,
  discoveryMaxMarketCap: 150_000,
  priorityMinMarketCap: 20_000,
  priorityMaxMarketCap: 80_000,
  minLiquidity: 3_000,
  strictLiquidity: 8_000,
  maxRugRatio: 0.2,
  maxTop10Rate: 0.3,
  maxInsiderRate: 0.15,
  maxBundlerRate: 0.15,
  maxSniperHoldRate: 0.08,
  maxBotHoldRate: 0.2,
  maxLinkedHoldRate: 0.1,
  maxBuyTax: 0.05,
  maxSellTax: 0.05,
  maxTaxAsymmetry: 0.02,
  minLpLockedRate: 0.8,
  minOrdinaryWallets: 8
});

function candidateRow(now) {
  return {
    address: 'So11111111111111111111111111111111111111112',
    symbol: 'TEST',
    name: 'Test token',
    market_cap: 50_000,
    liquidity: 12_000,
    price: 1,
    creation_timestamp: Math.floor(now / 1_000) - 600,
    rug_ratio: 0.01,
    bundler_rate: 0.01,
    rat_trader_amount_rate: 0.01,
    is_wash_trading: false,
    holder_count: 20,
    swaps_5m: 20,
    buys_5m: 15,
    sells_5m: 5,
    volume_5m: 100,
    price_change_percent5m: 0.01,
    smart_degen_count: 3,
    renowned_count: 0,
    creator_created_count: 1,
    creator_created_open_count: 1
  };
}

function auditResponses(now) {
  const createdAt = Math.floor(now / 1_000) - 600;
  const holders = Array.from({ length: 8 }, (_, index) => ({
    address: `holder-${index}`, addr_type: 0, amount_percentage: 0.01, is_new: false, is_suspicious: false, buy_tx_count_cur: 1
  }));
  const candles = Array.from({ length: 5 }, (_, index) => ({
    time: now - (5 - index) * 60_000, open: 1, high: 1.01, low: 0.99, close: 1, volume: 100
  }));
  return [
    { price: { price: 1, swaps_5m: 20, buys_5m: 15, sells_5m: 5, volume_5m: 100, price_5m: 1 }, holder_count: 20,
      open_timestamp: createdAt, locked_ratio: 1, dev: { creator_token_status: 'closed', creator_open_count: 1 } },
    { open_source: true, renounced_mint: true, renounced_freeze_account: true, buy_tax: 0, sell_tax: 0, rug_ratio: 0.01,
      top_10_holder_rate: 0.1, dev_team_hold_rate: 0.001, suspected_insider_hold_rate: 0.01,
      bundler_trader_amount_rate: 0.01, top70_sniper_hold_rate: 0.01, is_wash_trading: false, lock_percent: 1 },
    { liquidity: 12_000 }, holders, [], candles
  ];
}

async function reachClassification(radar, tenantId, cycleId) {
  const now = Date.now();
  await radar.beginRecoverableCycle({ tenantId, cycleId, chain: 'sol', keyEpoch: 0, controlEpoch: 0, deadlineAt: now + 60_000, settings });
  await radar.recordRecoverableScanRequest({ tenantId, cycleId, response: { completed: [candidateRow(now)] }, collectedAt: now });
  await radar.recordRecoverableScanRequest({ tenantId, cycleId, response: { rank: [] }, collectedAt: now + 1 });
  await radar.advanceRecoverableScan({ tenantId, cycleId });
  await radar.advanceRecoverableScan({ tenantId, cycleId });
  for (const response of auditResponses(now)) {
    await radar.recordRecoverableScanRequest({ tenantId, cycleId, response, collectedAt: now + 2 });
  }
  const secondary = {
    status: 'DEGRADED', complete: false,
    sources: { dexScreener: { status: 'UNSUPPORTED' }, goPlus: { status: 'UNSUPPORTED' } },
    security: { verdict: 'UNSUPPORTED' }, conflicts: []
  };
  await radar.recordRecoverableScanRequest({ tenantId, cycleId, response: { result: secondary }, collectedAt: now + 3 });
  await radar.recordRecoverableScanRequest({ tenantId, cycleId, response: { result: secondary }, collectedAt: now + 4 });
}

describe('recoverable Radar scanner', () => {
  it('persists an encrypted credential and scan task before alarm rearm or eviction', async () => {
    const tenantId = '19000';
    const cycleId = 'cycle-scheduled';
    const radar = env.RADAR.get(env.RADAR.idFromName(`radar:${tenantId}`));
    await radar.replaceSchedulerEligibility({ tenantId, eligibility: { paused: false, configured: true } });
    await radar.setRecoverableGmgnCredential({ tenantId, apiKey: `gmgn_${'a'.repeat(32)}` });
    const checkpoint = await radar.beginRecoverableCycle({
      tenantId,
      cycleId,
      chain: 'sol',
      keyEpoch: 1,
      controlEpoch: 0,
      deadlineAt: Date.now() + 60_000,
      settings
    });
    expect(checkpoint.phase).toBe('DISCOVER');
    await runInDurableObject(radar, async (_instance, state) => {
      const key = state.storage.sql.exec('SELECT value_enc FROM keys WHERE tenant_id = ? AND name = ?', tenantId, 'gmgn-api-key').one();
      const tasks = JSON.parse(state.storage.sql
        .exec('SELECT value_json FROM scheduler_state WHERE tenant_id = ? AND key = ?', tenantId, 'scheduler.tasks.v1')
        .one().value_json).tasks;
      expect(key.value_enc).not.toContain('gmgn_');
      expect(tasks).toContainEqual(expect.objectContaining({ id: `scan:${cycleId}`, kind: 'scan' }));
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
    await evictDurableObject(radar);
    expect((await radar.getRecoverableCycle({ tenantId, cycleId })).phase).toBe('DISCOVER');
  });

  it('rearms a recoverable scan after a missing credential without moving its request cursor', async () => {
    const tenantId = '19003';
    const cycleId = 'cycle-missing-credential';
    const radar = env.RADAR.get(env.RADAR.idFromName(`radar:${tenantId}`));
    await radar.replaceSchedulerEligibility({ tenantId, eligibility: { paused: false, configured: true } });
    await radar.beginRecoverableCycle({
      tenantId,
      cycleId,
      chain: 'sol',
      keyEpoch: 0,
      controlEpoch: 0,
      deadlineAt: Date.now() + 60_000,
      settings
    });
    await runInDurableObject(radar, async (_instance, state) => {
      const taskState = JSON.parse(state.storage.sql
        .exec('SELECT value_json FROM scheduler_state WHERE tenant_id = ? AND key = ?', tenantId, 'scheduler.tasks.v1')
        .one().value_json);
      taskState.tasks[0].dueAt = Date.now() - 1;
      state.storage.sql.exec(
        'UPDATE scheduler_state SET value_json = ? WHERE tenant_id = ? AND key = ?',
        JSON.stringify(taskState),
        tenantId,
        'scheduler.tasks.v1'
      );
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    expect(await runDurableObjectAlarm(radar)).toBe(true);
    await runInDurableObject(radar, async (_instance, state) => {
      const runtime = JSON.parse(state.storage.sql
        .exec('SELECT value_json FROM scheduler_state WHERE tenant_id = ? AND key = ?', tenantId, 'scheduler.runtime.v1')
        .one().value_json);
      expect(runtime.retries[`scan:${cycleId}`]).toMatchObject({ attempts: 1, lastErrorCode: 'GMGN_CREDENTIAL_MISSING' });
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
    expect((await radar.getRecoverableCycle({ tenantId, cycleId })).endpointIndex).toBe(0);
  });

  it('rolls back effects before commit, then keeps the committed checkpoint and effect across eviction', async () => {
    const tenantId = '19001';
    const cycleId = 'cycle-atomic';
    const radar = env.RADAR.get(env.RADAR.idFromName(`radar:${tenantId}`));
    await reachClassification(radar, tenantId, cycleId);
    expect((await radar.getRecoverableCycle({ tenantId, cycleId })).phase).toBe('CLASSIFY_AND_COMMIT');

    await runInDurableObject(radar, async (_instance, state) => {
      state.storage.sql.exec("CREATE TRIGGER test_abort_recoverable_commit BEFORE INSERT ON audit_queue BEGIN SELECT RAISE(ABORT, 'test rollback'); END");
    });
    await runInDurableObject(radar, async instance => {
      await expect(instance.commitRecoverableClassification({ tenantId, cycleId })).rejects.toThrow('test rollback');
    });
    await runInDurableObject(radar, async (_instance, state) => {
      for (const table of ['candidates', 'audit_queue', 'risk_exclusions', 'outcomes', 'events', 'outbox']) {
        expect(state.storage.sql.exec(`SELECT COUNT(*) AS count FROM ${table} WHERE tenant_id = ?`, tenantId).one().count).toBe(0);
      }
    });
    expect((await radar.getRecoverableCycle({ tenantId, cycleId })).phase).toBe('CLASSIFY_AND_COMMIT');

    await runInDurableObject(radar, async (_instance, state) => {
      state.storage.sql.exec('DROP TRIGGER test_abort_recoverable_commit');
    });
    const committed = await radar.commitRecoverableClassification({ tenantId, cycleId });
    const expectedEffectId = stableEffectId(tenantId, cycleId, 'sol', candidateRow(Date.now()).address, 'X_REVIEW');
    expect(committed.effectId).toBe(expectedEffectId);
    expect(committed.checkpoint.phase).toBe('OUTCOMES_SAMPLE');

    await evictDurableObject(radar);
    expect((await radar.getRecoverableCycle({ tenantId, cycleId })).phase).toBe('OUTCOMES_SAMPLE');
    await runInDurableObject(radar, async (_instance, state) => {
      const candidate = state.storage.sql.exec('SELECT status FROM candidates WHERE tenant_id = ?', tenantId).one();
      const outcome = state.storage.sql.exec('SELECT baseline_at, baseline_price FROM outcomes WHERE tenant_id = ?', tenantId).one();
      const event = state.storage.sql.exec('SELECT id FROM events WHERE tenant_id = ?', tenantId).one();
      const outbox = state.storage.sql.exec('SELECT event_id FROM outbox WHERE tenant_id = ?', tenantId).one();
      expect(candidate.status).toBe('X_REVIEW');
      expect(outcome.baseline_at).toBeGreaterThan(0);
      expect(outcome.baseline_price).toBe(1);
      expect(event.id).toBe(expectedEffectId);
      expect(outbox.event_id).toBe(expectedEffectId);
    });
  });

  it('recovers a request response cursor after eviction without reusing its response timestamp', async () => {
    const tenantId = '19002';
    const cycleId = 'cycle-response';
    const radar = env.RADAR.get(env.RADAR.idFromName(`radar:${tenantId}`));
    const collectedAt = Date.now();
    await radar.beginRecoverableCycle({ tenantId, cycleId, chain: 'sol', keyEpoch: 0, controlEpoch: 0, deadlineAt: collectedAt + 60_000, settings });
    await radar.recordRecoverableScanRequest({ tenantId, cycleId, response: { completed: [] }, collectedAt });
    await evictDurableObject(radar);
    const checkpoint = await radar.getRecoverableCycle({ tenantId, cycleId });
    expect(checkpoint.phase).toBe('DISCOVER');
    expect(checkpoint.endpointIndex).toBe(1);
    expect(checkpoint.partial.discovery.responses.trenches.collectedAt).toBe(collectedAt);
    expect((await radar.nextRecoverableScanRequest({ tenantId, cycleId })).endpoint).toBe('trending');
  });
});
