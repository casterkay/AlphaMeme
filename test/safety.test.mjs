import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregateSecondarySources } from '../src/providers/secondary.mjs';
import { mergeSecondaryClassification } from '../src/scoring/classification.mjs';
import { safetyVerdict, BLOCKING_CONFLICTS } from '../src/scoring/safety.mjs';

const SECURITY = { complete: true, verdict: 'NO_FATAL_FLAGS', fatal: [], unknownFields: [], fields: {}, buyTax: 0, sellTax: 0 };
// A recorded check as the scanner aggregates it; `primary` disagreeing with the sources yields conflicts.
const check = ({ dex = 'OK', security = SECURITY, primary = {} } = {}) => aggregateSecondarySources({ chain: 'bsc', tokenAddress: '0x' + 'ab'.repeat(20), primary, sources: {
  dexScreener: { value: { source: { status: dex }, market: { complete: true, priceUsd: 1, marketCap: 1000, liquidityUsd: 500, websites: [] } } },
  goPlus: { value: { source: { status: 'OK' }, security: { ...security, fields: { isHoneypot: false, ...security.fields } } } } } });
const PASSED = check();
const SECURITY_CONFLICT = check({ primary: { security: { honeypot: true } } });
const MARKET_CONFLICT = check({ primary: { market: { priceUsd: 2 } } });

test('the fixtures produce the conflicts they name', () => {
  assert.deepEqual(PASSED.conflicts, []);
  assert.deepEqual(SECURITY_CONFLICT.conflicts.map(item => item.type), ['SECURITY_MISMATCH']);
  assert.deepEqual(MARKET_CONFLICT.conflicts.map(item => item.type), ['MARKET_MISMATCH']);
  assert.equal(SECURITY_CONFLICT.status, 'COMPLETE');assert.equal(SECURITY_CONFLICT.security.verdict, 'NO_FATAL_FLAGS');
});

for (const [name, input, expected] of [
  ['no candidate and no check', { status: null, secondary: null }, 'PENDING'],
  ['a lead whose check has not run', { status: 'LIVE_READY', secondary: null }, 'PENDING'],
  ['a degraded check', { status: 'LIVE_READY', secondary: check({ dex: 'ERROR' }) }, 'INCOMPLETE'],
  ['an unknown verdict', { status: 'LIVE_READY', secondary: check({ security: { ...SECURITY, complete: false, verdict: 'UNKNOWN', unknownFields: ['honeypot'] } }) }, 'INCOMPLETE'],
  ['a complete record whose verdict is unknown', { status: 'LIVE_READY', secondary: { status: 'COMPLETE', security: { verdict: 'UNKNOWN' } } }, 'INCOMPLETE'],
  ['a complete check with a security conflict', { status: 'LIVE_READY', secondary: SECURITY_CONFLICT }, 'INCOMPLETE'],
  ['a complete check with a market conflict', { status: 'LIVE_READY', secondary: MARKET_CONFLICT }, 'INCOMPLETE'],
  ['a complete check with only a website conflict', { status: 'LIVE_READY', secondary: { ...PASSED, conflicts: [{ type: 'WEBSITE_MISMATCH' }] } }, 'PASSED'],
  ['a complete check without fatal flags or conflicts', { status: 'LIVE_READY', secondary: PASSED }, 'PASSED'],
  ['a fatal verdict', { status: 'LIVE_READY', secondary: check({ security: { ...SECURITY, verdict: 'FATAL', fatal: [{ field: 'honeypot', reason: 'honeypot' }] } }) }, 'VETOED'],
  ['a hard reject with a clean check', { status: 'HARD_REJECT', secondary: PASSED }, 'VETOED'],
  ['a hard reject with no check', { status: 'HARD_REJECT', secondary: null }, 'VETOED']
]) test(`safetyVerdict: ${name} is ${expected}`, () => assert.equal(safetyVerdict(input), expected));

test('classification holds back exactly the conflicts the verdict treats as blocking', () => {
  for (const type of [...BLOCKING_CONFLICTS, 'WEBSITE_MISMATCH']) {
    const secondary = { ...PASSED, conflicts: [{ type }] };
    const held = mergeSecondaryClassification({ status: 'X_REVIEW', hardFailed: [], waitingFailed: [] }, secondary).status === 'WAIT_RECHECK';
    assert.equal(held, safetyVerdict({ status: 'X_REVIEW', secondary }) !== 'PASSED', type);
  }
});
