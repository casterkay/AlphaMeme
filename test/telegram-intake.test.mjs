import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { parseTelegramUpdate, validateTelegramReceipt } from '../src/telegram-intake.mjs';

function privateMessage({ updateId = 10, chatId = 16000, fromId = chatId, text = '/start secret-argument', messageId = 7, languageCode } = {}) {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_700_000_000,
      chat: { id: chatId, type: 'private' },
      from: { id: fromId, ...(languageCode === undefined ? {} : { language_code: languageCode }) },
      text
    }
  };
}

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes) {
  let number = BigInt('0x' + (Buffer.from(bytes).toString('hex') || '0')), text = '';
  while (number > 0n) { text = BASE58[Number(number % 58n)] + text; number /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; text = '1' + text; }
  return text;
}
const parse = (text, extra = {}) => {
  const update = privateMessage({ text });
  Object.assign(update.message, extra);
  return parseTelegramUpdate(update, { now: () => 1234 });
};

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
      sourceMessageId: '7',
      locale: 'en'
    }
  });
  assert.equal(validateTelegramReceipt(result.receipt).payload.arguments, 'secret-argument');
});

test('setkey arguments use only transient protected handoff, unless they hold a PEM private key', () => {
  for (const text of ['/setkey ave-private-value-0123', '/setkey invalid', `/setkey ${'ab'.repeat(32)}`]) {
    const result = parse(text);
    assert.equal(result.kind, 'credential');
    assert.equal(result.credentialText, text);
    assert.deepEqual(validateTelegramReceipt(result.receipt).payload, { source: 'message' });
    assert.equal(JSON.stringify(result.receipt).includes(text.slice(8)), false);
  }
  assert.equal(parse('/setkey').receipt.commandType, 'command:setkey');
  const pem = parse('/setkey -----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----');
  assert.deepEqual([pem.kind, pem.receipt.commandType, pem.receipt.payload, pem.credentialText], ['accepted', 'secret_warning', {}, undefined]);
});

test('the receipt carries the sender\'s Telegram language: Chinese for zh clients, English for every other', () => {
  for (const [languageCode, locale] of [['zh', 'zh'], ['zh-hans', 'zh'], ['zh-TW', 'zh'], ['ZH', 'zh'], ['en', 'en'], ['ru', 'en'], ['', 'en'], [undefined, 'en'], [7, 'en']]) {
    const message = parseTelegramUpdate(privateMessage({ languageCode }), { now: () => 1234 }).receipt;
    assert.equal(validateTelegramReceipt(message).locale, locale, String(languageCode));
    const callback = parseTelegramUpdate({ update_id: 12, callback_query: { id: 'q', from: { id: 16000, language_code: languageCode }, data: 'cb:abc', message: privateMessage().message } }, { now: () => 1234 }).receipt;
    assert.equal(validateTelegramReceipt(callback).locale, locale, `callback ${languageCode}`);
  }
  const receipt = parse('/start').receipt;
  for (const locale of [undefined, 'fr', 'zh-hans']) assert.throws(() => validateTelegramReceipt({ ...receipt, locale }), /unsupported shape/, String(locale));
});

const evmKey = () => '0x' + randomBytes(32).toString('hex');
const secretShapes = () => [evmKey(), evmKey().slice(2), evmKey().toUpperCase().replace('0X', '0x'), base58(randomBytes(64)), base58(Buffer.concat([Buffer.alloc(1), randomBytes(63)])),
  '-----BEGIN PRIVATE KEY-----\nMIIEvQ\n-----END PRIVATE KEY-----', '-----BEGIN EC PRIVATE KEY-----'];

test('a message holding a private key becomes a text-free warning on every path: plain text, prompt reply and command argument', () => {
  for (let round = 0; round < 50; round++) for (const secret of secretShapes()) {
    for (const [text, extra] of [[secret, {}], [`my key: ${secret}.`, {}], [secret, { reply_to_message: { message_id: 55 } }], [`/note ${secret}`, {}], [`/start ${secret}`, { reply_to_message: { message_id: 55 } }]]) {
      const result = parse(text, extra);
      assert.equal(result.kind, 'accepted', text);
      assert.equal(result.credentialText, undefined);
      const receipt = validateTelegramReceipt(result.receipt);
      assert.equal(receipt.commandType, 'secret_warning', text);
      assert.deepEqual(receipt.payload, {});
      for (const piece of secret.split(/[^0-9A-Za-z]+/).filter(word => word.length > 8)) assert.equal(JSON.stringify(receipt).includes(piece), false, text);
    }
  }
});

test('plain text is classified at the boundary: a contract address becomes a lookup, anything else a text-free receipt', () => {
  for (let round = 0; round < 200; round++) {
    const evm = '0x' + randomBytes(20).toString('hex'), sol = base58(randomBytes(32));
    const mixed = evm.slice(0, 2) + [...evm.slice(2)].map((character, index) => index % 2 ? character.toUpperCase() : character).join('');
    assert.deepEqual(validateTelegramReceipt(parse(`  ${mixed} `).receipt).payload, { family: 'evm', address: evm });
    if (sol.length >= 32) assert.deepEqual(validateTelegramReceipt(parse(sol).receipt).payload, { family: 'sol', address: sol });
    const words = randomBytes(24).toString('base64');
    const receipt = validateTelegramReceipt(parse(`hello ${words}`).receipt);
    assert.deepEqual([receipt.commandType, receipt.payload], ['text', {}]);
    assert.equal(JSON.stringify(receipt).includes(words), false);
  }
  for (const text of ['0x' + '0'.repeat(40), '0x' + 'a'.repeat(39), '1'.repeat(32), 'PEPE', 'ave-api-key-0123456789']) assert.equal(parse(text).receipt.commandType, 'text', text);
  assert.equal(parse(`look at ${'0x' + 'ab'.repeat(20)}`).receipt.commandType, 'text');
});

test('durable validation rejects a text-carrying text receipt and an unnormalized lookup', () => {
  const receipt = parse('hello').receipt;
  for (const commandType of ['text', 'secret_warning']) assert.throws(() => validateTelegramReceipt({ ...receipt, commandType, payload: { text: 'hello' } }), /unsupported shape/);
  const lookup = parse('0x' + 'ab'.repeat(20)).receipt;
  assert.throws(() => validateTelegramReceipt({ ...lookup, payload: { family: 'evm', address: '0x' + 'AB'.repeat(20) } }), /unsupported shape/);
  assert.throws(() => validateTelegramReceipt({ ...lookup, payload: { family: 'sol', address: lookup.payload.address } }), /unsupported shape/);
  assert.throws(() => validateTelegramReceipt({ ...lookup, payload: { ...lookup.payload, text: 'x' } }), /unsupported shape/);
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
      sourceMessageId: '8',
      locale: 'en'
    }
  });
});

test('durable receipt validation rejects unbounded message parameters and malformed update ids', () => {
  const receipt = parseTelegramUpdate(privateMessage(), { now: () => 1234 }).receipt;
  assert.throws(() => validateTelegramReceipt({ ...receipt, updateId: '0010' }), /unsupported shape/);
  assert.throws(() => validateTelegramReceipt({ ...receipt, payload: { source: 'message', text: 'secret' } }), /unsupported shape/);
});

test('mentions match only the configured bot username', () => {
  for (const text of ['/start@other_bot', '/setkey@other_bot ave-secret-value']) {
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
  update.message.text = 'note with -----BEGIN PRIVATE KEY-----';
  assert.equal(parseTelegramUpdate(update).receipt.commandType, 'secret_warning');
  const receipt = parseTelegramUpdate(privateMessage()).receipt;
  assert.throws(() => validateTelegramReceipt({ ...receipt, payload: { source: 'message', arguments: '-----BEGIN PRIVATE KEY-----' } }), /unsupported shape/);
});

test('oversized messages and callbacks without acknowledgement identity are ignored', () => {
  assert.equal(parseTelegramUpdate(privateMessage({ text: '/note ' + 'x'.repeat(4096) })).kind, 'ignored');
  assert.equal(parseTelegramUpdate({ update_id: 5, callback_query: { from: { id: 16000 }, data: 'cb:abc', message: privateMessage().message } }).kind, 'ignored');
});
