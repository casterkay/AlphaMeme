import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeGmgnApiKey } from './gmgn-key-store.mjs';
import { secondaryChainSupport } from './providers/secondary.mjs';
import { publicCandidate, publicMessage, toPublicStatus } from './render/whitelist.mjs';
import { tokenKey } from './storage/controls.mjs';
import { CHART_RISK_VERSION } from './scoring/chart-risk.mjs';

export { toPublicStatus } from './render/whitelist.mjs';

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const CHAIN_IDS = new Set(['sol', 'bsc', 'base', 'eth', 'robinhood', 'arc', 'stable']);
function finite(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function finiteOrNull(value) {
  const parsed = Number(value);
  return value !== null && value !== undefined && value !== '' && Number.isFinite(parsed) ? parsed : null;
}

function countSummary(source, allowedKeys) {
  const result = {};
  for (const key of allowedKeys) {
    if (source?.[key] !== undefined) result[key] = finite(source[key]);
  }
  return result;
}

function text(value, maxLength = 160) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLength);
}

export function voiceSnapshot(state, enabledChains) {
  const scopes = { ...state.chainStates, [state.activeChain]: state };
  return { chains: Object.fromEntries(enabledChains.filter(chain => CHAIN_IDS.has(chain)).map(chain => [chain,
    (scopes[chain]?.candidates || []).slice(0, 200).map(row => ({ chain, address: text(row.address, 80),
      status: text(row.status, 32), auditedAt: finite(row.auditedAt), staleAt: finite(row.staleAt),
      qualified: row.status === 'X_REVIEW' && row.deep?.chainPass === true && !row.auditError
        && row.auditHealth?.complete !== false && row.deep?.chartRisk?.pass === true
        && row.deep?.chartRisk?.version === CHART_RISK_VERSION
        && !state.riskExclusions?.[tokenKey(chain, row.address)]
    }))])) };
}

function inlineHashes(html, tagName) {
  const hashes = [];
  const pattern = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, 'gi');
  for (const match of html.matchAll(pattern)) {
    const digest = crypto.createHash('sha256').update(match[1], 'utf8').digest('base64');
    hashes.push(`'sha256-${digest}'`);
  }
  return hashes;
}

function contentSecurityPolicy(html) {
  const scripts = inlineHashes(html, 'script');
  const styles = inlineHashes(html, 'style');
  return [
    "default-src 'none'",
    "base-uri 'none'",
    `script-src 'self' ${scripts.join(' ')}`.trim(),
    "script-src-attr 'none'",
    `style-src 'self' ${styles.join(' ')}`.trim(),
    "style-src-attr 'none'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "media-src 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
    "worker-src 'none'",
    "manifest-src 'self'"
  ].join('; ');
}

function headers(type, csp) {
  return {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Content-Security-Policy': csp
  };
}

function allowedHosts(port) {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
}

export function isTrustedLocalRequest(req, settings) {
  if (!LOOPBACK_ADDRESSES.has(String(req.socket?.remoteAddress || ''))) return false;
  const hosts = allowedHosts(settings.port);
  const host = String(req.headers?.host || '').toLowerCase();
  if (!hosts.has(host)) return false;

  const origin = req.headers?.origin;
  if (origin) {
    let originHost;
    try {
      const parsed = new URL(String(origin));
      if (parsed.protocol !== 'http:') return false;
      originHost = parsed.host.toLowerCase();
    } catch {
      return false;
    }
    if (!hosts.has(originHost) || originHost !== host) return false;
  }

  const fetchSite = String(req.headers?.['sec-fetch-site'] || '').toLowerCase();
  if (!fetchSite || fetchSite === 'same-origin' || fetchSite === 'none') return true;
  // A link from another website/app is a cross-site top-level navigation, not
  // a cross-origin API request. Only the static landing document is public in
  // this narrow case; loopback, Host and explicit Origin checks still apply.
  if (!['cross-site', 'same-site'].includes(fetchSite) || req.method !== 'GET'
    || req.headers?.['sec-fetch-mode'] !== 'navigate' || req.headers?.['sec-fetch-dest'] !== 'document') return false;
  try {
    const target = new URL(req.url, `http://${host}`);
    return target.origin === `http://${host}` && ['/', '/index.html'].includes(target.pathname);
  } catch { return false; }
}

export function healthSnapshot(source = {}, settings, now = Date.now()) {
  const interval = finite(settings.scanIntervalMs, 120_000);
  const maxAgeMs = Math.max(5 * 60_000, Math.min(60 * 60_000, interval * 3));
  const lastSuccessAt = finite(source.lastSuccessAt || source.generatedAt);
  const ageMs = lastSuccessAt > 0 ? Math.max(0, now - lastSuccessAt) : null;
  const fresh = ageMs !== null && ageMs <= maxAgeMs;
  const status = text(source.status, 32) || 'STARTING';
  const ready = status === 'RUNNING' && fresh;
  return {
    ok: true,
    service: 'meme-radar',
    instanceId: crypto.createHash('sha256').update(String(settings.publicDir)).digest('hex').slice(0, 16),
    ready,
    degraded: !ready,
    scanner: {
      status,
      fresh,
      scanInProgress: source.scanInProgress === true,
      cycleStartedAt: finite(source.cycleStartedAt),
      lastSuccessAt,
      ageMs,
      maxAgeMs
    },
    execution: false
  };
}

function sendJson(res, statusCode, value, csp) {
  const body = JSON.stringify(value);
  res.writeHead(statusCode, { ...headers('application/json; charset=utf-8', csp), 'Content-Length': new TextEncoder().encode(body).byteLength });
  res.end(body);
}

function bodyError(code, message) {
  const error = new Error(message);
  error.statusCode = code;
  return error;
}

function readSmallJson(req, maxBytes = 1024) {
  const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') return Promise.reject(bodyError(415, 'json_required'));
  const declaredLength = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) return Promise.reject(bodyError(413, 'body_too_large'));

  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', chunk => {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      size += bytes.byteLength;
      if (size > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
      } else if (!tooLarge) chunks.push(bytes);
    });
    req.on('end', () => {
      if (tooLarge) return reject(bodyError(413, 'body_too_large'));
      try {
        const body = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          body.set(chunk, offset);
          offset += chunk.byteLength;
        }
        const parsed = JSON.parse(new TextDecoder().decode(body));
        resolve(parsed);
      } catch {
        reject(bodyError(400, 'invalid_json'));
      }
    });
    req.on('error', () => reject(bodyError(400, 'invalid_request')));
  });
}

function allowedChainIds(supportedChains) {
  const configured = Array.isArray(supportedChains)
    ? supportedChains.map(value => text(value, 32)).filter(value => CHAIN_IDS.has(value))
    : [];
  return new Set(configured.length ? configured : CHAIN_IDS);
}

export function createServer({ state, settings, controls, switchChain, saveGmgnKey, disconnectGmgnKey, getGmgnOnboarding, getGmgnConnection, liveDiscovery, enqueueReview, supportedChains = [] }) {
  const dashboard = path.join(settings.publicDir, 'index.html');
  const dashboardHtml = fs.readFileSync(dashboard, 'utf8');
  const csp = contentSecurityPolicy(dashboardHtml);

  const server = http.createServer(async (req, res) => {
    if (!isTrustedLocalRequest(req, settings)) {
      return sendJson(res, 403, { error: 'local_request_required' }, csp);
    }

    let url;
    try {
      url = new URL(req.url, `http://127.0.0.1:${settings.port}`);
    } catch {
      return sendJson(res, 400, { error: 'bad_request' }, csp);
    }

    if (req.method === 'POST' && ['/api/live-discovery', '/api/live-review'].includes(url.pathname)) {
      if (!req.headers.origin) return sendJson(res, 403, { error: 'local_request_required' }, csp);
      if (!liveDiscovery) return sendJson(res, 503, { error: 'live_unavailable' }, csp);
      try {
        const body = await readSmallJson(req, 512);
        const keys = url.pathname === '/api/live-review' ? 'address,chain' : 'chain';
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== keys
          || !allowedChainIds(supportedChains).has(body.chain)) return sendJson(res, 400, { error: 'invalid_live_request' }, csp);
        if (url.pathname === '/api/live-review') {
          if (typeof body.address !== 'string' || body.address.length > 80 || !enqueueReview) return sendJson(res, 400, { error: 'invalid_live_request' }, csp);
          const row = liveDiscovery.auditRow(body.chain, body.address);
          const result = row ? enqueueReview(body.chain, row) : { accepted: false, reason: 'snapshot_expired' };
          return sendJson(res, result.accepted ? 200 : 409, result, csp);
        }
        const snapshot = liveDiscovery.touch(body.chain);
        const scope = state.value.activeChain === body.chain ? state.value : state.value.chainStates?.[body.chain] || {};
        const key = address => body.chain === 'sol' ? address : address.toLowerCase();
        const audits = new Map((scope.candidates || []).map(row => [key(row.address), row]));
        snapshot.rows = snapshot.rows.filter(row => !state.value.riskExclusions?.[tokenKey(body.chain, row.address)]).map(row => {
          const audit = audits.get(key(row.address));
          return { ...row, audit: audit ? { status: publicCandidate(audit).status, at: finite(audit.auditedAt) } : null };
        });
        return sendJson(res, 200, snapshot, csp);
      } catch (error) {
        return sendJson(res, [400, 413, 415].includes(error?.statusCode) ? error.statusCode : 500, { error: 'live_request_failed' }, csp);
      }
    }

    if (req.method === 'POST' && ['/api/scan-chains', '/api/annotation', '/api/gmgn-disconnect'].includes(url.pathname)) {
      if (!req.headers.origin) return sendJson(res, 403, { error: 'local_request_required' }, csp);
      try {
        const body = await readSmallJson(req, 4096);
        if (!body || typeof body !== 'object' || Array.isArray(body)) return sendJson(res, 400, { error: 'invalid_settings' }, csp);
        if (url.pathname === '/api/gmgn-disconnect') {
          if (Object.keys(body).length || !disconnectGmgnKey) return sendJson(res, 400, { error: 'invalid_settings' }, csp);
          return sendJson(res, 200, await disconnectGmgnKey(), csp);
        }
        if (!controls) return sendJson(res, 503, { error: 'settings_unavailable' }, csp);
        if (url.pathname === '/api/scan-chains') {
          if (Object.keys(body).length !== 1) return sendJson(res, 400, { error: 'invalid_settings' }, csp);
          return sendJson(res, 200, controls.setChains(body.chains), csp);
        }
        if (Object.keys(body).sort().join(',') !== 'address,chain,favorite,note') return sendJson(res, 400, { error: 'invalid_settings' }, csp);
        return sendJson(res, 200, controls.annotate(body), csp);
      } catch (error) { return sendJson(res, error?.statusCode === 400 ? 400 : 500, { error: 'settings_not_saved' }, csp); }
    }

    if (url.pathname === '/api/gmgn-key' && req.method === 'POST') {
      if (!req.headers.origin) return sendJson(res, 403, { error: 'gmgn_key_request_rejected' }, csp);
      if (typeof saveGmgnKey !== 'function') return sendJson(res, 503, { error: 'gmgn_key_request_rejected' }, csp);
      try {
        const body = await readSmallJson(req, 512);
        if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).length !== 1 || typeof body.apiKey !== 'string') {
          return sendJson(res, 400, { error: 'gmgn_key_request_rejected' }, csp);
        }
        const apiKey = normalizeGmgnApiKey(body.apiKey);
        if (!apiKey) return sendJson(res, 400, { error: 'gmgn_key_request_rejected' }, csp);
        const result = await saveGmgnKey(apiKey);
        if (result?.verified !== true || result?.configured !== true) {
          return sendJson(res, 502, { error: 'gmgn_verification_failed' }, csp);
        }
        return sendJson(res, 200, { accepted: true, configured: true, verified: true }, csp);
      } catch (error) {
        const safeErrors = {
          GMGN_AUTH_FAILED: [401, 'gmgn_auth_failed'],
          GMGN_PERMISSION_DENIED: [403, 'gmgn_permission_denied'],
          GMGN_RATE_LIMITED: [429, 'gmgn_rate_limited'],
          GMGN_RATE_LIMIT_BLOCKED: [429, 'gmgn_rate_limit_blocked'],
          GMGN_CHECK_BUSY: [409, 'gmgn_check_busy'],
          GMGN_TIMEOUT: [504, 'gmgn_timeout'],
          GMGN_NETWORK_ERROR: [502, 'gmgn_network_error'],
          GMGN_DEPENDENCY_MISSING: [503, 'gmgn_dependency_missing'],
          GMGN_ONBOARDING_REQUIRED: [409, 'gmgn_onboarding_required'],
          GMGN_SIGNING_KEY_FAILED: [500, 'gmgn_signing_key_failed']
        };
        const safe = safeErrors[error?.code];
        if (safe) {
          const body = { error: safe[1] };
          if (error?.code === 'GMGN_RATE_LIMITED' || error?.code === 'GMGN_RATE_LIMIT_BLOCKED') {
            body.retryAfterSeconds = Math.max(1, Math.min(300, Math.ceil((Number(error.retryAfterMs) || 30_000) / 1000)));
          }
          return sendJson(res, safe[0], body, csp);
        }
        const statusCode = [400, 413, 415].includes(error?.statusCode) ? error.statusCode : 500;
        return sendJson(res, statusCode, { error: 'gmgn_key_request_rejected' }, csp);
      }
    }

    if (url.pathname === '/api/gmgn-onboarding' && req.method === 'POST') {
      if (!req.headers.origin || typeof getGmgnOnboarding !== 'function') {
        return sendJson(res, 403, { error: 'gmgn_onboarding_rejected' }, csp);
      }
      try {
        const body = await readSmallJson(req, 64);
        if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).sort().join(',') !== 'regenerate'
          || typeof body.regenerate !== 'boolean') {
          return sendJson(res, 400, { error: 'gmgn_onboarding_rejected' }, csp);
        }
        const value = getGmgnOnboarding({ regenerate: body.regenerate });
        if (value?.algorithm !== 'Ed25519'
          || !/^-----BEGIN PUBLIC KEY-----[\s\S]+-----END PUBLIC KEY-----\s*$/.test(value?.publicKey || '')) {
          return sendJson(res, 500, { error: 'gmgn_onboarding_failed' }, csp);
        }
        const createUrl = new URL(value.createUrl);
        if (createUrl.protocol !== 'https:' || createUrl.hostname !== 'gmgn.ai' || createUrl.pathname !== '/ai/generateapi') {
          return sendJson(res, 500, { error: 'gmgn_onboarding_failed' }, csp);
        }
        return sendJson(res, 200, { algorithm: 'Ed25519', publicKey: value.publicKey, createUrl: createUrl.href }, csp);
      } catch {
        return sendJson(res, 500, { error: 'gmgn_onboarding_failed' }, csp);
      }
    }

    if (url.pathname === '/api/active-chain' && req.method === 'POST') {
      if (typeof switchChain !== 'function') return sendJson(res, 503, { error: 'chain_switch_unavailable' }, csp);
      try {
        const body = await readSmallJson(req);
        if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).length !== 1 || typeof body.chain !== 'string') {
          return sendJson(res, 400, { error: 'invalid_chain_request' }, csp);
        }
        const chain = text(body.chain, 32).toLowerCase();
        if (!allowedChainIds(supportedChains).has(chain)) return sendJson(res, 422, { error: 'unsupported_chain' }, csp);
        const result = await switchChain(chain);
        const returnedActive = text(result?.activeChain, 32).toLowerCase();
        const returnedPending = text(result?.pendingChain, 32).toLowerCase();
        return sendJson(res, 202, {
          accepted: true,
          requestedChain: chain,
          activeChain: CHAIN_IDS.has(returnedActive) ? returnedActive : chain,
          pendingChain: CHAIN_IDS.has(returnedPending) ? returnedPending : '',
          queued: result?.queued === true
        }, csp);
      } catch (error) {
        const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
        const publicCode = statusCode === 500 ? 'chain_switch_failed' : text(error.message, 48);
        return sendJson(res, statusCode, { error: publicCode }, csp);
      }
    }

    if (req.method !== 'GET') return sendJson(res, 405, { error: 'read_only_scanner' }, csp);
    if (url.pathname === '/api/status' || url.pathname === '/api/export') {
      const snapshot = getGmgnConnection?.();
      const gmgnConnection = {
        configured: snapshot?.configured === true,
        status: ['CHECKING', 'UNCONFIGURED', 'VERIFIED', 'CONFIGURED'].includes(snapshot?.status) ? snapshot.status : 'UNCONFIGURED'
      };
      const chain = url.searchParams.get('chain');
      if (chain && !CHAIN_IDS.has(chain)) return sendJson(res, 400, { error: 'unsupported_chain' }, csp);
      const selected = chain && chain !== state.value.activeChain
        ? { status: 'STARTING', candidates: [], ...state.value.chainStates?.[chain], activeChain: chain,
          supportedChains: state.value.supportedChains, events: state.value.events, riskExclusions: state.value.riskExclusions,
          policy: { ...state.value.policy, chain }, scanInProgress: false }
        : state.value;
      const annotations = Object.fromEntries(Object.entries(controls?.value.annotations || {}).slice(0, 500).map(([key, value]) => [key, {
        chain: text(value.chain, 32), address: text(value.address, 128), favorite: value.favorite === true,
        note: publicMessage(value.note, '[redacted]', 500), updatedAt: finite(value.updatedAt)
      }]));
      const output = { ...toPublicStatus(selected), gmgnConnection, annotations,
        voiceSnapshot: voiceSnapshot(state.value, controls?.value.enabledChains || [state.value.activeChain]),
        scheduler: { scanningChain: text(state.value.activeChain, 32), enabledChains: controls?.value.enabledChains || [state.value.activeChain],
          lastSuccessAt: finite(state.value.lastSuccessAt), status: text(state.value.status, 32) },
        coverage: Object.fromEntries([...CHAIN_IDS].map(id => [id, {
          dexScreener: Boolean(secondaryChainSupport.dexScreener[id]), goPlus: Boolean(secondaryChainSupport.goPlus[id])
        }])),
        requestMetrics: countSummary(state.value.requestMetrics || {}, ['requests', 'cacheHits', 'rateLimits', 'cooldownUntil'])
      };
      if (url.pathname === '/api/export') {
        const scopes = { ...state.value.chainStates, [state.value.activeChain]: state.value };
        output.exportedAt = Date.now();
        output.chains = Object.fromEntries(Object.entries(scopes).filter(([id]) => CHAIN_IDS.has(id)).map(([id, scope]) => [id, {
          ...toPublicStatus({ ...scope, activeChain: id, riskExclusions: state.value.riskExclusions }),
          outcomes: (scope.outcomes || []).slice(0, 1000).map(row => ({
            address: text(row.address, 128), symbol: publicMessage(row.symbol, '?', 30), chain: id,
            baselineAt: finite(row.baselineAt), baselinePrice: finiteOrNull(row.baselinePrice),
            initialDecision: text(row.initialDecision, 32), latestDecision: text(row.latestDecision, 32),
            samples: Object.fromEntries(['m5','m15','m30','h1','h2','h6','h24'].map(key => [key, row.samples?.[key] ? {
              at: finite(row.samples[key].at), targetAt: finite(row.samples[key].targetAt),
              source: text(row.samples[key].source, 32), price: finiteOrNull(row.samples[key].price), return: finiteOrNull(row.samples[key].return)
            } : null]))
          }))
        }]));
        res.setHeader('Content-Disposition', 'attachment; filename="meme-radar-records.json"');
      }
      return sendJson(res, 200, output, csp);
    }
    if (url.pathname === '/health') return sendJson(res, 200, healthSnapshot(state.value, settings), csp);
    const assets = { '/voice-ui.mjs': ['voice-ui.mjs', 'text/javascript; charset=utf-8'],
      '/voice-alerts.mjs': ['voice-alerts.mjs', 'text/javascript; charset=utf-8'],
      '/voice-player.mjs': ['voice-player.mjs', 'text/javascript; charset=utf-8'],
      '/manual-review.mjs': [new URL('./scoring/manual-review.mjs', import.meta.url), 'text/javascript; charset=utf-8'] };
    if (Object.hasOwn(assets, url.pathname)) {
      const [relative, type] = assets[url.pathname];
      try {
        const content = fs.readFileSync(typeof relative === 'string' ? path.join(settings.publicDir, relative) : relative);
        res.writeHead(200, { ...headers(type, csp), 'Content-Length': content.length });
        return res.end(content);
      } catch { return sendJson(res, 404, { error: 'asset_not_found' }, csp); }
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { ...headers('text/html; charset=utf-8', csp), 'Content-Length': new TextEncoder().encode(dashboardHtml).byteLength });
      return res.end(dashboardHtml);
    }
    return sendJson(res, 404, { error: 'not_found' }, csp);
  });
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });
  return server;
}
