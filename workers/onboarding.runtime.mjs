import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import {
  CONNECTION_KEY_NAMES,
  failOnboardingVerification,
  prepareOnboardingVerification,
  readAveApiKey,
  verifyAndActivateOnboardingCredential
} from '../src/auth/connection.mjs';
import { AVE_CU } from '../src/providers/ave.mjs';
import { SqliteControlStateStore } from '../src/storage/control-state.mjs';
import { readSchedulerStateInTransaction } from '../src/storage/scheduler-state.mjs';
import { encryptSecret } from '../src/util/crypto.mjs';

const masterKey = { activeVersion: '2', keys: { '1': 'old-master', '2': 'new-master' } };
const apiKey = 'ave-onboarding-key-0001';
const replacementKey = 'ave-onboarding-key-0002';

async function inTenant(tenantId, operation) {
  const radar = env.RADAR.get(env.RADAR.idFromName(`radar:${tenantId}`));
  await radar.replaceSchedulerEligibility({ tenantId, eligibility: { paused: false, configured: false } });
  return runInDurableObject(radar, async (_instance, state) => operation({ storage: state.storage, tenantId, masterKey, now: () => 1000 }));
}

function keyRow(storage, tenantId, name) {
  return storage.sql.exec('SELECT value_enc, generation FROM keys WHERE tenant_id = ? AND name = ?', tenantId, name).toArray()[0] ?? null;
}

async function submission(options, updateId = '1', key = apiKey) {
  const envelope = await encryptSecret(masterKey, options.tenantId, `telegram-inbox:${updateId}`, key);
  options.storage.sql.exec("INSERT INTO inbox (tenant_id, update_id, actor_user_id, command_type, payload_enc, status, received_at, expires_at) VALUES (?, ?, ?, 'credential', ?, 'RECEIVED', 1000, 901000)", options.tenantId, updateId, options.tenantId, envelope);
  const prepared = await prepareOnboardingVerification({ ...options, updateId, apiKey: key, aveCost: AVE_CU.details });
  return { ...options, ...prepared, updateId };
}

function activate(options, overrides = {}) {
  return verifyAndActivateOnboardingCredential({ ...options,
    request: action => action({ signal: new AbortController().signal, timeoutMs: 1000 }),
    verify: async () => ({ verified: true }),
    afterActivate: ({ updateId }) => options.storage.sql.exec("UPDATE inbox SET status = 'DONE', payload_enc = NULL WHERE tenant_id = ? AND update_id = ?", options.tenantId, updateId),
    ...overrides });
}

it('stores a submitted key only as an encrypted pending candidate and schedules one AVE details verification', async () => {
  await inTenant('21901', async options => {
    const pending = await submission(options);
    const row = keyRow(options.storage, options.tenantId, CONNECTION_KEY_NAMES.PENDING_KEY_NAME);
    expect(row.generation).toBe(pending.connectionGeneration);
    expect(row.value_enc).not.toContain(apiKey);
    expect(keyRow(options.storage, options.tenantId, CONNECTION_KEY_NAMES.ACTIVE_KEY_NAME)).toBeNull();
    await expect(readAveApiKey(options.storage, masterKey, options.tenantId)).rejects.toThrow('AVE credential is not configured');
    expect(readSchedulerStateInTransaction(options.storage, options.tenantId).tasks).toEqual([
      { id: `credential:${pending.connectionGeneration}`, kind: 'credential', dueAt: 1000, enabled: true, aveCost: AVE_CU.details }
    ]);
    expect(new SqliteControlStateStore(options.storage, options.tenantId).snapshot()).toMatchObject({ configured: false, keyEpoch: 0 });
    await expect(prepareOnboardingVerification({ ...options, updateId: '1', apiKey: 'short', aveCost: AVE_CU.details })).rejects.toThrow('AVE API key is invalid');
  });
});

it('verifies the candidate key itself and activates it while preserving a pause during verification', async () => {
  await inTenant('21902', async options => {
    const pending = await submission(options);
    const verified = [];
    const result = await activate(pending, { verify: async key => {
      verified.push(key);
      new SqliteControlStateStore(options.storage, options.tenantId).pause();
      return { verified: true };
    } });
    expect(verified).toEqual([apiKey]);
    expect(result).toMatchObject({ configured: true, keyEpoch: 1, updateId: '1' });
    expect(await readAveApiKey(options.storage, masterKey, options.tenantId)).toBe(apiKey);
    expect(keyRow(options.storage, options.tenantId, CONNECTION_KEY_NAMES.PENDING_KEY_NAME)).toBeNull();
    expect(new SqliteControlStateStore(options.storage, options.tenantId).snapshot()).toMatchObject({ paused: true, configured: true, keyEpoch: 1 });
    expect(options.storage.sql.exec('SELECT status, payload_enc FROM inbox WHERE tenant_id = ?', options.tenantId).one()).toEqual({ status: 'DONE', payload_enc: null });
  });
});

it.each(['disconnect', 'resubmit', 'expire', 'terminal'])('rejects late credential success after %s', async mutation => {
  const tenantId = { disconnect: '21903', resubmit: '21904', expire: '21905', terminal: '21906' }[mutation];
  await inTenant(tenantId, async options => {
    const pending = await submission(options);
    let timestamp = 1000;
    await expect(activate({ ...pending, now: () => timestamp }, { verify: async () => {
      if (mutation === 'disconnect') new SqliteControlStateStore(options.storage, tenantId).disconnect();
      if (mutation === 'resubmit') await submission(options, '2', replacementKey);
      if (mutation === 'expire') timestamp = 901000;
      if (mutation === 'terminal') options.storage.sql.exec("UPDATE inbox SET status = 'CANCELLED' WHERE tenant_id = ?", tenantId);
      return { verified: true };
    } })).rejects.toMatchObject({ name: 'ConnectionError' });
    expect(keyRow(options.storage, tenantId, CONNECTION_KEY_NAMES.ACTIVE_KEY_NAME)).toBeNull();
    expect(new SqliteControlStateStore(options.storage, tenantId).snapshot()).toMatchObject({ configured: false });
  });
});

it('rolls back the active key and key epoch when command completion cannot commit', async () => {
  await inTenant('21907', async options => {
    const pending = await submission(options);
    await expect(activate(pending, { afterActivate: () => { throw new Error('outbox transaction failed'); } })).rejects.toThrow('outbox transaction failed');
    expect(keyRow(options.storage, options.tenantId, CONNECTION_KEY_NAMES.ACTIVE_KEY_NAME)).toBeNull();
    expect(keyRow(options.storage, options.tenantId, CONNECTION_KEY_NAMES.PENDING_KEY_NAME)).not.toBeNull();
    expect(new SqliteControlStateStore(options.storage, options.tenantId).snapshot()).toMatchObject({ keyEpoch: 0, configured: false });
  });
});

it('preserves an old active connection on failed replacement and scrubs terminal candidates', async () => {
  await inTenant('21908', async options => {
    await activate(await submission(options));
    const before = keyRow(options.storage, options.tenantId, CONNECTION_KEY_NAMES.ACTIVE_KEY_NAME);
    const replacement = await submission(options, '2', replacementKey);
    await expect(activate(replacement, { verify: async () => ({ verified: false }) })).rejects.toThrow('credential verification failed');
    failOnboardingVerification(replacement);
    expect(keyRow(options.storage, options.tenantId, CONNECTION_KEY_NAMES.ACTIVE_KEY_NAME)).toEqual(before);
    expect(await readAveApiKey(options.storage, masterKey, options.tenantId)).toBe(apiKey);
    expect(keyRow(options.storage, options.tenantId, CONNECTION_KEY_NAMES.PENDING_KEY_NAME)).toBeNull();
    expect(options.storage.sql.exec('SELECT status, payload_enc FROM inbox WHERE tenant_id = ? AND update_id = ?', options.tenantId, '2').one()).toEqual({ status: 'FAILED', payload_enc: null });
  });
});

it('replaying one credential command reuses its scheduled verification generation', async () => {
  await inTenant('21909', async options => {
    const pending = await submission(options);
    const repeated = await prepareOnboardingVerification({ ...options, updateId: '1', apiKey, aveCost: AVE_CU.details });
    expect(repeated.connectionGeneration).toBe(pending.connectionGeneration);
    expect(readSchedulerStateInTransaction(options.storage, options.tenantId).tasks.map(task => task.id)).toEqual([`credential:${pending.connectionGeneration}`]);
    await activate(pending);
    await expect(prepareOnboardingVerification({ ...options, updateId: '1', apiKey, aveCost: AVE_CU.details })).rejects.toThrow('credential command is no longer active');
  });
});

it('a stale failure cannot cancel a newer credential submission', async () => {
  await inTenant('21910', async options => {
    const first = await submission(options);
    const second = await submission(options, '2', replacementKey);
    expect(options.storage.sql.exec('SELECT status FROM inbox WHERE tenant_id = ? AND update_id = ?', options.tenantId, '1').one().status).toBe('CANCELLED');
    failOnboardingVerification({ ...first, updateId: '2' });
    expect(options.storage.sql.exec('SELECT status FROM inbox WHERE tenant_id = ? AND update_id = ?', options.tenantId, '2').one().status).toBe('RECEIVED');
    await activate(second);
    expect(await readAveApiKey(options.storage, masterKey, options.tenantId)).toBe(replacementKey);
  });
});
