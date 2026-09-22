import { createdAt } from './scoring/index.mjs';
import { classifyDeepResult, mergeSecondaryClassification } from './scoring/classification.mjs';
import { sha256Hex } from './util/crypto.mjs';

const RESERVED_X_PATHS = new Set([
  'home', 'explore', 'search', 'intent', 'share', 'i', 'messages', 'notifications', 'settings'
]);

function numberOrNull(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function num(value, fallback = 0) {
  return numberOrNull(value) ?? fallback;
}

function first(...values) {
  return values.find(value => value !== undefined && value !== null && value !== '');
}

// EVM addresses are case-insensitive. Solana addresses are base58 and
// case-sensitive, so globally lower-casing every chain can merge distinct mints.
export function addressKey(value) {
  const address = String(value ?? '').trim();
  return /^0x[0-9a-f]{40}$/i.test(address) ? address.toLowerCase() : address;
}

export function twitterHandle(value) {
  const source = String(value || '').trim();
  if (!source) return '';
  const withoutHost = source.replace(/^(?:https?:\/\/)?(?:www\.)?(?:twitter|x)\.com\//i, '');
  const handle = withoutHost.replace(/^@/, '').split(/[/?#]/)[0];
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) return '';
  if (RESERVED_X_PATHS.has(handle.toLowerCase())) return '';
  return handle;
}

export async function reviewRevision(candidate) {
  const security = candidate.deep?.security || {};
  return (await sha256Hex(JSON.stringify({
    status: candidate.status, checks: candidate.deep?.checks, failed: candidate.deep?.failed,
    owner: security.ownerRenounced, mint: security.renouncedMint, freeze: security.renouncedFreezeAccount,
    honeypot: security.honeypot, buyTax: security.buyTax, sellTax: security.sellTax,
    lock: security.lockRate, burned: security.lpBurned,
    secondary: candidate.secondary?.security?.verdict, conflicts: candidate.secondary?.conflicts,
    website: candidate.info?.website, twitter: candidate.info?.twitter
  }))).slice(0, 24);
}

export function publicToken(row, screen, chain) {
  const twitter = first(row.twitter, row.twitter_username, row.link?.twitter_username) || '';
  const duplicateValue = first(row.twitter_dup, row.social_dup);
  const duplicateSocial = ['1', 'true', 'yes'].includes(String(duplicateValue ?? '').toLowerCase());
  return {
    address: String(row.address),
    chain,
    symbol: String(row.symbol || '?').slice(0, 30),
    name: String(row.name || '').slice(0, 80),
    marketCap: screen.mc,
    liquidity: screen.liquidity,
    price: numberOrNull(first(row.price, row.price_usd, row.usd_price)),
    createdAt: createdAt(row),
    ageSec: screen.ageSec,
    priorityBand: screen.priorityBand,
    discoveryScore: screen.score,
    holders: num(row.holder_count),
    volume1h: num(first(row.volume_1h, row.volume)),
    buys: num(first(row.buys_24h, row.buys)),
    sells: num(first(row.sells_24h, row.sells)),
    twitter: twitterHandle(twitter),
    gmgnUrl: String(row.link?.gmgn || ''),
    socialHints: {
      followerCount: num(first(row.x_user_follower, row.x_follower)),
      duplicateSocial
    }
  };
}

export function socialGate({ twitter, followerCount = 0, duplicateSocial = null, capability }) {
  if (!twitter) return { status: 'FAIL', score: 0, reason: '没有X账号' };
  if (duplicateSocial === true) return { status: 'FAIL', score: 0, reason: '社媒链接疑似复用' };
  if (!capability?.available) {
    return { status: 'UNVERIFIED', score: 0, reason: capability?.reason || '无法读取X评论，不能确认真人社区' };
  }
  return {
    status: 'UNVERIFIED', score: 0,
    reason: `已检测到X后端${capability.backend}，评论真实性解析器尚未完成联调`
  };
}

export function socialFrom(token) {
  return {
    twitter: token.twitter,
    ...socialGate({
      twitter: token.twitter,
      followerCount: token.socialHints.followerCount,
      duplicateSocial: token.socialHints.duplicateSocial,
      capability: { available: false, mode: 'manual', reason: '当前采用X人工复核模式' }
    })
  };
}

function queueSort(a, b) {
  return Number(b.priorityBand) - Number(a.priorityBand)
    || num(a.firstSeenAt) - num(b.firstSeenAt)
    || num(b.score) - num(a.score);
}

export function selectAuditQueue(queue, availableAddresses, now, cycleNumber, limit) {
  const available = new Set([...availableAddresses].map(addressKey));
  const due = queue.filter(item => available.has(addressKey(item.address)) && num(item.nextAuditAt) <= now);
  const never = due.filter(item => !num(item.lastAuditedAt)).sort(queueSort);
  const rechecks = due.filter(item => num(item.lastAuditedAt)).sort(queueSort);
  const selected = [];
  while (selected.length < limit && (never.length || rechecks.length)) {
    const slot = cycleNumber + selected.length;
    const urgent = rechecks.findIndex(row => row.status === 'X_REVIEW' || row.watched);
    if (urgent >= 0 && slot % 3 !== 1) selected.push(...rechecks.splice(urgent, 1));
    else if (slot % 5 === 0 && never.length) {
      // Reserve a fairness slot so lower-priority tokens are not starved forever.
      const oldest = never.reduce((a, b) => num(a.firstSeenAt) < num(b.firstSeenAt) ? a : b);
      selected.push(...never.splice(never.indexOf(oldest), 1));
    } else selected.push((slot % 3 === 0 ? rechecks.shift() : never.shift()) || rechecks.shift() || never.shift());
  }
  return selected.filter(Boolean);
}

export function nextAuditDelay(status, settings) {
  if (status === 'HARD_REJECT') return settings.hardRejectRecheckMs;
  if (status === 'X_REVIEW') return settings.chainPassRecheckMs;
  return settings.dynamicRecheckMs;
}

export function buildQueue(previous, prequalified, now, settings) {
  const byAddress = new Map((previous || []).map(item => [addressKey(item.address), { ...item }]));
  for (const { row, screen } of prequalified) {
    const address = addressKey(row.address);
    const old = byAddress.get(address);
    byAddress.set(address, {
      address: String(row.address),
      firstSeenAt: num(old?.firstSeenAt, now),
      lastSeenAt: now,
      lastAuditedAt: num(old?.lastAuditedAt),
      nextAuditAt: num(old?.nextAuditAt),
      attempts: num(old?.attempts),
      status: old?.status || 'QUEUED',
      priorityBand: Boolean(screen.priorityBand),
      score: screen.score,
      watched: Boolean(row._monitorOnly)
    });
  }
  return [...byAddress.values()].filter(item => now - num(item.lastSeenAt, item.firstSeenAt) <= settings.queueRetentionMs);
}

export { classifyDeepResult, mergeSecondaryClassification };
