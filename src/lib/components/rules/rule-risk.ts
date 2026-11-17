// Confirmation tiers for custom rules.
//
// Turning a rule on can weaken protection for live traffic, so these helpers
// decide when the Custom rules page asks first:
//
//   - a Match & act Allow rule: matching requests skip every detection engine
//     (only Allow and Block decide on their own; a Log rule records the match
//     and the request continues through the engines, see rule-stages.ts);
//   - a Match & act Block or Challenge rule whose conditions match every
//     request: it blocks (or challenges) the whole application;
//   - a script that can return ALLOW: it can replace a Block verdict;
//   - a tuning rule that turns inspection off for its scope (it skips every
//     engine or sets the scan mode to disabled), or whose scope matches every
//     request.
//
// Cloning and importing never ask: a clone opens in the editor as a disabled
// copy and imported rules arrive disabled (tier "none" in confirm-tiers).
// Turning a rule off asks only when that removes protection (a Block,
// Challenge or script rule); switching off an Allow, Log or tuning rule
// never lowers protection and needs no confirmation.
import { tierFor, type ConfirmTier } from '../../confirm-tiers';
import type { CustomRuleCondition, CustomRuleMode, CustomRuleTuning } from '#lib/api.js';

/** The rule fields the risk checks read (a CustomRule or a save body). */
export interface RuleShape {
  name?: string;
  mode: CustomRuleMode;
  action?: string;
  enabled?: boolean;
  conditions?: CustomRuleCondition[] | null;
  condition_logic?: string;
  script?: string;
  tuning?: CustomRuleTuning | null;
}

export type RiskKind = 'allow-bypass' | 'match-all' | 'script-allow' | 'inspection-off' | 'tuning-everywhere' | 'removes-protection';

export interface RuleRisk {
  kind: RiskKind;
  tier: ConfirmTier;
  title: string;
  message: string;
  confirmLabel: string;
}

// Fields every HTTP request carries, so "exists" (non-empty) is always true.
const ALWAYS_PRESENT = new Set(['path', 'uri', 'method', 'ip']);
// Transforms after which a path no longer starts with "/".
const VALUE_REPLACING_TRANSFORMS = new Set(['md5', 'sha1', 'sha256', 'length', 'base64_decode', 'hex_decode', 'sql_hex_decode']);
const MATCH_ALL_REGEX = new Set(['', '.*', '^.*', '^.*$', '(?s).*', '(?i).*', '^', '$', '(?s)^.*$']);

/**
 * True when a condition is known to match every request (a conservative
 * check: false means "not provably everything"). Negated and legacy not_*
 * conditions are never treated as match-all.
 */
export function conditionMatchesEverything(c: CustomRuleCondition): boolean {
  if (!c || c.negate) return false;
  const op = String(c.operator ?? '').trim().toLowerCase();
  const field = String(c.field ?? '').trim().toLowerCase();
  const value = String(c.value ?? '');
  const transforms = Array.isArray(c.transforms) ? c.transforms : [];
  switch (op) {
    case 'contains':
    case 'starts_with':
    case 'ends_with':
      if (value === '') return true;
      return op === 'starts_with' && value === '/' && (field === 'path' || field === 'uri') && !transforms.some((t) => VALUE_REPLACING_TRANSFORMS.has(t));
    case 'exists':
      return ALWAYS_PRESENT.has(field) && transforms.length === 0;
    case 'matches':
    case 'regex':
      return MATCH_ALL_REGEX.has(value.trim());
    case 'wildcard':
      // filepath.Match: "*" never crosses "/", so only slash-free fields qualify.
      return value.trim() === '*' && (field === 'method' || field === 'ip');
    case 'cidr':
      return field === 'ip' && ['0.0.0.0/0', '::/0'].includes(value.trim());
    case 'num_ge':
      return field === 'body_size' && Number(value) <= 0;
    default:
      return false;
  }
}

/** True when the rule's conditions provably match every request (AND: all of them, OR: any). */
export function conditionsMatchEverything(conditions: CustomRuleCondition[] | null | undefined, logic: string | undefined): boolean {
  const list = Array.isArray(conditions) ? conditions : [];
  if (list.length === 0) return false;
  return String(logic).toLowerCase() === 'or' ? list.some(conditionMatchesEverything) : list.every(conditionMatchesEverything);
}

/** A script that can return ALLOW (waf_allow() or waf_return("ALLOW")). */
export function scriptCanAllow(script: string | null | undefined): boolean {
  if (!script) return false;
  const code = script
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
  return /\bwaf_allow\s*\(/.test(code) || /\bwaf_return\s*\(\s*["']allow["']\s*\)/i.test(code);
}

/**
 * True when a tuning rule applies to every request. The agent reads only
 * `tuning.scope` (repository ListTuningRulesRaw), and an empty scope matches
 * every request (engine.matchTuningScope), unlike a Match & act rule, where
 * no conditions means no match.
 */
export function tuningScopeMatchesEverything(tuning: CustomRuleTuning | null | undefined): boolean {
  const conditions = tuning?.scope?.conditions ?? [];
  if (conditions.length === 0) return true;
  return conditionsMatchEverything(conditions, tuning?.scope?.logic);
}

/**
 * Tuning that turns inspection off for the requests it matches: it skips every
 * engine, or sets the scan mode to disabled. A stored `crs_only` or
 * `semantic_only` reads as the default, and `both` clears the skips of the rule.
 */
export function tuningTurnsInspectionOff(tuning: CustomRuleTuning | null | undefined): boolean {
  const effect = tuning?.effect;
  if (!effect) return false;
  switch (effect.scan_mode) {
    case 'disabled':
      return true;
    case 'both':
      return false;
    default:
      return (effect.skip_semantic ?? []).some((e) => e.trim() === '*');
  }
}

function quoted(rule: RuleShape): string {
  const name = rule.name?.trim();
  return name ? `"${name}"` : 'this rule';
}

/**
 * The confirmation needed before `rule` starts running (enabled from the list,
 * or saved enabled from the editor), or null when it can run without one.
 */
export function enableRisk(rule: RuleShape): RuleRisk | null {
  const name = quoted(rule);
  if (rule.mode === 'gui') {
    const matchAll = conditionsMatchEverything(rule.conditions, rule.condition_logic);
    if (rule.action === 'allow') {
      return {
        kind: 'allow-bypass',
        tier: tierFor('enable-allow-rule'),
        title: 'Enable an Allow rule?',
        message: `Requests that match ${name} skip every detection engine and script rule.${matchAll ? ' Its conditions match every request, so detection stops for the whole application.' : ''} Enable it only for traffic you trust.`,
        confirmLabel: 'Enable Allow rule',
      };
    }
    // Log records the match and the request continues through the engines,
    // so it never lowers protection and needs no confirmation.
    if ((rule.action === 'block' || rule.action === 'challenge') && matchAll) {
      const verb = rule.action === 'block' ? 'blocks' : 'challenges';
      return {
        kind: 'match-all',
        tier: tierFor('enable-block-rule'),
        title: rule.action === 'block' ? 'Block every request?' : 'Challenge every request?',
        message: `The conditions of ${name} match every request, so it ${verb} all traffic to this application on routes in Block mode.`,
        confirmLabel: rule.action === 'block' ? 'Enable Block rule' : 'Enable Challenge rule',
      };
    }
    return null;
  }
  if (rule.mode === 'script') {
    if (!scriptCanAllow(rule.script)) return null;
    return {
      kind: 'script-allow',
      tier: tierFor('enable-allow-rule'),
      title: 'Enable a script that can allow requests?',
      message: `${capitalise(name)} can return ALLOW, which replaces a Block verdict from the detection engines for the requests it chooses.`,
      confirmLabel: 'Enable script',
    };
  }
  if (rule.mode === 'tuning' && rule.tuning) {
    const everywhere = tuningScopeMatchesEverything(rule.tuning);
    if (tuningTurnsInspectionOff(rule.tuning)) {
      const scope = everywhere ? 'every request to this application' : 'the requests that match its conditions';
      return {
        kind: 'inspection-off',
        tier: tierFor('lower-protection'),
        title: 'Turn inspection off?',
        message: `${capitalise(name)} turns inspection off for ${scope}: those requests are not checked for attacks.`,
        confirmLabel: 'Enable tuning rule',
      };
    }
    if (everywhere) {
      const noScope = (rule.tuning.scope?.conditions ?? []).length === 0;
      return {
        kind: 'tuning-everywhere',
        tier: tierFor('lower-protection'),
        title: 'Lower protection for every request?',
        message: noScope
          ? `${capitalise(name)} has no "Apply when" conditions, so its skips and its log-only choice apply to the whole application.`
          : `The "Apply when" conditions of ${name} match every request, so its skips and its log-only choice apply to the whole application.`,
        confirmLabel: 'Enable tuning rule',
      };
    }
  }
  return null;
}

/**
 * The confirmation needed before an enabled `rule` stops running, or null.
 * Switching off a Block, Challenge or script rule removes protection;
 * switching off an Allow rule gives detection back, and a Log or tuning
 * rule never lowered it.
 */
export function disableRisk(rule: RuleShape): RuleRisk | null {
  const removesProtection =
    rule.mode === 'script' || (rule.mode === 'gui' && (rule.action === 'block' || rule.action === 'challenge'));
  if (!removesProtection) return null;
  return {
    kind: 'removes-protection',
    tier: tierFor('lower-protection'),
    title: 'Disable rule?',
    message:
      rule.mode === 'script'
        ? `Disable ${quoted(rule)}? The script stops running, so any block or log decisions it makes stop too.`
        : rule.action === 'block'
          ? `Disable ${quoted(rule)}? Requests it blocks today will reach the detection engines instead.`
          : `Disable ${quoted(rule)}? Requests it challenges today are no longer challenged; the detection engines still inspect them.`,
    confirmLabel: 'Disable rule',
  };
}

/**
 * The confirmation needed to save `next` over `previous` (null = a new rule
 * or a copy): only when the saved rule will run and the change introduces a
 * risk it did not have before.
 */
export function saveRisk(previous: RuleShape | null, next: RuleShape): RuleRisk | null {
  if (next.enabled === false) return null;
  const risk = enableRisk(next);
  if (!risk) return null;
  if (previous && previous.enabled !== false) {
    const before = enableRisk(previous);
    if (before && before.kind === risk.kind) return null;
  }
  return risk;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
