// Trading panels: token buy/sell rows, the quote confirmation and progress
// panel, the wallet panel and trading settings. Pure renderers over the
// snapshot's `trading` projection; they never see a private key or raw transaction.
import { TRADING_SETTINGS, KYBER_NATIVE_TOKEN } from '../trading/config.mjs';
import { displayUnits, centsText, microUsdText } from '../trading/amounts.mjs';
import { localize, userText, chainLabel, button, escapeHtml, timestamp, finishPanel } from '../render/telegram.mjs';

export const TRADING_PANELS = Object.freeze(['trade', 'wallet', 'wallet_export', 'wallet_remove', 'trade_settings']);
export const TRADING_PANEL_NAMES = Object.freeze({ trade: ['交易', 'Trade'], wallet: ['交易钱包', 'Trading wallet'], wallet_export: ['导出私钥', 'Export private key'], wallet_remove: ['移除交易钱包', 'Remove trading wallet'], trade_settings: ['交易设置', 'Trade settings'] });

const REASONS = {
  VETOED: ['安全核验未通过，已拒绝买入。', 'Safety check failed; the buy was refused.'],
  NO_BALANCE: ['钱包中没有该代币余额。', 'The wallet holds none of this token.'],
  TOKEN_UNREADABLE: ['无法读取代币合约。', 'The token contract could not be read.'],
  PRICE_UNAVAILABLE: ['无法获得原生币美元价格。', 'The native coin USD price is unavailable.'],
  AMOUNT_TOO_SMALL: ['金额过小。', 'The amount is too small.'],
  INSUFFICIENT_NATIVE: ['原生币余额不足以支付金额和Gas。', 'Not enough native balance for the amount and gas.'],
  INSUFFICIENT_TOKEN: ['代币余额不足。', 'Not enough token balance.'],
  APPROVAL_SIMULATION_FAILED: ['授权模拟失败，未发送。', 'Approval simulation failed; nothing was sent.'],
  SWAP_SIMULATION_FAILED: ['兑换模拟失败，未发送。', 'Swap simulation failed; nothing was sent.'],
  APPROVAL_REVERTED: ['授权交易在链上失败。', 'The approval transaction reverted on chain.'],
  SWAP_REVERTED: ['兑换交易在链上失败（可能超出滑点）。', 'The swap reverted on chain (possibly beyond slippage).'],
  ALLOWANCE_NOT_SET: ['授权未生效。', 'The approval did not take effect.'],
  QUOTE_DEADLINE_PASSED: ['授权完成时报价已过期；请重新报价（授权已保留）。', 'The quote deadline passed after approval; get a new quote (the approval remains).'],
  CHAIN_DISABLED: ['此链交易已被停用。', 'Trading on this chain was disabled.'],
  NO_RECEIPT: ['10分钟内未获得回执。交易可能仍会确认，请在浏览器核对；不会自动签署替代交易。', 'No receipt within 10 minutes. The transaction may still confirm; check the explorer. No replacement will be signed.'],
  BROADCAST_UNCONFIRMED: ['无法确认广播结果，请在浏览器核对。', 'The broadcast could not be confirmed; check the explorer.'],
  KYBER_REJECTED: ['KyberSwap无可用路由。', 'KyberSwap found no usable route.']
};
const reasonText = (reason, L) => REASONS[reason] ? L(...REASONS[reason])
  : String(reason).startsWith('BROADCAST_REJECTED') ? L('节点拒绝了交易，未广播。', 'The node refused the transaction; it was not broadcast.')
    : String(reason).startsWith('KYBER_') ? L('KyberSwap暂时不可用。', 'KyberSwap is unavailable right now.')
      : String(reason).startsWith('RPC_') ? L('链上节点暂时不可用。', 'The chain node is unavailable right now.') : L('交易未完成。', 'The trade did not complete.');
const STATUS = {
  QUOTING: ['报价中', 'Quoting'], QUOTED: ['待确认', 'Awaiting confirmation'], CONFIRMED: ['准备中', 'Preparing'], APPROVE_SIGNED: ['授权提交中', 'Submitting approval'],
  APPROVE_SENT: ['授权已提交', 'Approval submitted'], APPROVED: ['已授权', 'Approved'], SWAP_SIGNED: ['兑换提交中', 'Submitting swap'], SWAP_SENT: ['兑换已提交', 'Swap submitted'],
  FILLED: ['已成交', 'Filled'], FAILED: ['失败', 'Failed'], UNKNOWN: ['结果未知', 'Outcome unknown'], EXPIRED: ['报价已过期', 'Quote expired'], CANCELLED: ['已取消', 'Cancelled']
};

const L_ = locale => (zh, en) => localize(locale, zh, en);
const isNative = address => address.toLowerCase() === KYBER_NATIVE_TOKEN.toLowerCase();
const outDecimals = (trade, chain) => trade.side === 'buy' ? trade.tokenMeta.decimals : chain.quoteDecimals;
const outSymbol = (trade, chain) => trade.side === 'buy' ? trade.tokenMeta.symbol : chain.nativeSymbol;
const txLink = (trading, trade, hash, L) => {
  const explorer = trading.explorers[trade.chain];
  return explorer ? `<a href="${escapeHtml(`${explorer}/tx/${hash}`)}">${L('查看交易', 'View transaction')}</a> <code>${hash}</code>` : `${L('交易哈希', 'Transaction hash')}: <code>${hash}</code>`;
};

/** Buy and sell rows for a token detail; nothing on chains that cannot trade. */
export function tokenTradeControls(snapshot, row, locale, identity) {
  const trading = snapshot.trading, L = L_(locale);
  if (!trading || !trading.chains.includes(row.chain)) return { blocks: [], keyboard: [] };
  if (!trading.wallet) return { blocks: [], keyboard: [[button(L('设置交易钱包', 'Set up trading wallet'), 'panel.open', { panel: 'wallet' })]] };
  const blocks = [], keyboard = [];
  if (row.status === 'HARD_REJECT') blocks.push(L('安全核验未通过：已禁止买入，仍可卖出。', 'Safety check failed: buying is disabled; selling stays available.'));
  else keyboard.push([...TRADING_SETTINGS.buyButtonsUsd.filter(usd => usd <= trading.settings.capUsd).map(usd => button(`${L('买', 'Buy')} $${usd}`, 'trade.buy', { usd }, identity)),
    button(L('买 自定义', 'Buy custom'), 'trade.input', { side: 'buy' }, identity)]);
  keyboard.push([...TRADING_SETTINGS.sellButtonsPercent.map(percent => button(`${L('卖', 'Sell')} ${percent}%`, 'trade.sell', { percent }, identity)),
    button(L('卖 自定义%', 'Sell custom %'), 'trade.input', { side: 'sell' }, identity)]);
  return { blocks, keyboard };
}

function spendText(trade, chain, L) {
  if (trade.side === 'sell') return `${trade.percent}% = ${displayUnits(trade.amountIn, trade.tokenMeta.decimals)} ${userText(trade.tokenMeta.symbol, 30)}`;
  if (!isNative(trade.tokenIn)) return `${centsText(trade.usdCents)} = ${displayUnits(trade.amountIn, chain.quoteDecimals)} ${chain.nativeSymbol}`;
  return `${centsText(trade.usdCents)} ≈ ${displayUnits(trade.amountIn, 18)} ${chain.nativeSymbol} (${L('按', 'at')} ${microUsdText(trade.priceMicroUsd)}/${chain.nativeSymbol})`;
}

function quoteLines(trade, chain, trading, snapshot, L) {
  const quote = trade.quote, lines = [];
  lines.push(`${L('支出', 'Spend')}: ${spendText(trade, chain, L)}`);
  lines.push(`${L('预计获得', 'Estimated receive')}: ${displayUnits(quote.amountOut, outDecimals(trade, chain))} ${userText(outSymbol(trade, chain), 30)}`);
  lines.push(`${L('最少获得（滑点后）', 'Minimum receive after slippage')}: ${displayUnits(quote.minAmountOut, outDecimals(trade, chain))} ${userText(outSymbol(trade, chain), 30)}`);
  const inUsd = Number(quote.amountInUsd), outUsd = Number(quote.amountOutUsd);
  if (quote.amountInUsd !== null && quote.amountOutUsd !== null && inUsd > 0) lines.push(`${L('价格影响（估算）', 'Price impact (estimated)')}: ${((inUsd - outUsd) / inUsd * 100).toFixed(2)}%`);
  lines.push(`${L('滑点', 'Slippage')}: ${(trade.slippageBps / 100).toFixed(2).replace(/\.?0+$/, '')}%`);
  lines.push(`${L('预计Gas', 'Estimated gas')}: ${quote.gasUsd === null ? L('未知', 'Unknown') : `$${Number(quote.gasUsd).toFixed(4)}`}`);
  if (trade.side === 'buy') lines.push(`${L('单笔买入上限', 'Per-trade buy cap')}: $${trade.capUsd}`);
  if (trade.state === 'QUOTED') lines.push(`${L('报价有效至', 'Quote valid until')}: ${timestamp(quote.expiresAt)} (${Math.max(0, Math.ceil((quote.expiresAt - snapshot.at) / 1000))}s)`);
  return lines;
}

function tradePanel(snapshot, session, locale) {
  const L = L_(locale), trading = snapshot.trading;
  const trade = trading?.trades.find(item => item.id === session.query?.tradeId);
  const back = button(L('返回', 'Back'), 'panel.back');
  if (!trade) return finishPanel(L('交易', 'Trade'), [L('交易记录不可用。', 'This trade is no longer available.')], [[back]], snapshot, session, locale);
  const chain = trading.chainFacts[trade.chain];
  const symbol = trade.tokenMeta?.symbol ?? '?';
  const blocks = [`<b>${trade.side === 'buy' ? L('买入', 'Buy') : L('卖出', 'Sell')} ${userText(symbol, 30)}</b> · ${chainLabel(trade.chain)} · ${L(...STATUS[trade.state])}`, `CA: <code>${userText(trade.token, 42)}</code>`];
  const keyboard = [];
  if (trade.state === 'QUOTING') {
    blocks.push(L('正在获取报价…', 'Fetching a quote…'));
    keyboard.push([button(L('取消', 'Cancel'), 'trade.cancel', { tradeId: trade.id })]);
  } else if (trade.quote && chain) {
    blocks.push(...quoteLines(trade, chain, trading, snapshot, L));
  }
  if (trade.state === 'QUOTED') {
    blocks.push(L('确认后将从热钱包签名并广播。', 'Confirming signs and broadcasts from your hot wallet.'));
    keyboard.push([button(L('✅ 确认', '✅ Confirm'), 'trade.confirm', { tradeId: trade.id }), button(L('取消', 'Cancel'), 'trade.cancel', { tradeId: trade.id })]);
  }
  if (trade.state === 'EXPIRED') {
    blocks.push(L('报价已过期，未发送任何交易。', 'The quote expired; nothing was sent.'));
    keyboard.push([button(L('重新报价', 'Get a new quote'), 'trade.requote', { tradeId: trade.id })]);
  }
  for (const [label, tx] of [[L('授权', 'Approval'), trade.approval], [L('兑换', 'Swap'), trade.swap]]) {
    if (tx?.sentAt) blocks.push(`${label}: ${txLink(trading, trade, tx.hash, L)}`);
  }
  if (trade.state === 'FILLED' && chain) {
    const spentDecimals = trade.side === 'buy' ? chain.quoteDecimals : trade.tokenMeta.decimals, spentSymbol = trade.side === 'buy' ? chain.nativeSymbol : trade.tokenMeta.symbol;
    blocks.push(`${L('实际支出', 'Spent')}: ${displayUnits(trade.result.spent, isNative(trade.tokenIn) ? 18 : spentDecimals)} ${userText(spentSymbol, 30)}`);
    blocks.push(`${L('实际获得', 'Received')}: ${trade.result.received === null ? `≥ ${displayUnits(trade.quote.minAmountOut, outDecimals(trade, chain))}` : displayUnits(trade.result.received, outDecimals(trade, chain))} ${userText(outSymbol(trade, chain), 30)}`);
  }
  if (['FAILED', 'UNKNOWN'].includes(trade.state)) {
    blocks.push(reasonText(trade.result.reason, L));
    if (trade.result.needed !== null && chain) blocks.push(`${L('需要', 'Needed')}: ${displayUnits(trade.result.needed, trade.result.reason === 'INSUFFICIENT_TOKEN' && trade.side === 'buy' ? chain.quoteDecimals : trade.result.reason === 'INSUFFICIENT_TOKEN' ? trade.tokenMeta.decimals : 18)} ${trade.result.reason === 'INSUFFICIENT_TOKEN' && trade.side === 'sell' ? userText(symbol, 30) : chain.nativeSymbol}`);
  }
  keyboard.push([button(L('刷新', 'Refresh'), 'panel.refresh'), back]);
  return finishPanel(L('交易', 'Trade'), blocks, keyboard, snapshot, session, locale);
}

function walletPanel(snapshot, session, locale) {
  const L = L_(locale), trading = snapshot.trading, home = button(L('雷达总览', 'Radar overview'), 'panel.open', { panel: 'radar' });
  if (!trading?.chains.length) return finishPanel(L('交易钱包', 'Trading wallet'), [L('本部署未启用交易。', 'Trading is not enabled on this deployment.')], [[home]], snapshot, session, locale);
  const hot = L('这是热钱包：私钥由机器人加密保存并用于签名。只存入你愿意承担风险的小额资金。机器人不收取交易费，只有DEX费用和Gas。', 'This is a hot wallet: the bot stores its key encrypted and signs with it. Keep only small amounts you can afford to lose. The bot charges no fee; you pay DEX fees and gas.');
  if (!trading.wallet) {
    return finishPanel(L('交易钱包', 'Trading wallet'), [L('尚未创建交易钱包。机器人会为你生成一个专用钱包（不会导入你的私钥）。', 'No trading wallet yet. The bot generates a dedicated wallet for you (it never imports your key).'), hot],
      [[button(L('创建交易钱包', 'Create trading wallet'), 'wallet.create')], [home]], snapshot, session, locale);
  }
  const blocks = [`${L('地址', 'Address')}: <code>${userText(trading.wallet.address, 42)}</code>`, hot, '', `<b>${L('余额', 'Balances')}</b>`];
  for (const chain of trading.chains) {
    const entry = trading.balances.chains[chain], facts = trading.chainFacts[chain];
    const value = entry?.units != null ? `${displayUnits(entry.units, 18)} ${facts.nativeSymbol}` : entry?.error ? L('读取失败', 'Read failed') : L('未读取', 'Not read');
    blocks.push(`${chainLabel(chain)}: ${value}${trading.balances.pending.includes(chain) ? ` · ${L('刷新中', 'refreshing')}` : ''}`);
  }
  if (trading.exportIssue) blocks.push('', L('上次私钥导出可能未送达。如未收到，请再次导出。', 'The last key export may not have arrived. Export again if you did not receive it.'));
  const recent = trading.trades.slice(0, 5);
  blocks.push('', `<b>${L('最近交易', 'Recent trades')}</b>`);
  if (!recent.length) blocks.push(L('暂无', 'None'));
  for (const trade of recent) {
    const hash = trade.swap?.sentAt ? trade.swap.hash : trade.approval?.sentAt ? trade.approval.hash : null;
    const explorer = trading.explorers[trade.chain];
    const amount = trade.side === 'buy' ? centsText(trade.usdCents) : `${trade.percent}%`;
    blocks.push(`${timestamp(trade.createdAt, locale)} · ${trade.side === 'buy' ? L('买', 'Buy') : L('卖', 'Sell')} ${userText(trade.tokenMeta?.symbol ?? '?', 30)} ${amount} · ${chainLabel(trade.chain)} · ${L(...STATUS[trade.state])}${hash ? explorer ? ` · <a href="${escapeHtml(`${explorer}/tx/${hash}`)}">tx</a>` : ` · <code>${hash.slice(0, 18)}…</code>` : ''}`);
  }
  const keyboard = [[button(L('刷新余额', 'Refresh balances'), 'wallet.refresh'), button(L('交易设置', 'Trade settings'), 'panel.open', { panel: 'trade_settings' })],
    [button(L('导出私钥', 'Export private key'), 'panel.open', { panel: 'wallet_export' }), button(L('移除钱包', 'Remove wallet'), 'panel.open', { panel: 'wallet_remove' })], [home]];
  return finishPanel(L('交易钱包', 'Trading wallet'), blocks, keyboard, snapshot, session, locale);
}

function settingsPanel(snapshot, session, locale) {
  const L = L_(locale), settings = snapshot.trading?.settings ?? { slippageBps: TRADING_SETTINGS.slippageBps, capUsd: TRADING_SETTINGS.buyCapUsd };
  const keyboard = [
    TRADING_SETTINGS.slippageChoicesBps.map(value => button(`${settings.slippageBps === value ? '✓ ' : ''}${value / 100}%`, 'trading.slippage.set', { value })),
    TRADING_SETTINGS.buyCapChoicesUsd.map(value => button(`${settings.capUsd === value ? '✓ ' : ''}$${value}`, 'trading.cap.set', { value })),
    [button(L('返回', 'Back'), 'panel.back')]
  ];
  return finishPanel(L('交易设置', 'Trade settings'), [`${L('滑点（第一行）', 'Slippage (first row)')}: ${settings.slippageBps / 100}%`, `${L('单笔买入上限（第二行）', 'Per-trade buy cap (second row)')}: $${settings.capUsd}`,
    L('超过上限的买入按钮不显示，自定义金额超过上限会被拒绝。', 'Buy buttons above the cap are hidden; custom amounts above it are refused.')], keyboard, snapshot, session, locale);
}

export function renderTradingPanel(snapshot, session, locale) {
  const L = L_(locale), back = [button(L('返回', 'Back'), 'panel.back')];
  if (session.panel === 'trade') return tradePanel(snapshot, session, locale);
  if (session.panel === 'wallet') return walletPanel(snapshot, session, locale);
  if (session.panel === 'trade_settings') return settingsPanel(snapshot, session, locale);
  if (session.panel === 'wallet_export') {
    return finishPanel(L('导出私钥', 'Export private key'), [L('私钥将以一条消息发送一次，60秒后尝试删除（无法保证删除）。任何拿到私钥的人都能转走资金。请离线保存，切勿分享。', 'The key is sent once in a message that the bot tries to delete after 60 seconds (deletion is not guaranteed). Anyone with the key can take the funds. Store it offline and never share it.')],
      [[button(L('发送私钥', 'Send the private key'), 'wallet.export')], back], snapshot, session, locale);
  }
  return finishPanel(L('移除交易钱包', 'Remove trading wallet'), [L('移除后机器人会删除私钥。未导出私钥时，钱包中剩余资金将永久无法找回。', 'Removing deletes the key from the bot. Without an export, any funds left in the wallet are unrecoverable forever.')],
    [[button(L('移除并删除私钥', 'Remove and delete the key'), 'wallet.remove')], back], snapshot, session, locale);
}
