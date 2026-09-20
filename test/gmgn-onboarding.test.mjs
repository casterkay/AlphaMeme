import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GmgnClient } from '../src/providers/gmgn.mjs';
import { GmgnConnection } from '../src/gmgn-connection.mjs';
import { GmgnKeyStore, legacyGmgnApiKey } from '../src/gmgn-key-store.mjs';
import { dependenciesReady, supportedNode } from '../scripts/setup.mjs';

const fakeKey = letter => `gmgn_${letter.repeat(32)}`;

test('setup accepts the checked-in native provider without installing the retired GMGN CLI', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-native-provider-'));
  try {
    fs.cpSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src'), path.join(temporary, 'src'), { recursive: true });
    fs.writeFileSync(path.join(temporary, 'package.json'), JSON.stringify({ type: 'module' }));
    assert.equal(fs.existsSync(path.join(temporary, 'node_modules', 'gmgn-cli')), false);
    assert.equal(await dependenciesReady(temporary), true);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test('UI key overrides both legacy configuration and environment, with no mutation of either', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-credentials-'));
  try {
    const file = path.join(temporary, 'legacy.env');
    const old = `GMGN_API_KEY="${fakeKey('a')}"\nGMGN_PRIVATE_KEY=never-forward\n`;
    fs.writeFileSync(file, old);
    const source = { GMGN_API_KEY: fakeKey('b') };
    assert.equal(legacyGmgnApiKey({}, file), fakeKey('a'));
    assert.equal(legacyGmgnApiKey(source, file), fakeKey('b'));
    const store = new GmgnKeyStore(path.join(temporary, 'state'));
    const client = new GmgnClient({ apiKeyProvider: () => store.get(), legacyKeyProvider: () => legacyGmgnApiKey(source, file) });
    assert.equal(client.apiKey(), fakeKey('b'));
    store.save(fakeKey('c'));
    assert.equal(client.apiKey(), fakeKey('c'));
    assert.equal(typeof client.privateKey, 'undefined');
    assert.equal(fs.readFileSync(file, 'utf8'), old);
    assert.equal(source.GMGN_API_KEY, fakeKey('b'));
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test('direct provider sends only the submitted key in exist-auth and never a command environment', async () => {
  const key = fakeKey('c');
  const requests = [];
  const client = new GmgnClient({ apiKeyProvider: () => key, legacyKeyProvider: () => '', minRequestGapMs: 0,
    randomUUID: () => '11111111-1111-4111-8111-111111111111',
    fetch: async (url, init) => { requests.push({ url: new URL(url), init }); return new Response(JSON.stringify({ code: 0, data: { rank: [] } })); } });
  await client.marketRank('bsc', '5m', { limit: 1 });
  assert.equal(requests[0].init.headers['X-APIKEY'], key);
  assert.equal(requests[0].init.headers['X-Signature'], undefined);
  assert.doesNotMatch(requests[0].url.toString(), new RegExp(key));
  assert.equal(typeof client.childEnvironment, 'undefined');
});

test('provider preserves discovery filters and candle milliseconds while forbidding trading', async () => {
  const calls = [];
  const client = new GmgnClient({ apiKeyProvider: () => fakeKey('d'), legacyKeyProvider: () => '', minRequestGapMs: 0,
    fetch: async (url, init) => { calls.push({ url: new URL(url), init }); return new Response(JSON.stringify({ code: 0, data: { completed: [], rank: [], list: [] } })); } });
  await client.trenches('bsc', { types: ['completed'], limit: 80, filters: {
    max_rug_ratio: .3, max_bundler_rate: .3, max_insider_ratio: .3,
    min_created: '5m', max_created: '10080m', min_marketcap: 10000, max_marketcap: 150000, min_liquidity: 3000
  } });
  await client.marketRank('bsc', '5m', { limit: 100, order_by: 'volume', direction: 'desc', min_created: '5m', max_created: '10080m' });
  const address = '0x' + '1'.repeat(40);
  await client.tokenKline('bsc', address, '1m', 100000, 200000);
  await client.verifyApiKey(fakeKey('d'));
  assert.deepEqual(JSON.parse(calls[0].init.body), { version: 'v2', completed: {
    filters: ['offchain', 'onchain'], launchpad_platform_v2: true, limit: 80,
    quote_address_type: [6, 7, 1, 16, 8, 3, 9, 10, 2, 17, 18, 0],
    max_rug_ratio: .3, max_bundler_rate: .3, max_insider_ratio: .3,
    min_created: '5m', max_created: '10080m', min_marketcap: 10000, max_marketcap: 150000, min_liquidity: 3000
  } });
  assert.equal(calls[1].url.pathname, '/v1/market/rank');
  assert.equal(calls[2].url.searchParams.get('from'), '100000');
  assert.equal(calls[2].url.searchParams.get('to'), '200000');
  assert.equal(calls[3].url.pathname, '/v1/market/rank');
  assert.equal(typeof client.swap, 'undefined');
  assert.equal(typeof client.followWallet, 'undefined');
});

test('API connection verifies read access through a lightweight rank read without a signing surface', async () => {
  let captured;
  const gmgn = new GmgnClient({ legacyKeyProvider: () => '', minRequestGapMs: 0,
    fetch: async (url, init) => { captured = { url: new URL(url), init }; return new Response(JSON.stringify({ code: 0, data: { rank: [] } })); } });
  assert.deepEqual(await gmgn.verifyApiKey(fakeKey('v')), { verified: true });
  assert.equal(captured.url.pathname, '/v1/market/rank');
  assert.equal(captured.url.searchParams.get('limit'), '1');
  assert.equal(captured.init.headers['X-APIKEY'], fakeKey('v'));
  assert.equal(captured.init.headers['X-Signature'], undefined);
});

test('connection rejects a key without pending onboarding before making a provider request', async () => {
  let verified = 0;
  const connection = new GmgnConnection({
    gmgn: { verifyApiKey: async () => { verified++; return { verified: true }; } },
    keyStore: { hasPending: () => false, activatePending: () => true, save() {} },
    scanner: { requestCycle() {} }
  });
  await assert.rejects(connection.apply(fakeKey('z')), { code: 'GMGN_ONBOARDING_REQUIRED' });
  assert.equal(verified, 0);
});

test('first launch stays unconfigured; failed validation preserves key and successful validation requests a scan', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-connect-'));
  try {
    const keyStore = new GmgnKeyStore(temporary);
    let scans = 0;
    const scanner = { activeChain: 'sol', requestCycle() { scans++; } };
    const gmgn = new GmgnClient({ apiKeyProvider: () => keyStore.get(), legacyKeyProvider: () => '' });
    const connection = new GmgnConnection({ gmgn, keyStore, scanner });
    assert.deepEqual(connection.snapshot(), { configured: false, status: 'UNCONFIGURED' });
    assert.equal(await gmgn.configured(), false);
    gmgn.verifyApiKey = async () => { throw Object.assign(new Error('bad'), { code: 'GMGN_AUTH_FAILED' }); };
    await assert.rejects(connection.apply(fakeKey('a')), { code: 'GMGN_ONBOARDING_REQUIRED' });
    keyStore.onboarding();
    await assert.rejects(connection.apply(fakeKey('a')), { code: 'GMGN_AUTH_FAILED' });
    assert.equal(keyStore.get(), '');
    keyStore.save(fakeKey('b'));
    await assert.rejects(connection.apply(fakeKey('a')));
    assert.equal(keyStore.get(), fakeKey('b'));
    assert.equal(scans, 0);
    gmgn.verifyApiKey = async key => {
      gmgn.lastVerifiedKey = key;
      return { verified: true };
    };
    await connection.apply(fakeKey('c'));
    assert.equal(keyStore.get(), fakeKey('c'));
    assert.equal(scans, 1);
    assert.deepEqual(connection.snapshot(), { configured: true, status: 'VERIFIED' });
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test('concurrent key submissions cannot overwrite a key under validation', async () => {
  let finish;
  let saved = '';
  const connection = new GmgnConnection({
    gmgn: { verifyApiKey: () => new Promise(resolve => { finish = resolve; }) },
    keyStore: { hasPending: () => true, activatePending: () => true, save: key => { saved = key; } }, scanner: { activeChain: 'bsc', requestCycle() {} }
  });
  const first = connection.apply(fakeKey('a'));
  await assert.rejects(connection.apply(fakeKey('b')), { code: 'GMGN_CHECK_BUSY' });
  finish({ verified: true });
  await first;
  assert.equal(saved, fakeKey('a'));
});

test('connection waits for credential epoch persistence before scheduling a scan', async () => {
  let resetStarted;
  let finishReset;
  const resetPending = new Promise(resolve => { finishReset = resolve; });
  let scans = 0;
  const connection = new GmgnConnection({
    gmgn: {
      verifyApiKey: async () => ({ verified: true }),
      resetCredentials: () => {
        resetStarted();
        return resetPending;
      }
    },
    keyStore: { hasPending: () => true, activatePending: () => true, save() {} },
    scanner: { requestCycle() { scans++; } }
  });
  const resetObserved = new Promise(resolve => { resetStarted = resolve; });

  const applying = connection.apply(fakeKey('d'));
  await resetObserved;
  assert.equal(scans, 0);
  finishReset();
  await applying;
  assert.equal(scans, 1);
});

test('runtime check rejects Node versions without the proxy flag used by the scanner', () => {
  for (const version of ['20.20.0', '22.22.0', '23.0.0', '24.4.0']) assert.equal(supportedNode(version), false);
  for (const version of ['22.23.0', '22.23.1', '24.5.0', '25.0.0']) assert.equal(supportedNode(version), true);
});

test('an authenticated empty discovery is an empty scan, not a connection failure', async () => {
  const gmgn = new GmgnClient({ legacyKeyProvider: () => '' });
  gmgn.trenches = async () => ({ completed: [] });
  gmgn.marketRank = async () => ({ rank: [] });
  assert.deepEqual(await gmgn.discover('sol'), []);
  assert.equal(gmgn.lastDiscoveryHealth.complete, true);
});
