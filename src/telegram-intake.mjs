import { normalizeTokenAddress } from './address.mjs';

const MAX_CALLBACK_DATA_BYTES = 64;
const MAX_MESSAGE_LENGTH = 4096;
const PEM_PRIVATE_KEY = /-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----/i;
const HEX_PRIVATE_KEY = /^(?:0x)?[0-9a-f]{64}$/i;
const BASE58_TEXT = /^[1-9A-HJ-NP-Za-km-z]+$/;
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** The number of bytes base58 text decodes to, or 0 when it is not base58. */
function base58ByteLength(value) {
  if (!BASE58_TEXT.test(value)) return 0;
  let number = 0n;
  for (const character of value) number = number * 58n + BigInt(BASE58.indexOf(character));
  const significant = number === 0n ? 0 : Math.ceil(number.toString(16).length / 2);
  return significant + (value.match(/^1*/)?.[0].length || 0);
}

// A wallet private key: 32 bytes of hex (EVM) or base58 of 64 bytes (a Solana
// secret key; users still paste them though the radar no longer scans Solana).
// A transaction hash has the hex shape too; refusing one is the accepted cost
// of never storing a key.
const privateKeyWord = word => HEX_PRIVATE_KEY.test(word) || (word.length >= 64 && word.length <= 100 && base58ByteLength(word) === 64);

/** Whether text holds a private key anywhere: a PEM block or a key-shaped word. */
export function containsPrivateKey(text) {
  return typeof text === 'string' && (PEM_PRIVATE_KEY.test(text) || text.split(/[^0-9A-Za-z]+/).some(privateKeyWord));
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function positiveTelegramIdentifier(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value) && BigInt(value).toString() === value) return value;
  return null;
}

function nonNegativeUpdateId(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

// Telegram's interface language for the sender: Chinese clients get Chinese, every other client English.
function senderLocale(from) {
  return typeof from.language_code === 'string' && /^zh/i.test(from.language_code) ? 'zh' : 'en';
}

function privateOwner(envelope) {
  if (!plainObject(envelope?.chat) || !plainObject(envelope?.from) || envelope.chat.type !== 'private') return null;
  const tenantId = positiveTelegramIdentifier(envelope.chat.id);
  const actorUserId = positiveTelegramIdentifier(envelope.from.id);
  return tenantId && actorUserId && tenantId === actorUserId ? { tenantId, actorUserId } : null;
}

function messageReceipt(updateId, message, dueAt, botUsername, { edited = false } = {}) {
  const owner = privateOwner(message);
  const sourceMessageId = positiveInteger(message?.message_id);
  const body = typeof message?.text === 'string' ? message.text : typeof message?.caption === 'string' ? message.caption : null;
  if (!owner || !sourceMessageId || body === null || body.length > MAX_MESSAGE_LENGTH) return null;

  const text = body.trim();
  const match = /^\/([a-z][a-z0-9_]{0,31})(?:@([a-z0-9_]{1,32}))?(?:\s+([\s\S]*))?$/i.exec(text);
  const replyToMessageId = positiveInteger(message.reply_to_message?.message_id);
  const base = {
    tenantId: owner.tenantId,
    actorUserId: owner.actorUserId,
    updateId,
    dueAt,
    messageDate: positiveInteger(message.date),
    sourceMessageId: String(sourceMessageId),
    locale: senderLocale(message.from)
  };
  // Divert secrets before reading anything else. Any message holding a private
  // key (an edit, a caption, one addressed to another bot or a /setkey) is
  // deleted unread: it never reaches storage, logs or a provider. An AVE key (64
  // mixed-case alphanumerics) matches neither private-key shape, so a key shape on
  // /setkey is a wallet key that verification would send to AVE.
  if (containsPrivateKey(text)) return { kind: 'accepted', receipt: { ...base, commandType: 'secret_warning', payload: {} } };
  // An edit or a caption is never a new instruction.
  if (edited || typeof message.text !== 'string') return null;
  if (match?.[2] && (!botUsername || match[2].toLowerCase() !== botUsername.toLowerCase())) return null;
  const command = match?.[1].toLowerCase();
  const argumentsText = match?.[3] || '';
  if (command === 'setkey' && argumentsText) {
    return {
      kind: 'credential',
      receipt: { ...base, commandType: 'credential', payload: { source: 'message' } },
      credentialText: text
    };
  }
  if (match) return {
    kind: 'accepted',
    receipt: {
      ...base,
      commandType: `command:${command}`,
      payload: { source: 'message', arguments: argumentsText, ...(replyToMessageId ? { replyToMessageId: String(replyToMessageId) } : {}) }
    }
  };
  if (!text) return null;
  if (replyToMessageId) return {
    kind: 'accepted',
    receipt: { ...base, commandType: 'reply', payload: { source: 'reply', text, replyToMessageId: String(replyToMessageId) } }
  };
  return { kind: 'accepted', receipt: { ...base, ...plainText(text) } };
}

// Plain text is a pasted contract address or something the bot does not act on;
// the latter's text is dropped here, so it is never stored.
function plainText(text) {
  const address = normalizeTokenAddress(text);
  if (address) return { commandType: 'lookup', payload: { family: 'evm', address } };
  return { commandType: 'text', payload: {} };
}

function callbackReceipt(updateId, callback, dueAt) {
  const owner = privateOwner({ chat: callback?.message?.chat, from: callback?.from });
  const sourceMessageId = positiveInteger(callback?.message?.message_id);
  const data = callback?.data;
  if (!owner || !sourceMessageId || typeof data !== 'string' || typeof callback.id !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(callback.id)) return null;
  if (new TextEncoder().encode(data).byteLength > MAX_CALLBACK_DATA_BYTES || !/^cb:[A-Za-z0-9_-]{1,61}$/.test(data)) return null;

  return {
    kind: 'accepted',
    receipt: {
      tenantId: owner.tenantId,
      actorUserId: owner.actorUserId,
      updateId,
      commandType: 'callback',
      payload: { callbackId: data.slice(3), callbackQueryId: callback.id },
      dueAt,
      messageDate: positiveInteger(callback.message.date),
      sourceMessageId: String(sourceMessageId),
      locale: senderLocale(callback.from)
    }
  };
}

export function parseTelegramUpdate(value, { now = Date.now, botUsername } = {}) {
  if (typeof now !== 'function') throw new TypeError('Telegram receipt clock is invalid');
  if (!plainObject(value)) return { kind: 'ignored' };
  const updateId = nonNegativeUpdateId(value.update_id);
  if (!updateId) return { kind: 'ignored' };
  const dueAt = now();
  if (!Number.isSafeInteger(dueAt) || dueAt < 0) throw new TypeError('Telegram receipt clock returned an invalid timestamp');
  if (plainObject(value.message)) return messageReceipt(updateId, value.message, dueAt, botUsername) || { kind: 'ignored' };
  if (plainObject(value.edited_message)) return messageReceipt(updateId, value.edited_message, dueAt, botUsername, { edited: true }) || { kind: 'ignored' };
  if (plainObject(value.callback_query)) return callbackReceipt(updateId, value.callback_query, dueAt) || { kind: 'ignored' };
  return { kind: 'ignored' };
}

export function validateTelegramReceipt(value) {
  if (!plainObject(value) || !positiveTelegramIdentifier(value.tenantId) || value.tenantId !== value.actorUserId
    || typeof value.updateId !== 'string' || !/^(0|[1-9]\d*)$/.test(value.updateId) || BigInt(value.updateId).toString() !== value.updateId || typeof value.commandType !== 'string'
    || !/^(command:[a-z][a-z0-9_]{0,31}|callback|reply|credential|secret_warning|text|lookup)$/.test(value.commandType)
    || !plainObject(value.payload) || !Number.isSafeInteger(value.dueAt) || value.dueAt < 0
    || (value.messageDate !== null && !positiveInteger(value.messageDate))
    || !positiveTelegramIdentifier(value.sourceMessageId) || !['zh', 'en'].includes(value.locale)) {
    throw new TypeError('Telegram receipt has an unsupported shape');
  }
  const input = value.payload;
  let payload;
  if (value.commandType === 'callback') {
    if (Object.keys(input).length !== 2 || typeof input.callbackId !== 'string' || typeof input.callbackQueryId !== 'string'
      || !/^[A-Za-z0-9_-]{1,61}$/.test(input.callbackId)
      || !/^[A-Za-z0-9_-]{1,256}$/.test(input.callbackQueryId)) throw new TypeError('Telegram callback receipt has an unsupported shape');
    payload = { callbackId: input.callbackId, callbackQueryId: input.callbackQueryId };
  } else if (value.commandType === 'credential') {
    if (Object.keys(input).length !== 1 || input.source !== 'message') throw new TypeError('Telegram credential receipt has an unsupported shape');
    payload = { source: 'message' };
  } else if (value.commandType === 'secret_warning' || value.commandType === 'text') {
    if (Object.keys(input).length !== 0) throw new TypeError('Telegram text receipt has an unsupported shape');
    payload = {};
  } else if (value.commandType === 'lookup') {
    if (Object.keys(input).length !== 2 || input.family !== 'evm'
      || normalizeTokenAddress(input.address) !== input.address) throw new TypeError('Telegram lookup receipt has an unsupported shape');
    payload = { family: input.family, address: input.address };
  } else if (value.commandType === 'reply') {
    if (Object.keys(input).length !== 3 || input.source !== 'reply' || typeof input.text !== 'string'
      || !input.text.trim() || input.text.length > MAX_MESSAGE_LENGTH || containsPrivateKey(input.text)
      || !positiveTelegramIdentifier(input.replyToMessageId)) throw new TypeError('Telegram reply receipt has an unsupported shape');
    payload = { source: 'reply', text: input.text, replyToMessageId: input.replyToMessageId };
  } else {
    if (Object.keys(input).some(key => !['source', 'arguments', 'replyToMessageId'].includes(key))
      || input.source !== 'message' || typeof input.arguments !== 'string' || input.arguments.length > MAX_MESSAGE_LENGTH
      || containsPrivateKey(input.arguments) || (value.commandType === 'command:setkey' && input.arguments)
      || (input.replyToMessageId !== undefined && !positiveTelegramIdentifier(input.replyToMessageId))) throw new TypeError('Telegram command receipt has an unsupported shape');
    payload = { source: 'message', arguments: input.arguments, ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}) };
  }
  return Object.freeze({
    tenantId: value.tenantId,
    actorUserId: value.actorUserId,
    updateId: value.updateId,
    commandType: value.commandType,
    payload: Object.freeze(payload),
    dueAt: value.dueAt,
    messageDate: value.messageDate,
    sourceMessageId: value.sourceMessageId,
    locale: value.locale
  });
}
