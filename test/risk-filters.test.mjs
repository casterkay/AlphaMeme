import test from 'node:test';
import assert from 'node:assert/strict';
import { chartRiskScreen } from '../src/scoring/chart-risk.mjs';
import { classifyDeepResult } from '../src/scoring/classification.mjs';
import { scannerSettings as config } from '../src/scanner-settings.mjs';
import { deepScreen, knownRiskReasons, discoveryScreen, observeFiveMinutes } from '../src/scoring/index.mjs';

const now = 1_800_000_000_000, address = '0x' + 'a'.repeat(40);
const series = (closes, at = now) => closes.map((close, i) => {
  const open = i ? closes[i - 1] : 1;
  return { time: at - (closes.length - i) * 60_000, open, close,
    high: Math.max(open, close) * 1.005, low: Math.min(open, close) * .995, volume: 100 };
});
const pump = at => series([1.3776, 1.38, 1.38, 1.39, 1.39, 1.39, 1.40, 1.40, 1.40], at);
const dump = at => series([1, .65, .35, .18, .18, .18, .18, .18, .18], at);
const discovery = at => ({ address, chain: 'bsc', marketProvider: 'AVE', market_cap: 50000, liquidity: 12000,
  creation_timestamp: at / 1000 - 600, rug_ratio: .1, bundler_rate: .05,
  rat_trader_amount_rate: .05, is_wash_trading: false, is_honeypot: false });

test('observed early pump and collapse are rejected even when the last five bars look normal', () => {
  for (const [bars, code] of [[pump(now), 'VERTICAL_PLATEAU'], [dump(now), 'SUSTAINED_COLLAPSE']]) {
    assert.equal(observeFiveMinutes(bars, now).pass, true);
    const risk = chartRiskScreen(bars, now);
    assert.equal(risk.status, 'REJECT'); assert.ok(risk.codes.includes(code));
    assert.equal(risk.from, bars[0].time);
    assert.equal(chartRiskScreen([...bars].reverse(), now).status, 'REJECT');
    assert.equal(chartRiskScreen(bars.map(b => ({ ...b, time: b.time / 1000 })), now).status, 'REJECT');
    const deep = deepScreen({ discovery: {}, audit: { candles: bars }, nowMs: now }, config);
    assert.equal(classifyDeepResult(deep).status, 'HARD_REJECT');
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
    assert.equal(classifyDeepResult({ chainPass: false, failed: ['chartRisk'], blockingUnknownFields: risk.unknownFields }).status, 'WAIT_RECHECK');
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

test('discovery screening filters known low LP, high taxes, DEV and explicit zero 5m volume', () => {
  for (const fields of [{ liquidity: 2_900 }, { buy_tax: '10%', sell_tax: '15%' },
    { dev_team_hold_rate: .0803 }, { creator_balance_rate: .08 }, { volume_5m: 0 }]) {
    const row = { ...discovery(now), ...fields };
    const [reason] = knownRiskReasons(row, { ...config, strictLiquidity: config.minLiquidity });
    assert.ok(reason);
    assert.ok(discoveryScreen(row, { ...config, chain: 'bsc' }, now / 1000).reasons.includes(reason));
  }
});
