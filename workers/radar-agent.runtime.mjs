import { env } from 'cloudflare:workers';
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { AVE_CU, AveClient } from '../src/providers/ave.mjs';
import { SecondaryValidator } from '../src/providers/secondary.mjs';
import { RecoverableScanner } from '../src/recoverable-scanner.mjs';
import { scannerSettings } from '../src/scanner-settings.mjs';
import { SqliteRecoverableScannerStore, stableEffectId } from '../src/storage/recoverable-scanner.mjs';
import { encryptSecret } from '../src/util/crypto.mjs';

const settings = Object.freeze({
  ...scannerSettings,
  scanIntervalMs: 120_000,
  auditCycleBudgetMs: 80_000,
  maxSecondaryChecksPerCycle: 1,
  outcomeReadsPerCycle: 4
});
const apiKey = 'ave-radar-agent-key-0001';
const LEAD = `0x${'1'.repeat(40)}`;
const SECOND = `0x${'2'.repeat(40)}`;

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

/** One raw AVE trending token that passes the AVE market screen unless overridden. */
function arcToken(address, overrides = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    token: address, chain: 'arc', symbol: `T${address.slice(-4)}`, name: 'Arc test token', current_price_usd: '0.5',
    market_cap: '50000', main_pair_tvl: '12000', token_tx_volume_usd_5m: '800', updated_at: nowSec - 1, launch_at: nowSec - 600,
    ...overrides
  };
}

/** The scanner's DISCOVER value exactly as AveClient.trending parses a stubbed AVE response. */
async function trending(tokens) {
  const client = new AveClient({ apiKey, fetchImpl: async () => jsonResponse({ status: 1, data: { tokens } }) });
  return client.trending('arc');
}

/** The scanner's SECONDARY values as the validator parses stubbed DexScreener and GoPlus responses. */
async function secondaryValues(address, { honeypot }) {
  const validator = new SecondaryValidator({ fetchImpl: async url => String(url).includes('gopluslabs')
    ? jsonResponse({ code: 1, result: { [address]: { is_honeypot: honeypot ? '1' : '0' } } })
    : jsonResponse([]) });
  return {
    dexScreener: await validator.fetchSource({ source: 'dexScreener', chain: 'arc', tokenAddress: address }),
    goPlus: await validator.fetchSource({ source: 'goPlus', chain: 'arc', tokenAddress: address })
  };
}

async function configuredRadar(tenantId) {
  const radar = env.RADAR.get(env.RADAR.idFromName(`radar:${tenantId}`));
  await radar.replaceSchedulerEligibility({ tenantId, eligibility: { paused: false, configured: true } });
  await radar.selectScanChain({ tenantId, chain: 'arc' });
  return radar;
}

async function beginCycle(radar, tenantId, cycleId, extra = {}) {
  const { control } = await radar.getStatus(tenantId);
  return radar.beginRecoverableCycle({
    tenantId, cycleId, chain: 'arc', keyEpoch: control.keyEpoch, controlEpoch: control.controlEpoch,
    deadlineAt: Date.now() + 60_000, settings, ...extra
  });
}

async function seedAveCredential(radar, tenantId) {
  await runInDurableObject(radar, async (_instance, state) => {
    const envelope = await encryptSecret(env.MASTER_ENC_KEY, tenantId, 'ave-api-key', apiKey);
    state.storage.sql.exec('INSERT INTO keys (tenant_id, name, value_enc, generation, created_at) VALUES (?, ?, ?, ?, ?)', tenantId, 'ave-api-key', envelope, 0, Date.now());
  });
}

/** Screen one passing lead and record its secondary checks, stopping at CLASSIFY_AND_COMMIT. */
async function reachClassification(radar, tenantId, cycleId, { honeypot = false } = {}) {
  await beginCycle(radar, tenantId, cycleId);
  await radar.recordRecoverableScanRequest({ tenantId, cycleId, response: await trending([arcToken(LEAD)]), collectedAt: Date.now() });
  expect((await radar.advanceRecoverableScan({ tenantId, cycleId })).phase).toBe('BUILD_QUEUE');
  expect((await radar.advanceRecoverableScan({ tenantId, cycleId })).phase).toBe('SECONDARY');
  const secondary = await secondaryValues(LEAD, { honeypot });
  await radar.recordRecoverableScanRequest({ tenantId, cycleId, response: secondary.dexScreener, collectedAt: Date.now() });
  await radar.recordRecoverableScanRequest({ tenantId, cycleId, response: secondary.goPlus, collectedAt: Date.now() });
  expect((await radar.getRecoverableCycle({ tenantId, cycleId })).phase).toBe('CLASSIFY_AND_COMMIT');
}

function count(storage, table, tenantId) {
  return storage.sql.exec(`SELECT COUNT(*) AS count FROM ${table} WHERE tenant_id = ?`, tenantId).one().count;
}

describe('recoverable Radar scanner', () => {
  it('persists an encrypted AVE credential and a trending-cost scan task before alarm rearm or eviction', async () => {
    const tenantId = '19000';
    const cycleId = 'cycle-scheduled';
    const radar = await configuredRadar(tenantId);
    await seedAveCredential(radar, tenantId);
    const checkpoint = await beginCycle(radar, tenantId, cycleId);
    expect(checkpoint.phase).toBe('DISCOVER');
    await runInDurableObject(radar, async (_instance, state) => {
      const key = state.storage.sql.exec('SELECT value_enc FROM keys WHERE tenant_id = ? AND name = ?', tenantId, 'ave-api-key').one();
      const tasks = JSON.parse(state.storage.sql
        .exec('SELECT value_json FROM scheduler_state WHERE tenant_id = ? AND key = ?', tenantId, 'scheduler.tasks.v1')
        .one().value_json).tasks;
      expect(key.value_enc).not.toContain(apiKey);
      expect(tasks).toContainEqual(expect.objectContaining({ id: `scan:${cycleId}`, kind: 'scan', aveCost: AVE_CU.trending }));
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
    await evictDurableObject(radar);
    expect((await radar.getRecoverableCycle({ tenantId, cycleId })).phase).toBe('DISCOVER');
  });

  it('rearms a recoverable scan after a missing credential without moving its request cursor', async () => {
    const tenantId = '19003';
    const cycleId = 'cycle-missing-credential';
    const radar = await configuredRadar(tenantId);
    await beginCycle(radar, tenantId, cycleId);
    await runInDurableObject(radar, async (_instance, state) => {
      const taskState = JSON.parse(state.storage.sql
        .exec('SELECT value_json FROM scheduler_state WHERE tenant_id = ? AND key = ?', tenantId, 'scheduler.tasks.v1')
        .one().value_json);
      taskState.tasks[0].dueAt = Date.now() - 1;
      state.storage.sql.exec('UPDATE scheduler_state SET value_json = ? WHERE tenant_id = ? AND key = ?', JSON.stringify(taskState), tenantId, 'scheduler.tasks.v1');
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    expect(await runDurableObjectAlarm(radar)).toBe(true);
    await runInDurableObject(radar, async (_instance, state) => {
      const runtime = JSON.parse(state.storage.sql
        .exec('SELECT value_json FROM scheduler_state WHERE tenant_id = ? AND key = ?', tenantId, 'scheduler.runtime.v1')
        .one().value_json);
      expect(runtime.retries[`scan:${cycleId}`]).toMatchObject({ attempts: 1, lastErrorCode: 'AVE_CREDENTIAL_MISSING' });
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
    expect(await radar.getRecoverableCycle({ tenantId, cycleId })).toMatchObject({ phase: 'DISCOVER', endpointIndex: 0 });
  });

  it('turns every passing trending token into a lead with a new-lead event, outcome baseline and feed snapshot', async () => {
    const tenantId = '19012';
    const cycleId = 'cycle-screen';
    const radar = await configuredRadar(tenantId);
    await beginCycle(radar, tenantId, cycleId);
    const response = await trending([arcToken(LEAD), arcToken(SECOND, { market_cap: '1000' })]);
    await radar.recordRecoverableScanRequest({ tenantId, cycleId, response, collectedAt: Date.now() });
    const screened = await radar.advanceRecoverableScan({ tenantId, cycleId });
    expect(screened.phase).toBe('BUILD_QUEUE');
    expect(screened.partial.leads.map(lead => lead.row.address)).toEqual([LEAD]);
    await runInDurableObject(radar, async (_instance, state) => {
      const leads = state.storage.sql.exec('SELECT address, status, review_revision, ave_url FROM candidates WHERE tenant_id = ?', tenantId).toArray();
      expect(leads).toEqual([{ address: LEAD, status: 'LIVE_READY', review_revision: expect.stringMatching(/^lead-arc-/), ave_url: null }]);
      expect(state.storage.sql.exec('SELECT id, type, address FROM events WHERE tenant_id = ?', tenantId).toArray())
        .toEqual([{ id: stableEffectId(tenantId, cycleId, 'arc', LEAD, 'CANDIDATE_NEW'), type: 'CANDIDATE_NEW', address: LEAD }]);
      expect(state.storage.sql.exec('SELECT address, initial_decision, baseline_price FROM outcomes WHERE tenant_id = ?', tenantId).toArray())
        .toEqual([{ address: LEAD, initial_decision: 'LIVE_READY', baseline_price: 0.5 }]);
      const feed = JSON.parse(state.storage.sql.exec('SELECT value_json FROM scheduler_state WHERE tenant_id = ? AND key = ?', tenantId, 'feed.snapshot:arc').one().value_json);
      expect(feed).toMatchObject({ status: 'READY', receivedCount: 2, leadCount: 1, observedAt: response.capturedAt });
      expect(feed.rows.map(row => [row.address, row.pass])).toEqual([[LEAD, true], [SECOND, false]]);
    });
  });

  it.each([
    ['vetoes a lead on a GoPlus fatal finding', true],
    ['keeps a lead and its revision when GoPlus finds nothing fatal', false]
  ])('rolls back a failed classification commit, then %s durably across eviction', async (_name, honeypot) => {
    const tenantId = honeypot ? '19001' : '19013';
    const cycleId = 'cycle-atomic';
    const radar = await configuredRadar(tenantId);
    await reachClassification(radar, tenantId, cycleId, { honeypot });
    const before = await runInDurableObject(radar, async (_instance, state) => ({
      lead: state.storage.sql.exec('SELECT status, review_revision, secondary_json FROM candidates WHERE tenant_id = ?', tenantId).one(),
      queue: count(state.storage, 'audit_queue', tenantId)
    }));
    expect(before.lead).toMatchObject({ status: 'LIVE_READY', secondary_json: 'null' });

    await runInDurableObject(radar, async (_instance, state) => {
      state.storage.sql.exec("CREATE TRIGGER test_abort_recoverable_commit BEFORE INSERT ON audit_queue BEGIN SELECT RAISE(ABORT, 'test rollback'); END");
    });
    await runInDurableObject(radar, async instance => {
      await expect(instance.commitRecoverableClassification({ tenantId, cycleId })).rejects.toThrow('test rollback');
    });
    await runInDurableObject(radar, async (_instance, state) => {
      expect(state.storage.sql.exec('SELECT status, review_revision, secondary_json FROM candidates WHERE tenant_id = ?', tenantId).one()).toEqual(before.lead);
      expect(state.storage.sql.exec('SELECT type FROM events WHERE tenant_id = ?', tenantId).toArray()).toEqual([{ type: 'CANDIDATE_NEW' }]);
      expect(count(state.storage, 'audit_queue', tenantId)).toBe(before.queue);
      state.storage.sql.exec('DROP TRIGGER test_abort_recoverable_commit');
    });
    expect((await radar.getRecoverableCycle({ tenantId, cycleId })).phase).toBe('CLASSIFY_AND_COMMIT');

    const committed = await radar.commitRecoverableClassification({ tenantId, cycleId });
    expect(committed.effectId).toBe(honeypot ? stableEffectId(tenantId, cycleId, 'arc', LEAD, 'RISK_WORSENED') : null);
    expect(committed.checkpoint.phase).toBe('OUTCOMES_SAMPLE');

    await evictDurableObject(radar);
    expect((await radar.getRecoverableCycle({ tenantId, cycleId })).phase).toBe('OUTCOMES_SAMPLE');
    await runInDurableObject(radar, async (_instance, state) => {
      const candidate = state.storage.sql.exec('SELECT status, review_revision, secondary_json FROM candidates WHERE tenant_id = ?', tenantId).one();
      expect(JSON.parse(candidate.secondary_json).sources.goPlus.status).toBe('OK');
      if (honeypot) {
        expect(candidate.status).toBe('HARD_REJECT');
        expect(candidate.review_revision).not.toBe(before.lead.review_revision);
      } else {
        expect(candidate).toMatchObject({ status: 'LIVE_READY', review_revision: before.lead.review_revision });
      }
      expect(state.storage.sql.exec('SELECT latest_decision FROM outcomes WHERE tenant_id = ?', tenantId).one().latest_decision)
        .toBe(honeypot ? 'HARD_REJECT' : 'LIVE_READY');
      expect(state.storage.sql.exec('SELECT type FROM events WHERE tenant_id = ? ORDER BY at, type', tenantId).toArray().map(row => row.type))
        .toEqual(honeypot ? ['CANDIDATE_NEW', 'RISK_WORSENED'] : ['CANDIDATE_NEW']);
      // Domain events never bypass the Telegram notification allowlist.
      expect(count(state.storage, 'outbox', tenantId)).toBe(0);
    });
  });

  it('recovers a recorded trending response after eviction without reusing its response timestamp', async () => {
    const tenantId = '19002';
    const cycleId = 'cycle-response';
    const radar = await configuredRadar(tenantId);
    const collectedAt = Date.now();
    await beginCycle(radar, tenantId, cycleId);
    await radar.recordRecoverableScanRequest({ tenantId, cycleId, response: { rows: [], capturedAt: collectedAt }, collectedAt });
    await evictDurableObject(radar);
    const checkpoint = await radar.getRecoverableCycle({ tenantId, cycleId });
    expect(checkpoint).toMatchObject({ phase: 'SCREEN', endpointIndex: 0, updatedAt: collectedAt });
    expect(checkpoint.partial.discovery.responses.trending.collectedAt).toBe(collectedAt);
    expect(await radar.nextRecoverableScanRequest({ tenantId, cycleId })).toBeNull();
  });

  it('rebuilds the scan task AVE cost from the persisted checkpoint after local transitions and eviction', async () => {
    const tenantId = '19004';
    const cycleId = 'cycle-reconcile-admission';
    const radar = await configuredRadar(tenantId);
    await beginCycle(radar, tenantId, cycleId);
    const scanTask = async () => (await radar.getSchedulerSnapshot(tenantId)).tasks.find(task => task.id === `scan:${cycleId}`);
    expect((await scanTask()).aveCost).toBe(AVE_CU.trending);
    await radar.recordRecoverableScanRequest({ tenantId, cycleId, response: { rows: [], capturedAt: Date.now() }, collectedAt: Date.now() });

    await evictDurableObject(radar);
    await radar.wake();
    expect((await scanTask()).aveCost).toBe(0);

    await runInDurableObject(radar, async (_instance, state) => {
      const partial = { settings, rootCycleId: cycleId, outcomeDeadlineAt: Date.now() + 60_000,
        outcomes: { job: { chain: 'arc', address: LEAD, key: 'm5', targetAt: Date.now() - 60_000 } } };
      state.storage.sql.exec(
        'INSERT INTO outcomes (tenant_id, chain, address, initial_decision, latest_decision, baseline_at, baseline_price, last_audited_at, symbol, latest_failed_json, sampling, strategy_version, samples_json, sample_retries_json, cohort_metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        tenantId, 'arc', LEAD, 'LIVE_READY', 'LIVE_READY', Date.now() - 360_000, 1, Date.now(), 'LEAD', '[]', 'ALL_LEADS', 'ave-leads-v1', '{}', '{}', '{"baselineProvider":"AVE"}'
      );
      state.storage.sql.exec('UPDATE cycle_checkpoint SET phase = ?, partial_json = ? WHERE tenant_id = ? AND cycle_id = ?', 'OUTCOMES_SAMPLE', JSON.stringify(partial), tenantId, cycleId);
    });
    await evictDurableObject(radar);
    await radar.wake();
    expect((await scanTask()).aveCost).toBe(AVE_CU.klines);
  });

  it('persists unselected secondary queue rows and reuses their fairness history in the next cycle', async () => {
    const tenantId = '19005';
    const radar = await configuredRadar(tenantId);
    const tokens = () => [arcToken(LEAD), arcToken(SECOND)];
    await beginCycle(radar, tenantId, 'cycle-queue-first');
    await radar.recordRecoverableScanRequest({ tenantId, cycleId: 'cycle-queue-first', response: await trending(tokens()), collectedAt: Date.now() });
    await radar.advanceRecoverableScan({ tenantId, cycleId: 'cycle-queue-first' });
    const first = await radar.advanceRecoverableScan({ tenantId, cycleId: 'cycle-queue-first' });
    expect(first.phase).toBe('SECONDARY');
    expect(first.partial.queue.selected).toHaveLength(1);
    const firstSelectedAddress = first.partial.queue.selected[0].address;

    await evictDurableObject(radar);
    const firstSeen = await runInDurableObject(radar, async (_instance, state) => {
      const queue = state.storage.sql.exec('SELECT address, first_seen_at, attempts FROM audit_queue WHERE tenant_id = ? ORDER BY address', tenantId).toArray();
      expect(queue.map(row => [row.address, row.attempts])).toEqual([[LEAD, 0], [SECOND, 0]]);
      return new Map(queue.map(row => [row.address, row.first_seen_at]));
    });

    await beginCycle(radar, tenantId, 'cycle-queue-second', { partial: { scanCount: 4 } });
    await radar.recordRecoverableScanRequest({ tenantId, cycleId: 'cycle-queue-second', response: await trending(tokens()), collectedAt: Date.now() });
    await radar.advanceRecoverableScan({ tenantId, cycleId: 'cycle-queue-second' });
    const second = await radar.advanceRecoverableScan({ tenantId, cycleId: 'cycle-queue-second' });
    expect(second.phase).toBe('SECONDARY');
    expect(second.partial.queue.selected[0].address).not.toBe(firstSelectedAddress);
    await runInDurableObject(radar, async (_instance, state) => {
      const queue = state.storage.sql.exec('SELECT address, first_seen_at FROM audit_queue WHERE tenant_id = ?', tenantId).toArray();
      expect(queue.every(row => row.first_seen_at === firstSeen.get(row.address))).toBe(true);
    });
  });

  it.each([
    ['firstSeenAt', 2, 'first_seen_at', 2], ['lastSeenAt', 20, 'last_seen_at', 20], ['lastAuditedAt', 30, 'last_audited_at', 30],
    ['nextAuditAt', 40, 'next_audit_at', 40], ['attempts', 3, 'attempts', 3], ['status', 'AUDITED', 'status', 'AUDITED'],
    ['priorityBand', true, 'priority_band', 1], ['score', 2.5, 'score', 2.5], ['watched', true, 'watched', 1],
    ['details', { reason: 'changed' }, 'details_json', '{"reason":"changed"}']
  ])('a queue commit that changes only %s updates the stored row', async (field, value, column, stored) => {
    const tenantId = '19014';
    const radar = await configuredRadar(tenantId);
    const checkpoint = await beginCycle(radar, tenantId, `cycle-queue-column-${field}`);
    await runInDurableObject(radar, async (_instance, state) => {
      const store = new SqliteRecoverableScannerStore(state.storage, tenantId);
      const base = { address: LEAD, firstSeenAt: 1, lastSeenAt: 10, lastAuditedAt: 0, nextAuditAt: 0, attempts: 0, status: 'QUEUED', priorityBand: false, score: 1, watched: false, details: {} };
      store.commitQueue({ expected: {}, auditQueue: [base], next: { ...checkpoint, updatedAt: checkpoint.updatedAt + 1 } });
      store.commitQueue({ expected: {}, auditQueue: [{ ...base, [field]: value }], next: { ...checkpoint, updatedAt: checkpoint.updatedAt + 2 } });
      expect(state.storage.sql.exec(`SELECT ${column} AS value FROM audit_queue WHERE tenant_id = ? AND address = ?`, tenantId, LEAD).one().value).toEqual(stored);
    });
  });

  it('commits a queue as exactly the chain\'s audit queue, writing only its changed and new rows', async () => {
    const tenantId = '19006';
    const cycleId = 'cycle-queue-exact';
    const radar = await configuredRadar(tenantId);
    const checkpoint = await beginCycle(radar, tenantId, cycleId);
    const THIRD = `0x${'3'.repeat(40)}`;
    await runInDurableObject(radar, async (_instance, state) => {
      const store = new SqliteRecoverableScannerStore(state.storage, tenantId);
      const row = (address, lastSeenAt) => ({ address, firstSeenAt: 1, lastSeenAt, lastAuditedAt: 0, nextAuditAt: 0, attempts: 0, status: 'QUEUED', priorityBand: false, score: 1, watched: false });
      const commit = (auditQueue, updatedAt) => store.commitQueue({ expected: {}, auditQueue, next: { ...checkpoint, updatedAt } });
      const queue = () => state.storage.sql.exec('SELECT chain, address, last_seen_at FROM audit_queue WHERE tenant_id = ? ORDER BY chain, address', tenantId).toArray();
      state.storage.sql.exec("INSERT INTO audit_queue (tenant_id, chain, address, last_seen_at) VALUES (?, 'bsc', ?, 5)", tenantId, LEAD);
      commit([row(LEAD, 10), row(SECOND, 10)], 10);

      const rowsWritten = [];
      const exec = state.storage.sql.exec;
      state.storage.sql.exec = function (query, ...args) {
        const cursor = exec.call(this, query, ...args);
        if (/audit_queue/.test(query)) rowsWritten.push(cursor);
        return cursor;
      };
      try {
        commit([row(LEAD, 10), row(THIRD, 20)], 20);
      } finally {
        state.storage.sql.exec = exec;
      }
      expect(queue()).toEqual([
        { chain: 'arc', address: LEAD, last_seen_at: 10 }, { chain: 'arc', address: THIRD, last_seen_at: 20 },
        { chain: 'bsc', address: LEAD, last_seen_at: 5 }
      ]);
      // Deleting the dropped row writes one row and inserting the new one two (row and key); the unchanged row writes none.
      expect(rowsWritten.reduce((sum, cursor) => sum + cursor.rowsWritten, 0)).toBe(3);
      expect(() => commit([row(LEAD, 30), row(LEAD, 30)], 30)).toThrow('audit queue addresses must be unique');
      expect(queue()).toHaveLength(3);
    });
  });

  it('eliminates a lead that now fails the AVE screen and keeps a lead missing from one hot list', async () => {
    const tenantId = '19006';
    const radar = await configuredRadar(tenantId);
    await beginCycle(radar, tenantId, 'cycle-leads');
    await radar.recordRecoverableScanRequest({ tenantId, cycleId: 'cycle-leads', response: await trending([arcToken(LEAD), arcToken(SECOND)]), collectedAt: Date.now() });
    await radar.advanceRecoverableScan({ tenantId, cycleId: 'cycle-leads' });
    const revisions = await runInDurableObject(radar, async (_instance, state) => new Map(state.storage.sql
      .exec('SELECT address, review_revision FROM candidates WHERE tenant_id = ?', tenantId).toArray().map(row => [row.address, row.review_revision])));
    expect([...revisions.keys()].sort()).toEqual([LEAD, SECOND]);

    await beginCycle(radar, tenantId, 'cycle-followup');
    await radar.recordRecoverableScanRequest({ tenantId, cycleId: 'cycle-followup', response: await trending([arcToken(LEAD, { market_cap: '1' })]), collectedAt: Date.now() });
    const screened = await radar.advanceRecoverableScan({ tenantId, cycleId: 'cycle-followup' });
    expect(screened.partial.leads).toEqual([]);
    await runInDurableObject(radar, async (_instance, state) => {
      expect(state.storage.sql.exec('SELECT address, status, review_revision FROM candidates WHERE tenant_id = ?', tenantId).toArray())
        .toEqual([{ address: SECOND, status: 'LIVE_READY', review_revision: revisions.get(SECOND) }]);
      expect(state.storage.sql.exec('SELECT COUNT(*) AS count FROM events WHERE tenant_id = ? AND type = ?', tenantId, 'CANDIDATE_NEW').one().count).toBe(2);
    });
  });

  it('uses canonical lower-case EVM lookup keys', async () => {
    const tenantId = '19007';
    const radar = env.RADAR.get(env.RADAR.idFromName(`radar:${tenantId}`));
    const evmAddress = `0x${'a'.repeat(40)}`;
    await runInDurableObject(radar, async (_instance, state) => {
      state.storage.sql.exec("INSERT INTO candidates (tenant_id, chain, address, status, review_evidence, review_revision, info_json, deep_json, secondary_json, social_json, audit_health_json, metadata_json) VALUES (?, ?, ?, ?, ?, ?, '{}', '{}', 'null', '{}', '{}', '{}')",
        tenantId, 'bsc', evmAddress, 'LIVE_READY', 'revision-evidence', 'revision');
      const store = new SqliteRecoverableScannerStore(state.storage, tenantId);
      expect(store.readCandidate('bsc', `0x${'A'.repeat(40)}`)).toMatchObject({ address: evmAddress, reviewRevision: 'revision', status: 'LIVE_READY' });
    });
  });

  it('rolls back domain facts and checkpoint when transactional notification projection fails', async () => {
    const tenantId = '19025';
    const cycleId = 'projection-rollback';
    const radar = await configuredRadar(tenantId);
    await reachClassification(radar, tenantId, cycleId, { honeypot: true });
    await runInDurableObject(radar, async (_instance, { storage }) => {
      const before = storage.sql.exec('SELECT status, review_revision FROM candidates WHERE tenant_id = ?', tenantId).toArray();
      const store = new SqliteRecoverableScannerStore(storage, tenantId, { afterClassification: () => { throw new Error('projection failure'); } });
      const scanner = new RecoverableScanner({ store, settings });
      await expect(scanner.commitClassification(cycleId)).rejects.toThrow('projection failure');
      expect(storage.sql.exec('SELECT status, review_revision FROM candidates WHERE tenant_id = ?', tenantId).toArray()).toEqual(before);
      expect(storage.sql.exec('SELECT type FROM events WHERE tenant_id = ?', tenantId).toArray()).toEqual([{ type: 'CANDIDATE_NEW' }]);
      expect(store.read(cycleId).phase).toBe('CLASSIFY_AND_COMMIT');
    });
  });

  it('suppresses repeated cross-cycle notification effects during the deduplication window', async () => {
    const tenantId = '19008';
    const now = Date.now();
    const radar = await configuredRadar(tenantId);
    const { control } = await radar.getStatus(tenantId);
    await runInDurableObject(radar, async (_instance, state) => {
      const store = new SqliteRecoverableScannerStore(state.storage, tenantId);
      for (const [index, cycleId] of ['cycle-event-first', 'cycle-event-repeat'].entries()) {
        state.storage.sql.exec(
          'INSERT INTO cycle_checkpoint (tenant_id, cycle_id, chain, key_epoch, control_epoch, deadline_at, phase, token_index, endpoint_index, partial_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          tenantId, cycleId, 'arc', control.keyEpoch, control.controlEpoch, null, 'CLASSIFY_AND_COMMIT', 0, 0, JSON.stringify({}), now + index
        );
        const result = store.commitClassification({
          expected: { phase: 'CLASSIFY_AND_COMMIT', keyEpoch: control.keyEpoch, controlEpoch: control.controlEpoch },
          next: {
            cycleId, chain: 'arc', keyEpoch: control.keyEpoch, controlEpoch: control.controlEpoch, deadlineAt: null,
            phase: 'OUTCOMES_SAMPLE', tokenIndex: 1, endpointIndex: 0, partial: {}, updatedAt: now + index
          },
          candidate: { address: LEAD, chain: 'arc', status: 'HARD_REJECT', symbol: 'TEST' },
          auditQueue: { address: LEAD, status: 'HARD_REJECT', attempts: 1 },
          outcome: null,
          event: { effectType: 'RISK_WORSENED', type: 'RISK_WORSENED', message: 'vetoed', at: now + index, data: { address: LEAD } },
          sourceHealth: { lastSecondary: { complete: false, checkedAt: now + index, sources: {} } }
        });
        expect(result.effectId).toBe(index === 0 ? stableEffectId(tenantId, cycleId, 'arc', LEAD, 'RISK_WORSENED') : null);
      }
      expect(count(state.storage, 'events', tenantId)).toBe(1);
      expect(count(state.storage, 'outbox', tenantId)).toBe(0);
    });
  });

  it('samples a due outcome of a previously scanned chain atomically and prunes expired outcomes', async () => {
    const tenantId = '19009';
    const cycleId = 'cycle-outcome-sample';
    const address = `0x${'4'.repeat(40)}`;
    const expiredAddress = `0x${'5'.repeat(40)}`;
    const now = Date.now();
    const baselineAt = now - 400_000;
    const radar = await configuredRadar(tenantId);
    const { control } = await radar.getStatus(tenantId);
    await runInDurableObject(radar, async (_instance, state) => {
      const insertOutcome = (row, at) => state.storage.sql.exec(
        'INSERT INTO outcomes (tenant_id, chain, address, initial_decision, latest_decision, baseline_at, baseline_price, last_audited_at, symbol, latest_failed_json, sampling, strategy_version, samples_json, sample_retries_json, cohort_metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        tenantId, 'bsc', row, 'LIVE_READY', 'LIVE_READY', at, 1, at, 'BSC', '[]', 'ALL_LEADS', 'ave-leads-v1', '{}', '{}', '{"baselineProvider":"AVE"}'
      );
      insertOutcome(address, baselineAt);
      insertOutcome(expiredAddress, now - settings.outcomeRetentionMs - 400_000);
      state.storage.sql.exec(
        'INSERT INTO cycle_checkpoint (tenant_id, cycle_id, chain, key_epoch, control_epoch, deadline_at, phase, token_index, endpoint_index, partial_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        tenantId, cycleId, 'arc', control.keyEpoch, control.controlEpoch, null, 'OUTCOMES_SAMPLE', 0, 0, JSON.stringify({ settings }), now
      );
      const store = new SqliteRecoverableScannerStore(state.storage, tenantId);
      const scanner = new RecoverableScanner({ store, settings, now: () => now });
      scanner.advanceLocal(cycleId);
      expect(scanner.nextRequest(cycleId)).toMatchObject({ kind: 'OUTCOMES_SAMPLE', chain: 'bsc', address, key: 'm5' });
      scanner.recordOutcomeSample(cycleId, { sample: { price: 2, at: baselineAt + 300_000 }, collectedAt: now });
      const sampled = state.storage.sql.exec('SELECT samples_json FROM outcomes WHERE tenant_id = ? AND address = ?', tenantId, address).one();
      expect(JSON.parse(sampled.samples_json).m5).toMatchObject({ price: 2, return: 1 });
      expect(state.storage.sql.exec('SELECT COUNT(*) AS count FROM outcomes WHERE tenant_id = ? AND address = ?', tenantId, expiredAddress).one().count).toBe(0);
      expect(store.read(cycleId).phase).toBe('SUMMARIZE');
    });
  });

  it('prunes stale candidates and expired leads and caps the per-chain candidate projection at finalization', async () => {
    const tenantId = '19010';
    const cycleId = 'cycle-candidate-retention';
    const now = Date.now();
    const radar = await configuredRadar(tenantId);
    const { control } = await radar.getStatus(tenantId);
    await runInDurableObject(radar, async (_instance, state) => {
      const insert = (address, status, auditedAt, priorityBand, score, staleAt = null) => state.storage.sql.exec(
        'INSERT INTO candidates (tenant_id, chain, address, status, audited_at, stale_at, priority_band, discovery_score) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        tenantId, 'arc', address, status, auditedAt, staleAt, priorityBand, score
      );
      state.storage.sql.exec(
        'INSERT INTO cycle_checkpoint (tenant_id, cycle_id, chain, key_epoch, control_epoch, deadline_at, phase, token_index, endpoint_index, partial_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        tenantId, cycleId, 'arc', control.keyEpoch, control.controlEpoch, null, 'SUMMARIZE', 0, 0, JSON.stringify({ settings }), now
      );
      insert('stale-candidate', 'X_REVIEW', now - settings.candidateRetentionMs - 1, 1, 100);
      insert('favorite-candidate', 'X_REVIEW', now - settings.candidateRetentionMs - 1, 1, 1_000);
      insert('expired-lead', 'LIVE_READY', now, 1, 1_000, now - 1);
      state.storage.sql.exec('INSERT INTO annotations (tenant_id, chain, address, favorite, note, updated_at) VALUES (?, ?, ?, ?, ?, ?)', tenantId, 'arc', 'favorite-candidate', 1, '', now);
      for (let index = 0; index < 201; index += 1) insert(`active-${String(index).padStart(3, '0')}`, 'WAIT_RECHECK', now, 0, index);
      const store = new SqliteRecoverableScannerStore(state.storage, tenantId);
      store.commitSummary({
        expected: { phase: 'SUMMARIZE', keyEpoch: control.keyEpoch, controlEpoch: control.controlEpoch },
        next: {
          cycleId, chain: 'arc', keyEpoch: control.keyEpoch, controlEpoch: control.controlEpoch, deadlineAt: null,
          phase: 'SUMMARIZE', tokenIndex: 0, endpointIndex: 0, partial: { settings, summary: { finalized: true } }, updatedAt: now
        },
        candidateRetentionMs: settings.candidateRetentionMs,
        outcomeRetentionMs: settings.outcomeRetentionMs
      });
      const rows = state.storage.sql.exec('SELECT address FROM candidates WHERE tenant_id = ? AND chain = ?', tenantId, 'arc').toArray().map(row => row.address);
      expect(rows).toHaveLength(200);
      expect(rows).not.toContain('stale-candidate');
      expect(rows).not.toContain('expired-lead');
      expect(rows).toContain('favorite-candidate');
    });
  });

  it('keeps only the replay predecessor and successor checkpoints across repeated cycles', async () => {
    const tenantId = '19011';
    const rootCycleId = 'cycle-root';
    const radar = await configuredRadar(tenantId);
    const { control } = await radar.getStatus(tenantId);
    await runInDurableObject(radar, async (_instance, state) => {
      const store = new SqliteRecoverableScannerStore(state.storage, tenantId);
      const checkpoint = (cycleId, phase, partial, updatedAt) => ({
        cycleId, chain: 'arc', keyEpoch: control.keyEpoch, controlEpoch: control.controlEpoch, deadlineAt: null,
        phase, tokenIndex: 0, endpointIndex: 0, partial, updatedAt
      });
      store.begin(checkpoint('cycle-root', 'SUMMARIZE', { rootCycleId, summary: { finalized: true, nextCycleId: 'cycle-root:cycle:2' } }, 1));
      const second = store.begin(checkpoint('cycle-root:cycle:2', 'DISCOVER', { rootCycleId }, 2));
      store.advance({
        expected: { phase: 'DISCOVER', keyEpoch: control.keyEpoch, controlEpoch: control.controlEpoch },
        next: checkpoint('cycle-root:cycle:2', 'SUMMARIZE', { rootCycleId, summary: { finalized: true, nextCycleId: 'cycle-root:cycle:3' } }, 3)
      });
      const third = store.begin(checkpoint('cycle-root:cycle:3', 'DISCOVER', { rootCycleId }, 4));
      const replay = store.begin(checkpoint('cycle-root:cycle:3', 'DISCOVER', { rootCycleId }, 4));

      expect(store.read('cycle-root')).toBeNull();
      expect(store.read(second.cycleId)).toMatchObject({ phase: 'SUMMARIZE' });
      expect(replay).toEqual(third);
      expect(count(state.storage, 'cycle_checkpoint', tenantId)).toBe(2);
    });
  });
});

describe('AVE onboarding and scanning through the Durable Object', () => {
  it('verifies a /setkey submission with one AVE details read, activates it and scans Arc trending into leads', async () => {
    const tenantId = '19030';
    const radar = env.RADAR.get(env.RADAR.idFromName(`radar:${tenantId}`));
    // Other tenants' scans in this isolate share the global fetch; count only this tenant's key.
    const onboardingKey = 'ave-radar-onboarding-key';
    const requests = [];
    const ownRequests = () => requests.filter(request => request.apiKey === onboardingKey);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const target = String(url);
      requests.push({ url: target, apiKey: init?.headers?.['X-API-KEY'] ?? null });
      if (target.startsWith('https://prod.ave-api.com/v2/tokens/trending?chain=arc')) return jsonResponse({ status: 1, data: { tokens: [arcToken(LEAD)] } });
      if (target === 'https://prod.ave-api.com/v2/tokens/0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c-bsc') {
        return jsonResponse({ status: 1, data: { token: { token: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', chain: 'bsc', current_price_usd: '600' }, pairs: [] } });
      }
      return jsonResponse({}, 404);
    });

    try {
      await runInDurableObject(radar, async (instance, state) => {
        const now = Date.now();
        await instance.receiveTelegramCredential({
          tenantId, actorUserId: tenantId, updateId: '7', commandType: 'credential', payload: { source: 'message' },
          dueAt: now, messageDate: Math.floor(now / 1000), sourceMessageId: '70', locale: 'zh'
        }, `/setkey ${onboardingKey}`);
        const runUntil = async (reached, label) => {
          for (let step = 0; step < 20; step++) {
            if (await reached()) return;
            await instance.alarm();
          }
          throw new Error(`scheduler did not reach ${label} within 20 steps`);
        };

        await runUntil(async () => (await instance.getStatus(tenantId)).control.configured, 'activation');
        expect(ownRequests()).toEqual([{ url: 'https://prod.ave-api.com/v2/tokens/0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c-bsc', apiKey: onboardingKey }]);
        const { control, aveAdmission } = await instance.getStatus(tenantId);
        expect(control).toMatchObject({ configured: true, keyEpoch: 1, activeChain: 'arc' });
        // The candidate's read spent its own allowance, so the activated key starts at zero.
        expect(aveAdmission).toMatchObject({ keyEpoch: 1, cuUsed: 0 });
        const scans = (await instance.getSchedulerSnapshot(tenantId)).tasks.filter(task => task.kind === 'scan');
        expect(scans).toEqual([expect.objectContaining({ enabled: true, aveCost: AVE_CU.trending })]);

        // The verification read spaced the next AVE request; release that spacing instead of waiting it out.
        await instance.setAveAdmissionState({ tenantId, state: { ...aveAdmission, spacingReadyAt: 0 } });
        await runUntil(() => state.storage.sql.exec('SELECT COUNT(*) AS count FROM candidates WHERE tenant_id = ?', tenantId).one().count > 0, 'a committed lead');
        expect(ownRequests().filter(request => request.url.includes('/v2/tokens/trending'))).toEqual([
          { url: 'https://prod.ave-api.com/v2/tokens/trending?chain=arc&current_page=0&page_size=100', apiKey: onboardingKey }
        ]);
        expect(state.storage.sql.exec('SELECT chain, address, status FROM candidates WHERE tenant_id = ?', tenantId).toArray())
          .toEqual([{ chain: 'arc', address: LEAD, status: 'LIVE_READY' }]);
        expect((await instance.getAveAdmissionState(tenantId)).cuUsed).toBe(AVE_CU.trending);
        expect(JSON.stringify(state.storage.sql.exec('SELECT value_json FROM scheduler_state WHERE tenant_id = ?', tenantId).toArray())).not.toContain(onboardingKey);
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('tells the user to resend /setkey when AVE stays unavailable through every verification attempt', async () => {
    const tenantId = '19033';
    const radar = env.RADAR.get(env.RADAR.idFromName(`radar:${tenantId}`));
    const unavailableKey = 'ave-radar-unavailable-key';
    const requests = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const request = new Request(url, init);
      if (request.headers.get('X-API-KEY') === unavailableKey) {
        requests.push(request.url);
        return new Response('gateway timeout', { status: 504 });
      }
      return jsonResponse({}, 404);
    });

    try {
      await runInDurableObject(radar, async (instance, state) => {
        const now = Date.now();
        await instance.receiveTelegramCredential({
          tenantId, actorUserId: tenantId, updateId: '9', commandType: 'credential', payload: { source: 'message' },
          dueAt: now, messageDate: Math.floor(now / 1000), sourceMessageId: '90', locale: 'zh'
        }, `/setkey ${unavailableKey}`);
        const inboxStatus = () => state.storage.sql.exec("SELECT status FROM inbox WHERE tenant_id = ? AND update_id = '9'", tenantId).one().status;
        for (let step = 0; step < 30 && inboxStatus() !== 'FAILED'; step++) {
          await instance.alarm();
          // Release retry backoff and AVE request spacing instead of waiting them out.
          const { tasks } = await instance.getSchedulerSnapshot(tenantId);
          await instance.replaceSchedulerTasks({ tenantId, tasks: tasks.map(task => task.kind === 'credential' ? { ...task, dueAt: 0 } : task) });
          await instance.setAveAdmissionState({ tenantId, state: { ...(await instance.getAveAdmissionState(tenantId)), spacingReadyAt: 0 } });
        }

        expect(inboxStatus()).toBe('FAILED');
        expect(requests.length).toBe(5);
        expect(state.storage.sql.exec('SELECT name FROM keys WHERE tenant_id = ?', tenantId).toArray()).toEqual([]);
        expect((await instance.getStatus(tenantId)).control.configured).toBe(false);
        const panels = state.storage.sql.exec('SELECT payload_json FROM outbox WHERE tenant_id = ?', tenantId).toArray().map(row => JSON.parse(row.payload_json).params);
        expect(panels.some(params => params.text?.startsWith('<b>密钥未通过验证</b>\nAVE服务暂时出错。\nAVE尚未连接。') && params.reply_markup.inline_keyboard[0][0].text === '🔑 重试')).toBe(true);
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it.each([
    ['a refused replacement leaves the working key unblocked', 402, null],
    ['a replacement verifies and activates while the active key is quota-blocked', 200, 'QUOTA']
  ])('%s', async (_name, candidateStatus, activeBlock) => {
    const tenantId = activeBlock ? '19032' : '19031';
    const radar = env.RADAR.get(env.RADAR.idFromName(`radar:${tenantId}`));
    const activeKey = `ave-radar-active-key-${tenantId}`, candidateKey = `ave-radar-candidate-key-${tenantId}`;
    const requests = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const key = init?.headers?.['X-API-KEY'] ?? null;
      if (key === activeKey || key === candidateKey) requests.push(key);
      if (key === candidateKey && candidateStatus !== 200) return new Response('{}', { status: candidateStatus });
      return jsonResponse({ status: 1, data: { token: { token: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', chain: 'bsc', current_price_usd: '600' }, pairs: [] } });
    });

    try {
      await runInDurableObject(radar, async (instance, state) => {
        const submit = async (updateId, key) => {
          const now = Date.now();
          await instance.receiveTelegramCredential({
            tenantId, actorUserId: tenantId, updateId, commandType: 'credential', payload: { source: 'message' },
            dueAt: now, messageDate: Math.floor(now / 1000), sourceMessageId: `${updateId}0`, locale: 'zh'
          }, `/setkey ${key}`);
        };
        const inboxStatus = updateId => state.storage.sql.exec('SELECT status FROM inbox WHERE tenant_id = ? AND update_id = ?', tenantId, updateId).one().status;
        const runUntil = async (reached, label) => {
          for (let step = 0; step < 20; step++) {
            if (await reached()) return;
            await instance.alarm();
          }
          throw new Error(`scheduler did not reach ${label} within 20 steps`);
        };

        await submit('1', activeKey);
        await runUntil(async () => (await instance.getStatus(tenantId)).control.configured, 'first activation');
        // Pause scans so every AVE read below is the replacement's verification.
        await instance.pause({ tenantId });
        const now = Date.now();
        const active = {
          ...(await instance.getAveAdmissionState(tenantId)), cuUsed: 400, spacingReadyAt: 0,
          ...(activeBlock ? { blockedUntil: now + 30 * 86_400_000, blockReason: activeBlock } : {})
        };
        await instance.setAveAdmissionState({ tenantId, state: active });
        requests.length = 0;

        await submit('2', candidateKey);
        await runUntil(() => inboxStatus('2') !== 'RECEIVED' && inboxStatus('2') !== 'RUNNING', 'a verified replacement');
        expect(requests).toEqual([candidateKey]);
        const after = await instance.getAveAdmissionState(tenantId);
        if (candidateStatus === 200) {
          expect(inboxStatus('2')).toBe('DONE');
          expect(after).toMatchObject({ keyEpoch: active.keyEpoch + 1, cuUsed: 0, blockedUntil: 0, blockReason: null });
        } else {
          expect(inboxStatus('2')).toBe('FAILED');
          expect(after).toMatchObject({ keyEpoch: active.keyEpoch, cuUsed: 400, blockedUntil: 0, blockReason: null, backoffFactor: 1 });
          expect((await instance.getStatus(tenantId)).control).toMatchObject({ configured: true, keyEpoch: active.keyEpoch });
        }
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('calls fetch with a receiver the Workers runtime accepts when AVE uses the global fetch', async () => {
    // Workers throws "Illegal invocation" when its fetch runs with any receiver
    // but the global scope; this stub enforces the same rule.
    const receivers = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(function (url) {
      receivers.push(this === undefined || this === globalThis ? 'global' : this?.constructor?.name ?? typeof this);
      if (receivers.at(-1) !== 'global') throw new TypeError('Illegal invocation: function called with incorrect `this` reference.');
      return jsonResponse({ status: 1, data: { tokens: [] } });
    });
    try {
      const result = await new AveClient({ apiKey }).trending('arc');
      expect(result.rows).toEqual([]);
      expect(receivers).toEqual(['global']);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
