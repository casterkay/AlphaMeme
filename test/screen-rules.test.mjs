import test from 'node:test';
import assert from 'node:assert/strict';
import { scannerSettings } from '../src/scanner-settings.mjs';
import { ENFORCE, SHADOW, evaluateRules, rulesetVersion } from '../src/scoring/rules.mjs';
import { SCREEN_RULES, discoveryScreen } from '../src/scoring/screen.mjs';

const rule = (id, role, verdict, mode = ENFORCE, settings = []) => ({ id, version: 1, role, mode, settings, evaluate: () => verdict });

test('a token is dropped by any enforced DROP hit, admitted only when every enforced ADMIT rule is clear, and otherwise undecided', () => {
  for (const [scenario, rules, decision, reasons] of [
    ['all clear', [rule('D', 'DROP', 'CLEAR'), rule('A', 'ADMIT', 'CLEAR')], 'ADMIT', []],
    ['an unknown DROP rule does not block', [rule('D', 'DROP', 'UNKNOWN'), rule('A', 'ADMIT', 'CLEAR')], 'ADMIT', []],
    ['an unknown ADMIT rule blocks', [rule('D', 'DROP', 'CLEAR'), rule('A', 'ADMIT', 'UNKNOWN')], 'UNDECIDED', ['A']],
    ['an ADMIT hit blocks', [rule('A', 'ADMIT', 'HIT')], 'UNDECIDED', ['A']],
    ['a DROP hit drops, whatever the ADMIT rules say', [rule('A', 'ADMIT', 'UNKNOWN'), rule('D', 'DROP', 'HIT')], 'DROP', ['A', 'D']],
    ['a shadow hit is recorded but never decides', [rule('S', 'DROP', 'HIT', SHADOW), rule('T', 'ADMIT', 'UNKNOWN', SHADOW)], 'ADMIT', []]
  ]) {
    const result = evaluateRules({}, {}, rules);
    assert.deepEqual([result.decision, result.reasons], [decision, reasons], scenario);
    assert.deepEqual(result.verdicts, Object.fromEntries(rules.map(item => [item.id, item.evaluate()])), scenario);
  }
});

test('the ruleset version follows every rule\'s id, version, role and mode, but not the table order', () => {
  const rules = [rule('A', 'ADMIT', 'CLEAR'), rule('D', 'DROP', 'CLEAR')];
  const version = rulesetVersion(rules, {});
  assert.match(version, /^rs-[0-9a-f]{8}$/);
  assert.equal(rulesetVersion([...rules].reverse(), {}), version);
  for (const change of [{ version: 2 }, { mode: SHADOW }, { role: 'DROP' }, { id: 'B' }]) {
    assert.notEqual(rulesetVersion([{ ...rules[0], ...change }, rules[1]], {}), version, JSON.stringify(change));
  }
  assert.equal(new Set(SCREEN_RULES.map(item => item.id)).size, SCREEN_RULES.length, 'rule ids are unique');
});

test('the ruleset version changes with every threshold a rule reads, and with no other setting', () => {
  const row = { marketProvider: 'AVE', chain: 'arc', address: `0x${'1'.repeat(40)}` };
  const ruleset = settings => discoveryScreen(row, { ...settings, chain: 'arc' }, 1_800_000_000).ruleset;
  const current = ruleset(scannerSettings);
  assert.equal(ruleset({ ...scannerSettings }), current, 'equal settings, equal ruleset');
  const declared = new Set(SCREEN_RULES.flatMap(item => item.settings));
  for (const key of declared) {
    assert.ok(Number.isFinite(scannerSettings[key]), `a rule reads ${key}, which scannerSettings defines`);
    assert.notEqual(ruleset({ ...scannerSettings, [key]: scannerSettings[key] + 1 }), current, key);
  }
  for (const key of ['scanIntervalMs', 'liveLeadRetentionMs', 'priorityMinMarketCap', 'strictLiquidity']) {
    assert.ok(!declared.has(key), key);
    assert.equal(ruleset({ ...scannerSettings, [key]: scannerSettings[key] + 1 }), current, key);
  }
});

test('a blocked term in the symbol or the name hits, Robinhood does not, and an unread field leaves it unknown', () => {
  const nameRule = SCREEN_RULES.find(item => item.id === 'NAME_BLOCKLISTED');
  assert.deepEqual([nameRule.role, nameRule.mode], ['DROP', SHADOW]);
  for (const [symbol, name, verdict] of [
    ['OFFICIAL', 'Pepe', 'HIT'], ['PEPE', 'Pepe Airdrop', 'HIT'], ['PEPE', 'Pepe 官方', 'HIT'], ['空投', 'Pepe', 'HIT'],
    ['TENEO', 'Pepe', 'HIT'], ['PEPE', 'teneo protocol', 'HIT'],
    // NFKC folds full-width letters before the case-insensitive match.
    ['ＯＦＦＩＣＩＡＬ', 'Pepe', 'HIT'], ['PEPE', 'ＡｉｒＤｒｏｐ', 'HIT'],
    ['HOOD', 'Robinhood', 'CLEAR'], ['HOOD', 'HOOD on Robinhood Chain', 'CLEAR'], ['PEPE', 'Pepe', 'CLEAR'],
    // A hit in one field decides; a clear field leaves it unknown while the other is unread.
    ['OFFICIAL', undefined, 'HIT'], [null, 'airdrop', 'HIT'],
    ['PEPE', undefined, 'UNKNOWN'], ['', 'Pepe', 'UNKNOWN'], ['  ', 'Pepe', 'UNKNOWN'], [42, 'Pepe', 'UNKNOWN'], [undefined, undefined, 'UNKNOWN']
  ]) assert.equal(nameRule.evaluate({ row: { symbol, name } }), verdict, `${symbol} / ${name}`);
});

test('a blocked name never changes whether the screen passes a token', () => {
  const row = { marketProvider: 'AVE', chain: 'arc', address: `0x${'1'.repeat(40)}`, symbol: 'PEPE', name: 'Pepe' };
  const screen = discoveryScreen(row, { ...scannerSettings, chain: 'arc' }, 1_800_000_000);
  const blocked = discoveryScreen({ ...row, name: 'Pepe Official Airdrop' }, { ...scannerSettings, chain: 'arc' }, 1_800_000_000);
  assert.deepEqual([screen.verdicts.NAME_BLOCKLISTED, blocked.verdicts.NAME_BLOCKLISTED], ['CLEAR', 'HIT']);
  assert.deepEqual([blocked.pass, blocked.decision, blocked.reasons], [screen.pass, screen.decision, screen.reasons]);
});
