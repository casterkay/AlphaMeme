import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePoolAddress, normalizeTokenAddress, validTokenAddress } from '../src/address.mjs';
import { SecondaryValidator } from '../src/providers/secondary.mjs';

const solanaMint = 'So11111111111111111111111111111111111111112';
const evm = '0x1234567890abcdef1234567890abcdef12345678';

test('one strict EVM address validator is shared by chain-facing layers', async () => {
  assert.equal(normalizeTokenAddress(evm.toUpperCase().replace(/^0X/, '0x')), evm);
  assert.equal(normalizePoolAddress(`0x${'12'.repeat(32)}`), `0x${'12'.repeat(32)}`);
  for (const address of [solanaMint, `0x${'0'.repeat(40)}`, `0x${'e'.repeat(40)}`, ` ${evm}`]) assert.equal(validTokenAddress(address), false, address);

  let requests = 0;
  const secondary = await new SecondaryValidator({ fetchImpl: async () => { requests++; return Response.json({}); } })
    .fetchSource({ chain: 'base', tokenAddress: solanaMint });
  assert.equal(requests, 0);
  assert.equal(secondary.source.errorCode, 'INVALID_ADDRESS');
});
