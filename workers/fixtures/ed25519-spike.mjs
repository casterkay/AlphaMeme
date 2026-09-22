/** @param {ArrayBuffer} der @param {'PUBLIC KEY' | 'PRIVATE KEY'} label */
function toPem(der, label) {
  const base64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  return `-----BEGIN ${label}-----\n${base64.match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
}

/** @param {string} pem @param {'PUBLIC KEY' | 'PRIVATE KEY'} label */
function fromPem(pem, label) {
  const base64 = pem.replace(`-----BEGIN ${label}-----`, '')
    .replace(`-----END ${label}-----`, '').replace(/\s/g, '');
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

/** Exercise the complete onboarding key lifecycle without returning key material. */
export async function runEd25519Spike() {
  const algorithm = { name: 'Ed25519' };
  const pair = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
  const publicDer = await crypto.subtle.exportKey('spki', pair.publicKey);
  const privateDer = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  const publicPem = toPem(publicDer, 'PUBLIC KEY');
  const privatePem = toPem(privateDer, 'PRIVATE KEY');
  const publicKey = await crypto.subtle.importKey('spki', fromPem(publicPem, 'PUBLIC KEY'), algorithm, true, ['verify']);
  const privateKey = await crypto.subtle.importKey('pkcs8', fromPem(privatePem, 'PRIVATE KEY'), algorithm, false, ['sign']);
  const message = new TextEncoder().encode('GET /api/v1/test?timestamp=1700000000');
  const signature = await crypto.subtle.sign(algorithm, privateKey, message);
  const alteredMessage = new Uint8Array(message);
  alteredMessage[0] ^= 1;
  const alteredSignature = new Uint8Array(signature.slice(0));
  alteredSignature[0] ^= 1;
  const otherPair = await crypto.subtle.generateKey(algorithm, false, ['sign', 'verify']);
  let privateExportRejected = false;
  try {
    await crypto.subtle.exportKey('pkcs8', privateKey);
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== 'InvalidAccessError') throw error;
    privateExportRejected = true;
  }
  return {
    algorithm: publicKey.algorithm.name,
    publicPemRoundTrip: toPem(await crypto.subtle.exportKey('spki', publicKey), 'PUBLIC KEY') === publicPem,
    publicDerBytes: publicDer.byteLength,
    privateDerBytes: privateDer.byteLength,
    signatureBytes: signature.byteLength,
    validSignature: await crypto.subtle.verify(algorithm, publicKey, signature, message),
    originalPublicKeyAcceptsSignature: await crypto.subtle.verify(algorithm, pair.publicKey, signature, message),
    alteredMessageRejected: !await crypto.subtle.verify(algorithm, publicKey, signature, alteredMessage),
    alteredSignatureRejected: !await crypto.subtle.verify(algorithm, publicKey, alteredSignature, message),
    wrongKeyRejected: !await crypto.subtle.verify(algorithm, otherPair.publicKey, signature, message),
    privateExportRejected
  };
}

export default {
  async fetch() {
    return Response.json(await runEd25519Spike());
  }
};
