// Durable trade records: tenant-scoped JSON rows in scheduler_state under
// `trade:<id>`. Every read validates the whole record and fails loudly on a
// malformed one; every write validates first and bumps the revision, so a step
// whose record changed underneath it cannot commit.
import { TRADE_CHAINS } from './config.mjs';
import { TradingError } from './http.mjs';

export const TRADE_STATES = Object.freeze(['QUOTING', 'QUOTED', 'CONFIRMED', 'APPROVE_SIGNED', 'APPROVE_SENT', 'APPROVED', 'SWAP_SIGNED', 'SWAP_SENT', 'FILLED', 'FAILED', 'UNKNOWN', 'EXPIRED', 'CANCELLED']);
export const TERMINAL_STATES = Object.freeze(new Set(['FILLED', 'FAILED', 'UNKNOWN', 'EXPIRED', 'CANCELLED']));
// A wallet executes one trade at a time: from confirmation to a terminal state.
export const EXECUTING_STATES = Object.freeze(new Set(['CONFIRMED', 'APPROVE_SIGNED', 'APPROVE_SENT', 'APPROVED', 'SWAP_SIGNED', 'SWAP_SENT']));
const QUOTE_STEPS = new Set(['token', 'price', 'route', 'build']);
const PREFIX = 'trade:';

const corrupt = reason => new TradingError('TRADE_RECORD_CORRUPT', `trade record is malformed: ${reason}`);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const time = value => Number.isSafeInteger(value) && value >= 0;
const units = value => typeof value === 'string' && /^(0|[1-9]\d{0,77})$/.test(value);
const address = value => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
const hex = value => typeof value === 'string' && /^0x(?:[0-9a-fA-F]{2})+$/.test(value);
const hash = value => typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value);
const usd = value => value === null || (typeof value === 'string' && /^\d{1,40}(\.\d{1,40})?$/.test(value));

function check(condition, reason) { if (!condition) throw corrupt(reason); }

function checkTransaction(tx, label) {
  check(isObject(tx) && hex(tx.raw) && hash(tx.hash) && Number.isSafeInteger(tx.nonce) && tx.nonce >= 0, `${label} transaction`);
  check(tx.sentAt === null || time(tx.sentAt), `${label} sentAt`);
  check(tx.deadlineAt === null || time(tx.deadlineAt), `${label} deadline`);
  check(Number.isSafeInteger(tx.polls) && tx.polls >= 0 && typeof tx.uncertain === 'boolean', `${label} polling`);
  check(tx.rejected === null || typeof tx.rejected === 'string', `${label} rejection`);
  check(tx.minedBlock === null || (typeof tx.minedBlock === 'string' && /^0x[0-9a-f]{1,16}$/.test(tx.minedBlock)), `${label} block`);
  check(tx.fee === null || units(tx.fee), `${label} fee`);
}

/** Validate a parsed record completely; returns it unchanged. */
export function validateTrade(trade) {
  check(isObject(trade) && trade.version === 1, 'version');
  check(typeof trade.id === 'string' && /^[0-9a-f]{32}$/.test(trade.id), 'id');
  check(Number.isSafeInteger(trade.revision) && trade.revision >= 1, 'revision');
  check(Object.hasOwn(TRADE_CHAINS, trade.chain), 'chain');
  check(address(trade.token) && address(trade.wallet) && address(trade.tokenIn) && address(trade.tokenOut), 'addresses');
  check(['buy', 'sell'].includes(trade.side), 'side');
  check(trade.side === 'buy' ? Number.isSafeInteger(trade.usdCents) && trade.usdCents > 0 && trade.percent === null
    : Number.isSafeInteger(trade.percent) && trade.percent >= 1 && trade.percent <= 100 && trade.usdCents === null, 'amount request');
  check(typeof trade.unverifiedAtRequest === 'boolean' && (trade.side === 'buy' || !trade.unverifiedAtRequest), 'unverified acknowledgement');
  check(Number.isSafeInteger(trade.slippageBps) && trade.slippageBps > 0 && trade.slippageBps <= 5000 && Number.isSafeInteger(trade.capUsd) && trade.capUsd > 0, 'settings');
  check(TRADE_STATES.includes(trade.state), 'state');
  check(trade.state === 'QUOTING' ? QUOTE_STEPS.has(trade.step) : trade.step === null, 'quote step');
  check(trade.sessionId === null || (typeof trade.sessionId === 'string' && /^[0-9a-f]{32}$/.test(trade.sessionId)), 'session');
  check(time(trade.createdAt) && time(trade.updatedAt), 'timestamps');
  check(TERMINAL_STATES.has(trade.state) ? trade.nextAt === null : time(trade.nextAt), 'nextAt');
  check(Number.isSafeInteger(trade.errors) && trade.errors >= 0, 'errors');
  check(trade.tokenMeta === null || (isObject(trade.tokenMeta) && Number.isSafeInteger(trade.tokenMeta.decimals) && trade.tokenMeta.decimals >= 0 && trade.tokenMeta.decimals <= 36 && typeof trade.tokenMeta.symbol === 'string'), 'token metadata');
  check(trade.amountIn === null || units(trade.amountIn), 'amountIn');
  check(trade.priceMicroUsd === null || units(trade.priceMicroUsd), 'price');
  check(trade.route === null || isObject(trade.route), 'route');
  const q = trade.quote;
  check(q === null || (isObject(q) && units(q.amountOut) && units(q.minAmountOut) && usd(q.amountInUsd) && usd(q.amountOutUsd) && usd(q.gasUsd)
    && hex(q.data) && units(q.value) && time(q.deadline) && time(q.quotedAt) && time(q.expiresAt)), 'quote');
  check(trade.confirmedAt === null || time(trade.confirmedAt), 'confirmedAt');
  check(trade.confirmedMinAmountOut === null || units(trade.confirmedMinAmountOut), 'confirmed minimum');
  check(trade.recheckAt === null || (trade.state === 'UNKNOWN' && time(trade.recheckAt)), 'recheck');
  if (trade.approval !== null) checkTransaction(trade.approval, 'approval');
  if (trade.swap !== null) checkTransaction(trade.swap, 'swap');
  check(trade.result === null || (isObject(trade.result) && (trade.result.reason === null || typeof trade.result.reason === 'string')
    && [trade.result.received, trade.result.spent, trade.result.needed].every(value => value === null || units(value))), 'result');
  const after = states => states.includes(trade.state);
  if (after(['QUOTED', 'CONFIRMED', 'APPROVE_SIGNED', 'APPROVE_SENT', 'APPROVED', 'SWAP_SIGNED', 'SWAP_SENT', 'FILLED'])) check(q !== null && trade.tokenMeta !== null && trade.amountIn !== null, 'quoted state without quote');
  if (EXECUTING_STATES.has(trade.state) || trade.state === 'FILLED') check(trade.confirmedAt !== null && trade.confirmedMinAmountOut !== null, 'executing state without confirmation');
  if (after(['APPROVE_SIGNED', 'APPROVE_SENT'])) check(trade.approval !== null, 'approval state without approval');
  if (trade.state === 'APPROVE_SENT') check(trade.approval.sentAt !== null && trade.approval.deadlineAt !== null, 'approval not sent');
  if (after(['SWAP_SIGNED', 'SWAP_SENT', 'FILLED'])) check(trade.swap !== null, 'swap state without swap');
  if (after(['SWAP_SENT', 'FILLED'])) check(trade.swap.sentAt !== null && trade.swap.deadlineAt !== null, 'swap not sent');
  if (after(['FILLED', 'FAILED', 'UNKNOWN'])) check(trade.result !== null, 'terminal state without result');
  return trade;
}

function parse(row) {
  let value;
  try { value = JSON.parse(row.value_json); } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw corrupt('not JSON');
  }
  validateTrade(value);
  if (`${PREFIX}${value.id}` !== row.key) throw corrupt('key and id differ');
  return value;
}

export function readTrade(storage, tenantId, id) {
  const row = storage.sql.exec('SELECT key,value_json FROM scheduler_state WHERE tenant_id=? AND key=?', tenantId, `${PREFIX}${id}`).toArray()[0];
  return row ? parse(row) : null;
}

/** Every trade of the tenant, newest first. */
export function listTrades(storage, tenantId) {
  return storage.sql.exec("SELECT key,value_json FROM scheduler_state WHERE tenant_id=? AND substr(key,1,6)='trade:'", tenantId).toArray()
    .map(parse).sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id));
}

/** Write a validated next version of a record; `expectedRevision` null creates it. */
export function writeTradeInTransaction(storage, tenantId, trade, expectedRevision) {
  const current = readTrade(storage, tenantId, trade.id);
  if ((current?.revision ?? null) !== expectedRevision) throw new TradingError('TRADE_RECORD_CHANGED', 'trade record changed');
  const next = validateTrade({ ...structuredClone(trade), revision: (expectedRevision ?? 0) + 1 });
  storage.sql.exec('INSERT INTO scheduler_state (tenant_id,key,value_json) VALUES (?,?,?) ON CONFLICT(tenant_id,key) DO UPDATE SET value_json=excluded.value_json', tenantId, `${PREFIX}${trade.id}`, JSON.stringify(next));
  return next;
}

/** Keep every open trade and only the newest `keep` finished ones. */
export function pruneTradesInTransaction(storage, tenantId, keep) {
  const finished = listTrades(storage, tenantId).filter(trade => TERMINAL_STATES.has(trade.state));
  for (const trade of finished.slice(keep)) storage.sql.exec('DELETE FROM scheduler_state WHERE tenant_id=? AND key=?', tenantId, `${PREFIX}${trade.id}`);
}
