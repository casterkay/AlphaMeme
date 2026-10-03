import test from 'node:test';
import assert from 'node:assert/strict';
import { chartRiskScreen } from '../src/scoring/chart-risk.mjs';
import { scannerSettings as config } from '../src/scanner-settings.mjs';
import { deepScreen, observeFiveMinutes } from '../src/scoring/index.mjs';
import { discoveryScreen } from '../src/scoring/screen.mjs';

const now = 1_800_000_000_000, address = '0x' + 'a'.repeat(40);
const series = (closes, at = now) => closes.map((close, i) => {
  const open = i ? closes[i - 1] : 1;
  return { time: at - (closes.length - i) * 60_000, open, close,
    high: Math.max(open, close) * 1.005, low: Math.min(open, close) * .995, volume: 100 };
});
const pump = at => series([1.3776, 1.38, 1.38, 1.39, 1.39, 1.39, 1.40, 1.40, 1.40], at);
const dump = at => series([1, .65, .35, .18, .18, .18, .18, .18, .18], at);
const discovery = at => ({ address, chain: 'bsc', marketProvider: 'AVE', price: .001, market_cap: 50000, liquidity: 12000,
  volume_5m: 2000, launch_at: at / 1000 - 600, capturedAt: at, sourceUpdatedAt: at });

test('observed early pump and collapse are rejected even when the last five bars look normal', () => {
  for (const [bars, code] of [[pump(now), 'VERTICAL_PLATEAU'], [dump(now), 'SUSTAINED_COLLAPSE']]) {
    assert.equal(observeFiveMinutes(bars, now).pass, true);
    const risk = chartRiskScreen(bars, now);
    assert.equal(risk.status, 'REJECT'); assert.ok(risk.codes.includes(code));
    assert.equal(risk.from, bars[0].time);
    assert.equal(chartRiskScreen([...bars].reverse(), now).status, 'REJECT');
    assert.equal(chartRiskScreen(bars.map(b => ({ ...b, time: b.time / 1000 })), now).status, 'REJECT');
    const deep = deepScreen({ discovery: {}, audit: { candles: bars }, nowMs: now }, config);
    assert.ok(deep.failed.includes('chartRisk'));
    assert.equal(deep.chainPass, false);
  }
});

test('unknown, conflicting, stale, flat-zero-volume and price-gap candles do not create permanent accusations', () => {
  const good = series([1, 1.01, 1.02, 1.025, 1.03, 1.04, 1.05, 1.06]);
  assert.equal(chartRiskScreen(good, now).pass, true);
  assert.equal(chartRiskScreen([...good, good[0]], now).pass, true);
  const gapPrices = series([1, 1.5, 1.5, 1.5, 1.5, 1.5]).map(b => ({ ...b, open: b.close, low: b.close, high: b.close }));
  const cases = [[], good.slice(0, 3), good.slice(0, -3), [...good.slice(0, 3), ...good.slice(4)],
    [...good, { ...good[0], volume: 9 }], good.map(b => ({ ...b, time: b.time - 180000 })),
    good.map(b => ({ ...b, volume: 0 })), gapPrices, pump(now).map(b => ({ ...b, volume: 0 })),
    good.map(b => ({ ...b, open: [] }))];
  for (const rows of cases) {
    const risk = chartRiskScreen(rows, now);
    assert.equal(risk.status, 'UNKNOWN'); assert.equal(risk.pass, false);
    assert.ok(risk.unknownFields.length);
  }
  // A huge high wick has no ordered evidence of two later collapsed closes.
  assert.equal(chartRiskScreen(good.map(b => ({ ...b, high: 100 })), now).pass, true);
});

test('DEV exit labels cannot override positive holdings or fill a missing balance', () => {
  for (const status of ['sell', 'creator_close']) {
    for (const value of [.0803, '8.03%', undefined]) {
      const deep = deepScreen({ discovery: { creator_token_status: status, dev_team_hold_rate: value }, audit: {}, nowMs: now }, config);
      assert.equal(deep.checks.dev, false);
      if (value === undefined) assert.ok(deep.blockingUnknownFields.includes('devHold'));
    }
  }
});

test('discovery screening drops known low LP and high taxes, and holds back explicit zero 5m volume', () => {
  assert.equal(discoveryScreen(discovery(now), { ...config, chain: 'bsc' }, now / 1000).pass, true);
  for (const [fields, rule, verdict, decision] of [[{ liquidity: 2_900 }, 'LIQUIDITY_TOO_LOW', 'HIT', 'DROP'],
    [{ buy_tax: '10%', sell_tax: '15%' }, 'TAX_TOO_HIGH', 'HIT', 'DROP'], [{ volume_5m: 0 }, 'VOLUME_5M_POSITIVE', 'HIT', 'UNDECIDED']]) {
    const screen = discoveryScreen({ ...discovery(now), ...fields }, { ...config, chain: 'bsc' }, now / 1000);
    assert.deepEqual([screen.verdicts[rule], screen.decision, screen.reasons], [verdict, decision, [rule]]);
  }
});
