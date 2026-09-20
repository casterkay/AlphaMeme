function bearerToken(authorization) {
  if (typeof authorization !== 'string') return null;
  const match = /^Bearer ([^\s]+)$/.exec(authorization.trim());
  return match ? match[1] : null;
}

function equalDigests(left, right) {
  if (typeof crypto.subtle.timingSafeEqual === 'function') return crypto.subtle.timingSafeEqual(left, right);

  const leftBytes = new Uint8Array(left);
  const rightBytes = new Uint8Array(right);
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) difference |= leftBytes[index] ^ rightBytes[index];
  return difference === 0;
}

export async function isExactSecretToken(suppliedToken, expectedToken) {
  if (typeof suppliedToken !== 'string' || typeof expectedToken !== 'string' || expectedToken.length === 0) return false;
  const encoder = new TextEncoder();
  const [suppliedDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(suppliedToken)),
    crypto.subtle.digest('SHA-256', encoder.encode(expectedToken))
  ]);
  return equalDigests(suppliedDigest, expectedDigest);
}

export async function isAuthorizedBearer(authorization, expectedToken) {
  const suppliedToken = bearerToken(authorization);
  return suppliedToken ? isExactSecretToken(suppliedToken, expectedToken) : false;
}

export async function isAuthorizedTelegramWebhookSecret(headerValue, expectedToken) {
  return isExactSecretToken(headerValue, expectedToken);
}
