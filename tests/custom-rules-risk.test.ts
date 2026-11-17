import { describe, expect, test } from 'bun:test';
import {
  conditionMatchesEverything,
  conditionsMatchEverything,
  disableRisk,
  enableRisk,
  saveRisk,
  scriptCanAllow,
  tuningScopeMatchesEverything,
  tuningTurnsInspectionOff,
  type RuleShape,
} from '../src/lib/components/rules/rule-risk';
import {
  buildTuningPayload,
  scanModeFromStored,
  semanticEngineError,
  tuningStateError,
  emptyTuningState,
  emptyConditionRow,
  conditionToRow,
  conditionFieldError,
  rowToCondition,
  rowsToConditions,
  tuningFromRule,
} from '../src/lib/components/rules/registry';

const cond = (field: string, operator: string, value = '', extra: Record<string, unknown> = {}) => ({ field, operator, value, ...extra });
const gui = (action: string, conditions = [cond('path', 'starts_with', '/admin')], logic = 'and'): RuleShape => ({
  name: 'R',
  mode: 'gui',
  action,
  conditions,
  condition_logic: logic,
});

describe('match-all detection', () => {
  test('conditions that match every request', () => {
    expect(conditionMatchesEverything(cond('path', 'contains', ''))).toBe(true);
    expect(conditionMatchesEverything(cond('user_agent', 'starts_with', ''))).toBe(true);
    expect(conditionMatchesEverything(cond('path', 'starts_with', '/'))).toBe(true);
    expect(conditionMatchesEverything(cond('uri', 'starts_with', '/'))).toBe(true);
    expect(conditionMatchesEverything(cond('method', 'exists'))).toBe(true);
    expect(conditionMatchesEverything(cond('path', 'matches', '.*'))).toBe(true);
    expect(conditionMatchesEverything(cond('ip', 'cidr', '0.0.0.0/0'))).toBe(true);
    expect(conditionMatchesEverything(cond('method', 'wildcard', '*'))).toBe(true);
    expect(conditionMatchesEverything(cond('body_size', 'num_ge', '0'))).toBe(true);
  });

  test('narrow, negated or transformed conditions are not match-all', () => {
    expect(conditionMatchesEverything(cond('path', 'starts_with', '/admin'))).toBe(false);
    expect(conditionMatchesEverything(cond('path', 'contains', '', { negate: true }))).toBe(false);
    expect(conditionMatchesEverything(cond('path', 'starts_with', '/', { transforms: ['md5'] }))).toBe(false);
    expect(conditionMatchesEverything(cond('header:x-api-key', 'exists'))).toBe(false);
    expect(conditionMatchesEverything(cond('path', 'wildcard', '*'))).toBe(false); // "*" never crosses "/"
    expect(conditionMatchesEverything(cond('path', 'not_contains', 'zzz'))).toBe(false);
  });

  test('AND needs every condition, OR any', () => {
    const all = cond('path', 'starts_with', '/');
    const narrow = cond('method', 'equals', 'POST');
    expect(conditionsMatchEverything([all, narrow], 'and')).toBe(false);
    expect(conditionsMatchEverything([all, narrow], 'or')).toBe(true);
    expect(conditionsMatchEverything([], 'and')).toBe(false);
  });
});

describe('enabling asks for bypass and match-all rules', () => {
  test('an Allow Match & act rule bypasses detection', () => {
    expect(enableRisk(gui('allow'))?.kind).toBe('allow-bypass');
    expect(enableRisk(gui('allow'))?.tier).toBe('simple');
  });

  test('a Log rule records and continues through the engines: no prompt', () => {
    expect(enableRisk(gui('log'))).toBeNull();
    expect(enableRisk(gui('log', [cond('path', 'starts_with', '/')]))).toBeNull();
    expect(saveRisk(gui('block'), gui('log'))).toBeNull();
    expect(disableRisk(gui('log'))).toBeNull();
  });

  test('Block asks only when it matches everything', () => {
    expect(enableRisk(gui('block'))).toBeNull();
    expect(enableRisk(gui('block', [cond('path', 'starts_with', '/')]))?.kind).toBe('match-all');
    expect(enableRisk(gui('challenge', [cond('uri', 'contains', '')]))?.kind).toBe('match-all');
  });

  test('scripts ask when they can return ALLOW', () => {
    expect(scriptCanAllow('if (x) then:\n    waf_allow()\nend')).toBe(true);
    expect(scriptCanAllow('waf_return("ALLOW")')).toBe(true);
    expect(scriptCanAllow('// waf_allow()\nwaf_block()')).toBe(false);
    expect(enableRisk({ mode: 'script', script: 'waf_allow()' })?.kind).toBe('script-allow');
    expect(enableRisk({ mode: 'script', script: 'waf_block()' })).toBeNull();
  });

  test('tuning asks when it turns inspection off or applies everywhere', () => {
    const scope = { logic: 'and' as const, conditions: [cond('path', 'equals', '/search')] };
    const base = { scope, target: { components: [], match: 'exact' as const } };
    expect(tuningTurnsInspectionOff({ ...base, effect: { scan_mode: 'disabled' } })).toBe(true);
    expect(tuningTurnsInspectionOff({ ...base, effect: { skip_semantic: ['*'] } })).toBe(true);
    expect(tuningTurnsInspectionOff({ ...base, effect: { skip_semantic: ['sql'] } })).toBe(false);
    expect(tuningTurnsInspectionOff({ ...base, effect: { scan_mode: 'both', skip_semantic: ['*'] } })).toBe(false);
    expect(tuningTurnsInspectionOff({ ...base, effect: {} })).toBe(false);
    const off = enableRisk({ name: 'Quiet search', mode: 'tuning', tuning: { ...base, effect: { skip_semantic: ['*'] } } });
    expect(off?.kind).toBe('inspection-off');
    expect(off?.title).toBe('Turn inspection off?');
    expect(off?.message).toContain('not checked for attacks');
    expect(enableRisk({ mode: 'tuning', tuning: { ...base, effect: { scan_mode: 'disabled' } } })?.kind).toBe('inspection-off');
    expect(
      enableRisk({ mode: 'tuning', tuning: { ...base, scope: { logic: 'and', conditions: [cond('path', 'starts_with', '/')] }, effect: { skip_semantic: ['sql'] } } })?.kind
    ).toBe('tuning-everywhere');
    expect(enableRisk({ mode: 'tuning', tuning: { ...base, effect: { skip_semantic: ['sql'] } } })).toBeNull();
  });

  test('a stored crs_only or semantic_only scan mode reads as the default', () => {
    expect(scanModeFromStored('crs_only')).toBe('default');
    expect(scanModeFromStored('semantic_only')).toBe('default');
    expect(scanModeFromStored(undefined)).toBe('default');
    expect(scanModeFromStored('both')).toBe('both');
    expect(scanModeFromStored('disabled')).toBe('disabled');
    const scope = { logic: 'and' as const, conditions: [cond('path', 'equals', '/search')] };
    const base = { scope, target: { components: [], match: 'exact' as const } };
    // crs_only alone does not turn inspection off now; with skip_semantic ["*"] it is the skip that does.
    expect(tuningTurnsInspectionOff({ ...base, effect: { scan_mode: 'crs_only' } })).toBe(false);
    expect(tuningTurnsInspectionOff({ ...base, effect: { scan_mode: 'crs_only', skip_semantic: ['*'] } })).toBe(true);
  });

  test('a stored tuning rule with a version 1 scan mode opens as the default and is saved without it', () => {
    const scope = { logic: 'and' as const, conditions: [cond('path', 'equals', '/search')] };
    const base = {
      id: 't1', app_id: 'a1', name: 'T', description: '', enabled: true, priority: 0, mode: 'tuning' as const,
      condition_logic: 'and' as const, action: 'log' as const, script: '', created_at: '', updated_at: '', conditions: [],
    };
    for (const scan_mode of ['crs_only', 'semantic_only'] as const) {
      const state = tuningFromRule({ ...base, tuning: { scope, target: { components: [], match: 'exact' }, effect: { skip_semantic: ['sql'], scan_mode } } });
      expect(state.scanMode).toBe('default');
      expect(buildTuningPayload(state).effect).toEqual({ skip_semantic: ['sql'] });
    }
  });

  test('a tuning rule is saved with an inspection warning first, and not again when it already had one', () => {
    const scope = { logic: 'and' as const, conditions: [cond('path', 'equals', '/search')] };
    const rule: RuleShape = { name: 'Quiet search', mode: 'tuning', enabled: true, tuning: { scope, target: { components: [], match: 'exact' }, effect: { skip_semantic: ['*'] } } };
    expect(saveRisk(null, rule)?.kind).toBe('inspection-off');
    expect(saveRisk(rule, { ...rule, name: 'Renamed' })).toBeNull();
    expect(saveRisk(null, { ...rule, enabled: false })).toBeNull();
  });

  test('a tuning rule with an empty scope applies everywhere; top-level conditions do not narrow it', () => {
    const base = { target: { components: [], match: 'exact' as const }, effect: { skip_semantic: ['sql'] } };
    const empty = { ...base, scope: { logic: 'and' as const, conditions: [] } };
    expect(tuningScopeMatchesEverything(empty)).toBe(true);
    expect(enableRisk({ mode: 'tuning', tuning: empty })?.kind).toBe('tuning-everywhere');
    // The agent reads tuning.scope only (ListTuningRulesRaw), never the rule's conditions.
    expect(enableRisk({ mode: 'tuning', conditions: [cond('path', 'equals', '/search')], tuning: empty })?.kind).toBe('tuning-everywhere');
    expect(tuningScopeMatchesEverything({ ...base, scope: { logic: 'and', conditions: [cond('path', 'equals', '/search')] } })).toBe(false);
    expect(enableRisk({ mode: 'tuning' })).toBeNull(); // nothing to apply
  });
});

describe('disabling asks only when protection is removed', () => {
  test('block, challenge and scripts ask; allow, log and tuning do not', () => {
    expect(disableRisk(gui('block'))?.kind).toBe('removes-protection');
    expect(disableRisk(gui('challenge'))).not.toBeNull();
    expect(disableRisk({ mode: 'script', script: 'waf_block()' })).not.toBeNull();
    expect(disableRisk(gui('allow'))).toBeNull();
    expect(disableRisk(gui('log'))).toBeNull();
    expect(disableRisk({ mode: 'tuning' })).toBeNull();
  });
});

describe('saving', () => {
  test('a new enabled Allow rule asks; a disabled one does not', () => {
    expect(saveRisk(null, { ...gui('allow'), enabled: true })?.kind).toBe('allow-bypass');
    expect(saveRisk(null, { ...gui('allow'), enabled: false })).toBeNull();
  });

  test('re-saving an already enabled Allow rule does not ask again', () => {
    const prev = { ...gui('allow'), enabled: true };
    expect(saveRisk(prev, { ...prev, name: 'Renamed' })).toBeNull();
  });

  test('turning a Block rule into Allow, or enabling it on save, asks', () => {
    expect(saveRisk({ ...gui('block'), enabled: true }, { ...gui('allow'), enabled: true })?.kind).toBe('allow-bypass');
    expect(saveRisk({ ...gui('allow'), enabled: false }, { ...gui('allow'), enabled: true })?.kind).toBe('allow-bypass');
  });
});

describe('registry validators mirror the server', () => {
  test('semantic engine keys are the server keys', () => {
    // The twenty keys of the agent, the four switch-only detectors included.
    for (const ok of ['sql', 'deser', 'proto_pollution', 'header_injection', 'open_redirect', 'prompt_injection', 'anomaly', '*']) expect(semanticEngineError(ok)).toBeNull();
    for (const bad of ['deserialization', 'prototype_pollution', 'headers', 'crlf']) expect(semanticEngineError(bad)).not.toBeNull();
  });

  test('tuning state needs a scope and an effect', () => {
    const st = emptyTuningState();
    expect(tuningStateError(st)).toContain('Apply when');
    st.scopeConditions = [emptyConditionRow()];
    expect(tuningStateError(st)).toContain('effect');
    st.skipSemantic = ['sql'];
    expect(tuningStateError(st)).toBeNull(); // the effect applies to the whole request
    st.skipSemantic = ['deserialization'];
    expect(tuningStateError(st)).toContain('semantic');
  });

  test('the tuning editor shows the scope the agent evaluates', () => {
    const base = {
      id: 't1',
      app_id: 'a1',
      name: 'T',
      description: '',
      enabled: true,
      priority: 0,
      mode: 'tuning' as const,
      condition_logic: 'and' as const,
      action: 'log' as const,
      script: '',
      created_at: '',
      updated_at: '',
    };
    const tuning = { target: { components: [], match: 'exact' as const }, effect: { skip_semantic: ['sql'] } };
    // tuning.scope wins, even when empty: the top-level conditions are not applied by the agent.
    const empty = tuningFromRule({ ...base, conditions: [cond('path', 'equals', '/x')], tuning: { ...tuning, scope: { logic: 'and', conditions: [] } } });
    expect(empty.scopeConditions).toHaveLength(0);
    const scoped = tuningFromRule({ ...base, conditions: [], tuning: { ...tuning, scope: { logic: 'or', conditions: [cond('path', 'equals', '/y')] } } });
    expect(scoped.scopeConditions.map((r) => r.value)).toEqual(['/y']);
    expect(scoped.scopeLogic).toBe('or');
    // Without a tuning payload (another rule type switched to tuning) the conditions seed the scope.
    const seeded = tuningFromRule({ ...base, mode: 'gui', conditions: [cond('path', 'equals', '/z')] });
    expect(seeded.scopeConditions.map((r) => r.value)).toEqual(['/z']);
  });

  test('condition rows are keyed and the key never reaches the server', () => {
    const a = emptyConditionRow();
    const b = emptyConditionRow();
    expect(a.id).not.toBe(b.id);
    const row = conditionToRow({ field: 'header:X-Api', operator: 'not_equals', value: 'k' });
    expect(row.id).toBeTruthy();
    expect(row.negate).toBe(true);
    const [out] = rowsToConditions([row]);
    expect(out).toEqual({ field: 'header:x-api', operator: 'equals', value: 'k', negate: true, case_sensitive: false, transforms: [] });
    expect('id' in out).toBe(false);
  });
});

describe('param and deep field conditions', () => {
  test('param:<name> round-trips and needs a name', () => {
    const row = conditionToRow({ field: 'param:user.email', operator: 'contains', value: 'x' });
    expect(row.fieldType).toBe('param');
    expect(row.name).toBe('user.email');
    expect(rowToCondition(row).field).toBe('param:user.email');
    expect(conditionFieldError('param:user.email')).toBeNull();
    expect(conditionFieldError('param')).not.toBeNull();
  });
  test('a JSON pointer with a wildcard is valid', () => {
    expect(conditionFieldError('json:/items/*/sku')).toBeNull();
  });
});
