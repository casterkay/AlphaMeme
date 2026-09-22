import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { TelegramInbox } from '../src/bot/inbox.mjs';

function receipt(tenantId, updateId, command, date = 2_000_000) {
  return { tenantId, actorUserId: tenantId, updateId, commandType: `command:${command}`, payload: { source: 'message', arguments: '' }, messageDate: date, sourceMessageId: '10' };
}

async function fixture(id, run) {
  await runInDurableObject(env.RADAR.getByName(`radar:${id}`), async (_instance, state) => {
    const inbox = new TelegramInbox({ storage: state.storage, tenantId: id, now: () => 2_000_000_000 });
    await run(inbox, state.storage);
  });
}

describe('durable Telegram inbox', () => {
  it('commits a control mutation, reply intent and terminal receipt atomically and never replays them', async () => {
    await fixture('19201', (inbox, storage) => {
      let applied = 0;
      const immediate = row => {
        applied++;
        storage.sql.exec('INSERT INTO preferences (tenant_id, key, value_json) VALUES (?, ?, ?)', '19201', 'test.reply', 'true');
        inbox.finishInTransaction(row.update_id, 'DONE');
      };
      storage.transactionSync(() => inbox.receiveInTransaction(receipt('19201', '2', 'pause'), { immediate }));
      const duplicate = storage.transactionSync(() => inbox.receiveInTransaction(receipt('19201', '2', 'pause'), { immediate }));
      expect(duplicate).toMatchObject({ duplicate: true, status: 'DONE' });
      expect(applied).toBe(1);
      expect(inbox.get('2').payload_enc).toBeNull();
    });
  });

  it('rolls back receipt and watermark when a local effect fails', async () => {
    await fixture('19202', (inbox, storage) => {
      expect(() => storage.transactionSync(() => inbox.receiveInTransaction(receipt('19202', '2', 'pause'), { immediate: () => { throw new Error('injected'); } }))).toThrow('injected');
      expect(inbox.get('2')).toBeNull();
      expect(storage.sql.exec('SELECT * FROM preferences WHERE tenant_id = ?', '19202').toArray()).toEqual([]);
    });
  });

  it('uses independent dated watermarks and accepts reset update IDs after idle', async () => {
    await fixture('19203', (inbox, storage) => {
      const receive = r => storage.transactionSync(() => inbox.receiveInTransaction(r));
      receive(receipt('19203', '900', 'pause', 1_999_999));
      expect(receive(receipt('19203', '2', 'resume', 2_000_000)).status).toBe('RECEIVED');
      expect(receive(receipt('19203', '999', 'pause', 1_999_999)).status).toBe('CANCELLED');
      expect(receive(receipt('19203', '3', 'onboard', 1_999_999)).status).toBe('RECEIVED');
      expect(receive(receipt('19203', '4', 'radar', 1)).status).toBe('RECEIVED');
    });
  });

  it('stores only ciphertext for credentials and scrubs cancelled and completed payloads', async () => {
    await fixture('19204', (inbox, storage) => {
      const r = { ...receipt('19204', '8', 'setkey'), commandType: 'credential', payload: { source: 'message' } };
      expect(() => storage.transactionSync(() => inbox.receiveInTransaction(r))).toThrow('ciphertext');
      storage.transactionSync(() => inbox.receiveInTransaction(r, { payloadEnc: 'sealed-envelope' }));
      expect(inbox.get('8').payload_json).toBe('{"source":"message"}');
      storage.transactionSync(() => inbox.finishInTransaction('8', 'DONE'));
      expect(inbox.get('8').payload_enc).toBeNull();
    });
  });

  it('restores oldest received work without treating callback message date as click time', async () => {
    await fixture('19205', (inbox, storage) => {
      storage.transactionSync(() => inbox.receiveInTransaction({ ...receipt('19205', '88', 'radar', 1), commandType: 'callback', payload: { callbackId: 'bound', callbackQueryId: 'query' } }));
      storage.transactionSync(() => inbox.receiveInTransaction(receipt('19205', '4', 'radar')));
      const restored = new TelegramInbox({ storage, tenantId: '19205', now: () => 2_000_000_000 });
      expect(storage.transactionSync(() => restored.reconcileInTransaction()).filter(t => t.id.startsWith('inbox:')).map(t => t.id)).toEqual(['inbox:88']);
      storage.transactionSync(() => restored.finishInTransaction('88', 'DONE'));
      expect(storage.transactionSync(() => restored.reconcileInTransaction()).filter(t => t.id.startsWith('inbox:')).map(t => t.id)).toEqual(['inbox:4']);
    });
  });
});
