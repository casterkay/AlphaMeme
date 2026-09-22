import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RecoverableScanner,
  classifyRecoverableDeepResult,
  mergeRecoverableSecondaryClassification,
  selectRecoverableAuditQueue
} from '../src/recoverable-scanner.mjs';
import { executeRecoverableScanStep } from '../src/recoverable-scan-executor.mjs';
import { stableEffectId } from '../src/storage/recoverable-scanner.mjs';

const NOW = 1_800_000_000_000;

const settings = Object.freeze({
  maxDeepAuditsPerCycle: 2,
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

class MemoryScannerStore {
  constructor() {
    this.checkpoints = new Map();
  }

  begin(value) {
    const current = this.checkpoints.get(value.cycleId);
    if (current) return structuredClone(current);
    const checkpoint = { tenantId: '1000', ...structuredClone(value) };
    this.checkpoints.set(value.cycleId, checkpoint);
    return structuredClone(checkpoint);
  }

  read(cycleId) {
    const checkpoint = this.checkpoints.get(cycleId);
    return checkpoint ? structuredClone(checkpoint) : null;
  }

  advance({ expected, next }) {
    const current = this.checkpoints.get(next.cycleId);
    assert.equal(current.phase, expected.phase);
    assert.equal(current.keyEpoch, expected.keyEpoch);
    assert.equal(current.controlEpoch, expected.controlEpoch);
    this.checkpoints.set(next.cycleId, { tenantId: '1000', ...structuredClone(next) });
    return this.read(next.cycleId);
  }

  readRiskExclusions() {
    return [];
  }

  readAuditQueue() {
    return [];
  }

  readOutcomes() {
    return [];
  }
}

test('recoverable scanner persists one response cursor at a time and retains the original deadline after recovery', () => {
  const store = new MemoryScannerStore();
  const scanner = new RecoverableScanner({ store, settings, now: () => NOW });
  scanner.begin({ cycleId: 'cycle-1', chain: 'sol', keyEpoch: 0, controlEpoch: 0, deadlineAt: NOW + 20_000 });

  assert.equal(scanner.nextRequest('cycle-1').endpoint, 'trenches');
  scanner.recordRequest('cycle-1', { value: { completed: [] }, collectedAt: NOW + 1 });
  const persisted = store.read('cycle-1');
  assert.equal(persisted.phase, 'DISCOVER');
  assert.equal(persisted.endpointIndex, 1);
  assert.equal(persisted.partial.discovery.responses.trenches.collectedAt, NOW + 1);
  assert.equal(persisted.deadlineAt, NOW + 20_000);

  scanner.recordRequest('cycle-1', { value: { rank: [] }, collectedAt: NOW + 2 });
  assert.equal(store.read('cycle-1').phase, 'SCREEN');
  scanner.advanceLocal('cycle-1');
  assert.equal(store.read('cycle-1').phase, 'BUILD_QUEUE');
  scanner.advanceLocal('cycle-1');
  assert.equal(store.read('cycle-1').phase, 'OUTCOMES_SAMPLE');
});

test('recoverable scanner preserves the legacy transient classification and fairness rules', () => {
  assert.equal(classifyRecoverableDeepResult({ failed: ['observation'], blockingUnknownFields: [], honeypotEvidence: '未验证' }, { complete: true }).status, 'WAIT_RECHECK');
  assert.equal(classifyRecoverableDeepResult({ failed: ['ownerRenounced'], blockingUnknownFields: [], honeypotEvidence: '未验证' }, { complete: true }).status, 'HARD_REJECT');
  assert.equal(mergeRecoverableSecondaryClassification({ status: 'X_REVIEW', hardFailed: [], waitingFailed: [] }, {
    status: 'COMPLETE', sources: { dexScreener: { status: 'OK' }, goPlus: { status: 'OK' } }, security: { verdict: 'FATAL' }, conflicts: []
  }).status, 'HARD_REJECT');

  const selected = selectRecoverableAuditQueue([
    { address: 'fresh', firstSeenAt: NOW - 1_000, nextAuditAt: 0, lastAuditedAt: 0, priorityBand: true, score: 99 },
    { address: 'fair', firstSeenAt: NOW - 10_000, nextAuditAt: 0, lastAuditedAt: 0, priorityBand: false, score: 10 }
  ], new Set(['fresh', 'fair']), NOW, 5, 1);
  assert.equal(selected[0].address, 'fair');
});

test('a hard rejection from the final audit endpoint skips secondary source work', () => {
  const address = `0x${'1'.repeat(40)}`;
  const holders = Array.from({ length: 10 }, (_, index) => ({
    address: `0x${String(index + 1).padStart(40, '0')}`,
    addr_type: 0,
    amount_percentage: 0.01,
    buy_tx_count_cur: 1,
    is_new: false,
    is_suspicious: false,
    native_transfer: { from_address: `source-${index}` },
    tags: [],
    maker_token_tags: []
  }));
  const traders = Array.from({ length: 5 }, (_, index) => ({
    address: `seller-${index}`,
    sell_tx_count_cur: 1,
    last_active_timestamp: NOW / 1_000 - 60
  }));
  const value = response => ({ value: response, collectedAt: NOW });
  const store = new MemoryScannerStore();
  store.checkpoints.set('cycle-final-hard-reject', {
    tenantId: '1000',
    cycleId: 'cycle-final-hard-reject',
    chain: 'bsc',
    keyEpoch: 0,
    controlEpoch: 0,
    deadlineAt: NOW + 20_000,
    phase: 'AUDIT',
    tokenIndex: 0,
    endpointIndex: 5,
    updatedAt: NOW,
    partial: {
      settings,
      queue: {
        selected: [{
          row: {
            address,
            market_cap: 50_000,
            liquidity: 10_000,
            sells_24h: 20,
            rug_ratio: 0.1,
            top_10_holder_rate: 0.2,
            bundler_rate: 0.05,
            rat_trader_amount_rate: 0.05,
            top70_sniper_hold_rate: 0.02,
            is_wash_trading: false,
            creator_token_status: 'creator_close',
            dev_team_hold_rate: 0,
            lock_percent: 0.9
          },
          screen: { pass: true }
        }]
      },
      audit: {
        responses: {
          info: value({ liquidity: 10_000, price: { sells_5m: 3, sells_24h: 20 } }),
          security: value({
            open_source: true,
            owner_renounced: true,
            is_honeypot: false,
            buy_tax: 0.01,
            sell_tax: 0.01,
            rug_ratio: 0.1,
            top_10_holder_rate: 0.2,
            creator_token_status: 'creator_close',
            rat_trader_amount_rate: 0.05,
            bundler_trader_amount_rate: 0.05,
            top70_sniper_hold_rate: 0.02,
            is_wash_trading: false,
            lock_percent: 0.9
          }),
          pool: value({ liquidity: 10_000 }),
          holders: value(holders),
          traders: value(traders)
        }
      }
    }
  });
  const scanner = new RecoverableScanner({ store, settings, now: () => NOW });
  const candles = [1.3776, 1.38, 1.38, 1.39, 1.39, 1.39, 1.4, 1.4, 1.4].map((close, index, values) => {
    const open = index ? values[index - 1] : 1;
    return {
      time: NOW - (values.length - index) * 60_000,
      open,
      close,
      high: Math.max(open, close) * 1.005,
      low: Math.min(open, close) * 0.995,
      volume: 100
    };
  });

  const checkpoint = scanner.recordRequest('cycle-final-hard-reject', { value: candles, collectedAt: NOW + 1 });
  assert.equal(checkpoint.phase, 'CLASSIFY_AND_COMMIT');
  assert.equal(checkpoint.endpointIndex, 0);
  assert.equal(scanner.nextRequest('cycle-final-hard-reject'), null);
});

test('stable effect IDs include the tenant, cycle, chain, address, and effect type', () => {
  const id = stableEffectId('1000', 'cycle-1', 'sol', 'So11111111111111111111111111111111111111112', 'X_REVIEW');
  assert.equal(id, stableEffectId('1000', 'cycle-1', 'sol', 'So11111111111111111111111111111111111111112', 'X_REVIEW'));
  assert.notEqual(id, stableEffectId('1000', 'cycle-2', 'sol', 'So11111111111111111111111111111111111111112', 'X_REVIEW'));
});

test('recoverable scan executor makes one direct discovery request and checkpoints its response', async () => {
  const store = new MemoryScannerStore();
  const scanner = new RecoverableScanner({ store, settings, now: () => NOW });
  scanner.begin({ cycleId: 'cycle-executor', chain: 'sol', keyEpoch: 0, controlEpoch: 0, deadlineAt: NOW + 20_000 });
  const calls = [];
  const gmgn = {
    trenches: async (chain, options) => {
      calls.push({ operation: 'trenches', chain, options });
      return { completed: [] };
    }
  };
  let requests = 0;
  const result = await executeRecoverableScanStep({
    scanner,
    cycleId: 'cycle-executor',
    gmgn,
    now: () => NOW + 1,
    request: async operation => {
      requests++;
      return operation({ signal: new AbortController().signal, timeoutMs: 5_000 });
    }
  });

  assert.equal(requests, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].operation, 'trenches');
  assert.equal(store.read('cycle-executor').endpointIndex, 1);
  assert.equal(result.complete, false);
});
