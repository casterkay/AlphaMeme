import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scannerSettings } from '../src/scanner-settings.mjs';
import { SCREEN_RULES, discoveryScreen } from '../src/scoring/screen.mjs';
import { discoveryScreen as oracleScreen } from './fixtures/discovery-screen-oracle.mjs';

// The rule table must pass and fail exactly what the screen it replaced did. The
// oracle hardcoded a 60 s quote age, so the parity runs pin that setting to it.
const settingsFor = chain => ({ ...scannerSettings, maxQuoteAgeMs: 60_000, chain });
// The rule table reads only settings the scanner validates complete at its snapshot: any other key fails the test.
const strictSettingsFor = chain => new Proxy(settingsFor(chain), {
  get: (target, key) => Object.hasOwn(target, key) ? target[key] : assert.fail(`the screen read an unknown setting ${String(key)}`)
});

// Both screens on one row: the same pass/fail and the same derived facts, or the same TypeError.
function assertParity(row, chain, nowSec, label) {
  let expected, actual;
  try { expected = oracleScreen(row, settingsFor(chain), nowSec); } catch (error) { expected = error; }
  try { actual = discoveryScreen(row, strictSettingsFor(chain), nowSec); } catch (error) { actual = error; }
  if (actual instanceof assert.AssertionError) throw actual;
  if (expected instanceof Error) {
    assert.ok(actual instanceof TypeError && expected instanceof TypeError, `${label}: both reject the row`);
    return null;
  }
  const facts = screen => ({ pass: screen.pass, createdAt: screen.createdAt, ageBasis: screen.ageBasis, ageSec: screen.ageSec,
    mc: screen.mc, liquidity: screen.liquidity, priorityBand: screen.priorityBand, score: screen.score });
  assert.deepEqual(facts(actual), facts(expected), `${label}: ${JSON.stringify(row)} oracle reasons ${expected.reasons.join(' | ')}`);
  return actual;
}

test('every screen row recorded from the test suite passes or fails exactly as before the rule table', () => {
  // Recorded by running the node suite against the old screen; undefined values were encoded explicitly.
  const recorded = JSON.parse(readFileSync(new URL('./fixtures/screen-rows.json', import.meta.url), 'utf8'),
    (_key, value) => value?.$undefined === true ? undefined : value);
  assert.ok(recorded.length > 150);
  let passed = 0;
  recorded.forEach(({ chain, nowSec, row }, index) => { passed += assertParity(row, chain, nowSec, `recorded row ${index}`)?.pass ? 1 : 0; });
  assert.ok(passed > 20, `recorded rows include passing ones (${passed})`);
});

// A small seeded generator (mulberry32), so every run checks the same rows.
function random(seed) {
  return () => {
    seed = seed + 0x6d2b79f5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

test('generated rows across boundaries, missing fields, encodings and clocks pass or fail exactly as before', () => {
  const next = random(105), pick = values => values[Math.floor(next() * values.length)];
  const s = scannerSettings, ABSENT = Symbol('absent');
  // Mostly a valid value, so a fair share of rows pass and each rule is the only failure often enough.
  const field = (good, edge) => next() < .88 ? good() : pick(edge);
  const encodings = value => [value, String(value), ` ${value} `, `${value * 100}%`];
  const around = value => [value - 1, value, value + 1, value - .5, value + .5];
  const malformed = [ABSENT, null, undefined, '', 'abc', NaN, Infinity, -1, true, {}, []];
  const verdictsSeen = new Map(SCREEN_RULES.map(rule => [rule.id, new Set()]));
  let passed = 0, rows = 0;
  for (let index = 0; index < 30_000; index++) {
    const nowSec = 1_800_000_000 + pick([0, .25, .5, .999]), now = nowSec * 1000;
    const provider = pick(['AVE', 'DEXSCREENER']), chain = pick(['arc', 'bsc']);
    const ages = [...around(s.minAgeSec), ...around(s.maxAgeSec), ...around(s.matureMarketAgeSec), ...around(s.oldMarketAgeSec), 0, -60];
    const age = pick([600, 1_800, 2 * 3600, 7 * 3600, 2 * 86400, ...ages]);
    const createdAt = Math.floor(nowSec - age);
    const clock = () => now - pick([0, 1, 5_000, 30_000]);
    const clockEdge = [...malformed, 0, now + 1, now - 59_999, now - 60_000, now - 60_001, now - 120_000, String(now - 1_000)];
    const liquidity = pick([3_000, 8_000, 20_000, 30_000, 50_000, 80_000]);
    const capturedAt = field(clock, clockEdge);
    const row = {
      marketProvider: provider, chain: field(() => chain, ['eth', 'ARC', undefined]),
      address: field(() => `0x${pick(['1', 'a', 'B'])}${'1'.repeat(39)}`, [`0x${'0'.repeat(40)}`, `0x${'e'.repeat(40)}`, '0x123', ` 0x${'1'.repeat(40)}`, null]),
      price: field(() => pick([.001, '0.5', 2]), [...malformed, 0, '-1', '1e-3', '5%']),
      capturedAt, sourceUpdatedAt: field(() => typeof capturedAt === 'number' ? capturedAt - pick([0, 1, 2_000]) : clock(), clockEdge),
      stale: field(() => pick([false, ABSENT]), [true, 'true', null]),
      expiresAt: field(() => pick([ABSENT, null, now + 60_000]), [now, now - 1, now + 1, 'x', String(now + 1_000)]),
      launch_at: provider === 'AVE' ? field(() => createdAt, [...malformed, 0, createdAt + .5, String(createdAt)]) : null,
      creation_timestamp: field(() => createdAt, [...malformed, 0, createdAt + .5, String(createdAt)]),
      ageBasis: field(() => provider === 'AVE' ? pick(['launch', 'token']) : 'pool', ['token', 'pool', 'launch', null, ABSENT]),
      market_cap: field(() => pick([20_000, 50_000, 100_000]), [...malformed, ...around(s.discoveryMinMarketCap), ...around(s.discoveryMaxMarketCap), '5e4', '12%']),
      liquidity: field(() => liquidity, [...malformed, ...around(s.minLiquidity), String(liquidity)]),
      volume_5m: field(() => pick([2_000, 99, 100, 101, 149, 150, 151, 249, 250, 251, 299, 300, 301, 499, 500, 501, 799, 800, 801]),
        [...malformed, 0, '0', -0, '250']),
      buy_volume_5m: field(() => pick([ABSENT, null, 1_000, '20']), [...malformed, 0, '0']),
      sell_volume_5m: field(() => pick([ABSENT, null, 1_000, '20']), [...malformed, 0, '0']),
      buys_5m: field(() => pick([ABSENT, null, 20, '3']), [...malformed, 0, '0', 1.5]),
      sells_5m: field(() => pick([ABSENT, null, 5, '3']), [...malformed, 0, '0', 1.5]),
      buy_tax: field(() => pick([ABSENT, null, 0, .03, ...encodings(.05)]), [...malformed, .0500001, ...encodings(.06), 1.5, '-1']),
      sell_tax: field(() => pick([ABSENT, null, 0, .03, ...encodings(.05)]), [...malformed, .0500001, ...encodings(.06), 1.5, '-1']),
      holder_count: pick([ABSENT, null, 0, 150, '2000'])
    };
    // An AVE row carries its market cap's own clock (the mapper always sets it); a DexScreener row never does.
    if (provider === 'AVE' || next() < .1) {
      const mcClock = field(() => typeof capturedAt === 'number' ? capturedAt - pick([0, 3_000]) : clock(), clockEdge);
      Object.assign(row, { marketCapSourceUpdatedAt: mcClock,
        marketCapCapturedAt: field(() => typeof capturedAt === 'number' ? capturedAt : now, [...clockEdge, ABSENT]),
        marketCapExpiresAt: field(() => now + 30_000, [...clockEdge, ABSENT]) });
    }
    for (const [key, value] of Object.entries(row)) if (value === ABSENT) delete row[key];
    const screen = assertParity(row, chain, nowSec, `generated row ${index}`);
    rows += 1;
    if (!screen) continue;
    passed += screen.pass ? 1 : 0;
    for (const [id, verdict] of Object.entries(screen.verdicts)) verdictsSeen.get(id).add(verdict);
  }
  assert.ok(passed > rows * .05, `a fair share of generated rows pass (${passed} of ${rows})`);
  // Every rule meets each verdict it can give, so the generator reaches every boundary the table draws.
  const expected = { IDENTITY_MISMATCH: ['HIT', 'CLEAR'], PRICE_KNOWN: ['CLEAR', 'UNKNOWN'], AGE_KNOWN: ['CLEAR', 'UNKNOWN'],
    MARKET_CAP_KNOWN: ['CLEAR', 'UNKNOWN'], LIQUIDITY_KNOWN: ['CLEAR', 'UNKNOWN'] };
  for (const [id, seen] of verdictsSeen) assert.deepEqual([...seen].sort(), (expected[id] || ['CLEAR', 'HIT', 'UNKNOWN']).sort(), id);
});
