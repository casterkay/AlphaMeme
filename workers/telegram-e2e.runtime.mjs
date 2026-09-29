import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe,it,expect,vi } from 'vitest';
import { TelegramRuntime } from '../src/bot/runtime.mjs';
import { CHART_RISK_VERSION } from '../src/scoring/chart-risk.mjs';
import { readAveApiKey } from '../src/auth/connection.mjs';
import { AVE_CU } from '../src/providers/ave.mjs';
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
function aveStub(respond) {
  const calls=[];
  return {calls,fetch:async(url,init)=>{calls.push({url:String(url),apiKey:init.headers['X-API-KEY']});return respond(String(url));}};
}

async function withRuntime(tenantId,operation) {
  const radar=env.RADAR.get(env.RADAR.idFromName(`telegram-e2e:${tenantId}`));
  return runInDurableObject(radar,async(_instance,{storage})=>{
    let update=0,message=100;
    const runtime=new TelegramRuntime({storage,tenantId,env:{MASTER_ENC_KEY:masterKey,AVE_MONTHLY_CU:env.AVE_MONTHLY_CU,AVE_CU_RESET_DAY:env.AVE_CU_RESET_DAY},now:()=>at});
    const sent=[];
    runtime.outbox.transport=async input=>{
      sent.push(structuredClone({method:input.method,params:input.params}));
      return {ok:true,result:input.method==='sendMessage'?{message_id:++message}:input.method==='editMessageText'?{message_id:Number(input.params.message_id)}:true};
    };
    const receipt=(commandType,payload,overrides={})=>({tenantId,actorUserId:tenantId,updateId:String(++update),commandType,payload,dueAt:at+60_000,messageDate:at/1000,sourceMessageId:String(1000+update),...overrides});
    const drain=async()=>{
      for(let count=0;count<100;count++) {
        const tasks=storage.transactionSync(()=>runtime.outbox.reconcileInTransaction());
        const task=tasks.find(task=>task.dueAt<=at);
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
    await operation({runtime,storage,tenantId,sent,receipt,drain,command,sessions,link,click,seed});
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
        const response=await instance.receiveTelegramUpdate({tenantId,actorUserId:tenantId,updateId:'1',commandType:'callback',payload:{callbackId:'expired-shortlink',callbackQueryId:'immediate-query'},dueAt:now+60_000,messageDate:Math.floor(now/1000),sourceMessageId:'100'});
        expect(response.accepted).toBe(true);expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(storage.sql.exec('SELECT status FROM inbox WHERE tenant_id=?',tenantId).one().status).toBe('RECEIVED');
        expect(storage.sql.exec('SELECT id FROM outbox WHERE tenant_id=?',tenantId).toArray()).toEqual([]);
        release();await acknowledgment;
      } finally {release();await acknowledgment;fetchSpy.mockRestore();answerSpy.mockRestore();instance.env.TELEGRAM_BOT_TOKEN=previousToken;}
    });
  });

  it('binds independent root messages, edits the originating panel, and rejects stale and cross-owner callbacks',async()=>{
    await withRuntime('22901',async({runtime,storage,tenantId,sent,command,sessions,link,click,seed,receipt})=>{
      seed(7);await command('radar');await command('audits');
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
      seed();await command('audits');const audits=sessions()[0];
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
      await command('settings');const oldSettings=sessions()[0],enable=link(oldSettings,'notifications.set',params=>params.value===true);
      await command('unmute');await command('mute');
      const obsoleteNotifications=await click(enable);
      expect(runtime.inbox.get(obsoleteNotifications.updateId).status).toBe('FAILED');expect(runtime.commands.preference('notifications',false)).toBe(false);
      expect(runtime.commands.sessions.get(oldSettings.id).version).toBe(oldSettings.version);
      await command('chains');const oldChains=sessions().at(-1),toSol=link(oldChains,'chains.set',params=>params.value==='sol');
      await command('chains');await click(link(sessions().at(-1),'chains.set',params=>params.value==='bsc'));
      expect(runtime.control.snapshot().activeChain).toBe('bsc');
      const obsoleteChain=await click(toSol);
      expect(runtime.inbox.get(obsoleteChain.updateId).status).toBe('FAILED');expect(runtime.control.snapshot().activeChain).toBe('bsc');
    });
  });

  it('normalizes all-chain navigation before collection and preserves pending alerts',async()=>{
    await withRuntime('22915',async({runtime,storage,tenantId,sent,command,sessions,link,click,seed,drain})=>{
      seed();
      storage.sql.exec('INSERT INTO annotations (tenant_id,chain,address,favorite,note,updated_at) VALUES (?,?,?,?,?,?)',tenantId,'robinhood','0x'+'c'.repeat(40),1,'saved',at);
      await command('saved');
      const saved=sessions()[0];expect(saved.viewChain).toBe('all');
      await click(link(saved,'panel.open',params=>params.panel==='radar'));
      const home=runtime.commands.sessions.get(saved.id);expect(home.viewChain).toBe('arc');
      await click(link(home,'panel.open',params=>params.panel==='feed'));
      const feed=runtime.commands.sessions.get(saved.id);expect(feed.viewChain).toBe('arc');

      await command('unmute');
      storage.sql.exec('INSERT INTO candidates (tenant_id,chain,address,symbol,status,audited_at,stale_at,review_revision) VALUES (?,?,?,?,?,?,?,?)',tenantId,'arc','0x'+'d'.repeat(40),'ALERT','LIVE_READY',at,at+600_000,'alert-revision');
      expect(runtime.notifications.controls()).toEqual({enabled:true,chains:['arc']});
      expect(runtime.notifications.candidates().find(row=>row.symbol==='ALERT')?.qualified).toBe(true);
      storage.transactionSync(()=>runtime.reconcileNotificationsInTransaction());
      expect(runtime.outbox.rows().some(row=>row.delivery_class==='ACTION_REQUIRED'&&row.status==='PENDING')).toBe(true);
      await command('feed');await drain();
      expect(runtime.outbox.rows().some(row=>row.delivery_class==='ACTION_REQUIRED'&&row.status==='CANCELLED')).toBe(false);
      expect(sent.some(row=>row.params.text?.includes('ALERT'))).toBe(true);
    });
  });

  it('schedules card correction only for an actual future review expiry',async()=>{
    await withRuntime('22916',async({runtime,storage,tenantId,command,sessions,link,click,seed})=>{
      seed();await command('audits');const audits=sessions()[0];
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

  it('restores list filter, sort, page and chain after detail and evidence navigation',async()=>{
    await withRuntime('22910',async({runtime,command,sessions,link,click,seed})=>{
      seed(8);await command('audits');const root=sessions()[0];
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
    await withRuntime('22903',async({runtime,storage,tenantId,sent,command,receipt,drain})=>{
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
      expect(sent.some(row=>row.params.text?.includes('AVE已连接'))).toBe(true);
      expect(runtime.commands.preference('notifications',false)).toBe(false);
      const [scan]=schedulerTasks(storage,tenantId).filter(task=>task.kind==='scan');
      expect(scan).toMatchObject({kind:'scan',dueAt:at,enabled:true,aveCost:AVE_CU.trending});
      expect(storage.sql.exec('SELECT chain,key_epoch,phase FROM cycle_checkpoint WHERE tenant_id=? AND cycle_id=?',tenantId,scan.id.slice('scan:'.length)).one()).toEqual({chain:'arc',key_epoch:1,phase:'DISCOVER'});
    });
  });

  it.each([[401,'AVE_AUTH'],[402,'AVE_QUOTA']])('ends verification on an AVE %s refusal, scrubs the candidate and tells the user',async(status)=>{
    await withRuntime(status===401?'22918':'22919',async({runtime,storage,tenantId,sent,receipt,drain})=>{
      const input=receipt('credential',{source:'message'});await runtime.receiveCredential(input,`/setkey ${apiKey}`);await runtime.runCommand(input.updateId);
      const ave=aveStub(()=>new Response('{}',{status}));
      await runtime.verifyCredential(runtime.inbox.get(input.updateId).generation,{request,fetchImpl:ave.fetch});await drain();
      expect(ave.calls).toHaveLength(1);
      expect(runtime.inbox.get(input.updateId)).toMatchObject({status:'FAILED',payload_enc:null});
      expect(storage.sql.exec('SELECT name FROM keys WHERE tenant_id=?',tenantId).toArray()).toEqual([]);
      expect(runtime.control.snapshot().configured).toBe(false);
      expect(sent.some(row=>row.params.text?.includes('/onboard'))).toBe(true);
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
    await withRuntime('22922',async({runtime,storage,tenantId,sent,receipt,drain})=>{
      const input=receipt('credential',{source:'message'});await runtime.receiveCredential(input,`/setkey ${apiKey}`);await runtime.runCommand(input.updateId);
      const ave=aveStub(()=>new Response('too many requests',{status:429,headers:{'retry-after':'30'}}));
      await runtime.verifyCredential(runtime.inbox.get(input.updateId).generation,{request,fetchImpl:ave.fetch,finalAttempt:true});await drain();
      expect(ave.calls).toHaveLength(1);
      expect(runtime.inbox.get(input.updateId)).toMatchObject({status:'FAILED',payload_enc:null});
      expect(storage.sql.exec('SELECT name FROM keys WHERE tenant_id=?',tenantId).toArray()).toEqual([]);
      expect(runtime.control.snapshot().configured).toBe(false);
      expect(sent.some(row=>row.params.text?.includes('AVE暂时不可用')&&row.params.text.includes('/setkey'))).toBe(true);
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
      seed();await command('audits');
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
      seed();await command('audits');await click(link(sessions()[0],'panel.open',params=>params.panel==='detail'));
      await command('audits');await click(link(sessions()[1],'panel.open',params=>params.panel==='detail'));
      expect(runtime.commands.preference('notifications',false)).toBe(false);
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

});
