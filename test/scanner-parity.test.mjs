import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addressKey,
  buildQueue,
  nextAuditDelay,
  publicToken,
  reviewRevision,
  socialFrom,
  twitterHandle
} from '../src/scanner-parity.mjs';

test('Worker parity helpers preserve token normalization, manual social gating, and address identity', () => {
  const token = publicToken({
    address: '0xAbCd000000000000000000000000000000000000',
    symbol: 'A'.repeat(31),
    name: 'N'.repeat(81),
    market_cap: 1,
    liquidity: 2,
    price_usd: '3.5',
    creation_timestamp: 123,
    twitter_username: 'Real_User',
    link: { gmgn: 'https://gmgn.ai/token' },
    holder_count: '4',
    volume: '5',
    buys: '6',
    sells: '7',
    x_follower: '8',
    social_dup: 'yes'
  }, { mc: 100, liquidity: 200, ageSec: 300, priorityBand: true, score: 400 }, 'bsc');

  assert.deepEqual(token, {
    address: '0xAbCd000000000000000000000000000000000000',
    chain: 'bsc',
    symbol: 'A'.repeat(30),
    name: 'N'.repeat(80),
    marketCap: 100,
    liquidity: 200,
    price: 3.5,
    createdAt: 123,
    ageSec: 300,
    priorityBand: true,
    discoveryScore: 400,
    holders: 4,
    volume1h: 5,
    buys: 6,
    sells: 7,
    twitter: 'Real_User',
    gmgnUrl: 'https://gmgn.ai/token',
    socialHints: { followerCount: 8, duplicateSocial: true }
  });
  assert.deepEqual(socialFrom(token), { twitter: 'Real_User', status: 'FAIL', score: 0, reason: '社媒链接疑似复用' });
  assert.equal(addressKey(token.address), token.address.toLowerCase());
  assert.equal(addressKey('So11111111111111111111111111111111111111112'), 'So11111111111111111111111111111111111111112');
  assert.equal(twitterHandle('x.com/search'), '');
});

test('Worker parity queue keeps the existing record and recheck cadence', async () => {
  const now = 1_800_000_000_000;
  const queue = buildQueue([{
    address: '0xAbCd000000000000000000000000000000000000',
    firstSeenAt: now - 10_000,
    lastAuditedAt: now - 2_000,
    nextAuditAt: now + 5_000,
    attempts: 2,
    status: 'WAIT_RECHECK'
  }], [{
    row: { address: '0xabcd000000000000000000000000000000000000', _monitorOnly: true },
    screen: { priorityBand: true, score: 9 }
  }], now, { queueRetentionMs: 20_000 });

  assert.deepEqual(queue, [{
    address: '0xabcd000000000000000000000000000000000000',
    firstSeenAt: now - 10_000,
    lastSeenAt: now,
    lastAuditedAt: now - 2_000,
    nextAuditAt: now + 5_000,
    attempts: 2,
    status: 'WAIT_RECHECK',
    priorityBand: true,
    score: 9,
    watched: true
  }]);
  assert.equal(nextAuditDelay('HARD_REJECT', { hardRejectRecheckMs: 1, chainPassRecheckMs: 2, dynamicRecheckMs: 3 }), 1);
  assert.equal(nextAuditDelay('X_REVIEW', { hardRejectRecheckMs: 1, chainPassRecheckMs: 2, dynamicRecheckMs: 3 }), 2);
  assert.equal(nextAuditDelay('WAIT_RECHECK', { hardRejectRecheckMs: 1, chainPassRecheckMs: 2, dynamicRecheckMs: 3 }), 3);
  assert.equal(await reviewRevision({ status: 'X_REVIEW' }), '9ce7d23cdd4a8246f1930ab3');
});
