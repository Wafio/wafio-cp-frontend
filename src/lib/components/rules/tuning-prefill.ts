/**
 * "Tune false positive" hand-off: the application's
 * decision drawer links to Custom rules with
 *   ?create=tuning&app=&decision=&name=&path=&method=&skip_semantic=
 * (producer: tuningRuleSearch() in $lib/components/apps/decision-actions).
 * This module turns that query into the starting values of a new Engine
 * Tuning rule. The editor validates everything before it is saved.
 */
import type { CustomRule, CustomRuleCondition } from '#lib/api.js';
import type { ReadonlyURLSearchParams } from '$app/state';

/** Query keys of the hand-off; removed from the URL once the editor opened. */
export const TUNING_PREFILL_KEYS = ['create', 'decision', 'name', 'path', 'method', 'skip_semantic'] as const;

const MAX_LIST = 50;
const METHOD = /^[A-Z]{1,16}$/;
const LIST_ITEM = /^[A-Za-z0-9_:*.-]{1,64}$/;

function list(value: string | null): string[] {
  if (!value) return [];
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => LIST_ITEM.test(item));
  return [...new Set(items)].slice(0, MAX_LIST);
}

export function wantsTuningPrefill(params: ReadonlyURLSearchParams): boolean {
  return params.get('create') === 'tuning';
}

/**
 * Starting values of the new tuning rule, as a rule the editor fills itself
 * from (open it in "create" mode), or null without `create=tuning`.
 */
export function tuningPrefillRule(params: ReadonlyURLSearchParams, appId: string): CustomRule | null {
  if (!wantsTuningPrefill(params)) return null;
  const path = (params.get('path') ?? '').trim().split('?')[0];
  const method = (params.get('method') ?? '').trim().toUpperCase();
  const decision = (params.get('decision') ?? '').trim();

  const scope: CustomRuleCondition[] = [];
  if (path.startsWith('/')) scope.push({ field: 'path', operator: 'equals', value: path.slice(0, 2048) });
  if (METHOD.test(method)) scope.push({ field: 'method', operator: 'equals', value: method });

  const name = (params.get('name') ?? '').trim().slice(0, 64) || `Tune detection on ${path || 'this application'}`.slice(0, 64);
  const description = /^\d{1,20}$/.test(decision) ? `False-positive tuning created from decision #${decision}.` : 'False-positive tuning created from a decision.';

  return {
    id: '',
    app_id: appId,
    name,
    description,
    enabled: true,
    priority: 0,
    mode: 'tuning',
    conditions: scope,
    condition_logic: 'and',
    action: 'log',
    script: '',
    tuning: {
      scope: { logic: 'and', conditions: scope },
      target: { components: [], match: 'exact' },
      effect: {
        skip_semantic: list(params.get('skip_semantic')),
      },
    },
    created_at: '',
    updated_at: '',
  };
}
