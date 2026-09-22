const MAX_CALLBACK_DATA_BYTES = 64;

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

function messageReceipt(updateId, message, dueAt) {
  const owner = privateOwner(message);
  const sourceMessageId = positiveInteger(message?.message_id);
  if (!owner || !sourceMessageId || typeof message.text !== 'string') return null;

  const text = message.text.trim();
  if (/^\/setkey\b/i.test(text) || /^gmgn_/i.test(text)) return { kind: 'credential_rejected' };
  const match = /^\/([a-z][a-z0-9_]{0,31})(?:@[a-z0-9_]{1,32})?(?:\s|$)/i.exec(text);
  if (!match) return null;

  return {
    kind: 'accepted',
    receipt: {
      tenantId: owner.tenantId,
      actorUserId: owner.actorUserId,
      updateId,
      commandType: `command:${match[1].toLowerCase()}`,
      payload: { source: 'message' },
      dueAt,
      messageDate: positiveInteger(message.date),
      sourceMessageId: String(sourceMessageId)
    }
  };
}

function callbackReceipt(updateId, callback, dueAt) {
  const owner = privateOwner({ chat: callback?.message?.chat, from: callback?.from });
  const sourceMessageId = positiveInteger(callback?.message?.message_id);
  const data = callback?.data;
  if (!owner || !sourceMessageId || typeof data !== 'string') return null;
  if (new TextEncoder().encode(data).byteLength > MAX_CALLBACK_DATA_BYTES || !/^cb:[A-Za-z0-9_-]{1,61}$/.test(data)) return null;

  return {
    kind: 'accepted',
    receipt: {
      tenantId: owner.tenantId,
      actorUserId: owner.actorUserId,
      updateId,
      commandType: 'callback',
      payload: { callbackId: data.slice(3) },
      dueAt,
      messageDate: positiveInteger(callback.message.date),
      sourceMessageId: String(sourceMessageId)
    }
  };
}

export function parseTelegramUpdate(value, { now = Date.now } = {}) {
  if (typeof now !== 'function') throw new TypeError('Telegram receipt clock is invalid');
  if (!plainObject(value)) return { kind: 'ignored' };
  const updateId = nonNegativeUpdateId(value.update_id);
  if (!updateId) return { kind: 'ignored' };
  const dueAt = now();
  if (!Number.isSafeInteger(dueAt) || dueAt < 0) throw new TypeError('Telegram receipt clock returned an invalid timestamp');
  if (plainObject(value.message)) return messageReceipt(updateId, value.message, dueAt) || { kind: 'ignored' };
  if (plainObject(value.callback_query)) return callbackReceipt(updateId, value.callback_query, dueAt) || { kind: 'ignored' };
  return { kind: 'ignored' };
}

export function validateTelegramReceipt(value) {
  if (!plainObject(value) || !positiveTelegramIdentifier(value.tenantId) || value.tenantId !== value.actorUserId
    || typeof value.updateId !== 'string' || !/^(0|[1-9]\d*)$/.test(value.updateId) || BigInt(value.updateId).toString() !== value.updateId || typeof value.commandType !== 'string'
    || !/^(command:[a-z][a-z0-9_]{0,31}|callback)$/.test(value.commandType)
    || !plainObject(value.payload) || !Number.isSafeInteger(value.dueAt) || value.dueAt < 0
    || (value.messageDate !== null && !positiveInteger(value.messageDate))
    || !positiveTelegramIdentifier(value.sourceMessageId)) {
    throw new TypeError('Telegram receipt has an unsupported shape');
  }
  const payload = value.commandType === 'callback'
    ? (() => {
      if (Object.keys(value.payload).length !== 1 || typeof value.payload.callbackId !== 'string' || !/^[A-Za-z0-9_-]{1,61}$/.test(value.payload.callbackId)) {
        throw new TypeError('Telegram callback receipt has an unsupported shape');
      }
      return { callbackId: value.payload.callbackId };
    })()
    : (() => {
      if (Object.keys(value.payload).length !== 1 || value.payload.source !== 'message') throw new TypeError('Telegram command receipt has an unsupported shape');
      return { source: 'message' };
    })();
  return Object.freeze({
    tenantId: value.tenantId,
    actorUserId: value.actorUserId,
    updateId: value.updateId,
    commandType: value.commandType,
    payload,
    dueAt: value.dueAt,
    messageDate: value.messageDate,
    sourceMessageId: value.sourceMessageId
  });
}
