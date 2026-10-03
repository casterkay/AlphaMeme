import { backendDisposition, effectiveStatus } from '../scoring/manual-review.mjs';
import { SCAN_CHAINS } from '../chains.mjs';
import { safetyVerdict, blockingUnknownFields } from '../scoring/safety.mjs';
import { scannerSettings } from '../scanner-settings.mjs';
import { aveTokenUrl } from '../providers/ave.mjs';
import { dexScreenerTokenUrl } from '../providers/secondary.mjs';
import { tokenIdentity, safeTelegramText } from './snapshot.mjs';
import { TRADING_PANELS, TRADING_PANEL_NAMES, tokenTradeControls, renderTradingPanel } from './trading-panels.mjs';
import { localize, escapeHtml, userText, chainLabel, button, urlButton, money, numberText, percent, timestamp, duration, clockTime, relativeTime, truth, textPages, finishPanel, officialXUrl, safetyBadge, ICONS } from '../render/telegram.mjs';

export const PANEL_NAMES = Object.freeze(['alert','radar','feed','audits','saved','events','status','sources','delivery','settings','chains','onboard','help','detail','evidence','view_chain','filter','sort','language','disconnect','stats','horizon','cohort','connection',...TRADING_PANELS]);
export const AUDIT_FILTERS = Object.freeze(['all','alerted','lead','chain','waiting','passed','ignored','rejected','fresh','favorite']);
export const AUDIT_SORTS = Object.freeze(['audit_desc','score_desc','market_desc','market_asc','liquidity_desc']);
export const FEED_SORTS = Object.freeze(['priority','volume']);
const AVE_KEY_URL = 'https://cloud.ave.ai/login';
const names = {
  radar:['雷达','Radar'], feed:['热榜','Hot list'], audits:['线索','Leads'], saved:['自选','Watchlist'], events:['动态','Activity'], status:['状态','Status'], sources:['来源','Sources'], delivery:['投递','Delivery'], settings:['设置','Settings'], chains:['扫描链','Scan chain'], onboard:['AVE密钥','AVE key'], help:['帮助','Help'], detail:['代币详情','Token detail'], evidence:['检查证据','Evidence'], view_chain:['查看链','View chain'], filter:['筛选','Filter'], sort:['排序','Order'], language:['语言','Language'], disconnect:['删除AVE密钥','Delete AVE key'], stats:['表现','Performance'], horizon:['观察窗口','Window'], cohort:['样本组别','Cohort'], connection:['AVE连接','AVE connection'],
  all:['全部','All'], alerted:['已提醒','Alerted'], lead:['线索','Leads'], chain:['待看X','Needs X review'], waiting:['复查中','Rechecking'], passed:['人工通过','Approved'], ignored:['已忽略','Ignored'], rejected:['已否决','Vetoed'], fresh:['近5分钟','Last 5 min'], favorite:['收藏','Favorites'], notes:['有备注','With notes'],
  audit_desc:['最新审计','Newest audit'], score_desc:['发现评分','Discovery score'], market_desc:['市值↓','Market cap ↓'], market_asc:['市值↑','Market cap ↑'], liquidity_desc:['流动性↓','Liquidity ↓'], priority:['通过筛选优先','Screen passes first'], volume:['5分钟成交额','5-minute volume'],
  candidates:['候选事件','Candidates'], risk:['风险变化','Risk changes'], service:['服务事件','Service'], unknown:['未知','Unknown'],
  ...TRADING_PANEL_NAMES
};
const name = (key, locale) => names[key] ? localize(locale, ...names[key]) : safeTelegramText(key, 80);
const id = row => tokenIdentity(row.chain, row.address);
const token = row => ({ chain: row.chain, address: row.address });
const markFor = (snapshot, row) => (snapshot.marks || []).find(mark => id(mark) === id(row));
const annotationFor = (snapshot, row) => (snapshot.annotations || []).find(mark => id(mark) === id(row));
const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const searchMatches = (row, search) => !search || [row.symbol,row.name,row.address].join(' ').toLowerCase().includes(search.trim().toLowerCase());
// A destination shares the icon of the state it fixes: one glyph per concept.
const PANEL_ICONS = { onboard: ICONS.key, disconnect: ICONS.delete };
const heading = (panel, locale) => { const icon = PANEL_ICONS[panel] ?? ICONS[panel]; return icon ? `${icon} ${name(panel, locale)}` : name(panel, locale); };
const open = (panel, locale, params = {}) => button(heading(panel, locale), 'panel.open', { panel, ...params });
const scanState = (control, locale) => !control.configured ? `${ICONS.disconnected} ${localize(locale,'未连接AVE','Not connected')}` : control.paused ? `${ICONS.paused} ${localize(locale,'已暂停','Paused')}` : `${ICONS.scanning} ${localize(locale,'扫描中','Scanning')}`;
const alertState = (control, locale) => control.notifications ? `${ICONS.alertsOn} ${localize(locale,'提醒开启','Alerts on')}` : `${ICONS.alertsOff} ${localize(locale,'提醒关闭','Alerts off')}`;

export function selectPanelRows(snapshot, session) {
  const query = session.query || {}, chain = session.viewChain;
  let rows;
  if (session.panel === 'feed') {
    rows = [...(snapshot.feedByChain?.[chain]?.rows || [])].filter(row => searchMatches(row, query.search));
    const sort = query.sort || 'priority';
    return rows.sort((a,b) => (sort === 'priority' ? Number(b.pass) - Number(a.pass) || Number(b.priorityBand) - Number(a.priorityBand) : 0) || number(b.volume5m) - number(a.volume5m)).slice(0,15);
  }
  if (session.panel === 'saved') {
    if (query.noteTargetMatches) {
      const candidates = [...snapshot.candidates, ...Object.values(snapshot.feedByChain || {}).flatMap(feed => feed.rows), ...snapshot.annotations];
      return query.noteTargetMatches.map(token => ({ ...candidates.find(row => id(row) === id(token)), ...token }));
    }
    return snapshot.annotations.filter(row => (!chain || chain === 'all' || row.chain === chain) && (query.filter !== 'favorite' || row.favorite) && (query.filter !== 'notes' || row.note?.trim()))
      .map(row => ({ ...snapshot.candidates.find(candidate => id(candidate) === id(row)), ...row }))
      .filter(row => searchMatches(row, query.search)).sort((a,b) => number(b.updatedAt) - number(a.updatedAt));
  }
  // Leads lists every token the radar still keeps; retention, not a time window, decides what that is.
  rows = snapshot.candidates.filter(row => (!chain || row.chain === chain) && searchMatches(row,query.search));
  rows = rows.filter(row => {
    const filter = query.filter || 'all';
    if (['lead','chain','waiting','passed','ignored','rejected'].includes(filter)) return effectiveStatus(row,markFor(snapshot,row),snapshot.at) === filter;
    if (filter === 'fresh') return snapshot.at - row.auditedAt <= 300_000;
    if (filter === 'alerted') return Number.isFinite(row.alertedAt);
    if (filter === 'favorite') return annotationFor(snapshot,row)?.favorite === true;
    return true;
  });
  return rows.sort((a,b) => {
    if (query.sort === 'score_desc') return number(b.discoveryScore) - number(a.discoveryScore);
    if (query.sort === 'market_desc') return number(b.marketCap) - number(a.marketCap);
    if (query.sort === 'market_asc') return number(a.marketCap) - number(b.marketCap);
    if (query.sort === 'liquidity_desc') return number(b.deep?.security?.liquidity ?? b.liquidity) - number(a.deep?.security?.liquidity ?? a.liquidity);
    return number(b.auditedAt) - number(a.auditedAt);
  });
}

function pagination(total, requested, size, locale, action = 'page.set') {
  const page = Math.min(Math.max(0, Number.isSafeInteger(requested) ? requested : 0), Math.max(0, Math.ceil(total / size) - 1));
  return { page, start: page * size, label: localize(locale, `第 ${page + 1}/${Math.max(1, Math.ceil(total / size))} 页`, `Page ${page + 1}/${Math.max(1, Math.ceil(total / size))}`), keyboard: [page > 0 ? button(`${ICONS.previous} ${localize(locale, '上一页', 'Previous')}`,action,{page:page - 1}) : null, (page+1)*size < total ? button(`${ICONS.next} ${localize(locale, '下一页', 'Next')}`,action,{page:page + 1}) : null].filter(Boolean) };
}
const detailButton = (row,index,locale) => button(`${index + 1} ${safeTelegramText(row.symbol || row.address?.slice(-8) || '?',30)}`, 'panel.open', { panel:'detail' },token(row));
const rowsOf = (items,size) => Array.from({length:Math.ceil(items.length/size)}, (_,index) => items.slice(index*size,index*size+size));
const rangeText = (start,end,total,locale) => localize(locale,`第${start}–${end}条，共${total}条`,`${start}–${end} of ${total}`);
const selectorButton = (panel,locale) => {
  const [icon,zh,en] = { view_chain:[ICONS.view_chain,'链','Chain'], filter:[ICONS.filter,'筛选','Filter'], sort:[ICONS.sort,'排序','Sort'] }[panel];
  return button(`${icon} ${localize(locale,zh,en)}`,'panel.open',{panel});
};
const present = value => value !== null && value !== undefined;

// The shared safety verdict plus the facts the display explains it with. A row
// that was never checked (hot-list or note-only) has no verdict at all; a pasted
// token's finished lookup has its check without being a candidate.
function tokenSafety(row) {
  if (!row.status && !row.secondary) return { verdict:null };
  const deep = row.deep || {}, secondary = row.secondary || null, security = secondary?.security || {}, blocking = blockingUnknownFields(deep);
  return {
    verdict:safetyVerdict({ status:row.status, secondary, deep }), checkedAt:secondary?.checkedAt || row.auditedAt || null,
    reasons:[...(security.fatal || []).map(item => item.field),...(deep.failed || [])],
    // On Arc, AVE's distinct sellers or DexScreener's sells stand in for GoPlus's missing cannot_sell_all.
    sellerStandIn:security.standIns?.cannotSellAll ?? null,
    counts:{
      failed:(deep.failed || []).length, blocking:blocking.length,
      // GoPlus records a missing check as the single field 'tokenSecurity'; it is not one unknown field.
      goPlusMissing:(security.unknownFields || []).includes('tokenSecurity'),
      unknown:new Set([...(deep.unknownFields || []).filter(field => !blocking.includes(field)),...(security.unknownFields || []).filter(field => field !== 'tokenSecurity')]).size
    }
  };
}
const safetyMark = (safety,locale) => safety.verdict ? safetyBadge(safety.verdict,locale) : `${ICONS.unknown} ${localize(locale,'未核验','Not checked')}`;
// A market lead stays stored after it stops being live; say so, and why when the screen failed it.
function liveState(row,snapshot,locale,{ reason = false } = {}) {
  if (row.status !== 'LIVE_READY' || !Number.isFinite(row.staleAt) || row.staleAt > snapshot.at) return '';
  const L = (zh,en) => localize(locale,zh,en);
  if (!Number.isFinite(row.screenFailedAt)) return L('已离开热榜','off the hot list');
  const why = reason && row.screenReasons?.length ? `${L('：',': ')}${userText(row.screenReasons[0],80)}` : '';
  return `${L('不再通过筛选','no longer passes the screen')}${why}`;
}

function safetyLine(safety,snapshot,locale) {
  const L = (zh,en) => localize(locale,zh,en);
  if (!safety.verdict) return `${ICONS.unknown} ${L('未经安全核验','Not safety-checked')}`;
  if (safety.verdict === 'PENDING') return safetyBadge('PENDING',locale);
  // A lookup's clean check too old to verify a buy says so, as the Buy question does.
  const checked = present(safety.checkedAt) ? ` · ${L(`${relativeTime(safety.checkedAt,snapshot.at,locale)}核验`,`checked ${relativeTime(safety.checkedAt,snapshot.at,locale)}`)}${safety.stale ? ` · ${L('已过期，重新粘贴地址即可重新核验','stale, paste the address again to re-check')}` : ''}` : '';
  const { failed, blocking, goPlusMissing, unknown } = safety.counts, plural = (count,one,many) => count === 1 ? one : many;
  const details = safety.verdict === 'VETOED' ? [...new Set(safety.reasons)].map(value => fieldLabels[value] ? L(...fieldLabels[value]) : safeTelegramText(value,48))
    : safety.verdict === 'PASSED' ? [present(safety.sellerStandIn?.distinctSellers24h) ? L(`无法全部卖出：GoPlus 无结果，以 AVE 24小时卖家数（${numberText(safety.sellerStandIn.distinctSellers24h,locale)}）代替`,
      `Cannot sell all: no GoPlus answer; AVE's 24h seller count (${numberText(safety.sellerStandIn.distinctSellers24h,locale)}) stands in`)
      : present(safety.sellerStandIn?.dexSells24h) ? L(`无法全部卖出：GoPlus 无结果，以 DexScreener 24小时卖出笔数（${numberText(safety.sellerStandIn.dexSells24h,locale)}）代替`,
        `Cannot sell all: no GoPlus answer; DexScreener's 24h sell count (${numberText(safety.sellerStandIn.dexSells24h,locale)}) stands in`) : ''].filter(Boolean) : [
      failed ? L(`${failed}项检查失败`,`${failed} failed ${plural(failed,'check','checks')}`) : '',
      blocking ? L(`${blocking}项阻断未知`,`${blocking} blocking unknown`) : '',
      goPlusMissing ? L('GoPlus 检查不可用','GoPlus check unavailable') : '',
      unknown ? L(`${unknown}项字段未知`,`${unknown} ${plural(unknown,'field','fields')} unknown`) : ''
    ].filter(Boolean);
  if (safety.verdict === 'INCOMPLETE' && !details.length) details.push(L('核验不完整','check incomplete'));
  const shown = safety.verdict === 'VETOED' ? details.slice(0,2) : details, more = details.length - shown.length;
  return `${safetyBadge(safety.verdict,locale)}${details.length ? `${L('：',': ')}${userText(shown.join(safety.verdict === 'VETOED' ? L('、',', ') : L('，',', ')),240)}${more ? ` +${more}` : ''}` : ''}${checked}`;
}

function listPanel(snapshot,session,locale) {
  const L = (zh,en) => localize(locale,zh,en), query = session.query || {};
  const rows = selectPanelRows(snapshot,session), paging = pagination(rows.length,query.page,5,locale);
  const shown = rows.slice(paging.start,paging.start+5), isLive = session.panel === 'feed', saved = session.panel === 'saved';
  const feed = snapshot.feedByChain?.[session.viewChain];
  // Only state the owner changed is printed; defaults stay silent.
  const header = [session.viewChain && session.viewChain !== 'all' ? chainLabel(session.viewChain) : L('全部链','All chains')];
  if (query.filter && query.filter !== 'all') header.push(`${L('筛选','Filter')}: ${name(query.filter,locale)}`);
  if (query.sort && query.sort !== (isLive ? 'priority' : 'audit_desc')) header.push(`${L('排序','Sort')}: ${name(query.sort,locale)}`);
  if (query.search) header.push(`${L('搜索','Search')}: "${safeTelegramText(query.search,128)}"`);
  const blocks = [userText(header.join(' · '),400)];
  if (isLive) {
    if (!feed?.observedAt) blocks.push(L('等待首次读取AVE热榜','Waiting for the first AVE hot-list read'));
    else if (snapshot.at-feed.observedAt > 120_000) blocks.push(L('数据已陈旧','Data stale'));
    if (feed?.status && feed.status !== 'READY') blocks.push(`${L('读取状态','Read status')}: ${reasonText(feed.status,locale)}`);
    if (snapshot.control?.scanChain !== session.viewChain) blocks.push(L('此链未在扫描，显示最后一次读取','This chain is not being scanned; showing its last read'));
  }
  blocks.push('');
  shown.forEach((row,index) => {
    const title = `<b>${paging.start + index + 1}. ${userText(row.symbol || '?',30)}</b>`;
    if (isLive) {
      // ✅ is reserved for the safety check; a market-screen pass alone earns no icon.
      const candidate = snapshot.candidates.find(item => id(item) === id(row));
      blocks.push(`${title} · ${candidate ? safetyMark(tokenSafety(candidate),locale) : row.pass ? L('通过筛选','passed screen') : userText(row.reasons[0] || name('unknown',locale),60)}`);
      blocks.push([present(row.marketCap) ? money(row.marketCap,locale) : '', row.createdAt > 0 ? L(`币龄${duration(snapshot.at-row.createdAt*1000,locale)}`,`${duration(snapshot.at-row.createdAt*1000,locale)} old`) : '',
        present(row.volume5m) ? L(`5分钟成交${money(row.volume5m,locale)}`,`5m vol ${money(row.volume5m,locale)}`) : '', present(row.priceChange5m) ? percent(row.priceChange5m,locale,true) : ''].filter(Boolean).join(' · '));
    } else {
      const mark = markFor(snapshot,row), status = row.status && mark ? effectiveStatus(row,mark,snapshot.at) : null;
      const marked = status === 'passed' ? ` · ${ICONS.approve} ${name('passed',locale)}` : mark?.decision === 'ignored' ? ` · ${ICONS.ignore} ${name('ignored',locale)}` : '';
      blocks.push(`${title} · ${safetyMark(tokenSafety(row),locale)}${marked}${Number.isFinite(row.alertedAt) && !saved ? ` · ${ICONS.alertsOn}` : ''}`);
      if (saved) blocks.push([chainLabel(row.chain),row.symbol ? '' : `<code>${userText(row.address?.slice(-12),12)}</code>`,row.favorite ? ICONS.saved : '',row.note?.trim() ? `${ICONS.note} ${userText(row.note,60)}` : ''].filter(Boolean).join(' · '));
      else blocks.push([present(row.marketCap) ? L(`市值 ${money(row.marketCap,locale)}`,`${money(row.marketCap,locale)} MC`) : '',present(row.liquidity) ? L(`流动性 ${money(row.liquidity,locale)}`,`${money(row.liquidity,locale)} liq`) : '',relativeTime(row.auditedAt,snapshot.at,locale),liveState(row,snapshot,locale)].filter(Boolean).join(' · '));
    }
    blocks.push('');
  });
  if (!shown.length) blocks.push(L('没有符合条件的记录','No matching records'));
  else blocks.push(rangeText(paging.start+1,paging.start+shown.length,rows.length,locale),paging.label);
  if (isLive && feed?.observedAt) blocks.push(`${L('本次读取','This read')}: ${numberText(feed.receivedCount,locale)} · ${L('线索','leads')}: ${numberText(feed.leadCount,locale)}`);
  const keyboard = rowsOf(shown.map((row,index) => session.query?.noteTargetMatches ? button(`${paging.start + index + 1} ${safeTelegramText(row.symbol || row.address.slice(-8),30)}`, 'note.select', {}, token(row)) : detailButton(row,paging.start+index,locale)),2);
  keyboard.push([selectorButton('view_chain',locale),isLive ? null : selectorButton('filter',locale),saved ? null : selectorButton('sort',locale)]);
  keyboard.push([button(`${ICONS.search} ${L('搜索','Search')}`,'input.begin',{kind:'search'}),query.search ? button(`${ICONS.clear} ${L('清空','Clear')}`,'search.clear') : null],paging.keyboard);
  const footnote = isLive && feed?.observedAt ? L(`热榜读取于${relativeTime(feed.observedAt,snapshot.at,locale)}`,`hot list read ${relativeTime(feed.observedAt,snapshot.at,locale)}`) : null;
  return finishPanel(name(session.panel,locale),blocks,keyboard,snapshot,session,locale,{footnote});
}

const fieldLabels = {
  openSource:['开源','Open source'],ownerRenounced:['所有权放弃','Owner renounced'],honeypot:['貔貅风险','Honeypot'],buyTax:['买入税','Buy tax'],sellTax:['卖出税','Sell tax'],taxDifference:['税差','Tax difference'],rugRatio:['跑路比例','Rug ratio'],top10:['前10持仓','Top 10 holdings'],devHold:['开发者持仓','Developer holdings'],insider:['内幕持仓','Insider holdings'],bundler:['捆绑持仓','Bundler holdings'],sniperHold:['狙击持仓','Sniper holdings'],lockRate:['锁仓比例','Locked ratio'],lpBurned:['LP销毁','LP burned'],liquidity:['流动性','Liquidity'],sampled:['钱包样本','Sampled wallets'],ordinaryCount:['普通钱包数','Ordinary wallets'],ordinaryHoldRate:['普通钱包持仓','Ordinary holdings'],riskWalletCount:['风险钱包数','Risk wallets'],botHoldRate:['机器人持仓','Bot holdings'],linkedHoldRate:['关联持仓','Linked holdings'],duplicateCount:['重复数','Duplicates'],missingAddressCount:['缺失地址数','Missing addresses'],invalidRateCount:['无效比例数','Invalid ratios'],dataComplete:['证据完整','Evidence complete'],pass:['通过','Passed'],status:['状态','Status'],reason:['原因','Reason'],bars:['K线数','Candle count'],return5m:['5分钟收益','5-minute return'],maxDrawdown:['最大回撤','Maximum drawdown'],volumeConcentration:['成交集中度','Volume concentration'],totalVolume:['总成交','Total volume'],activeBars:['活跃K线','Active candles'],volumeChange:['成交变化','Volume change'],volumeTrend:['成交趋势','Volume trend'],decliningVolumeBars:['成交递减K线','Declining volume candles'],invalidBars:['无效K线','Invalid candles'],duplicateBars:['重复K线','Duplicate candles'],continuous:['连续','Continuous'],fresh:['新鲜','Fresh'],latestClosedAt:['最后闭合时间','Last closed time'],stalenessMs:['证据滞后毫秒','Evidence lag (ms)'],sells5m:['5分钟卖出','5-minute sells'],sells24h:['24小时卖出','24-hour sells'],distinctSellers:['不同卖家','Distinct sellers'],historicalDistinctSellers:['历史不同卖家','Historical distinct sellers'],windowSec:['窗口秒数','Window seconds'],evidenceType:['证据类型','Evidence type'],evidenceNote:['证据局限','Evidence limitations'],unknownFields:['未知字段','Unknown fields'],complete:['完整','Complete'],checkedAt:['核验时间','Checked at'],marketCap:['市值','Market cap'],verdict:['结论','Verdict'],field:['字段','Field'],type:['类别','Type'],notHoneypot:['无貔貅风险','Not honeypot'],lpLocked:['LP锁定','LP locked'],tax:['交易税','Trading tax'],rug:['跑路风险','Rug risk'],concentration:['持仓集中度','Concentration'],dev:['开发者','Developer'],sniper:['狙击者','Sniper'],wash:['刷量','Wash trading'],wallets:['钱包','Wallets'],observation:['价格观察','Price observation'],chartRisk:['图形风险','Chart risk'],marketBehavior:['市场行为','Market behavior'],from:['起始时间','Start time'],to:['结束时间','End time'],reasons:['原因','Reasons'],fatal:['致命证据','Fatal evidence']
};
Object.assign(fieldLabels, {
  discovery:['发现来源','Discovery sources'],lastAudit:['最近审计来源','Last audit sources'],lastSecondary:['最近第二来源','Last secondary sources'],endpoints:['接口','Endpoints'],sources:['来源','Sources'],trenches:['新币发现','Trenches'],trending:['趋势榜','Trending'],newPools:['链上新池','New pools on chain'],watch:['新池观察','New pools watched'],promoted:['新池送筛','New pools screened'],info:['基本信息','Token information'],security:['安全','Security'],pool:['资金池','Pool'],holders:['持有人','Holders'],traders:['交易者','Traders'],candles:['K线','Candles'],ok:['可用','Available'],code:['原因','Reason'],count:['条数','Count'],errorCode:['错误原因','Error reason'],codes:['风险原因','Risk reasons'],evidence:['证据','Evidence'],downgradeReasons:['降级原因','Downgrade reasons'],warnings:['警告','Warnings'],strengths:['积极证据','Supporting evidence'],smartWallets:['聪明钱钱包','Smart money wallets'],renownedWallets:['知名钱包','Renowned wallets'],taggedSmartWallets:['标签聪明钱钱包','Tagged smart wallets'],taggedRenownedWallets:['标签知名钱包','Tagged renowned wallets'],sampledTaggedWallets:['标签钱包样本','Tagged wallet samples'],holderCount:['持有人数','Holder count'],holderSampleDistinct:['不同持有人样本','Distinct holder samples'],swaps5m:['5分钟交换','5-minute swaps'],buys5m:['5分钟买入','5-minute buys'],volume5m:['5分钟成交','5-minute volume'],priceChange5m:['5分钟价格变化','5-minute price change'],swapsPerHolder5m:['每持有人交换数','Swaps per holder'],swapCountConsistent:['交易计数一致','Trade count consistent'],holderSampleConsistent:['持有人样本一致','Holder sample consistent'],sellBuyRatio:['卖买比','Sell/buy ratio'],ageSec:['币龄秒数','Age in seconds'],creatorStatus:['创建者状态','Creator status'],creatorLaunchCount:['创建者发币数','Creator launches'],creatorCreatedCount:['创建数','Created count'],creatorGraduatedCount:['毕业数','Graduated count'],creatorOpenRatio:['开放比例','Open ratio'],creatorDeletedPosts:['删除帖子数','Deleted posts'],creatorPromotedTokens:['推广代币数','Promoted tokens'],isHoneypot:['貔貅风险','Honeypot'],mintable:['可增发','Mintable'],ownerChangeBalance:['所有者可改余额','Owner can change balance'],hiddenOwner:['隐藏所有者','Hidden owner'],cannotSellAll:['无法全部卖出','Cannot sell all'],standIns:['替代证据','Stand-in evidence'],distinctSellers24h:['AVE 24小时不同卖家','AVE distinct sellers (24h)'],dexSells24h:['DexScreener 24小时卖出笔数','DexScreener sells (24h)'],selfDestruct:['可自毁','Self-destruct'],externalCall:['外部调用','External calls'],slippageModifiable:['可修改滑点','Slippage modifiable'],personalSlippageModifiable:['可修改个人滑点','Personal slippage modifiable'],transferPausable:['可暂停转账','Transfers pausable'],blacklisted:['黑名单','Blacklisted'],tradingCooldown:['交易冷却','Trading cooldown'],freezable:['可冻结','Freezable'],closable:['可关闭','Closable'],balanceMutableAuthority:['可修改余额权限','Balance mutable authority'],transferFeeUpgradable:['可更新转账费','Transfer fee upgradable'],nonTransferable:['不可转账','Non-transferable']
});
const reasonLabels = {
  STALE_RULES:['风险规则已更新，等待复核','Risk rules changed; awaiting recheck'],AVE_RATE_LIMITED:['AVE限流，冷却中','AVE rate limited; cooling down'],AVE_QUOTA:['AVE额度用完','AVE credits exhausted'],AVE_AUTH:['AVE密钥不可用，请重新连接','AVE key unavailable; reconnect'],AVE_TIMEOUT:['AVE响应超时','AVE timed out'],AVE_NETWORK:['AVE连接失败','AVE connection failed'],AUDIT_FAILED:['深度审计失败，等待复查','Audit failed; awaiting recheck'],REQUEST_WAIT:['等待采集窗口','Waiting for a collection slot'],BLOCKED:['密钥被临时封锁，请检查Key或配额','Key temporarily blocked; check the key or quota'],REQUEST_FAILED:['采集请求失败','Feed request failed'],VERTICAL_PLATEAU:['急涨后窄幅平台','Vertical rise followed by a narrow plateau'],SUSTAINED_COLLAPSE:['持续大幅回撤','Sustained severe drawdown'],RATE_LIMITED:['请求额度受限','Rate limited'],AUTH_REQUIRED:['密钥不可用，请重新连接','Key unavailable; reconnect'],UNSUPPORTED:['来源不支持此链','Source does not support this chain'],NO_DATA:['来源暂无数据','No source data'],ERROR:['来源读取失败','Source read failed'],OK:['正常','OK'],WAIT_RECHECK:['等待复查','Waiting for recheck'],HARD_REJECT:['已排除','Rejected'],X_REVIEW:['等待人工看X','Review X manually']
};
export const reasonText = (value,locale) => fieldLabels[value] ? localize(locale,...fieldLabels[value]) : reasonLabels[value] ? localize(locale,...reasonLabels[value]) : `${localize(locale,'证据不完整，请查看来源','Incomplete evidence; check the source')}: ${safeTelegramText(value,500)}`;
function evidenceLines(value,locale,prefix='') {
  if (Array.isArray(value)) return value.flatMap((item,index) => typeof item === 'object' && item !== null ? evidenceLines(item,locale,`${prefix} ${index+1}`) : [`${prefix} ${index+1}: ${reasonText(item,locale)}`]);
  if (value && typeof value === 'object') return Object.entries(value).filter(([key]) => !['version','reviewRevision'].includes(key)).flatMap(([key,item]) => evidenceLines(item,locale,`${prefix ? prefix+' · ' : ''}${fieldLabels[key] ? localize(locale,...fieldLabels[key]) : safeTelegramText(key,60)}`));
  return [`${prefix}: ${typeof value === 'boolean' ? truth(value,locale) : typeof value === 'number' ? numberText(value,locale) : value === null || value === undefined || value === '' ? name('unknown',locale) : safeTelegramText(value,500)}`];
}

// The candidate is the token of record, then a pasted token's lookup; the
// latest hot-list row supplies the age and 5-minute facts a candidate does not keep.
function findToken(snapshot,session) {
  const selected = session.query?.selectedToken;
  if (!selected) return null;
  const candidate = snapshot.candidates.find(row => id(row) === id(selected));
  const lookup = candidate ? null : (snapshot.lookups || []).find(row => id(row) === id(selected)) || null;
  const listed = snapshot.feedByChain?.[selected.chain]?.rows?.find(row => id(row) === id(selected)) || null;
  const annotation = snapshot.annotations.find(row => id(row) === id(selected));
  const row = candidate || lookup || (listed ? { ...listed, info:{} } : annotation ? { ...annotation, symbol:'?' } : null);
  return row && { row, listed, lookup };
}

const LOOKUP_FAILURES = {
  AVE_AUTH:['AVE密钥不可用，请重新连接','AVE key unavailable; reconnect'], AVE_SCHEMA:['AVE返回了无法识别的结果','AVE returned an answer it could not be read from'], AVE_SIZE:['AVE响应过大','AVE answered with too much data'],
  AVE_TIMEOUT:['AVE响应超时','AVE timed out'], SCHEDULER_REQUEST_TIMEOUT:['AVE响应超时','AVE timed out'], AVE_NETWORK:['无法连接AVE','Could not reach AVE'], AVE_UPSTREAM:['AVE服务暂时出错','AVE is temporarily unavailable'],
  AVE_CREDENTIAL_MISSING:['AVE未连接','AVE is not connected'], AVE_CREDENTIAL_CORRUPT:['AVE密钥不可用，请重新连接','AVE key unavailable; reconnect']
};

// A failing source's code in words; a code with no wording yet is shown as received.
const SOURCE_PROBLEMS = {
  ONCHAIN_NOT_CONFIGURED:['未配置此链的RPC','No RPC configured for this chain'], ONCHAIN_UNSUPPORTED:['此链暂无链上发现','No on-chain discovery for this chain'],
  ONCHAIN_NETWORK:['无法连接RPC','RPC unreachable'], ONCHAIN_TIMEOUT:['RPC响应超时','RPC timed out'], ONCHAIN_SCHEMA:['RPC返回了无法识别的结果','RPC answer unreadable'], ONCHAIN_FAILED:['RPC读取失败','RPC read failed'],
  TIMEOUT:['响应超时','Timed out'], REQUEST_FAILED:['请求失败','Request failed'], UPSTREAM_REJECTED:['拒绝了请求','Rejected the request'], RESPONSE_TOO_LARGE:['响应过大','Answer too large'],
  INVALID_JSON:['返回了无法识别的结果','Answer unreadable'], INVALID_JSON_SHAPE:['返回了无法识别的结果','Answer unreadable'], INVALID_CONTENT_TYPE:['返回了无法识别的结果','Answer unreadable'], INVALID_RESPONSE:['返回了无法识别的结果','Answer unreadable'], NORMALIZATION_MISSING:['返回了无法识别的结果','Answer unreadable'],
  INVALID_ADDRESS:['代币地址无效','Invalid token address'], RATE_LIMITED:['请求受限','Rate limited'],
  GOPLUS_AUTH_REJECTED:['GoPlus拒绝了应用密钥','GoPlus refused the app key'], GOPLUS_AUTH_TIMEOUT:['GoPlus登录超时','GoPlus sign-in timed out'], GOPLUS_AUTH_FAILED:['GoPlus登录失败','GoPlus sign-in failed']
};
function sourceProblem(code,locale) {
  const L=(zh,en)=>localize(locale,zh,en),http=/^(?:ONCHAIN_)?HTTP_(\d+)$/.exec(code || ''),rpc=/^ONCHAIN_RPC(?:_(\d+))?$/.exec(code || '');
  if(http) return http[1] === '429' ? L('请求受限 (429)','Rate limited (429)') : L(`请求被拒绝 (HTTP ${http[1]})`,`Request refused (HTTP ${http[1]})`);
  if(rpc) return L('RPC返回错误','RPC returned an error')+(rpc[1] ? ` ${rpc[1]}` : '');
  const known=SOURCE_PROBLEMS[code] || LOOKUP_FAILURES[code] || reasonLabels[code];
  return known ? L(...known) : code ? safeTelegramText(code,48) : name('unknown',locale);
}

const LOOKUP_CHECK_FAILURES = { GOPLUS:['GoPlus 检查未完成','the GoPlus check did not finish'] };

// A pasted token's lookup (§4): progress while it runs, then AVE's market facts and the shared verdict.
function lookupDetail(snapshot,session,locale,lookup,listed) {
  const L = (zh,en) => localize(locale,zh,en), identity = token(lookup), annotation = annotationFor(snapshot,lookup);
  // A recorded veto stands until a later complete check clears it, whatever this run's state.
  const safety = lookup.veto ? { verdict:'VETOED', checkedAt:lookup.veto.checkedAt, reasons:lookup.veto.fields, counts:{} } : { ...tokenSafety(lookup), stale:lookup.stale };
  const where = chainLabel(lookup.chain), others = SCAN_CHAINS.filter(chain => chain !== lookup.chain);
  const status = ['DETAILS','GOPLUS'].includes(lookup.state)
    ? lookup.state === 'DETAILS' && snapshot.ave?.readyAt > snapshot.at ? `${ICONS.checking} ${L('等待AVE额度','Waiting for AVE capacity')}` : `${ICONS.checking} ${L(`正在 ${where} 上查询…`,`Looking up on ${where}…`)}`
    : lookup.state === 'NOT_FOUND' ? `${ICONS.unknown} ${L(`AVE在 ${where} 上没有此地址的代币。`,`AVE has no token at this address on ${where}.`)}`
      : lookup.state === 'FAILED' ? `${ICONS.unknown} ${L('查询失败','Lookup failed')}${L('：',': ')}${L(...(lookup.failedStep !== 'DETAILS' ? LOOKUP_CHECK_FAILURES[lookup.failedStep] : LOOKUP_FAILURES[lookup.reason] ?? ['无法读取AVE','AVE could not be read']))}`
        : null;
  const fact = key => lookup[key] ?? listed?.[key] ?? null, createdAt = fact('createdAt');
  const blocks = [status,lookup.state === 'DONE' || lookup.veto ? safetyLine(safety,snapshot,locale) : null,
    [present(fact('marketCap')) ? L(`市值 ${money(fact('marketCap'),locale)}`,`MC ${money(fact('marketCap'),locale)}`) : '',present(fact('liquidity')) ? L(`流动性 ${money(fact('liquidity'),locale)}`,`Liq ${money(fact('liquidity'),locale)}`) : '',present(fact('holders')) ? L(`持有人 ${numberText(fact('holders'),locale)}`,`${numberText(fact('holders'),locale)} holders`) : ''].filter(Boolean).join(' · '),
    [createdAt > 0 ? L(`币龄${duration(snapshot.at-createdAt*1000,locale)}`,`${duration(snapshot.at-createdAt*1000,locale)} old`) : '',present(fact('priceChange5m')) ? `5m ${percent(fact('priceChange5m'),locale,true)}` : '',present(fact('volume5m')) ? L(`5分钟成交 ${money(fact('volume5m'),locale)}`,`5m vol ${money(fact('volume5m'),locale)}`) : ''].filter(Boolean).join(' · '),
    `<code>${userText(lookup.address,80)}</code>`,
    [annotation?.favorite ? `${ICONS.saved} ${L('已加入自选','In watchlist')}` : '',annotation?.note ? `${ICONS.note} "${userText(annotation.note,140)}${annotation.note.length>140 ? '…' : ''}"` : ''].filter(Boolean).join(' · '),
    present(lookup.capturedAt) ? `AVE · ${relativeTime(lookup.capturedAt,snapshot.at,locale)}` : ''];
  const trading = tokenTradeControls(snapshot,lookup,locale,identity,lookup.verdict === 'VETOED');
  blocks.push(...trading.blocks);
  const keyboard = [...trading.keyboard,
    [urlButton(`${ICONS.site} ${L('官网','Site')}`,lookup.website),urlButton(`${ICONS.chart} ${L('图表','Chart')}`,dexScreenerTokenUrl(lookup.chain,lookup.address)),urlButton(`${ICONS.ave} ${L('资料','Profile')}`,aveTokenUrl(lookup.chain,lookup.address))],
    [button(`${ICONS.saved} ${annotation?.favorite ? L('取消自选','Unwatch') : L('自选','Watch')}`,'favorite.set',{value:annotation?.favorite !== true},identity),button(`${ICONS.note} ${L('备注','Note')}`,'note.begin',{},identity),annotation?.note ? button(`${ICONS.clear} ${L('清空备注','Clear note')}`,'note.clear',{},identity) : null],
    lookup.state === 'FAILED' ? [button(`${ICONS.refresh} ${L('重试','Retry')}`,'lookup.start',{retry:true},identity)] : [],
    // Until AVE confirms the token here, the likely cause of a miss is the wrong chain, whichever way AVE says it.
    ...(lookup.state === 'NOT_FOUND' || lookup.failedStep === 'DETAILS' ? rowsOf(others.map(chain => button(L(`在 ${chainLabel(chain)} 上查询`,`Try on ${chainLabel(chain)}`),'lookup.start',{},{ chain,address:lookup.address })),2) : [])];
  return finishPanel(`${safeTelegramText(lookup.symbol || '?',30)} · ${where}`,blocks.filter(value => value !== '' && value !== null),keyboard,snapshot,session,locale,{token:identity});
}

function detailPanel(snapshot,session,locale) {
  const L = (zh,en) => localize(locale,zh,en), found = findToken(snapshot,session);
  if (found?.lookup && session.panel === 'detail') return lookupDetail(snapshot,session,locale,found.lookup,found.listed);
  if (!found) return finishPanel(name('detail',locale),[L('未找到，请从列表选择代币','Not found; choose a token from a list')],[],snapshot,session,locale,{refresh:false});
  const { row, listed } = found, mark = markFor(snapshot,row), annotation = annotationFor(snapshot,row), identity = token(row), deep = row.deep || {};
  const safety = tokenSafety(row), invalidApproval = mark?.decision === 'passed' && effectiveStatus(row,mark,snapshot.at) !== 'passed';
  if (session.panel === 'evidence') {
    const checks = Object.values(deep.checks || {}), unknown = deep.unknownFields || [], blocking = deep.blockingUnknownFields || [];
    const header = [`${userText(row.symbol || '?',30)} · ${chainLabel(row.chain)} · ${safetyMark(safety,locale)}`, `CA: <code>${userText(row.address,80)}</code>`,`${L('审计','Audit')}: ${timestamp(row.auditedAt,locale)} · ${relativeTime(row.auditedAt,snapshot.at,locale)}`];
    if (invalidApproval) header.push(L('原人工通过已失效，请查看当前证据。','Prior approval is invalid; review current evidence.'));
    const counts = `${L('通过/未通过检查','Passed/not-passed checks')}: ${checks.filter(value => value === true).length}/${checks.filter(value => value === false).length}\n${L('明确失败/阻断未知/其他未知','Explicit failures/blocking unknown/other unknown')}: ${(deep.failed || []).length}/${blocking.length}/${unknown.filter(value => !blocking.includes(value)).length}`;
    const sections = [
      [L('阻断发现','Blocking findings'), [...(deep.failed || []).map(value => `${L('失败','Failure')}: ${reasonText(value,locale)}`),...blocking.map(value => `${L('阻断未知','Blocking unknown')}: ${safeTelegramText(value)}`),...unknown.filter(value => !blocking.includes(value)).map(value => `${L('其他未知','Other unknown')}: ${safeTelegramText(value)}`),row.auditHealth?.earlyExit ? L('审计提前结束，部分证据未采集','Audit exited early; some evidence was not collected') : '',row.decisionReason ? reasonText(row.decisionReason,locale) : '',...evidenceLines(deep.checks || {},locale)]],
      [L('合约与供应','Contract and supply'),[safeTelegramText(deep.honeypotEvidence,500),...evidenceLines(deep.security || {},locale)]],
      [L('持有人与钱包','Holders and wallets'),evidenceLines(deep.wallets || {},locale)],
      [L('价格与可卖出性','Price and sellability'),[...evidenceLines(deep.observation || {},locale),...evidenceLines(deep.chartRisk || {},locale),...evidenceLines(deep.marketBehavior || {},locale),...evidenceLines(deep.sellability || {},locale)]],
      [L('第二来源','Second sources'),evidenceLines(row.secondary || {},locale)],
      [L('完整备注','Full note'),[annotation?.note || L('无备注','No note')]]
    ];
    const pages = sections.flatMap(([title,lines]) => textPages(lines.filter(Boolean).length ? lines.filter(Boolean) : [L('未知；未视为通过','Unknown; not treated as passed')],1800).map((items,index) => ({ title:`${ICONS.evidence} ${title} · ${index+1}`,items })));
    const paging = pagination(pages.length,session.query?.detailPage,1,locale), page = pages[paging.page];
    return finishPanel(page.title,[...header,counts,'',...page.items.map(value => userText(value,2400)),paging.label], [paging.keyboard,[button(L('摘要','Summary'),'panel.open',{panel:'detail'},identity)]],snapshot,session,locale,{token:identity,refresh:false});
  }
  const fact = key => row[key] ?? listed?.[key] ?? null, liquidity = deep.security?.liquidity ?? fact('liquidity'), createdAt = fact('createdAt');
  const blocks = [safetyLine(safety,snapshot,locale),liveState(row,snapshot,locale,{ reason:true }) || null,
    [present(fact('marketCap')) ? L(`市值 ${money(fact('marketCap'),locale)}`,`MC ${money(fact('marketCap'),locale)}`) : '',present(liquidity) ? L(`流动性 ${money(liquidity,locale)}`,`Liq ${money(liquidity,locale)}`) : '',present(fact('holders')) ? L(`持有人 ${numberText(fact('holders'),locale)}`,`${numberText(fact('holders'),locale)} holders`) : ''].filter(Boolean).join(' · '),
    [createdAt > 0 ? L(`币龄${duration(snapshot.at-createdAt*1000,locale)}`,`${duration(snapshot.at-createdAt*1000,locale)} old`) : '',present(listed?.priceChange5m) ? `5m ${percent(listed.priceChange5m,locale,true)}` : '',present(listed?.volume5m) ? L(`5分钟成交 ${money(listed.volume5m,locale)}`,`5m vol ${money(listed.volume5m,locale)}`) : ''].filter(Boolean).join(' · '),
    `<code>${userText(row.address,80)}</code>`];
  const status = mark ? effectiveStatus(row,mark,snapshot.at) : null;
  blocks.push([annotation?.favorite ? `${ICONS.saved} ${L('已加入自选','In watchlist')}` : '',status === 'passed' ? `${ICONS.approve} ${name('passed',locale)}` : status === 'ignored' ? `${ICONS.ignore} ${name('ignored',locale)}` : '',
    annotation?.note ? `${ICONS.note} "${userText(annotation.note,140)}${annotation.note.length>140 ? `…"${L('（完整备注见证据）',' (full note in Evidence)')}` : '"'}` : ''].filter(Boolean).join(' · '));
  if (invalidApproval) blocks.push(L('原人工通过已失效，请查看当前证据。','Prior approval is invalid; review current evidence.'));
  if (!row.auditedAt) blocks.push(L('审计快照已不再保留，或尚未审计。','Audit snapshot no longer retained, or not yet audited.'));
  if (backendDisposition(row) === 'chain') blocks.push(L('链上硬门通过；请人工查看X社区评论与回复。','On-chain gates passed; review X community comments and replies.'));
  if (backendDisposition(row) === 'lead' && safety.verdict !== 'VETOED' && row.secondary?.status !== 'COMPLETE') blocks.push(L('市场线索：安全性尚未核验。','Market lead: safety not yet verified.'));
  // Buy follows the engine's safetyState: a vetoed lookup of the same token vetoes it too.
  const lookupVetoed = (snapshot.lookups || []).some(item => id(item) === id(row) && item.verdict === 'VETOED');
  const trading = tokenTradeControls(snapshot,row,locale,identity,safety.verdict === 'VETOED' || lookupVetoed);
  blocks.push(...trading.blocks);
  const binding = { reviewRevision:row.reviewRevision || null, expectedMarkVersion:mark?.version || 0 };
  const eligible = !mark?.decision && row.reviewRevision && backendDisposition(row) === 'chain' && row.auditedAt && snapshot.at-row.auditedAt <= 600_000;
  const keyboard = [...trading.keyboard,
    [urlButton(ICONS.x,officialXUrl(row.info?.twitter,row.social?.twitter,row.twitter)),urlButton(`${ICONS.site} ${L('官网','Site')}`,row.info?.website),urlButton(`${ICONS.chart} ${L('图表','Chart')}`,dexScreenerTokenUrl(row.chain,row.address)),urlButton(`${ICONS.ave} ${L('资料','Profile')}`,aveTokenUrl(row.chain,row.address)),button(`${ICONS.evidence} ${L('证据','Evidence')}`,'panel.open',{panel:'evidence'},identity)],
    [button(`${ICONS.saved} ${annotation?.favorite ? L('取消自选','Unwatch') : L('自选','Watch')}`,'favorite.set',{value:annotation?.favorite !== true},identity),button(`${ICONS.note} ${L('备注','Note')}`,'note.begin',{},identity),mark?.decision === 'ignored' ? null : button(`${ICONS.ignore} ${L('忽略','Ignore')}`,'mark.set_ignored',binding,identity)],
    [mark?.decision ? button(mark.decision === 'passed' ? L('撤销人工通过','Undo approval') : L('取消忽略','Stop ignoring'),'mark.clear',binding,identity) : eligible ? button(`${ICONS.approve} ${L('人工通过','Approve')}`,'mark.set_passed',binding,identity) : null,annotation?.note ? button(`${ICONS.clear} ${L('清空备注','Clear note')}`,'note.clear',{},identity) : null]];
  return finishPanel(`${safeTelegramText(row.symbol || '?',30)} · ${chainLabel(row.chain)}`,blocks.filter(value => value !== ''),keyboard,snapshot,session,locale,{token:identity});
}

function selectorPanel(snapshot,session,locale) {
  const L = (zh,en) => localize(locale,zh,en), query = session.query || {}, origin = query.returnTo?.panel || 'audits';
  let choices, action, selected;
  if (session.panel === 'view_chain') { choices = [...(['saved','events'].includes(origin) ? ['all'] : []),...SCAN_CHAINS]; action='view_chain.set';selected=session.viewChain; }
  else if (session.panel === 'filter') { choices = origin === 'saved' ? ['all','favorite','notes'] : origin === 'events' ? ['all','candidates','risk','service'] : AUDIT_FILTERS; action='filter.set';selected=query.filter || 'all'; }
  else if (session.panel === 'sort') { choices=origin === 'feed' ? FEED_SORTS : AUDIT_SORTS;action='sort.set';selected=query.sort || (origin === 'feed' ? 'priority' : 'audit_desc'); }
  else if (session.panel === 'language') { choices=['zh','en'];action='language.set';selected=locale; }
  else if (session.panel === 'horizon') { choices=['m5','m15','m30','h1','h2','h6','h24'];action='horizon.set';selected=query.horizon || 'm30'; }
  else { choices=['passed','rejected','compare'];action='cohort.set';selected=query.cohort || 'passed'; }
  const labels = { zh:'中文',en:'English',passed:L('通过筛选组','Passed the screen'),rejected:L('否决对照组','Vetoed control'),compare:L('对比','Compare'),m5:'5m',m15:'15m',m30:'30m',h1:'1h',h2:'2h',h6:'6h',h24:'24h' };
  const keyboard = rowsOf(choices.map(value => button(`${selected === value ? '✓ ' : ''}${SCAN_CHAINS.includes(value) ? chainLabel(value) : labels[value] || name(value,locale)}`,action,{value})),session.panel === 'horizon' ? 3 : 2);
  const blocks = session.panel === 'view_chain' ? [L('查看某条链不会改变扫描的链。','Viewing a chain does not change what is scanned.')] : [];
  return finishPanel(name(session.panel,locale),blocks,keyboard,snapshot,session,locale,{refresh:false});
}

function eventsPanel(snapshot,session,locale) {
  const L = (zh,en) => localize(locale,zh,en), query=session.query || {};
  const groups={candidates:['CANDIDATE_NEW'],risk:['RISK_WORSENED'],service:['ERROR','AUTH','RATE_LIMITED','STATE_ERROR','SCAN_COMPLETE','SCAN_STARTED']};
  const known=[...snapshot.candidates,...Object.values(snapshot.feedByChain || {}).flatMap(feed => feed.rows)];
  const symbolFor=row => safeTelegramText(known.find(item => item.symbol && row.address && id(item) === id(row))?.symbol,30) || (row.address ? `${safeTelegramText(row.address,80).slice(0,6)}…${safeTelegramText(row.address,80).slice(-4)}` : '?');
  const rows=snapshot.events.filter(row => (!session.viewChain || session.viewChain === 'all' || row.chain === session.viewChain) && (!groups[query.filter] || groups[query.filter].includes(row.type))).sort((a,b) => b.at-a.at);
  const logical=[];
  for(let index=0;index<rows.length;index+=12) {
    let page=[],size=0;
    for(const row of rows.slice(index,index+12)) {
      const where=session.viewChain === 'all' || !row.chain ? `${chainLabel(row.chain) || L('服务','Service')} · ` : '', symbol=symbolFor(row);
      const text=`${relativeTime(row.at,snapshot.at,locale)} · ${where}${row.type === 'CANDIDATE_NEW' ? `${ICONS.newLead} ${symbol} — ${L('新线索','new lead')}` : row.type === 'RISK_WORSENED' ? `${ICONS.vetoed} ${symbol} — ${L('安全核验未通过','failed the safety check')}` : `${groups.service.includes(row.type) ? name('service',locale) : L('其他事件','Other event')}: ${safeTelegramText(row.message,500)}`}`;
      if(size+userText(text,1000).length>2200 && page.length) { logical.push(page);page=[];size=0; }
      page.push({row,text,index:rows.indexOf(row)});size+=userText(text,1000).length;
    }
    if(page.length) logical.push(page);
  }
  const paging=pagination(logical.length,query.page,1,locale), shown=logical[paging.page] || [];
  const keyboard=rowsOf(shown.filter(({row}) => row.address && SCAN_CHAINS.includes(row.chain) && (snapshot.candidates.some(candidate => id(candidate) === id(row)) || snapshot.annotations.some(annotation => id(annotation) === id(row)))).map(({row,index}) => detailButton({...row,symbol:symbolFor(row)},index,locale)),2);
  keyboard.push([selectorButton('view_chain',locale),selectorButton('filter',locale)],paging.keyboard);
  return finishPanel(name('events',locale),shown.length ? [...shown.map(({text,index}) => `${index+1}. ${userText(text,1000)}`),rangeText(shown[0].index+1,shown.at(-1).index+1,rows.length,locale),paging.label] : [L('尚无事件','No events yet')],keyboard,snapshot,session,locale);
}

// The registered command menu, in order of use. Rarer commands work but stay out of
// the menu; Help lists both.
const MENU_COMMANDS = [
  ['radar','雷达：首页与最新线索','Radar: home and newest leads'],['leads','线索：雷达保留的代币与安全核验','Leads: tokens the radar keeps and their safety checks'],['hot','热榜：雷达筛选的AVE热榜与链上新池','Hot list: the AVE hot list and new on-chain pools the radar screens'],['watchlist','自选：收藏与备注','Watchlist: favorites and notes'],
  ['wallet','钱包：交易热钱包与余额','Wallet: your trading hot wallet and balances'],['performance','表现：通过筛选的代币之后的涨跌','Performance: how screened tokens moved afterwards'],['status','状态：扫描、来源、AVE额度与投递','Status: scanning, sources, AVE credits and delivery'],['settings','设置：扫描链、提醒、交易与语言','Settings: scan chain, alerts, trading and language'],['help','帮助：用法、命令与安全','Help: how it works, commands and safety']
];
const MORE_COMMANDS = [
  ['start','打开雷达','Open the radar'],['activity','动态：雷达事件','Activity: radar events'],['chains','选择扫描链（查看其他链不改变扫描）','Choose the scan chain (viewing another chain does not change it)'],
  ['pause','暂停扫描','Pause scanning'],['resume','恢复扫描','Resume scanning'],['mute','开关提醒','Turn alerts on or off'],['lang','选择语言：/lang zh 或 /lang en','Choose language: /lang zh or /lang en'],['note','编辑备注：/note <简称或CA>','Edit a note: /note <symbol or CA>'],['cancel','取消输入','Cancel input'],
  ['export','导出记录','Export records'],['onboard','连接AVE','Connect AVE'],['setkey','提交AVE密钥：/setkey <key>','Submit your AVE key: /setkey <key>'],['disconnect','删除AVE密钥并停止扫描','Delete the AVE key and stop scanning']
];
export const HELP_COMMAND_NAMES = Object.freeze([...MENU_COMMANDS,...MORE_COMMANDS].map(([command]) => command));
export function telegramCommandDescriptions(locale='zh') { return MENU_COMMANDS.map(([command,zh,en]) => ({command,description:localize(locale,zh,en)})); }
/**
 * setMyCommands parameters: English by default, Chinese for zh clients. The en scope
 * is rewritten too so an earlier registration cannot leave stale commands there.
 */
export function telegramCommandRegistrations() {
  return [[null,'en'],['zh','zh'],['en','en']].map(([languageCode,locale]) => ({ commands:telegramCommandDescriptions(locale),scope:{type:'all_private_chats'},...(languageCode ? {language_code:languageCode} : {}) }));
}
export function keySafetyCopy(locale='zh') {
  return localize(locale,'API Key明文会经过Telegram并可能留在聊天记录中。我们会尝试删除含Key消息，但无法保证删除。请自行检查并删除。服务端只保存加密Key，从不回显。AVE Key只读，不能交易。','Your plaintext key passes through Telegram and may remain in chat history. We try to delete the message but cannot guarantee deletion; check and delete it yourself. The service stores the key encrypted and never displays it. The AVE key is read-only; it cannot trade.');
}

// Why a key submission failed, by the error that ended its verification.
const CONNECTION_FAILURES = {
  AVE_AUTH:['AVE密钥无效或已被拒绝。','AVE rejected the key.'], AVE_QUOTA:['AVE额度已用尽。','AVE credits are exhausted.'], AVE_RATE_LIMITED:['AVE请求受到限流。','AVE rate limited the request.'],
  AVE_NETWORK:['无法连接AVE。','Could not reach AVE.'], AVE_UPSTREAM:['AVE服务暂时出错。','AVE is temporarily unavailable.'], AVE_TIMEOUT:['AVE验证超时。','AVE verification timed out.'], SCHEDULER_REQUEST_TIMEOUT:['AVE验证超时。','AVE verification timed out.']
};

function statusPanel(snapshot,session,locale) {
  const L=(zh,en)=>localize(locale,zh,en),control=snapshot.control || {},metrics=snapshot.metrics || {},ave=snapshot.ave || {};
  let blocks,keyboard;
  if(session.panel === 'sources') {
    const {discovery,lastSecondary}=snapshot.sourceHealth || {},section=(title,row)=>`<b>${title}</b> · ${relativeTime(row.checkedAt,snapshot.at,locale)}`;
    const line=(label,row)=>row.ok === false || row.status === 'ERROR' ? `${ICONS.unknown} ${label}: ${sourceProblem(row.code,locale)}`
      : `${ICONS.passed} ${label}${row.count !== null ? `: ${numberText(row.count,locale)}` : row.status && row.status !== 'OK' ? `: ${sourceProblem(row.status,locale)}` : ''}`;
    blocks=[];
    if(discovery) blocks.push(section(L('发现来源','Discovery'),discovery),...['trending','newPools','watch','promoted'].filter(field=>discovery[field]).map(field=>line(L(...fieldLabels[field]),discovery[field])));
    if(lastSecondary) blocks.push(...(blocks.length ? [''] : []),section(L('最近代币核验','Last token check'),lastSecondary),...Object.entries({goPlus:'GoPlus'}).filter(([field])=>lastSecondary.sources[field]).map(([field,label])=>line(label,lastSecondary.sources[field])));
    if(!blocks.length) blocks=[L('尚无来源记录','No source records')];
    keyboard=[];
  } else if(session.panel === 'delivery') {
    const pages=textPages((snapshot.delivery || []).map(row=>`${row.purpose === 'ACTION_REQUIRED' ? L('需处理的提醒','Action-required notice') : row.purpose === 'PANEL_UPDATE' ? L('面板更新','Panel update') : L('请求回复','Requested response')}: ${row.status === 'UNKNOWN' ? L('发送结果不确定，请核对','Delivery unconfirmed; check it') : L('发送失败','Delivery failed')}`));
    const paging=pagination(pages.length,session.query?.page,1,locale);
    blocks=(snapshot.delivery || []).length ? [...pages[paging.page].map(value=>userText(value,2400)),paging.label] : [L('没有待核对的投递问题','No delivery issues to check')];
    keyboard=[paging.keyboard,(snapshot.delivery || []).length ? [button(L('已核对并清除','Acknowledge and clear'),'delivery.acknowledge')] : []];
  } else {
    const feed=snapshot.feedByChain?.[control.scanChain],issues=snapshot.delivery?.length ?? 0;
    blocks=[`${scanState(control,locale)} · ${chainLabel(control.scanChain)}`,`${L('上次尝试','Last attempt')}: ${relativeTime(metrics.lastAttemptAt,snapshot.at,locale)} · ${L('上次成功','last success')}: ${relativeTime(metrics.lastSuccessAt,snapshot.at,locale)}`,`${L('下轮扫描','Next scan')}: ${metrics.nextCycleAt ? clockTime(metrics.nextCycleAt,locale,{reference:snapshot.at,seconds:true}) : L('未安排','Not scheduled')}`,`${L('累计成功扫描','Successful scans')}: ${numberText(metrics.scanCount,locale)}`,`${L('本轮发现/初筛通过','Last cycle discovered/prefilter passed')}: ${numberText(metrics.discoveredCount,locale)}/${numberText(metrics.prequalifiedCount,locale)}`,`${L('审计队列/到期','Audit queue/due')}: ${numberText(snapshot.queue?.length ?? 0,locale)}/${numberText(snapshot.queue?.filter(row=>row.nextAuditAt !== null && row.nextAuditAt<=snapshot.at).length ?? 0,locale)}`,`${L('上次读取热榜','Last hot-list read')}: ${relativeTime(feed?.observedAt,snapshot.at,locale)}`,`${L('本期AVE额度已用','AVE credits used this period')}: ${numberText(ave.cuUsed,locale)}${snapshot.aveBudget ? ' / ' + numberText(snapshot.aveBudget.monthlyCu,locale) : ''}${L('（本地估算）',' (local estimate)')}`,`${L('下次AVE请求','Next AVE request')}: ${ave.readyAt > snapshot.at ? clockTime(ave.readyAt,locale,{reference:snapshot.at,seconds:true}) : L('现在','now')}`,`${issues ? `${ICONS.unknown} ` : ''}${L('投递需核对','Delivery issues')}: ${numberText(issues,locale)}`];
    if(ave.blockedUntil>snapshot.at) blocks.push(`${ICONS.unknown} ${ave.blockReason === 'RATE_LIMITED' ? L('AVE限流，等待至','AVE rate limited; waiting until') : ave.blockReason === 'QUOTA' ? L('AVE报告额度用完，等待至','AVE reports credits exhausted; waiting until') : L('已达本期额度估算上限，等待至','Estimated allowance reached; waiting until')} ${clockTime(ave.blockedUntil,locale,{reference:snapshot.at})}`);
    keyboard=[[open('events',locale),open('sources',locale),open('delivery',locale)]];
  }
  return finishPanel(heading(session.panel,locale),blocks,keyboard,snapshot,session,locale);
}

const WINDOW_LABELS = { m5:['5分钟','5 min'], m15:['15分钟','15 min'], m30:['30分钟','30 min'], h1:['1小时','1 h'], h2:['2小时','2 h'], h6:['6小时','6 h'], h24:['24小时','24 h'] };
export function renderStatisticsPanel(snapshot,session,locale='zh') {
  const L=(zh,en)=>localize(locale,zh,en),summary=snapshot.stats?.[session.viewChain],query=session.query || {},horizon=query.horizon || 'm30',cohort=query.cohort || 'passed';
  const windowName=key=>L(...WINDOW_LABELS[key]);
  const blocks=[chainLabel(session.viewChain)];
  const keyboard=[[selectorButton('view_chain',locale),open('horizon',locale)],[open('cohort',locale),button(L('覆盖详情','Coverage details'),'panel.open',{panel:'stats',query:{coverage:true}})]];
  if(!summary) blocks.push(L('统计数据不可用','Statistics unavailable'));
  else if(query.coverage || query.horizon || query.cohort) {
    for(const selected of cohort === 'compare' ? ['passed','rejected'] : [cohort]) {
      const row=summary.coverage?.[selected]?.[horizon];
      blocks.push(`<b>${selected === 'passed' ? L('通过筛选组','Passed the screen') : L('否决对照组','Vetoed control')} · ${windowName(horizon)}</b>`);
      if(!row) blocks.push(L('不可用','Unavailable'));
      else blocks.push(`${L('到期','Due')} ${numberText(row.eligible,locale)} · ${L('已测','measured')} ${numberText(row.completed,locale)} · ${L('缺失','missing')} ${numberText(row.missing,locale)}`,`${L('中位数','Median')}: ${row.median === null ? L('暂无样本','No samples') : percent(row.median,locale,true)}`,`${L('正收益比例','Positive returns')}: ${row.positiveRate === null ? L('暂无样本','No samples') : percent(row.positiveRate,locale)}`);
    }
    blocks.push('',`${L('50样本门槛','50-sample gate')}: ${[['m30','30m'],['h2','2h'],['h24','24h']].map(([key,suffix])=>`${windowName(key)} ${summary['completed'+suffix]>=50 ? L('已达','Ready') : L('未达','Not ready')}`).join(' · ')}`,`${L('整体调参门槛','Overall calibration gate')}: ${summary.calibrationReady === true ? L('已达','Ready') : L('未达','Not ready')}`);
  } else {
    ['m30','h1','h2','h24'].forEach((key,index)=>{
      const row=summary.coverage?.passed?.[key], when=index ? L(`${windowName(key)}后`,`${windowName(key)} later`) : L(`通过筛选的代币，${windowName(key)}后`,`Tokens that passed the screen, ${windowName(key)} later`);
      blocks.push(`${when}: ${!row ? L('不可用','unavailable') : row.median === null ? L('暂无样本','no samples yet') : L(`中位数 ${percent(row.median,locale,true)}（${numberText(row.completed,locale)}个）`,`median ${percent(row.median,locale,true)} (${numberText(row.completed,locale)} ${row.completed === 1 ? 'token' : 'tokens'})`)}`);
    });
    blocks.push(L(`跟踪中：${numberText(summary.tracked,locale)}个代币`,`Tracking ${numberText(summary.tracked,locale)} tokens`));
  }
  blocks.push(L('影子观察，不代表可成交收益。','Shadow observations; not executable returns.'));
  return finishPanel(name('stats',locale),blocks,keyboard,snapshot,session,locale);
}

/** Pure native Telegram panel renderer. Action descriptors are bound by the controller. */
/**
 * One token's alert. It is sent once and then edited in place as its checks finish, so it states
 * facts as of its update time rather than relative to now.
 */
function alertPanel(snapshot,session,locale) {
  const L = (zh,en) => localize(locale,zh,en), selected = session.query.selectedToken, found = findToken(snapshot,session);
  const row = found?.row ?? { ...selected, symbol:'?' }, listed = found?.listed, deep = row.deep || {};
  const shortName = row.symbol && row.symbol !== '?' ? row.symbol : selected.address.slice(-8), label = userText(shortName,30);
  const safety = found ? { ...tokenSafety(row), checkedAt:null } : { verdict:null };
  const fact = key => row[key] ?? listed?.[key] ?? null, liquidity = deep.security?.liquidity ?? fact('liquidity'), createdAt = fact('createdAt');
  const facts = [
    present(fact('marketCap')) ? L(`市值 ${money(fact('marketCap'),locale)}`,`${money(fact('marketCap'),locale)} MC`) : null,
    present(liquidity) ? L(`流动性 ${money(liquidity,locale)}`,`${money(liquidity,locale)} liq`) : null,
    // createdAt is in seconds, as AVE reports it.
    createdAt > 0 && createdAt * 1000 <= snapshot.at ? L(`币龄 ${duration(snapshot.at-createdAt*1000,locale)}`,`${duration(snapshot.at-createdAt*1000,locale)} old`) : null,
    present(listed?.priceChange5m) ? L(`5分钟 ${percent(listed.priceChange5m,locale,true)}`,`5m ${percent(listed.priceChange5m,locale,true)}`) : null
  ].filter(Boolean);
  const title = safety.verdict === 'VETOED' ? `${ICONS.vetoed} ${label} ${L('未通过安全检查','failed the safety check')} · ${chainLabel(selected.chain)}` : `${ICONS.newLead} ${L('新线索','New lead')} · ${label} · ${chainLabel(selected.chain)}`;
  const closing = safety.verdict === 'VETOED' ? L('已禁止买入；仍可卖出。','Buying is blocked; selling still works.')
    : [null,'PENDING'].includes(safety.verdict) ? L('安全检查仍在进行，尚未核验。','Safety check still running; not verified.') : L('检查结果不构成安全保证。','Checks are not a safety guarantee.');
  const blocks = [facts.length ? userText(facts.join(' · ')) : null, safetyLine(safety,snapshot,locale), `<code>${userText(selected.address,80)}</code>`, closing].filter(Boolean);
  const keyboard = [[button(L(`打开 ${safeTelegramText(shortName,30)}`,`Open ${safeTelegramText(shortName,30)}`),'panel.open',{ panel:'detail' },token(selected))],
    [button(`${ICONS.audits} ${L('全部线索','All leads')}`,'panel.open',{ panel:'audits' }),button(`${ICONS.alertsOff} ${L('关闭提醒','Mute alerts')}`,'notifications.set',{ value:false })]];
  const controls = session.query.tokenControls ? detailPanel(snapshot,{ ...session, panel:'detail' },locale).keyboard : keyboard;
  const notice = session.query.notice ? `${ICONS.unknown} ${escapeHtml(session.query.notice)}\n\n` : '';
  return { text:`${notice}<b>${title}</b>\n${blocks.join('\n')}\n\n${L('更新于','Updated')} ${clockTime(snapshot.at,locale)}`, keyboard:controls, version:session.version, token:token(selected) };
}

export function renderPanel(snapshot,session,locale='zh') {
  if(!['zh','en'].includes(locale)) throw new TypeError('Unsupported Telegram locale');
  if(!PANEL_NAMES.includes(session.panel)) throw new TypeError('Unsupported Telegram panel');
  const L=(zh,en)=>localize(locale,zh,en),query=session.query || {},control=snapshot.control || {};
  if(session.panel === 'alert') return alertPanel(snapshot,session,locale);
  if(['feed','audits','saved'].includes(session.panel)) return listPanel(snapshot,session,locale);
  if(['detail','evidence'].includes(session.panel)) return detailPanel(snapshot,session,locale);
  if(['view_chain','filter','sort','language','horizon','cohort'].includes(session.panel)) return selectorPanel(snapshot,session,locale);
  if(['status','sources','delivery'].includes(session.panel)) return statusPanel(snapshot,session,locale);
  if(session.panel === 'stats') return renderStatisticsPanel(snapshot,session,locale);
  if(session.panel === 'events') return eventsPanel(snapshot,session,locale);
  if(TRADING_PANELS.includes(session.panel)) return renderTradingPanel(snapshot,session,locale);
  let blocks=[],keyboard=[],title=heading(session.panel,locale);
  if(session.panel === 'radar') {
    if(!control.configured && !snapshot.candidates.length) {
      // First run: what the radar does, then the two steps that start it.
      title=`${ICONS.welcome} ${L('AlphaMeme 雷达','AlphaMeme radar')}`;
      blocks=[L(`盯住 ${chainLabel(control.scanChain)} 热榜上的新 meme 代币，核验安全性并提醒你。`,`Watches the ${chainLabel(control.scanChain)} hot list for new meme tokens, checks their safety and alerts you.`),'',
        L('第1步 · 获取免费的 AVE Data API Key','Step 1 · Get a free AVE Data API key'),L('第2步 · 发送 /setkey &lt;key&gt;','Step 2 · Send /setkey &lt;key&gt;'),
        L('Key 只读，永远不能交易。发送后请删除含 Key 的消息。','Your key is read-only; it can never trade. Delete the key message afterwards.')];
      keyboard=[[urlButton(`${ICONS.key} ${L('获取AVE Key','Get AVE key')}`,AVE_KEY_URL),button(`${ICONS.help} ${L('使用说明','How it works')}`,'panel.open',{panel:'help'})],
        [button(`${ICONS.language} ${locale==='en' ? '中文' : 'English'}`,'language.set',{value:locale==='en' ? 'zh' : 'en'})]];
    } else {
      // Radar answers "is there anything for me?": the newest leads on the scan chain, vetoed last.
      const chain=control.scanChain,feed=snapshot.feedByChain?.[chain]?.rows || [];
      // Every recheck rewrites auditedAt, so a lead is as new as when it first qualified.
      const recent=snapshot.candidates.filter(row=>row.chain === chain && row.auditedAt>=snapshot.at-1_800_000),newest=key=>(a,b)=>number(key(b))-number(key(a));
      const leads=recent.filter(row=>backendDisposition(row)==='lead').sort(newest(row=>row.qualifiedAt ?? row.auditedAt)),vetoed=recent.filter(row=>row.status==='HARD_REJECT').sort(newest(row=>row.auditedAt)),shown=[...leads,...vetoed].slice(0,3);
      const leadLine=(row,index)=>{
        const symbol=userText(row.symbol || '?',30);
        if(row.status==='HARD_REJECT') return `${index+1}. ${ICONS.vetoed} ${symbol} · ${L('已否决','vetoed')}`;
        const change=feed.find(item=>id(item)===id(row))?.priceChange5m;
        const facts=[Number.isFinite(row.marketCap) ? money(row.marketCap,locale) : null,Number.isFinite(row.createdAt) ? L(`币龄${duration(snapshot.at-row.createdAt*1000,locale)}`,`${duration(snapshot.at-row.createdAt*1000,locale)} old`) : null,Number.isFinite(change) ? percent(change,locale,true) : null].filter(Boolean);
        return `${index+1}. <b>${symbol}</b>${facts.length ? ` · ${facts.join(' · ')}` : ''}`;
      };
      title=`${heading('radar',locale)} · ${chainLabel(chain)}`;
      blocks=[`${scanState(control,locale)} · ${alertState(control,locale)}`,''];
      if(shown.length) blocks.push(L(`近30分钟：${leads.length} 条线索 · ${vetoed.length} 条已否决`,`Last 30 min: ${leads.length} ${leads.length === 1 ? 'lead' : 'leads'} · ${vetoed.length} vetoed`),...shown.map(leadLine));
      else blocks.push(`${L('近30分钟没有线索。','No leads in the last 30 min.')} ${!control.configured ? L('AVE未连接。','AVE is not connected.') : control.paused ? L('扫描已暂停。','Scanning is paused.') : L(`雷达约每${duration(scannerSettings.scanIntervalMs,locale)}读取一次热榜。`,`The radar checks the hot list every ~${duration(scannerSettings.scanIntervalMs,locale)}.`)}`);
      // A failing discovery source shows here, not only two taps away in Sources.
      const discovery=snapshot.sourceHealth?.discovery || {};
      blocks.splice(1,0,...['trending','newPools','watch','promoted'].filter(field=>discovery[field]?.ok === false)
        .map(field=>`${ICONS.unknown} ${L(...fieldLabels[field])}: ${sourceProblem(discovery[field].code,locale)}`));
      keyboard=[...rowsOf(shown.map((row,index)=>detailButton(row,index,locale)),2),[open('audits',locale),open('feed',locale)],[open('saved',locale),open('stats',locale)],[open('wallet',locale),open('status',locale)]];
    }
  } else if(session.panel === 'settings') {
    const chain=chainLabel(control.scanChain),trading=snapshot.trading;
    blocks=[`${L('扫描','Scanning')}: ${!control.configured ? `${ICONS.disconnected} ${L('等待连接AVE','Waiting for AVE')} · ${chain}` : control.paused ? `${ICONS.paused} ${L('已暂停','Paused')} · ${chain}` : `${ICONS.scanning} ${chain}`}`,
      `${L('提醒','Alerts')}: ${control.notifications ? `${ICONS.alertsOn} ${L('已开启','On')}` : `${ICONS.alertsOff} ${L('已关闭','Off')}`}`,
      `${L('交易','Trading')}: ${trading?.chains?.length ? L(`滑点 ${trading.settings.slippageBps/100}% · 上限 ${money(trading.settings.capUsd,locale)}`,`slippage ${trading.settings.slippageBps/100}% · cap ${money(trading.settings.capUsd,locale)}`) : L('本部署未启用','not enabled on this deployment')}`,
      `${L('语言','Language')}: ${locale==='en' ? 'English' : '中文'}`,`AVE: ${control.configured ? L('已连接','connected') : L('未连接','not connected')}`];
    keyboard=[[button(`${heading('chains',locale)}: ${chain}`,'panel.open',{panel:'chains'})],
      [button(control.notifications ? `${ICONS.alertsOff} ${L('关闭提醒','Mute')}` : `${ICONS.alertsOn} ${L('开启提醒','Unmute')}`,'notifications.set',{value:!control.notifications}),
        button(control.paused ? `${ICONS.scanning} ${L('恢复','Resume')}` : `${ICONS.paused} ${L('暂停','Pause')}`,control.paused ? 'scan.resume' : 'scan.pause')],
      [open('trade_settings',locale),open('language',locale)],[open('onboard',locale),button(`${ICONS.export} ${L('导出记录','Export')}`,'export.create')]];
  } else if(session.panel === 'chains') {
    blocks=[L('一次扫描一条链。切换后旧链的研究记录保留，扫描立即转到新链。','One chain is scanned at a time. Switching keeps the old chain\'s records and moves scanning to the new chain.')];
    keyboard=SCAN_CHAINS.map(value=>[button(`${control.scanChain===value?'✓ ':''}${chainLabel(value)}`,'chains.set',{value})]);
  } else if(session.panel === 'disconnect') {
    blocks=[L('停止扫描，删除AVE API密钥；保留研究记录。交易钱包不受影响（在 /wallet 中移除）。','Stop scanning and delete the AVE API key; research records stay. The trading wallet is not affected (remove it under /wallet).')];
    keyboard=[[button(`${ICONS.delete} ${L('删除密钥','Delete key')}`,'connection.disconnect')]];
  } else if(session.panel === 'onboard') {
    blocks.push(control.configured ? L('AVE已连接；提交新密钥验证通过前，原连接保持不变。','AVE connected; the current connection stays until a new key passes verification.') : L('尚未连接AVE。','AVE is not connected.'));
    blocks.push(L('第1步：登录AVE Cloud，复制你的Data API Key（免费版即可）。','Step 1: sign in to AVE Cloud and copy your Data API key (the free plan works).'),L('第2步：发送 /setkey &lt;key&gt;。验证会消耗5个AVE额度。','Step 2: send /setkey &lt;key&gt;. Verification spends 5 AVE credits.'));
    blocks.push(keySafetyCopy(locale));
    keyboard.push([urlButton(L('打开AVE Cloud','Open AVE Cloud'),AVE_KEY_URL),control.configured ? button(`${ICONS.delete} ${L('删除','Delete')}`,'panel.open',{panel:'disconnect'}) : null]);
  } else if(session.panel === 'connection') {
    // The result of one key submission; the connection state it reports is read now.
    const outcome=query.outcome;
    if(!['connected','failed','invalid'].includes(outcome)) throw new TypeError('Unsupported AVE connection outcome');
    const deleteKey=L('如果含 Key 的消息仍可见，请删除它。','Delete your key message if it is still visible.');
    if(outcome === 'connected') {
      title=`${ICONS.passed} ${L('AVE已连接','AVE connected')}`;
      blocks=[`${control.paused ? `${ICONS.paused} ${L('已暂停','Paused')} · ${chainLabel(control.scanChain)}` : `${ICONS.scanning} ${L(`正在扫描 ${chainLabel(control.scanChain)}`,`Scanning ${chainLabel(control.scanChain)}`)}`} · ${alertState(control,locale)}`,deleteKey];
      // The footer's Home opens the radar; a second radar button would break the one-footer rule.
      keyboard=[[button(`${ICONS.chains} ${L('切换链','Change chain')}`,'panel.open',{panel:'chains'})]];
    } else {
      const reason=outcome === 'invalid' ? ['这不是有效的AVE API密钥。','That is not a valid AVE API key.'] : Object.hasOwn(CONNECTION_FAILURES,query.reason) ? CONNECTION_FAILURES[query.reason] : ['连接失败或已过期。','Connection failed or expired.'];
      const retryAt=query.reason === 'AVE_RATE_LIMITED' && Number.isSafeInteger(query.retryAt) && query.retryAt>snapshot.at ? L(`请在 ${clockTime(query.retryAt,locale,{reference:snapshot.at,seconds:true})} 之后重试。`,`Try again after ${clockTime(query.retryAt,locale,{reference:snapshot.at,seconds:true})}.`) : null;
      title=outcome === 'invalid' ? L('密钥无效','Key not valid') : L('密钥未通过验证','Key not verified');
      blocks=[[L(...reason),retryAt].filter(Boolean).join(' '),control.configured ? L('之前的连接保持不变。','Your previous connection is unchanged.') : L('AVE尚未连接。','AVE is not connected.'),deleteKey];
      keyboard=[[button(`${ICONS.key} ${L('重试','Try again')}`,'panel.open',{panel:'onboard'})]];
    }
  } else if(session.panel === 'help') {
    const commands=list=>list.map(([command,zh,en])=>escapeHtml(`/${command} — ${L(zh,en)}`));
    const pages=[
      [L('雷达读取扫描链上的AVE热榜，把通过行情筛选的新代币作为线索提醒你。','The radar reads the AVE hot list on your scan chain and alerts you to new tokens that pass its market screen: these are leads.'),L('随后GoPlus核验每条线索的安全性；未通过的线索被否决，不能买入，仍可卖出。','GoPlus then checks each lead\'s safety; a lead that fails is vetoed and cannot be bought, though it can still be sold.'),L('交易可选：使用独立的热钱包（/wallet），每笔交易都需你确认报价。','Trading is optional: it uses a separate hot wallet (/wallet), and every trade waits for you to confirm its quote.')],
      [`<b>${L('菜单命令','Menu commands')}</b>`,...commands(MENU_COMMANDS),'',`<b>${L('更多命令','More commands')}</b>`,...commands(MORE_COMMANDS)],
      [keySafetyCopy(locale),L('热钱包只存放你愿意承担风险的小额资金；导出的私钥请离线保存。','Keep only small amounts you can afford to lose in the hot wallet, and store its exported key offline.'),L('线索只通过了行情筛选（AVE热榜，或链上新池的DexScreener行情）；未核验不代表安全，交易前请自行核查。','Leads passed a market screen only (the AVE hot list, or DexScreener for new on-chain pools); unverified does not mean safe, so check before any trade.'),L('人工通过不会改变筛选结果，也不会执行交易。暂停扫描与关闭提醒互不影响。','Manual approval does not change screening results or execute trades. Pausing scanning and muting alerts are independent.'),L('非投资建议。','Not investment advice.')]
    ];
    const paging=pagination(pages.length,query.page,1,locale);blocks=[...pages[paging.page],paging.label];keyboard=[paging.keyboard,control.configured ? [] : [open('onboard',locale)]];
  }
  // Radar's footer leads with Settings, left of Refresh, once AVE is connected.
  const footerStart=session.panel === 'radar' && (control.configured || snapshot.candidates.length) ? [open('settings',locale)] : [];
  return finishPanel(title,blocks,keyboard,snapshot,session,locale,{refresh:!['chains','disconnect','help','connection'].includes(session.panel),footerStart});
}
