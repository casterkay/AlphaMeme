import test from 'node:test';
import assert from 'node:assert/strict';
import {
  publicCandidate,
  publicChecks,
  publicMessage,
  publicSecondary
} from '../src/render/whitelist.mjs';

test('render whitelist retains exact redaction and secondary field allowlists', () => {
  for (const message of ['api key=secret', 'Bearer secret', 'private-key=secret', 'passphrase=secret']) {
    assert.equal(publicMessage(message, 'safe'), 'safe');
  }
  assert.equal(publicMessage('ordinary state', 'safe'), 'ordinary state');
  assert.deepEqual(publicChecks({ tax: true, rug: 'true' }), {
    openSource: false, ownerRenounced: false, lpLocked: false, notHoneypot: false, tax: true,
    rug: false, concentration: false, dev: false, insider: false, bundler: false, sniper: false,
    wash: false, liquidity: false, wallets: false, observation: false, chartRisk: false,
    marketBehavior: false
  });
  assert.deepEqual(publicSecondary({
    status: 'COMPLETE', unexpected: 'must-not-leak', sources: {}, market: {},
    security: { fields: { isHoneypot: false, unexpected: true } }
  }).security.fields, { isHoneypot: false });
  assert.equal(publicCandidate({ address: 'token', deep: { chartRisk: { version: 0 } } }).address, 'token');
});

test('the public audit keeps verdicts, unrun checks and facts, but not its ruleset id or anything malformed', () => {
  const audit = publicSecondary({ audit: {
    ruleset: 'rs-12345678', at: 5, verdicts: { TOP10_CONCENTRATED: 'HIT', LP_NOT_LOCKED: 'maybe', 'bad id': 'CLEAR' }, notRun: ['RUG_RATIO', '<b>'],
    evidence: { top10Rate: .42, lpLockedRate: 'x', creatorRate: null, ownerRenounced: true, creatorHoneypots: 'no', liquidity: 5_000, holders: [{ address: '0x1' }] }
  } }).audit;
  assert.deepEqual(audit, { verdicts: { TOP10_CONCENTRATED: 'HIT' }, notRun: ['RUG_RATIO'],
    evidence: { lpLockedRate: null, top10Rate: .42, creatorRate: null, ownerRenounced: true, creatorHoneypots: null, liquidity: 5_000 } });
  assert.equal('audit' in publicSecondary({ status: 'COMPLETE' }), false);
});
