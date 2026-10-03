import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { annotateInTransaction, readReview, reviewProjectionRevision, setManualMarkInTransaction } from '../src/bot/review.mjs';

const token = { chain: 'base', address: '0x' + 'a'.repeat(40) };
it('accepts only ignore marks, versions every change and rejects stale evidence',async () => {
  await runInDurableObject(env.RADAR.getByName('radar:19301'), async (_instance, state) => {
    const storage = state.storage, tenant = '19301', now = 2_000_000;
    storage.sql.exec('INSERT INTO candidates (tenant_id,chain,address,status,audited_at,review_revision) VALUES (?,?,?,?,?,?)', tenant, token.chain, token.address, 'LIVE_READY', now - 600_000, 'r1');
    const set = (decision, version, revision = 'r1') => storage.transactionSync(() => setManualMarkInTransaction(storage, tenant, { token, decision, expectedMarkVersion: version, reviewRevision: revision }, now));
    expect(() => set('passed', 0)).toThrow('invalid_mark');
    const before = reviewProjectionRevision(storage, tenant, token);
    expect(set('ignored', 0).version).toBe(1);
    expect(reviewProjectionRevision(storage, tenant, token)).not.toBe(before);
    expect(() => set(null, 0)).toThrow('mark_changed');
    storage.sql.exec('UPDATE candidates SET review_revision = ? WHERE tenant_id = ?', 'r2', tenant);
    expect(readReview(storage, tenant, token).mark.decision).toBe('ignored');
    expect(set(null, 1).decision).toBeNull();
    expect(() => set('ignored', 2)).toThrow('evidence_changed');
  });
});

it('field-specific annotation writes preserve concurrent other-field edits and deletion tombstones', async () => {
  await runInDurableObject(env.RADAR.getByName('radar:19302'), async (_instance, state) => {
    const storage = state.storage, tenant = '19302';
    const write = (field, value, expectedVersion) => storage.transactionSync(() => annotateInTransaction(storage, tenant, { token, field, value, expectedVersion }, 2_000_000));
    write('note', 'investigate', 0);
    expect(write('favorite', true, 0)).toMatchObject({ favorite: true, note: 'investigate' });
    expect(() => write('note', 'stale overwrite', 0)).toThrow('annotation_changed');
    write('note', '', 1); write('favorite', false, 1);
    expect(storage.sql.exec('SELECT * FROM annotations WHERE tenant_id = ?', tenant).toArray()).toEqual([]);
    expect(() => write('note', 'resurrect', 0)).toThrow('annotation_changed');
    expect(() => write('note', '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEI', 2)).toThrow('sensitive_input');
  });
});

it('allows ignore without candidate evidence and rejects it if evidence appears after binding', async () => {
  await runInDurableObject(env.RADAR.getByName('radar:19303'), async (_instance, state) => {
    const storage = state.storage, tenant = '19303', now = 2_000_000;
    const ignored = storage.transactionSync(() => setManualMarkInTransaction(storage, tenant, {
      token, decision: 'ignored', expectedMarkVersion: 0, reviewRevision: null
    }, now));
    expect(ignored).toMatchObject({ decision: 'ignored', reviewRevision: null, version: 1 });

    const changed = { chain: 'base', address: '0x' + 'b'.repeat(40) };
    storage.sql.exec('INSERT INTO candidates (tenant_id,chain,address,status,audited_at,review_revision) VALUES (?,?,?,?,?,?)', tenant, changed.chain, changed.address, 'WAIT_RECHECK', now, 'new-evidence');
    expect(() => storage.transactionSync(() => setManualMarkInTransaction(storage, tenant, {
      token: changed, decision: 'ignored', expectedMarkVersion: 0, reviewRevision: null
    }, now))).toThrow('evidence_changed');
  });
});
