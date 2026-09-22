import assert from 'node:assert/strict';
import test from 'node:test';
import { renderPanel, selectPanelRows, PANEL_NAMES, telegramCommandDescriptions } from '../src/bot/panels.mjs';
import { projectTelegramCandidate, projectTelegramLiveRow, createTelegramExport, safeTelegramUrl } from '../src/bot/snapshot.mjs';
import { CHART_RISK_VERSION } from '../src/scoring/chart-risk.mjs';
import { money, officialXUrl } from '../src/render/telegram.mjs';

const now=1_800_000_000_000;
function candidate(index=0,changes={}) { return projectTelegramCandidate({ chain:'sol',address:'A'.repeat(32)+index,symbol:'COIN'+index,name:'Research token',status:'X_REVIEW',marketCap:20000+index,liquidity:8000,holders:0,auditedAt:now-60_000,reviewRevision:'revision',deep:{chainPass:true,chartRisk:{version:CHART_RISK_VERSION,pass:true},checks:{openSource:true,ownerRenounced:false},failed:[],unknownFields:[],blockingUnknownFields:[]},...changes }); }
function fixture() { return {at:now,control:{configured:true,paused:false,notifications:false,activeChain:'sol',enabledChains:['sol']},candidates:Array.from({length:13},(_,index)=>candidate(index)),annotations:[],marks:[],events:[],queue:[],delivery:[],metrics:{},sourceHealth:{},live:{},liveByChain:{},outcomes:[]}; }
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
  assert.equal(telegramCommandDescriptions('en').length,23);
});

test('audit filters use effective marks while overview keeps original on-chain candidate count',()=>{
  const snapshot=fixture();snapshot.marks=[{chain:'sol',address:snapshot.candidates[0].address,decision:'passed',at:now-1,reviewRevision:'revision'}];
  assert.equal(selectPanelRows(snapshot,session('audits',{filter:'chain'})).length,12);
  assert.equal(selectPanelRows(snapshot,session('audits',{filter:'passed'})).length,1);
  assert.match(renderPanel(snapshot,session('radar'),'en').text,/13\/13\/1/);
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

test('five-row pagination clamps after deletion and token buttons bind identities rather than ordinals',()=>{
  const snapshot=fixture(),result=renderPanel(snapshot,session('audits',{page:999}),'en');
  const buttons=result.keyboard.flat().filter(item=>item.token);
  assert.equal(buttons.length,3);assert.equal(buttons[0].token.address,snapshot.candidates[10].address);
  assert.match(result.text,/11–13 \/ 13/);
});

test('search precedes sorting and live top-15 truncation, with stable volume ties',()=>{
  const snapshot=fixture();snapshot.liveByChain.sol={rows:Array.from({length:25},(_,index)=>projectTelegramLiveRow({chain:'sol',address:'a'+index,symbol:index<20?'OTHER':'MATCH',priorityBand:true,volume1m:1,newAt:now-600_000}))};
  const selected=selectPanelRows(snapshot,session('feed',{search:'match'}));
  assert.equal(selected.length,5);assert.equal(selected[0].address,'a20');
  assert.equal(selectPanelRows(snapshot,session('feed',{sort:'new'})).length,0);
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
  const snapshot=fixture();snapshot.candidates=[candidate(0,{symbol:'<b>bad</b>',name:'gmgn_secret',info:{website:'https://user:password@example.com',twitter:'https://x.com/home'},gmgnUrl:'javascript:alert(1)'})];
  const result=renderPanel(snapshot,session('detail',{selectedToken:snapshot.candidates[0]}),'en');
  assert.ok(result.text.includes('&lt;b&gt;bad&lt;/b&gt;'));assert.ok(!result.text.includes('gmgn_secret'));
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

test('live collection controls and audit queue actions do not alter viewed or enabled chains',()=>{
  const snapshot=fixture();snapshot.live={subscribed:true,focusChain:'base'};snapshot.liveByChain.sol={lastSuccessAt:now,rows:[{...snapshot.candidates[0],auditEligible:true}]};
  const feed=renderPanel(snapshot,session('feed'),'en');assert.match(feed.text,/Collecting Base/);
  const collect=feed.keyboard.flat().find(item=>item.action==='live.set' && item.params.value);assert.equal(collect.params.chain,'sol');
  const detail=renderPanel(snapshot,session('detail',{selectedToken:snapshot.candidates[0],returnTo:{panel:'feed'}}),'en');assert.ok(actions(detail).includes('audit.enqueue'));
  snapshot.liveByChain.sol.lastSuccessAt=now-60_001;assert.ok(!actions(renderPanel(snapshot,session('detail',{selectedToken:snapshot.candidates[0],returnTo:{panel:'feed'}}))).includes('audit.enqueue'));
});

test('events split long logical pages without hiding events and link only resolvable tokens',()=>{
  const snapshot=fixture();snapshot.events=Array.from({length:15},(_,index)=>({at:now-index,chain:'sol',type:'CUSTOM',message:`event-${index} `+'long '.repeat(90)}));
  const seen=[];let page=0;
  while(true) { const result=renderPanel(snapshot,session('events',{page}),'en');seen.push(result.text);if(!result.keyboard.flat().some(item=>item.action==='page.set' && item.params.page===page+1)) break;page++; }
  for(let index=0;index<15;index++) assert.ok(seen.join('').includes(`event-${index} `));
});

test('onboarding in both languages states residual chat risk and renders only public PEM',()=>{
  for(const locale of ['zh','en']) {
    const snapshot=fixture();snapshot.onboarding={publicKey:'-----BEGIN PUBLIC KEY-----\nYWJj\n-----END PUBLIC KEY-----'};
    const result=renderPanel(snapshot,session('onboard'),locale);assert.ok(result.text.includes('PUBLIC KEY'));assert.ok(result.text.includes(locale==='en'?'cannot guarantee deletion':'无法保证删除'));
    snapshot.onboarding.publicKey='-----BEGIN PRIVATE KEY-----\nYWJj\n-----END PRIVATE KEY-----';assert.throws(()=>renderPanel(snapshot,session('onboard'),locale),/Invalid public/);
  }
});

test('export is all-chain and whitelist-only with original manual revision and sanitized annotations',()=>{
  const snapshot=fixture();snapshot.annotations=[{chain:'base',address:'0x'+'a'.repeat(40),favorite:true,note:'gmgn_secret',updatedAt:now,tenantId:'private'}];snapshot.marks=[{...snapshot.candidates[0],decision:'passed',at:now-1,reviewRevision:'revision',version:3}];snapshot.privateKey='private secret';
  const exported=createTelegramExport(snapshot),serialized=JSON.stringify(exported);
  assert.equal(Object.keys(exported.chains).length,7);assert.equal(exported.chains.base.annotations.length,1);assert.equal(exported.chains.sol.manualMarks[0].reviewRevision,'revision');assert.ok(!serialized.includes('gmgn_secret'));assert.ok(!serialized.includes('tenantId'));assert.ok(!serialized.includes('privateKey'));
});

test('statistics distinguish unavailable from empty and require all three windows for overall readiness',()=>{
  const snapshot=fixture();assert.match(renderPanel(snapshot,session('stats'),'en').text,/unavailable/);
  snapshot.stats={sol:{tracked:60,completed30m:50,completed1h:1,completed2h:49,completed24h:0,averageReturn30m:null,averageReturn1h:null,averageReturn2h:null,averageReturn24h:null,calibrationReady:false,coverage:{passed:{h6:{eligible:0,completed:0,missing:0,median:null,positiveRate:null}}}}};
  const summary=renderPanel(snapshot,session('stats'),'en');assert.match(summary.text,/30m Ready/);assert.match(summary.text,/Overall calibration gate: Not ready/);
  const detail=renderPanel(snapshot,session('stats',{horizon:'h6'}),'en');assert.match(detail.text,/0\/0\/0/);assert.match(detail.text,/No samples/);
});
