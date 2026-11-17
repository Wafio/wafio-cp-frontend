// Script-rule sandbox and ownership: creating or changing a
// script-mode rule needs project role owner (403 SCRIPT_RULE_OWNER_REQUIRED),
// and a script may call only allowlisted built-ins (400
// SCRIPT_BUILTIN_FORBIDDEN with `forbidden: [names]`), and an application whose
// WAF agent cannot run script rules refuses them (400 SCRIPT_RULES_UNSUPPORTED).

import type { ApiError, CustomRuleMode, ProjectRole } from '#lib/api.js';
import { SCRIPT_RULES_UNSUPPORTED, SCRIPT_RULES_UNSUPPORTED_MESSAGE, SCRIPT_RULES_UNSUPPORTED_TITLE } from '#lib/inspection.js';

/** Largest script the server accepts (400 SCRIPT_INVALID beyond it). */
export const SCRIPT_MAX_BYTES = 64 * 1024;

/** UTF-8 size of a script, as the server measures it. */
export function scriptBytes(script: string): number {
  return new TextEncoder().encode(script ?? '').length;
}

/** Problem when the script is over the size limit, else null. */
export function scriptSizeError(script: string): string | null {
  const bytes = scriptBytes(script);
  if (bytes <= SCRIPT_MAX_BYTES) return null;
  return `The script is ${Math.ceil(bytes / 1024)} KiB; scripts may be at most 64 KiB.`;
}

export const SCRIPT_OWNER_MESSAGE = 'Only project owners can create or change script rules.';

/** True when `role` may create, edit, enable or change the mode of script rules. */
export function canEditScriptRules(role: ProjectRole | null | undefined): boolean {
  return role === 'owner';
}

/**
 * True when the change touches a script rule: the rule is (or was) a script,
 * so a non-owner gets 403 for it.
 */
export function touchesScriptRule(previousMode: CustomRuleMode | string | null | undefined, nextMode: CustomRuleMode | string | null | undefined): boolean {
  return previousMode === 'script' || nextMode === 'script';
}

/** "Not allowed in scripts: exec, http_get." */
export function forbiddenBuiltinsMessage(names: readonly string[]): string {
  if (!names.length) return 'The script calls functions that scripts may not use.';
  return `Not allowed in scripts: ${names.join(', ')}. Scripts may use string, number, collection, regex, JSON, clock and waf_* functions only.`;
}

/** Error thrown by a rule save so the dialog can show the forbidden names next to the editor. */
export class RuleSaveError extends Error {
  readonly code?: string;
  /** Short heading for an error that needs one (a toast or an alert title). */
  readonly title?: string;
  readonly forbidden: string[];
  /** True when the error is about the script itself (shown next to the editor). */
  get scriptProblem(): boolean {
    return this.code === 'SCRIPT_BUILTIN_FORBIDDEN' || this.code === 'SCRIPT_INVALID';
  }
  constructor(message: string, code?: string, forbidden: string[] = [], title?: string) {
    super(message);
    this.name = 'RuleSaveError';
    this.code = code;
    this.forbidden = forbidden;
    this.title = title;
  }
}

/** Maps an API error of a custom-rule create/update/validate call to a RuleSaveError. */
export function ruleSaveError(err: ApiError | undefined, fallback = 'The rule could not be saved.'): RuleSaveError {
  if (err?.code === 'SCRIPT_RULE_OWNER_REQUIRED') return new RuleSaveError(SCRIPT_OWNER_MESSAGE, err.code);
  if (err?.code === 'SCRIPT_BUILTIN_FORBIDDEN') {
    const names = err.forbidden ?? [];
    return new RuleSaveError(forbiddenBuiltinsMessage(names), err.code, names);
  }
  if (err?.code === SCRIPT_RULES_UNSUPPORTED) {
    return new RuleSaveError(SCRIPT_RULES_UNSUPPORTED_MESSAGE, err.code, [], SCRIPT_RULES_UNSUPPORTED_TITLE);
  }
  if (err?.code === 'SCRIPT_INVALID') {
    // Over 64 KiB or nested too deeply; the server message says which.
    return new RuleSaveError(err.error || 'The script is too large or nested too deeply.', err.code);
  }
  return new RuleSaveError(err?.error || fallback, err?.code);
}
