import assert from 'node:assert/strict';
import test from 'node:test';
import { renderPanel, selectPanelRows, PANEL_NAMES, HELP_COMMAND_NAMES, telegramCommandDescriptions, telegramCommandRegistrations } from '../src/bot/panels.mjs';
import { projectTelegramCandidate, projectTelegramFeedRow, createTelegramExport, safeTelegramUrl } from '../src/bot/snapshot.mjs';
import { CHART_RISK_VERSION, applyRiskExclusion } from '../src/scoring/chart-risk.mjs';
import { money, officialXUrl } from '../src/render/telegram.mjs';
import { aveTokenUrl } from '../src/providers/ave.mjs';

const now=1_800_000_000_000;
function candidate(index=0,changes={}) { return projectTelegramCandidate({ chain:'robinhood',address:'a'.repeat(32)+index,symbol:'COIN'+index,name:'Research token',status:'X_REVIEW',marketCap:20000+index,liquidity:8000,holders:0,auditedAt:now-60_000,reviewRevision:'revision',deep:{chainPass:true,chartRisk:{version:CHART_RISK_VERSION,pass:true},checks:{openSource:true,ownerRenounced:false},failed:[],unknownFields:[],blockingUnknownFields:[]},...changes }); }
function fixture() { return {at:now,control:{configured:true,paused:false,notifications:false,activeChain:'robinhood',scanChain:'robinhood'},candidates:Array.from({length:13},(_,index)=>candidate(index)),annotations:[],marks:[],events:[],queue:[],delivery:[],metrics:{},sourceHealth:{},feedByChain:{},ave:{cuUsed:0,blockedUntil:0,readyAt:0},outcomes:[]}; }
function session(panel='audits',query={}) { return {panel,viewChain:'robinhood',query,version:2}; }
const actions=result=>result.keyboard.flat().filter(item=>item.action).map(item=>item.action);

test('all native panels render both locales with bounded text and typed action descriptors',()=>{
  for(const locale of ['zh','en']) for(const panel of PANEL_NAMES) {
    const snapshot=fixture(), current=session(panel,{selectedToken:{chain:'robinhood',address:snapshot.candidates[0].address},outcome:'connected'});
    const result=renderPanel(snapshot,current,locale);
    assert.ok(result.text.length<=3500,`${panel} ${locale}`);
    assert.ok(result.keyboard.length,`${panel} has navigation`);
    for(const item of result.keyboard.flat()) assert.ok(item.url || typeof item.action==='string');
    assert.equal(result.version,2);
  }
});

test('the command menu lists the nine frequent commands in order, localized, and Help lists every command',()=>{
  const menu=['radar','leads','hot','watchlist','wallet','performance','status','settings','help'];
  for(const locale of ['zh','en']) {
    const commands=telegramCommandDescriptions(locale);
    assert.deepEqual(commands.map(item=>item.command),menu,locale);
    for(const {description} of commands) assert.ok(description.length>0&&description.length<=256,description);
  }
  assert.notDeepEqual(telegramCommandDescriptions('zh'),telegramCommandDescriptions('en'));
  assert.deepEqual(HELP_COMMAND_NAMES.slice(0,9),menu);
  for(const retired of ['audits','candidates','feed','saved','stats','events']) assert.ok(!HELP_COMMAND_NAMES.includes(retired),retired);
  for(const unlisted of ['start','activity','chains','pause','resume','mute','lang','note','cancel','export','onboard','setkey','disconnect']) assert.ok(HELP_COMMAND_NAMES.includes(unlisted),unlisted);
  for(const locale of ['zh','en']) {
    const commands=renderPanel(fixture(),session('help',{page:1}),locale).text;
    for(const command of HELP_COMMAND_NAMES) assert.match(commands,new RegExp(`/${command} — `),`${locale} ${command}`);
    assert.ok(commands.indexOf('/help — ')<commands.indexOf('/start — '),'menu commands come before the rest');
    assert.ok(!/<(?!\/?b>)/.test(commands),'argument placeholders are escaped, not raw HTML');
  }
});

test('command registration is English by default and Chinese only for zh clients',()=>{
  const registrations=telegramCommandRegistrations();
  assert.deepEqual(registrations.map(params=>params.language_code),[undefined,'zh','en']);
  for(const params of registrations) {
    assert.deepEqual(params.scope,{type:'all_private_chats'});
    assert.deepEqual(params.commands,telegramCommandDescriptions(params.language_code==='zh'?'zh':'en'),String(params.language_code));
  }
});

test('help is three pages: what the radar does, commands, then safety',()=>{
  const page=index=>renderPanel(fixture(),session('help',{page:index}),'en');
  assert.match(page(0).text,/^<b>❓ Help<\/b>\nThe radar reads the AVE hot list/);
  assert.match(page(1).text,/Menu commands[\s\S]*More commands/);
  assert.match(page(2).text,/cannot guarantee deletion[\s\S]*hot wallet[\s\S]*Manual approval does not change screening[\s\S]*Not investment advice/);
  assert.ok(!page(2).keyboard.flat().some(item=>item.action==='page.set'&&item.params.page===3));
});

// Panels whose content cannot change by re-reading: choices, confirmations, help, evidence
// pages, and the trading dialogs (in this fixture trading is off, so they are all static).
const STATIC_PANELS=new Set(['view_chain','filter','sort','language','horizon','cohort','chains','disconnect','help','connection','evidence','trade','trade_unverified','wallet','wallet_export','wallet_remove','trade_settings']);
// An alert is a message, not a place to navigate: it has no footer (its own tests cover it).
const NAVIGABLE_PANELS=PANEL_NAMES.filter(panel=>panel!=='alert');
test('every panel ends with the standard footer and keeps navigation out of its body',()=>{
  const home=item=>item.action==='panel.open'&&item.params.panel==='radar';
  const nav=item=>item.action==='panel.refresh'||item.action==='panel.back'||home(item);
  for(const locale of ['zh','en']) for(const panel of NAVIGABLE_PANELS) for(const returning of [false,true]) {
    const snapshot=fixture(), query={selectedToken:{chain:'robinhood',address:snapshot.candidates[0].address},outcome:'connected',...(returning?{returnTo:{panel:'audits',viewChain:'robinhood',query:{}}}:{})};
    const result=renderPanel(snapshot,session(panel,query),locale), label=`${panel} ${locale} ${returning}`;
    // Radar's footer leads with Settings, then the standard navigation.
    const footer=panel==='radar' ? result.keyboard.at(-1).slice(1) : result.keyboard.at(-1);
    if(panel==='radar') assert.equal(result.keyboard.at(-1)[0].params.panel,'settings',label);
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

// A destination's icon must name one place: a title or a panel.open button never
// reuses another panel's icon (Radar's 📡 once marked Sources too).
test('no icon leads to two different panels',()=>{
  const owners=new Map(),claim=(icon,panel,label)=>{ if(!owners.has(icon)) owners.set(icon,new Set());owners.get(icon).add(panel);assert.equal(owners.get(icon).size,1,`${icon} marks ${[...owners.get(icon)].join(' and ')} (${label})`); };
  const icon=text=>text.match(/^(\p{Extended_Pictographic}\S*) /u)?.[1];
  for(const locale of ['zh','en']) for(const panel of PANEL_NAMES) {
    const snapshot=fixture(),result=renderPanel(snapshot,session(panel,{selectedToken:{chain:'robinhood',address:snapshot.candidates[0].address},outcome:'connected'}),locale);
    const title=icon(result.text.match(/^<b>(.*?)<\/b>/)[1]);
    if(title) claim(title,panel,`${panel} title`);
    for(const item of result.keyboard.flat()) if(item.action==='panel.open'&&icon(item.text)) claim(icon(item.text),item.params.panel,`${panel} button ${item.text}`);
  }
  assert.ok(owners.get('🛜')?.has('sources')&&owners.get('📡')?.has('radar'));
});

test('audit filters use effective marks while overview keeps original on-chain candidate count',()=>{
  const snapshot=fixture();snapshot.marks=[{chain:'robinhood',address:snapshot.candidates[0].address,decision:'passed',at:now-1,reviewRevision:'revision'}];
  assert.equal(selectPanelRows(snapshot,session('audits',{filter:'chain'})).length,12);
  assert.equal(selectPanelRows(snapshot,session('audits',{filter:'passed'})).length,1);
  snapshot.candidates[1]={...snapshot.candidates[1],status:'LIVE_READY'};snapshot.candidates[2]={...snapshot.candidates[2],status:'HARD_REJECT'};
  assert.match(renderPanel(snapshot,session('radar'),'en').text,/Last 30 min: 1 lead · 1 vetoed/);
  assert.equal(selectPanelRows(snapshot,session('audits',{filter:'lead'})).length,1);
});

test('Leads lists every kept token whatever its age, the fresh cutoff is inclusive, and saved records survive evidence expiry',()=>{
  const snapshot=fixture();snapshot.candidates=[candidate(0,{auditedAt:now-1_800_000}),candidate(1,{auditedAt:now-6*3_600_000}),candidate(2,{auditedAt:now-300_000}),candidate(3,{auditedAt:now-300_001})];
  snapshot.annotations=[{chain:'base',address:'0x'+'a'.repeat(40),favorite:true,note:'Historical note',updatedAt:now}];
  assert.equal(selectPanelRows(snapshot,session()).length,4);
  assert.equal(selectPanelRows(snapshot,session('audits',{filter:'fresh'})).length,1);
  assert.equal(selectPanelRows(snapshot,{...session('saved'),viewChain:'all'}).length,1);
  const detail=renderPanel(snapshot,session('detail',{selectedToken:snapshot.annotations[0]}),'en');
  assert.match(detail.text,/no longer retained/);assert.ok(!actions(detail).includes('mark.set_passed'));
});

test('Leads finds alerted tokens and says when a kept lead is no longer live, and why in its detail',()=>{
  const snapshot=fixture();
  snapshot.candidates=[candidate(0,{status:'LIVE_READY',alertedAt:now-86_400_000,staleAt:now-1,metadata:{screenFailedAt:now-1,screenReasons:['市值超出范围']}}),candidate(1,{status:'LIVE_READY',staleAt:now-1}),candidate(2,{status:'LIVE_READY',staleAt:now+1})];
  assert.deepEqual(selectPanelRows(snapshot,session('audits',{filter:'alerted'})).map(row=>row.symbol),['COIN0']);
  const text=renderPanel(snapshot,session('audits',{sort:'score_desc'}),'en').text;
  assert.match(text,/COIN0<\/b> · [^\n]+ · 🔔\n[^\n]*no longer passes the screen\n/);
  assert.match(text,/COIN1<\/b>[^\n]*\n[^\n]*off the hot list\n/);
  assert.doesNotMatch(text,/COIN2<\/b>[^\n]*\n[^\n]*(off the hot list|no longer)/);
  assert.match(renderPanel(snapshot,session('detail',{selectedToken:snapshot.candidates[0]}),'en').text,/no longer passes the screen: 市值超出范围/);
});

test('the hot list states its read status, staleness and whether the chain is scanned, in both locales',()=>{
  for(const [status,zh,en] of [['AVE_RATE_LIMITED','AVE限流','AVE rate limited'],['AVE_QUOTA','AVE额度用完','AVE credits exhausted']]) {
    const snapshot=fixture();
    snapshot.feedByChain={robinhood:{rows:[],status,observedAt:now}};
    assert.match(renderPanel(snapshot,session('feed'),'zh').text,new RegExp(zh),status);
    assert.match(renderPanel(snapshot,session('feed'),'en').text,new RegExp(en),status);
  }
  const healthy=fixture();
  healthy.feedByChain={robinhood:{rows:[],status:'READY',observedAt:now}};
  assert.doesNotMatch(renderPanel(healthy,session('feed'),'en').text,/Read status|stale/);
  healthy.feedByChain.robinhood.observedAt=now-120_001;assert.match(renderPanel(healthy,session('feed'),'en').text,/Data stale/);
  healthy.control.scanChain='arc';assert.match(renderPanel(healthy,session('feed'),'en').text,/not being scanned/);
});

test('five-row pagination clamps after deletion and token buttons bind identities rather than ordinals',()=>{
  const snapshot=fixture(),result=renderPanel(snapshot,session('audits',{page:999}),'en');
  const buttons=result.keyboard.flat().filter(item=>item.token);
  assert.equal(buttons.length,3);assert.equal(buttons[0].token.address,snapshot.candidates[10].address);
  assert.match(result.text,/11–13 of 13/);
});

test('search precedes sorting and live top-15 truncation, with stable volume ties',()=>{
  const snapshot=fixture();snapshot.feedByChain.robinhood={rows:Array.from({length:25},(_,index)=>projectTelegramFeedRow({address:'a'+index,symbol:index<20?'OTHER':'MATCH',priorityBand:true,pass:index%2===0,volume5m:1,reasons:[]},'robinhood'))};
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

test('a lead detail links AVE only by our own token-page link, never a stored referral link, and offers no manual approval',()=>{
  const snapshot=fixture();
  const address='0x59a0d858b0825098b5218f08e09901381c25a57d';
  snapshot.candidates=[candidate(0,{address,status:'LIVE_READY',aveUrl:`https://pro.ave.ai/token/${address}-robinhood?ref=0001`})];
  const lead=renderPanel(snapshot,session('detail',{selectedToken:snapshot.candidates[0]}),'en');
  assert.deepEqual(lead.keyboard.flat().filter(item=>String(item.url).includes('ave.ai')).map(item=>item.url),[`https://ave.ai/token/${address}-robinhood`]);
  assert.doesNotMatch(lead.text,/Trade on AVE/);
  assert.match(lead.text,/Market lead/);assert.ok(!actions(lead).includes('mark.set_passed'));
});

test('the chain panel selects exactly one scan chain',()=>{
  const snapshot=fixture(),result=renderPanel(snapshot,session('chains'),'en');
  const choices=result.keyboard.flat().filter(item=>item.action==='chains.set');
  assert.deepEqual(choices.map(item=>item.params.value),['arc','bsc','base','eth','robinhood']);
  assert.equal(choices.filter(item=>item.text.startsWith('✓')).length,1);
});

test('events split long logical pages without hiding events and link only resolvable tokens',()=>{
  const snapshot=fixture();snapshot.events=Array.from({length:15},(_,index)=>({at:now-index,chain:'robinhood',type:'CUSTOM',message:`event-${index} `+'long '.repeat(90)}));
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

test('the AVE key panel holds only its own actions: open AVE Cloud, and Delete once connected',()=>{
  const snapshot=fixture();
  const connected=renderPanel(snapshot,session('onboard'),'en');
  assert.deepEqual(connected.keyboard.slice(0,-1).map(row=>row.map(item=>item.url ? 'url' : item.params.panel)),[['url','disconnect']]);
  assert.equal(connected.keyboard[0][1].text,'🗑️ Delete');
  assert.equal(renderPanel(snapshot,session('disconnect'),'en').keyboard[0][0].text,'🗑️ Delete key');
  snapshot.control.configured=false;
  assert.deepEqual(renderPanel(snapshot,session('onboard'),'en').keyboard.slice(0,-1).map(row=>row.length),[1]);
});

test('export is all-chain and whitelist-only with original manual revision and sanitized annotations',()=>{
  const snapshot=fixture();snapshot.annotations=[{chain:'base',address:'0x'+'a'.repeat(40),favorite:true,note:'api_key=secret',updatedAt:now,tenantId:'private'}];snapshot.marks=[{...snapshot.candidates[0],decision:'passed',at:now-1,reviewRevision:'revision',version:3}];snapshot.privateKey='private secret';
  const exported=createTelegramExport(snapshot),serialized=JSON.stringify(exported);
  assert.equal(Object.keys(exported.chains).length,5);assert.equal(exported.chains.base.annotations.length,1);assert.equal(exported.chains.robinhood.manualMarks[0].reviewRevision,'revision');assert.ok(!serialized.includes('api_key=secret'));assert.ok(!serialized.includes('tenantId'));assert.ok(!serialized.includes('privateKey'));
});

test('statistics distinguish unavailable from empty and require all three windows for overall readiness',()=>{
  const snapshot=fixture();assert.match(renderPanel(snapshot,session('stats'),'en').text,/unavailable/);
  snapshot.stats={robinhood:{tracked:60,completed30m:50,completed1h:1,completed2h:49,completed24h:0,calibrationReady:false,coverage:{passed:{h6:{eligible:0,completed:0,missing:0,median:null,positiveRate:null}}}}};
  const summary=renderPanel(snapshot,session('stats'),'en');assert.doesNotMatch(summary.text,/gate/);
  const coverage=renderPanel(snapshot,session('stats',{coverage:true}),'en');assert.match(coverage.text,/30 min Ready · 2 h Not ready · 24 h Not ready/);assert.match(coverage.text,/Overall calibration gate: Not ready/);
  const detail=renderPanel(snapshot,session('stats',{horizon:'h6'}),'en');assert.match(detail.text,/Due 0 · measured 0 · missing 0/);assert.match(detail.text,/No samples/);
});

test('evidence pages keep the exact audit time while the detail summary shows it relatively',()=>{
  const snapshot=fixture(),query={selectedToken:{chain:'robinhood',address:snapshot.candidates[0].address}};
  snapshot.candidates[0]={...snapshot.candidates[0],secondary:{...complete,checkedAt:now-60_000}};
  assert.match(renderPanel(snapshot,session('evidence',query),'en').text,/Audit: 2027-01-15 07:59:00 UTC · 1m ago/);
  const detail=renderPanel(snapshot,session('detail',query),'en').text;
  assert.match(detail,/· checked 1m ago\n/);assert.doesNotMatch(detail,/2027-01-15/);
});

const complete={status:'COMPLETE',complete:true,checkedAt:now-120_000,sources:{},market:{pairUrl:'https://dexscreener.com/solana/pair'},security:{complete:true,verdict:'NO_FATAL_FLAGS',fatal:[],unknownFields:[]},conflicts:[]};
const lead=(changes={})=>candidate(0,{status:'LIVE_READY',deep:{},...changes});
test('the safety verdict leads the detail and marks each list row, from the recorded check',()=>{
  const fatal=(fields,status='HARD_REJECT')=>lead({status,secondary:{...complete,security:{complete:true,verdict:'FATAL',fatal:fields.map(field=>({field})),unknownFields:[]}}});
  const degraded=security=>lead({secondary:{...complete,status:'DEGRADED',complete:false,...(security?{security}:{})}});
  const audited=deep=>candidate(0,{secondary:complete,deep:{chartRisk:{version:CHART_RISK_VERSION},chainPass:true,failed:[],unknownFields:[],blockingUnknownFields:[],...deep}});
  // [scenario, row, detail verdict line, list badge, lead caveat shown]
  const cases=[
    ['lead before its check',lead(),'⏳ Checking','⏳ Checking',true],
    ['candidate with no recorded check',candidate(0),'⏳ Checking','⏳ Checking',false],
    ['complete check without fatal flags',lead({secondary:complete}),'✅ No failures found · checked 2m ago','✅ No failures found',false],
    ['a website mismatch does not block',lead({secondary:{...complete,conflicts:[{type:'WEBSITE_MISMATCH',field:'website'}]}}),'✅ No failures found · checked 2m ago','✅ No failures found',false],
    ['incomplete GoPlus fields',degraded({complete:false,verdict:'UNKNOWN',fatal:[],unknownFields:['buyTax','sellTax']}),'⚠️ Needs review: 2 fields unknown · checked 2m ago','⚠️ Needs review',true],
    ['GoPlus check missing',degraded({complete:false,verdict:'UNKNOWN',fatal:[],unknownFields:['tokenSecurity']}),'⚠️ Needs review: GoPlus check unavailable · checked 2m ago','⚠️ Needs review',true],
    ['degraded market source only',degraded(),'⚠️ Needs review: check incomplete · checked 2m ago','⚠️ Needs review',true],
    ['one failed deep check',audited({failed:['tax']}),'⚠️ Needs review: 1 failed check · checked 2m ago','⚠️ Needs review',false],
    ['one blocking unknown',audited({unknownFields:['top10'],blockingUnknownFields:['top10']}),'⚠️ Needs review: 1 blocking unknown · checked 2m ago','⚠️ Needs review',false],
    ['failures, blocking and other unknowns together',audited({failed:['tax'],unknownFields:['top10','devHold','lockRate'],blockingUnknownFields:['top10']}),'⚠️ Needs review: 1 failed check, 1 blocking unknown, 2 fields unknown · checked 2m ago','⚠️ Needs review',false],
    ['conflicting sources after a complete check',lead({secondary:{...complete,conflicts:[{type:'MARKET_MISMATCH',field:'marketCap'}]}}),'⚠️ Needs review: 1 source conflict · checked 2m ago','⚠️ Needs review',false],
    ['secondary veto',fatal(['isHoneypot','hiddenOwner','mintable']),'⛔ Vetoed: Honeypot, Hidden owner +1 · checked 2m ago','⛔ Vetoed',false],
    ['fatal verdict before the status changes',fatal(['isHoneypot'],'LIVE_READY'),'⛔ Vetoed: Honeypot · checked 2m ago','⛔ Vetoed',false],
    ['held risk exclusion',applyRiskExclusion(lead({secondary:complete}),{['robinhood:'+'a'.repeat(32)+'0']:{reasons:['x'],codes:['VERTICAL_PLATEAU']}}),'⛔ Vetoed: Chart risk · checked 2m ago','⛔ Vetoed',false],
    ['veto reasons are escaped',fatal(['<x>']),'⛔ Vetoed: &lt;x&gt; · checked 2m ago','⛔ Vetoed',false]
  ];
  for(const [label,row,line,mark,caveat] of cases) {
    const snapshot=fixture();snapshot.candidates=[row];
    const detail=renderPanel(snapshot,session('detail',{selectedToken:row}),'en').text;
    assert.equal(detail.split('\n')[1],line,label);
    assert.ok(!detail.includes('<x>'),label);
    assert.match(renderPanel(snapshot,session('audits'),'en').text,new RegExp(`<b>1\\. COIN0</b> · ${mark}\n`),label);
    assert.equal(/Market lead: safety not yet verified/.test(detail),caveat,label);
  }
  const feedRow=projectTelegramFeedRow({address:'f'.repeat(32),symbol:'HOT',pass:true,reasons:[]},'robinhood');
  const snapshot=fixture();snapshot.candidates=[];snapshot.feedByChain.robinhood={rows:[feedRow]};
  assert.equal(renderPanel(snapshot,session('detail',{selectedToken:feedRow}),'zh').text.split('\n')[1],'⚠️ 未经安全核验','a hot-list row never checked');
});

test('a hot-list row shows its candidate safety badge, never ✅ for the market screen alone',()=>{
  const snapshot=fixture(),vetoed={...lead({status:'HARD_REJECT'}),address:'v'.repeat(32),symbol:'RUG'},fresh={...lead(),address:'l'.repeat(32),symbol:'NEWLEAD'};
  snapshot.candidates=[vetoed,fresh];
  snapshot.feedByChain.robinhood={observedAt:now-300_000,status:'READY',rows:[
    projectTelegramFeedRow({address:vetoed.address,symbol:'RUG',pass:true,priorityBand:true,volume5m:3,reasons:[]},'robinhood'),
    projectTelegramFeedRow({address:fresh.address,symbol:'NEWLEAD',pass:true,volume5m:2,reasons:[]},'robinhood'),
    projectTelegramFeedRow({address:'s'.repeat(32),symbol:'SCREENED',pass:true,volume5m:1,reasons:[]},'robinhood'),
    projectTelegramFeedRow({address:'r'.repeat(32),symbol:'LATE',pass:false,reasons:['上线不足5分钟']},'robinhood')]};
  for(const locale of ['en','zh']) assert.ok(!renderPanel(snapshot,session('feed'),locale).text.includes('✅'),locale);
  const text=renderPanel(snapshot,session('feed'),'en').text;
  assert.match(text,/<b>1\. RUG<\/b> · ⛔ Vetoed\n/);assert.match(text,/<b>2\. NEWLEAD<\/b> · ⏳ Checking\n/);
  assert.match(text,/<b>3\. SCREENED<\/b> · passed screen\n/);assert.match(text,/<b>4\. LATE<\/b> · 上线不足5分钟\n/);
  assert.match(text,/\n\nUpdated [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2} UTC · hot list read 5m ago$/);
});

test('the detail takes age and 5-minute facts from the hot list when the candidate lacks them',()=>{
  const snapshot=fixture(),row=lead({holders:undefined,marketCap:120000,liquidity:30000});snapshot.candidates=[row];
  snapshot.feedByChain.robinhood={rows:[projectTelegramFeedRow({address:row.address,symbol:'COIN0',holders:2431,createdAt:(now-18*60_000)/1000,volume5m:12000,priceChange5m:.35,reasons:[]},'robinhood')]};
  const lines=renderPanel(snapshot,session('detail',{selectedToken:row}),'en').text.split('\n');
  assert.equal(lines[2],'MC $120K · Liq $30K · 2,431 holders');assert.equal(lines[3],'18m old · 5m +35% · 5m vol $12K');
});

test('watchlist rows and the detail show watch state, and note-only rows say they were never checked',()=>{
  const snapshot=fixture(),watched=snapshot.candidates[0],noted={chain:'robinhood',address:'n'.repeat(32),favorite:false,note:'dev wallet',updatedAt:now-1};
  snapshot.annotations=[{chain:'robinhood',address:watched.address,favorite:true,note:'',updatedAt:now},noted];
  const text=renderPanel(snapshot,session('saved'),'en').text;
  assert.match(text,/<b>1\. COIN0<\/b> · ⏳ Checking\nRobinhood · ⭐\n/);
  assert.match(text,/<b>2\. \?<\/b> · ⚠️ Not checked\nRobinhood · <code>nnnnnnnnnnnn<\/code> · 📝 dev wallet\n/);
  const label=selected=>renderPanel(snapshot,session('detail',{selectedToken:selected}),'en').keyboard.flat().find(item=>item.action==='favorite.set').text;
  assert.equal(label(watched),'⭐ Unwatch');assert.equal(label(noted),'⭐ Watch');
});

test('list headers print only the chain and the state the owner changed',()=>{
  const snapshot=fixture(),header=result=>result.text.split('\n')[1];
  assert.equal(header(renderPanel(snapshot,session('audits'),'en')),'Robinhood');
  assert.equal(header(renderPanel(snapshot,session('audits',{filter:'all',sort:'audit_desc'}),'en')),'Robinhood');
  assert.equal(header(renderPanel(snapshot,session('audits',{filter:'fresh',sort:'market_desc',search:'coin'}),'en')),'Robinhood · Filter: Last 5 min · Sort: Market cap ↓ · Search: &quot;coin&quot;');
  assert.equal(header(renderPanel(snapshot,session('feed',{sort:'priority'}),'en')),'Robinhood');
  assert.equal(header(renderPanel(snapshot,session('feed',{sort:'volume'}),'zh')),'Robinhood · 排序: 5分钟成交额');
});

test('list, activity and detail panels fit the text budget with maximum-length rows in both languages',()=>{
  const wide='<'.repeat(500),symbol='&'.repeat(30),rows=Array.from({length:10},(_,index)=>candidate(index,{symbol,deep:{chartRisk:{version:CHART_RISK_VERSION},failed:Array(32).fill('<'),unknownFields:Array(48).fill('<'),blockingUnknownFields:Array(48).fill('<')},secondary:{...complete,security:{verdict:'FATAL',fatal:Array(20).fill({field:wide}),unknownFields:[]}},status:'HARD_REJECT'}));
  const snapshot=fixture();snapshot.candidates=rows;
  snapshot.annotations=rows.map(row=>({chain:'robinhood',address:row.address,favorite:true,note:wide,updatedAt:now}));
  snapshot.marks=rows.map(row=>({chain:'robinhood',address:row.address,decision:'ignored',at:now,reviewRevision:'revision',version:1}));
  snapshot.events=rows.map((row,index)=>({at:now-index,chain:'robinhood',address:row.address,type:index%2?'CANDIDATE_NEW':'CUSTOM',message:wide}));
  snapshot.feedByChain.robinhood={observedAt:now-1_000_000,status:'AVE_RATE_LIMITED',receivedCount:100,leadCount:10,rows:rows.map(row=>projectTelegramFeedRow({address:row.address,symbol,marketCap:-1.23e12,createdAt:1,volume5m:9.99e14,priceChange5m:-4.99,reasons:[wide.slice(0,120)]},'robinhood'))};
  for(const locale of ['zh','en']) for(const panel of ['audits','feed','saved','events','detail']) for(const search of ['a'.repeat(32),wide.slice(0,128)]) {
    const result=renderPanel(snapshot,session(panel,{search,selectedToken:rows[0]}),locale);
    assert.ok(result.text.length<=3500,`${panel} ${locale}`);
    if(search.startsWith('a')&&['audits','feed','saved'].includes(panel)) assert.equal(result.keyboard.flat().filter(item=>item.token).length,5,`${panel} ${locale} shows a full page`);
  }
});

test('the token detail links only what exists, with the chart from DexScreener, and no unavailable-link notice',()=>{
  const snapshot=fixture(),row=lead({secondary:complete,info:{twitter:'@coin',website:''}});snapshot.candidates=[row];
  const result=renderPanel(snapshot,session('detail',{selectedToken:row}),'en'),links=result.keyboard.find(line=>line.some(item=>item.action==='panel.open'&&item.params.panel==='evidence'));
  assert.deepEqual(links.map(item=>item.url||item.text),['https://x.com/coin','https://dexscreener.com/solana/pair','🔎 Evidence']);
  assert.doesNotMatch(result.text,/unavailable|Manual approval does not change/);
  snapshot.candidates=[lead()];
  assert.deepEqual(renderPanel(snapshot,session('detail',{selectedToken:row}),'en').keyboard.flat().filter(item=>item.url),[]);
});

test('selectors lay out two choices per row, time windows three, and only the chain selector explains itself',()=>{
  const snapshot=fixture(),choices=result=>result.keyboard.slice(0,-1).map(row=>row.length);
  assert.deepEqual(choices(renderPanel(snapshot,session('view_chain',{returnTo:{panel:'saved'}}),'en')),[2,2,2]);
  assert.deepEqual(choices(renderPanel(snapshot,session('horizon'),'en')),[3,3,1]);
  assert.deepEqual(renderPanel(snapshot,session('cohort'),'en').keyboard[0].map(item=>item.text),['✓ Passed the screen','Vetoed control']);
  assert.match(renderPanel(snapshot,session('view_chain'),'en').text,/^<b>[^<]+<\/b>\nViewing a chain does not change what is scanned\.\n\nUpdated/);
  for(const panel of ['filter','sort','language','horizon','cohort']) assert.match(renderPanel(snapshot,session(panel),'en').text,/^<b>[^<]+<\/b>\n\nUpdated/,panel);
});

test('activity rows name the token and what happened in plain words',()=>{
  const snapshot=fixture(),address=snapshot.candidates[0].address;
  snapshot.events=[{at:now-240_000,chain:'robinhood',address,type:'CANDIDATE_NEW',message:'COIN0：新市场线索，安全性待核验'},{at:now-300_000,chain:'robinhood',address:'b'.repeat(32),type:'RISK_WORSENED',message:'?'}];
  const result=renderPanel(snapshot,session('events'),'en');
  assert.match(result.text,/\n1\. 4m ago · 🆕 COIN0 — new lead\n2\. 5m ago · ⛔ bbbbbb…bbbb — failed the safety check\n/);
  assert.doesNotMatch(result.text,/新市场线索/);
  assert.match(renderPanel(snapshot,{...session('events'),viewChain:'all'},'en').text,/4m ago · Robinhood · 🆕 COIN0/);
});

test('performance leads with the median return of screen passes in plain words',()=>{
  const snapshot=fixture(),cell=(median,completed)=>({eligible:completed+3,completed,missing:3,median,positiveRate:null});
  snapshot.stats={robinhood:{tracked:40,calibrationReady:false,coverage:{passed:{m30:cell(.042,37),h1:cell(-.5,1),h2:cell(null,0),h24:cell(null,0)}}}};
  const text=renderPanel(snapshot,session('stats'),'en').text;
  assert.match(text,/Tokens that passed the screen, 30 min later: median \+4\.2% \(37 tokens\)\n1 h later: median -50% \(1 token\)\n2 h later: no samples yet/);
  assert.match(text,/Shadow observations; not executable returns\./);
});

const panelRows=result=>result.keyboard.slice(0,-1).map(row=>row.map(item=>item.action==='panel.open'?item.params.panel:item.action));

test('radar leads with the newest leads on the scan chain, vetoed last, and leaves operator counters to Status',()=>{
  const snapshot=fixture();
  snapshot.metrics={scanCount:7,discoveredCount:40,prequalifiedCount:12};
  snapshot.candidates=[
    // PEPE first qualified 25 min ago and was rechecked just now; DOGE2 is the newer lead.
    candidate(0,{symbol:'PEPE',status:'LIVE_READY',auditedAt:now-1000,metadata:{qualifiedAt:now-1_500_000},marketCap:120_000,createdAt:(now-240_000)/1000}),
    candidate(1,{symbol:'DOGE2',status:'LIVE_READY',auditedAt:now-30_000,metadata:{qualifiedAt:now-60_000},marketCap:undefined}),
    candidate(2,{symbol:'RUGME',status:'HARD_REJECT',auditedAt:now-1000}),
    candidate(3,{symbol:'OLD',status:'LIVE_READY',auditedAt:now-1_800_001}),
    candidate(4,{symbol:'REVIEW',status:'X_REVIEW',auditedAt:now-1000}),
    {...candidate(5,{symbol:'ELSEWHERE',status:'LIVE_READY',auditedAt:now-1000}),chain:'base'}
  ];
  snapshot.feedByChain={robinhood:{rows:[projectTelegramFeedRow({address:snapshot.candidates[0].address,symbol:'PEPE',priceChange5m:.35},'robinhood')]}};
  // The radar shows the scan chain even when the session last viewed another one.
  const result=renderPanel(snapshot,{...session('radar'),viewChain:'base'},'en');
  assert.equal(result.text,'<b>📡 Radar · Robinhood</b>\n🟢 Scanning · 🔕 Alerts off\n\nLast 30 min: 2 leads · 1 vetoed\n1. <b>DOGE2</b>\n2. <b>PEPE</b> · $120K · 4m old · +35%\n3. ⛔ RUGME · vetoed\n\nUpdated Jan 15 08:00 UTC');
  // Lead buttons go two to a row; an odd last one takes the full row.
  assert.deepEqual(result.keyboard.slice(0,2).map(row=>row.map(item=>item.token.address)),[[1,0],[2]].map(row=>row.map(index=>snapshot.candidates[index].address)));
  assert.deepEqual(panelRows(result).slice(2),[['audits','feed'],['saved','stats'],['wallet','status']]);
  assert.deepEqual(result.keyboard.at(-1).map(item=>item.params?.panel ?? item.action),['settings','panel.refresh'],'Settings sits left of Refresh');
  const status=renderPanel(snapshot,session('status'),'en').text;
  assert.match(status,/Successful scans: 7\n/);assert.match(status,/Last cycle discovered\/prefilter passed: 40\/12\n/);
  snapshot.candidates=[];
  const empty=renderPanel(snapshot,session('radar'),'en');
  assert.match(empty.text,/\n\nNo leads in the last 30 min\. The radar checks the hot list every ~15s\.\n/);
  assert.deepEqual(panelRows(empty),[[],['audits','feed'],['saved','stats'],['wallet','status']].filter(row=>row.length));
});

test('radar names each failing discovery source and its reason, and nothing when all are healthy',()=>{
  const snapshot=fixture();snapshot.candidates=[];
  snapshot.sourceHealth={discovery:{trending:{ok:true,count:100},newPools:{ok:false,code:'ONCHAIN_HTTP_403'},watch:{ok:true,count:3},promoted:{ok:false,code:null}}};
  const failing=renderPanel(snapshot,session('radar'),'en').text;
  assert.match(failing,/\n🟢 Scanning · 🔕 Alerts off\n⚠️ New pools on chain: ONCHAIN_HTTP_403\n⚠️ New pools screened: Unknown\n\nNo leads/);
  snapshot.sourceHealth.discovery.newPools={ok:true,count:0};snapshot.sourceHealth.discovery.promoted={ok:true,count:0};
  assert.doesNotMatch(renderPanel(snapshot,session('radar'),'en').text,/⚠️/);
});

test('radar says why nothing arrives when scanning is paused or AVE is disconnected',()=>{
  const paused=fixture();paused.candidates=[];paused.control.paused=true;
  const pausedText=renderPanel(paused,session('radar'),'en').text;
  assert.match(pausedText,/\n⏸️ Paused · 🔕 Alerts off\n\nNo leads in the last 30 min\. Scanning is paused\.\n/);assert.doesNotMatch(pausedText,/checks the hot list/);
  // Disconnected with history: the radar still shows records but says it is not connected.
  const disconnected=fixture();disconnected.control.configured=false;disconnected.candidates=[candidate(0,{status:'LIVE_READY',auditedAt:now-1_800_001})];
  const disconnectedText=renderPanel(disconnected,session('radar'),'en').text;
  assert.match(disconnectedText,/\n🔌 Not connected · 🔕 Alerts off\n\nNo leads in the last 30 min\. AVE is not connected\.\n/);
  disconnected.candidates[0]={...disconnected.candidates[0],auditedAt:now-1000};
  assert.match(renderPanel(disconnected,session('radar'),'zh').text,/\n🔌 未连接AVE · 🔕 提醒关闭\n\n近30分钟：1 条线索/);
});

test('settings groups state first and its own actions below; Status sits on Radar and deleting the key under AVE key',()=>{
  const snapshot=fixture();snapshot.control.notifications=true;snapshot.trading={chains:['arc'],settings:{slippageBps:500,capUsd:100}};
  const connected=renderPanel(snapshot,session('settings'),'en');
  assert.equal(connected.text,'<b>⚙️ Settings</b>\nScanning: 🟢 Robinhood\nAlerts: 🔔 On\nTrading: slippage 5% · cap $100\nLanguage: English\nAVE: connected\n\nUpdated Jan 15 08:00 UTC');
  assert.deepEqual(panelRows(connected),[['chains'],['notifications.set','scan.pause'],['trade_settings','language'],['onboard','export.create']]);
  assert.deepEqual(connected.keyboard[1].map(item=>item.text),['🔕 Mute','⏸️ Pause']);
  assert.equal(connected.keyboard[0][0].text,'🔗 Scan chain: Robinhood');assert.equal(connected.keyboard[3][0].text,'🔑 AVE key');
  Object.assign(snapshot.control,{configured:false});delete snapshot.trading;
  const disconnected=renderPanel(snapshot,session('settings'),'en');
  assert.match(disconnected.text,/Scanning: 🔌 Waiting for AVE · Robinhood\n.*\nTrading: not enabled on this deployment\n[\s\S]*AVE: not connected/);
  Object.assign(snapshot.control,{configured:true,paused:true});
  const paused=renderPanel(snapshot,session('settings'),'zh');
  assert.match(paused.text,/扫描: ⏸️ 已暂停 · Robinhood/);assert.deepEqual(panelRows(paused)[1],['notifications.set','scan.resume']);assert.deepEqual(paused.keyboard[1].map(item=>item.text),['🔕 关闭提醒','🟢 恢复']);
});

test('status links Activity, Sources and Delivery and flags delivery issues',()=>{
  const snapshot=fixture();
  const result=renderPanel(snapshot,session('status'),'en');
  assert.match(result.text,/^<b>📊 Status<\/b>\n🟢 Scanning · Robinhood\n/);
  assert.deepEqual(panelRows(result),[['events','sources','delivery']]);
  assert.match(result.text,/\nDelivery issues: 0/);
  snapshot.delivery=[{status:'FAILED',purpose:'USER_RESPONSE'}];
  assert.match(renderPanel(snapshot,session('status'),'en').text,/\n⚠️ Delivery issues: 1/);
});

test('first run welcomes a new owner with what the radar does, two steps, a key link, help and the other language',()=>{
  const fresh=fixture();fresh.control={configured:false,paused:false,notifications:true,activeChain:'arc',scanChain:'arc'};fresh.candidates=[];
  const en=renderPanel(fresh,session('radar'),'en');
  assert.match(en.text,/^<b>👋 AlphaMeme radar<\/b>\nWatches the Arc hot list for new meme tokens, checks their safety and alerts you\.\n\nStep 1 · Get a free AVE Data API key\nStep 2 · Send \/setkey &lt;key&gt;\nYour key is read-only; it can never trade\. Delete the key message afterwards\.\n\nUpdated /);
  assert.deepEqual(en.keyboard.map(row=>row.map(item=>item.url ?? `${item.action}:${item.params.panel ?? item.params.value ?? ''}`)),[['https://cloud.ave.ai/login','panel.open:help'],['language.set:zh'],['panel.refresh:']]);
  assert.deepEqual(en.keyboard.flat().map(item=>item.text).slice(0,3),['🔑 Get AVE key','❓ How it works','🌐 中文']);
  const zh=renderPanel(fresh,session('radar'),'zh');
  assert.match(zh.text,/^<b>👋 AlphaMeme 雷达<\/b>\n盯住 Arc 热榜/);
  assert.deepEqual(zh.keyboard[1].map(item=>[item.text,item.params.value]),[['🌐 English','en']]);
  // Records from an earlier connection keep the ordinary radar, which says AVE is not connected.
  fresh.candidates=[candidate(0)];
  assert.doesNotMatch(renderPanel(fresh,session('radar'),'en').text,/AlphaMeme/);
});

test('a key submission answers with a panel: connected shows the scan, a failure says why and offers another try',()=>{
  const snapshot=fixture();snapshot.control={configured:true,paused:false,notifications:true,activeChain:'arc',scanChain:'arc'};
  const connected=renderPanel(snapshot,session('connection',{outcome:'connected'}),'en');
  assert.match(connected.text,/^<b>✅ AVE connected<\/b>\n🟢 Scanning Arc · 🔔 Alerts on\nDelete your key message if it is still visible\.\n/);
  assert.deepEqual(connected.keyboard.map(row=>row.map(item=>[item.text,item.params.panel])),[[['🔗 Change chain','chains']],[['🏠 Home','radar']]]);
  snapshot.control.paused=true;
  assert.match(renderPanel(snapshot,session('connection',{outcome:'connected'}),'zh').text,/^<b>✅ AVE已连接<\/b>\n⏸️ 已暂停 · Arc · 🔔 提醒开启\n/);
  for(const [query,reason] of [[{outcome:'failed',reason:'AVE_AUTH'},/^AVE rejected the key\.$/m],[{outcome:'failed',reason:'AVE_UPSTREAM'},/^AVE is temporarily unavailable\.$/m],
    [{outcome:'failed',reason:'AVE_RATE_LIMITED',retryAt:now+90_000},/^AVE rate limited the request\. Try again after \d\d:\d\d:\d\d UTC\.$/m],[{outcome:'failed',reason:'AVE_RATE_LIMITED',retryAt:now-1},/^AVE rate limited the request\.$/m],
    [{outcome:'failed',reason:'toString'},/^Connection failed or expired\.$/m],[{outcome:'failed',reason:null},/^Connection failed or expired\.$/m],[{outcome:'invalid'},/^That is not a valid AVE API key\.$/m]]) for(const configured of [true,false]) {
    snapshot.control.configured=configured;
    const result=renderPanel(snapshot,session('connection',query),'en'),label=JSON.stringify(query);
    assert.match(result.text,query.outcome==='invalid' ? /^<b>Key not valid<\/b>/ : /^<b>Key not verified<\/b>/,label);
    assert.match(result.text,reason,label);
    assert.match(result.text,configured ? /Your previous connection is unchanged\./ : /AVE is not connected\./,label);
    assert.match(result.text,/Delete your key message if it is still visible\./);
    assert.deepEqual(result.keyboard[0].map(item=>[item.text,item.params.panel]),[['🔑 Try again','onboard']]);
    assert.ok(!renderPanel(snapshot,session('connection',query),'zh').text.includes('Delete'));
  }
  for(const outcome of [undefined,'toString','rejected']) assert.throws(()=>renderPanel(snapshot,session('connection',{outcome}),'en'),/connection outcome/);
});

test('a session notice leads any panel as one escaped warning line',()=>{
  for(const panel of ['radar','audits','settings','wallet','detail']) {
    const snapshot=fixture(),result=renderPanel(snapshot,session(panel,{selectedToken:{chain:'robinhood',address:snapshot.candidates[0].address},notice:'Above your <b>$100</b> cap.'}),'en');
    assert.match(result.text,/^⚠️ Above your &lt;b&gt;\$100&lt;\/b&gt; cap\.\n\n<b>/,panel);
  }
  assert.doesNotMatch(renderPanel(fixture(),session('radar'),'en').text,/⚠️/);
});

test('the AVE token page is built from the chain and address, and left out when AVE has no id for it',()=>{
  const evm='0x59a0d858b0825098b5218f08e09901381c25a57d';
  assert.equal(aveTokenUrl('arc',evm),'https://ave.ai/token/0x59a0d858b0825098b5218f08e09901381c25a57d-arc');
  for(const [chain,id] of [['bsc','bsc'],['base','base'],['eth','eth'],['robinhood','robinhood']]) assert.equal(aveTokenUrl(chain,evm.toUpperCase().replace('0X','0x')),`https://ave.ai/token/${evm}-${id}`,chain);
  for(const [chain,address] of [['stable',evm],['arc','not-an-address'],['sol',evm],['constructor',evm]]) assert.equal(aveTokenUrl(chain,address),'',`${chain} ${address}`);
});

test('the token detail link row reads X, Site, Chart, AVE, then Evidence',()=>{
  const snapshot=fixture();
  snapshot.candidates=[candidate(0,{address:'0x59a0d858b0825098b5218f08e09901381c25a57d',info:{website:'https://coin.example',twitter:'coin'},secondary:{status:'COMPLETE',market:{pairUrl:'https://dexscreener.com/robinhood/pair',websites:[]},security:{verdict:'NO_FATAL_FLAGS'},conflicts:[]}})];
  const detail=renderPanel(snapshot,session('detail',{selectedToken:snapshot.candidates[0]}),'en');
  const row=detail.keyboard.find(items=>items.some(item=>item.url?.startsWith('https://ave.ai/')));
  assert.deepEqual(row.map(item=>item.text),['𝕏','🌐 Site','📊 Chart','🔭 AVE','🔎 Evidence']);
  assert.equal(row[3].url,'https://ave.ai/token/0x59a0d858b0825098b5218f08e09901381c25a57d-robinhood');
});

// A pasted token's lookup as the snapshot projects it.
function lookup(changes={}) { return {chain:'arc',address:'0x'+'cd'.repeat(20),state:'DETAILS',startedAt:now-5_000,reason:null,symbol:'',name:'',price:null,marketCap:null,liquidity:null,holders:null,createdAt:null,priceChange5m:null,volume5m:null,capturedAt:null,verdict:'PENDING',stale:false,secondary:null,veto:null,failedStep:null,...changes}; }
const lookupDetail=(changes,snapshotChanges={})=>{ const snapshot={...fixture(),...snapshotChanges},row=lookup(changes);snapshot.lookups=[row];return renderPanel(snapshot,{...session('detail',{selectedToken:{chain:row.chain,address:row.address}}),viewChain:row.chain},'en'); };
const chainButtons=result=>result.keyboard.flat().filter(item=>item.action==='lookup.start'&&!item.params.retry).map(item=>item.token.chain);

test('a running lookup shows its progress, or the wait for AVE capacity, with the AVE link and no chain buttons',()=>{
  const running=lookupDetail({});
  assert.match(running.text,/^<b>\? · Arc<\/b>\n⏳ Looking up on Arc…\n<code>0x(cd){20}<\/code>/);
  assert.deepEqual(chainButtons(running),[]);
  assert.ok(running.keyboard.flat().some(item=>item.url===`https://ave.ai/token/0x${'cd'.repeat(20)}-arc`));
  assert.match(lookupDetail({},{ave:{cuUsed:0,blockedUntil:now+60_000,readyAt:now+60_000}}).text,/⏳ Waiting for AVE capacity/);
  // Only the AVE step waits on admission.
  assert.match(lookupDetail({state:'GOPLUS',symbol:'LOOK',marketCap:50_000,capturedAt:now-20_000},{ave:{cuUsed:0,blockedUntil:now+60_000,readyAt:now+60_000}}).text,/⏳ Looking up on Arc…\nMC \$50K[\s\S]*AVE · 20s ago/);
});

test('a lookup AVE did not find, or that failed, offers the other EVM chains; only a failure offers Retry',()=>{
  const others=['bsc','base','eth','robinhood'];
  const missing=lookupDetail({state:'NOT_FOUND'});
  assert.match(missing.text,/⚠️ AVE has no token at this address on Arc\./);
  assert.deepEqual(chainButtons(missing),others);assert.ok(!missing.keyboard.flat().some(item=>item.params?.retry));
  const failed=lookupDetail({state:'FAILED',reason:'AVE_SCHEMA',failedStep:'DETAILS'});
  assert.match(failed.text,/⚠️ Lookup failed: AVE returned an answer it could not be read from/);
  assert.deepEqual(chainButtons(failed),others);assert.ok(failed.keyboard.flat().some(item=>item.action==='lookup.start'&&item.params.retry===true&&item.token.chain==='arc'));
});

test('a finished lookup shows the shared verdict; a vetoed one keeps selling but offers no buy',()=>{
  const fatal={status:'DEGRADED',checkedAt:now-60_000,market:{pairUrl:'https://dexscreener.com/arc/pair',websites:[]},security:{verdict:'FATAL',fatal:[{field:'honeypot'}],unknownFields:[]},conflicts:[]};
  const trading={chains:['arc'],wallet:{address:'0x'+'11'.repeat(20)},settings:{capUsd:100,slippageBps:500}};
  const result=lookupDetail({state:'DONE',verdict:'VETOED',secondary:fatal},{trading});
  assert.match(result.text,/⛔ Vetoed: Honeypot · checked 1m ago/);
  assert.ok(!actions(result).includes('trade.buy'));assert.ok(actions(result).includes('trade.sell'));
  assert.ok(result.keyboard.flat().some(item=>item.url==='https://dexscreener.com/arc/pair'));
  const passed=lookupDetail({state:'DONE',verdict:'PASSED',secondary:{...fatal,status:'COMPLETE',security:{verdict:'NO_FATAL_FLAGS',fatal:[],unknownFields:[]}}},{trading});
  assert.match(passed.text,/✅ No failures found/);assert.ok(actions(passed).includes('trade.buy'));
});


test('a clean lookup past its freshness keeps its verdict but says the check is stale, and still offers Buy',()=>{
  const trading={chains:['arc'],wallet:{address:'0x'+'11'.repeat(20)},settings:{capUsd:100,slippageBps:500}};
  const secondary={status:'COMPLETE',checkedAt:now-20*60_000,market:{websites:[]},security:{verdict:'NO_FATAL_FLAGS',fatal:[],unknownFields:[]},conflicts:[]};
  const render=(stale,locale='en')=>{ const snapshot={...fixture(),trading},row=lookup({state:'DONE',verdict:'PASSED',secondary,stale});snapshot.lookups=[row];return renderPanel(snapshot,{...session('detail',{selectedToken:{chain:row.chain,address:row.address}}),viewChain:row.chain},locale); };
  assert.match(render(true).text,/✅ No failures found · checked 20m ago · stale, paste the address again to re-check\n/);
  assert.match(render(true,'zh').text,/✅ 未发现问题 · 20分钟前核验 · 已过期，重新粘贴地址即可重新核验\n/);
  assert.match(render(false).text,/✅ No failures found · checked 20m ago\n/);
  assert.ok(actions(render(true)).includes('trade.buy'));
});

test('a candidate whose lookup is vetoed shows no buy, as the engine refuses one',()=>{
  const snapshot=fixture(),row=snapshot.candidates[0];
  snapshot.trading={chains:['robinhood'],wallet:{address:'0x'+'11'.repeat(20)},settings:{capUsd:100,slippageBps:500}};
  const detail=()=>renderPanel(snapshot,session('detail',{selectedToken:row}),'en');
  assert.ok(actions(detail()).includes('trade.buy'));
  snapshot.lookups=[lookup({chain:row.chain,address:row.address,state:'DONE',verdict:'VETOED',veto:{checkedAt:now,fields:['honeypot']}})];
  assert.ok(!actions(detail()).includes('trade.buy'));assert.ok(actions(detail()).includes('trade.sell'));
});

test('a lookup that failed after AVE confirmed the token names the check and offers only Retry',()=>{
  for(const [failedStep,check] of [['DEXSCREENER','DexScreener'],['GOPLUS','GoPlus']]) {
    const failed=lookupDetail({state:'FAILED',reason:'SCHEDULER_LEASE_EXPIRED',failedStep,symbol:'LOOK',marketCap:50_000,capturedAt:now});
    assert.match(failed.text,new RegExp(`⚠️ Lookup failed: the ${check} check did not finish`),failedStep);
    assert.deepEqual(chainButtons(failed),[],failedStep);
    assert.ok(failed.keyboard.flat().some(item=>item.action==='lookup.start'&&item.params.retry===true),failedStep);
  }
});
