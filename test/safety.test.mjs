import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregateSecondarySources } from '../src/providers/secondary.mjs';
import { mergeSecondaryClassification } from '../src/scoring/classification.mjs';
import { safetyVerdict, BLOCKING_CONFLICTS } from '../src/scoring/safety.mjs';
import { applyRiskExclusion, CHART_RISK_VERSION } from '../src/scoring/chart-risk.mjs';
import { projectTelegramCandidate } from '../src/bot/snapshot.mjs';
import { safetyBadge } from '../src/render/telegram.mjs';

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
  ['a hard reject with no check', { status: 'HARD_REJECT', secondary: null }, 'VETOED'],
  ['a passed check whose deep audit has a waiting failure', { status: 'X_REVIEW', secondary: PASSED, deep: { failed: ['notHoneypot'], blockingUnknownFields: [] } }, 'INCOMPLETE'],
  ['a passed check whose deep audit has a blocking unknown field', { status: 'X_REVIEW', secondary: PASSED, deep: { failed: [], blockingUnknownFields: ['buyTax'] } }, 'INCOMPLETE'],
  ['a passed check whose legacy deep audit has only unknownFields', { status: 'X_REVIEW', secondary: PASSED, deep: { failed: [], unknownFields: ['top10'] } }, 'INCOMPLETE'],
  ['a passed check whose deep audit has only non-blocking unknowns', { status: 'X_REVIEW', secondary: PASSED, deep: { failed: [], blockingUnknownFields: [], unknownFields: ['top10'] } }, 'PASSED'],
  ['a risk exclusion, which fails chartRisk in the deep audit', { status: 'HARD_REJECT', secondary: PASSED, deep: { failed: ['chartRisk'], blockingUnknownFields: [] } }, 'VETOED'],
  ['an open deep audit before any check', { status: 'X_REVIEW', secondary: null, deep: { failed: ['notHoneypot'], blockingUnknownFields: [] } }, 'PENDING']
]) test(`safetyVerdict: ${name} is ${expected}`, () => assert.equal(safetyVerdict(input), expected));

test('classification holds back exactly the conflicts the verdict treats as blocking', () => {
  for (const type of [...BLOCKING_CONFLICTS, 'WEBSITE_MISMATCH']) {
    const secondary = { ...PASSED, conflicts: [{ type }] };
    const held = mergeSecondaryClassification({ status: 'X_REVIEW', hardFailed: [], waitingFailed: [] }, secondary).status === 'WAIT_RECHECK';
    assert.equal(held, safetyVerdict({ status: 'X_REVIEW', secondary }) !== 'PASSED', type);
  }
});

test('the Telegram projection keeps every fact the verdict reads, including a risk exclusion', () => {
  const source = { chain: 'bsc', address: '0x' + 'ab'.repeat(20), symbol: 'MEME', status: 'X_REVIEW', auditedAt: 1, reviewRevision: 'r', secondary: PASSED,
    deep: { chainPass: true, chartRisk: { version: CHART_RISK_VERSION, pass: true }, checks: {}, failed: [], unknownFields: [], blockingUnknownFields: [] } };
  const verdict = row => safetyVerdict({ status: row.status, secondary: row.secondary, deep: row.deep });
  assert.equal(verdict(projectTelegramCandidate(source)), 'PASSED');
  assert.equal(verdict(projectTelegramCandidate({ ...source, secondary: SECURITY_CONFLICT })), 'INCOMPLETE');
  assert.equal(verdict(projectTelegramCandidate({ ...source, deep: { ...source.deep, failed: ['notHoneypot'] } })), 'INCOMPLETE');
  assert.equal(verdict(projectTelegramCandidate({ ...source, deep: { ...source.deep, blockingUnknownFields: ['buyTax'] } })), 'INCOMPLETE');
  // Recorded before the blocking split: no blockingUnknownFields at all.
  const legacy = { chainPass: true, chartRisk: source.deep.chartRisk, checks: {}, failed: [], unknownFields: ['top10'] };
  assert.equal(safetyVerdict({ status: source.status, secondary: PASSED, deep: legacy }), 'INCOMPLETE');
  assert.equal(verdict(projectTelegramCandidate({ ...source, deep: legacy })), 'INCOMPLETE', 'a legacy audit cannot show as passed once projected');
  const excluded = applyRiskExclusion(source, { [`bsc:${source.address}`]: { version: 1, codes: ['X'], reasons: ['excluded'], at: 1 } });
  assert.equal(verdict(projectTelegramCandidate(excluded)), 'VETOED');
});

test('safetyBadge words every verdict once in both languages and refuses an unknown one', () => {
  assert.deepEqual(['PASSED', 'INCOMPLETE', 'VETOED', 'PENDING'].map(verdict => [safetyBadge(verdict, 'en'), safetyBadge(verdict, 'zh')]), [
    ['✅ No failures found', '✅ 未发现问题'], ['⚠️ Needs review', '⚠️ 待复核'], ['⛔ Vetoed', '⛔ 已否决'], ['⏳ Checking', '⏳ 检查中']]);
  assert.throws(() => safetyBadge('VERIFIED', 'en'), RangeError);
});
