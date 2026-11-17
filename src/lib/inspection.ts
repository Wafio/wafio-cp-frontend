/**
 * The inspection switch and the texts around it.
 *
 * Every WAF agent inspects requests with the same detection engine, so the
 * dashboard has one switch: "Inspection off". A stored document keeps it as
 * one key, `inspection_off: true`, on `semantic_policies` and on a path rule.
 *
 * A document saved by version 1 has two keys for it, `disable_semantic` and
 * `disable_rule_based`. The agent and the control plane read them like this:
 *
 *   inspection_off true       inspection off
 *   disable_semantic true     inspection off (alone or with disable_rule_based)
 *   disable_rule_based alone  no effect, inspection stays on
 *
 * The dashboard shows a stored document by that rule. A save writes only
 * `inspection_off` and removes the two version 1 keys, so a document that was
 * edited here leaves with the new key only.
 */

/** The stored flags of a policy scope or a path: the current key and the two version 1 keys. */
export interface InspectionFlags {
  inspection_off?: unknown;
  disable_semantic?: unknown;
  disable_rule_based?: unknown;
}

/** Whether a stored scope has inspection off: `inspection_off`, or `disable_semantic` from a version 1 document. */
export function inspectionOffFromFlags(flags: InspectionFlags | null | undefined): boolean {
  return flags?.inspection_off === true || flags?.disable_semantic === true;
}

/** The flag to save for a switch position. "On" saves no flag. */
export function inspectionFlagsToSave(off: boolean): { inspection_off?: true } {
  return off ? { inspection_off: true } : {};
}

/** The stored keys of the switch. A save removes all of them first, then writes `inspectionFlagsToSave`. */
export const INSPECTION_KEYS = ['inspection_off', 'disable_semantic', 'disable_rule_based'] as const;

// ── Texts ───────────────────────────────────────────────────────────────────

export const NOT_CHECKED = 'Requests are not checked for attacks.';

/** What a policy form edits: one application or the project defaults. */
export type InspectionScope = 'app' | 'project';

/** Policy switch. */
export const POLICY_INSPECTION_OFF = {
  label: 'Inspection off',
  hint: `${NOT_CHECKED} Geo, bot, flood and block-policy controls still apply. Use it only to find out whether the WAF causes a problem.`
} as const;

/** Warning under Protection while the policy switch is on. */
export function policyInspectionOffAlert(scope: InspectionScope): string {
  return `Inspection is off: requests to this ${scope === 'app' ? 'application' : 'project'} are not checked for attacks. Geo, bot, flood and block-policy controls still apply.`;
}

/** Short value for the policy index. */
export function inspectionSummary(off: boolean): string {
  return off ? 'Off' : 'On';
}

/** The choice of a path rule. */
export const PATH_INSPECTION_OFF = {
  label: 'Inspection off',
  description: 'Requests to this path are not checked for attacks.'
} as const;

/** Warning under a path rule with inspection off. */
export const PATH_INSPECTION_OFF_ALERT = 'Requests to this path are not checked for attacks. Geo, bot and flood controls still apply.';

/** A skip list that names every detection engine, or a tuning rule that turns inspection off. */
export const TUNING_INSPECTION_OFF_TEXT =
  'Inspection off for matched requests: requests that match this rule are not checked for attacks.';

/** Hint of a skip list that names every detection engine. */
export const SKIP_ALL_ENGINES_TEXT = 'Inspection off for matched requests. They are not checked for attacks.';

// ── Script rules ────────────────────────────────────────────────────────────

/** Warning when the agent cannot run script rules; false only, anything else is unknown and says nothing. */
export function scriptRulesWarning(scriptRules: boolean | null | undefined, scope: 'app' | 'agent'): string | null {
  if (scriptRules !== false) return null;
  return scope === 'app'
    ? 'The WAF agent that serves this application cannot run script rules. The control plane refuses to create or enable one here, and a script rule that is already enabled does not run on that agent.'
    : 'This WAF agent cannot run script rules, so the script rules of the applications it serves do not run on it. Creating or enabling one is refused for an application when every agent that serves it is like this.';
}

/** Code of the 400 answer for a script rule on an application whose agent cannot run script rules. */
export const SCRIPT_RULES_UNSUPPORTED = 'SCRIPT_RULES_UNSUPPORTED';

export const SCRIPT_RULES_UNSUPPORTED_TITLE = 'This WAF agent cannot run script rules. Nothing was saved.';

export const SCRIPT_RULES_UNSUPPORTED_MESSAGE =
  'The WAF agent that serves this application has no script runner, so a script rule would never run. Use a Match & act or Engine tuning rule instead, or move the application to an agent that supports script rules.';
