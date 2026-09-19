import test from 'node:test';
import assert from 'node:assert/strict';
import {
  publicCandidate,
  publicChecks,
  publicError,
  publicMessage,
  publicSecondary,
  toPublicStatus
} from '../src/render/whitelist.mjs';
import { toPublicStatus as serverPublicStatus } from '../src/server.mjs';

test('render whitelist exposes the public serializers and preserves server status output', () => {
  const source = {
    status: 'ERROR',
    activeChain: 'bsc',
    supportedChains: ['bsc', 'not-real'],
    candidates: [{
      address: '0x1111111111111111111111111111111111111111', chain: 'bsc', symbol: 'DOG',
      deep: { chartRisk: { version: 1 }, checks: { tax: true } },
      secondary: { status: 'COMPLETE', sources: {}, market: {}, security: { fields: {} } }
    }],
    auditQueue: [{ private: 'must-not-leak' }]
  };

  assert.deepEqual(toPublicStatus(source), serverPublicStatus(source));
  assert.deepEqual(Object.keys(toPublicStatus(source)), [
    'version', 'status', 'error', 'retryAt', 'generatedAt', 'lastAttemptAt', 'lastSuccessAt',
    'nextCycleAt', 'lastCompleteSuccessAt', 'cycleStartedAt', 'scanInProgress', 'lastCycleMs',
    'scanCount', 'discoveredCount', 'prequalifiedCount', 'activeChain', 'pendingChain',
    'supportedChains', 'candidates', 'rejected', 'events', 'xCapability', 'sourceHealth',
    'auditQueueStats', 'outcomeSummary', 'policy'
  ]);
  assert.equal(JSON.stringify(toPublicStatus(source)).includes('must-not-leak'), false);
});

test('render whitelist retains exact redaction and secondary field allowlists', () => {
  for (const message of ['api key=secret', 'Bearer secret', 'private-key=secret', 'passphrase=secret', `gmgn_${'a'.repeat(8)}`]) {
    assert.equal(publicMessage(message, 'safe'), 'safe');
  }
  assert.equal(publicMessage('ordinary state', 'safe'), 'ordinary state');
  assert.equal(publicError('RATE_LIMITED'), 'GMGN请求频率超限，系统将自动等待并重试。');
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
