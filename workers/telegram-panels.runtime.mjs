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
        storage.sql.exec('INSERT INTO candidates (tenant_id,chain,address,symbol,status,audited_at,market_cap,holders,deep_json,review_revision) VALUES (?,?,?,?,?,?,?,?,?,?)',tenant,'sol','A'.repeat(32),tenant==='19200'?'OWN':'OTHER','X_REVIEW',now-1000,null,0,JSON.stringify({chartRisk:{version:CHART_RISK_VERSION},checks:{tax:false}}),'revision');
      }
      storage.sql.exec('INSERT INTO annotations (tenant_id,chain,address,favorite,note,updated_at) VALUES (?,?,?,?,?,?)','19200','sol','A'.repeat(32),1,'safe note',now);
      storage.sql.exec('INSERT INTO manual_marks (tenant_id,chain,address,decision,marked_at,review_revision,mark_version) VALUES (?,?,?,?,?,?,?)','19200','sol','A'.repeat(32),'passed',now-500,'revision',2);
      storage.sql.exec('INSERT INTO keys (tenant_id,name,value_enc,generation) VALUES (?,?,?,?)','19200','private','secret-ciphertext',1);
      storage.sql.exec('INSERT INTO scheduler_state (tenant_id,key,value_json) VALUES (?,?,?)','19200','live.snapshot:sol',JSON.stringify({keyEpoch:0,lastSuccessAt:now,rows:[{chain:'sol',address:'A'.repeat(32),symbol:'LIVE',holders:null,rawSecret:'do-not-show'}]}));
      const snapshot=readTelegramSnapshot(storage,'19200',now);
      expect(snapshot.candidates).toHaveLength(1);expect(snapshot.candidates[0].symbol).toBe('OWN');expect(snapshot.candidates[0].marketCap).toBeNull();expect(snapshot.candidates[0].holders).toBe(0);expect(snapshot.marks[0].at).toBe(now-500);expect(snapshot.marks[0].version).toBe(2);
      expect(snapshot.liveByChain.sol.rows[0].symbol).toBe('LIVE');
      const exported=JSON.stringify(createTelegramExport(snapshot));expect(exported).not.toContain('secret-ciphertext');expect(exported).not.toContain('OTHER');expect(exported).not.toContain('do-not-show');
      const rendered=renderPanel(snapshot,{panel:'detail',viewChain:'sol',query:{selectedToken:{chain:'sol',address:'A'.repeat(32)}},version:1},'en');
      expect(rendered.text).toContain('Manually approved');expect(rendered.text).toContain('Market cap Unknown');
    });
  });
});
