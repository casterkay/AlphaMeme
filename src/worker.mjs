import { RadarAgent } from './radar-agent.mjs';
import { TenantRegistry } from './tenant-registry.mjs';
import { isAuthorizedBearer, isAuthorizedTelegramWebhookSecret } from './worker-auth.mjs';
import { normalizeTenantId } from './storage/gmgn-admission-state.mjs';

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
        return json(await env.RADAR.get(id).getStatus(tenantId));
      }

      if (url.pathname === '/webhook/telegram') {
        if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, { status: 405, headers: { allow: 'POST' } });
        if (!(await telegramWebhookAuthorized(request, env))) return json({ error: 'forbidden' }, { status: 403 });
        // Do not acknowledge a Telegram delivery before #13 durably receives and deduplicates it.
        return json({ error: 'webhook_not_ready' }, { status: 503 });
      }

      return json({ error: 'not_found' }, { status: 404 });
    } catch (error) {
      console.error(JSON.stringify({ event: 'worker_request_failed', path: url.pathname, errorType: error instanceof Error ? error.name : 'unknown' }));
      return json({ error: 'internal_error' }, { status: 500 });
    }
  },

  async scheduled(controller, env) {
    const registry = env.TENANT_REGISTRY.getByName('tenant-registry');
    const result = await registry.scheduledWake();
    console.log(JSON.stringify({ event: 'scheduled_skeleton', cron: controller.cron, registeredTenantCount: result.registeredTenantCount }));
  }
};
