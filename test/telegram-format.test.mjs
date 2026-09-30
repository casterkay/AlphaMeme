import assert from 'node:assert/strict';
import test from 'node:test';
import { money, percent, duration, clockTime, relativeTime, numberText } from '../src/render/telegram.mjs';

// Deterministic generator so a failing property reproduces.
function random(seed) {
  return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const UNIT = { '': 1, K: 1e3, M: 1e6, B: 1e9 };
const parseMoney = text => { const [, sign, mantissa, unit] = /^(-?)\$([\d.,]+)([KMB]?)$/.exec(text); return (sign ? -1 : 1) * Number(mantissa.replaceAll(',', '')) * UNIT[unit]; };

test('money is compact with three significant digits and rolls over to the next unit', () => {
  for (const [value, expected] of [
    [0, '$0'], [1e-9, '$0.000000001'], [5.321, '$5.32'], [532.18, '$532'], [999.4, '$999'], [999.5, '$1K'],
    [123_456.78, '$123K'], [999_950, '$1M'], [1_234_567, '$1.23M'], [12.3e9, '$12.3B'], [-4200, '-$4.2K']
  ]) assert.equal(money(value, 'en'), expected, String(value));
  assert.equal(money(1_234_567, 'zh'), '$1.23M');
  for (const value of [null, undefined, NaN, Infinity, '12']) assert.equal(money(value, 'en'), 'Unknown');
});

test('money keeps value within rounding error and order across magnitudes', () => {
  const next = random(7);
  const samples = Array.from({ length: 2000 }, () => 10 ** (next() * 21 - 9)).sort((a, b) => a - b);
  let previous = -Infinity;
  for (const value of samples) {
    const text = money(value, 'en'), parsed = parseMoney(text);
    assert.ok(Math.abs(parsed - value) <= value * 0.005 + Number.EPSILON, `${value} → ${text}`);
    assert.ok(text.replace(/[^\d]/g, '').replace(/^0+/, '').replace(/0+$/, '').length <= 3, text);
    // A mantissa of 1,000 or more means the unit should have rolled over (e.g. $1,000K).
    const [, mantissa, unit] = /^\$([\d.,]+)([KMB]?)$/.exec(text);
    assert.ok(unit === 'B' || Number(mantissa.replaceAll(',', '')) < 1000, text);
    assert.ok(parsed >= previous, `${text} is below the previous sample`);
    previous = parsed;
    assert.equal(money(-value, 'en'), `-${text}`);
  }
});

test('percent shows one decimal below 100% and whole numbers above, with an honest sign', () => {
  for (const [value, signed, expected] of [
    [0.35234, true, '+35.2%'], [0.35234, false, '35.2%'], [-0.125, true, '-12.5%'], [12.4, true, '+1,240%'],
    [0, true, '0%'], [-0.0004, true, '0%'], [-0.0004, false, '0%'], [0.99949, true, '+99.9%']
  ]) assert.equal(percent(value, 'en', signed), expected, `${value} ${signed}`);
  const next = random(11);
  for (let index = 0; index < 2000; index++) {
    const value = (next() - 0.5) * 10 ** (next() * 6 - 4), text = percent(value, 'en', true);
    assert.doesNotMatch(text, /^-0%$/);
    if (text !== '0%') assert.equal(text.startsWith('-'), value < 0, `${value} → ${text}`);
  }
});

test('durations and relative times use the largest whole unit in both languages', () => {
  const now = Date.UTC(2026, 8, 30, 12, 34, 56);
  for (const [ago, en, zh] of [[2000, 'just now', '刚刚'], [45_000, '45s ago', '45秒前'], [240_000, '4m ago', '4分钟前'], [7_200_000, '2h ago', '2小时前'], [3 * 86_400_000, '3d ago', '3天前']]) {
    assert.equal(relativeTime(now - ago, now, 'en'), en);
    assert.equal(relativeTime(now - ago, now, 'zh'), zh);
  }
  assert.equal(duration(-5, 'en'), '0s');
  assert.equal(relativeTime(0, now, 'en'), 'No record');
  // A future value is a deadline, not an elapsed time.
  assert.equal(relativeTime(now + 60_000, now, 'en'), '12:35 UTC');
});

test('clock times drop the date only on the reference UTC day', () => {
  const now = Date.UTC(2026, 8, 30, 12, 34, 56);
  assert.equal(clockTime(now, 'en'), 'Sep 30 12:34 UTC');
  assert.equal(clockTime(now, 'zh'), '9月30日 12:34 UTC');
  assert.equal(clockTime(now + 30_000, 'en', { reference: now, seconds: true }), '12:35:26 UTC');
  assert.equal(clockTime(Date.UTC(2026, 9, 1, 0, 5), 'en', { reference: now }), 'Oct 1 00:05 UTC');
  assert.equal(clockTime(NaN, 'zh'), '尚无记录');
});

test('exact numbers stay exact for evidence', () => {
  assert.equal(numberText(123_456.78, 'en'), '123,456.78');
});
