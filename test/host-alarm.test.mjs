import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { ALARM_RETRY_LIMIT, AlarmRunner } from '../src/host/alarm.mjs';
import { hostEntries, initializeHostSchema } from '../src/host/state.mjs';
import { sqliteStorage } from '../src/host/storage.mjs';

const flush = async () => {
  for (let turn = 0; turn < 5; turn += 1) await new Promise(resolve => setImmediate(resolve));
};

// Mocked timers and clock from 0, and one host database the runners share as a restart would.
function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const storage = sqliteStorage(new DatabaseSync(':memory:'));
  initializeHostSchema(storage);
  const entries = hostEntries(storage, 'host');
  const runners = [];
  const runner = handler => {
    const created = new AlarmRunner({ entries, key: 'radar.alarm', handler });
    runners.push(created);
    return created;
  };
  t.after(() => Promise.all(runners.map(created => created.stop())));
  const advance = async ms => {
    await flush();
    t.mock.timers.tick(ms);
    await flush();
  };
  return { entries, runner, advance };
}

test('a persisted alarm is re-armed on boot and fires at its time', async t => {
  const { runner, advance } = fixture(t);
  const before = runner(() => assert.fail('the stopped runner must not fire'));
  before.start();
  before.setAlarm(5_000);
  await before.stop();

  const fired = [];
  const after = runner(() => fired.push(Date.now()));
  after.start();
  await advance(4_999);
  assert.deepEqual(fired, []);
  await advance(1);
  assert.deepEqual(fired, [5_000]);
  assert.equal(after.getAlarm(), null, 'a completed alarm is cleared');
});

test('an alarm past due at boot fires at once', async t => {
  const { entries, runner, advance } = fixture(t);
  entries.put('radar.alarm', -60_000);
  let fired = 0;
  runner(() => { fired += 1; }).start();
  await advance(0);
  assert.equal(fired, 1);
});

test('an alarm set while the handler runs waits for it to finish and is kept', async t => {
  const { runner, advance } = fixture(t);
  let active = 0, maxActive = 0, calls = 0, release;
  const alarm = runner(async () => {
    calls += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    if (calls === 1) {
      alarm.setAlarm(Date.now());
      await new Promise(resolve => { release = resolve; });
    }
    active -= 1;
  });
  alarm.start();
  alarm.setAlarm(0);
  await advance(0);
  await advance(1_000);
  assert.equal(calls, 1, 'the due alarm waits while the first run is in progress');
  release();
  await advance(0);
  assert.equal(calls, 2);
  assert.equal(maxActive, 1);
});

test('a failing alarm is retried after 2 s doubling, six times, then dropped', async t => {
  const { runner, advance } = fixture(t);
  const attempts = [];
  const alarm = runner(() => {
    attempts.push(Date.now());
    throw new Error('step failed');
  });
  t.mock.method(console, 'error', () => {});
  alarm.start();
  alarm.setAlarm(0);
  for (let elapsed = 0; elapsed <= 200_000; elapsed += 1_000) await advance(1_000);
  assert.equal(attempts.length, 1 + ALARM_RETRY_LIMIT);
  assert.deepEqual(attempts.slice(1).map((at, index) => at - attempts[index]), [2_000, 4_000, 8_000, 16_000, 32_000, 64_000]);
  assert.equal(alarm.getAlarm(), null);
});

test('a retry is not later than an alarm the failed run set', async t => {
  const { runner, advance } = fixture(t);
  const attempts = [];
  const alarm = runner(() => {
    attempts.push(Date.now());
    if (attempts.length === 1) {
      alarm.setAlarm(Date.now() + 60_000);
      throw new Error('step failed');
    }
  });
  t.mock.method(console, 'error', () => {});
  alarm.start();
  alarm.setAlarm(0);
  await advance(0);
  assert.equal(alarm.getAlarm(), 2_000);
  await advance(2_000);
  assert.deepEqual(attempts, [0, 2_000]);
});
