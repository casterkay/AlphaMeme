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

test('private command receipts derive the tenant from chat and from while retaining command arguments', () => {
  const result = parseTelegramUpdate(privateMessage(), { now: () => 1234 });

  assert.deepEqual(result, {
    kind: 'accepted',
    receipt: {
      tenantId: '16000',
      actorUserId: '16000',
      updateId: '10',
      commandType: 'command:start',
      payload: { source: 'message', arguments: 'secret-argument' },
      dueAt: 1234,
      messageDate: 1_700_000_000,
      sourceMessageId: '7'
    }
  });
  assert.equal(validateTelegramReceipt(result.receipt).payload.arguments, 'secret-argument');
});

test('credentials in commands, notes and malformed setkey input use only transient protected handoff', () => {
  for (const text of ['/setkey gmgn_private_value', 'gmgn_private_value', '/note sol token has gmgn_private_value', '/setkey invalid']) {
    const result = parseTelegramUpdate(privateMessage({ text }), { now: () => 1234 });
    assert.equal(result.kind, 'credential');
    assert.equal(result.credentialText, text);
    assert.deepEqual(validateTelegramReceipt(result.receipt).payload, { source: 'message' });
    assert.equal(JSON.stringify(result.receipt).includes(text), false);
  }
  assert.equal(parseTelegramUpdate(privateMessage({ text: '/setkey' })).receipt.commandType, 'command:setkey');
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
      payload: { callbackId: '99999', callbackQueryId: 'callback-id' },
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

test('mentions match only the configured bot username', () => {
  for (const text of ['/start@other_bot', '/setkey@other_bot gmgn_secret']) {
    assert.equal(parseTelegramUpdate(privateMessage({ text }), { botUsername: 'radar_bot' }).kind, 'ignored');
  }
  assert.equal(parseTelegramUpdate(privateMessage({ text: '/start@RADAR_bot' }), { botUsername: 'radar_bot' }).kind, 'accepted');
  assert.equal(parseTelegramUpdate(privateMessage({ text: '/start@radar_bot' })).kind, 'ignored');
});

test('prompt replies preserve reply identity while commands take priority and embedded secrets never enter a receipt', () => {
  const update = privateMessage({ text: 'research note' });
  update.message.reply_to_message = { message_id: 55 };
  assert.deepEqual(validateTelegramReceipt(parseTelegramUpdate(update).receipt).payload,
    { source: 'reply', text: 'research note', replyToMessageId: '55' });
  update.message.text = '/cancel';
  assert.equal(parseTelegramUpdate(update).receipt.commandType, 'command:cancel');
  assert.equal(parseTelegramUpdate(update).receipt.payload.replyToMessageId, '55');
  update.message.text = 'note with gmgn_secret';
  assert.equal(parseTelegramUpdate(update).kind, 'credential');
  const receipt = parseTelegramUpdate(privateMessage()).receipt;
  assert.throws(() => validateTelegramReceipt({ ...receipt, payload: { source: 'message', arguments: 'gmgn_secret' } }), /unsupported shape/);
});

test('oversized messages and callbacks without acknowledgement identity are ignored', () => {
  assert.equal(parseTelegramUpdate(privateMessage({ text: '/note ' + 'x'.repeat(4096) })).kind, 'ignored');
  assert.equal(parseTelegramUpdate({ update_id: 5, callback_query: { from: { id: 16000 }, data: 'cb:abc', message: privateMessage().message } }).kind, 'ignored');
});
