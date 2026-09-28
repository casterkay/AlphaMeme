import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AVE_MINIMUM_GAP_MS,
  AveAdmissionError,
  activateAveKey,
  aveCreditsUsed,
  aveReadyAt,
  budgetPeriod,
  defaultAveAdmission,
  parseAveBudget,
  recordAveResponse,
  releaseAveKey,
  reserveAveRequest,
  validateAveAdmission
} from '../src/ave-admission.mjs';
import { AveError } from '../src/providers/ave.mjs';

const JANUARY = Date.UTC(2026, 0, 1);
const FEBRUARY = Date.UTC(2026, 1, 1);
const MARCH = Date.UTC(2026, 2, 1);
const BUDGET = Object.freeze({ monthlyCu: 1_000_000, resetDay: 1 });

function admission(overrides = {}) {
  return { ...defaultAveAdmission(), ...overrides };
}

function isAdmissionError(code) {
  return error => error instanceof AveAdmissionError && error.code === code;
}

test('parseAveBudget reads the plan allowance and reset day from Worker vars', () => {
  const budget = parseAveBudget({ AVE_MONTHLY_CU: '1000000', AVE_CU_RESET_DAY: '1' });
  assert.deepEqual(budget, { monthlyCu: 1_000_000, resetDay: 1 });
  assert.equal(Object.isFrozen(budget), true);
  assert.deepEqual(parseAveBudget({ AVE_MONTHLY_CU: 100, AVE_CU_RESET_DAY: 28 }), { monthlyCu: 100, resetDay: 28 });
});

test('parseAveBudget refuses allowances and reset days that are not plan values', () => {
  const invalid = [
    {},
    { AVE_CU_RESET_DAY: '1' },
    { AVE_MONTHLY_CU: '', AVE_CU_RESET_DAY: '1' },
    { AVE_MONTHLY_CU: '   ', AVE_CU_RESET_DAY: '1' },
    { AVE_MONTHLY_CU: '99', AVE_CU_RESET_DAY: '1' },
    { AVE_MONTHLY_CU: '1000.5', AVE_CU_RESET_DAY: '1' },
    { AVE_MONTHLY_CU: 'unlimited', AVE_CU_RESET_DAY: '1' },
    { AVE_MONTHLY_CU: '1000000' },
    { AVE_MONTHLY_CU: '1000000', AVE_CU_RESET_DAY: '0' },
    { AVE_MONTHLY_CU: '1000000', AVE_CU_RESET_DAY: '29' },
    { AVE_MONTHLY_CU: '1000000', AVE_CU_RESET_DAY: '1.5' }
  ];
  for (const vars of invalid) {
    assert.throws(() => parseAveBudget(vars), isAdmissionError('AVE_BUDGET_CONFIG_INVALID'), JSON.stringify(vars));
  }
});

test('budgetPeriod spans UTC reset days, including across a year boundary', () => {
  const cases = [
    { now: Date.UTC(2026, 1, 15), resetDay: 1, startAt: FEBRUARY, endAt: MARCH },
    { now: FEBRUARY, resetDay: 1, startAt: FEBRUARY, endAt: MARCH },
    { now: FEBRUARY - 1, resetDay: 1, startAt: JANUARY, endAt: FEBRUARY },
    { now: Date.UTC(2026, 0, 10), resetDay: 15, startAt: Date.UTC(2025, 11, 15), endAt: Date.UTC(2026, 0, 15) },
    { now: Date.UTC(2026, 0, 15), resetDay: 15, startAt: Date.UTC(2026, 0, 15), endAt: Date.UTC(2026, 1, 15) },
    { now: Date.UTC(2026, 11, 20), resetDay: 15, startAt: Date.UTC(2026, 11, 15), endAt: Date.UTC(2027, 0, 15) },
    { now: Date.UTC(2028, 1, 29, 12), resetDay: 28, startAt: Date.UTC(2028, 1, 28), endAt: Date.UTC(2028, 2, 28) }
  ];
  for (const { now, resetDay, startAt, endAt } of cases) {
    assert.deepEqual(budgetPeriod(now, { resetDay }), { startAt, endAt }, new Date(now).toISOString());
  }
});

test('a reservation spends its credits and keeps the next request at least 15 seconds away', () => {
  const { reserved, state } = reserveAveRequest(JANUARY, admission(), 5, BUDGET);

  assert.equal(reserved, true);
  assert.equal(AVE_MINIMUM_GAP_MS, 15_000);
  assert.deepEqual(state, admission({
    periodStartAt: JANUARY, cuUsed: 5, lastRequestAt: JANUARY, spacingReadyAt: JANUARY + 15_000
  }));
  assert.equal(aveReadyAt(state), JANUARY + 15_000);
});

test('pacing spreads the remaining credits over the rest of the allowance period', () => {
  const januaryMs = FEBRUARY - JANUARY;

  // 1,000,000 CU over 31 days paces a 5 CU request at ~13.4 s, under the 15 s floor.
  assert.equal(Math.ceil(5 * januaryMs / 1_000_000), 13_392);
  assert.equal(reserveAveRequest(JANUARY, admission(), 5, BUDGET).state.spacingReadyAt, JANUARY + 15_000);

  // With 1,000 CU left the same request must wait 5/1000 of the month.
  const scarce = admission({ periodStartAt: JANUARY, cuUsed: 999_000 });
  assert.equal(reserveAveRequest(JANUARY, scarce, 5, BUDGET).state.spacingReadyAt, JANUARY + Math.ceil(5 * januaryMs / 1_000));

  // The same credits left one day before the reset allow a shorter gap.
  const lastDay = FEBRUARY - 86_400_000;
  assert.equal(reserveAveRequest(lastDay, scarce, 5, BUDGET).state.spacingReadyAt, lastDay + Math.ceil(5 * 86_400_000 / 1_000));

  // A costlier request waits proportionally longer.
  assert.equal(reserveAveRequest(JANUARY, scarce, 10, BUDGET).state.spacingReadyAt, JANUARY + Math.ceil(10 * januaryMs / 1_000));
});

test('the rate-limit backoff factor multiplies the reserved gap', () => {
  const { state } = reserveAveRequest(JANUARY, admission({ backoffFactor: 4 }), 5, BUDGET);
  assert.equal(state.spacingReadyAt, JANUARY + 4 * 15_000);
});

test('a request that would overspend the allowance is refused and blocks admission until the period ends', () => {
  const nearlySpent = admission({ periodStartAt: JANUARY, cuUsed: BUDGET.monthlyCu - 4 });
  const refused = reserveAveRequest(JANUARY + 1_000, nearlySpent, 5, BUDGET);

  assert.equal(refused.reserved, false);
  assert.equal(refused.state.cuUsed, BUDGET.monthlyCu - 4);
  assert.equal(refused.state.blockReason, 'BUDGET');
  assert.equal(refused.state.blockedUntil, FEBRUARY);
  assert.equal(aveReadyAt(refused.state), FEBRUARY);
  assert.throws(() => reserveAveRequest(FEBRUARY - 1, refused.state, 5, BUDGET), isAdmissionError('AVE_RESERVATION_INVALID'));

  const renewed = reserveAveRequest(FEBRUARY, refused.state, 5, BUDGET);
  assert.equal(renewed.reserved, true);
  assert.equal(renewed.state.periodStartAt, FEBRUARY);
  assert.equal(renewed.state.cuUsed, 5);
  assert.equal(renewed.state.blockReason, null);
});

test('a request that spends exactly the remaining credits is admitted and paced to the period end', () => {
  const now = JANUARY + 86_400_000;
  const { reserved, state } = reserveAveRequest(now, admission({ periodStartAt: JANUARY, cuUsed: BUDGET.monthlyCu - 5 }), 5, BUDGET);
  assert.equal(reserved, true);
  assert.equal(state.cuUsed, BUDGET.monthlyCu);
  assert.equal(state.spacingReadyAt, FEBRUARY);
});

test('the first reservation in a new period resets the spent credits', () => {
  const lastMonth = admission({ periodStartAt: JANUARY, cuUsed: 777_000, lastRequestAt: FEBRUARY - 60_000, spacingReadyAt: FEBRUARY - 45_000 });
  const { reserved, state } = reserveAveRequest(FEBRUARY + 3_600_000, lastMonth, 5, BUDGET);
  assert.equal(reserved, true);
  assert.equal(state.periodStartAt, FEBRUARY);
  assert.equal(state.cuUsed, 5);
});

test('a reservation is refused before admission is ready or for a non-positive or fractional cost', () => {
  const spaced = admission({ spacingReadyAt: JANUARY + 1 });
  const blocked = admission({ blockedUntil: JANUARY + 1, blockReason: 'RATE_LIMITED' });
  assert.throws(() => reserveAveRequest(JANUARY, spaced, 5, BUDGET), isAdmissionError('AVE_RESERVATION_INVALID'));
  assert.throws(() => reserveAveRequest(JANUARY, blocked, 5, BUDGET), isAdmissionError('AVE_RESERVATION_INVALID'));
  for (const cost of [0, -5, 1.5, Number.NaN]) {
    assert.throws(() => reserveAveRequest(JANUARY, admission(), cost, BUDGET), isAdmissionError('AVE_RESERVATION_INVALID'), String(cost));
  }
});

test('a constant-cost plan requested as soon as ready spends exactly its allowance each period and is never refused', () => {
  const budget = { monthlyCu: 100, resetDay: 1 };
  let state = admission();
  let now = JANUARY;
  const spentByPeriod = new Map();
  while (now < Date.UTC(2026, 3, 1)) {
    const reservation = reserveAveRequest(now, state, 5, budget);
    assert.equal(reservation.reserved, true, `refused at ${new Date(now).toISOString()}`);
    state = reservation.state;
    spentByPeriod.set(state.periodStartAt, (spentByPeriod.get(state.periodStartAt) || 0) + 5);
    now = aveReadyAt(state);
  }
  assert.deepEqual([...spentByPeriod], [[JANUARY, 100], [FEBRUARY, 100], [MARCH, 100]]);
});

test('property: reserved credits never exceed the allowance of any period under arbitrary traffic and refusals', () => {
  let seed = 0x2f6b1d;
  const random = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  const budget = { monthlyCu: 1_000, resetDay: 7 };
  let state = admission();
  let now = JANUARY;
  const spentByPeriod = new Map();
  let refusals = 0;
  for (let step = 0; step < 5_000; step += 1) {
    now = Math.max(now, aveReadyAt(state)) + Math.floor(random() * (random() < 0.05 ? 20 * 86_400_000 : 60_000));
    const cost = [5, 5, 10, 25, 400][Math.floor(random() * 5)];
    const before = state;
    const reservation = reserveAveRequest(now, state, cost, budget);
    state = validateAveAdmission(reservation.state);
    if (reservation.reserved) {
      assert.ok(state.spacingReadyAt - now >= AVE_MINIMUM_GAP_MS * before.backoffFactor);
      spentByPeriod.set(state.periodStartAt, (spentByPeriod.get(state.periodStartAt) || 0) + cost);
    } else {
      refusals += 1;
      assert.equal(state.blockReason, 'BUDGET');
      assert.equal(state.blockedUntil, budgetPeriod(now, budget).endAt);
    }
    assert.ok(state.cuUsed <= budget.monthlyCu);
    assert.equal(state.cuUsed, spentByPeriod.get(state.periodStartAt) || 0);
    const roll = random();
    if (roll < 0.03) state = recordAveResponse(now, state, new AveError('RATE_LIMITED', 429, now + Math.floor(random() * 600_000)), budget);
    else if (roll < 0.04) state = recordAveResponse(now, state, new AveError('QUOTA', 402), budget);
    else state = recordAveResponse(now, state, null, budget);
  }
  assert.ok(refusals > 0, 'the traffic mix should exercise budget refusals');
  for (const [startAt, spent] of spentByPeriod) assert.ok(spent <= budget.monthlyCu, `period ${new Date(startAt).toISOString()} spent ${spent}`);
});

test('successes build a streak and 30 in a row halve the backoff factor', () => {
  let state = admission({ backoffFactor: 8 });
  for (let count = 1; count < 30; count += 1) {
    state = recordAveResponse(JANUARY, state, null, BUDGET);
    assert.equal(state.successStreak, count);
    assert.equal(state.backoffFactor, 8);
  }
  state = recordAveResponse(JANUARY, state, null, BUDGET);
  assert.equal(state.backoffFactor, 4);
  assert.equal(state.successStreak, 0);

  const recovered = recordAveResponse(JANUARY, admission({ successStreak: 29 }), null, BUDGET);
  assert.equal(recovered.backoffFactor, 1);
});

test('a rate limit doubles the backoff up to 8 and blocks for the scaled cooldown', () => {
  let state = admission({ successStreak: 12 });
  const expected = [[2, 120_000], [4, 240_000], [8, 480_000], [8, 480_000]];
  for (const [backoffFactor, cooldownMs] of expected) {
    state = recordAveResponse(JANUARY, state, new AveError('RATE_LIMITED', 429), BUDGET);
    assert.equal(state.backoffFactor, backoffFactor);
    assert.equal(state.blockedUntil, JANUARY + cooldownMs);
    assert.equal(state.blockReason, 'RATE_LIMITED');
    assert.equal(state.successStreak, 0);
  }
});

test('a rate limit honors a Retry-After later than the cooldown but never shortens an existing block', () => {
  const retryAt = JANUARY + 900_000;
  assert.equal(recordAveResponse(JANUARY, admission(), new AveError('RATE_LIMITED', 429, retryAt), BUDGET).blockedUntil, retryAt);
  assert.equal(recordAveResponse(JANUARY, admission(), new AveError('RATE_LIMITED', 429, JANUARY + 5_000), BUDGET).blockedUntil, JANUARY + 120_000);

  const alreadyBlocked = admission({ blockedUntil: JANUARY + 2_000_000, blockReason: 'RATE_LIMITED' });
  assert.equal(recordAveResponse(JANUARY, alreadyBlocked, new AveError('RATE_LIMITED', 429), BUDGET).blockedUntil, JANUARY + 2_000_000);
});

test('an exhausted AVE quota blocks admission until the allowance period ends', () => {
  const state = recordAveResponse(Date.UTC(2026, 0, 20), admission({ backoffFactor: 2, successStreak: 5 }), new AveError('QUOTA', 402), BUDGET);
  assert.equal(state.blockReason, 'QUOTA');
  assert.equal(state.blockedUntil, FEBRUARY);
  assert.equal(state.backoffFactor, 2);
  assert.equal(state.successStreak, 0);
  assert.equal(aveReadyAt(state), FEBRUARY);
});

test('other AVE failures only reset the success streak', () => {
  for (const kind of ['UPSTREAM', 'TIMEOUT', 'AUTH']) {
    const before = admission({ backoffFactor: 2, successStreak: 7, spacingReadyAt: JANUARY + 15_000 });
    assert.deepEqual(recordAveResponse(JANUARY, before, new AveError(kind), BUDGET), { ...before, successStreak: 0 }, kind);
  }
});

test('activating a new key starts a fresh epoch with its own allowance and no blocks, keeping request spacing', () => {
  const blocked = admission({
    keyEpoch: 3, periodStartAt: JANUARY, cuUsed: 400, lastRequestAt: JANUARY, spacingReadyAt: JANUARY + 15_000,
    blockedUntil: FEBRUARY, blockReason: 'QUOTA', backoffFactor: 8, successStreak: 4
  });
  const activated = activateAveKey(blocked);
  assert.deepEqual(activated, {
    ...blocked, keyEpoch: 4, cuUsed: 0, blockedUntil: 0, blockReason: null, backoffFactor: 1, successStreak: 0
  });
  assert.equal(aveReadyAt(activated), JANUARY + 15_000);
});

test('releasing a key drops its cooldowns but keeps its epoch, spending and spacing', () => {
  const blocked = admission({
    keyEpoch: 3, periodStartAt: JANUARY, cuUsed: 400, lastRequestAt: JANUARY, spacingReadyAt: JANUARY + 15_000,
    blockedUntil: FEBRUARY, blockReason: 'RATE_LIMITED', backoffFactor: 4, successStreak: 2
  });
  assert.deepEqual(releaseAveKey(blocked), { ...blocked, blockedUntil: 0, blockReason: null, backoffFactor: 1, successStreak: 0 });
});

test('a candidate key read waits only for spacing and neither spends nor clears the active key allowance', () => {
  for (const blockReason of ['QUOTA', 'BUDGET', 'RATE_LIMITED']) {
    const blocked = admission({
      periodStartAt: JANUARY, cuUsed: BUDGET.monthlyCu, lastRequestAt: JANUARY, spacingReadyAt: JANUARY + 15_000,
      blockedUntil: FEBRUARY, blockReason, backoffFactor: 2
    });
    const now = JANUARY + 15_000;
    assert.equal(aveReadyAt(blocked, { candidateKey: true }), now, blockReason);
    assert.equal(aveReadyAt(blocked), FEBRUARY, blockReason);
    assert.throws(() => reserveAveRequest(now - 1, blocked, 5, BUDGET, { candidateKey: true }), { code: 'AVE_RESERVATION_INVALID' });
    assert.deepEqual(reserveAveRequest(now, blocked, 5, BUDGET, { candidateKey: true }), {
      reserved: true,
      state: { ...blocked, lastRequestAt: now, spacingReadyAt: now + AVE_MINIMUM_GAP_MS }
    }, blockReason);
  }
});

test('a candidate key read keeps at least the minimum gap after the active key paced read', () => {
  const paced = admission({ periodStartAt: JANUARY, lastRequestAt: JANUARY, spacingReadyAt: JANUARY + 600_000 });
  const { state } = reserveAveRequest(JANUARY + 600_000, paced, 5, BUDGET, { candidateKey: true });
  assert.equal(state.spacingReadyAt, JANUARY + 600_000 + AVE_MINIMUM_GAP_MS);
});

test('credits used report zero once the period containing now is later than the recorded one', () => {
  assert.equal(aveCreditsUsed(FEBRUARY - 1, { periodStartAt: JANUARY, cuUsed: 400 }, BUDGET), 400);
  assert.equal(aveCreditsUsed(FEBRUARY, { periodStartAt: JANUARY, cuUsed: 400 }, BUDGET), 0);
  assert.equal(aveCreditsUsed(JANUARY, { periodStartAt: FEBRUARY, cuUsed: 400 }, BUDGET), 400);
});

test('admission state with unknown fields, reasons, or backoff factors is refused', () => {
  const invalid = [
    null,
    { ...admission(), extra: 1 },
    (({ cuUsed: _cuUsed, ...rest }) => rest)(admission()),
    admission({ blockReason: 'PAUSED' }),
    admission({ backoffFactor: 0 }),
    admission({ backoffFactor: 16 }),
    admission({ cuUsed: -1 }),
    admission({ spacingReadyAt: 1.5 })
  ];
  for (const state of invalid) {
    assert.throws(() => validateAveAdmission(state), isAdmissionError('AVE_ADMISSION_INVALID'), JSON.stringify(state));
    assert.throws(() => recordAveResponse(JANUARY, state, null, BUDGET), isAdmissionError('AVE_ADMISSION_INVALID'));
  }
});

test('a clock that steps back across a reset keeps the later period and its spending', () => {
  const budget = parseAveBudget({ AVE_MONTHLY_CU: '100', AVE_CU_RESET_DAY: '1' });
  const march = Date.UTC(2026, 2, 1, 0, 1);
  const spent = reserveAveRequest(march, defaultAveAdmission(), 100, budget).state;
  const earlier = Date.UTC(2026, 1, 27);
  const { reserved, state } = reserveAveRequest(earlier, { ...spent, spacingReadyAt: 0 }, 5, budget);
  assert.equal(reserved, false, 'the earlier period must not grant a second allowance');
  assert.equal(state.periodStartAt, Date.UTC(2026, 2, 1));
  assert.equal(state.cuUsed, 100);
});
