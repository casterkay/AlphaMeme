/**
 * The rule machinery the discovery screen and the post-alert audit share. Each
 * rule answers HIT, CLEAR or UNKNOWN:
 * - a DROP rule rejects the token on HIT; UNKNOWN does not block it;
 * - an ADMIT rule must be CLEAR for the token to be admitted; UNKNOWN blocks it.
 * A SHADOW rule's verdict is recorded but never decides.
 */
export const HIT = 'HIT', CLEAR = 'CLEAR', UNKNOWN = 'UNKNOWN';
export const ADMIT = 'ADMIT', DROP = 'DROP', UNDECIDED = 'UNDECIDED';
export const ENFORCE = 'ENFORCE', SHADOW = 'SHADOW';

/** A fact's verdict: UNKNOWN when it was not read, else HIT when the rule's condition holds. */
export const known = (value, hit) => value === null ? UNKNOWN : hit ? HIT : CLEAR;

/**
 * The ruleset's identity: a hash of every rule's id, version, role and mode and
 * the values of the settings it declares, so a changed rule or threshold changes
 * it and an unrelated setting does not. Outcomes compare rulesets by it.
 */
export function rulesetVersion(rules, settings) {
  let hash = 0x811c9dc5;
  const identity = rules.map(rule => `${rule.id}@${rule.version}:${rule.role}:${rule.mode}`
    + JSON.stringify(rule.settings.map(key => [key, settings[key]]))).sort().join(',');
  for (const character of identity) hash = Math.imul(hash ^ character.charCodeAt(0), 0x01000193);
  return 'rs-' + (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Every rule's verdict for one token, the token's decision, and the enforced
 * rules that blocked it (the reasons a rejected token shows), in table order.
 */
export function evaluateRules(facts, settings, rules) {
  const verdicts = {}, reasons = [];
  let dropped = false;
  for (const rule of rules) {
    const verdict = verdicts[rule.id] = rule.evaluate(facts, settings);
    if (rule.mode !== ENFORCE || verdict === CLEAR || rule.role === DROP && verdict === UNKNOWN) continue;
    dropped ||= rule.role === DROP;
    reasons.push(rule.id);
  }
  return { decision: dropped ? DROP : reasons.length ? UNDECIDED : ADMIT, verdicts, reasons };
}

