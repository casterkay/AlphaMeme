import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { ensurePendingSigningKey, regeneratePendingSigningKey, signingSetupSnapshot, signingRow, SIGNING_KEY_NAMES } from '../src/auth/key-store.mjs';
import { prepareOnboardingVerification, verifyAndActivateOnboardingCredential, failOnboardingVerification } from '../src/auth/connection.mjs';
import { SqliteControlStateStore } from '../src/storage/control-state.mjs';
import { readGmgnApiKey } from '../src/storage/gmgn-credential.mjs';
import { encryptSecret } from '../src/util/crypto.mjs';

const masterKey = { activeVersion: '2', keys: { '1': 'old-master', '2': 'new-master' } };
const apiKey = `gmgn_${'a'.repeat(32)}`;

async function inTenant(tenantId, operation) {
  const radar = env.RADAR.get(env.RADAR.idFromName(`radar:${tenantId}`));
  await radar.replaceSchedulerEligibility({ tenantId, eligibility: { paused: false, configured: false } });
  return runInDurableObject(radar, async (_instance, state) => operation({ storage: state.storage, tenantId, masterKey, now: () => 1000 }));
}

async function submission(options, updateId = '1') {
  const setup = await ensurePendingSigningKey(options);
  const envelope = await encryptSecret(masterKey, options.tenantId, `telegram-inbox:${updateId}`, apiKey);
  options.storage.sql.exec("INSERT INTO inbox (tenant_id, update_id, actor_user_id, command_type, payload_enc, status, received_at, expires_at) VALUES (?, ?, ?, 'command:setkey', ?, 'RECEIVED', 1000, 901000)", options.tenantId, updateId, options.tenantId, envelope);
  const prepared = await prepareOnboardingVerification({ ...options, updateId, apiKey, expectedSigningGeneration: setup.generation });
  return { ...options, ...prepared, setup, updateId };
}

function activate(options, overrides = {}) {
  return verifyAndActivateOnboardingCredential({ ...options,
    request: action => action({ signal: new AbortController().signal, timeoutMs: 1000 }),
    verify: async (_key, requestOptions) => ({ verified: requestOptions.privateKey === undefined }),
    afterActivate: ({ updateId }) => options.storage.sql.exec("UPDATE inbox SET status = 'DONE', payload_enc = NULL WHERE tenant_id = ? AND update_id = ?", options.tenantId, updateId),
    ...overrides });
}

it('reuses pending onboarding keys and binds explicit regeneration to both generations', async () => {
  await inTenant('21901', async options => {
    const first = await ensurePendingSigningKey(options);
    expect(await ensurePendingSigningKey(options)).toEqual(first);
    const replacement = await regeneratePendingSigningKey({ ...options, expectedGeneration: first.generation, expectedConnectionGeneration: first.connectionGeneration });
    expect(replacement.publicKey).not.toBe(first.publicKey);
    await expect(regeneratePendingSigningKey({ ...options, expectedGeneration: first.generation, expectedConnectionGeneration: first.connectionGeneration })).rejects.toThrow('SIGNING_GENERATION_STALE');
    expect((await signingSetupSnapshot(options)).publicKey).toBe(replacement.publicKey);
    expect(signingRow(options.storage, options.tenantId).value_enc).not.toContain('PRIVATE KEY');
  });
});

it('activates registration and API keys atomically while preserving a pause during verification', async () => {
  await inTenant('21902', async options => {
    const pending = await submission(options);
    await activate(pending, { verify: async () => {
      new SqliteControlStateStore(options.storage, options.tenantId).pause();
      return { verified: true };
    } });
    expect(await readGmgnApiKey(options.storage, masterKey, options.tenantId)).toBe(apiKey);
    expect((await signingSetupSnapshot(options)).pending).toBe(false);
    expect(signingRow(options.storage, options.tenantId, SIGNING_KEY_NAMES.active)).not.toBeNull();
    expect(new SqliteControlStateStore(options.storage, options.tenantId).snapshot().paused).toBe(true);
    expect(options.storage.sql.exec('SELECT status, payload_enc FROM inbox WHERE tenant_id = ?', options.tenantId).one()).toEqual({ status: 'DONE', payload_enc: null });
  });
});

it.each(['disconnect', 'regenerate', 'expire', 'terminal'])('rejects late credential success after %s', async mutation => {
  const tenantId = { disconnect: '21903', regenerate: '21904', expire: '21905', terminal: '21906' }[mutation];
  await inTenant(tenantId, async options => {
    const pending = await submission(options);
    let timestamp = 1000;
    await expect(activate({ ...pending, now: () => timestamp }, { verify: async () => {
      if (mutation === 'disconnect') new SqliteControlStateStore(options.storage, tenantId).disconnect();
      if (mutation === 'regenerate') await regeneratePendingSigningKey({ ...options, expectedGeneration: pending.setup.generation, expectedConnectionGeneration: pending.connectionGeneration });
      if (mutation === 'expire') timestamp = 901000;
      if (mutation === 'terminal') options.storage.sql.exec("UPDATE inbox SET status = 'CANCELLED' WHERE tenant_id = ?", tenantId);
      return { verified: true };
    } })).rejects.toThrow();
    expect(signingRow(options.storage, tenantId, SIGNING_KEY_NAMES.active)).toBeNull();
    expect(new SqliteControlStateStore(options.storage, tenantId).snapshot().configured).toBe(false);
  });
});

it('rolls back both active keys and epochs when command completion cannot commit', async () => {
  await inTenant('21907', async options => {
    const pending = await submission(options);
    await expect(activate(pending, { afterActivate: () => { throw new Error('outbox transaction failed'); } })).rejects.toThrow('outbox transaction failed');
    expect(signingRow(options.storage, options.tenantId, SIGNING_KEY_NAMES.active)).toBeNull();
    expect(new SqliteControlStateStore(options.storage, options.tenantId).snapshot().keyEpoch).toBe(0);
  });
});

it('preserves an old active connection on failed replacement and scrubs terminal candidates', async () => {
  await inTenant('21908', async options => {
    await activate(await submission(options));
    const before = signingRow(options.storage, options.tenantId, SIGNING_KEY_NAMES.active);
    const replacement = await submission(options, '2');
    await expect(activate(replacement, { verify: async () => ({ verified: false }) })).rejects.toThrow('credential verification failed');
    failOnboardingVerification(replacement);
    expect(signingRow(options.storage, options.tenantId, SIGNING_KEY_NAMES.active)).toEqual(before);
    expect(await readGmgnApiKey(options.storage, masterKey, options.tenantId)).toBe(apiKey);
    expect(signingRow(options.storage, options.tenantId, 'gmgn-pending-api-key')).toBeNull();
    expect(options.storage.sql.exec('SELECT status, payload_enc FROM inbox WHERE tenant_id = ? AND update_id = ?', options.tenantId, '2').one()).toEqual({ status: 'FAILED', payload_enc: null });
  });
});

it('replaying one credential command reuses its scheduled verification generation', async () => {
  await inTenant('21909', async options => {
    const pending = await submission(options);
    const repeated = await prepareOnboardingVerification({ ...options, updateId: '1', apiKey, expectedSigningGeneration: pending.setup.generation });
    expect(repeated.connectionGeneration).toBe(pending.connectionGeneration);
    await activate(pending);
    await expect(prepareOnboardingVerification({ ...options, updateId: '1', apiKey, expectedSigningGeneration: pending.setup.generation })).rejects.toThrow('credential command is no longer active');
  });
});

it('a stale failure cannot cancel a newer credential submission', async () => {
  await inTenant('21910', async options => {
    const first = await submission(options);
    const second = await submission(options, '2');
    failOnboardingVerification({ ...first, updateId: '2' });
    expect(options.storage.sql.exec('SELECT status FROM inbox WHERE tenant_id = ? AND update_id = ?', options.tenantId, '2').one().status).toBe('RECEIVED');
    await activate(second);
  });
});
