// When custom rules run, the one description the Custom rules page, the rule
// editor and the script guide all show. It follows the WAF
// agent pipeline in internal/application/analyze.go (Analyze):
//
//   infrastructure checks (body size, request smuggling, GraphQL batch limit,
//   path body size, path block and rate limit, L7 flood, temporary block
//   window, geoblocking, bot protection)
//   → Match & act rules (engine.EvalGUIRules: allow/block return; log records
//     and continues; challenge challenges, else continues)
//   → Engine tuning plan (engine.ResolveTuningPlan: every matching rule
//     merges; an empty "Apply when" scope matches every request)
//   → path IP rules, login protection, upload content scan
//   → detection engines → decision engine
//   → script rules (engine.EvalScriptRules: first decision replaces the verdict)
//
// Scripts also run when the engines find nothing (score 0, action "allow"),
// but not after an earlier stage has already returned a verdict. Change this file when the pipeline changes.
import type { CustomRuleMode } from '#lib/api.js';

export interface RuleStage {
  mode: CustomRuleMode;
  /** Mode name as the editor shows it. */
  label: string;
  /** Where the rule sits in the request pipeline (one short phrase). */
  when: string;
  /** What a matching rule does. */
  effect: string;
}

export const RULE_STAGES: Record<CustomRuleMode, RuleStage> = {
  gui: {
    mode: 'gui',
    label: 'Match & act',
    when: 'Before the detection engines',
    effect:
      'Enabled rules are tried in priority order (lower number first; equal priorities in creation order). Only Allow and Block decide on their own: the first matching Allow or Block rule decides the request, and neither the detection engines nor script rules run for it (Block rejects it on routes in Block mode; Monitor routes only record it). Log records the match and the request continues through the engines. Challenge serves a browser challenge to the client even when the challenge trigger is "Only on bot detection", but only when the challenge is enabled for the application. Local clients (when the policy lets them skip the challenge), good bots, non-browser clients and clients with a valid challenge cookie are not challenged; their request continues through the engines, never straight to Allow. A rule without conditions never matches.',
  },
  tuning: {
    mode: 'tuning',
    label: 'Engine tuning',
    when: 'Before the detection engines, adjusting them',
    effect:
      'Every enabled tuning rule whose "Apply when" conditions match adds its effect: skipped semantic engines, a scan mode, or weaker scoring. When several set a scan mode, the first by priority wins. Tuning never allows or blocks a request by itself.',
  },
  script: {
    mode: 'script',
    label: 'Script',
    when: 'After the decision engine',
    effect:
      'Scripts run in priority order with the engine score and verdict. The first script that returns a decision (block, allow or log) replaces the verdict; a script that returns nothing leaves it unchanged. Each script has 5 ms and all scripts together 15 ms; a script that runs out of time is ignored.',
  },
};

/** Pipeline order for the "When rules run" explainer. `mode` marks a custom-rule stage. */
export const PIPELINE_STEPS: { label: string; mode?: CustomRuleMode }[] = [
  { label: 'Infrastructure checks' },
  { label: 'Match & act rules', mode: 'gui' },
  { label: 'Engine tuning rules', mode: 'tuning' },
  { label: 'Path IP rules, login protection, upload scan' },
  { label: 'Detection engines, decision engine' },
  { label: 'Script rules', mode: 'script' },
];

/** Stages before the detection engines that end a request, so no custom rule sees it. */
export const INFRASTRUCTURE_CHECKS =
  'body size limit, request smuggling check, GraphQL batch limit, path block and rate limit, L7 flood limit, temporary block window, geoblocking and bot protection';

/**
 * When a request never reaches script rules: an earlier stage already
 * returned a verdict.
 */
export const SCRIPT_SKIPPED_WHEN =
  'Scripts do not run when an earlier stage has already decided the request: an infrastructure check, a matching Allow or Block Match & act rule (or a challenge it serves), a path IP rule or login protection, an upload the content scan blocks, a strong detection by a semantic engine set to Block (blocked at once), or a path rule that turns inspection off.';

/** Scripts when the engines find nothing. */
export const SCRIPT_FAST_PATH =
  'When the detection engines find nothing, scripts still run, with score 0 and action "allow".';

/** One line for the rule editor footer. */
export function stageLine(mode: CustomRuleMode): string {
  return RULE_STAGES[mode].when;
}
