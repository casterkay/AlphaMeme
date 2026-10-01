import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe,it,expect } from 'vitest';
import { readTelegramSnapshot,createTelegramExport } from '../src/bot/snapshot.mjs';
import { renderPanel } from '../src/bot/panels.mjs';
import { CHART_RISK_VERSION } from '../src/scoring/chart-risk.mjs';

describe('Telegram SQLite snapshot projection',()=>{
  it('reads a tenant-consistent projection without key material or another owner records',async()=>{
    const radar=env.RADAR.get(env.RADAR.idFromName('panels-snapshot-19200'));
    await runInDurableObject(radar,async(_instance,{storage})=>{
      const now=1_800_000_000_000;
      for(const tenant of ['19200','19201']) {
        storage.sql.exec('INSERT INTO candidates (tenant_id,chain,address,symbol,status,audited_at,market_cap,holders,deep_json,review_revision) VALUES (?,?,?,?,?,?,?,?,?,?)',tenant,'robinhood','a'.repeat(32),tenant==='19200'?'OWN':'OTHER','X_REVIEW',now-1000,null,0,JSON.stringify({chartRisk:{version:CHART_RISK_VERSION},checks:{tax:false}}),'revision');
      }
      storage.sql.exec('INSERT INTO annotations (tenant_id,chain,address,favorite,note,updated_at) VALUES (?,?,?,?,?,?)','19200','robinhood','a'.repeat(32),1,'safe note',now);
      storage.sql.exec('INSERT INTO manual_marks (tenant_id,chain,address,decision,marked_at,review_revision,mark_version) VALUES (?,?,?,?,?,?,?)','19200','robinhood','a'.repeat(32),'passed',now-500,'revision',2);
      storage.sql.exec('INSERT INTO keys (tenant_id,name,value_enc,generation) VALUES (?,?,?,?)','19200','private','secret-ciphertext',1);
      storage.sql.exec('INSERT INTO scheduler_state (tenant_id,key,value_json) VALUES (?,?,?)','19200','feed.snapshot:robinhood',JSON.stringify({status:'OK',at:now,observedAt:now,receivedCount:1,leadCount:1,rows:[{address:'a'.repeat(32),symbol:'FEED',marketCap:null,pass:true,rawSecret:'do-not-show'}]}));
      const snapshot=readTelegramSnapshot(storage,'19200',now);
      expect(snapshot.candidates).toHaveLength(1);expect(snapshot.candidates[0].symbol).toBe('OWN');expect(snapshot.candidates[0].marketCap).toBeNull();expect(snapshot.candidates[0].holders).toBe(0);expect(snapshot.marks[0].at).toBe(now-500);expect(snapshot.marks[0].version).toBe(2);
      expect(snapshot.feedByChain.robinhood.rows[0]).toMatchObject({chain:'robinhood',symbol:'FEED',marketCap:null,pass:true});expect(snapshot.feedByChain.robinhood.rows[0]).not.toHaveProperty('rawSecret');
      const exported=JSON.stringify(createTelegramExport(snapshot));expect(exported).not.toContain('secret-ciphertext');expect(exported).not.toContain('OTHER');expect(exported).not.toContain('do-not-show');
      const rendered=renderPanel(snapshot,{panel:'detail',viewChain:'robinhood',query:{selectedToken:{chain:'robinhood',address:'a'.repeat(32)}},version:1},'en');
      expect(rendered.text).toContain('👍 Approved');expect(rendered.text).not.toContain('MC ');
    });
  });
  it('never renders a legacy stored AVE trade link on a lead or vetoed detail',async()=>{
    const radar=env.RADAR.get(env.RADAR.idFromName('panels-trade-19202'));
    await runInDurableObject(radar,async(_instance,{storage})=>{
      const now=1_800_000_000_000,lead='0x'+'1'.repeat(40),vetoed='0x'+'2'.repeat(40);
      for(const [address,status] of [[lead,'LIVE_READY'],[vetoed,'HARD_REJECT']]) {
        storage.sql.exec('INSERT INTO candidates (tenant_id,chain,address,symbol,status,audited_at,ave_url,review_revision) VALUES (?,?,?,?,?,?,?,?)','19202','arc',address,status,status,now-1000,`https://pro.ave.ai/token/${address}-arc?ref=0001`,`revision-${status}`);
      }
      const snapshot=readTelegramSnapshot(storage,'19202',now);
      const buttons=address=>renderPanel(snapshot,{panel:'detail',viewChain:'arc',query:{selectedToken:{chain:'arc',address}},version:1},'en').keyboard.flat().filter(Boolean);
      for(const address of [lead,vetoed]) expect(buttons(address).some(button=>button.text==='Trade on AVE'||String(button.url).includes('pro.ave.ai'))).toBe(false);
    });
  });
});
