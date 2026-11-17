// "Tune false positive" hand-off: the decision drawer's query
// string opens a prefilled tuning rule on Custom rules.
import { describe, expect, test } from 'bun:test';
import { tuningRuleSearch, type TuningDraft } from '../src/lib/components/apps/decision-actions';
import { TUNING_PREFILL_KEYS, tuningPrefillRule, wantsTuningPrefill } from '../src/lib/components/rules/tuning-prefill';
import { buildTuningPayload, tuningFromRule } from '../src/lib/components/rules/registry';

const draft: TuningDraft = {
  app: 'app-1',
  decision: '42',
  name: 'Tune sql on /search',
  path: '/search',
  method: 'POST',
  skipSemantic: ['sql', 'xss'],
};

describe('tuning prefill', () => {
  test('round-trips the decision drawer draft', () => {
    const params = new URLSearchParams(tuningRuleSearch(draft));
    expect(wantsTuningPrefill(params)).toBe(true);
    const rule = tuningPrefillRule(params, 'app-1');
    expect(rule).not.toBeNull();
    expect(rule?.mode).toBe('tuning');
    expect(rule?.name).toBe('Tune sql on /search');
    expect(rule?.description).toContain('#42');
    expect(rule?.tuning?.scope.conditions).toEqual([
      { field: 'path', operator: 'equals', value: '/search' },
      { field: 'method', operator: 'equals', value: 'POST' },
    ]);
    expect(rule?.tuning?.target).toEqual({ components: [], match: 'exact' });
    expect(rule?.tuning?.effect).toEqual({ skip_semantic: ['sql', 'xss'] });
  });

  test('the editor state keeps the prefilled scope and skip list', () => {
    const rule = tuningPrefillRule(new URLSearchParams(tuningRuleSearch(draft)), 'app-1');
    const state = tuningFromRule(rule);
    expect(state.scopeConditions.map((c) => c.fieldType)).toEqual(['path', 'method']);
    expect(state.skipSemantic).toEqual(['sql', 'xss']);
    const payload = buildTuningPayload(state);
    expect(payload.effect).toEqual({ skip_semantic: ['sql', 'xss'] });
    expect(payload.target).toEqual({ components: [], match: 'exact' });
    expect('engine' in payload).toBe(false);
  });

  test('keys of the old hand-off are ignored', () => {
    const rule = tuningPrefillRule(new URLSearchParams('create=tuning&target=query:q&engine=crs&skip_crs=942100&skip_semantic=sql'), 'a');
    expect(rule?.tuning?.target.components).toEqual([]);
    expect(rule?.tuning?.effect).toEqual({ skip_semantic: ['sql'] });
    expect(TUNING_PREFILL_KEYS as readonly string[]).not.toContain('skip_crs');
  });

  test('without create=tuning there is nothing to prefill', () => {
    expect(wantsTuningPrefill(new URLSearchParams('app=a'))).toBe(false);
    expect(tuningPrefillRule(new URLSearchParams('app=a&create=gui'), 'a')).toBeNull();
  });

  test('odd values fall back to safe defaults', () => {
    const rule = tuningPrefillRule(
      new URLSearchParams('create=tuning&method=get%20x&path=search&skip_semantic=sql,%3Cscript%3E,sql,,xss&decision=abc'),
      'a',
    );
    expect(rule?.tuning?.scope.conditions).toEqual([]);
    expect(rule?.tuning?.effect.skip_semantic).toEqual(['sql', 'xss']);
    expect(rule?.description).not.toContain('#');
    expect(rule?.name.length).toBeGreaterThan(0);
  });

  test('the hand-off keys keep the app selection', () => {
    expect(TUNING_PREFILL_KEYS).toContain('create');
    expect(TUNING_PREFILL_KEYS as readonly string[]).not.toContain('app');
  });
});
