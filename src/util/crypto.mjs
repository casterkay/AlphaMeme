const encoder = new TextEncoder();

export async function sha256Bytes(input) {
  const bytes = typeof input === 'string' ? encoder.encode(input) : input;
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
}

export async function sha256Hex(input) {
  return Array.from(await sha256Bytes(input), byte => byte.toString(16).padStart(2, '0')).join('');
}
