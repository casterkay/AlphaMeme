import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { encryptGmgnApiKey } from '../../src/storage/gmgn-credential.mjs';

export async function seedGmgnCredential(radar, tenantId) {
  await radar.replaceSchedulerEligibility({ tenantId, eligibility: { paused: false, configured: true } });
  await runInDurableObject(radar, async (_instance, state) => {
    const encrypted = await encryptGmgnApiKey(env.MASTER_ENC_KEY, tenantId, `gmgn_${'a'.repeat(32)}`);
    state.storage.sql.exec(
      'INSERT INTO keys (tenant_id, name, value_enc, generation, created_at) VALUES (?, ?, ?, ?, ?)',
      tenantId, 'gmgn-api-key', encrypted, 1, Date.now()
    );
  });
  const admission = await radar.getGmgnAdmissionState({ tenantId });
  await radar.setGmgnAdmissionState({ tenantId, state: { ...admission, keyEpoch: 1 } });
}
