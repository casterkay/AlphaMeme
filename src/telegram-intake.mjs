const MAX_CALLBACK_DATA_BYTES = 64;
const MAX_MESSAGE_LENGTH = 4096;

// Divert credentials before interpreting commands or prompt replies.
export function containsTelegramCredential(text) {
  return typeof text === 'string' && /gmgn_|-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----/i.test(text);
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

function privateOwner(envelope) {
  if (!plainObject(envelope?.chat) || !plainObject(envelope?.from) || envelope.chat.type !== 'private') return null;
  const tenantId = positiveTelegramIdentifier(envelope.chat.id);
  const actorUserId = positiveTelegramIdentifier(envelope.from.id);
  return tenantId && actorUserId && tenantId === actorUserId ? { tenantId, actorUserId } : null;
}

function messageReceipt(updateId, message, dueAt, botUsername) {
  const owner = privateOwner(message);
  const sourceMessageId = positiveInteger(message?.message_id);
  if (!owner || !sourceMessageId || typeof message.text !== 'string' || message.text.length > MAX_MESSAGE_LENGTH) return null;

  const text = message.text.trim();
  const match = /^\/([a-z][a-z0-9_]{0,31})(?:@([a-z0-9_]{1,32}))?(?:\s+([\s\S]*))?$/i.exec(text);
  const replyToMessageId = positiveInteger(message.reply_to_message?.message_id);
  const base = {
    tenantId: owner.tenantId,
    actorUserId: owner.actorUserId,
    updateId,
    dueAt,
    messageDate: positiveInteger(message.date),
    sourceMessageId: String(sourceMessageId)
  };
  if (match?.[2] && (!botUsername || match[2].toLowerCase() !== botUsername.toLowerCase())) return null;
  const argumentsText = match?.[3] || '';
  if (containsTelegramCredential(text) || (match?.[1].toLowerCase() === 'setkey' && argumentsText)) {
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
      commandType: `command:${match[1].toLowerCase()}`,
      payload: { source: 'message', arguments: argumentsText, ...(replyToMessageId ? { replyToMessageId: String(replyToMessageId) } : {}) }
    }
  };
  if (!text || !replyToMessageId) return null;
  return {
    kind: 'accepted',
    receipt: { ...base, commandType: 'reply', payload: { source: 'reply', text, replyToMessageId: String(replyToMessageId) } }
  };
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
      sourceMessageId: String(sourceMessageId)
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
  if (plainObject(value.callback_query)) return callbackReceipt(updateId, value.callback_query, dueAt) || { kind: 'ignored' };
  return { kind: 'ignored' };
}

export function validateTelegramReceipt(value) {
  if (!plainObject(value) || !positiveTelegramIdentifier(value.tenantId) || value.tenantId !== value.actorUserId
    || typeof value.updateId !== 'string' || !/^(0|[1-9]\d*)$/.test(value.updateId) || BigInt(value.updateId).toString() !== value.updateId || typeof value.commandType !== 'string'
    || !/^(command:[a-z][a-z0-9_]{0,31}|callback|reply|credential)$/.test(value.commandType)
    || !plainObject(value.payload) || !Number.isSafeInteger(value.dueAt) || value.dueAt < 0
    || (value.messageDate !== null && !positiveInteger(value.messageDate))
    || !positiveTelegramIdentifier(value.sourceMessageId)) {
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
  } else if (value.commandType === 'reply') {
    if (Object.keys(input).length !== 3 || input.source !== 'reply' || typeof input.text !== 'string'
      || !input.text.trim() || input.text.length > MAX_MESSAGE_LENGTH || containsTelegramCredential(input.text)
      || !positiveTelegramIdentifier(input.replyToMessageId)) throw new TypeError('Telegram reply receipt has an unsupported shape');
    payload = { source: 'reply', text: input.text, replyToMessageId: input.replyToMessageId };
  } else {
    if (Object.keys(input).some(key => !['source', 'arguments', 'replyToMessageId'].includes(key))
      || input.source !== 'message' || typeof input.arguments !== 'string' || input.arguments.length > MAX_MESSAGE_LENGTH
      || containsTelegramCredential(input.arguments) || (value.commandType === 'command:setkey' && input.arguments)
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
    sourceMessageId: value.sourceMessageId
  });
}
