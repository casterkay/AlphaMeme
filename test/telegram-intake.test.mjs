import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTelegramUpdate, validateTelegramReceipt } from '../src/telegram-intake.mjs';

function privateMessage({ updateId = 10, chatId = 16000, fromId = chatId, text = '/start secret-argument', messageId = 7 } = {}) {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000,
      chat: { id: chatId, type: 'private' },
      from: { id: fromId },
      text
    }
  };
}

test('private command receipts derive the tenant from chat and from while omitting user text', () => {
  const result = parseTelegramUpdate(privateMessage(), { now: () => 1234 });

  assert.deepEqual(result, {
    kind: 'accepted',
    receipt: {
      tenantId: '16000',
      actorUserId: '16000',
      updateId: '10',
      commandType: 'command:start',
      payload: { source: 'message' },
      dueAt: 1234,
      messageDate: 1_700_000_000,
      sourceMessageId: '7'
    }
  });
  assert.equal(JSON.stringify(result).includes('secret-argument'), false);
});

test('credential-bearing messages are acknowledged without constructing a tenant receipt', () => {
  for (const text of ['/setkey gmgn_private_value', 'gmgn_private_value']) {
    assert.deepEqual(parseTelegramUpdate(privateMessage({ text }), { now: () => 1234 }), { kind: 'credential_rejected' });
  }
});

test('unsupported and unauthorized updates do not construct a receipt', () => {
  assert.deepEqual(parseTelegramUpdate({ update_id: 11, inline_query: { id: 'x' } }, { now: () => 1234 }), { kind: 'ignored' });
  assert.deepEqual(parseTelegramUpdate({
    ...privateMessage(),
    message: { ...privateMessage().message, chat: { id: -16000, type: 'group' } }
  }, { now: () => 1234 }), { kind: 'ignored' });
  assert.deepEqual(parseTelegramUpdate(privateMessage({ fromId: 16001 }), { now: () => 1234 }), { kind: 'ignored' });
});

test('callback receipts route from their private message envelope rather than callback data', () => {
  const result = parseTelegramUpdate({
    update_id: 12,
    callback_query: {
      id: 'callback-id',
      from: { id: 16000 },
      data: 'cb:99999',
      message: { message_id: 8, date: 1_700_000_001, chat: { id: 16000, type: 'private' } }
    }
  }, { now: () => 1234 });

  assert.deepEqual(result, {
    kind: 'accepted',
    receipt: {
      tenantId: '16000',
      actorUserId: '16000',
      updateId: '12',
      commandType: 'callback',
      payload: { callbackId: '99999' },
      dueAt: 1234,
      messageDate: 1_700_000_001,
      sourceMessageId: '8'
    }
  });
});

test('durable receipt validation rejects unbounded message parameters and malformed update ids', () => {
  const receipt = parseTelegramUpdate(privateMessage(), { now: () => 1234 }).receipt;
  assert.throws(() => validateTelegramReceipt({ ...receipt, updateId: '0010' }), /unsupported shape/);
  assert.throws(() => validateTelegramReceipt({ ...receipt, payload: { source: 'message', text: 'secret' } }), /unsupported shape/);
});
