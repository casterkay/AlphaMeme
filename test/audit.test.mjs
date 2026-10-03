import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SecondaryValidator, goPlusHoldings } from '../src/providers/secondary.mjs';
import { scannerSettings } from '../src/scanner-settings.mjs';
import { AUDIT_RULES, auditFacts, postAlertAudit } from '../src/scoring/audit.mjs';

// GoPlus records read live on 2026-10-03, trimmed to the fields the check parses.
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/goplus-${name}.json`, import.meta.url), 'utf8'));
const TOKENS = {
  'arc-memespad': ['arc', '0x0bb3befba323578dad33efb6356c69b557787777'],
  'bsc-tart': ['bsc', '0x7ab8d02cbb51ff7223fde700eaaa2a91bf750314'],
  'eth-agl': ['eth', '0x63401cdd577478f9389a1683e866a937f072d1c2']
};
async function check(payload, chain, tokenAddress) {
  const value = await new SecondaryValidator({ fetchImpl: async () => Response.json(payload) }).fetchSource({ chain, tokenAddress });
  return goPlusHoldings({ goPlus: { value, collectedAt: 1 } });
}
const holdingsOf = name => check(fixture(name), ...TOKENS[name]);
// Each rule sees only the settings it declares, since only those enter the ruleset id.
const strictSettings = rule => new Proxy(scannerSettings, {
  get: (target, key) => rule.settings.includes(key) ? target[key] : assert.fail(`${rule.id} read the undeclared setting ${String(key)}`)
});
const verdicts = facts => Object.fromEntries(AUDIT_RULES.map(rule => [rule.id, rule.evaluate(facts, strictSettings(rule))]));

test('the GoPlus holder distribution is parsed at the boundary on Arc, BSC and Ethereum', async () => {
  const arc = await holdingsOf('arc-memespad');
  assert.equal(arc.holders.length, 10);
  assert.deepEqual(arc.holders[0], { address: '0x8366a39cc670b4001a1121b8f6a443a643e40951', rate: 0.215923, locked: false, contract: true, tag: '' });
  assert.deepEqual([arc.lpHolders[0].address, arc.lpHolders[0].locked, arc.lpHolders[0].nftPositions], ['0x000000000000000000000000000000000000dead', true, true]);
  assert.equal(arc.ownerAddress, null, 'GoPlus omits the owner of this Arc token');
  assert.deepEqual([arc.creatorRate, arc.creatorHoneypots, arc.venues], [0, false, ['UniV4']]);
  assert.deepEqual(arc.pairAddresses, [], 'a v4 pool id is not an address');
  const bsc = await holdingsOf('bsc-tart');
  assert.deepEqual(bsc.pairAddresses, ['0x30000a407fabebe29439f8e437050512ff6661be']);
  assert.equal(bsc.lpHolders.some(holder => holder.nftPositions), false);
  assert.deepEqual([bsc.ownerAddress, bsc.creatorRate], ['0x0000000000000000000000000000000000000000', 0.00022]);
  assert.equal((await holdingsOf('eth-agl')).ownerAddress, '0x9afdee0b0af90945e47e0d4e8d3139669a7c5f1a');
});

test('a holder list with an unreadable entry is unknown as a whole, and an unanswered check has no holdings', async () => {
  const payload = fixture('bsc-tart'), record = Object.values(payload.result)[0];
  record.holders = [...record.holders, { address: 'not an address', percent: '0.5', is_locked: 0 }];
  record.lp_holders = [{ ...record.lp_holders[0], percent: '150' }];
  const holdings = await check(payload, ...TOKENS['bsc-tart']);
  assert.deepEqual([holdings.holders, holdings.lpHolders], [null, null]);
  assert.equal(await check({ code: 1, result: {} }, ...TOKENS['bsc-tart']), null, 'no record for the token');
  assert.equal(goPlusHoldings({ goPlus: { error: { code: 'TIMEOUT' }, collectedAt: 1 } }), null);
  assert.equal(goPlusHoldings({ goPlus: { value: { source: { status: 'OK' }, security: {} }, collectedAt: 1 } }), null, 'a check recorded before holdings were kept');
});

test('each recorded token gets the verdicts its holders call for', async () => {
  for (const [name, liquidity, expected] of [
    // TART: its V2 pair, the burn address and a locker are set aside; the next six hold about 52%. Only 76% of its LP is locked or burned.
    ['bsc-tart', 12_000, { OWNER_NOT_RENOUNCED: 'CLEAR', LP_NOT_LOCKED: 'HIT', TOP10_CONCENTRATED: 'HIT', DEV_HOLD_TOO_HIGH: 'CLEAR', LIQUIDITY_BELOW_STRICT: 'CLEAR', CREATOR_HONEYPOT_HISTORY: 'CLEAR' }],
    // MEMESPAD: Arc's pinned v4 PoolManager (22%) and the burn address are set aside. GoPlus gives no owner; its LP is an NFT position.
    ['arc-memespad', 5_000, { OWNER_NOT_RENOUNCED: 'UNKNOWN', LP_NOT_LOCKED: 'UNKNOWN', TOP10_CONCENTRATED: 'CLEAR', DEV_HOLD_TOO_HIGH: 'CLEAR', LIQUIDITY_BELOW_STRICT: 'HIT', CREATOR_HONEYPOT_HISTORY: 'CLEAR' }],
    // AGL trades on v4 on Ethereum, whose PoolManager we do not pin, so its top holders cannot be told from its pools.
    ['eth-agl', null, { OWNER_NOT_RENOUNCED: 'HIT', LP_NOT_LOCKED: 'UNKNOWN', TOP10_CONCENTRATED: 'UNKNOWN', DEV_HOLD_TOO_HIGH: 'CLEAR', LIQUIDITY_BELOW_STRICT: 'UNKNOWN', CREATOR_HONEYPOT_HISTORY: 'CLEAR' }]
  ]) {
    const facts = auditFacts({ chain: TOKENS[name][0], holdings: await holdingsOf(name), liquidity });
    const ran = Object.fromEntries(Object.entries(verdicts(facts)).filter(([id]) => id in expected));
    assert.deepEqual(ran, expected, name);
  }
  // The positions whose lock no rule counts yet are kept as evidence: MEMESPAD's one LP position is owned by the dead address.
  const memespad = auditFacts({ chain: 'arc', holdings: await holdingsOf('arc-memespad'), liquidity: null });
  assert.deepEqual(memespad.lpPositions, [{ address: '0x000000000000000000000000000000000000dead', rate: 1, locked: true }]);
  const tart = auditFacts({ chain: 'bsc', holdings: await holdingsOf('bsc-tart'), liquidity: 12_000 });
  assert.deepEqual(tart.lpPositions, [], 'V2 LP tokens are not positions');
  assert.ok(Math.abs(tart.top10Rate - .5224) < .001 && Math.abs(tart.lpLockedRate - .7562) < .001, JSON.stringify(tart));
});

test('every check that ran hits past its threshold, clears within it, and is unknown without its fact', () => {
  const s = scannerSettings;
  const clear = { ownerRenounced: true, lpLockedRate: s.minLpLockedRate, top10Rate: s.maxTop10Rate, creatorRate: s.maxDevHoldRate, creatorHoneypots: false, liquidity: s.strictLiquidity };
  const hit = { ownerRenounced: false, lpLockedRate: s.minLpLockedRate - .01, top10Rate: s.maxTop10Rate + .01, creatorRate: s.maxDevHoldRate + .001, creatorHoneypots: true, liquidity: s.strictLiquidity - 1 };
  const ran = AUDIT_RULES.filter(rule => rule.source !== null);
  assert.deepEqual(ran.map(rule => rule.id), ['OWNER_NOT_RENOUNCED', 'LP_NOT_LOCKED', 'TOP10_CONCENTRATED', 'DEV_HOLD_TOO_HIGH', 'LIQUIDITY_BELOW_STRICT', 'CREATOR_HONEYPOT_HISTORY']);
  for (const [facts, verdict] of [[clear, 'CLEAR'], [hit, 'HIT'], [Object.fromEntries(Object.keys(clear).map(key => [key, null])), 'UNKNOWN']]) {
    for (const rule of ran) assert.equal(verdicts(facts)[rule.id], verdict, `${rule.id} ${verdict}`);
  }
  assert.equal(scannerSettings.maxDevHoldRate, .01);
});

test('locked, burned and pool supply never counts toward the top holders, and V3 or V4 LP positions leave the lock unknown', () => {
  const holder = (address, rate, more = {}) => ({ address, rate, locked: false, contract: false, tag: '', ...more });
  const base = { pairAddresses: ['0x' + 'b'.repeat(40)], venues: ['UniV2'], lpTotalSupply: 10, creatorRate: 0, ownerAddress: null, creatorHoneypots: null };
  const holdings = { ...base, holders: [holder('0x' + 'a'.repeat(40), .2), holder('0x' + 'b'.repeat(40), .5), holder('0x' + 'c'.repeat(40), .3, { locked: true }),
    holder('0x000000000000000000000000000000000000dead', .4), holder('0x0000000000000000000000000000000000000000', .1)],
  lpHolders: [holder('0x' + 'c'.repeat(40), .7, { locked: true }), holder('0x000000000000000000000000000000000000dead', .15), holder('0x' + 'd'.repeat(40), .15)] };
  const facts = auditFacts({ chain: 'bsc', holdings, liquidity: null });
  assert.deepEqual([facts.top10Rate, Math.round(facts.lpLockedRate * 100) / 100], [.2, .85]);
  const positions = { ...holdings, lpHolders: holdings.lpHolders.map((item, index) => ({ ...item, nftPositions: index === 2 })) };
  assert.equal(auditFacts({ chain: 'bsc', holdings: positions, liquidity: null }).lpLockedRate, null);
  for (const empty of [{ lpHolders: [] }, { lpTotalSupply: 0 }, { lpTotalSupply: null }]) assert.equal(auditFacts({ chain: 'bsc', holdings: { ...holdings, ...empty }, liquidity: null }).lpLockedRate, null);
  assert.equal(auditFacts({ chain: 'bsc', holdings: { ...holdings, venues: ['UniV2', 'UniV4'] }, liquidity: null }).top10Rate, null);
  assert.equal(auditFacts({ chain: 'bsc', holdings: { ...holdings, holders: [] }, liquidity: null }).top10Rate, null);
});

test('the checks without a source never run: they stay unknown and the record lists them apart from checks that ran without data', () => {
  const audit = postAlertAudit({ chain: 'arc', holdings: null, liquidity: null, at: 7 }, scannerSettings);
  const notRun = AUDIT_RULES.filter(rule => rule.source === null).map(rule => rule.id);
  assert.deepEqual(audit.notRun, notRun);
  assert.equal(notRun.length, 13);
  assert.ok(notRun.includes('SELL_ALL_SIMULATION') && notRun.includes('CREATOR_LAUNCHES_24H') && notRun.includes('HOLDERS_GROWING'));
  assert.ok(Object.values(audit.verdicts).every(verdict => verdict === 'UNKNOWN'), 'a check GoPlus did not answer is unknown');
  assert.ok(Object.keys(audit.verdicts).filter(id => !notRun.includes(id)).length === 6, 'the six that ran without data are not listed as not run');
  assert.ok(AUDIT_RULES.every(rule => rule.mode === 'SHADOW'));
  assert.equal(audit.at, 7);
});

test('the audit ruleset id changes with every threshold an audit rule reads, and with no other setting', () => {
  const ruleset = settings => postAlertAudit({ chain: 'arc', holdings: null, liquidity: null, at: 0 }, settings).ruleset;
  const current = ruleset(scannerSettings);
  assert.match(current, /^rs-[0-9a-f]{8}$/);
  const declared = new Set(AUDIT_RULES.flatMap(rule => rule.settings));
  assert.deepEqual([...declared].sort(), ['maxDevHoldRate', 'maxTop10Rate', 'minLpLockedRate', 'strictLiquidity']);
  for (const key of declared) assert.notEqual(ruleset({ ...scannerSettings, [key]: scannerSettings[key] + 1 }), current, key);
  for (const key of ['minLiquidity', 'maxBuyTax', 'scanIntervalMs']) assert.equal(ruleset({ ...scannerSettings, [key]: scannerSettings[key] + 1 }), current, key);
  assert.equal(new Set(AUDIT_RULES.map(rule => rule.id)).size, AUDIT_RULES.length, 'rule ids are unique');
});
