import { backendDisposition, effectiveStatus } from '../scoring/manual-review.mjs';
import { TELEGRAM_CHAINS, tokenIdentity, safeTelegramText } from './snapshot.mjs';
import { localize, userText, chainLabel, button, urlButton, money, numberText, percent, timestamp, age, truth, textPages, finishPanel, officialXUrl } from '../render/telegram.mjs';

export const PANEL_NAMES = Object.freeze(['radar','feed','audits','saved','events','status','sources','delivery','settings','chains','onboard','help','detail','evidence','view_chain','filter','sort','language','disconnect','regenerate','stats','horizon','cohort']);
export const AUDIT_FILTERS = Object.freeze(['all','chain','waiting','passed','ignored','rejected','fresh','favorite']);
export const AUDIT_SORTS = Object.freeze(['audit_desc','score_desc','market_desc','market_asc','liquidity_desc']);
export const LIVE_SORTS = Object.freeze(['priority','volume','new']);
const names = {
  radar:['雷达总览','Radar overview'], feed:['1分钟活跃榜','1-minute live feed'], audits:['近30分钟深度审计','Audits from last 30 min'], saved:['收藏与备注','Favorites and notes'], events:['雷达事件','Radar events'], status:['运行状态','Service status'], sources:['来源详情','Source details'], delivery:['投递问题','Delivery issues'], settings:['设置','Settings'], chains:['选择扫描链','Choose scan chains'], onboard:['连接GMGN','Connect GMGN'], help:['帮助与密钥安全','Help and key safety'], detail:['代币详情','Token detail'], evidence:['检查证据','Evidence'], view_chain:['查看链','View chain'], filter:['筛选','Filter'], sort:['排序','Order'], language:['语言','Language'], disconnect:['断开连接','Disconnect'], regenerate:['重新生成公钥','Regenerate public key'], stats:['筛选后表现验证','Post-screen performance'], horizon:['观察窗口','Window'], cohort:['样本组别','Cohort'],
  all:['全部','All'], chain:['链上候选，待人工看X','On-chain candidate; review X'], waiting:['等待复查','Waiting for recheck'], passed:['人工通过','Manually approved'], ignored:['已忽略','Ignored'], rejected:['已排除','Rejected'], fresh:['5分钟内审计','Audited within 5 min'], favorite:['收藏','Favorites'], notes:['有备注','With notes'],
  audit_desc:['最新审计','Newest audit'], score_desc:['发现评分','Discovery score'], market_desc:['市值↓','Market cap ↓'], market_asc:['市值↑','Market cap ↑'], liquidity_desc:['流动性↓','Liquidity ↓'], priority:['2–8万市值优先','20–80K market cap first'], volume:['1分钟成交量','1-minute volume'], new:['10分钟内新发现','New within 10 min'],
  candidates:['候选事件','Candidates'], risk:['风险变化','Risk changes'], service:['服务事件','Service'], unknown:['未知','Unknown']
};
const name = (key, locale) => names[key] ? localize(locale, ...names[key]) : safeTelegramText(key, 80);
const id = row => tokenIdentity(row.chain, row.address);
const token = row => ({ chain: row.chain, address: row.address });
const markFor = (snapshot, row) => (snapshot.marks || []).find(mark => id(mark) === id(row));
const annotationFor = (snapshot, row) => (snapshot.annotations || []).find(mark => id(mark) === id(row));
const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const searchMatches = (row, search) => !search || [row.symbol,row.name,row.address].join(' ').toLowerCase().includes(search.trim().toLowerCase());
const open = (panel, locale, params = {}) => button(name(panel, locale), 'panel.open', { panel, ...params });
const home = locale => open('radar', locale);
const back = locale => button(localize(locale,'返回','Back'), 'panel.back');
const refresh = locale => button(localize(locale,'刷新','Refresh'), 'panel.refresh');
const state = (snapshot, row, locale) => row.auditedAt ? name(effectiveStatus(row, markFor(snapshot,row), snapshot.at), locale) : localize(locale,'未审计','Not audited');

export function selectPanelRows(snapshot, session) {
  const query = session.query || {}, chain = session.viewChain;
  let rows;
  if (session.panel === 'feed') {
    rows = [...(snapshot.liveByChain?.[chain]?.rows || [])].filter(row => searchMatches(row, query.search));
    if (query.sort === 'new') rows = rows.filter(row => row.newAt && snapshot.at - row.newAt < 600_000);
    const sort = query.sort || 'priority';
    return rows.sort((a,b) => (sort === 'priority' ? Number(b.priorityBand) - Number(a.priorityBand) : sort === 'new' ? b.newAt - a.newAt : 0) || number(b.volume1m) - number(a.volume1m)).slice(0,15);
  }
  if (session.panel === 'saved') {
    if (query.noteTargetMatches) {
      const candidates = [...snapshot.candidates, ...Object.values(snapshot.liveByChain || {}).flatMap(feed => feed.rows), ...snapshot.annotations];
      return query.noteTargetMatches.map(token => ({ ...candidates.find(row => id(row) === id(token)), ...token }));
    }
    return snapshot.annotations.filter(row => (!chain || chain === 'all' || row.chain === chain) && (query.filter !== 'favorite' || row.favorite) && (query.filter !== 'notes' || row.note?.trim()))
      .map(row => ({ ...snapshot.candidates.find(candidate => id(candidate) === id(row)), ...row }))
      .filter(row => searchMatches(row, query.search)).sort((a,b) => number(b.updatedAt) - number(a.updatedAt));
  }
  rows = snapshot.candidates.filter(row => (!chain || row.chain === chain) && row.auditedAt >= snapshot.at - 1_800_000 && searchMatches(row,query.search));
  rows = rows.filter(row => {
    const filter = query.filter || 'all';
    if (['chain','waiting','passed','ignored','rejected'].includes(filter)) return effectiveStatus(row,markFor(snapshot,row),snapshot.at) === filter;
    if (filter === 'fresh') return snapshot.at - row.auditedAt <= 300_000;
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
  return { page, start: page * size, keyboard: [page > 0 ? button(localize(locale,'上一页','Previous'),action,{page:page - 1}) : null, (page+1)*size < total ? button(localize(locale,'下一页','Next'),action,{page:page + 1}) : null].filter(Boolean) };
}
const detailButton = (row,index,locale) => button(`${index + 1} ${safeTelegramText(row.symbol || row.address?.slice(-8) || '?',30)}`, 'panel.open', { panel:'detail' },token(row));
const pairs = rows => Array.from({length:Math.ceil(rows.length/2)}, (_,index) => rows.slice(index*2,index*2+2));

function listPanel(snapshot,session,locale) {
  const L = (zh,en) => localize(locale,zh,en), query = session.query || {};
  const rows = selectPanelRows(snapshot,session), paging = pagination(rows.length,query.page,5,locale);
  const shown = rows.slice(paging.start,paging.start+5), isLive = session.panel === 'feed', saved = session.panel === 'saved';
  const live = snapshot.liveByChain?.[session.viewChain];
  const blocks = [userText(chainLabel(session.viewChain || 'all')), `${name(query.filter || 'all',locale)} · ${name(query.sort || (isLive ? 'priority' : 'audit_desc'),locale)}`, `${L('搜索','Search')}: ${userText(query.search || L('无','None'),128)}`, ''];
  if (isLive) {
    blocks.push(!live?.lastSuccessAt ? L('等待首次采集','Waiting for first collection') : `${L('采集更新','Collection updated')}: ${timestamp(live.lastSuccessAt,locale)}`);
    if (live?.lastSuccessAt && snapshot.at-live.lastSuccessAt > 60_000) blocks.push(L('数据已陈旧','Data stale'));
    if (live?.delayReason) blocks.push(`${L('采集状态','Feed status')}: ${reasonText(live.delayReason,locale)}`);
    if (snapshot.live?.focusChain !== session.viewChain) blocks.push(`${L('当前采集','Collecting')} ${chainLabel(snapshot.live?.focusChain) || L('未开启','Off')}; ${L('此链仅显示缓存','showing this chain from cache')}`);
  }
  shown.forEach((row,index) => {
    blocks.push(`<b>${paging.start + index + 1}. ${userText(row.symbol || '?',30)}</b> · ${state(snapshot,row,locale)}`);
    if (saved) blocks.push(`${chainLabel(row.chain)} · <code>${userText(row.address?.slice(-12),12)}</code> · ${L('收藏','Favorite')}: ${truth(row.favorite,locale)}`, userText(row.note || L('无备注','No note'),60));
    else {
      blocks.push(`${L('市值','Market cap')} ${money(row.marketCap,locale)} · ${L('流动性','Liquidity')} ${money(row.liquidity,locale)}`);
      if (isLive) blocks.push(row.newAt && snapshot.at-row.newAt<120_000 ? L('新发现','New') : '',`${L('币龄','Age')}: ${row.createdAt ? numberText(Math.max(0,Math.floor((snapshot.at-row.createdAt*1000)/60_000)),locale)+'m' : name('unknown',locale)}`,`${L('1m成交','1m volume')} ${money(row.volume1m,locale)} · ${L('买/卖','Buys/sells')} ${numberText(row.buys1m,locale)}/${numberText(row.sells1m,locale)}`, `${L('聪明钱/持有人','Smart money/holders')} ${numberText(row.smartMoney,locale)}/${numberText(row.holders,locale)}`, row.deltaWindowMs ? `${L('价格变化','Price change')} ${percent(row.priceDelta,locale,true)} / ${numberText(row.deltaWindowMs / 1000,locale)}s` : L('暂无可比窗口','No comparable window'));
      else blocks.push(`${L('发现评分','Discovery score')} ${numberText(row.discoveryScore,locale)} · ${L('失败/未知','Failed/unknown')} ${(row.deep?.failed || []).length}/${(row.deep?.unknownFields || []).length}`);
    }
    blocks.push(`${L('审计','Audit')}: ${timestamp(row.auditedAt,locale)}`, '');
  });
  if (!shown.length) blocks.push(L('没有符合条件的记录','No matching records'));
  blocks.push(`${rows.length ? paging.start+1 : 0}–${Math.min(paging.start+5,rows.length)} / ${rows.length}`);
  if (isLive) blocks.push(`${L('规范化总数','Normalized total')}: ${numberText(live?.rows?.length,locale)}`, L('采集目标20秒；本消息仅在操作时刷新。','Collection target 20s; this message refreshes on interaction.'));
  const keyboard = pairs(shown.map((row,index) => session.query?.noteTargetMatches ? button(`${paging.start + index + 1} ${safeTelegramText(row.symbol || row.address.slice(-8),30)}`, 'note.select', {}, token(row)) : detailButton(row,paging.start+index,locale)));
  keyboard.push([open('view_chain',locale),open(isLive ? 'sort' : 'filter',locale)]);
  if (!isLive && !saved) keyboard.push([open('sort',locale)]);
  keyboard.push([button(L('搜索','Search'),'input.begin',{kind:'search'}),query.search ? button(L('清空搜索','Clear search'),'search.clear') : null],paging.keyboard,[refresh(locale),home(locale)]);
  if (isLive) keyboard.push([snapshot.live?.subscribed ? button(L('关闭采集','Stop collection'),'live.set',{value:false}) : null,snapshot.live?.focusChain !== session.viewChain || !snapshot.live?.subscribed ? button(L('采集此链','Collect this chain'),'live.set',{value:true,chain:session.viewChain}) : null]);
  return finishPanel(name(session.panel,locale),blocks,keyboard,snapshot,session,locale);
}

const fieldLabels = {
  openSource:['开源','Open source'],ownerRenounced:['所有权放弃','Owner renounced'],evmOwnerRenounced:['EVM所有权放弃','EVM owner renounced'],renouncedMint:['增发权限放弃','Mint authority renounced'],renouncedFreezeAccount:['冻结权限放弃','Freeze authority renounced'],honeypot:['貔貅风险','Honeypot'],buyTax:['买入税','Buy tax'],sellTax:['卖出税','Sell tax'],taxDifference:['税差','Tax difference'],rugRatio:['跑路比例','Rug ratio'],top10:['前10持仓','Top 10 holdings'],devHold:['开发者持仓','Developer holdings'],insider:['内幕持仓','Insider holdings'],bundler:['捆绑持仓','Bundler holdings'],sniperHold:['狙击持仓','Sniper holdings'],lockRate:['锁仓比例','Locked ratio'],lpBurned:['LP销毁','LP burned'],liquidity:['流动性','Liquidity'],sampled:['钱包样本','Sampled wallets'],ordinaryCount:['普通钱包数','Ordinary wallets'],ordinaryHoldRate:['普通钱包持仓','Ordinary holdings'],riskWalletCount:['风险钱包数','Risk wallets'],botHoldRate:['机器人持仓','Bot holdings'],linkedHoldRate:['关联持仓','Linked holdings'],duplicateCount:['重复数','Duplicates'],missingAddressCount:['缺失地址数','Missing addresses'],invalidRateCount:['无效比例数','Invalid ratios'],dataComplete:['证据完整','Evidence complete'],pass:['通过','Passed'],status:['状态','Status'],reason:['原因','Reason'],bars:['K线数','Candle count'],return5m:['5分钟收益','5-minute return'],maxDrawdown:['最大回撤','Maximum drawdown'],volumeConcentration:['成交集中度','Volume concentration'],totalVolume:['总成交','Total volume'],activeBars:['活跃K线','Active candles'],volumeChange:['成交变化','Volume change'],volumeTrend:['成交趋势','Volume trend'],decliningVolumeBars:['成交递减K线','Declining volume candles'],invalidBars:['无效K线','Invalid candles'],duplicateBars:['重复K线','Duplicate candles'],continuous:['连续','Continuous'],fresh:['新鲜','Fresh'],latestClosedAt:['最后闭合时间','Last closed time'],stalenessMs:['证据滞后毫秒','Evidence lag (ms)'],sells5m:['5分钟卖出','5-minute sells'],sells24h:['24小时卖出','24-hour sells'],distinctSellers:['不同卖家','Distinct sellers'],historicalDistinctSellers:['历史不同卖家','Historical distinct sellers'],windowSec:['窗口秒数','Window seconds'],evidenceType:['证据类型','Evidence type'],evidenceNote:['证据局限','Evidence limitations'],unknownFields:['未知字段','Unknown fields'],complete:['完整','Complete'],checkedAt:['核验时间','Checked at'],priceUsd:['美元价格','Price USD'],marketCap:['市值','Market cap'],liquidityUsd:['流动性','Liquidity USD'],verdict:['结论','Verdict'],field:['字段','Field'],relativeDifference:['相对差异','Relative difference'],type:['类别','Type'],notHoneypot:['无貔貅风险','Not honeypot'],lpLocked:['LP锁定','LP locked'],tax:['交易税','Trading tax'],rug:['跑路风险','Rug risk'],concentration:['持仓集中度','Concentration'],dev:['开发者','Developer'],sniper:['狙击者','Sniper'],wash:['刷量','Wash trading'],wallets:['钱包','Wallets'],observation:['价格观察','Price observation'],chartRisk:['图形风险','Chart risk'],marketBehavior:['市场行为','Market behavior'],from:['起始时间','Start time'],to:['结束时间','End time'],reasons:['原因','Reasons'],fatal:['致命证据','Fatal evidence'],conflicts:['来源冲突','Source conflicts']
};
Object.assign(fieldLabels, {
  discovery:['发现来源','Discovery sources'],lastAudit:['最近审计来源','Last audit sources'],lastSecondary:['最近第二来源','Last secondary sources'],endpoints:['接口','Endpoints'],sources:['来源','Sources'],trenches:['新币发现','Trenches'],trending:['趋势榜','Trending'],info:['基本信息','Token information'],security:['安全','Security'],pool:['资金池','Pool'],holders:['持有人','Holders'],traders:['交易者','Traders'],candles:['K线','Candles'],ok:['可用','Available'],code:['原因','Reason'],count:['条数','Count'],errorCode:['错误原因','Error reason'],codes:['风险原因','Risk reasons'],evidence:['证据','Evidence'],downgradeReasons:['降级原因','Downgrade reasons'],warnings:['警告','Warnings'],strengths:['积极证据','Supporting evidence'],smartWallets:['聪明钱钱包','Smart money wallets'],renownedWallets:['知名钱包','Renowned wallets'],taggedSmartWallets:['标签聪明钱钱包','Tagged smart wallets'],taggedRenownedWallets:['标签知名钱包','Tagged renowned wallets'],sampledTaggedWallets:['标签钱包样本','Tagged wallet samples'],holderCount:['持有人数','Holder count'],holderSampleDistinct:['不同持有人样本','Distinct holder samples'],swaps5m:['5分钟交换','5-minute swaps'],buys5m:['5分钟买入','5-minute buys'],volume5m:['5分钟成交','5-minute volume'],priceChange5m:['5分钟价格变化','5-minute price change'],swapsPerHolder5m:['每持有人交换数','Swaps per holder'],swapCountConsistent:['交易计数一致','Trade count consistent'],holderSampleConsistent:['持有人样本一致','Holder sample consistent'],sellBuyRatio:['卖买比','Sell/buy ratio'],ageSec:['币龄秒数','Age in seconds'],creatorStatus:['创建者状态','Creator status'],creatorLaunchCount:['创建者发币数','Creator launches'],creatorCreatedCount:['创建数','Created count'],creatorGraduatedCount:['毕业数','Graduated count'],creatorOpenRatio:['开放比例','Open ratio'],creatorDeletedPosts:['删除帖子数','Deleted posts'],creatorPromotedTokens:['推广代币数','Promoted tokens'],isHoneypot:['貔貅风险','Honeypot'],mintable:['可增发','Mintable'],ownerChangeBalance:['所有者可改余额','Owner can change balance'],hiddenOwner:['隐藏所有者','Hidden owner'],cannotSellAll:['无法全部卖出','Cannot sell all'],selfDestruct:['可自毁','Self-destruct'],externalCall:['外部调用','External calls'],slippageModifiable:['可修改滑点','Slippage modifiable'],personalSlippageModifiable:['可修改个人滑点','Personal slippage modifiable'],transferPausable:['可暂停转账','Transfers pausable'],blacklisted:['黑名单','Blacklisted'],tradingCooldown:['交易冷却','Trading cooldown'],freezable:['可冻结','Freezable'],closable:['可关闭','Closable'],balanceMutableAuthority:['可修改余额权限','Balance mutable authority'],transferFeeUpgradable:['可更新转账费','Transfer fee upgradable'],nonTransferable:['不可转账','Non-transferable']
});
const reasonLabels = {
  STALE_RULES:['风险规则已更新，等待复核','Risk rules changed; awaiting recheck'],AUDIT_FAILED:['深度审计失败，等待复查','Audit failed; awaiting recheck'],REQUEST_WAIT:['等待采集窗口','Waiting for a collection slot'],BLOCKED:['密钥被临时封锁，请检查Key或配额','Key temporarily blocked; check the key or quota'],REQUEST_FAILED:['采集请求失败','Feed request failed'],VERTICAL_PLATEAU:['急涨后窄幅平台','Vertical rise followed by a narrow plateau'],SUSTAINED_COLLAPSE:['持续大幅回撤','Sustained severe drawdown'],RATE_LIMITED:['请求额度受限','Rate limited'],AUTH_REQUIRED:['密钥不可用，请重新连接','Key unavailable; reconnect'],UNSUPPORTED:['来源不支持此链','Source does not support this chain'],NO_DATA:['来源暂无数据','No source data'],ERROR:['来源读取失败','Source read failed'],OK:['正常','OK'],WAIT_RECHECK:['等待复查','Waiting for recheck'],HARD_REJECT:['已排除','Rejected'],X_REVIEW:['等待人工看X','Review X manually']
};
const reasonText = (value,locale) => fieldLabels[value] ? localize(locale,...fieldLabels[value]) : reasonLabels[value] ? localize(locale,...reasonLabels[value]) : `${localize(locale,'证据不完整，请查看来源','Incomplete evidence; check the source')}: ${safeTelegramText(value,500)}`;
function evidenceLines(value,locale,prefix='') {
  if (Array.isArray(value)) return value.flatMap((item,index) => typeof item === 'object' && item !== null ? evidenceLines(item,locale,`${prefix} ${index+1}`) : [`${prefix} ${index+1}: ${reasonText(item,locale)}`]);
  if (value && typeof value === 'object') return Object.entries(value).filter(([key]) => !['version','reviewRevision','pairUrl','websites'].includes(key)).flatMap(([key,item]) => evidenceLines(item,locale,`${prefix ? prefix+' · ' : ''}${fieldLabels[key] ? localize(locale,...fieldLabels[key]) : safeTelegramText(key,60)}`));
  return [`${prefix}: ${typeof value === 'boolean' ? truth(value,locale) : typeof value === 'number' ? numberText(value,locale) : value === null || value === undefined || value === '' ? name('unknown',locale) : safeTelegramText(value,500)}`];
}

function findToken(snapshot,session) {
  const selected = session.query?.selectedToken;
  if (!selected) return null;
  const candidate = snapshot.candidates.find(row => id(row) === id(selected));
  const live = snapshot.liveByChain?.[selected.chain]?.rows?.find(row => id(row) === id(selected));
  const annotation = snapshot.annotations.find(row => id(row) === id(selected));
  return candidate || (live ? { ...live, info:{twitter:live.twitter,website:live.website} } : annotation ? { ...annotation, symbol:'?' } : null);
}

function detailPanel(snapshot,session,locale) {
  const L = (zh,en) => localize(locale,zh,en), row = findToken(snapshot,session);
  if (!row) return finishPanel(name('detail',locale),[L('未找到，请从列表选择代币','Not found; choose a token from a list')],[[back(locale),home(locale)]],snapshot,session,locale);
  const mark = markFor(snapshot,row), annotation = annotationFor(snapshot,row), identity = token(row), deep = row.deep || {};
  const checks = Object.values(deep.checks || {}), unknown = deep.unknownFields || [], blocking = deep.blockingUnknownFields || [];
  const header = [`${userText(row.symbol || '?',30)} · ${chainLabel(row.chain)} · ${state(snapshot,row,locale)}`, `CA: <code>${userText(row.address,80)}</code>`,`${L('审计','Audit')}: ${timestamp(row.auditedAt,locale)} · ${age(row.auditedAt,snapshot.at,locale)}`];
  const counts = `${L('通过/未通过检查','Passed/not-passed checks')}: ${checks.filter(value => value === true).length}/${checks.filter(value => value === false).length}\n${L('明确失败/阻断未知/其他未知/冲突','Explicit failures/blocking unknown/other unknown/conflicts')}: ${(deep.failed || []).length}/${blocking.length}/${unknown.filter(value => !blocking.includes(value)).length}/${(row.secondary?.conflicts || []).length}`;
  if (mark?.decision === 'passed' && effectiveStatus(row,mark,snapshot.at) !== 'passed') header.push(L('原人工通过已失效，请查看当前证据。','Prior approval is invalid; review current evidence.'));
  if (session.panel === 'evidence') {
    const sections = [
      [L('阻断发现','Blocking findings'), [...(deep.failed || []).map(value => `${L('失败','Failure')}: ${reasonText(value,locale)}`),...blocking.map(value => `${L('阻断未知','Blocking unknown')}: ${safeTelegramText(value)}`),...unknown.filter(value => !blocking.includes(value)).map(value => `${L('其他未知','Other unknown')}: ${safeTelegramText(value)}`),row.auditHealth?.earlyExit ? L('审计提前结束，部分证据未采集','Audit exited early; some evidence was not collected') : '',row.decisionReason ? reasonText(row.decisionReason,locale) : '',...evidenceLines(deep.checks || {},locale)]],
      [L('合约与供应','Contract and supply'),[safeTelegramText(deep.honeypotEvidence,500),...evidenceLines(deep.security || {},locale)]],
      [L('持有人与钱包','Holders and wallets'),evidenceLines(deep.wallets || {},locale)],
      [L('价格与可卖出性','Price and sellability'),[...evidenceLines(deep.observation || {},locale),...evidenceLines(deep.chartRisk || {},locale),...evidenceLines(deep.marketBehavior || {},locale),...evidenceLines(deep.sellability || {},locale)]],
      [L('第二来源','Second sources'),evidenceLines(row.secondary || {},locale)],
      [L('完整备注','Full note'),[annotation?.note || L('无备注','No note')]]
    ];
    const pages = sections.flatMap(([title,lines]) => textPages(lines.filter(Boolean).length ? lines.filter(Boolean) : [L('未知；未视为通过','Unknown; not treated as passed')],1800).map((items,index) => ({ title:`${title} · ${index+1}`,items })));
    const paging = pagination(pages.length,session.query?.detailPage,1,locale), page = pages[paging.page];
    return finishPanel(page.title,[...header,counts,'',...page.items.map(value => userText(value,2400)),`${paging.page+1}/${pages.length}`], [paging.keyboard,[button(L('摘要','Summary'),'panel.open',{panel:'detail'},identity),back(locale)]],snapshot,session,locale,identity);
  }
  const blocks = [...header,`${L('市值','Market cap')} ${money(row.marketCap,locale)} · ${L('流动性','Liquidity')} ${money(deep.security?.liquidity ?? row.liquidity,locale)} · ${L('持有人','Holders')} ${numberText(row.holders,locale)}`,counts];
  if (!row.auditedAt) blocks.push(L('审计快照已不再保留，或尚未审计。','Audit snapshot no longer retained, or not yet audited.'));
  if (backendDisposition(row) === 'chain') blocks.push(L('链上硬门通过；请人工查看X社区评论与回复。','On-chain gates passed; review X community comments and replies.'));
  blocks.push(`${L('人工标记','Manual mark')}: ${mark?.decision ? name(mark.decision,locale) : L('未标记','None')} · ${L('收藏','Favorite')}: ${truth(annotation?.favorite === true,locale)}`);
  if (annotation?.note) blocks.push(`${L('备注','Note')}: ${userText(annotation.note,140)}${annotation.note.length>140 ? L('…（完整备注见检查证据）','… (full note in Evidence)') : ''}`);
  blocks.push(L('人工通过不会改变筛选结果或执行交易。','Manual approval does not change screening results or execute trades.'));
  const x = officialXUrl(row.info?.twitter,row.social?.twitter,row.twitter), site = row.info?.website;
  if (!x || !site) blocks.push(L('部分官方链接不可用。','Some official links are unavailable.'));
  const keyboard = [[urlButton(L('查看X','View X'),x),urlButton('GMGN',row.gmgnUrl || `https://gmgn.ai/${row.chain}/token/${encodeURIComponent(row.address)}`)],[urlButton(L('官网','Website'),site)],[button(name('evidence',locale),'panel.open',{panel:'evidence'},identity)]];
  const binding = { reviewRevision:row.reviewRevision || null, expectedMarkVersion:mark?.version || 0 };
  if (mark?.decision) keyboard.push([button(mark.decision === 'passed' ? L('撤销人工通过','Undo approval') : L('取消忽略','Stop ignoring'),'mark.clear',binding,identity)]);
  else if (row.reviewRevision && backendDisposition(row) === 'chain' && row.auditedAt && snapshot.at-row.auditedAt <= 600_000) keyboard.push([button(L('人工通过','Approve manually'),'mark.set_passed',binding,identity)]);
  if (mark?.decision !== 'ignored') keyboard.push([button(L('忽略','Ignore'),'mark.set_ignored',binding,identity)]);
  keyboard.push([button(annotation?.favorite ? L('取消收藏','Remove favorite') : L('收藏','Favorite'),'favorite.set',{value:annotation?.favorite !== true},identity),button(L('备注','Note'),'note.begin',{},identity)]);
  if (annotation?.note) keyboard.push([button(L('清空备注','Clear note'),'note.clear',{},identity)]);
  if (session.query?.returnTo?.panel === 'feed') {
    const live = snapshot.liveByChain?.[row.chain], liveRow = live?.rows?.find(item => id(item) === id(row));
    if (liveRow?.auditEligible && live?.lastSuccessAt && snapshot.at-live.lastSuccessAt <= 60_000 && snapshot.control?.configured && snapshot.control?.enabledChains?.includes(row.chain) && row.status !== 'HARD_REJECT') keyboard.push([button(L('申请深审','Queue audit'),'audit.enqueue',{snapshotAt:live.lastSuccessAt},identity)]);
    else blocks.push(L('当前无法申请深审：需新鲜榜单、有效连接、已启用扫描链及通过入队检查。','Audit request unavailable: requires a fresh feed, usable connection, enabled scan chain and admission checks.'));
  }
  keyboard.push([refresh(locale),back(locale)]);
  return finishPanel(name('detail',locale),blocks,keyboard,snapshot,session,locale,identity);
}

function selectorPanel(snapshot,session,locale) {
  const L = (zh,en) => localize(locale,zh,en), query = session.query || {}, origin = query.returnTo?.panel || 'audits';
  let choices, action, selected;
  if (session.panel === 'view_chain') { choices = [...(['saved','events'].includes(origin) ? ['all'] : []),...TELEGRAM_CHAINS]; action='view_chain.set';selected=session.viewChain; }
  else if (session.panel === 'filter') { choices = origin === 'saved' ? ['all','favorite','notes'] : origin === 'events' ? ['all','candidates','risk','service'] : AUDIT_FILTERS; action='filter.set';selected=query.filter || 'all'; }
  else if (session.panel === 'sort') { choices=origin === 'feed' ? LIVE_SORTS : AUDIT_SORTS;action='sort.set';selected=query.sort || (origin === 'feed' ? 'priority' : 'audit_desc'); }
  else if (session.panel === 'language') { choices=['zh','en'];action='language.set';selected=locale; }
  else if (session.panel === 'horizon') { choices=['m5','m15','m30','h1','h2','h6','h24'];action='horizon.set';selected=query.horizon || 'm30'; }
  else { choices=['passed','rejected','compare'];action='cohort.set';selected=query.cohort || 'passed'; }
  const labels = { zh:'中文',en:'English',passed:L('链上通过组','On-chain passed'),rejected:L('排除对照组','Rejected control'),compare:L('对比','Compare'),m5:'5m',m15:'15m',m30:'30m',h1:'1h',h2:'2h',h6:'6h',h24:'24h' };
  const keyboard = choices.map(value => [button(`${selected === value ? '✓ ' : ''}${TELEGRAM_CHAINS.includes(value) ? chainLabel(value) : labels[value] || name(value,locale)}`,action,{value})]);
  keyboard.push([back(locale)]);
  return finishPanel(name(session.panel,locale),[L('选择仅影响当前面板视图；语言设置影响后续交互。','View choices apply to this panel; language applies to future interactions.')],keyboard,snapshot,session,locale);
}

function eventsPanel(snapshot,session,locale) {
  const L = (zh,en) => localize(locale,zh,en), query=session.query || {};
  const groups={candidates:['CANDIDATE_NEW'],risk:['RISK_WORSENED'],service:['ERROR','AUTH','RATE_LIMITED','STATE_ERROR','SCAN_COMPLETE','SCAN_STARTED']};
  const rows=snapshot.events.filter(row => (!session.viewChain || session.viewChain === 'all' || row.chain === session.viewChain) && (!groups[query.filter] || groups[query.filter].includes(row.type))).sort((a,b) => b.at-a.at);
  const logical=[];
  for(let index=0;index<rows.length;index+=12) {
    let page=[],size=0;
    for(const row of rows.slice(index,index+12)) {
      const text=`${timestamp(row.at,locale)} · ${chainLabel(row.chain) || L('服务','Service')}\n${groups.candidates.includes(row.type) ? name('candidates',locale) : groups.risk.includes(row.type) ? name('risk',locale) : groups.service.includes(row.type) ? name('service',locale) : L('其他事件','Other event')}: ${safeTelegramText(row.message,500)}`;
      if(size+userText(text,1000).length>2200 && page.length) { logical.push(page);page=[];size=0; }
      page.push({row,text,index:rows.indexOf(row)});size+=userText(text,1000).length;
    }
    if(page.length) logical.push(page);
  }
  const paging=pagination(logical.length,query.page,1,locale), shown=logical[paging.page] || [];
  const keyboard=pairs(shown.filter(({row}) => row.address && TELEGRAM_CHAINS.includes(row.chain) && (snapshot.candidates.some(candidate => id(candidate) === id(row)) || snapshot.annotations.some(annotation => id(annotation) === id(row)))).map(({row,index}) => detailButton(row,index,locale)));
  keyboard.push([open('view_chain',locale),open('filter',locale)],paging.keyboard,[refresh(locale),open('status',locale)],[home(locale)]);
  return finishPanel(name('events',locale),shown.length ? [...shown.map(({text,index}) => `${index+1}. ${userText(text,1000)}`),`${shown[0].index+1}–${shown.at(-1).index+1} / ${rows.length}`] : [L('尚无事件','No events yet')],keyboard,snapshot,session,locale);
}

const HELP_COMMANDS = [
  ['start','雷达总览','Radar overview'],['radar','雷达总览','Radar overview'],['help','帮助与密钥安全','Help and key safety'],['status','运行状态','Service status'],['settings','设置','Settings'],['chains','选择扫描链','Choose scan chains'],['feed','活跃榜与采集','Live feed and collection'],['audits','近30分钟深审','Audits from last 30 min'],['candidates','近30分钟深审','Audits from last 30 min'],['saved','收藏与备注','Favorites and notes'],['events','雷达事件','Radar events'],['stats','筛选后表现','Post-screen performance'],['note','编辑代币备注','Edit a token note'],['export','导出记录','Export records'],['onboard','连接GMGN','Connect GMGN'],['setkey','提交GMGN密钥','Submit GMGN key'],['pause','暂停扫描','Pause scanning'],['resume','恢复扫描','Resume scanning'],['disconnect','断开并删除密钥','Disconnect and delete key'],['mute','关闭提醒','Mute alerts'],['unmute','开启提醒','Enable alerts'],['lang','选择语言','Choose language'],['cancel','取消输入','Cancel input']
];
export function telegramCommandDescriptions(locale='zh') { return HELP_COMMANDS.map(([command,zh,en]) => ({command,description:localize(locale,zh,en)})); }
export function keySafetyCopy(locale='zh') {
  return localize(locale,'API Key明文会经过Telegram并可能留在聊天记录中。我们会尝试删除含Key消息，但无法保证删除。请自行检查并删除。服务端只保存加密Key；回显仅显示 gmgn_****。只读，不执行交易。','Your plaintext key passes through Telegram and may remain in chat history. We try to delete the message but cannot guarantee deletion; check and delete it yourself. The service stores the key encrypted and only displays gmgn_****. Read-only; no trades.');
}

function statusPanel(snapshot,session,locale) {
  const L=(zh,en)=>localize(locale,zh,en),control=snapshot.control || {},metrics=snapshot.metrics || {},live=snapshot.live || {};
  let blocks,keyboard;
  if(session.panel === 'sources') {
    const lines=evidenceLines(snapshot.sourceHealth || {},locale);
    const pages=textPages(lines.length ? lines : [L('尚无来源记录','No source records')]);
    const paging=pagination(pages.length,session.query?.page,1,locale);
    blocks=pages[paging.page].map(value=>userText(value,2400));keyboard=[paging.keyboard,[refresh(locale),back(locale)]];
  } else if(session.panel === 'delivery') {
    const pages=textPages((snapshot.delivery || []).map(row=>`${row.purpose === 'ACTION_REQUIRED' ? L('需处理的提醒','Action-required notice') : row.purpose === 'PANEL_UPDATE' ? L('面板更新','Panel update') : L('请求回复','Requested response')}: ${row.status === 'UNKNOWN' ? L('发送结果不确定，请核对','Delivery unconfirmed; check it') : L('发送失败','Delivery failed')}`));
    const paging=pagination(pages.length,session.query?.page,1,locale);
    blocks=(snapshot.delivery || []).length ? pages[paging.page].map(value=>userText(value,2400)) : [L('没有待核对的投递问题','No delivery issues to check')];
    keyboard=[paging.keyboard,(snapshot.delivery || []).length ? [button(L('已核对并清除','Acknowledge and clear'),'delivery.acknowledge')] : [],[home(locale),refresh(locale)],[back(locale)]];
  } else {
    const focused=snapshot.liveByChain?.[live.focusChain];
    blocks=[`${L('扫描','Scanning')}: ${control.paused ? L('已暂停','Paused') : control.configured ? L('运行中','Running') : L('等待连接','Waiting for connection')}`,`${L('当前链','Current chain')}: ${chainLabel(control.activeChain) || name('unknown',locale)}`,`${L('上次尝试','Last attempt')}: ${timestamp(metrics.lastAttemptAt,locale)}`,`${L('上次成功','Last success')}: ${timestamp(metrics.lastSuccessAt,locale)}`,`${L('下轮计划','Next scheduled')}: ${metrics.nextCycleAt ? timestamp(metrics.nextCycleAt,locale) : L('未安排','Not scheduled')}`,`${L('审计队列/到期','Audit queue/due')}: ${snapshot.queue?.length ?? 0}/${snapshot.queue?.filter(row=>row.nextAuditAt !== null && row.nextAuditAt<=snapshot.at).length ?? 0}`,`${L('活跃榜','Live feed')}: ${live.subscribed ? chainLabel(live.focusChain) || name('unknown',locale) : L('未开启','Off')}`,`${L('上次采集成功','Last collection success')}: ${timestamp(focused?.lastSuccessAt,locale)}`,`${L('采集目标20秒 · 最近延迟','Collection target 20s · latest lag')}: ${numberText(focused?.pollLagMs,locale)}ms`,`${L('投递需核对','Delivery issues')}: ${snapshot.delivery?.length ?? 0}`];
    if(snapshot.cooldownUntil>snapshot.at) blocks.push(`${L('请求额度受限，等待至','Rate limited; waiting until')} ${timestamp(snapshot.cooldownUntil,locale)}`);
    keyboard=[[open('sources',locale),open('delivery',locale)],[refresh(locale),open('settings',locale)],[home(locale)]];
  }
  return finishPanel(name(session.panel,locale),blocks,keyboard,snapshot,session,locale);
}

export function renderStatisticsPanel(snapshot,session,locale='zh') {
  const L=(zh,en)=>localize(locale,zh,en),summary=snapshot.stats?.[session.viewChain],query=session.query || {},horizon=query.horizon || 'm30',cohort=query.cohort || 'passed';
  const blocks=[chainLabel(session.viewChain),L('影子观察，不代表可成交收益。','Shadow observations; not executable returns.')];
  const keyboard=[[open('view_chain',locale),open('horizon',locale)],[open('cohort',locale),button(L('覆盖详情','Coverage details'),'panel.open',{panel:'stats',query:{coverage:true}})],[refresh(locale),home(locale)]];
  if(!summary) blocks.push(L('统计数据不可用','Statistics unavailable'));
  else if(query.coverage || query.horizon || query.cohort) {
    for(const selected of cohort === 'compare' ? ['passed','rejected'] : [cohort]) {
      const row=summary.coverage?.[selected]?.[horizon];
      blocks.push(`<b>${selected === 'passed' ? L('链上通过组','On-chain passed') : L('排除对照组','Rejected control')} · ${horizon}</b>`);
      if(!row) blocks.push(L('不可用','Unavailable'));
      else blocks.push(`${L('到期/完成/缺失','Eligible/completed/missing')}: ${numberText(row.eligible,locale)}/${numberText(row.completed,locale)}/${numberText(row.missing,locale)}`,`${L('中位数','Median')}: ${row.median === null ? L('暂无样本','No samples') : percent(row.median,locale,true)}`,`${L('正收益比例','Positive returns')}: ${row.positiveRate === null ? L('暂无样本','No samples') : percent(row.positiveRate,locale)}`);
    }
  } else {
    blocks.push(`${L('链上通过组：跟踪','On-chain passed: tracked')} ${numberText(summary.tracked,locale)}`);
    for(const [label,suffix] of [['30m','30m'],['1h','1h'],['2h','2h'],['24h','24h']]) blocks.push(`${label}: ${summary['averageReturn'+suffix] === null ? L('暂无样本','No samples') : percent(summary['averageReturn'+suffix],locale,true)} · ${L('完成','Completed')} ${numberText(summary['completed'+suffix],locale)}`);
  }
  if(summary) {
    blocks.push(`${L('50样本门槛','50-sample gate')}: ${['30m','2h','24h'].map(window=>`${window} ${summary['completed'+window]>=50 ? L('已达','Ready') : L('未达','Not ready')}`).join(' · ')}`,`${L('整体调参门槛','Overall calibration gate')}: ${summary.calibrationReady === true ? L('已达','Ready') : L('未达','Not ready')}`);
  }
  return finishPanel(name('stats',locale),blocks,keyboard,snapshot,session,locale);
}

/** Pure native Telegram panel renderer. Action descriptors are bound by the controller. */
export function renderPanel(snapshot,session,locale='zh') {
  if(!['zh','en'].includes(locale)) throw new TypeError('Unsupported Telegram locale');
  if(!PANEL_NAMES.includes(session.panel)) throw new TypeError('Unsupported Telegram panel');
  const L=(zh,en)=>localize(locale,zh,en),query=session.query || {},control=snapshot.control || {};
  if(['feed','audits','saved'].includes(session.panel)) return listPanel(snapshot,session,locale);
  if(['detail','evidence'].includes(session.panel)) return detailPanel(snapshot,session,locale);
  if(['view_chain','filter','sort','language','horizon','cohort'].includes(session.panel)) return selectorPanel(snapshot,session,locale);
  if(['status','sources','delivery'].includes(session.panel)) return statusPanel(snapshot,session,locale);
  if(session.panel === 'stats') return renderStatisticsPanel(snapshot,session,locale);
  if(session.panel === 'events') return eventsPanel(snapshot,session,locale);
  let blocks=[],keyboard=[];
  if(session.panel === 'radar') {
    if(!control.configured && !snapshot.candidates.length) {
      blocks=[L('连接 GMGN 后开始扫描。只读研究，不执行交易。','Connect GMGN to start scanning. Read-only research; no trading.')];
      keyboard=[[open('onboard',locale)],[open('language',locale),open('help',locale)],[open('saved',locale),open('status',locale)]];
    } else {
      const recent=snapshot.candidates.filter(row=>row.chain === session.viewChain && row.auditedAt>=snapshot.at-1_800_000),metrics=snapshot.metrics || {},queue=snapshot.queue.filter(row=>row.chain === session.viewChain);
      blocks=[chainLabel(session.viewChain),`${control.paused ? L('扫描已暂停','Scanning paused') : L('扫描运行中','Scanning running')} · ${control.configured ? L('GMGN已连接','GMGN connected') : L('GMGN未连接，显示历史数据','GMGN disconnected; historical data')} · ${control.notifications ? L('提醒已开启','Alerts on') : L('提醒已关闭','Alerts off')}`,`${L('累计成功扫描','Successful scans')}: ${numberText(metrics.scanCount,locale)}`,`${L('本轮发现/初筛通过','Cycle discovered/prefilter passed')}: ${numberText(metrics.discoveredCount,locale)}/${numberText(metrics.prequalifiedCount,locale)}`,`${L('近30分钟深审/链上候选/有效人工通过','Last 30m audits/on-chain/valid manual approvals')}: ${recent.length}/${recent.filter(row=>backendDisposition(row)==='chain').length}/${recent.filter(row=>effectiveStatus(row,markFor(snapshot,row),snapshot.at)==='passed').length}`,`${L('队列/到期','Queue/due')}: ${queue.length}/${queue.filter(row=>row.nextAuditAt!==null && row.nextAuditAt<=snapshot.at).length}`,L('只读研究，不执行交易。','Read-only research; no trading.')];
      keyboard=[[open('feed',locale),open('audits',locale)],[open('stats',locale),open('saved',locale)],[open('events',locale),open('status',locale)],[open('view_chain',locale),open('settings',locale)]];
    }
  } else if(session.panel === 'settings') {
    blocks=[`${L('扫描链','Scan chains')}: ${(control.enabledChains || []).map(chainLabel).join(', ')} (${control.enabledChains?.length || 0}/3)`,control.configured ? L('GMGN已连接 gmgn_****','GMGN connected gmgn_****') : L('尚未连接GMGN','GMGN not connected'),`${L('扫描','Scanning')}: ${control.paused ? L('已暂停','Paused') : L('运行中','Running')}`,`${L('提醒','Alerts')}: ${control.notifications ? L('已开启','On') : L('已关闭','Off')}`,`${L('后台采集','Background collection')}: ${snapshot.live?.subscribed ? chainLabel(snapshot.live.focusChain) || name('unknown',locale) : L('未开启','Off')}`,`${L('语言','Language')}: ${locale==='en' ? 'English' : '中文'}`];
    keyboard=[[open('chains',locale),open('onboard',locale)],[button(control.paused ? L('恢复扫描','Resume scanning') : L('暂停扫描','Pause scanning'),control.paused ? 'scan.resume' : 'scan.pause'),button(control.notifications ? L('关闭提醒','Mute alerts') : L('开启提醒','Enable alerts'),'notifications.set',{value:!control.notifications})],[open('language',locale),button(L('导出记录','Export records'),'export.create')],[open('status',locale),home(locale)]];
    if(control.configured || snapshot.onboarding?.publicKey) keyboard.push([open('disconnect',locale)]);
  } else if(session.panel === 'chains') {
    const draft=query.draftChains || control.enabledChains || [];
    blocks=[L('选择1–3条扫描链；保存后生效。查看链和活跃榜采集链不受影响。','Choose 1–3 scan chains, then Save. The viewed chain and live focus remain independent.'),`${draft.length}/3`];
    if(draft.length<1 || draft.length>3) blocks.push(L('必须选择1–3条链','Select between 1 and 3 chains'));
    keyboard=TELEGRAM_CHAINS.map(value=>[button(`${draft.includes(value)?'✓ ':''}${chainLabel(value)}`,'chains.draft_set',{value,selected:!draft.includes(value)})]);
    keyboard.push([draft.length>=1 && draft.length<=3 ? button(L('保存','Save'),'chains.save') : null,back(locale)]);
  } else if(session.panel === 'disconnect' || session.panel === 'regenerate') {
    blocks=[session.panel==='disconnect' ? L('停止扫描和采集，删除API密钥与签名密钥；保留研究记录。','Stop scanning and collection, delete API and signing keys; retain research records.') : L('旧的待绑定公钥将失效，正在进行的旧密钥验证不能继续生效。','The prior pending public key will become unusable; its in-flight verification cannot activate.')];
    keyboard=[[button(session.panel==='disconnect'?L('断开并删除密钥','Disconnect and delete key'):L('确认重新生成','Confirm regeneration'),session.panel==='disconnect'?'connection.disconnect':'onboard.regenerate',session.panel==='regenerate'?{generation:query.generation}:{})],[back(locale)]];
  } else if(session.panel === 'onboard') {
    const onboarding=snapshot.onboarding || {},phase=onboarding.status;
    const phases={ preparing:['正在准备公钥','Preparing public key'],verifying:['正在验证只读权限','Verifying read access'],waiting:['等待请求额度，尚未验证','Waiting for request capacity; not verified'],failed:['新密钥验证失败；原连接保持原状态','New key failed verification; prior connection unchanged'],expired:['密钥验证已超时，请重新提交','Key verification expired; submit again'],auth_failure:['密钥不可用，请重新连接','Key unavailable; reconnect'],state_error:['连接状态不可读取，请联系部署方','Connection state unreadable; contact operator'] };
    if(phase && phases[phase]) blocks.push(localize(locale,...phases[phase]));
    if(control.configured) blocks.push(L('GMGN已连接 gmgn_****；新密钥待绑定不影响原连接。','GMGN connected gmgn_****; pending replacement does not change the active connection.'));
    if(onboarding.publicKey) {
      if(typeof onboarding.publicKey!=='string' || !/^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\r\n]+\n-----END PUBLIC KEY-----\s*$/.test(onboarding.publicKey) || onboarding.publicKey.length>512) throw new TypeError('Invalid public onboarding key');
      blocks.push(L('第1步：打开GMGN API管理，使用以下公钥创建只读Key。','Step 1: open GMGN API management and create a read-only key using this public key.'),`<pre>${onboarding.publicKey}</pre>`,L('第2步：回复 gmgn_… 或发送 /setkey &lt;key&gt;。','Step 2: send gmgn_… or /setkey &lt;key&gt;.'));
      keyboard.push([urlButton(L('打开GMGN API管理','Open GMGN API management'),'https://gmgn.ai/ai?tab=api_management')],[open('regenerate',locale,{query:{generation:onboarding.generation}}),open('help',locale)]);
    } else if(!phase && !control.configured) {
      blocks.push(L('使用 /onboard 创建绑定公钥。','Use /onboard to prepare your public key.'));
    }
    blocks.push(keySafetyCopy(locale));
    if(control.configured) keyboard.push([home(locale),open('chains',locale)],[open('feed',locale),!control.notifications?button(L('开启提醒','Enable alerts'),'notifications.set',{value:true}):null]);
    keyboard.push([open('status',locale),open('settings',locale)]);
  } else if(session.panel === 'help') {
    const pages=[HELP_COMMANDS.slice(0,12).map(([command,zh,en])=>`/${command} — ${L(zh,en)}`),HELP_COMMANDS.slice(12).map(([command,zh,en])=>`/${command} — ${L(zh,en)}`),[L('只读研究，不执行交易；非投资建议。','Read-only research; no trades. Not investment advice.'),keySafetyCopy(locale),L('/feed [chain|off] 设置采集；查看链不改变采集。/lang [zh|en] 设置语言。/note <简称或CA> 编辑备注；/cancel 取消输入。','/feed [chain|off] controls collection; viewing a chain does not. /lang [zh|en] sets language. /note <symbol or CA> edits a note; /cancel cancels input.'),L('暂停扫描、关闭采集和关闭提醒是独立控制。历史消息不是实时状态，请刷新。','Pause, feed off and mute are independent controls. Historical messages are not live state; refresh them.')]];
    const paging=pagination(pages.length,query.page,1,locale);blocks=pages[paging.page];keyboard=[paging.keyboard,[open('onboard',locale),home(locale)]];
  }
  return finishPanel(name(session.panel,locale),blocks,keyboard,snapshot,session,locale);
}
