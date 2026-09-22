import { backendDisposition, effectiveStatus } from '../scoring/manual-review.mjs';

export class ReviewConflict extends Error {
  constructor(code) { super(code); this.name = 'ReviewConflict'; this.code = code; }
}

export function tokenIdentity({ chain, address }) {
  if (!['sol','eth','base','bsc','robinhood','arc','stable'].includes(chain) || typeof address !== 'string'
    || !(chain === 'sol' ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ : /^0x[0-9a-f]{40}$/i).test(address)) throw new ReviewConflict('invalid_token');
  return { chain, address: chain === 'sol' ? address : address.toLowerCase() };
}

export function readReview(storage, tenantId, token) {
  const { chain, address } = tokenIdentity(token);
  const row = storage.sql.exec('SELECT * FROM candidates WHERE tenant_id = ? AND chain = ? AND address = ?', tenantId, chain, address).toArray()[0];
  const stored = storage.sql.exec('SELECT * FROM manual_marks WHERE tenant_id = ? AND chain = ? AND address = ?', tenantId, chain, address).toArray()[0];
  const candidate = row ? { chain, address, status: row.status, auditedAt: row.audited_at, reviewRevision: row.review_revision, deep: row.deep_json ? JSON.parse(row.deep_json) : null } : null;
  const mark = stored ? { decision: stored.decision, at: stored.marked_at, reviewRevision: stored.review_revision, version: stored.mark_version } : { decision: null, at: null, reviewRevision: null, version: 0 };
  return { candidate, mark };
}

/** The caller atomically completes its inbox and records correction intent around this write. */
export function setManualMarkInTransaction(storage, tenantId, { token, decision, expectedMarkVersion, reviewRevision }, now) {
  const { chain, address } = tokenIdentity(token);
  if (![null, 'passed', 'ignored'].includes(decision) || !Number.isSafeInteger(expectedMarkVersion)) throw new ReviewConflict('invalid_mark');
  const { candidate, mark } = readReview(storage, tenantId, token);
  if (expectedMarkVersion !== mark.version) throw new ReviewConflict('mark_changed');
  if (decision !== null && candidate?.reviewRevision !== reviewRevision) throw new ReviewConflict('evidence_changed');
  if (decision === 'passed') {
    if (!candidate || mark.decision === 'ignored' || !reviewRevision || backendDisposition(candidate) !== 'chain'
      || !Number.isSafeInteger(candidate.auditedAt) || candidate.auditedAt > now || now - candidate.auditedAt > 600_000) throw new ReviewConflict('approval_unavailable');
  }
  const nextVersion = mark.version + 1;
  if (!Number.isSafeInteger(nextVersion)) throw new ReviewConflict('mark_version_exhausted');
  storage.sql.exec('INSERT INTO manual_marks (tenant_id, chain, address, decision, marked_at, review_revision, mark_version) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(tenant_id, chain, address) DO UPDATE SET decision = excluded.decision, marked_at = excluded.marked_at, review_revision = excluded.review_revision, mark_version = excluded.mark_version', tenantId, chain, address, decision, now, candidate?.reviewRevision ?? null, nextVersion);
  return { decision, at: now, reviewRevision: candidate?.reviewRevision ?? null, version: nextVersion };
}

export function annotationVersion(storage, tenantId, token, field) {
  const { chain, address } = tokenIdentity(token);
  if (!['favorite', 'note'].includes(field)) throw new ReviewConflict('invalid_annotation_field');
  const key = `telegram.annotation-version:${chain}:${address}:${field}`;
  const row = storage.sql.exec('SELECT value_json FROM preferences WHERE tenant_id = ? AND key = ?', tenantId, key).toArray()[0];
  const version = row ? JSON.parse(row.value_json) : 0;
  if (!Number.isSafeInteger(version) || version < 0) throw new ReviewConflict('annotation_version_corrupt');
  return { key, version };
}

export function annotateInTransaction(storage, tenantId, { token, field, value, expectedVersion }, now) {
  const { chain, address } = tokenIdentity(token);
  const { key, version } = annotationVersion(storage, tenantId, token, field);
  if (version !== expectedVersion) throw new ReviewConflict('annotation_changed');
  if (field === 'favorite' && typeof value !== 'boolean') throw new ReviewConflict('invalid_favorite');
  if (field === 'note' && (typeof value !== 'string' || value.length > 500)) throw new ReviewConflict('note_too_long');
  if (field === 'note' && /gmgn_|-----BEGIN .*PRIVATE KEY-----/i.test(value)) throw new ReviewConflict('sensitive_input');
  const old = storage.sql.exec('SELECT favorite, note FROM annotations WHERE tenant_id = ? AND chain = ? AND address = ?', tenantId, chain, address).toArray()[0];
  const next = { favorite: Boolean(old?.favorite), note: old?.note ?? '', [field]: field === 'note' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '') : value };
  if (next.favorite && !old?.favorite && storage.sql.exec('SELECT COUNT(*) AS n FROM annotations WHERE tenant_id = ? AND favorite = 1', tenantId).toArray()[0].n >= 50) throw new ReviewConflict('favorite_limit');
  if (!old && (next.favorite || next.note.trim()) && storage.sql.exec('SELECT COUNT(*) AS n FROM annotations WHERE tenant_id = ?', tenantId).toArray()[0].n >= 500) throw new ReviewConflict('annotation_limit');
  if (!next.favorite && !next.note.trim()) storage.sql.exec('DELETE FROM annotations WHERE tenant_id = ? AND chain = ? AND address = ?', tenantId, chain, address);
  else storage.sql.exec('INSERT INTO annotations (tenant_id, chain, address, favorite, note, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(tenant_id, chain, address) DO UPDATE SET favorite = excluded.favorite, note = excluded.note, updated_at = excluded.updated_at', tenantId, chain, address, Number(next.favorite), next.note, now);
  if (!Number.isSafeInteger(version + 1)) throw new ReviewConflict('annotation_version_exhausted');
  storage.sql.exec('INSERT INTO preferences (tenant_id, key, value_json) VALUES (?, ?, ?) ON CONFLICT(tenant_id, key) DO UPDATE SET value_json = excluded.value_json', tenantId, key, JSON.stringify(version + 1));
  return { ...next, version: version + 1 };
}

/** Projection revision includes time-derived approval validity, even without a new audit. */
export function reviewProjectionRevision(storage, tenantId, token, now) {
  const { candidate, mark } = readReview(storage, tenantId, token);
  return JSON.stringify([candidate?.reviewRevision ?? null, mark.version, candidate ? effectiveStatus(candidate, mark, now) : mark.decision === 'ignored' ? 'ignored' : 'historical', annotationVersion(storage, tenantId, token, 'favorite').version, annotationVersion(storage, tenantId, token, 'note').version]);
}

export function nextReviewExpiry(storage, tenantId, token, now) {
  const { candidate, mark } = readReview(storage, tenantId, token);
  if (!candidate || effectiveStatus(candidate, mark, now) !== 'passed') return null;
  return Math.min(mark.at + 86_400_000, candidate.auditedAt + 600_001);
}
