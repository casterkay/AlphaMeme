import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeRadarSchema } from '../src/storage/schema.mjs';
import { NotificationPolicy } from '../src/bot/notification-policy.mjs';
import { CHART_RISK_VERSION } from '../src/scoring/chart-risk.mjs';
import { readSchedulerStateInTransaction, writeSchedulerStateInTransaction } from '../src/storage/scheduler-state.mjs';
const START = 1800000000000;
function fixture() {
  const db = new DatabaseSync(':memory:');
  const storage = { sql: { exec: (sql, ...args) => { const stmt = db.prepare(sql), rows = stmt.columns().length ? stmt.all(...args) : (stmt.run(...args), []); return { toArray: () => rows }; } }, transactionSync: fn => fn() };
  initializeRadarSchema(storage);
  let now = START;
  const create = () => new NotificationPolicy({ storage, tenantId: '123', now: () => now });
  const sql = (query, ...args) => storage.sql.exec(query, ...args);
  const pref = (key, value) => sql('INSERT INTO preferences (tenant_id,key,value_json) VALUES (?,?,?) ON CONFLICT(tenant_id,key) DO UPDATE SET value_json=excluded.value_json','123',key,JSON.stringify(value));
  pref('telegram.notifications', true);
  const scanChain = chain => { const state = readSchedulerStateInTransaction(storage, '123'); writeSchedulerStateInTransaction(storage, '123', { ...state, runtime: { ...state.runtime, control: { ...state.runtime.control, activeChain: chain } } }); };
  scanChain('bsc');
  const candidate = (address, options = {}) => {
    const { status = 'X_REVIEW', revision = 'r1', qualified = true, age = 0 } = options;
    sql('INSERT INTO candidates (tenant_id,chain,address,status,audited_at,stale_at,review_revision,deep_json,audit_health_json) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,chain,address) DO UPDATE SET status=excluded.status,audited_at=excluded.audited_at,stale_at=excluded.stale_at,review_revision=excluded.review_revision,deep_json=excluded.deep_json', '123','bsc',address,status,now-age,now+600000,revision,JSON.stringify({chainPass:qualified,chartRisk:{pass:qualified,version:CHART_RISK_VERSION}}),'{}');
  };
  const event = (id,type,address) => sql('INSERT INTO events (tenant_id,id,at,type,chain,address) VALUES (?,?,?,?,?,?)','123',id,now,type,'bsc',address);
  return { sql, pref, scanChain, candidate, event, policy: create(), create, advance: ms => { now += ms; } };
}

test('initial baseline stays quiet; newly eligible promotion produces one immutable batch and survives eviction', () => {
  const f = fixture(); f.candidate('old'); f.candidate('promote', { status:'WAIT_RECHECK', qualified:false });
  assert.equal(f.policy.reconcileInTransaction().notifications.length, 0);
  f.advance(1); f.candidate('promote');
  const first = f.policy.reconcileInTransaction().notifications;
  assert.equal(first.length,1); assert.equal(first[0].members[0].address,'promote');
  assert.equal(Object.isFrozen(first[0].members),true);
  f.policy = f.create();
  assert.deepEqual(f.policy.reconcileInTransaction().notifications,first);
  f.policy.acknowledgeInTransaction(first[0]);
  f.advance(86400001); f.candidate('promote');
  assert.equal(f.policy.reconcileInTransaction().notifications.length,0,'continuous qualification is quiet beyond 24h');
});

const logLines = log => log.mock.calls.map(call => JSON.parse(call.arguments[0]));
const holds = log => logLines(log).filter(line => line.event === 'notification_lead_held').map(line => `${line.address}:${line.reason}`);

test('each lead logs why it is held once per change, and an enqueued alert is logged with its leads', t => {
  const log = t.mock.method(console, 'log', () => {});
  const f = fixture(); f.candidate('old');
  f.policy.reconcileInTransaction(); f.policy.reconcileInTransaction();
  assert.deepEqual(holds(log), ['old:quiet_before_baseline']);
  log.mock.resetCalls();
  f.advance(1); f.candidate('fresh');
  f.policy.reconcileInTransaction(); f.policy.reconcileInTransaction();
  assert.deepEqual(holds(log), ['fresh:alerted']);
  assert.deepEqual(logLines(log).filter(line => line.event === 'notification_enqueued'),
    [{ event: 'notification_enqueued', id: 'notification:1:1', actionReason: 'CANDIDATE_NEW', addresses: ['fresh'] }]);
  log.mock.resetCalls();
  f.pref('telegram.notifications', false);
  f.policy.reconcileInTransaction();
  assert.deepEqual(holds(log).sort(), ['fresh:alerts_off', 'old:alerts_off']);
});

test('a lead that is not alert-eligible, or waits for the next batch, says so', t => {
  const log = t.mock.method(console, 'log', () => {});
  const f = fixture(); f.candidate('seed');
  f.policy.reconcileInTransaction();
  f.advance(1); f.candidate('first');
  f.policy.reconcileInTransaction();
  f.advance(1); f.candidate('second');
  f.policy.reconcileInTransaction();
  assert.ok(holds(log).includes('second:batch_interval'));
  log.mock.resetCalls();
  f.candidate('late', { status: 'LIVE_READY', age: 11 * 60_000 });
  f.policy.reconcileInTransaction();
  assert.deepEqual(holds(log), ['late:audit_too_old']);
});

test('an alert dropped before delivery is logged with the reason it no longer qualifies', t => {
  const log = t.mock.method(console, 'log', () => {});
  const f = fixture(); f.candidate('old');
  f.policy.reconcileInTransaction();
  f.advance(1); f.candidate('fresh');
  const [notice] = f.policy.reconcileInTransaction().notifications;
  f.candidate('fresh', { revision: 'r2' });
  f.policy.reconcileInTransaction();
  assert.deepEqual(logLines(log).filter(line => line.event === 'notification_dropped'),
    [{ event: 'notification_dropped', id: notice.id, actionReason: 'CANDIDATE_NEW', addresses: ['fresh'], reason: 'lead_revised' }]);
});

test('delivery eligibility names the reason a pending alert may no longer be sent', () => {
  const f = fixture(); f.candidate('old');
  f.policy.reconcileInTransaction();
  f.advance(1); f.candidate('fresh');
  const [notice] = f.policy.reconcileInTransaction().notifications;
  const outbox = { delivery_class: 'ACTION_REQUIRED', action_reason: 'CANDIDATE_NEW' };
  assert.equal(f.policy.ineligibleReason(outbox, { notification: notice }), null);
  f.candidate('fresh', { revision: 'r2' });
  assert.equal(f.policy.ineligibleReason(outbox, { notification: notice }), 'lead_revised');
  f.pref('telegram.notifications', false);
  assert.equal(f.policy.ineligibleReason(outbox, { notification: notice }), 'alerts_off');
  assert.equal(f.policy.eligible(outbox, { notification: notice }), false);
});

test('alerts are on until the tenant explicitly turns them off', () => {
  const f = fixture();
  f.sql("DELETE FROM preferences WHERE tenant_id='123' AND key='telegram.notifications'");
  assert.equal(f.policy.controls().enabled, true);
  f.pref('telegram.notifications', false);
  assert.equal(f.policy.controls().enabled, false);
});

test('routine changes, samples, ordinary rejects and recoverable issues never notify', () => {
  const f = fixture(); f.policy.baselineInTransaction(); f.advance(1);
  for (const type of ['LIVE_CHANGED','SAMPLE_COMPLETE','HARD_REJECT','SCAN_SUMMARY','DEGRADED','RATE_LIMITED']) f.event(type,type,'a');
  assert.equal(f.policy.reconcileInTransaction({issues:[{key:'rate',reason:'RATE_LIMITED',nextAction:'wait'}]}).notifications.length,0);
});

test('ignored and incomplete candidates are excluded; mute cancels automatic notices but permits corrections', () => {
  const f = fixture(); f.policy.baselineInTransaction(); f.advance(1); f.candidate('ignored'); f.candidate('bad',{qualified:false}); f.candidate('good');
  f.sql('INSERT INTO manual_marks (tenant_id,chain,address,decision) VALUES (?,?,?,?)','123','bsc','ignored','ignored');
  f.sql('INSERT INTO message_map (tenant_id,chain,address,message_id,chat_id) VALUES (?,?,?,?,?)','123','bsc','good','1','123');
  const notice = f.policy.reconcileInTransaction().notifications[0];
  assert.deepEqual(notice.members.map(row=>row.address),['good']);
  f.pref('telegram.notifications',false);
  const result=f.policy.reconcileInTransaction();
  assert.equal(result.notifications.length,0); assert.equal(result.corrections.length,1);
  assert.equal(f.policy.eligible({delivery_class:'USER_RESPONSE'},{}),true);
  assert.equal(f.policy.eligible({delivery_class:'PANEL_UPDATE'},{}),true);
  assert.equal(f.policy.eligible({delivery_class:'ACTION_REQUIRED',action_reason:'CANDIDATE_NEW'},{notification:notice}),false);
});

test('new-candidate batches are limited to one per minute and have 24h token suppression', () => {
  const f=fixture();f.policy.baselineInTransaction();f.advance(1);f.candidate('a');
  const first=f.policy.reconcileInTransaction().notifications[0];f.policy.acknowledgeInTransaction(first);
  f.candidate('b'); assert.equal(f.policy.reconcileInTransaction().notifications.length,0);
  f.advance(60000); const second=f.policy.reconcileInTransaction().notifications[0];assert.equal(second.members[0].address,'b');
  f.policy.acknowledgeInTransaction(second);
  f.candidate('a',{status:'WAIT_RECHECK'});f.policy.reconcileInTransaction();f.advance(60000);f.candidate('a');
  assert.equal(f.policy.reconcileInTransaction().notifications.length,0);
});

test('risk notification bypasses voice qualification while every mapped card gets correction independently of dedup', () => {
  const f=fixture();f.policy.baselineInTransaction();f.advance(1);f.candidate('a',{status:'HARD_REJECT',qualified:false,revision:'bad'});
  f.sql('INSERT INTO annotations (tenant_id,chain,address,favorite,note) VALUES (?,?,?,?,?)','123','bsc','a',1,'');
  for (const id of ['1','2']) f.sql('INSERT INTO message_map (tenant_id,chain,address,message_id,chat_id) VALUES (?,?,?,?,?)','123','bsc','a',id,'123');
  f.event('risk1','RISK_WORSENED','a');
  const first=f.policy.reconcileInTransaction(); assert.equal(first.notifications[0].actionReason,'RISK_WORSENED');assert.equal(first.corrections.length,2);
  f.policy.acknowledgeInTransaction(first.notifications[0]);f.advance(1);f.candidate('a',{status:'HARD_REJECT',qualified:false,revision:'worse'});f.event('risk2','RISK_WORSENED','a');
  const next=f.policy.reconcileInTransaction();assert.equal(next.notifications.length,0);assert.equal(next.corrections.length,2);assert.equal(next.corrections[0].revision,'worse');
});

test('explicit unresolved service issue notifies once, and eligibility rechecks current issue', () => {
  const f=fixture();const issue={key:'key',reason:'KEY_UNUSABLE',nextAction:'/onboard'};
  const descriptor=f.policy.reconcileInTransaction({issues:[issue]}).notifications[0];
  assert.equal(f.policy.eligible({delivery_class:'ACTION_REQUIRED',action_reason:'ACCOUNT_ACTION_REQUIRED'},{notification:descriptor},{issues:[issue]}),true);
  assert.equal(f.policy.eligible({delivery_class:'ACTION_REQUIRED',action_reason:'ACCOUNT_ACTION_REQUIRED'},{notification:descriptor},{issues:[]}),false);
  f.policy.acknowledgeInTransaction(descriptor);
  assert.equal(f.policy.reconcileInTransaction({issues:[issue]}).notifications.length,0);
  assert.equal(f.policy.reconcileInTransaction({issues:[]}).notifications.length,0);
});

test('explicit reconnect baseline invalidates pending batches without mutating frozen membership', () => {
  const f=fixture();f.policy.baselineInTransaction();f.advance(1);f.candidate('a');
  const descriptor=f.policy.reconcileInTransaction().notifications[0];
  f.policy.baselineInTransaction(true);
  assert.equal(f.policy.eligible({delivery_class:'ACTION_REQUIRED',action_reason:'CANDIDATE_NEW'},{notification:descriptor}),false);
  assert.equal(f.policy.reconcileInTransaction().notifications.length,0);
  assert.equal(descriptor.members.length,1);
});

test('expired failed delivery cannot bypass transport retry limit by creating a replacement notification', () => {
  const f=fixture();f.policy.baselineInTransaction();f.advance(1);f.candidate('a');
  const issue={key:'delivery',reason:'DELIVERY_UNCERTAIN',nextAction:'/status'};
  const pending=f.policy.reconcileInTransaction({issues:[issue]}).notifications;
  assert.equal(pending.length,2);
  f.advance(600001);f.candidate('a');
  assert.equal(f.policy.reconcileInTransaction({issues:[issue]}).notifications.length,0);
});

test('an AVE market lead alerts once as upstream live leads do, and a vetoed lead is no longer eligible', () => {
  const f = fixture(); f.policy.baselineInTransaction(); f.advance(1);
  f.candidate('lead', { status: 'LIVE_READY', qualified: false });
  const [batch] = f.policy.reconcileInTransaction().notifications;
  assert.equal(batch.actionReason, 'CANDIDATE_NEW');
  assert.deepEqual(batch.members.map(member => member.address), ['lead']);
  f.candidate('lead', { status: 'HARD_REJECT', revision: 'veto' });
  assert.equal(f.policy.eligible({ delivery_class: 'ACTION_REQUIRED', action_reason: 'CANDIDATE_NEW' }, { notification: batch }), false);
});

test('only the selected scan chain alerts', () => {
  const f = fixture(); f.policy.baselineInTransaction(); f.advance(1);
  f.scanChain('arc');
  f.candidate('lead', { status: 'LIVE_READY' });
  assert.equal(f.policy.reconcileInTransaction().notifications.length, 0);
});
