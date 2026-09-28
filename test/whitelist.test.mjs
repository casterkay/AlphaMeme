import test from 'node:test';
import assert from 'node:assert/strict';
import {
  publicCandidate,
  publicChecks,
  publicMessage,
  publicSecondary
} from '../src/render/whitelist.mjs';

test('render whitelist retains exact redaction and secondary field allowlists', () => {
  for (const message of ['api key=secret', 'Bearer secret', 'private-key=secret', 'passphrase=secret', `gmgn_${'a'.repeat(8)}`]) {
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
