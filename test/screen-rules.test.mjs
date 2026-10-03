import test from 'node:test';
import assert from 'node:assert/strict';
import { scannerSettings } from '../src/scanner-settings.mjs';
import { ENFORCE, SCREEN_RULES, SHADOW, discoveryScreen, evaluateRules, rulesetVersion } from '../src/scoring/screen.mjs';

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
