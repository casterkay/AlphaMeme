import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { backendDisposition, effectiveStatus, canPass } from '../src/scoring/manual-review.mjs';

const now = 1_800_000_000_000;
const freshChainCandidate = {
  status: 'X_REVIEW',
  auditedAt: now - 10 * 60_000,
  reviewRevision: 'revision-1'
};

test('backend disposition retains the audit status mapping', () => {
  assert.equal(backendDisposition({ status: 'X_REVIEW' }), 'chain');
  assert.equal(backendDisposition({ status: 'QUALIFIED' }), 'chain');
  assert.equal(backendDisposition({ status: 'WAIT_RECHECK' }), 'waiting');
  assert.equal(backendDisposition({ status: 'HARD_REJECT' }), 'rejected');
  assert.equal(backendDisposition({ deep: { chainPass: true } }), 'chain');
});

test('a matching fresh manual pass is effective only while its evidence remains eligible', () => {
  const mark = { decision: 'passed', at: now - 24 * 60 * 60_000 + 1, reviewRevision: 'revision-1' };
  assert.equal(effectiveStatus(freshChainCandidate, mark, now), 'passed');
  assert.equal(effectiveStatus({ ...freshChainCandidate, reviewRevision: 'revision-2' }, mark, now), 'chain');
  assert.equal(effectiveStatus({ ...freshChainCandidate, auditedAt: now - 10 * 60_000 - 1 }, mark, now), 'chain');
  assert.equal(effectiveStatus(freshChainCandidate, { ...mark, at: now - 24 * 60 * 60_000 }, now), 'chain');
});

test('ignored marks remain effective until explicitly undone', () => {
  assert.equal(effectiveStatus({ status: 'HARD_REJECT' }, { decision: 'ignored', at: now - 99 * 24 * 60 * 60_000 }, now), 'ignored');
});

test('an existing passed mark only enables its cancellation, never a new pass', () => {
  const expiredPass = { decision: 'passed', at: now - 24 * 60 * 60_000, reviewRevision: 'old-revision' };
  assert.equal(canPass({ status: 'HARD_REJECT' }, expiredPass, now), true);
  assert.equal(canPass({ status: 'HARD_REJECT' }, null, now), false);
  assert.equal(canPass(freshChainCandidate, null, now), true);
  assert.equal(canPass({ ...freshChainCandidate, auditedAt: now - 10 * 60_000 - 1 }, null, now), false);
});

test('the dashboard imports the extracted manual review decision module', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /import\('\/manual-review\.mjs'\)/);
  assert.doesNotMatch(html, /function backendDisposition\(row\)/);
});

test('a local-file launch initializes before the server-only module import', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /if \(location\.protocol === 'file:'\) initializeDashboard\(\);\n    else import\('\/manual-review\.mjs'\)/);
});
