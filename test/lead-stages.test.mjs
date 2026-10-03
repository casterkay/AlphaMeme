import test from 'node:test';
import assert from 'node:assert/strict';
import { withStages } from '../src/lead-stages.mjs';

const T = 1_800_000_000_000, token = { chain: 'arc', address: `0x${'a'.repeat(40)}` };
const lines = log => log.mock.calls.map(call => JSON.parse(call.arguments[0]));

test('a stage record keeps known times in pipeline order and leaves missing ones unknown, never zero', t => {
  const log = t.mock.method(console, 'log', () => {});
  const stages = withStages({}, { launchedAt: T, logSeenAt: undefined, listedAt: null, promotableAt: 0, screenedAt: T + 5_000, leadCreatedAt: T + 5_000 }, token);
  assert.deepEqual(stages, { launchedAt: T, screenedAt: T + 5_000, leadCreatedAt: T + 5_000 });
  assert.deepEqual(lines(log), [{ event: 'lead_stages', ...token, stages }]);
});

test('a recorded stage keeps its first time, and a stage earlier than the last known one before it stays unknown', t => {
  const log = t.mock.method(console, 'log', () => {});
  const lead = { launchedAt: T, leadCreatedAt: T + 60_000 };
  for (const [scenario, entries, expected] of [
    ['first time wins', { leadCreatedAt: T + 90_000 }, lead],
    ['delivery follows its enqueue', { alertEnqueuedAt: T + 61_000, alertDeliveredAt: T + 62_000 }, { ...lead, alertEnqueuedAt: T + 61_000, alertDeliveredAt: T + 62_000 }],
    ['an unknown enqueue defers to the lead', { alertDeliveredAt: T + 59_000 }, lead],
    ['a GoPlus check before delivery still follows the lead', { goPlusCompleteAt: T + 60_000 }, { ...lead, goPlusCompleteAt: T + 60_000 }],
    ['a launch after the first sighting (another clock)', { logSeenAt: T - 1 }, lead]
  ]) assert.deepEqual(withStages(lead, entries, token), expected, scenario);
  assert.deepEqual(lines(log).filter(line => line.event === 'lead_stage_out_of_order').map(line => [line.stage, line.at, line.before]),
    [['alertDeliveredAt', T + 59_000, T + 60_000], ['logSeenAt', T - 1, T]]);
  assert.throws(() => withStages({}, { firstSeenAt: T }, token), TypeError);
});
