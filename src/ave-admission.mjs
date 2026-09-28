// Durable per-tenant AVE admission. Every AVE request is reserved here before
// it is sent: requests keep at least MINIMUM_GAP_MS apart, and are paced so the
// credits left in the plan's monthly allowance last until it resets. A refusal
// from AVE blocks further requests: a rate limit until its cooldown ends, an
// exhausted quota until the allowance resets.
export const AVE_MINIMUM_GAP_MS = 15_000;
const RATE_LIMIT_COOLDOWN_MS = 60_000;
const MAX_BACKOFF_FACTOR = 8;
const RECOVERY_STREAK = 30;
const BLOCK_REASONS = new Set(['RATE_LIMITED', 'QUOTA', 'BUDGET']);

export class AveAdmissionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AveAdmissionError';
    this.code = code;
  }
}

function isTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/** The plan's monthly allowance and its UTC reset day, from the Worker's vars. */
export function parseAveBudget({ AVE_MONTHLY_CU: monthly, AVE_CU_RESET_DAY: resetDay } = {}) {
  const monthlyCu = Number(monthly), day = Number(resetDay);
  if (!Number.isSafeInteger(monthlyCu) || monthlyCu < 100 || String(monthly).trim() === '') {
    throw new AveAdmissionError('AVE_BUDGET_CONFIG_INVALID', 'AVE_MONTHLY_CU must be the plan allowance in credit units');
  }
  if (!Number.isSafeInteger(day) || day < 1 || day > 28) {
    throw new AveAdmissionError('AVE_BUDGET_CONFIG_INVALID', 'AVE_CU_RESET_DAY must be a day of the month from 1 to 28');
  }
  return Object.freeze({ monthlyCu, resetDay: day });
}

/** The allowance period containing now: [startAt, endAt) between UTC reset days. */
export function budgetPeriod(now, { resetDay }) {
  const date = new Date(now);
  const year = date.getUTCFullYear(), month = date.getUTCMonth();
  const thisMonth = Date.UTC(year, month, resetDay);
  const startAt = now >= thisMonth ? thisMonth : Date.UTC(year, month - 1, resetDay);
  const start = new Date(startAt);
  return { startAt, endAt: Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, resetDay) };
}

export function defaultAveAdmission() {
  return {
    keyEpoch: 0, periodStartAt: 0, cuUsed: 0, lastRequestAt: 0, spacingReadyAt: 0,
    blockedUntil: 0, blockReason: null, backoffFactor: 1, successStreak: 0
  };
}

export function validateAveAdmission(value) {
  const expected = Object.keys(defaultAveAdmission()).sort();
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join() !== expected.join()
    || !isTimestamp(value.keyEpoch) || !isTimestamp(value.periodStartAt) || !isTimestamp(value.cuUsed)
    || !isTimestamp(value.lastRequestAt) || !isTimestamp(value.spacingReadyAt) || !isTimestamp(value.blockedUntil)
    || (value.blockReason !== null && !BLOCK_REASONS.has(value.blockReason))
    || !Number.isInteger(value.backoffFactor) || value.backoffFactor < 1 || value.backoffFactor > MAX_BACKOFF_FACTOR
    || !isTimestamp(value.successStreak)) {
    throw new AveAdmissionError('AVE_ADMISSION_INVALID', 'AVE admission state is invalid');
  }
  return value;
}

export function aveReadyAt(state) {
  validateAveAdmission(state);
  return Math.max(state.spacingReadyAt, state.blockedUntil);
}

function inPeriod(state, period) {
  return state.periodStartAt === period.startAt ? state : { ...state, periodStartAt: period.startAt, cuUsed: 0 };
}

/**
 * Reserve one request of `cost` credit units at `now`. Returns the next state
 * and whether the request may be sent; a request that would overspend the
 * allowance is not sent, and admission stays blocked until the next period.
 */
export function reserveAveRequest(now, state, cost, budget) {
  if (!isTimestamp(now) || !Number.isSafeInteger(cost) || cost <= 0 || aveReadyAt(state) > now) {
    throw new AveAdmissionError('AVE_RESERVATION_INVALID', 'an AVE request cannot be reserved before admission is ready');
  }
  const period = budgetPeriod(now, budget);
  const current = inPeriod(state, period);
  const remaining = budget.monthlyCu - current.cuUsed;
  if (cost > remaining) {
    return { reserved: false, state: { ...current, blockedUntil: period.endAt, blockReason: 'BUDGET' } };
  }
  // Spend no faster than the remaining allowance over the remaining period.
  const pacedGapMs = Math.ceil(cost * (period.endAt - now) / remaining);
  const gapMs = Math.max(AVE_MINIMUM_GAP_MS, pacedGapMs) * current.backoffFactor;
  return {
    reserved: true,
    state: { ...current, cuUsed: current.cuUsed + cost, lastRequestAt: now, spacingReadyAt: now + gapMs, blockReason: null }
  };
}

/** Record how AVE answered a reserved request. */
export function recordAveResponse(now, state, error, budget) {
  validateAveAdmission(state);
  if (!error) {
    const successStreak = state.successStreak + 1;
    return successStreak < RECOVERY_STREAK
      ? { ...state, successStreak }
      : { ...state, successStreak: 0, backoffFactor: Math.max(1, state.backoffFactor / 2) };
  }
  if (error.code === 'AVE_RATE_LIMITED') {
    const backoffFactor = Math.min(MAX_BACKOFF_FACTOR, state.backoffFactor * 2);
    const retryAt = Number.isSafeInteger(error.retryAt) ? error.retryAt : 0;
    const blockedUntil = Math.max(state.blockedUntil, retryAt, now + RATE_LIMIT_COOLDOWN_MS * backoffFactor);
    return { ...state, backoffFactor, successStreak: 0, blockedUntil, blockReason: 'RATE_LIMITED' };
  }
  if (error.code === 'AVE_QUOTA') {
    return { ...state, successStreak: 0, blockedUntil: Math.max(state.blockedUntil, budgetPeriod(now, budget).endAt), blockReason: 'QUOTA' };
  }
  return { ...state, successStreak: 0 };
}

/** A newly activated key starts a fresh credential epoch without cooldowns; spend stays counted. */
export function activateAveKey(state) {
  validateAveAdmission(state);
  return { ...state, keyEpoch: state.keyEpoch + 1, blockedUntil: 0, blockReason: null, backoffFactor: 1, successStreak: 0 };
}
