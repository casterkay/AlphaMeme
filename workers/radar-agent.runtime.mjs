import { env } from 'cloudflare:workers';
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { stableEffectId } from '../src/storage/recoverable-scanner.mjs';
import { SqliteRecoverableScannerStore } from '../src/storage/recoverable-scanner.mjs';
import { RecoverableScanner } from '../src/recoverable-scanner.mjs';
import { seedGmgnCredential } from './fixtures/gmgn-credential.mjs';

const settings = Object.freeze({
  scanIntervalMs: 120_000,
  maxDeepAuditsPerCycle: 1,
  auditCycleBudgetMs: 80_000,
  queueRetentionMs: 24 * 60 * 60_000,
  staleCandidateMs: 10 * 60_000,
  dynamicRecheckMs: 2 * 60_000,
  chainPassRecheckMs: 5 * 60_000,
  hardRejectRecheckMs: 6 * 60 * 60_000,
  outcomeReadsPerCycle: 4,
  candidateRetentionMs: 2 * 60 * 60_000,
  outcomeRetentionMs: 7 * 24 * 60 * 60_000,
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
  await radar.replaceSchedulerEligibility({ tenantId, eligibility: { paused: false, configured: true } });
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
    await seedGmgnCredential(radar, tenantId);
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
      const runtime = JSON.parse(state.storage.sql
        .exec('SELECT value_json FROM scheduler_state WHERE tenant_id = ? AND key = ?', tenantId, 'scheduler.runtime.v1')
        .one().value_json);
      expect(key.value_enc).not.toContain('gmgn_');
      expect(tasks).toContainEqual(expect.objectContaining({ id: `scan:${cycleId}`, kind: 'scan' }));
      expect(runtime.eligibility).toEqual({ paused: false, configured: true });
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
    const queueCountBeforeRollback = await runInDurableObject(radar, async (_instance, state) => state.storage.sql
      .exec('SELECT COUNT(*) AS count FROM audit_queue WHERE tenant_id = ?', tenantId).one().count);

    await runInDurableObject(radar, async (_instance, state) => {
      state.storage.sql.exec("CREATE TRIGGER test_abort_recoverable_commit BEFORE INSERT ON audit_queue BEGIN SELECT RAISE(ABORT, 'test rollback'); END");
    });
    await runInDurableObject(radar, async instance => {
      await expect(instance.commitRecoverableClassification({ tenantId, cycleId })).rejects.toThrow('test rollback');
    });
    await runInDurableObject(radar, async (_instance, state) => {
      for (const table of ['candidates', 'risk_exclusions', 'outcomes', 'events', 'outbox']) {
        expect(state.storage.sql.exec(`SELECT COUNT(*) AS count FROM ${table} WHERE tenant_id = ?`, tenantId).one().count).toBe(0);
      }
      expect(state.storage.sql.exec('SELECT COUNT(*) AS count FROM audit_queue WHERE tenant_id = ?', tenantId).one().count)
        .toBe(queueCountBeforeRollback);
    });
    expect((await radar.getRecoverableCycle({ tenantId, cycleId })).phase).toBe('CLASSIFY_AND_COMMIT');

    await runInDurableObject(radar, async (_instance, state) => {
      state.storage.sql.exec('DROP TRIGGER test_abort_recoverable_commit');
    });
    const committed = await radar.commitRecoverableClassification({ tenantId, cycleId });
    const expectedEffectId = stableEffectId(tenantId, cycleId, 'sol', candidateRow(Date.now()).address, 'CANDIDATE_NEW');
    expect(committed.effectId).toBe(expectedEffectId);
    expect(committed.checkpoint.phase).toBe('OUTCOMES_SAMPLE');

    await evictDurableObject(radar);
    expect((await radar.getRecoverableCycle({ tenantId, cycleId })).phase).toBe('OUTCOMES_SAMPLE');
    await runInDurableObject(radar, async (_instance, state) => {
      const candidate = state.storage.sql.exec('SELECT status FROM candidates WHERE tenant_id = ?', tenantId).one();
      const outcome = state.storage.sql.exec('SELECT baseline_at, baseline_price FROM outcomes WHERE tenant_id = ?', tenantId).one();
      const event = state.storage.sql.exec('SELECT id FROM events WHERE tenant_id = ?', tenantId).one();
      const outbox = state.storage.sql.exec('SELECT event_id FROM outbox WHERE tenant_id = ?', tenantId).toArray();
      expect(candidate.status).toBe('X_REVIEW');
      expect(outcome.baseline_at).toBeGreaterThan(0);
      expect(outcome.baseline_price).toBe(1);
      expect(event.id).toBe(expectedEffectId);
      // Domain events no longer bypass the Telegram notification allowlist.
      expect(outbox).toEqual([]);
    });
  });

  it('recovers a request response cursor after eviction without reusing its response timestamp', async () => {
    const tenantId = '19002';
    const cycleId = 'cycle-response';
    const radar = env.RADAR.get(env.RADAR.idFromName(`radar:${tenantId}`));
    const collectedAt = Date.now();
    await radar.replaceSchedulerEligibility({ tenantId, eligibility: { paused: false, configured: true } });
    await radar.beginRecoverableCycle({ tenantId, cycleId, chain: 'sol', keyEpoch: 0, controlEpoch: 0, deadlineAt: collectedAt + 60_000, settings });
    await radar.recordRecoverableScanRequest({ tenantId, cycleId, response: { completed: [] }, collectedAt });
    await evictDurableObject(radar);
    const checkpoint = await radar.getRecoverableCycle({ tenantId, cycleId });
    expect(checkpoint.phase).toBe('DISCOVER');
    expect(checkpoint.endpointIndex).toBe(1);
    expect(checkpoint.partial.discovery.responses.trenches.collectedAt).toBe(collectedAt);
    expect((await radar.nextRecoverableScanRequest({ tenantId, cycleId })).endpoint).toBe('trending');
  });

  it('rebuilds scan admission from a persisted checkpoint after local transitions and eviction', async () => {
    const tenantId = '19004';
    const cycleId = 'cycle-reconcile-admission';
    const radar = env.RADAR.get(env.RADAR.idFromName(`radar:${tenantId}`));
    const now = Date.now();
    await radar.replaceSchedulerEligibility({ tenantId, eligibility: { paused: false, configured: true } });
    await radar.beginRecoverableCycle({ tenantId, cycleId, chain: 'sol', keyEpoch: 0, controlEpoch: 0, deadlineAt: now + 60_000, settings });
    await radar.recordRecoverableScanRequest({ tenantId, cycleId, response: { completed: [candidateRow(now)] }, collectedAt: now });
    await radar.recordRecoverableScanRequest({ tenantId, cycleId, response: { rank: [] }, collectedAt: now + 1 });
    await radar.advanceRecoverableScan({ tenantId, cycleId });
    expect((await radar.getRecoverableCycle({ tenantId, cycleId })).phase).toBe('BUILD_QUEUE');

    await evictDurableObject(radar);
    await radar.wake();
    expect((await radar.getSchedulerSnapshot(tenantId)).tasks).toContainEqual(expect.objectContaining({
      id: `scan:${cycleId}`, needsGmgn: false, gmgnWeight: 1
    }));

    await radar.advanceRecoverableScan({ tenantId, cycleId });
    expect((await radar.getRecoverableCycle({ tenantId, cycleId })).phase).toBe('AUDIT');
    await evictDurableObject(radar);
    await radar.wake();
    expect((await radar.getSchedulerSnapshot(tenantId)).tasks).toContainEqual(expect.objectContaining({
      id: `scan:${cycleId}`, needsGmgn: true, gmgnWeight: 1
    }));
  });

  it('persists unselected audit queue rows and reuses their fairness history in the next cycle', async () => {
    const tenantId = '19005';
    const firstCycleId = 'cycle-queue-first';
    const secondCycleId = 'cycle-queue-second';
    const radar = env.RADAR.get(env.RADAR.idFromName(`radar:${tenantId}`));
    const now = Date.now();
    const second = { ...candidateRow(now), address: 'So11111111111111111111111111111111111111113', symbol: 'SECOND' };
    await radar.replaceSchedulerEligibility({ tenantId, eligibility: { paused: false, configured: true } });
    await radar.beginRecoverableCycle({ tenantId, cycleId: firstCycleId, chain: 'sol', keyEpoch: 0, controlEpoch: 0, deadlineAt: now + 60_000, settings });
    await radar.recordRecoverableScanRequest({ tenantId, cycleId: firstCycleId, response: { completed: [candidateRow(now), second] }, collectedAt: now });
    await radar.recordRecoverableScanRequest({ tenantId, cycleId: firstCycleId, response: { rank: [] }, collectedAt: now + 1 });
    await radar.advanceRecoverableScan({ tenantId, cycleId: firstCycleId });
    const first = await radar.advanceRecoverableScan({ tenantId, cycleId: firstCycleId });
    expect(first.phase).toBe('AUDIT');
    expect(first.partial.queue.rows).toHaveLength(2);
    expect(first.partial.queue.selected).toHaveLength(1);
    const firstSelectedAddress = first.partial.queue.selected[0].address;
    const queueFirstSeenAt = new Map(first.partial.queue.rows.map(row => [row.address, row.firstSeenAt]));

    await evictDurableObject(radar);
    await runInDurableObject(radar, async (_instance, state) => {
      const queue = state.storage.sql
        .exec('SELECT address, first_seen_at, attempts FROM audit_queue WHERE tenant_id = ? ORDER BY address', tenantId).toArray();
      expect(queue).toHaveLength(2);
      expect(queue.every(row => row.first_seen_at === queueFirstSeenAt.get(row.address) && row.attempts === 0)).toBe(true);
    });

    await radar.beginRecoverableCycle({
      tenantId,
      cycleId: secondCycleId,
      chain: 'sol',
      keyEpoch: 0,
      controlEpoch: 0,
      deadlineAt: now + 60_000,
      partial: { scanCount: 4 },
      settings
    });
    await radar.recordRecoverableScanRequest({ tenantId, cycleId: secondCycleId, response: { completed: [candidateRow(now), second] }, collectedAt: now + 2 });
    await radar.recordRecoverableScanRequest({ tenantId, cycleId: secondCycleId, response: { rank: [] }, collectedAt: now + 3 });
    await radar.advanceRecoverableScan({ tenantId, cycleId: secondCycleId });
    const secondCycle = await radar.advanceRecoverableScan({ tenantId, cycleId: secondCycleId });
    expect(secondCycle.phase).toBe('AUDIT');
    expect(secondCycle.partial.queue.selected[0].address).not.toBe(firstSelectedAddress);
  });

  it('keeps prior X_REVIEW and favorite tokens in monitor queue while atomically downgrading adverse discovery', async () => {
    const tenantId = '19006';
    const initialCycleId = 'cycle-monitor-initial';
    const monitoringCycleId = 'cycle-monitor-followup';
    const radar = env.RADAR.get(env.RADAR.idFromName(`radar:${tenantId}`));
    await reachClassification(radar, tenantId, initialCycleId);
    await radar.commitRecoverableClassification({ tenantId, cycleId: initialCycleId });
    const now = Date.now();
    const favoriteAddress = 'So11111111111111111111111111111111111111113';
    await runInDurableObject(radar, async (_instance, state) => {
      state.storage.sql.exec(
        'INSERT INTO annotations (tenant_id, chain, address, favorite, note, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        tenantId, 'sol', favoriteAddress, 1, '', now
      );
    });
    await radar.beginRecoverableCycle({ tenantId, cycleId: monitoringCycleId, chain: 'sol', keyEpoch: 0, controlEpoch: 0, deadlineAt: now + 60_000, settings });
    await radar.recordRecoverableScanRequest({
      tenantId,
      cycleId: monitoringCycleId,
      response: { completed: [{ ...candidateRow(now), market_cap: 1 }] },
      collectedAt: now
    });
    await radar.recordRecoverableScanRequest({ tenantId, cycleId: monitoringCycleId, response: { rank: [] }, collectedAt: now + 1 });
    const screened = await radar.advanceRecoverableScan({ tenantId, cycleId: monitoringCycleId });
    expect(screened.phase).toBe('BUILD_QUEUE');
    expect(screened.partial.monitors.map(row => row.row.address)).toEqual(expect.arrayContaining([
      candidateRow(now).address,
      favoriteAddress
    ]));

    await runInDurableObject(radar, async (_instance, state) => {
      const candidate = state.storage.sql.exec(
        'SELECT status, deep_json, decision_reason FROM candidates WHERE tenant_id = ? AND chain = ? AND address = ?',
        tenantId, 'sol', candidateRow(now).address
      ).one();
      const queue = state.storage.sql.exec(
        'SELECT status FROM audit_queue WHERE tenant_id = ? AND chain = ? AND address = ?',
        tenantId, 'sol', candidateRow(now).address
      ).one();
      expect(candidate.status).toBe('WAIT_RECHECK');
      expect(JSON.parse(candidate.deep_json).chainPass).toBe(false);
      expect(candidate.decision_reason).not.toBe('');
      expect(queue.status).toBe('WAIT_RECHECK');
    });

    const queued = await radar.advanceRecoverableScan({ tenantId, cycleId: monitoringCycleId });
    expect(queued.partial.queue.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ address: candidateRow(now).address, watched: true }),
      expect.objectContaining({ address: favoriteAddress, watched: true })
    ]));
  });

  it('uses canonical EVM lookup keys without changing Solana address case', async () => {
    const tenantId = '19007';
    const radar = env.RADAR.get(env.RADAR.idFromName(`radar:${tenantId}`));
    const evmAddress = `0x${'a'.repeat(40)}`;
    const solAddress = 'So11111111111111111111111111111111111111112';
    await runInDurableObject(radar, async (_instance, state) => {
      state.storage.sql.exec(
        'INSERT INTO candidates (tenant_id, chain, address, status, review_evidence, review_revision) VALUES (?, ?, ?, ?, ?, ?)',
        tenantId, 'bsc', evmAddress, 'X_REVIEW', 'evidence', 'revision'
      );
      state.storage.sql.exec(
        'INSERT INTO candidates (tenant_id, chain, address, status, review_evidence, review_revision) VALUES (?, ?, ?, ?, ?, ?)',
        tenantId, 'sol', solAddress, 'X_REVIEW', 'sol-evidence', 'sol-revision'
      );
      const store = new SqliteRecoverableScannerStore(state.storage, tenantId);
      expect(store.readCandidateReview('bsc', `0x${'A'.repeat(40)}`)).toEqual({
        reviewEvidence: 'evidence', reviewRevision: 'revision', status: 'X_REVIEW'
      });
      expect(store.readCandidateReview('sol', solAddress)).toEqual({
        reviewEvidence: 'sol-evidence', reviewRevision: 'sol-revision', status: 'X_REVIEW'
      });
    });
  });

  it('rolls back domain facts and checkpoint when transactional notification projection fails', async () => {
    const tenantId='19025',cycleId='projection-rollback';
    const radar=env.RADAR.get(env.RADAR.idFromName(`radar:${tenantId}`));
    await reachClassification(radar,tenantId,cycleId);
    await runInDurableObject(radar,async(_instance,{storage})=>{
      const store=new SqliteRecoverableScannerStore(storage,tenantId,{afterClassification:()=>{throw new Error('projection failure');}});
      const scanner=new RecoverableScanner({store,settings});
      await expect(scanner.commitClassification(cycleId)).rejects.toThrow('projection failure');
      expect(storage.sql.exec('SELECT * FROM candidates WHERE tenant_id=?',tenantId).toArray()).toEqual([]);
      expect(storage.sql.exec('SELECT * FROM events WHERE tenant_id=?',tenantId).toArray()).toEqual([]);
      expect(store.read(cycleId).phase).toBe('CLASSIFY_AND_COMMIT');
    });
  });

  it('suppresses repeated cross-cycle notification effects during the legacy deduplication window', async () => {
    const tenantId = '19008';
    const address = candidateRow(Date.now()).address;
    const now = Date.now();
    const radar = env.RADAR.get(env.RADAR.idFromName(`radar:${tenantId}`));
    await radar.replaceSchedulerEligibility({ tenantId, eligibility: { paused: false, configured: true } });
    await runInDurableObject(radar, async (_instance, state) => {
      const store = new SqliteRecoverableScannerStore(state.storage, tenantId);
      for (const [index, cycleId] of ['cycle-event-first', 'cycle-event-repeat'].entries()) {
        state.storage.sql.exec(
          'INSERT INTO cycle_checkpoint (tenant_id, cycle_id, chain, key_epoch, control_epoch, deadline_at, phase, token_index, endpoint_index, partial_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          tenantId, cycleId, 'sol', 0, 0, null, 'CLASSIFY_AND_COMMIT', 0, 0, JSON.stringify({}), now + index
        );
        const result = store.commitClassification({
          expected: { phase: 'CLASSIFY_AND_COMMIT', keyEpoch: 0, controlEpoch: 0 },
          next: {
            cycleId, chain: 'sol', keyEpoch: 0, controlEpoch: 0, deadlineAt: null,
            phase: 'OUTCOMES_SAMPLE', tokenIndex: 1, endpointIndex: 0, partial: {}, updatedAt: now + index
          },
          candidate: { address, chain: 'sol', status: 'X_REVIEW', symbol: 'TEST' },
          auditQueue: { address, status: 'X_REVIEW', attempts: 1 },
          riskExclusion: null,
          outcome: null,
          event: {
            effectType: 'CANDIDATE_NEW', type: 'CANDIDATE_NEW', message: 'new candidate', at: now + index,
            data: { address }
          }
        });
        expect(result.effectId).toBe(index === 0 ? stableEffectId(tenantId, cycleId, 'sol', address, 'CANDIDATE_NEW') : null);
      }
      expect(state.storage.sql.exec('SELECT COUNT(*) AS count FROM events WHERE tenant_id = ?', tenantId).one().count).toBe(1);
      expect(state.storage.sql.exec('SELECT COUNT(*) AS count FROM outbox WHERE tenant_id = ?', tenantId).one().count).toBe(0);
    });
  });

  it('samples a due inactive-chain outcome atomically while another chain finalizes', async () => {
    const tenantId = '19009';
    const cycleId = 'cycle-sol-outcome-sample';
    const address = `0x${'4'.repeat(40)}`;
    const expiredAddress = `0x${'5'.repeat(40)}`;
    const now = Date.now();
    const baselineAt = now - 400_000;
    const radar = env.RADAR.get(env.RADAR.idFromName(`radar:${tenantId}`));
    await radar.replaceSchedulerEligibility({ tenantId, eligibility: { paused: false, configured: true } });
    await runInDurableObject(radar, async (_instance, state) => {
      state.storage.sql.exec(
        'INSERT INTO outcomes (tenant_id, chain, address, initial_decision, latest_decision, baseline_at, baseline_price, last_audited_at, symbol, latest_failed_json, sampling, strategy_version, samples_json, sample_retries_json, cohort_metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        tenantId, 'bsc', address, 'X_REVIEW', 'X_REVIEW', baselineAt, 1, baselineAt, 'BSC', '[]', 'FULL', 'radar-v3', '{}', '{}', '{}'
      );
      state.storage.sql.exec(
        'INSERT INTO outcomes (tenant_id, chain, address, initial_decision, latest_decision, baseline_at, baseline_price, last_audited_at, symbol, latest_failed_json, sampling, strategy_version, samples_json, sample_retries_json, cohort_metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        tenantId, 'bsc', expiredAddress, 'X_REVIEW', 'X_REVIEW', now - settings.outcomeRetentionMs - 400_000, 1,
        now - settings.outcomeRetentionMs - 400_000, 'EXPIRED', '[]', 'FULL', 'radar-v3', '{}', '{}', '{}'
      );
      state.storage.sql.exec(
        'INSERT INTO cycle_checkpoint (tenant_id, cycle_id, chain, key_epoch, control_epoch, deadline_at, phase, token_index, endpoint_index, partial_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        tenantId, cycleId, 'sol', 0, 0, null, 'OUTCOMES_SAMPLE', 0, 0, JSON.stringify({ settings }), now
      );
      const store = new SqliteRecoverableScannerStore(state.storage, tenantId);
      const scanner = new RecoverableScanner({ store, settings, now: () => now });
      scanner.advanceLocal(cycleId);
      expect(scanner.nextRequest(cycleId)).toMatchObject({ kind: 'OUTCOMES_SAMPLE', chain: 'bsc', address });
      scanner.recordOutcomeSample(cycleId, { sample: { price: 2, at: baselineAt + 300_000 }, collectedAt: now });
      const sampled = state.storage.sql.exec(
        'SELECT samples_json FROM outcomes WHERE tenant_id = ? AND chain = ? AND address = ?', tenantId, 'bsc', address
      ).one();
      expect(JSON.parse(sampled.samples_json).m5.price).toBe(2);
      expect(state.storage.sql.exec('SELECT COUNT(*) AS count FROM outcomes WHERE tenant_id = ? AND address = ?', tenantId, expiredAddress).one().count).toBe(0);
      expect(store.read(cycleId).phase).toBe('SUMMARIZE');
    });
  });

  it('prunes stale candidates and caps the per-chain durable candidate projection at finalization', async () => {
    const tenantId = '19010';
    const cycleId = 'cycle-candidate-retention';
    const now = Date.now();
    const radar = env.RADAR.get(env.RADAR.idFromName(`radar:${tenantId}`));
    await radar.replaceSchedulerEligibility({ tenantId, eligibility: { paused: false, configured: true } });
    await runInDurableObject(radar, async (_instance, state) => {
      state.storage.sql.exec(
        'INSERT INTO cycle_checkpoint (tenant_id, cycle_id, chain, key_epoch, control_epoch, deadline_at, phase, token_index, endpoint_index, partial_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        tenantId, cycleId, 'sol', 0, 0, null, 'SUMMARIZE', 0, 0, JSON.stringify({ settings }), now
      );
      state.storage.sql.exec(
        'INSERT INTO candidates (tenant_id, chain, address, status, audited_at, priority_band, discovery_score) VALUES (?, ?, ?, ?, ?, ?, ?)',
        tenantId, 'sol', 'stale-candidate', 'X_REVIEW', now - settings.candidateRetentionMs - 1, 1, 100
      );
      state.storage.sql.exec(
        'INSERT INTO candidates (tenant_id, chain, address, status, audited_at, priority_band, discovery_score) VALUES (?, ?, ?, ?, ?, ?, ?)',
        tenantId, 'sol', 'favorite-candidate', 'X_REVIEW', now - settings.candidateRetentionMs - 1, 1, 1_000
      );
      state.storage.sql.exec(
        'INSERT INTO annotations (tenant_id, chain, address, favorite, note, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        tenantId, 'sol', 'favorite-candidate', 1, '', now
      );
      for (let index = 0; index < 201; index += 1) {
        state.storage.sql.exec(
          'INSERT INTO candidates (tenant_id, chain, address, status, audited_at, priority_band, discovery_score) VALUES (?, ?, ?, ?, ?, ?, ?)',
          tenantId, 'sol', `active-${String(index).padStart(3, '0')}`, 'WAIT_RECHECK', now, 0, index
        );
      }
      const store = new SqliteRecoverableScannerStore(state.storage, tenantId);
      store.commitSummary({
        expected: { phase: 'SUMMARIZE', keyEpoch: 0, controlEpoch: 0 },
        next: {
          cycleId, chain: 'sol', keyEpoch: 0, controlEpoch: 0, deadlineAt: null,
          phase: 'SUMMARIZE', tokenIndex: 0, endpointIndex: 0, partial: { settings, summary: { finalized: true } }, updatedAt: now
        },
        candidateRetentionMs: settings.candidateRetentionMs,
        outcomeRetentionMs: settings.outcomeRetentionMs
      });
      const rows = state.storage.sql.exec('SELECT address FROM candidates WHERE tenant_id = ? AND chain = ?', tenantId, 'sol').toArray();
      expect(rows).toHaveLength(200);
      expect(rows.some(row => row.address === 'stale-candidate')).toBe(false);
      expect(rows.some(row => row.address === 'favorite-candidate')).toBe(true);
    });
  });

  it('keeps only the replay predecessor and successor checkpoints across repeated cycles', async () => {
    const tenantId = '19011';
    const rootCycleId = 'cycle-root';
    const radar = env.RADAR.get(env.RADAR.idFromName(`radar:${tenantId}`));
    await radar.replaceSchedulerEligibility({ tenantId, eligibility: { paused: false, configured: true } });
    await runInDurableObject(radar, async (_instance, state) => {
      const store = new SqliteRecoverableScannerStore(state.storage, tenantId);
      const checkpoint = (cycleId, phase, partial, updatedAt) => ({
        cycleId, chain: 'sol', keyEpoch: 0, controlEpoch: 0, deadlineAt: null,
        phase, tokenIndex: 0, endpointIndex: 0, partial, updatedAt
      });
      store.begin(checkpoint('cycle-root', 'SUMMARIZE', {
        rootCycleId, summary: { finalized: true, nextCycleId: 'cycle-root:cycle:2' }
      }, 1));
      const second = store.begin(checkpoint('cycle-root:cycle:2', 'DISCOVER', { rootCycleId }, 2));
      store.advance({
        expected: { phase: 'DISCOVER', keyEpoch: 0, controlEpoch: 0 },
        next: checkpoint('cycle-root:cycle:2', 'SUMMARIZE', {
          rootCycleId, summary: { finalized: true, nextCycleId: 'cycle-root:cycle:3' }
        }, 3)
      });
      const third = store.begin(checkpoint('cycle-root:cycle:3', 'DISCOVER', { rootCycleId }, 4));
      const replay = store.begin(checkpoint('cycle-root:cycle:3', 'DISCOVER', { rootCycleId }, 4));

      expect(store.read('cycle-root')).toBeNull();
      expect(store.read(second.cycleId)).toMatchObject({ phase: 'SUMMARIZE' });
      expect(replay).toEqual(third);
      expect(state.storage.sql.exec('SELECT COUNT(*) AS count FROM cycle_checkpoint WHERE tenant_id = ?', tenantId).one().count).toBe(2);
    });
  });
});
