// The tenant's dedicated trading hot wallet. The private key exists in
// plaintext only in memory while it signs (or while the transport sends an
// explicit export); at rest it is the encrypted envelope in `keys`.
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { encryptSecret, decryptSecret } from '../util/crypto.mjs';
import { TradingError } from './http.mjs';

export const TRADE_WALLET_KEY_NAME = 'trade-wallet-key';
const WALLET_PREFERENCE = 'trading.wallet';
const privateKeyPattern = /^0x[0-9a-f]{64}$/;

/** Generate a fresh key and its encrypted envelope; never persists anything. */
export async function generateTradingWallet(masterKey, tenantId) {
  const privateKey = generatePrivateKey();
  const address = privateKeyToAccount(privateKey).address;
  return { address, envelope: await encryptSecret(masterKey, tenantId, TRADE_WALLET_KEY_NAME, privateKey) };
}

/** The stored wallet ({ address, createdAt }) or null; fails loudly if its two records disagree. */
export function readTradingWallet(storage, tenantId) {
  const key = storage.sql.exec('SELECT generation, created_at FROM keys WHERE tenant_id=? AND name=?', tenantId, TRADE_WALLET_KEY_NAME).toArray()[0];
  const preference = storage.sql.exec('SELECT value_json FROM preferences WHERE tenant_id=? AND key=?', tenantId, WALLET_PREFERENCE).toArray()[0];
  if (!key && !preference) return null;
  const value = preference ? JSON.parse(preference.value_json) : null;
  if (!key || !value || typeof value.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value.address) || value.generation !== key.generation
    || !(value.exportedAt === undefined || value.exportedAt === null || (Number.isSafeInteger(value.exportedAt) && value.exportedAt >= 0))) {
    throw new TradingError('TRADE_WALLET_CORRUPT', 'trading wallet records disagree');
  }
  return { address: value.address, createdAt: key.created_at, exportedAt: value.exportedAt ?? null };
}

/** Store a generated wallet unless one exists; returns the wallet in effect. */
export function saveTradingWalletInTransaction(storage, tenantId, generated, now) {
  const existing = readTradingWallet(storage, tenantId);
  if (existing) return { ...existing, created: false };
  storage.sql.exec('INSERT INTO keys (tenant_id,name,value_enc,generation,created_at) VALUES (?,?,?,?,?)', tenantId, TRADE_WALLET_KEY_NAME, generated.envelope, 1, now);
  storage.sql.exec('INSERT INTO preferences (tenant_id,key,value_json) VALUES (?,?,?)', tenantId, WALLET_PREFERENCE, JSON.stringify({ address: generated.address, generation: 1, exportedAt: null }));
  return { address: generated.address, createdAt: now, exportedAt: null, created: true };
}

/** Record that Telegram accepted an export of the current key. */
export function markTradingWalletExportedInTransaction(storage, tenantId, at) {
  const wallet = readTradingWallet(storage, tenantId);
  if (!wallet) return;
  storage.sql.exec('UPDATE preferences SET value_json=? WHERE tenant_id=? AND key=?', JSON.stringify({ address: wallet.address, generation: 1, exportedAt: at }), tenantId, WALLET_PREFERENCE);
}

export function removeTradingWalletInTransaction(storage, tenantId) {
  storage.sql.exec('DELETE FROM keys WHERE tenant_id=? AND name=?', tenantId, TRADE_WALLET_KEY_NAME);
  storage.sql.exec('DELETE FROM preferences WHERE tenant_id=? AND key=?', tenantId, WALLET_PREFERENCE);
}

/** The encrypted key envelope, for an export the transport decrypts at send time. */
export function tradingWalletEnvelope(storage, tenantId) {
  const row = storage.sql.exec('SELECT value_enc FROM keys WHERE tenant_id=? AND name=?', tenantId, TRADE_WALLET_KEY_NAME).toArray()[0];
  return row?.value_enc ?? null;
}

/** Decrypt an envelope to its private key, checking it is one. */
export async function revealTradingKey(masterKey, tenantId, envelope) {
  const privateKey = await decryptSecret(masterKey, tenantId, TRADE_WALLET_KEY_NAME, envelope);
  if (!privateKeyPattern.test(privateKey)) throw new TradingError('TRADE_WALLET_CORRUPT', 'trading wallet key is malformed');
  return privateKey;
}

/** A signing account for the stored wallet; its address must match the stored one. */
export async function tradingAccount(storage, masterKey, tenantId) {
  const wallet = readTradingWallet(storage, tenantId);
  const envelope = tradingWalletEnvelope(storage, tenantId);
  if (!wallet || !envelope) throw new TradingError('TRADE_WALLET_MISSING', 'trading wallet is not set up');
  const account = privateKeyToAccount(await revealTradingKey(masterKey, tenantId, envelope));
  if (account.address !== wallet.address) throw new TradingError('TRADE_WALLET_CORRUPT', 'trading wallet key does not match its address');
  return account;
}
