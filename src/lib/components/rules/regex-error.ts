// The control plane reports per rule why a regex (condition or tuning
// target) is invalid or over the program budget. Agents drop such a rule at
// bundle load, so the dashboard flags it as not applied.
import type { CustomRule } from '#lib/api.js';

/** The trimmed regex_error, or "" when the rule is usable. */
export function ruleRegexError(rule: Pick<CustomRule, 'regex_error'> | null | undefined): string {
  return typeof rule?.regex_error === 'string' ? rule.regex_error.trim() : '';
}

/** User-facing notice for an affected rule, or "" when there is none. */
export function regexNotAppliedMessage(rule: Pick<CustomRule, 'regex_error'> | null | undefined): string {
  const err = ruleRegexError(rule);
  return err ? `Not applied by agents: ${err}` : '';
}
