// The durable trade state machine. User actions run inside the caller's
// transaction; execution runs as bounded scheduler steps, each making at most
// one network request and committing its outcome in one transaction.
//
// QUOTING(token → price → route → build) → QUOTED → CONFIRMED
//   → [APPROVE_SIGNED → APPROVE_SENT → APPROVED] → SWAP_SIGNED → SWAP_SENT
//   → FILLED | FAILED | UNKNOWN; a quote may also end EXPIRED or CANCELLED.
//
// Broadcast safety: a signed transaction is persisted with its hash in the
// same transaction that advances to *_SIGNED, before it is ever sent. A replay
// rebroadcasts that identical raw transaction; a step never signs twice.
import { getAddress, isAddress, keccak256 } from 'viem';
import { TRADE_CHAINS, TRADING_SETTINGS, KYBER_NATIVE_TOKEN } from './config.mjs';
import { TradingError } from './http.mjs';
import { KyberClient, KYBER_ROUTER, verifySwapCalldata } from './kyber.mjs';
import { EvmRpc, rpc, decodeErc20, approveCalldata, feeFields, hexQuantity, receiptStatus, transferredAmount, DEFINITE_REFUSALS } from './evm.mjs';
import { percentOf, usdCentsToStableUnits, usdCentsToNativeUnits, nativePriceMicroUsd, withinBuyCap, decimalToMicro } from './amounts.mjs';
import { readTradingWallet, tradingAccount } from './wallet.mjs';
import { readTrade, listTrades, writeTradeInTransaction, pruneTradesInTransaction, TERMINAL_STATES, EXECUTING_STATES } from './trades.mjs';

// Balance refreshes and receipt rechecks get a task id per request, so a request the
// scheduler gave up on never blocks a later one.
const balanceTaskId = requestedAt => `trade-balances:${requestedAt}`;
const recheckTaskId = trade => `trade-recheck:${trade.id}:${trade.recheckAt}`;
const BALANCES_KEY = 'trading.balances';
const S = TRADING_SETTINGS;
const done = Object.freeze({ status: 'success', complete: true });
const same = (left, right) => left.toLowerCase() === right.toLowerCase();
const transient = error => error?.transient === true || error?.code === 'SCHEDULER_REQUEST_TIMEOUT';
const asTransient = error => new TradingError(error.code, error.message, { transient: true });
const printable = value => String(value).replace(/[^\x20-\x7e]/g, '').slice(0, 30) || '?';

/**
 * A user action the current state does not allow; the caller explains it. An
 * UNVERIFIED refusal carries the refused buy, so the caller can ask about exactly it.
 */
export class TradeRefusal extends Error {
  constructor(code, request = null) { super(code); this.name = 'TradeRefusal'; this.code = code; this.request = request; }
}

/**
 * The one safety rule for buying. VETOED blocks a buy; UNVERIFIED (no recorded
 * check, or one that is degraded or unknown) needs the owner's acknowledgement;
 * VERIFIED is a complete GoPlus/DexScreener check without fatal flags.
 */
export function safetyState(storage, tenantId, chain, token) {
  const candidate = storage.sql.exec('SELECT status, secondary_json FROM candidates WHERE tenant_id=? AND chain=? AND lower(address)=lower(?)', tenantId, chain, token).toArray()[0];
  const secondary = candidate?.secondary_json ? JSON.parse(candidate.secondary_json) : null;
  if (candidate?.status === 'HARD_REJECT' || secondary?.security?.verdict === 'FATAL') return 'VETOED';
  if (storage.sql.exec('SELECT 1 AS held FROM risk_exclusions WHERE tenant_id=? AND chain=? AND lower(address)=lower(?)', tenantId, chain, token).toArray().length) return 'VETOED';
  return secondary?.status === 'COMPLETE' && secondary.security?.verdict === 'NO_FATAL_FLAGS' ? 'VERIFIED' : 'UNVERIFIED';
}

export const tradeVetoed = (storage, tenantId, chain, token) => safetyState(storage, tenantId, chain, token) === 'VETOED';

export class TradingEngine {
  constructor({ storage, tenantId, masterKey, config, now = Date.now, onTradeInTransaction = () => {}, onBalancesInTransaction = () => {} }) {
    // masterKey is a function: the keyring is read only when a signature needs it.
    Object.assign(this, { storage, tenantId, masterKey, config, now, onTradeInTransaction, onBalancesInTransaction });
  }

  chain(chain) { return this.config.chains[chain] ?? null; }
  wallet() { return readTradingWallet(this.storage, this.tenantId); }
  trade(id) { return readTrade(this.storage, this.tenantId, id); }
  trades() { return listTrades(this.storage, this.tenantId); }
  executing() { return this.trades().find(trade => EXECUTING_STATES.has(trade.state)) ?? null; }
  vetoed(trade) { return trade.side === 'buy' && tradeVetoed(this.storage, this.tenantId, trade.chain, trade.token); }

  // ---- user actions (inside the caller's transaction) ----

  /**
   * Open a quote. A buy of an unverified token is refused as UNVERIFIED unless the
   * owner acknowledged it for this request; a vetoed token is refused regardless.
   */
  requestTradeInTransaction({ chain, token, side, usdCents = null, percent = null, sessionId = null, slippageBps, capUsd, unverifiedAcknowledged = false }) {
    const facts = this.chain(chain);
    if (!facts) throw new TradeRefusal('NOT_TRADABLE');
    const wallet = this.wallet();
    if (!wallet) throw new TradeRefusal('NO_WALLET');
    if (typeof token !== 'string' || !isAddress(token, { strict: false }) || same(token, facts.quoteToken) || same(token, KYBER_NATIVE_TOKEN)) throw new TradeRefusal('INVALID_TOKEN');
    const address = getAddress(token.toLowerCase());
    let unverifiedAtRequest = false;
    if (side === 'buy') {
      const safety = safetyState(this.storage, this.tenantId, chain, address);
      if (safety === 'VETOED') throw new TradeRefusal('VETOED');
      if (!withinBuyCap(usdCents, capUsd)) throw new TradeRefusal('OVER_CAP');
      if (safety === 'UNVERIFIED' && unverifiedAcknowledged !== true) throw new TradeRefusal('UNVERIFIED', { chain, token: address, usdCents });
      unverifiedAtRequest = safety === 'UNVERIFIED';
    } else if (side !== 'sell' || !Number.isSafeInteger(percent) || percent < 1 || percent > 100) throw new TradeRefusal('INVALID_AMOUNT');
    const now = this.now();
    const trade = { version: 1, id: crypto.randomUUID().replaceAll('-', ''), revision: 0, chain, token: address, side, wallet: wallet.address,
      usdCents: side === 'buy' ? usdCents : null, percent: side === 'sell' ? percent : null, slippageBps, capUsd, unverifiedAtRequest,
      state: 'QUOTING', step: 'token', sessionId, createdAt: now, updatedAt: now, nextAt: now, errors: 0, tokenMeta: null,
      tokenIn: side === 'buy' ? facts.quoteToken : address, tokenOut: side === 'buy' ? address : facts.quoteToken,
      amountIn: null, priceMicroUsd: null, route: null, quote: null, confirmedAt: null, confirmedMinAmountOut: null, approval: null, swap: null, result: null, recheckAt: null };
    pruneTradesInTransaction(this.storage, this.tenantId, S.recentTradesKept);
    return writeTradeInTransaction(this.storage, this.tenantId, trade, null);
  }

  /**
   * Confirm a live quote, fixing the minimum output the confirm screen showed.
   * An expired quote is replaced by a fresh one under the current settings, never executed.
   */
  confirmInTransaction(id, settings) {
    const trade = this.#open(id, ['QUOTED']);
    const now = this.now();
    if (this.vetoed(trade)) return { trade: this.#write(trade, this.#failure('VETOED')) };
    if (now >= trade.quote.expiresAt) {
      this.#write(trade, { state: 'EXPIRED', nextAt: null });
      return { trade: this.#again(trade, settings), requoted: true };
    }
    if (this.executing()) throw new TradeRefusal('BUSY');
    return { trade: this.#write(trade, { state: 'CONFIRMED', confirmedAt: now, confirmedMinAmountOut: trade.quote.minAmountOut, nextAt: now, errors: 0 }) };
  }

  cancelInTransaction(id) {
    return this.#write(this.#open(id, ['QUOTING', 'QUOTED']), { state: 'CANCELLED', step: null, nextAt: null });
  }

  requoteInTransaction(id, settings) {
    return this.#again(this.#open(id, ['EXPIRED']), settings);
  }

  /** A wallet may be removed only once no trade is open or of unknown outcome. */
  assertRemovableInTransaction() {
    if (this.trades().some(trade => !TERMINAL_STATES.has(trade.state) || trade.state === 'UNKNOWN')) throw new TradeRefusal('TRADES_OPEN');
  }

  /** True when the key was never exported and the last balance check saw funds. */
  exportRequiredBeforeRemoval() {
    const wallet = this.wallet(), balances = this.balances();
    if (!wallet || wallet.exportedAt !== null || balances.address !== wallet.address) return false;
    return Object.values(balances.chains).some(entry => entry?.units != null && BigInt(entry.units) > 0n);
  }

  /** Ask for a fresh receipt check of every trade whose outcome is unknown. */
  recheckUnknownInTransaction() {
    for (const trade of this.trades().filter(item => item.state === 'UNKNOWN' && item.recheckAt === null)) this.#write(trade, { recheckAt: this.now() });
  }

  #open(id, states) {
    const trade = typeof id === 'string' && /^[0-9a-f]{32}$/.test(id) ? this.trade(id) : null;
    if (!trade || !states.includes(trade.state)) throw new TradeRefusal('STATE_CHANGED');
    return trade;
  }

  // A requote repeats the same request, so an acknowledged unverified buy stays acknowledged.
  #again(trade, { slippageBps, capUsd }) {
    return this.requestTradeInTransaction({ chain: trade.chain, token: trade.token, side: trade.side, usdCents: trade.usdCents, percent: trade.percent,
      sessionId: trade.sessionId, slippageBps, capUsd, unverifiedAcknowledged: trade.unverifiedAtRequest });
  }

  #write(trade, changes) {
    return writeTradeInTransaction(this.storage, this.tenantId, { ...trade, ...changes, updatedAt: this.now() }, trade.revision);
  }

  #failure(reason, needed = null) {
    return { state: 'FAILED', step: null, nextAt: null, result: { reason, received: null, spent: null, needed: needed === null ? null : needed.toString() } };
  }

  // ---- scheduler integration ----

  /**
   * Scheduler tasks derived from durable records, honoring the scheduler's retry
   * backoff. A trade whose step the scheduler gave up on ends here: FAILED when
   * nothing was ever signed, else UNKNOWN (keeping its transaction link).
   */
  tasksInTransaction(retries = {}) {
    const exhausted = id => retries[id] !== undefined && retries[id].dueAt === null;
    for (const trade of this.trades()) {
      if (!TERMINAL_STATES.has(trade.state) && exhausted(`trade:${trade.id}`)) {
        const next = this.#write(trade, trade.approval === null && trade.swap === null ? this.#failure('STEP_FAILED') : this.#unknown('STEP_FAILED'));
        this.onTradeInTransaction(next);
      } else if (trade.recheckAt !== null && exhausted(recheckTaskId(trade))) this.#write(trade, { recheckAt: null });
    }
    const tasks = this.trades().flatMap(trade => !TERMINAL_STATES.has(trade.state) ? [{ id: `trade:${trade.id}`, dueAt: trade.nextAt }]
      : trade.recheckAt !== null ? [{ id: recheckTaskId(trade), dueAt: trade.recheckAt }] : []);
    const balances = this.balances();
    if (balances.pending.length && exhausted(balanceTaskId(balances.requestedAt))) this.#saveBalances({ ...balances, pending: [] });
    else if (balances.pending.length) tasks.push({ id: balanceTaskId(balances.requestedAt), dueAt: balances.requestedAt });
    return tasks.map(({ id, dueAt }) => {
      const retry = retries[id];
      return { id, kind: 'trade', dueAt: retry && retry.dueAt !== null ? Math.max(dueAt, retry.dueAt) : dueAt, enabled: !retry || retry.dueAt !== null, aveCost: 0 };
    });
  }

  async runStep(taskId, { request, fetchImpl }) {
    if (/^trade-balances:\d+$/.test(taskId)) return this.#balanceStep(request, fetchImpl);
    const recheck = /^trade-recheck:([0-9a-f]{32}):\d+$/.exec(taskId);
    if (recheck) return this.#recheck(this.trade(recheck[1]), request, fetchImpl);
    const match = /^trade:([0-9a-f]{32})$/.exec(taskId);
    if (!match) throw new TradingError('TRADE_TASK_INVALID', 'trade task identity is invalid');
    const trade = this.trade(match[1]);
    if (!trade || TERMINAL_STATES.has(trade.state) || trade.nextAt > this.now()) return done;
    const facts = this.chain(trade.chain);
    if (!facts) {
      // A chain disabled mid-trade: never broadcast further; a sent transaction's outcome is unknown.
      await this.#commit(trade, ['APPROVE_SIGNED', 'APPROVE_SENT', 'SWAP_SIGNED', 'SWAP_SENT'].includes(trade.state) ? this.#unknown('CHAIN_DISABLED') : this.#failure('CHAIN_DISABLED'));
      return done;
    }
    const context = { trade, facts, request, evm: new EvmRpc({ url: facts.rpcUrl, chainId: facts.chainId, fetchImpl }),
      kyber: () => new KyberClient({ clientId: this.config.clientId, fetchImpl }) };
    if (trade.state === 'QUOTING') await this.#quote(context);
    else if (trade.state === 'QUOTED') await this.#commit(trade, { state: 'EXPIRED', nextAt: null });
    else if (trade.state === 'CONFIRMED' || trade.state === 'APPROVED') await this.#prepare(context);
    else if (trade.state === 'APPROVE_SIGNED' || trade.state === 'SWAP_SIGNED') await this.#broadcast(context, trade.state === 'APPROVE_SIGNED' ? 'approval' : 'swap');
    else if (trade.state === 'APPROVE_SENT' || trade.state === 'SWAP_SENT') await this.#poll(context, trade.state === 'APPROVE_SENT' ? 'approval' : 'swap');
    else throw new TradingError('TRADE_STATE_INVALID', `no step handles ${trade.state}`);
    return done;
  }

  /** Commit a step's outcome unless the record changed since the step read it. */
  #commit(trade, changes) {
    return this.storage.transactionSync(() => {
      const current = this.trade(trade.id);
      if (!current || current.revision !== trade.revision) return null;
      const next = this.#write(current, changes);
      if (next.state !== trade.state) this.onTradeInTransaction(next);
      return next;
    });
  }

  async #network(request, operation) {
    try {
      return { value: await request(({ signal }) => operation(signal)) };
    } catch (error) {
      if (error instanceof TradingError || error?.code === 'SCHEDULER_REQUEST_TIMEOUT') return { error };
      throw error;
    }
  }

  /** Before any broadcast, a transient failure retries with backoff and then fails. */
  #retryOrFail(trade, error) {
    if (transient(error) && trade.errors < S.transientRetries) {
      return this.#commit(trade, { errors: trade.errors + 1, nextAt: this.now() + S.receiptPollMs * 2 ** trade.errors });
    }
    return this.#commit(trade, this.#failure(error.code));
  }

  #unknown(reason) {
    return { state: 'UNKNOWN', nextAt: null, result: { reason, received: null, spent: null, needed: null } };
  }

  // ---- quoting ----

  async #quote({ trade, facts, request, evm, kyber }) {
    if (this.vetoed(trade)) return this.#commit(trade, this.#failure('VETOED'));
    if (trade.step === 'token') {
      const calls = [rpc.erc20(trade.token, 'decimals'), rpc.erc20(trade.token, 'symbol'), ...(trade.side === 'sell' ? [rpc.erc20(trade.token, 'balanceOf', [trade.wallet])] : [])];
      const answer = await this.#network(request, signal => evm.batch(calls, { signal }));
      if (answer.error) return this.#retryOrFail(trade, answer.error);
      const [decimalsAnswer, symbolAnswer, balanceAnswer] = answer.value;
      let decimals, balance, symbol = '?';
      try {
        decimals = Number(decodeErc20('decimals', decimalsAnswer));
        if (trade.side === 'sell') balance = decodeErc20('balanceOf', balanceAnswer);
      } catch (error) {
        if (!(error instanceof TradingError)) throw error;
        return this.#commit(trade, this.#failure('TOKEN_UNREADABLE'));
      }
      if (decimals > 36) return this.#commit(trade, this.#failure('TOKEN_UNREADABLE'));
      try { symbol = printable(decodeErc20('symbol', symbolAnswer)); } catch (error) { if (!(error instanceof TradingError)) throw error; }
      const tokenMeta = { decimals, symbol };
      if (trade.side === 'sell') {
        const amountIn = percentOf(balance, trade.percent);
        if (amountIn === 0n) return this.#commit(trade, { tokenMeta, ...this.#failure('NO_BALANCE') });
        return this.#commit(trade, { tokenMeta, amountIn: amountIn.toString(), step: 'route', errors: 0, nextAt: this.now() });
      }
      if (!same(facts.quoteToken, KYBER_NATIVE_TOKEN)) {
        return this.#commit(trade, { tokenMeta, amountIn: usdCentsToStableUnits(trade.usdCents, facts.quoteDecimals).toString(), step: 'route', errors: 0, nextAt: this.now() });
      }
      return this.#commit(trade, { tokenMeta, step: 'price', errors: 0, nextAt: this.now() });
    }
    if (trade.step === 'price') {
      // A small probe prices the native coin without needing depth for a whole coin.
      const probe = 10n ** BigInt(18 - S.priceProbeDecimalsBelowCoin);
      const answer = await this.#network(request, signal => kyber().route({ slug: facts.kyberSlug, tokenIn: KYBER_NATIVE_TOKEN, tokenOut: trade.token, amountIn: probe, signal }));
      if (answer.error) return this.#retryOrFail(trade, answer.error);
      const price = nativePriceMicroUsd(answer.value.amountInUsd, probe);
      if (price === null) return this.#commit(trade, this.#failure('PRICE_UNAVAILABLE'));
      const amountIn = usdCentsToNativeUnits(trade.usdCents, price);
      if (amountIn === 0n) return this.#commit(trade, this.#failure('AMOUNT_TOO_SMALL'));
      return this.#commit(trade, { priceMicroUsd: price.toString(), amountIn: amountIn.toString(), step: 'route', errors: 0, nextAt: this.now() });
    }
    if (trade.step === 'route') {
      const answer = await this.#network(request, signal => kyber().route({ slug: facts.kyberSlug, tokenIn: trade.tokenIn, tokenOut: trade.tokenOut, amountIn: BigInt(trade.amountIn), signal }));
      if (answer.error) return this.#retryOrFail(trade, answer.error);
      // A native buy was sized from a probe price; the route must value it within the cap.
      if (trade.side === 'buy' && same(trade.tokenIn, KYBER_NATIVE_TOKEN)) {
        const valued = decimalToMicro(answer.value.amountInUsd);
        if (valued === null) return this.#commit(trade, this.#failure('PRICE_UNAVAILABLE'));
        if (valued * 100n > BigInt(trade.capUsd) * 1_000_000n * BigInt(100 + S.capTolerancePercent)) return this.#commit(trade, this.#failure('OVER_CAP'));
      }
      return this.#commit(trade, { route: answer.value.routeSummary, step: 'build', errors: 0, nextAt: this.now() });
    }
    const now = this.now();
    const deadline = Math.floor((now + S.swapDeadlineMs) / 1000);
    const answer = await this.#network(request, signal => kyber().build({ slug: facts.kyberSlug, routeSummary: trade.route, tokenIn: trade.tokenIn, tokenOut: trade.tokenOut,
      amountIn: BigInt(trade.amountIn), sender: trade.wallet, slippageBps: trade.slippageBps, deadline, signal }));
    if (answer.error) return this.#retryOrFail(trade, answer.error);
    const built = answer.value, quotedAt = this.now();
    return this.#commit(trade, { state: 'QUOTED', step: null, route: null, errors: 0, nextAt: quotedAt + S.quoteTtlMs,
      quote: { amountOut: built.amountOut.toString(), minAmountOut: built.minAmountOut.toString(), amountInUsd: built.amountInUsd,
        amountOutUsd: built.amountOutUsd, gasUsd: built.gasUsd, data: built.data, value: built.value.toString(), deadline, quotedAt, expiresAt: quotedAt + S.quoteTtlMs } });
  }

  // ---- preparing and signing ----

  async #prepare({ trade, facts, request, evm }) {
    if (trade.state === 'APPROVED' && Math.floor(this.now() / 1000) >= trade.quote.deadline) return this.#commit(trade, this.#failure('QUOTE_DEADLINE_PASSED'));
    if (this.vetoed(trade)) return this.#commit(trade, this.#failure('VETOED'));
    const amountIn = BigInt(trade.amountIn), value = BigInt(trade.quote.value);
    // Re-verify the stored calldata against what the user confirmed, right before any signature.
    try {
      verifySwapCalldata(trade.quote.data, { tokenIn: trade.tokenIn, tokenOut: trade.tokenOut, amountIn, recipient: trade.wallet, minAmountOut: BigInt(trade.confirmedMinAmountOut) });
    } catch (error) {
      if (!(error instanceof TradingError)) throw error;
      return this.#commit(trade, this.#failure(error.code));
    }
    const tokenIn = !same(trade.tokenIn, KYBER_NATIVE_TOKEN);
    const approval = { from: trade.wallet, to: trade.tokenIn, data: approveCalldata(KYBER_ROUTER, amountIn), value: 0n };
    const swap = { from: trade.wallet, to: KYBER_ROUTER, data: trade.quote.data, value };
    const calls = [rpc.nonce(trade.wallet), rpc.gasPrice(), rpc.latestBlock(), rpc.balance(trade.wallet),
      ...(tokenIn ? [rpc.erc20(trade.tokenIn, 'allowance', [trade.wallet, KYBER_ROUTER]), rpc.erc20(trade.tokenIn, 'balanceOf', [trade.wallet]), rpc.estimateGas(approval)] : []),
      rpc.estimateGas(swap)];
    const answer = await this.#network(request, signal => evm.batch(calls, { signal }));
    if (answer.error) return this.#retryOrFail(trade, answer.error);
    const [nonceAnswer, gasPriceAnswer, blockAnswer, balanceAnswer] = answer.value;
    const failed = [nonceAnswer, gasPriceAnswer, blockAnswer, balanceAnswer].find(item => item.error);
    if (failed) return this.#retryOrFail(trade, asTransient(failed.error));
    let nonce, fees, nativeBalance, allowance = null, tokenBalance = null;
    try {
      nonce = hexQuantity(nonceAnswer.result); fees = feeFields(hexQuantity(gasPriceAnswer.result), blockAnswer.result); nativeBalance = hexQuantity(balanceAnswer.result);
      if (tokenIn) { allowance = decodeErc20('allowance', answer.value[4]); tokenBalance = decodeErc20('balanceOf', answer.value[5]); }
    } catch (error) {
      if (!(error instanceof TradingError)) throw error;
      return this.#retryOrFail(trade, asTransient(error));
    }
    const needsApproval = tokenIn && allowance < amountIn;
    if (trade.state === 'APPROVED' && needsApproval) return this.#commit(trade, this.#failure('ALLOWANCE_NOT_SET'));
    if (tokenIn && tokenBalance < amountIn) return this.#commit(trade, this.#failure('INSUFFICIENT_TOKEN', amountIn));
    const estimate = needsApproval ? answer.value[6] : answer.value.at(-1);
    if (estimate.error) return this.#commit(trade, this.#failure(needsApproval ? 'APPROVAL_SIMULATION_FAILED' : 'SWAP_SIMULATION_FAILED'));
    let gas;
    try { gas = hexQuantity(estimate.result) * BigInt(100 + S.gasLimitBufferPercent) / 100n; } catch (error) {
      if (!(error instanceof TradingError)) throw error;
      return this.#retryOrFail(trade, asTransient(error));
    }
    // On Arc the ERC-20 USDC spent and the native USDC paying gas are one balance.
    const shared = facts.quoteSharesNativeBalance && same(trade.tokenIn, facts.quoteToken) ? amountIn * 10n ** BigInt(18 - facts.quoteDecimals) : 0n;
    const needed = (needsApproval ? 0n : value) + gas * fees.maxCost + shared;
    if (nativeBalance < needed) return this.#commit(trade, this.#failure('INSUFFICIENT_NATIVE', needed));
    const target = needsApproval ? approval : swap;
    const unsigned = { chainId: facts.chainId, nonce: Number(nonce), gas, to: target.to, data: target.data, value: target.value,
      ...(fees.type === 'eip1559' ? { type: 'eip1559', maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas } : { type: 'legacy', gasPrice: fees.gasPrice }) };
    if (this.vetoed(trade)) return this.#commit(trade, this.#failure('VETOED'));
    const account = await tradingAccount(this.storage, this.masterKey(), this.tenantId);
    if (account.address !== trade.wallet) throw new TradingError('TRADE_WALLET_CHANGED', 'trade belongs to a different wallet');
    const raw = await account.signTransaction(unsigned);
    const signed = { raw, hash: keccak256(raw), nonce: Number(nonce), sentAt: null, deadlineAt: null, polls: 0, uncertain: false, rejected: null, minedBlock: null, fee: null };
    return this.storage.transactionSync(() => {
      const current = this.trade(trade.id);
      if (!current || current.revision !== trade.revision) return null;
      // The veto is final right up to the commit that makes the signature broadcastable.
      const changes = this.vetoed(current) ? this.#failure('VETOED')
        : needsApproval ? { state: 'APPROVE_SIGNED', approval: signed, errors: 0, nextAt: this.now() } : { state: 'SWAP_SIGNED', swap: signed, errors: 0, nextAt: this.now() };
      const next = this.#write(current, changes);
      this.onTradeInTransaction(next);
      return next;
    });
  }

  // ---- broadcasting and receipts ----

  #sent(trade, which, uncertain) {
    const now = this.now();
    return { state: which === 'approval' ? 'APPROVE_SENT' : 'SWAP_SENT', errors: 0, nextAt: now + S.receiptPollMs,
      [which]: { ...trade[which], sentAt: now, deadlineAt: now + S.receiptDeadlineMs, uncertain } };
  }

  async #broadcast({ trade, request, evm }, which) {
    const tx = trade[which];
    if (tx.rejected !== null) {
      // A definite refusal: the node will not hold this transaction. It can only
      // have been mined by an earlier (replayed) send, which its receipt shows;
      // without one it can never mine (its nonce is unused and refused, or taken).
      const answer = await this.#network(request, signal => evm.batch([rpc.receipt(tx.hash)], { signal }));
      const receipt = answer.error || answer.value[0].error ? undefined : answer.value[0].result;
      if (receipt === undefined) {
        if (trade.errors >= S.transientRetries) return this.#commit(trade, this.#unknown('BROADCAST_UNCONFIRMED'));
        return this.#commit(trade, { errors: trade.errors + 1, nextAt: this.now() + S.receiptPollMs * 2 ** trade.errors });
      }
      if (receipt !== null) return this.#commit(trade, this.#sent(trade, which, false));
      return this.#commit(trade, this.#failure(`BROADCAST_REJECTED_${tx.rejected}`));
    }
    const answer = await this.#network(request, signal => evm.batch([rpc.sendRaw(tx.raw)], { signal }));
    // No answer proves nothing either way: poll the receipt of our own hash.
    if (answer.error) return this.#commit(trade, this.#sent(trade, which, true));
    const [sent] = answer.value;
    if (sent.error) {
      if (sent.error.kind === 'KNOWN') return this.#commit(trade, this.#sent(trade, which, false));
      // Only an allowlisted refusal proves the node did not take it; anything else is ambiguous.
      if (DEFINITE_REFUSALS.has(sent.error.kind)) return this.#commit(trade, { [which]: { ...tx, rejected: sent.error.kind }, nextAt: this.now() });
      return this.#commit(trade, this.#sent(trade, which, true));
    }
    return this.#commit(trade, this.#sent(trade, which, sent.result !== tx.hash));
  }

  async #poll({ trade, facts, request, evm }, which) {
    const tx = trade[which], now = this.now();
    if (tx.minedBlock !== null) return this.#settleByBalance({ trade, facts, request, evm });
    const polls = tx.polls + 1;
    const expired = now >= tx.deadlineAt;
    const wait = () => this.#commit(trade, expired ? this.#unknown('NO_RECEIPT') : { [which]: { ...tx, polls }, nextAt: now + S.receiptPollMs });
    if (!expired && polls % S.rebroadcastEveryPolls === 0) {
      // Rebroadcasting the identical signed transaction is idempotent.
      await this.#network(request, signal => evm.batch([rpc.sendRaw(tx.raw)], { signal }));
      return wait();
    }
    const answer = await this.#network(request, signal => evm.batch([rpc.receipt(tx.hash)], { signal }));
    if (answer.error || answer.value[0].error) return wait();
    const receipt = answer.value[0].result;
    let status;
    try { status = receiptStatus(receipt); } catch (error) {
      if (!(error instanceof TradingError)) throw error;
      return wait();
    }
    if (status === null) return wait();
    if (status === 'reverted') return this.#commit(trade, this.#failure(which === 'approval' ? 'APPROVAL_REVERTED' : 'SWAP_REVERTED'));
    if (which === 'approval') return this.#commit(trade, { state: 'APPROVED', errors: 0, nextAt: now });
    const received = transferredAmount(receipt, trade.tokenOut, { to: trade.wallet });
    const spent = same(trade.tokenIn, KYBER_NATIVE_TOKEN) ? BigInt(trade.quote.value) : transferredAmount(receipt, trade.tokenIn, { from: trade.wallet }) ?? BigInt(trade.amountIn);
    if (received !== null) return this.#commit(trade, this.#filled(received, spent));
    // No Transfer log (a native coin out): measure the balance change across the block.
    let fee;
    try { fee = hexQuantity(receipt.gasUsed) * hexQuantity(receipt.effectiveGasPrice ?? '0x0'); hexQuantity(receipt.blockNumber); } catch (error) {
      if (!(error instanceof TradingError)) throw error;
      return this.#commit(trade, this.#filled(null, spent));
    }
    return this.#commit(trade, { swap: { ...tx, polls, minedBlock: receipt.blockNumber.toLowerCase(), fee: fee.toString() }, result: { reason: null, received: null, spent: spent.toString(), needed: null }, errors: 0, nextAt: now });
  }

  /**
   * Resolve an UNKNOWN trade from facts: a receipt of its last transaction, or a
   * confirmed later nonce proving it can never mine. Otherwise it stays UNKNOWN.
   */
  async #recheck(trade, request, fetchImpl) {
    if (!trade || trade.state !== 'UNKNOWN' || trade.recheckAt === null || trade.recheckAt > this.now()) return done;
    const facts = this.chain(trade.chain), tx = trade.swap ?? trade.approval;
    if (!facts || !tx) {
      await this.#commit(trade, { recheckAt: null });
      return done;
    }
    const evm = new EvmRpc({ url: facts.rpcUrl, chainId: facts.chainId, fetchImpl });
    const answer = await this.#network(request, signal => evm.batch([rpc.receipt(tx.hash), rpc.minedNonce(trade.wallet)], { signal }));
    let receipt, status, mined;
    try {
      if (answer.error) throw answer.error;
      const [receiptAnswer, nonceAnswer] = answer.value;
      if (receiptAnswer.error) throw receiptAnswer.error;
      if (nonceAnswer.error) throw nonceAnswer.error;
      receipt = receiptAnswer.result; status = receiptStatus(receipt); mined = hexQuantity(nonceAnswer.result);
    } catch (error) {
      if (!(error instanceof TradingError)) throw error;
      await this.#commit(trade, { recheckAt: null });
      return done;
    }
    const swap = tx === trade.swap;
    let changes = { recheckAt: null };
    if (status === 'reverted') changes = { ...this.#failure(swap ? 'SWAP_REVERTED' : 'APPROVAL_REVERTED'), recheckAt: null };
    else if (status === 'success' && !swap) changes = { ...this.#failure('RESOLVED_WITHOUT_SWAP'), recheckAt: null };
    else if (status === 'success') {
      const spent = same(trade.tokenIn, KYBER_NATIVE_TOKEN) ? BigInt(trade.quote.value) : transferredAmount(receipt, trade.tokenIn, { from: trade.wallet }) ?? BigInt(trade.amountIn);
      changes = { ...this.#filled(transferredAmount(receipt, trade.tokenOut, { to: trade.wallet }), spent), recheckAt: null };
    } else if (mined > BigInt(tx.nonce)) changes = { ...this.#failure('NOT_MINED'), recheckAt: null };
    await this.#commit(trade, changes);
    return done;
  }

  #filled(received, spent) {
    return { state: 'FILLED', nextAt: null, errors: 0, result: { reason: null, received: received === null ? null : received.toString(), spent: spent.toString(), needed: null } };
  }

  async #settleByBalance({ trade, facts, request, evm }) {
    const tx = trade.swap, block = BigInt(tx.minedBlock), native = same(trade.tokenOut, KYBER_NATIVE_TOKEN);
    const at = value => `0x${value.toString(16)}`;
    const calls = native ? [rpc.balance(trade.wallet, at(block - 1n)), rpc.balance(trade.wallet, at(block))]
      : [rpc.erc20(trade.tokenOut, 'balanceOf', [trade.wallet], at(block - 1n)), rpc.erc20(trade.tokenOut, 'balanceOf', [trade.wallet], at(block))];
    const answer = await this.#network(request, signal => evm.batch(calls, { signal }));
    const spent = BigInt(trade.result.spent);
    let before, after;
    try {
      if (answer.error) throw answer.error;
      [before, after] = native ? answer.value.map(item => { if (item.error) throw item.error; return hexQuantity(item.result); }) : answer.value.map(item => decodeErc20('balanceOf', item));
    } catch (error) {
      if (!(error instanceof TradingError)) throw error;
      if (trade.errors < S.transientRetries) return this.#commit(trade, { errors: trade.errors + 1, nextAt: this.now() + S.receiptPollMs });
      return this.#commit(trade, this.#filled(null, spent));
    }
    // The swap paid its fee from the native balance (on Arc, the same USDC balance).
    const fee = BigInt(tx.fee);
    const feeInView = native ? fee : facts.quoteSharesNativeBalance && same(trade.tokenOut, facts.quoteToken) ? fee / 10n ** BigInt(18 - facts.quoteDecimals) : 0n;
    const received = after - before + feeInView;
    return this.#commit(trade, this.#filled(received >= 0n ? received : null, spent));
  }

  // ---- wallet balances ----

  balances() {
    const row = this.storage.sql.exec('SELECT value_json FROM scheduler_state WHERE tenant_id=? AND key=?', this.tenantId, BALANCES_KEY).toArray()[0];
    const value = row ? JSON.parse(row.value_json) : { version: 1, sessionId: null, requestedAt: 0, pending: [], chains: {} };
    if (value.version !== 1 || !Array.isArray(value.pending) || !value.pending.every(chain => Object.hasOwn(TRADE_CHAINS, chain)) || typeof value.chains !== 'object') {
      throw new TradingError('TRADE_BALANCES_CORRUPT', 'wallet balance record is malformed');
    }
    return value;
  }

  requestBalancesInTransaction(sessionId) {
    const wallet = this.wallet();
    if (!wallet) return;
    const current = this.balances();
    this.#saveBalances({ ...current, sessionId, requestedAt: this.now(), pending: Object.keys(this.config.chains), address: wallet.address });
  }

  #saveBalances(value) {
    this.storage.sql.exec('INSERT INTO scheduler_state (tenant_id,key,value_json) VALUES (?,?,?) ON CONFLICT(tenant_id,key) DO UPDATE SET value_json=excluded.value_json', this.tenantId, BALANCES_KEY, JSON.stringify(value));
  }

  async #balanceStep(request, fetchImpl) {
    const state = this.balances(), wallet = this.wallet();
    const chain = state.pending[0];
    if (!chain) return done;
    const facts = this.chain(chain);
    let entry;
    if (!facts || !wallet || wallet.address !== state.address) entry = null;
    else {
      const answer = await this.#network(request, signal => new EvmRpc({ url: facts.rpcUrl, chainId: facts.chainId, fetchImpl }).batch([rpc.balance(wallet.address)], { signal }));
      let units = null;
      if (!answer.error && !answer.value[0].error) {
        try { units = hexQuantity(answer.value[0].result).toString(); } catch (error) { if (!(error instanceof TradingError)) throw error; }
      }
      entry = { units, error: units === null ? (answer.error?.code ?? 'RPC_REFUSED') : null, at: this.now() };
    }
    this.storage.transactionSync(() => {
      const current = this.balances();
      if (current.requestedAt !== state.requestedAt || current.pending[0] !== chain) return;
      const next = { ...current, pending: current.pending.slice(1), chains: entry ? { ...current.chains, [chain]: entry } : current.chains };
      this.#saveBalances(next);
      if (!next.pending.length) this.onBalancesInTransaction(next);
    });
    return done;
  }
}
