import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { GoPlusAuth, goPlusCredentials } from '../src/providers/goplus-auth.mjs';
import { SecondaryValidator } from '../src/providers/secondary.mjs';

const evmAddress = '0x1111111111111111111111111111111111111111';
const credentials = { appKey: 'app-key', appSecret: 'app-secret' };

function tokenServer({ expiresIn = 7200, answer } = {}) {
  const signIns = [];
  let issued = 0;
  const fetchImpl = async (url, init) => {
    assert.equal(String(url), 'https://api.gopluslabs.io/api/v1/token');
    const body = JSON.parse(init.body);
    signIns.push(body);
    if (answer) return answer();
    return Response.json({ code: 1, message: 'ok', result: { access_token: `token-${++issued}`, expires_in: expiresIn } });
  };
  return { fetchImpl, signIns };
}

test('goPlusCredentials takes both values or neither, and refuses half a pair', () => {
  assert.equal(goPlusCredentials({}), null);
  assert.equal(goPlusCredentials({ GOPLUS_APP_KEY: ' ', GOPLUS_APP_SECRET: '' }), null);
  assert.deepEqual(goPlusCredentials({ GOPLUS_APP_KEY: ' k ', GOPLUS_APP_SECRET: 's' }), { appKey: 'k', appSecret: 's' });
  assert.throws(() => goPlusCredentials({ GOPLUS_APP_KEY: 'k' }), /set together/);
  assert.throws(() => goPlusCredentials({ GOPLUS_APP_SECRET: 's' }), /set together/);
});

test('sign-in signs sha1(key + time + secret) and reuses the token until shortly before it expires', async () => {
  let now = 1_790_000_000_000;
  const server = tokenServer();
  const auth = new GoPlusAuth({ ...credentials, fetchImpl: server.fetchImpl, now: () => now });
  const [first, concurrent] = await Promise.all([auth.accessToken(), auth.accessToken()]);
  assert.deepEqual([first, concurrent], ['token-1', 'token-1']);
  const time = Math.floor(now / 1000);
  assert.deepEqual(server.signIns, [{ app_key: 'app-key', time, sign: createHash('sha1').update(`app-key${time}app-secret`).digest('hex') }]);
  now += 7200_000 - 5 * 60_000 - 1;
  assert.equal(await auth.accessToken(), 'token-1');
  now += 1;
  assert.equal(await auth.accessToken(), 'token-2');
  auth.forget();
  assert.equal(await auth.accessToken(), 'token-3');
});

test('a failed sign-in names its cause and never quotes the request', async () => {
  for (const [scenario, answer, code] of [
    ['refused', () => Response.json({ code: 4012, message: 'bad sign' }), 'GOPLUS_AUTH_REJECTED'],
    ['HTTP error', () => new Response('no', { status: 503 }), 'GOPLUS_AUTH_HTTP_503'],
    ['network', () => { throw new TypeError('fetch failed app-secret'); }, 'GOPLUS_AUTH_FAILED']
  ]) {
    const error = await new GoPlusAuth({ ...credentials, fetchImpl: tokenServer({ answer }).fetchImpl }).accessToken().catch(caught => caught);
    assert.equal(error.code, code, scenario);
    assert.doesNotMatch(error.message, /app-secret|app-key/, scenario);
  }
});

test('GoPlus checks carry the access token, report 4029 as rate limited, and sign in again after a refusal', async () => {
  const seen = [];
  let goPlusCode = 1;
  const auth = new GoPlusAuth({ ...credentials, fetchImpl: tokenServer().fetchImpl });
  const validator = new SecondaryValidator({ goPlusAuth: auth, fetchImpl: async (url, init) => {
    seen.push(init.headers.Authorization);
    return Response.json({ code: goPlusCode, message: 'ok', result: {} });
  } });
  const check = () => validator.fetchSource({ source: 'goPlus', chain: 'bsc', tokenAddress: evmAddress });
  assert.notEqual((await check()).source.status, 'ERROR');
  goPlusCode = 4029;
  assert.deepEqual((await check()).source, { status: 'ERROR', errorCode: 'RATE_LIMITED' });
  goPlusCode = 4012;
  assert.deepEqual((await check()).source, { status: 'ERROR', errorCode: 'UPSTREAM_REJECTED' });
  goPlusCode = 1;
  await check();
  assert.deepEqual(seen, ['token-1', 'token-1', 'token-1', 'token-2']);
});

test('without app credentials GoPlus is called anonymously', async () => {
  let headers;
  await new SecondaryValidator({ fetchImpl: async (url, init) => { headers = init.headers; return Response.json({ code: 1, result: {} }); } })
    .fetchSource({ source: 'goPlus', chain: 'bsc', tokenAddress: evmAddress });
  assert.equal(headers.Authorization, undefined);
});
