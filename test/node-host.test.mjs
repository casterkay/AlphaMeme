import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableObjectHost } from '../src/host/durable-object-host.mjs';
import { DurableObject } from '../src/host/cloudflare-workers-shim.mjs';
import worker, { RadarAgent, TenantRegistry } from '../src/worker.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'radar-host-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = new DurableObjectHost({ storageDirectory: dir });
  const env = {
    OPERATOR_TOKEN: 'op-token',
    TELEGRAM_WEBHOOK_SECRET: 'webhook-secret',
    TELEGRAM_BOT_TOKEN: 'bot-token',
    TELEGRAM_BOT_USERNAME: 'test_bot',
    MASTER_ENC_KEY: 'enc-key',
    RADAR: host.namespace(RadarAgent),
    TENANT_REGISTRY: host.namespace(TenantRegistry)
  };
  host.setEnvironment(env);
  return { dir, host, env };
}

test('the Node host runs worker.fetch with operator and webhook auth unchanged', async t => {
  const { env } = fixture(t);

  const unauthHealth = await worker.fetch(new Request('https://example.test/health'), env);
  assert.equal(unauthHealth.status, 401);

  const health = await worker.fetch(new Request('https://example.test/health', {
    headers: { Authorization: 'Bearer op-token' }
  }), env);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, service: 'meme-radar', lifecycle: 'SKELETON' });

  const status = await worker.fetch(new Request('https://example.test/status?tenant_id=123', {
    headers: { Authorization: 'Bearer op-token' }
  }), env);
  assert.equal(status.status, 200);
  assert.equal((await status.json()).schemaVersion, 1);

  const badSecret = await worker.fetch(new Request('https://example.test/webhook/telegram', {
    method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'wrong' }, body: '{}'
  }), env);
  assert.equal(badSecret.status, 403);

  const ignored = await worker.fetch(new Request('https://example.test/webhook/telegram', {
    method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'webhook-secret' }, body: '{}'
  }), env);
  assert.equal(ignored.status, 200);
  assert.deepEqual(await ignored.json(), { accepted: false });
});

test('the input gate serializes concurrent calls on one durable object instance', async t => {
  const { host } = fixture(t);

  class Probe extends DurableObject {
    constructor(ctx, env) {
      super(ctx, env);
      this.active = 0;
      this.peak = 0;
    }
    async run() {
      this.active += 1;
      this.peak = Math.max(this.peak, this.active);
      await new Promise(resolve => setTimeout(resolve, 10));
      this.active -= 1;
    }
    async peakActive() { return this.peak; }
  }

  const namespace = host.namespace(Probe);
  const probe = namespace.get(namespace.idFromName('probe'));
  await Promise.all([probe.run(), probe.run(), probe.run(), probe.run(), probe.run()]);
  assert.equal(await probe.peakActive(), 1, 'a durable object runs one call at a time');
});

test('setAlarm fires the durable object alarm once at its deadline', async t => {
  const { host } = fixture(t);

  class Alarmed extends DurableObject {
    constructor(ctx, env) {
      super(ctx, env);
      this.fired = 0;
    }
    async arm() { await this.ctx.storage.setAlarm(Date.now() + 30); }
    async alarm() { this.fired += 1; }
    async firedCount() { return this.fired; }
  }

  const namespace = host.namespace(Alarmed);
  const alarmed = namespace.get(namespace.idFromName('alarmed'));
  await alarmed.arm();
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(await alarmed.firedCount(), 1);
});

test('a failed blockConcurrencyWhile does not cache a half-initialized instance', async t => {
  const { host } = fixture(t);

  class Broken extends DurableObject {
    constructor(ctx, env) {
      super(ctx, env);
      ctx.blockConcurrencyWhile(async () => { throw new Error('schema init failed'); });
    }
    async probe() { return 'ok'; }
  }

  const namespace = host.namespace(Broken);
  const broken = namespace.get(namespace.idFromName('broken'));
  await assert.rejects(broken.probe(), /schema init failed/);
  // A later call must retry construction and fail the same way, not hit a stale instance.
  await assert.rejects(broken.probe(), /schema init failed/);
});

test('RadarAgent and TenantRegistry initialize their schemas and serve RPC methods', async t => {
  const { env } = fixture(t);

  const registry = env.TENANT_REGISTRY.getByName('tenant-registry');
  assert.deepEqual(await registry.registerTenant('123'), { tenantId: '123' });

  const wake = await registry.scheduledWake();
  assert.equal(wake.registeredTenantCount, 1);
  assert.equal(wake.selectedTenantCount, 1);

  const radar = env.RADAR.get(env.RADAR.idFromName('radar:123'));
  const status = await radar.getStatus('123');
  assert.equal(status.schemaVersion, 1);
  assert.equal(status.lifecycle, 'SKELETON');
});
