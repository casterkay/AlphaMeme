import assert from 'node:assert/strict';
import test from 'node:test';
import { isAuthorizedBearer, isAuthorizedTelegramWebhookSecret } from '../src/worker-auth.mjs';

test('operator bearer authentication fails closed and accepts only an exact bearer credential', async () => {
  const expected = 'test-only-operator-token';

  assert.equal(await isAuthorizedBearer(null, expected), false);
  assert.equal(await isAuthorizedBearer('Basic test-only-operator-token', expected), false);
  assert.equal(await isAuthorizedBearer('Bearer test-only-operator-token extra', expected), false);
  assert.equal(await isAuthorizedBearer('Bearer test-only-operator-tokeN', expected), false);
  assert.equal(await isAuthorizedBearer('Bearer test-only-operator-token', expected), true);
  assert.equal(await isAuthorizedBearer('Bearer test-only-operator-token', ''), false);
});

test('Telegram webhook authentication accepts the raw exact secret instead of a bearer credential', async () => {
  const expected = 'test-only-telegram-secret';

  assert.equal(await isAuthorizedTelegramWebhookSecret(null, expected), false);
  assert.equal(await isAuthorizedTelegramWebhookSecret(`Bearer ${expected}`, expected), false);
  assert.equal(await isAuthorizedTelegramWebhookSecret(`${expected} `, expected), false);
  assert.equal(await isAuthorizedTelegramWebhookSecret('test-only-telegram-secreT', expected), false);
  assert.equal(await isAuthorizedTelegramWebhookSecret(expected, expected), true);
  assert.equal(await isAuthorizedTelegramWebhookSecret(expected, ''), false);
});
