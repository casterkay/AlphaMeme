import { RadarAgent } from './radar-agent.mjs';
import { TenantRegistry } from './tenant-registry.mjs';
import { isAuthorizedBearer, isAuthorizedTelegramWebhookSecret } from './worker-auth.mjs';
import { normalizeTenantId } from './storage/gmgn-admission-state.mjs';
import { parseTelegramUpdate } from './telegram-intake.mjs';
import { callWorkerRpc } from './worker-rpc.mjs';

const MAX_TELEGRAM_UPDATE_BYTES = 256 * 1024;

export { RadarAgent, TenantRegistry };

function json(value, init = {}) {
  return Response.json(value, {
    ...init,
    headers: { 'cache-control': 'no-store', ...(init.headers || {}) }
  });
}

function methodNotAllowed() {
  return json({ error: 'method_not_allowed' }, { status: 405, headers: { allow: 'GET' } });
}

function operatorStatus(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.lifecycle !== 'string' || !Number.isSafeInteger(value.schemaVersion)
    || !value.gmgnAdmission || typeof value.gmgnAdmission !== 'object' || Array.isArray(value.gmgnAdmission)) {
    throw new Error('Radar status has an unsupported shape');
  }
  const admission = value.gmgnAdmission;
  if (!Number.isSafeInteger(admission.nextAllowedAt) || !Number.isSafeInteger(admission.spacingReadyAt)
    || !Number.isFinite(admission.backoffFactor) || !Number.isSafeInteger(admission.keyEpoch)) {
    throw new Error('Radar admission status has an unsupported shape');
  }
  return {
    lifecycle: value.lifecycle,
    schemaVersion: value.schemaVersion,
    gmgnAdmission: {
      nextAllowedAt: admission.nextAllowedAt,
      spacingReadyAt: admission.spacingReadyAt,
      backoffFactor: admission.backoffFactor,
      keyEpoch: admission.keyEpoch
    }
  };
}

function tenantIdFromSearch(url) {
  const tenantId = url.searchParams.get('tenant_id');
  if (!tenantId) return null;
  try {
    return normalizeTenantId(tenantId);
  } catch {
    return null;
  }
}

async function operatorAuthorized(request, env) {
  return isAuthorizedBearer(request.headers.get('authorization'), env.OPERATOR_TOKEN);
}

async function telegramWebhookAuthorized(request, env) {
  return isAuthorizedTelegramWebhookSecret(request.headers.get('x-telegram-bot-api-secret-token'), env.TELEGRAM_WEBHOOK_SECRET);
}

async function readBoundedJson(request) {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_TELEGRAM_UPDATE_BYTES)) return null;
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_TELEGRAM_UPDATE_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(concatenate(chunks, length)));
  } catch {
    return null;
  }
}

function concatenate(chunks, length) {
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/health') {
        if (request.method !== 'GET') return methodNotAllowed();
        if (!(await operatorAuthorized(request, env))) return json({ error: 'unauthorized' }, { status: 401 });
        return json({ ok: true, service: 'meme-radar', lifecycle: 'SKELETON' });
      }

      if (url.pathname === '/status') {
        if (request.method !== 'GET') return methodNotAllowed();
        if (!(await operatorAuthorized(request, env))) return json({ error: 'unauthorized' }, { status: 401 });
        const tenantId = tenantIdFromSearch(url);
        if (!tenantId) return json({ error: 'tenant_id_required' }, { status: 400 });
        const id = env.RADAR.idFromName('radar:' + tenantId);
        return json(operatorStatus(await callWorkerRpc(() => env.RADAR.get(id).getStatus(tenantId))));
      }

      if (url.pathname === '/webhook/telegram') {
        if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, { status: 405, headers: { allow: 'POST' } });
        if (!(await telegramWebhookAuthorized(request, env))) return json({ error: 'forbidden' }, { status: 403 });
        const update = await readBoundedJson(request);
        const parsed = parseTelegramUpdate(update, { botUsername: env.TELEGRAM_BOT_USERNAME });
        if (!['accepted', 'credential'].includes(parsed.kind)) return json({ accepted: false });

        const registry = env.TENANT_REGISTRY.getByName('tenant-registry');
        await callWorkerRpc(() => registry.registerTenant(parsed.receipt.tenantId));
        const radar = env.RADAR.get(env.RADAR.idFromName(`radar:${parsed.receipt.tenantId}`));
        const result = await callWorkerRpc(() => parsed.kind === 'credential'
          ? radar.receiveTelegramCredential(parsed.receipt, parsed.credentialText)
          : radar.receiveTelegramUpdate(parsed.receipt));
        return json({ accepted: result.accepted === true });
      }

      return json({ error: 'not_found' }, { status: 404 });
    } catch (error) {
      console.error(JSON.stringify({ event: 'worker_request_failed', path: url.pathname, errorType: error instanceof Error ? error.name : 'unknown' }));
      return json({ error: 'internal_error' }, { status: 500 });
    }
  },

  async scheduled(controller, env) {
    const registry = env.TENANT_REGISTRY.getByName('tenant-registry');
    const result = await callWorkerRpc(() => registry.scheduledWake());
    console.log(JSON.stringify({ event: 'scheduler_watchdog', cron: controller.cron, ...result }));
  }
};
