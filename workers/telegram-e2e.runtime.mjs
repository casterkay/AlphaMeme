import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe,it,expect,vi } from 'vitest';
import { TelegramRuntime } from '../src/bot/runtime.mjs';
import { CHART_RISK_VERSION } from '../src/scoring/chart-risk.mjs';
import { readAveApiKey } from '../src/auth/connection.mjs';
import { AVE_CU, AveError } from '../src/providers/ave.mjs';
import { readSchedulerStateInTransaction } from '../src/storage/scheduler-state.mjs';

const at=1_800_000_000_000;
const masterKey={activeVersion:'1',keys:{'1':'e2e-only-master-key'}};
const apiKey='ave-e2e-api-key-0001';
const request=operation=>operation({signal:new AbortController().signal,timeoutMs:1000});
const WBNB='0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const WBNB_DETAILS_URL=`https://prod.ave-api.com/v2/tokens/${WBNB}-bsc`;
const wbnbDetails={status:1,data:{token:{token:WBNB,chain:'bsc',symbol:'WBNB',current_price_usd:'600'},pairs:[]}};
const jsonResponse=value=>new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});
const schedulerTasks=(storage,tenantId)=>readSchedulerStateInTransaction(storage,tenantId).tasks;

// A hand-written AVE endpoint: records each request's URL and key, never touches the network.
// Building a real Request applies the Workers runtime's option checks, which a bare stub would skip.
function aveStub(respond) {
  const calls=[];
  return {calls,fetch:async(url,init)=>{const request=new Request(url,init);calls.push({url:request.url,apiKey:request.headers.get('X-API-KEY')});return respond(request.url);}};
}

async function withRuntime(tenantId,operation) {
  const radar=env.RADAR.get(env.RADAR.idFromName(`telegram-e2e:${tenantId}`));
  return runInDurableObject(radar,async(_instance,{storage})=>{
    let update=0,message=100;
    // Tests that need time to pass move clock.now; everything else runs at `at`.
    const clock={now:at};
    const runtime=new TelegramRuntime({storage,tenantId,env:{MASTER_ENC_KEY:masterKey,AVE_MONTHLY_CU:env.AVE_MONTHLY_CU,AVE_CU_RESET_DAY:env.AVE_CU_RESET_DAY},now:()=>clock.now});
    const sent=[];
    runtime.outbox.transport=async input=>{
      sent.push(structuredClone({method:input.method,params:input.params}));
      return {ok:true,result:input.method==='sendMessage'?{message_id:++message}:input.method==='editMessageText'?{message_id:Number(input.params.message_id)}:true};
    };
    const receipt=(commandType,payload,overrides={})=>({tenantId,actorUserId:tenantId,updateId:String(++update),commandType,payload,dueAt:clock.now+60_000,messageDate:clock.now/1000,sourceMessageId:String(1000+update),locale:'zh',...overrides});
    const drain=async()=>{
      for(let count=0;count<100;count++) {
        const tasks=storage.transactionSync(()=>runtime.outbox.reconcileInTransaction());
        const task=tasks.find(task=>task.dueAt<=clock.now);
        if(!task) return;
        await runtime.outbox.deliverOne(task.id.slice('outbox:'.length),{request});
      }
      throw new Error('Outbox failed to converge after 100 deterministic deliveries');
    };
    const command=async(name,args='')=>{
      const input=receipt(`command:${name}`,{source:'message',arguments:args});
      runtime.receive(input);await runtime.runCommand(input.updateId);await drain();return input;
    };
    const sessions=()=>storage.sql.exec('SELECT id FROM ui_sessions WHERE tenant_id=? ORDER BY rowid',tenantId).toArray().map(row=>runtime.commands.sessions.get(row.id));
    const link=(session,action,predicate=()=>true)=>{
      const rows=storage.sql.exec('SELECT * FROM shortlinks WHERE tenant_id=? AND ui_session_id=? AND expected_ui_version=? AND action=?',tenantId,session.id,session.version,action).toArray();
      const found=rows.find(row=>predicate(JSON.parse(row.params_json),row));
      if(!found) throw new Error(`Missing ${action} in ${session.panel} v${session.version}`);
      return found;
    };
    const click=async(binding,overrides={})=>{
      const input=receipt('callback',{callbackId:binding.id,callbackQueryId:`query-${update+1}`},{sourceMessageId:binding.origin_message_id,...overrides});
      runtime.receive(input);await runtime.answerCallback(input);await runtime.runCommand(input.updateId);await drain();return input;
    };
    const seed=(count=1)=>{
      for(let index=0;index<count;index++) storage.sql.exec('INSERT INTO candidates (tenant_id,chain,address,symbol,status,audited_at,review_revision,deep_json) VALUES (?,?,?,?,?,?,?,?)',tenantId,'arc',`0x${index.toString(16).padStart(40,'a')}`,`TOKEN${index}`,'X_REVIEW',at-1000,`revision-${index}`,JSON.stringify({chainPass:true,chartRisk:{version:CHART_RISK_VERSION},checks:{openSource:true},failed:[],unknownFields:[]}));
    };
    await operation({runtime,storage,tenantId,sent,receipt,drain,command,sessions,link,click,seed,clock});
  });
}

describe('Telegram complete command and delivery flows',()=>{
  it('RadarAgent acknowledges a callback only after durable receipt and alarm scheduling without waiting for command execution',async()=>{
    const tenantId='22911',radar=env.RADAR.get(env.RADAR.idFromName(`telegram-e2e:${tenantId}`));
    await runInDurableObject(radar,async(instance,{storage})=>{
      const previousToken=instance.env.TELEGRAM_BOT_TOKEN;
      instance.env.TELEGRAM_BOT_TOKEN='test-only-telegram-token';
      let release,acknowledgment;
      const gate=new Promise(resolve=>{release=resolve;});
      const original=TelegramRuntime.prototype.answerCallback;
      const answerSpy=vi.spyOn(TelegramRuntime.prototype,'answerCallback').mockImplementation(function(receipt) {
        acknowledgment=original.call(this,receipt);return acknowledgment;
      });
      const fetchSpy=vi.spyOn(globalThis,'fetch').mockImplementation(async(url,options)=>{
        expect(String(url)).toContain('/answerCallbackQuery');
        expect(JSON.parse(options.body)).toEqual({callback_query_id:'immediate-query'});
        expect(storage.sql.exec('SELECT status FROM inbox WHERE tenant_id=? AND update_id=?',tenantId,'1').one()).toEqual({status:'RECEIVED'});
        expect(await storage.getAlarm()).not.toBeNull();
        await gate;
        return new Response(JSON.stringify({ok:true,result:true}),{status:200});
      });
      try {
        const now=Date.now();
        const response=await instance.receiveTelegramUpdate({tenantId,actorUserId:tenantId,updateId:'1',commandType:'callback',payload:{callbackId:'expired-shortlink',callbackQueryId:'immediate-query'},dueAt:now+60_000,messageDate:Math.floor(now/1000),sourceMessageId:'100',locale:'zh'});
        expect(response.accepted).toBe(true);expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(storage.sql.exec('SELECT status FROM inbox WHERE tenant_id=?',tenantId).one().status).toBe('RECEIVED');
        expect(storage.sql.exec('SELECT id FROM outbox WHERE tenant_id=?',tenantId).toArray()).toEqual([]);
        release();await acknowledgment;
      } finally {release();await acknowledgment;fetchSpy.mockRestore();answerSpy.mockRestore();instance.env.TELEGRAM_BOT_TOKEN=previousToken;}
    });
  });

  it('binds independent root messages, edits the originating panel, and rejects stale and cross-owner callbacks',async()=>{
    await withRuntime('22901',async({runtime,storage,tenantId,sent,command,sessions,link,click,seed,receipt})=>{
      seed(7);await command('radar');await command('leads');
      const [overview,audits]=sessions();
      expect(overview.messageId).not.toBe(audits.messageId);expect(overview.panel).toBe('radar');expect(audits.panel).toBe('audits');
      const next=link(audits,'page.set',params=>params.page===1),oldDetail=link(audits,'panel.open',params=>params.panel==='detail');
      await click(next);
      const after=runtime.commands.sessions.get(audits.id);
      expect(after.query.page).toBe(1);expect(after.messageId).toBe(audits.messageId);expect(runtime.commands.sessions.get(overview.id).version).toBe(0);
      expect(sent.filter(row=>row.method==='editMessageText').at(-1).params.message_id).toBe(audits.messageId);
      const stale=await click(oldDetail);expect(runtime.inbox.get(stale.updateId).status).toBe('FAILED');expect(runtime.commands.sessions.get(audits.id).panel).toBe('audits');
      const current=link(after,'panel.open',params=>params.panel==='detail');
      const forged=receipt('callback',{callbackId:current.id,callbackQueryId:'wrong-owner'},{actorUserId:'99999',sourceMessageId:after.messageId});
      expect(()=>runtime.receive(forged)).toThrow('owner mismatch');expect(runtime.inbox.get(forged.updateId)).toBeNull();
      expect(storage.sql.exec('SELECT COUNT(*) AS count FROM manual_marks WHERE tenant_id=?',tenantId).one().count).toBe(0);
      expect(sent.some(row=>row.method==='answerCallbackQuery')).toBe(true);
    });
  });

  it('approves, clears and annotates through a delivered ForceReply without changing panel identity or losing favorites',async()=>{
    await withRuntime('22902',async({runtime,storage,tenantId,sent,command,sessions,link,click,seed,receipt,drain})=>{
      seed();await command('leads');const audits=sessions()[0];
      await click(link(audits,'panel.open',params=>params.panel==='detail'));
      let detail=runtime.commands.sessions.get(audits.id);expect(detail.messageId).toBe(audits.messageId);
      const pass=link(detail,'mark.set_passed');await click(pass);
      expect(storage.sql.exec('SELECT decision,mark_version FROM manual_marks WHERE tenant_id=?',tenantId).one()).toEqual({decision:'passed',mark_version:1});
      const duplicate=await click(pass);expect(runtime.inbox.get(duplicate.updateId).status).toBe('FAILED');
      detail=runtime.commands.sessions.get(audits.id);await click(link(detail,'mark.clear'));
      expect(storage.sql.exec('SELECT decision,mark_version FROM manual_marks WHERE tenant_id=?',tenantId).one()).toEqual({decision:null,mark_version:2});
      detail=runtime.commands.sessions.get(audits.id);await click(link(detail,'favorite.set',params=>params.value===true));
      detail=runtime.commands.sessions.get(audits.id);await click(link(detail,'note.begin'));
      const pending=runtime.commands.sessions.get(audits.id);
      expect(pending.messageId).toBe(audits.messageId);expect(pending.query.pendingInput.promptMessageId).not.toBe(pending.messageId);
      expect(sent.find(row=>String(row.params.reply_markup?.force_reply)==='true')).toBeTruthy();
      const reply=receipt('reply',{source:'reply',text:'Reviewed official comments',replyToMessageId:pending.query.pendingInput.promptMessageId});
      runtime.receive(reply);await runtime.runCommand(reply.updateId);await drain();
      expect(storage.sql.exec('SELECT favorite,note FROM annotations WHERE tenant_id=?',tenantId).one()).toEqual({favorite:1,note:'Reviewed official comments'});
      expect(runtime.commands.sessions.get(audits.id).query.pendingInput).toBeUndefined();expect(runtime.commands.sessions.get(audits.id).messageId).toBe(audits.messageId);
      const replay=receipt('reply',{source:'reply',text:'Late overwrite',replyToMessageId:pending.query.pendingInput.promptMessageId});
      runtime.receive(replay);await runtime.runCommand(replay.updateId);expect(runtime.inbox.get(replay.updateId).status).toBe('FAILED');
      expect(storage.sql.exec('SELECT note FROM annotations WHERE tenant_id=?',tenantId).one().note).toBe('Reviewed official comments');
      expect(storage.sql.exec('SELECT message_id FROM message_map WHERE tenant_id=?',tenantId).one().message_id).toBe(audits.messageId);
    });
  });

  it('resolves an exact symbol before substring matches and shows candidates in an ambiguous note picker',async()=>{
    await withRuntime('22906',async({runtime,command,sessions,seed,link,click})=>{
      seed(12);await command('note','TOKEN1');
      const exact=sessions()[0];
      expect(exact.panel).toBe('detail');expect(exact.query.pendingInput.kind).toBe('note');
      expect(exact.query.selectedToken.address).toBe(`0x${'1'.padStart(40,'a')}`);
      await command('note','TOKEN');
      const picker=sessions().at(-1);
      const rows=runtime.outbox.rows().filter(row=>row.ui_session_id===picker.id);
      const keyboard=runtime.outbox.payload(rows.at(-1)).params.reply_markup.inline_keyboard.flat();
      expect(keyboard.some(button=>button.text.includes('TOKEN0'))).toBe(true);
      expect(keyboard.some(button=>button.text.includes('TOKEN1'))).toBe(true);
      await click(link(picker,'note.select',(_params,row)=>row.address===`0x${'0'.padStart(40,'a')}`));
      const selected=runtime.commands.sessions.get(picker.id);
      expect(selected.panel).toBe('detail');expect(selected.query.pendingInput.kind).toBe('note');expect(selected.query.pendingInput.promptMessageId).toBeTruthy();
      expect(selected.query.pendingInput.target.address).toBe(`0x${'0'.padStart(40,'a')}`);
    });
  });

  it('scopes reply cancellation to one prompt and leaves the independent prompt usable',async()=>{
    await withRuntime('22907',async({runtime,storage,tenantId,command,sessions,receipt,drain,seed})=>{
      seed(2);await command('note','TOKEN0');await command('note','TOKEN1');
      const [first,second]=sessions();
      const cancel=receipt('command:cancel',{source:'message',arguments:'',replyToMessageId:first.query.pendingInput.promptMessageId});
      runtime.receive(cancel);await runtime.runCommand(cancel.updateId);await drain();
      expect(runtime.commands.sessions.get(first.id).query.pendingInput).toBeUndefined();
      expect(runtime.commands.sessions.get(second.id).query.pendingInput.promptMessageId).toBe(second.query.pendingInput.promptMessageId);
      const reply=receipt('reply',{source:'reply',text:'Second prompt survives',replyToMessageId:second.query.pendingInput.promptMessageId});
      runtime.receive(reply);await runtime.runCommand(reply.updateId);await drain();
      expect(storage.sql.exec('SELECT address,note FROM annotations WHERE tenant_id=?',tenantId).toArray()).toEqual([{address:second.query.selectedToken.address,note:'Second prompt survives'}]);
    });
  });

  it('rejects obsolete notification and scan-chain controls from independently current sessions',async()=>{
    await withRuntime('22908',async({runtime,command,sessions,link,click})=>{
      await command('settings');const oldSettings=sessions()[0],disable=link(oldSettings,'notifications.set',params=>params.value===false);
      await command('mute');await command('mute');
      const obsoleteNotifications=await click(disable);
      expect(runtime.inbox.get(obsoleteNotifications.updateId).status).toBe('FAILED');expect(runtime.notifications.controls().enabled).toBe(true);
      expect(runtime.commands.sessions.get(oldSettings.id).version).toBe(oldSettings.version);
      await command('chains');const oldChains=sessions().at(-1),toRobinhood=link(oldChains,'chains.set',params=>params.value==='robinhood');
      await command('chains');await click(link(sessions().at(-1),'chains.set',params=>params.value==='bsc'));
      expect(runtime.control.snapshot().activeChain).toBe('bsc');
      const obsoleteChain=await click(toRobinhood);
      expect(runtime.inbox.get(obsoleteChain.updateId).status).toBe('FAILED');expect(runtime.control.snapshot().activeChain).toBe('bsc');
    });
  });

  it('starts with alerts on and toggles them with /mute, answering with the settings panel',async()=>{
    await withRuntime('22923',async({runtime,command,sent,drain})=>{
      expect(runtime.notifications.controls().enabled).toBe(true);
      await command('mute');await drain();
      expect(runtime.notifications.controls().enabled).toBe(false);
      expect(sent.at(-1).params.text).toContain('提醒: 🔕 已关闭');
      await command('mute');await drain();
      expect(runtime.notifications.controls().enabled).toBe(true);expect(sent.at(-1).params.text).toContain('提醒: 🔔 已开启');
      await command('unmute');
      expect(runtime.notifications.controls().enabled).toBe(true);
      expect(runtime.commands.preference('notificationsVersion',0)).toBe(2);
    });
  });

  it('normalizes all-chain navigation before collection and preserves pending alerts',async()=>{
    await withRuntime('22915',async({runtime,storage,tenantId,sent,command,sessions,link,click,seed,drain})=>{
      seed();
      storage.sql.exec('INSERT INTO annotations (tenant_id,chain,address,favorite,note,updated_at) VALUES (?,?,?,?,?,?)',tenantId,'robinhood','0x'+'c'.repeat(40),1,'saved',at);
      await command('watchlist');
      const saved=sessions()[0];expect(saved.viewChain).toBe('all');
      await click(link(saved,'panel.open',params=>params.panel==='radar'));
      const home=runtime.commands.sessions.get(saved.id);expect(home.viewChain).toBe('arc');
      await click(link(home,'panel.open',params=>params.panel==='feed'));
      const feed=runtime.commands.sessions.get(saved.id);expect(feed.viewChain).toBe('arc');

      await command('mute');await command('mute');
      storage.sql.exec('INSERT INTO candidates (tenant_id,chain,address,symbol,status,audited_at,stale_at,review_revision) VALUES (?,?,?,?,?,?,?,?)',tenantId,'arc','0x'+'d'.repeat(40),'ALERT','LIVE_READY',at,at+600_000,'alert-revision');
      expect(runtime.notifications.controls()).toEqual({enabled:true,chains:['arc']});
      expect(runtime.notifications.candidates().find(row=>row.symbol==='ALERT')?.qualified).toBe(true);
      storage.transactionSync(()=>runtime.reconcileNotificationsInTransaction());
      expect(runtime.outbox.rows().some(row=>row.delivery_class==='ACTION_REQUIRED'&&row.status==='PENDING')).toBe(true);
      await command('hot');await drain();
      expect(runtime.outbox.rows().some(row=>row.delivery_class==='ACTION_REQUIRED'&&row.status==='CANCELLED')).toBe(false);
      expect(sent.some(row=>row.params.text?.includes('ALERT'))).toBe(true);
    });
  });

  it('opens token controls and restores the alert keyboard in place without replacing the alert text',async()=>{
    await withRuntime('22941',async({runtime,storage,tenantId,sent,sessions,link,click,drain})=>{
      runtime.commands.setPreference('language','en');
      storage.transactionSync(()=>runtime.reconcileNotificationsInTransaction());
      const pepe='0x'+'e'.repeat(40),bare='0x'+'f'.repeat(40);
      const lead=(address,symbol,marketCap,liquidity,createdAt)=>storage.sql.exec('INSERT INTO candidates (tenant_id,chain,address,symbol,status,market_cap,liquidity,created_at,audited_at,stale_at,review_revision,secondary_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',tenantId,'arc',address,symbol,'LIVE_READY',marketCap,liquidity,createdAt,at,at+600_000,`lead-${symbol}`,'null');
      lead(pepe,'PEPE',120_400,30_100,(at-4*60_000)/1000);
      lead(bare,'BARE',null,null,null);
      storage.sql.exec('INSERT INTO scheduler_state (tenant_id,key,value_json) VALUES (?,?,?)',tenantId,'feed.snapshot:arc',JSON.stringify({rows:[{address:pepe.toUpperCase().replace('0X','0x'),priceChange5m:0.35}]}));
      storage.transactionSync(()=>runtime.reconcileNotificationsInTransaction());await drain();
      const alerts=sent.filter(row=>row.params.text?.includes('New lead'));
      expect(alerts.map(row=>row.params.text.split('\n').slice(0,2))).toEqual([['<b>🆕 New lead · PEPE · Arc</b>','$120K MC · $30.1K liq · 4m old · 5m +35%'],['<b>🆕 New lead · BARE · Arc</b>','⏳ Checking']]);
      expect(alerts[0].params.reply_markup.inline_keyboard.map(row=>row.map(button=>button.text))).toEqual([['Open PEPE'],['🎯 All leads','🔕 Mute alerts']]);
      const alert=sessions().find(session=>session.panel==='alert'&&session.query.selectedToken.address===pepe),before=sent.length;
      const projectionKey=`telegram.rendered:${alert.messageId}`;
      const projectionBefore=storage.sql.exec('SELECT value_json FROM scheduler_state WHERE tenant_id=? AND key=?',tenantId,projectionKey).one().value_json;
      storage.sql.exec("UPDATE candidates SET review_revision='lead-clean',secondary_json=? WHERE tenant_id=? AND address=?",JSON.stringify({status:'COMPLETE',security:{verdict:'NO_FATAL_FLAGS',fatal:[]},conflicts:[]}),tenantId,pepe);
      await click(link(alert,'panel.open',(params,row)=>params.panel==='detail'&&row.address===pepe));
      expect(storage.sql.exec('SELECT value_json FROM scheduler_state WHERE tenant_id=? AND key=?',tenantId,projectionKey).one().value_json).toBe(projectionBefore);
      expect(sent.slice(before).map(row=>row.method).filter(method=>method!=='answerCallbackQuery')).toEqual(['editMessageReplyMarkup']);
      const controls=sent.at(-1);
      expect(controls.params).toMatchObject({message_id:alert.messageId});
      expect(controls.params.text).toBeUndefined();
      const detail=runtime.commands.sessions.get(alert.id);
      expect(detail).toMatchObject({panel:'alert',version:alert.version+1,query:{tokenControls:true,selectedToken:{chain:'arc',address:pepe},returnTo:{panel:'alert'}}});
      expect(sessions()).toHaveLength(2);
      const oldFavorite=link(detail,'favorite.set');
      storage.sql.exec("UPDATE candidates SET review_revision='lead-veto',secondary_json=? WHERE tenant_id=? AND address=?",JSON.stringify({status:'COMPLETE',security:{verdict:'FATAL',fatal:['HONEYPOT']},conflicts:[]}),tenantId,pepe);
      storage.transactionSync(()=>runtime.reconcileCardsInTransaction());await drain();
      expect(sent.at(-1)).toMatchObject({method:'editMessageText',params:{message_id:alert.messageId}});
      expect(sent.at(-1).params.text).toContain('PEPE failed the safety check');
      expect(sent.at(-1).params.reply_markup.inline_keyboard.flat().some(button=>button.text==='⬅️ Back')).toBe(true);
      await click(link(runtime.commands.sessions.get(alert.id),'panel.back'));
      expect(sent.at(-1)).toMatchObject({method:'editMessageReplyMarkup',params:{message_id:alert.messageId}});
      expect(sent.at(-1).params.text).toBeUndefined();
      expect(sent.at(-1).params.reply_markup.inline_keyboard.map(row=>row.map(button=>button.text))).toEqual([['Open PEPE'],['🎯 All leads','🔕 Mute alerts']]);
      expect(runtime.commands.sessions.get(alert.id).query.tokenControls).toBeUndefined();
      const stale=await click(oldFavorite);
      expect(runtime.inbox.get(stale.updateId)).toMatchObject({status:'FAILED'});
      expect(storage.sql.exec('SELECT COUNT(*) AS n FROM annotations WHERE tenant_id=?',tenantId).one().n).toBe(0);
    });
  });

  it('still alerts when recorded facts are unreadable, showing only the plain columns',async()=>{
    await withRuntime('22944',async({runtime,storage,tenantId,sent,drain})=>{
      runtime.commands.setPreference('language','en');
      storage.transactionSync(()=>runtime.reconcileNotificationsInTransaction());
      storage.sql.exec('INSERT INTO candidates (tenant_id,chain,address,symbol,status,market_cap,audited_at,stale_at,review_revision,secondary_json) VALUES (?,?,?,?,?,?,?,?,?,?)',tenantId,'arc','0x'+'1'.repeat(40),'ODD','LIVE_READY',50_000,at,at+600_000,'lead-odd','{');
      storage.sql.exec('INSERT INTO scheduler_state (tenant_id,key,value_json) VALUES (?,?,?)',tenantId,'feed.snapshot:arc','{');
      storage.transactionSync(()=>runtime.reconcileNotificationsInTransaction());await drain();
      expect(sent.find(row=>row.params.text?.includes('New lead')).params.text.split('\n').slice(0,3)).toEqual(['<b>🆕 New lead · ODD · Arc</b>','$50K MC','⏳ Checking']);
    });
  });

  it('edits the alert in place when its checks finish, and a veto adds a short notice replying to it',async()=>{
    await withRuntime('22945',async({runtime,storage,tenantId,sent,drain})=>{
      runtime.commands.setPreference('language','en');
      // The runtime's reconcile order: correct shown cards, then send new notifications.
      const reconcile=()=>storage.transactionSync(()=>{runtime.reconcileCardsInTransaction();runtime.reconcileNotificationsInTransaction();});
      storage.transactionSync(()=>runtime.reconcileNotificationsInTransaction());
      const address='0x'+'7'.repeat(40);
      storage.sql.exec('INSERT INTO candidates (tenant_id,chain,address,symbol,status,market_cap,audited_at,stale_at,review_revision,secondary_json) VALUES (?,?,?,?,?,?,?,?,?,?)',tenantId,'arc',address,'WAGMI','LIVE_READY',50_000,at,at+600_000,'lead-1','null');
      reconcile();await drain();
      const alert=sent.find(row=>row.params.text?.includes('New lead · WAGMI')),messageId=sent.indexOf(alert)+101;
      const clean={status:'COMPLETE',security:{verdict:'NO_FATAL_FLAGS',fatal:[]},conflicts:[]};
      storage.sql.exec("UPDATE candidates SET review_revision='lead-2',secondary_json=? WHERE tenant_id=? AND address=?",JSON.stringify(clean),tenantId,address);
      reconcile();await drain();
      const passed=sent.at(-1);
      expect(passed).toMatchObject({method:'editMessageText',params:{message_id:String(messageId)}});
      expect(passed.params.text.split('\n')[2]).toBe('✅ No failures found');
      const fatal={status:'COMPLETE',security:{verdict:'FATAL',fatal:[{field:'isHoneypot'}],fields:{isHoneypot:true}},conflicts:[]};
      storage.sql.exec("UPDATE candidates SET status='HARD_REJECT',review_revision='veto-1',secondary_json=? WHERE tenant_id=? AND address=?",JSON.stringify(fatal),tenantId,address);
      storage.sql.exec('INSERT INTO events (tenant_id,id,at,type,chain,address) VALUES (?,?,?,?,?,?)',tenantId,'risk-1',at+1,'RISK_WORSENED','arc',address);
      const before=sent.length;
      reconcile();await drain();
      const after=sent.slice(before);
      expect(after.find(row=>row.method==='editMessageText').params.text.split('\n')[0]).toBe('<b>⛔ WAGMI failed the safety check · Arc</b>');
      const notice=after.find(row=>row.method==='sendMessage');
      expect(notice.params.text).toBe(['<b>⛔ WAGMI failed the safety check · Arc</b>','GoPlus flagged: Honeypot: Yes','Buying is blocked; selling still works.'].join('\n'));
      expect(notice.params.reply_parameters).toEqual({message_id:messageId,allow_sending_without_reply:true});
      storage.sql.exec('DELETE FROM candidates WHERE tenant_id=? AND address=?',tenantId,address);
      const settled=sent.length;reconcile();await drain();
      expect(sent.length).toBe(settled);
    });
  });

  it('keeps an alert\'s buttons working through its edits and past the ordinary panel lifetime, until the alert expires',async()=>{
    await withRuntime('22946',async({runtime,storage,tenantId,sent,sessions,link,click,drain,clock})=>{
      runtime.commands.setPreference('language','en');
      storage.transactionSync(()=>runtime.reconcileNotificationsInTransaction());
      const address='0x'+'8'.repeat(40);
      storage.sql.exec('INSERT INTO candidates (tenant_id,chain,address,symbol,status,market_cap,audited_at,stale_at,review_revision,secondary_json) VALUES (?,?,?,?,?,?,?,?,?,?)',tenantId,'arc',address,'LATER','LIVE_READY',50_000,at,at+600_000,'lead-1','null');
      storage.transactionSync(()=>runtime.reconcileNotificationsInTransaction());await drain();
      const alert=sessions().find(session=>session.panel==='alert'),open=link(alert,'panel.open',params=>params.panel==='detail');
      // A finished check edits the alert; the buttons already on screen keep working.
      storage.sql.exec("UPDATE candidates SET review_revision='lead-2',secondary_json=? WHERE tenant_id=? AND address=?",JSON.stringify({status:'COMPLETE',security:{verdict:'NO_FATAL_FLAGS',fatal:[]},conflicts:[]}),tenantId,address);
      storage.transactionSync(()=>runtime.reconcileCardsInTransaction());
      expect(runtime.commands.sessions.get(alert.id).version).toBe(alert.version+1);
      clock.now=at+16*60_000;
      storage.transactionSync(()=>runtime.commands.sessions.pruneInTransaction());
      const opened=await click(open);
      expect(runtime.inbox.get(opened.updateId).status).toBe('DONE');
      expect(runtime.commands.sessions.get(alert.id)).toMatchObject({panel:'alert',query:{tokenControls:true,selectedToken:{chain:'arc',address}}});
      clock.now=at+7*24*60*60_000+1;
      storage.transactionSync(()=>runtime.commands.sessions.pruneInTransaction());
      expect(storage.sql.exec('SELECT COUNT(*) AS n FROM message_map WHERE tenant_id=? AND ui_session_id=?',tenantId,alert.id).one().n).toBe(0);
      const expired=await click(open);
      expect(runtime.inbox.get(expired.updateId)).toMatchObject({status:'FAILED'});
    });
  });

  it('mutes from an alert even after the controls changed since it was sent',async()=>{
    await withRuntime('22947',async({runtime,storage,tenantId,sessions,link,click,drain,command})=>{
      runtime.commands.setPreference('language','en');
      storage.transactionSync(()=>runtime.reconcileNotificationsInTransaction());
      storage.sql.exec('INSERT INTO candidates (tenant_id,chain,address,symbol,status,market_cap,audited_at,stale_at,review_revision,secondary_json) VALUES (?,?,?,?,?,?,?,?,?,?)',tenantId,'arc','0x'+'9'.repeat(40),'MUTE','LIVE_READY',50_000,at,at+600_000,'lead-1','null');
      storage.transactionSync(()=>runtime.reconcileNotificationsInTransaction());await drain();
      const alert=sessions().find(session=>session.panel==='alert');
      await command('mute');await command('mute');
      expect(runtime.notifications.controls().enabled).toBe(true);
      await click(link(alert,'notifications.set',params=>params.value===false));
      expect(runtime.notifications.controls().enabled).toBe(false);
      expect(sessions().at(-1).panel).toBe('settings');
    });
  });

  it('sends an unusable-key alert whose button opens the reconnect panel',async()=>{
    await withRuntime('22943',async({runtime,storage,tenantId,sent,sessions,link,click,drain})=>{
      runtime.commands.setPreference('language','en');
      storage.sql.exec('INSERT INTO scheduler_state (tenant_id,key,value_json) VALUES (?,?,?)',tenantId,'telegram.providerAuth',JSON.stringify({keyEpoch:runtime.control.snapshot().keyEpoch,unusable:true}));
      storage.transactionSync(()=>runtime.reconcileNotificationsInTransaction());await drain();
      const alert=sent.find(row=>row.params.text?.includes('AVE key'));
      expect(alert.params.text).toBe('<b>🔑 Your AVE key stopped working</b>');
      expect(alert.params.reply_markup.inline_keyboard.map(row=>row.map(button=>button.text))).toEqual([['🔑 Reconnect AVE']]);
      const session=sessions().at(-1);
      await click(link(session,'panel.open',params=>params.panel==='onboard'));
      expect(runtime.commands.sessions.get(session.id).panel).toBe('notice');
      expect(sessions().at(-1).panel).toBe('onboard');
    });
  });

  it('schedules card correction only for an actual future review expiry',async()=>{
    await withRuntime('22916',async({runtime,storage,tenantId,command,sessions,link,click,seed})=>{
      seed();await command('leads');const audits=sessions()[0];
      await click(link(audits,'panel.open',params=>params.panel==='detail'));
      expect(storage.transactionSync(()=>runtime.reconcileCardsInTransaction())).toBeNull();
      const detail=runtime.commands.sessions.get(audits.id);
      await click(link(detail,'mark.set_passed'));
      expect(storage.transactionSync(()=>runtime.reconcileCardsInTransaction())).toBe(at-1000+600_001);
    });
  });

  it('acknowledges a delivery issue from the status panel',async()=>{
    await withRuntime('22917',async({runtime,storage,command,sessions,link,click})=>{
      storage.transactionSync(()=>runtime.outbox.enqueueInTransaction({id:'failed-panel',chatId:'22917',method:'sendMessage',params:{text:'failed'},expiresAt:at+60_000}));
      storage.sql.exec("UPDATE outbox SET status='FAILED' WHERE tenant_id=? AND id=?",'22917','failed-panel');
      await command('status');const status=sessions()[0];
      await click(link(status,'panel.open',params=>params.panel==='delivery'));
      const delivery=runtime.commands.sessions.get(status.id);
      await click(link(delivery,'delivery.acknowledge'));
      expect(runtime.outbox.issues()).toEqual([]);
      expect(runtime.commands.sessions.get(status.id).panel).toBe('delivery');
    });
  });

  it('Home returns to the Radar root without a stale path back',async()=>{
    await withRuntime('22931',async({runtime,command,sessions,link,click,seed})=>{
      seed(3);await command('leads');const root=sessions()[0];
      await click(link(root,'panel.open',params=>params.panel==='detail'));
      await click(link(runtime.commands.sessions.get(root.id),'panel.open',params=>params.panel==='radar'));
      const home=runtime.commands.sessions.get(root.id);expect(home.panel).toBe('radar');expect(home.query.returnTo).toBeUndefined();
      expect(()=>link(home,'panel.back')).toThrow();
    });
  });

  it('opens a panel for every menu and unlisted command and answers retired slugs with Help',async()=>{
    await withRuntime('22963',async({command,sessions})=>{
      const panels={radar:'radar',start:'radar',leads:'audits',hot:'feed',watchlist:'saved',wallet:'wallet',performance:'stats',settings:'settings',help:'help',activity:'events',status:'status',chains:'chains',onboard:'onboard'};
      for(const [slug,panel] of Object.entries(panels)) {
        const before=sessions().length;await command(slug);
        expect(sessions().length,slug).toBe(before+1);expect(sessions().at(-1).panel,slug).toBe(panel);
        expect(sessions().at(-1).viewChain,slug).toBe(['saved','events'].includes(panel)?'all':'arc');
      }
      for(const slug of ['audits','candidates','feed','saved','stats','events','constructor']) {
        await command(slug);expect(sessions().at(-1).panel,slug).toBe('help');
      }
    });
  });

  it('Home returns to the scan chain after a list viewed another chain',async()=>{
    await withRuntime('22964',async({runtime,command,sessions,link,click})=>{
      await command('leads');const root=sessions()[0];
      await click(link(root,'panel.open',params=>params.panel==='view_chain'));
      await click(link(runtime.commands.sessions.get(root.id),'view_chain.set',params=>params.value==='bsc'));
      expect(runtime.commands.sessions.get(root.id)).toMatchObject({panel:'audits',viewChain:'bsc'});
      await click(link(runtime.commands.sessions.get(root.id),'panel.open',params=>params.panel==='radar'));
      expect(runtime.commands.sessions.get(root.id)).toMatchObject({panel:'radar',viewChain:'arc'});
    });
  });

  it('opens the Watchlist and Activity buttons on every chain, as their commands do',async()=>{
    await withRuntime('22965',async({runtime,command,sessions,link,click,seed})=>{
      seed();await command('radar');const radar=sessions()[0];
      await click(link(radar,'panel.open',params=>params.panel==='saved'));
      expect(runtime.commands.sessions.get(radar.id)).toMatchObject({panel:'saved',viewChain:'all'});
      await command('status');const status=sessions()[1];
      await click(link(status,'panel.open',params=>params.panel==='events'));
      expect(runtime.commands.sessions.get(status.id)).toMatchObject({panel:'events',viewChain:'all'});
    });
  });

  it('restores list filter, sort, page and chain after detail and evidence navigation',async()=>{
    await withRuntime('22910',async({runtime,command,sessions,link,click,seed})=>{
      seed(8);await command('leads');const root=sessions()[0];
      await click(link(root,'panel.open',params=>params.panel==='filter'));
      await click(link(runtime.commands.sessions.get(root.id),'filter.set',params=>params.value==='fresh'));
      await click(link(runtime.commands.sessions.get(root.id),'panel.open',params=>params.panel==='sort'));
      await click(link(runtime.commands.sessions.get(root.id),'sort.set',params=>params.value==='score_desc'));
      await click(link(runtime.commands.sessions.get(root.id),'page.set',params=>params.page===1));
      const origin=runtime.commands.sessions.get(root.id);expect(origin.query).toMatchObject({filter:'fresh',sort:'score_desc',page:1});
      await click(link(origin,'panel.open',params=>params.panel==='detail'));
      await click(link(runtime.commands.sessions.get(root.id),'panel.open',params=>params.panel==='evidence'));
      await click(link(runtime.commands.sessions.get(root.id),'page.set',params=>params.page===1));
      expect(runtime.commands.sessions.get(root.id).query.detailPage).toBe(1);
      await click(link(runtime.commands.sessions.get(root.id),'panel.back'));expect(runtime.commands.sessions.get(root.id).panel).toBe('detail');
      await click(link(runtime.commands.sessions.get(root.id),'panel.back'));
      const restored=runtime.commands.sessions.get(root.id);expect(restored.panel).toBe('audits');expect(restored.viewChain).toBe(origin.viewChain);expect(restored.query).toMatchObject({filter:'fresh',sort:'score_desc',page:1});expect(restored.messageId).toBe(root.messageId);
    });
  });

  it('connects AVE from /setkey: encrypts the submission, verifies it with one AVE details read and starts the Arc scan',async()=>{
    await withRuntime('22903',async({runtime,storage,tenantId,sent,command,receipt,drain,sessions})=>{
      await command('onboard');
      const guide=sent.find(row=>row.params.text?.includes('/setkey'));
      expect(guide.params.reply_markup.inline_keyboard.flat().some(button=>button.url==='https://cloud.ave.ai/login')).toBe(true);
      const input=receipt('credential',{source:'message'});await runtime.receiveCredential(input,`/setkey ${apiKey}`);
      const pending=runtime.inbox.get(input.updateId);expect(pending.payload_enc).toBeTruthy();expect(pending.payload_enc).not.toContain(apiKey);expect(pending.payload_json).not.toContain(apiKey);
      await runtime.runCommand(input.updateId);const generation=runtime.inbox.get(input.updateId).generation;
      expect(schedulerTasks(storage,tenantId).filter(task=>task.kind==='credential')).toEqual([{id:`credential:${generation}`,kind:'credential',dueAt:at,enabled:true,aveCost:AVE_CU.details}]);
      expect(runtime.control.snapshot().configured).toBe(false);
      const ave=aveStub(()=>jsonResponse(wbnbDetails));
      await runtime.verifyCredential(generation,{request,fetchImpl:ave.fetch});
      await drain();
      expect(ave.calls).toEqual([{url:WBNB_DETAILS_URL,apiKey}]);
      expect(runtime.inbox.get(input.updateId).status).toBe('DONE');expect(runtime.inbox.get(input.updateId).payload_enc).toBeNull();
      expect(runtime.control.snapshot()).toMatchObject({configured:true,keyEpoch:1,activeChain:'arc'});
      expect(await readAveApiKey(storage,masterKey,tenantId)).toBe(apiKey);
      expect(storage.sql.exec('SELECT name,value_enc FROM keys WHERE tenant_id=?',tenantId).toArray().map(row=>{expect(row.value_enc).not.toContain(apiKey);return row.name;})).toEqual(['ave-api-key']);
      expect(sent.some(row=>row.method==='deleteMessage'&&row.params.message_id===input.sourceMessageId)).toBe(true);expect(JSON.stringify(sent)).not.toContain(apiKey);
      expect(sessions().find(session=>session.panel==='connection').query.outcome).toBe('connected');
      expect(sent.at(-1).params.text).toMatch(/^<b>✅ AVE已连接<\/b>\n🟢 正在扫描 Arc · 🔔 提醒开启\n/);
      expect(runtime.notifications.controls().enabled).toBe(true);
      const [scan]=schedulerTasks(storage,tenantId).filter(task=>task.kind==='scan');
      expect(scan).toMatchObject({kind:'scan',dueAt:at,enabled:true,aveCost:AVE_CU.trending});
      expect(storage.sql.exec('SELECT chain,key_epoch,phase FROM cycle_checkpoint WHERE tenant_id=? AND cycle_id=?',tenantId,scan.id.slice('scan:'.length)).one()).toEqual({chain:'arc',key_epoch:1,phase:'DISCOVER'});
    });
  });

  it.each([[401,'AVE密钥无效或已被拒绝。'],[402,'AVE额度已用尽。']])('ends verification on an AVE %s refusal, scrubs the candidate and tells the user',async(status,reason)=>{
    await withRuntime(status===401?'22918':'22919',async({runtime,storage,tenantId,sent,receipt,drain,sessions,link,click})=>{
      const input=receipt('credential',{source:'message'});await runtime.receiveCredential(input,`/setkey ${apiKey}`);await runtime.runCommand(input.updateId);
      const ave=aveStub(()=>new Response('{}',{status}));
      await runtime.verifyCredential(runtime.inbox.get(input.updateId).generation,{request,fetchImpl:ave.fetch});await drain();
      expect(ave.calls).toHaveLength(1);
      expect(runtime.inbox.get(input.updateId)).toMatchObject({status:'FAILED',payload_enc:null});
      expect(storage.sql.exec('SELECT name FROM keys WHERE tenant_id=?',tenantId).toArray()).toEqual([]);
      expect(runtime.control.snapshot().configured).toBe(false);
      const [panel]=sessions().filter(session=>session.panel==='connection');
      expect(panel.query).toMatchObject({outcome:'failed',reason:status===401?'AVE_AUTH':'AVE_QUOTA'});
      expect(sent.at(-1).params.text.startsWith(`<b>密钥未通过验证</b>\n${reason}\nAVE尚未连接。\n`)).toBe(true);
      await click(link(panel,'panel.open',params=>params.panel==='onboard'));
      expect(runtime.commands.sessions.get(panel.id).panel).toBe('onboard');
    });
  });

  it('keeps the candidate for a retry when AVE rate-limits its verification',async()=>{
    await withRuntime('22920',async({runtime,storage,tenantId,receipt})=>{
      const input=receipt('credential',{source:'message'});await runtime.receiveCredential(input,`/setkey ${apiKey}`);await runtime.runCommand(input.updateId);
      const ave=aveStub(()=>new Response('too many requests',{status:429,headers:{'retry-after':'30'}}));
      await expect(runtime.verifyCredential(runtime.inbox.get(input.updateId).generation,{request,fetchImpl:ave.fetch})).rejects.toMatchObject({code:'AVE_RATE_LIMITED'});
      expect(['RECEIVED','RUNNING']).toContain(runtime.inbox.get(input.updateId).status);
      expect(storage.sql.exec('SELECT name FROM keys WHERE tenant_id=?',tenantId).toArray()).toEqual([{name:'ave-pending-api-key'}]);
      expect(runtime.control.snapshot().configured).toBe(false);
    });
  });

  it('ends verification on its final attempt when AVE stays unavailable, scrubs the candidate and tells the user to resend',async()=>{
    await withRuntime('22922',async({runtime,storage,tenantId,sent,receipt,drain,sessions})=>{
      const input=receipt('credential',{source:'message'});await runtime.receiveCredential(input,`/setkey ${apiKey}`);await runtime.runCommand(input.updateId);
      const ave=aveStub(()=>new Response('too many requests',{status:429,headers:{'retry-after':'30'}}));
      await runtime.verifyCredential(runtime.inbox.get(input.updateId).generation,{request,fetchImpl:ave.fetch,finalAttempt:true});await drain();
      expect(ave.calls).toHaveLength(1);
      expect(runtime.inbox.get(input.updateId)).toMatchObject({status:'FAILED',payload_enc:null});
      expect(storage.sql.exec('SELECT name FROM keys WHERE tenant_id=?',tenantId).toArray()).toEqual([]);
      expect(runtime.control.snapshot().configured).toBe(false);
      expect(sessions().find(session=>session.panel==='connection').query).toMatchObject({outcome:'failed',reason:'AVE_RATE_LIMITED',retryAt:at+30_000});
      expect(sent.at(-1).params.text).toMatch(/^<b>密钥未通过验证<\/b>\nAVE请求受到限流。 请在 08:00:30 UTC 之后重试。\nAVE尚未连接。\n/);
    });
  });

  it.each([
    ['network', '23991', '无法连接AVE。', async () => { throw new TypeError('secret transport detail'); }],
    ['upstream', '23992', 'AVE服务暂时出错。', async () => new Response('{}', { status: 502 })],
    ['timeout', '23993', 'AVE验证超时。', async () => new Response('{}', { status: 200 })]
  ])('reports a sanitized %s verification failure', async (kind, tenantId, notice, fetchImpl) => {
    await withRuntime(tenantId, async ({ runtime, sent, receipt, drain }) => {
      const input = receipt('credential', { source: 'message' });
      await runtime.receiveCredential(input, `/setkey ${apiKey}`);
      await runtime.runCommand(input.updateId);
      const verificationRequest = kind === 'timeout' ? async () => { throw new AveError('TIMEOUT', 504); } : request;
      await runtime.verifyCredential(runtime.inbox.get(input.updateId).generation,
        { request: verificationRequest, fetchImpl, finalAttempt: true });
      await drain();
      const panel = sent.find(row => row.params.text?.includes(notice));
      expect(panel.params.text.startsWith(`<b>密钥未通过验证</b>\n${notice}\n`)).toBe(true);
      expect(panel.params.reply_markup.inline_keyboard[0][0].text).toBe('🔑 重试');
      expect(JSON.stringify(sent)).not.toContain('secret transport detail');
      expect(JSON.stringify(sent)).not.toContain(apiKey);
    });
  });

  it.each(['pause','disconnect'])('commits /%s during a suspended verification before its network completion',async action=>{
    await withRuntime(action==='pause'?'22904':'22905',async({runtime,storage,tenantId,command,receipt})=>{
      await command('onboard');const input=receipt('credential',{source:'message'});await runtime.receiveCredential(input,`/setkey ${apiKey}`);await runtime.runCommand(input.updateId);
      let release,entered;
      const gate=new Promise(resolve=>{release=resolve;});const started=new Promise(resolve=>{entered=resolve;});
      const verification=runtime.verifyCredential(runtime.inbox.get(input.updateId).generation,{request,fetchImpl:async()=>{entered();await gate;return jsonResponse(wbnbDetails);}});
      await started;
      const control=receipt(`command:${action}`,{source:'message',arguments:''});runtime.receive(control);
      expect(runtime.inbox.get(control.updateId).status).toBe('DONE');expect(runtime.control.snapshot().paused).toBe(true);
      release();await verification;
      if(action==='pause') {expect(runtime.control.snapshot()).toMatchObject({configured:true,paused:true});expect(runtime.inbox.get(input.updateId).status).toBe('DONE');}
      else {expect(runtime.control.snapshot().configured).toBe(false);expect(runtime.inbox.get(input.updateId).status).toBe('CANCELLED');expect(storage.sql.exec('SELECT name FROM keys WHERE tenant_id=?',tenantId).toArray()).toEqual([]);expect(schedulerTasks(storage,tenantId).filter(task=>task.kind==='scan')).toEqual([]);}
    });
  });

  it('moves a connected scan to the chain chosen in the chains panel and drops the previous chain cycle',async()=>{
    await withRuntime('22921',async({runtime,storage,tenantId,command,sessions,link,click,receipt,drain})=>{
      const input=receipt('credential',{source:'message'});await runtime.receiveCredential(input,`/setkey ${apiKey}`);await runtime.runCommand(input.updateId);
      await runtime.verifyCredential(runtime.inbox.get(input.updateId).generation,{request,fetchImpl:aveStub(()=>jsonResponse(wbnbDetails)).fetch});await drain();
      const [arcScan]=schedulerTasks(storage,tenantId).filter(task=>task.kind==='scan');
      await command('chains');await click(link(sessions().at(-1),'chains.set',params=>params.value==='bsc'));
      expect(runtime.control.snapshot().activeChain).toBe('bsc');
      const scans=schedulerTasks(storage,tenantId).filter(task=>task.kind==='scan');
      expect(scans).toHaveLength(1);expect(scans[0].id).not.toBe(arcScan.id);expect(scans[0].aveCost).toBe(AVE_CU.trending);
      expect(storage.sql.exec('SELECT chain FROM cycle_checkpoint WHERE tenant_id=?',tenantId).toArray()).toEqual([{chain:'bsc'}]);
    });
  });

  it('rebuilds a requested detail from current evidence when an audit changes before its first edit is sent',async()=>{
    await withRuntime('22912',async({runtime,storage,tenantId,sent,command,sessions,link,seed,receipt,drain})=>{
      seed();await command('leads');
      const audits=sessions()[0],binding=link(audits,'panel.open',params=>params.panel==='detail');
      const input=receipt('callback',{callbackId:binding.id,callbackQueryId:'detail-race'},{sourceMessageId:audits.messageId});
      runtime.receive(input);await runtime.runCommand(input.updateId);
      expect(storage.sql.exec('SELECT * FROM message_map WHERE tenant_id=?',tenantId).toArray()).toHaveLength(0);
      storage.sql.exec('UPDATE candidates SET review_revision=? WHERE tenant_id=?','fresh-evidence',tenantId);
      await drain();
      expect(runtime.outbox.rows().some(row=>row.status==='CANCELLED')).toBe(true);
      storage.transactionSync(()=>runtime.reconcileInTransaction());await drain();
      const mapping=storage.sql.exec('SELECT rendered_revision,message_id FROM message_map WHERE tenant_id=?',tenantId).one();
      expect(mapping).toEqual({rendered_revision:'fresh-evidence',message_id:audits.messageId});
      expect(sent.at(-1).method).toBe('editMessageText');
    });
  });

  it('corrects all mapped cards while muted and never resets a permanently failed correction retry budget',async()=>{
    await withRuntime('22913',async({runtime,storage,tenantId,command,sessions,link,click,seed,drain})=>{
      seed();await command('leads');await click(link(sessions()[0],'panel.open',params=>params.panel==='detail'));
      await command('leads');await click(link(sessions()[1],'panel.open',params=>params.panel==='detail'));
      await command('mute');expect(runtime.notifications.controls().enabled).toBe(false);
      storage.sql.exec('UPDATE candidates SET review_revision=? WHERE tenant_id=?','risk-revision',tenantId);
      storage.transactionSync(()=>runtime.reconcileCardsInTransaction());
      const corrections=()=>runtime.outbox.rows().filter(row=>row.delivery_class==='PANEL_UPDATE');
      expect(corrections()).toHaveLength(2);
      runtime.outbox.transport=async()=>({ok:false,kind:'permanent',code:'TELEGRAM_REJECTED'});
      await drain();expect(corrections().every(row=>row.status==='FAILED')).toBe(true);
      for(let iteration=0;iteration<3;iteration++) storage.transactionSync(()=>runtime.reconcileCardsInTransaction());
      expect(corrections()).toHaveLength(2);
      storage.sql.exec('UPDATE candidates SET review_revision=? WHERE tenant_id=?','different-risk-revision',tenantId);
      storage.transactionSync(()=>runtime.reconcileCardsInTransaction());
      expect(corrections()).toHaveLength(4);
    });
  });

  it('commits a valid pause callback during intake without waiting for an external scheduler step',async()=>{
    await withRuntime('22914',async({runtime,command,sessions,link,receipt})=>{
      await command('settings');
      const session=sessions()[0],binding=link(session,'scan.pause');
      const input=receipt('callback',{callbackId:binding.id,callbackQueryId:'pause-now'},{sourceMessageId:session.messageId});
      runtime.receive(input);
      expect(runtime.control.snapshot().paused).toBe(true);
      expect(runtime.inbox.get(input.updateId).status).toBe('DONE');
    });
  });

  it('starts a new owner in their Telegram language on the welcome, whose language button keeps the welcome',async()=>{
    await withRuntime('23601',async({runtime,storage,tenantId,sent,receipt,drain,sessions,link,click})=>{
      const start=receipt('command:start',{source:'message',arguments:''},{locale:'en'});
      runtime.receive(start);await runtime.runCommand(start.updateId);await drain();
      expect(runtime.commands.language).toBe('en');
      expect(sent.at(-1).params.text).toMatch(/^<b>👋 AlphaMeme radar<\/b>\nWatches the Arc hot list/);
      const [welcome]=sessions();
      await click(link(welcome,'language.set',params=>params.value==='zh'));
      expect(runtime.commands.sessions.get(welcome.id).panel).toBe('radar');
      expect(sent.at(-1)).toMatchObject({method:'editMessageText',params:{message_id:welcome.messageId}});
      expect(sent.at(-1).params.text).toMatch(/^<b>👋 AlphaMeme 雷达<\/b>/);
      // Only the first receipt seeds the language; a later one in another language changes nothing.
      const later=receipt('command:radar',{source:'message',arguments:''},{locale:'en'});
      runtime.receive(later);await runtime.runCommand(later.updateId);
      expect(storage.sql.exec('SELECT value_json FROM preferences WHERE tenant_id=? AND key=?',tenantId,'telegram.language').one().value_json).toBe('"zh"');
    });
  });

  it('answers unrecognized text with a hint whose buttons open Radar and Help',async()=>{
    await withRuntime('23602',async({runtime,sent,receipt,drain,sessions,link,click})=>{
      const payload={},input=receipt('text',payload);
      runtime.receive(input);await runtime.runCommand(input.updateId);await drain();
      expect(runtime.inbox.get(input.updateId)).toMatchObject({status:'DONE',payload_json:JSON.stringify(payload)});
      expect(sent).toHaveLength(1);
      expect(sent[0].params.text).toBe('粘贴代币合约地址即可查询，或打开 📡 雷达。');
      expect(sent[0].params.reply_markup.inline_keyboard.map(row=>row.map(item=>item.text))).toEqual([['📡 雷达','❓ 帮助']]);
      const [hint]=sessions();
      await click(link(hint,'panel.open',params=>params.panel==='help'));
      expect(runtime.commands.sessions.get(hint.id).panel).toBe('help');
      expect(sent.at(-1)).toMatchObject({method:'editMessageText',params:{message_id:hint.messageId}});
      await click(link(runtime.commands.sessions.get(hint.id),'panel.back'));
      expect(runtime.commands.sessions.get(hint.id).panel).toBe('radar');
    });
  });

  it('names the token in the note prompt',async()=>{
    await withRuntime('23604',async({runtime,sent,command,sessions,link,click,seed})=>{
      seed();await command('leads');const audits=sessions()[0];
      await click(link(audits,'panel.open',params=>params.panel==='detail'));
      await click(link(runtime.commands.sessions.get(audits.id),'note.begin'));
      expect(sent.findLast(row=>row.params.reply_markup?.force_reply).params.text).toBe('请回复 TOKEN0 (Arc) 的备注，最多500字符。/cancel 取消。');
    });
  });
});
