import assert from 'node:assert/strict';
import test from 'node:test';
import { renderPanel, selectPanelRows, PANEL_NAMES, telegramCommandDescriptions } from '../src/bot/panels.mjs';
import { projectTelegramCandidate, projectTelegramFeedRow, createTelegramExport, safeTelegramUrl } from '../src/bot/snapshot.mjs';
import { CHART_RISK_VERSION } from '../src/scoring/chart-risk.mjs';
import { money, officialXUrl } from '../src/render/telegram.mjs';

const now=1_800_000_000_000;
function candidate(index=0,changes={}) { return projectTelegramCandidate({ chain:'sol',address:'A'.repeat(32)+index,symbol:'COIN'+index,name:'Research token',status:'X_REVIEW',marketCap:20000+index,liquidity:8000,holders:0,auditedAt:now-60_000,reviewRevision:'revision',deep:{chainPass:true,chartRisk:{version:CHART_RISK_VERSION,pass:true},checks:{openSource:true,ownerRenounced:false},failed:[],unknownFields:[],blockingUnknownFields:[]},...changes }); }
function fixture() { return {at:now,control:{configured:true,paused:false,notifications:false,activeChain:'sol',scanChain:'sol'},candidates:Array.from({length:13},(_,index)=>candidate(index)),annotations:[],marks:[],events:[],queue:[],delivery:[],metrics:{},sourceHealth:{},feedByChain:{},ave:{cuUsed:0,blockedUntil:0,readyAt:0},outcomes:[]}; }
function session(panel='audits',query={}) { return {panel,viewChain:'sol',query,version:2}; }
const actions=result=>result.keyboard.flat().filter(item=>item.action).map(item=>item.action);

test('all native panels render both locales with bounded text and typed action descriptors',()=>{
  for(const locale of ['zh','en']) for(const panel of PANEL_NAMES) {
    const snapshot=fixture(), current=session(panel,{selectedToken:{chain:'sol',address:snapshot.candidates[0].address}});
    const result=renderPanel(snapshot,current,locale);
    assert.ok(result.text.length<=3500,`${panel} ${locale}`);
    assert.ok(result.keyboard.length,`${panel} has navigation`);
    for(const item of result.keyboard.flat()) assert.ok(item.url || typeof item.action==='string');
    assert.equal(result.version,2);
  }
  const commands=telegramCommandDescriptions('en').map(item=>item.command);
  assert.equal(commands.length,23);
  assert.ok(commands.includes('mute')&&commands.includes('wallet')&&!commands.includes('unmute'));
});

// Panels whose content cannot change by re-reading: choices, confirmations, help, evidence
// pages, and the trading dialogs (in this fixture trading is off, so they are all static).
const STATIC_PANELS=new Set(['view_chain','filter','sort','language','horizon','cohort','chains','disconnect','help','evidence','trade','wallet','wallet_export','wallet_remove','trade_settings']);
test('every panel ends with the standard footer and keeps navigation out of its body',()=>{
  const home=item=>item.action==='panel.open'&&item.params.panel==='radar';
  const nav=item=>item.action==='panel.refresh'||item.action==='panel.back'||home(item);
  for(const locale of ['zh','en']) for(const panel of PANEL_NAMES) for(const returning of [false,true]) {
    const snapshot=fixture(), query={selectedToken:{chain:'sol',address:snapshot.candidates[0].address},...(returning?{returnTo:{panel:'audits',viewChain:'sol',query:{}}}:{})};
    const result=renderPanel(snapshot,session(panel,query),locale), footer=result.keyboard.at(-1), label=`${panel} ${locale} ${returning}`;
    assert.ok(footer.every(nav),label);
    assert.ok(!result.keyboard.slice(0,-1).flat().some(nav),label);
    const order=footer.map(item=>item.action==='panel.refresh'?0:item.action==='panel.back'?1:2);
    assert.deepEqual(order,[...order].sort(),label);
    assert.equal(footer.some(item=>item.action==='panel.back'),returning&&panel!=='radar',label);
    assert.equal(footer.some(home),panel!=='radar',label);
    assert.equal(footer.some(item=>item.action==='panel.refresh'),!STATIC_PANELS.has(panel),label);
    assert.match(result.text,locale==='en'?/\n\nUpdated [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2} UTC$/:/\n\n更新于 \d{1,2}月\d{1,2}日 \d{2}:\d{2} UTC$/,label);
  }
});

test('audit filters use effective marks while overview keeps original on-chain candidate count',()=>{
  const snapshot=fixture();snapshot.marks=[{chain:'sol',address:snapshot.candidates[0].address,decision:'passed',at:now-1,reviewRevision:'revision'}];
  assert.equal(selectPanelRows(snapshot,session('audits',{filter:'chain'})).length,12);
  assert.equal(selectPanelRows(snapshot,session('audits',{filter:'passed'})).length,1);
  snapshot.candidates[1]={...snapshot.candidates[1],status:'LIVE_READY'};snapshot.candidates[2]={...snapshot.candidates[2],status:'HARD_REJECT'};
  assert.match(renderPanel(snapshot,session('radar'),'en').text,/leads\/vetoed: 1\/1/);
  assert.equal(selectPanelRows(snapshot,session('audits',{filter:'lead'})).length,1);
});

test('audit and fresh cutoffs are inclusive and saved records survive evidence expiry',()=>{
  const snapshot=fixture();snapshot.candidates=[candidate(0,{auditedAt:now-1_800_000}),candidate(1,{auditedAt:now-1_800_001}),candidate(2,{auditedAt:now-300_000}),candidate(3,{auditedAt:now-300_001})];
  snapshot.annotations=[{chain:'base',address:'0x'+'a'.repeat(40),favorite:true,note:'Historical note',updatedAt:now}];
  assert.equal(selectPanelRows(snapshot,session()).length,3);
  assert.equal(selectPanelRows(snapshot,session('audits',{filter:'fresh'})).length,1);
  assert.equal(selectPanelRows(snapshot,{...session('saved'),viewChain:'all'}).length,1);
  const detail=renderPanel(snapshot,session('detail',{selectedToken:snapshot.annotations[0]}),'en');
  assert.match(detail.text,/no longer retained/);assert.ok(!actions(detail).includes('mark.set_passed'));
});

test('the hot list states its read status, staleness and whether the chain is scanned, in both locales',()=>{
  for(const [status,zh,en] of [['AVE_RATE_LIMITED','AVE限流','AVE rate limited'],['AVE_QUOTA','AVE额度用完','AVE credits exhausted']]) {
    const snapshot=fixture();
    snapshot.feedByChain={sol:{rows:[],status,observedAt:now}};
    assert.match(renderPanel(snapshot,session('feed'),'zh').text,new RegExp(zh),status);
    assert.match(renderPanel(snapshot,session('feed'),'en').text,new RegExp(en),status);
  }
  const healthy=fixture();
  healthy.feedByChain={sol:{rows:[],status:'READY',observedAt:now}};
  assert.doesNotMatch(renderPanel(healthy,session('feed'),'en').text,/Read status|stale/);
  healthy.feedByChain.sol.observedAt=now-120_001;assert.match(renderPanel(healthy,session('feed'),'en').text,/Data stale/);
  healthy.control.scanChain='arc';assert.match(renderPanel(healthy,session('feed'),'en').text,/not being scanned/);
});

test('five-row pagination clamps after deletion and token buttons bind identities rather than ordinals',()=>{
  const snapshot=fixture(),result=renderPanel(snapshot,session('audits',{page:999}),'en');
  const buttons=result.keyboard.flat().filter(item=>item.token);
  assert.equal(buttons.length,3);assert.equal(buttons[0].token.address,snapshot.candidates[10].address);
  assert.match(result.text,/11–13 \/ 13/);
});

test('search precedes sorting and live top-15 truncation, with stable volume ties',()=>{
  const snapshot=fixture();snapshot.feedByChain.sol={rows:Array.from({length:25},(_,index)=>projectTelegramFeedRow({address:'a'+index,symbol:index<20?'OTHER':'MATCH',priorityBand:true,pass:index%2===0,volume5m:1,reasons:[]},'sol'))};
  const selected=selectPanelRows(snapshot,session('feed',{search:'match'}));
  assert.equal(selected.length,5);assert.deepEqual(selected.map(row=>row.address),['a20','a22','a24','a21','a23'],'screen passes first, stable ties');
  assert.equal(selectPanelRows(snapshot,session('feed')).length,15);
});

test('projection preserves unknown, false and zero, including early-exit evidence',()=>{
  const row=candidate(0,{marketCap:undefined,deep:{chartRisk:{version:CHART_RISK_VERSION},checks:{openSource:false},security:{honeypot:false,buyTax:0},wallets:{ordinaryCount:0}},auditHealth:{earlyExit:true}});
  assert.equal(row.marketCap,null);assert.equal(row.holders,0);assert.equal(row.deep.checks.openSource,false);assert.equal(row.deep.checks.tax,null);assert.equal(row.deep.security.honeypot,false);assert.equal(row.deep.security.buyTax,0);assert.equal(row.deep.wallets.ordinaryCount,null);
  assert.notEqual(money(.000000001,'en'),'$0');
});

test('every long finding remains reachable with valid escaped HTML pages',()=>{
  const snapshot=fixture();snapshot.candidates=[candidate(0,{deep:{chartRisk:{version:CHART_RISK_VERSION},failed:Array.from({length:110},(_,index)=>`finding-${index} <unsafe> & 中文`),unknownFields:[]}})];
  const content=[];let page=0;
  while(true) {
    const result=renderPanel(snapshot,session('evidence',{selectedToken:snapshot.candidates[0],detailPage:page}),'en');
    assert.ok(result.text.length<=3500);assert.ok(!result.text.includes('<unsafe>'));content.push(result.text);
    if(!result.keyboard.flat().some(item=>item.action==='page.set' && item.params.page===page+1)) break;
    page++;assert.ok(page<100);
  }
  for(let index=0;index<110;index++) assert.ok(content.join('\n').includes(`finding-${index} `));
});

test('malicious labels and credentials are escaped or redacted and unsafe links omitted',()=>{
  const snapshot=fixture();snapshot.candidates=[candidate(0,{symbol:'<b>bad</b>',name:'api_key=secret',info:{website:'https://user:password@example.com',twitter:'https://x.com/home'}})];
  const result=renderPanel(snapshot,session('detail',{selectedToken:snapshot.candidates[0]}),'en');
  assert.ok(result.text.includes('&lt;b&gt;bad&lt;/b&gt;'));assert.ok(!result.text.includes('api_key=secret'));assert.ok(!result.keyboard.flat().some(item=>item.url?.startsWith('javascript')));
  assert.ok(!result.keyboard.flat().some(item=>item.url?.includes('password')));
  assert.equal(safeTelegramUrl('http://example.com'),'');assert.equal(officialXUrl('https://evil.com/user'),'');assert.equal(officialXUrl('https://x.com/home'),'');assert.equal(officialXUrl('@valid_user'),'https://x.com/valid_user');
});

test('manual approval creation is unavailable for ignored, stale or revisionless evidence but undo remains available',()=>{
  const snapshot=fixture(),selected=snapshot.candidates[0];
  assert.ok(actions(renderPanel(snapshot,session('detail',{selectedToken:selected}))).includes('mark.set_passed'));
  for(const changes of [{auditedAt:now-600_001},{reviewRevision:''}]) {
    snapshot.candidates=[{...selected,...changes}];assert.ok(!actions(renderPanel(snapshot,session('detail',{selectedToken:selected}))).includes('mark.set_passed'));
  }
  snapshot.marks=[{...selected,decision:'passed',at:now-86400000,reviewRevision:'revision',version:3}];
  const stale=renderPanel(snapshot,session('detail',{selectedToken:selected}),'en');assert.ok(actions(stale).includes('mark.clear'));assert.match(stale.text,/Prior approval is invalid/);
  snapshot.marks[0].decision='ignored';assert.ok(!actions(renderPanel(snapshot,session('detail',{selectedToken:selected}))).includes('mark.set_passed'));
});

test('a lead detail links no external trading page and offers no manual approval',()=>{
  const snapshot=fixture();
  snapshot.candidates=[candidate(0,{status:'LIVE_READY',aveUrl:'https://pro.ave.ai/token/'+'A'.repeat(32)+'0-solana?ref=0001'})];
  const lead=renderPanel(snapshot,session('detail',{selectedToken:snapshot.candidates[0]}),'en');
  assert.ok(!lead.keyboard.flat().some(item=>String(item.url).includes('ave.ai')));assert.doesNotMatch(lead.text,/Trade on AVE/);
  assert.match(lead.text,/Market lead/);assert.ok(!actions(lead).includes('mark.set_passed'));
});

test('the chain panel selects exactly one scan chain',()=>{
  const snapshot=fixture(),result=renderPanel(snapshot,session('chains'),'en');
  const choices=result.keyboard.flat().filter(item=>item.action==='chains.set');
  assert.deepEqual(choices.map(item=>item.params.value),['arc','bsc','base','eth','sol','robinhood']);
  assert.equal(choices.filter(item=>item.text.startsWith('✓')).length,1);
});

test('events split long logical pages without hiding events and link only resolvable tokens',()=>{
  const snapshot=fixture();snapshot.events=Array.from({length:15},(_,index)=>({at:now-index,chain:'sol',type:'CUSTOM',message:`event-${index} `+'long '.repeat(90)}));
  const seen=[];let page=0;
  while(true) { const result=renderPanel(snapshot,session('events',{page}),'en');seen.push(result.text);if(!result.keyboard.flat().some(item=>item.action==='page.set' && item.params.page===page+1)) break;page++; }
  for(let index=0;index<15;index++) assert.ok(seen.join('').includes(`event-${index} `));
});

test('onboarding in both languages links AVE Cloud, asks for /setkey and states residual chat risk',()=>{
  for(const locale of ['zh','en']) {
    const result=renderPanel(fixture(),session('onboard'),locale);
    assert.ok(result.keyboard.flat().some(item=>item.url==='https://cloud.ave.ai/login'));
    assert.ok(result.text.includes('/setkey'));assert.ok(result.text.includes(locale==='en'?'cannot guarantee deletion':'无法保证删除'));
  }
});

test('export is all-chain and whitelist-only with original manual revision and sanitized annotations',()=>{
  const snapshot=fixture();snapshot.annotations=[{chain:'base',address:'0x'+'a'.repeat(40),favorite:true,note:'api_key=secret',updatedAt:now,tenantId:'private'}];snapshot.marks=[{...snapshot.candidates[0],decision:'passed',at:now-1,reviewRevision:'revision',version:3}];snapshot.privateKey='private secret';
  const exported=createTelegramExport(snapshot),serialized=JSON.stringify(exported);
  assert.equal(Object.keys(exported.chains).length,6);assert.equal(exported.chains.base.annotations.length,1);assert.equal(exported.chains.sol.manualMarks[0].reviewRevision,'revision');assert.ok(!serialized.includes('api_key=secret'));assert.ok(!serialized.includes('tenantId'));assert.ok(!serialized.includes('privateKey'));
});

test('statistics distinguish unavailable from empty and require all three windows for overall readiness',()=>{
  const snapshot=fixture();assert.match(renderPanel(snapshot,session('stats'),'en').text,/unavailable/);
  snapshot.stats={sol:{tracked:60,completed30m:50,completed1h:1,completed2h:49,completed24h:0,averageReturn30m:null,averageReturn1h:null,averageReturn2h:null,averageReturn24h:null,calibrationReady:false,coverage:{passed:{h6:{eligible:0,completed:0,missing:0,median:null,positiveRate:null}}}}};
  const summary=renderPanel(snapshot,session('stats'),'en');assert.match(summary.text,/30m Ready/);assert.match(summary.text,/Overall calibration gate: Not ready/);
  const detail=renderPanel(snapshot,session('stats',{horizon:'h6'}),'en');assert.match(detail.text,/0\/0\/0/);assert.match(detail.text,/No samples/);
});

test('evidence pages keep the exact audit time while the detail summary shows it relatively',()=>{
  const snapshot=fixture(),query={selectedToken:{chain:'sol',address:snapshot.candidates[0].address}};
  assert.match(renderPanel(snapshot,session('evidence',query),'en').text,/Audit: 2027-01-15 07:59:00 UTC · 1m ago/);
  assert.match(renderPanel(snapshot,session('detail',query),'en').text,/Audit: 1m ago\n/);
});
