import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { annotateInTransaction, readReview, reviewProjectionRevision, setManualMarkInTransaction, nextReviewExpiry } from '../src/bot/review.mjs';

const token = { chain: 'base', address: '0x' + 'a'.repeat(40) };
it('rejects stale and ignored approvals, preserves mark history and allows revocation after audit expiry', async () => {
  await runInDurableObject(env.RADAR.getByName('radar:19301'), async (_instance, state) => {
    const storage = state.storage, tenant = '19301', now = 2_000_000;
    storage.sql.exec('INSERT INTO candidates (tenant_id,chain,address,status,audited_at,review_revision) VALUES (?,?,?,?,?,?)', tenant, token.chain, token.address, 'X_REVIEW', now - 600_000, 'r1');
    const set = (decision, version, revision = 'r1', at = now) => storage.transactionSync(() => setManualMarkInTransaction(storage, tenant, { token, decision, expectedMarkVersion: version, reviewRevision: revision }, at));
    expect(set('passed', 0).version).toBe(1);
    expect(nextReviewExpiry(storage, tenant, token, now)).toBe(now + 1);
    expect(reviewProjectionRevision(storage, tenant, token, now)).not.toBe(reviewProjectionRevision(storage, tenant, token, now + 1));
    expect(() => set('ignored', 0)).toThrow('mark_changed');
    expect(() => set('passed', 1, 'r1', now + 1)).toThrow('approval_unavailable');
    expect(set(null, 1, null, now + 1).version).toBe(2);
    set('ignored', 2);
    expect(() => set('passed', 3)).toThrow('approval_unavailable');
    storage.sql.exec('UPDATE candidates SET review_revision = ? WHERE tenant_id = ?', 'r2', tenant);
    expect(readReview(storage, tenant, token).mark.decision).toBe('ignored');
    expect(set(null, 3).decision).toBeNull();
    expect(() => set('passed', 4)).toThrow('evidence_changed');
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
    expect(() => write('note', 'gmgn_secret', 2)).toThrow('sensitive_input');
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
