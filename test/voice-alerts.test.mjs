import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceAlerts, voiceEligible, voiceKey, VOICE_TTL } from '../public/voice-alerts.mjs';

const now = 1_800_000_000_000;
const row = (address = '0x' + 'a'.repeat(40), at = now) => ({ address, chain: 'bsc',
  status: 'LIVE_READY', qualified: true, auditedAt: at, staleAt: at + 600000 });
const snapshot = rows => ({ chains: { bsc: rows } });

test('quiet baseline, newly audited promotion, duplicate suppression and downgrade cancellation', () => {
  const tracker = new VoiceAlerts(); tracker.reset(now);
  const old = row(), pending = { ...row('pending'), status: 'WAIT_RECHECK', qualified: false };
  tracker.ingest(snapshot([old, pending]), now);
  assert.equal(tracker.batch({}, now).length, 0);
  const promoted = row('pending', now + 1000);
  tracker.ingest(snapshot([old, promoted]), now + 1000);
  assert.deepEqual(tracker.batch({}, now + 1000), [promoted]);
  tracker.ingest(snapshot([old, pending]), now + 2000);
  assert.equal(tracker.batch({}, now + 2000).length, 0);
  tracker.ingest(snapshot([old, promoted]), now + 3000);
  tracker.acknowledge([promoted], now + 3000);
  tracker.ingest(snapshot([old, promoted]), now + 4000);
  assert.equal(tracker.batch({}, now + 4000).length, 0);
});

test('fresh unified live candidates alert once while incomplete or stale live rows stay quiet', () => {
  const tracker = new VoiceAlerts(); tracker.reset(now);
  tracker.ingest(snapshot([]), now);
  const live = { ...row('live', now + 1000), source: 'live', status: 'LIVE_READY' };
  tracker.ingest(snapshot([live]), now + 1000);
  assert.deepEqual(tracker.batch({}, now + 1000), [live]);
  tracker.acknowledge([live], now + 1000);
  tracker.ingest(snapshot([{ ...live, auditedAt: now + 2000 }]), now + 2000);
  assert.equal(tracker.batch({}, now + 2000).length, 0);
  assert.equal(voiceEligible({ ...live, status: 'LIVE_WAIT', qualified: false }, now + 1000), false);
  assert.equal(voiceEligible({ ...live, staleAt: now + 999 }, now + 1000), false);
});

test('stale, ignored, unknown, failed, future and unaudited-before-enable candidates never alert', () => {
  const tracker = new VoiceAlerts(); tracker.reset(now);
  tracker.ingest(snapshot([]), now);
  const rows = [row('old', now - 1), { ...row('stale'), staleAt: now },
    { ...row('failed'), qualified: false }, row('future', now + 5000), row('ignored')];
  tracker.ingest(snapshot(rows), now, r => r.address === 'ignored');
  assert.equal(tracker.batch({}, now).length, 0);
  assert.equal(voiceEligible(row('too-old', now - 601000), now), false);
  tracker.reset(now + 10000);
  tracker.ingest(snapshot([row('restart', now + 10000)]), now + 10000);
  assert.equal(tracker.batch({}, now + 10000).length, 0);
});

test('identity and cross-tab persisted dedupe respect chain and ignore address case', () => {
  assert.equal(voiceKey(row('0xAa')), voiceKey(row('0xaa')));
  assert.notEqual(voiceKey(row('same')), voiceKey({ chain: 'arc', address: 'same' }));
  const tracker = new VoiceAlerts(); tracker.reset(now); tracker.ingest(snapshot([]), now);
  const candidate = row('a', now + 1); tracker.ingest(snapshot([candidate]), now + 1);
  assert.equal(tracker.batch({ [voiceKey(candidate)]: now }, now + 1).length, 0);
  tracker.ingest(snapshot([row('a', now + VOICE_TTL + 1)]), now + VOICE_TTL + 1);
  assert.equal(tracker.batch({}, now + VOICE_TTL + 1).length, 0);
});

test('continuous qualification and regular reaudits do not re-alert during the seven-day window', () => {
  const tracker = new VoiceAlerts(); tracker.reset(now); tracker.ingest(snapshot([row()]), now);
  for (const offset of [VOICE_TTL - 1, VOICE_TTL + 1, 2 * VOICE_TTL + 1]) {
    tracker.ingest(snapshot([row(undefined, now + offset)]), now + offset);
    assert.equal(tracker.batch({}, now + offset).length, 0);
  }
});
