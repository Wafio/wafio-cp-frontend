// A tuning rule holds back blocks as LOG for the requests it matches ("Log only for matched requests", stored as
// effect.action "log"). A weaken of version 1 shows as that choice when it lowered scores or raised the block
// threshold, and as nothing otherwise.
import './support/runes';
import './support/ssr';
import { describe, expect, test } from 'bun:test';
import type { CustomRule } from '../src/lib/api';
import { buildTuningPayload, emptyConditionRow, emptyTuningState, tuningFromRule, tuningHasEffect, tuningStateError } from '../src/lib/components/rules/registry';
import { emptyTuning, pathRuleFromRaw, pathRuleToJson, toJsonValue, tuningFromRaw, tuningToJson, type Json } from '../src/lib/components/waf-policy/model';
import { renderComponent } from './support/ssr';

// The UI barrel pulls in PageHeader, which reads `dev` from SvelteKit.
Bun.plugin({
  name: 'app-environment-stub',
  setup(build) {
    build.module('$app/env', () => ({ loader: 'object', exports: { dev: false, browser: false, building: false, version: 'test' } }));
  }
});

const { default: TuningTab } = await import('../src/lib/components/rules/TuningTab.svelte');
const { default: PathTuningSection } = await import('../src/lib/components/rules/PathTuningSection.svelte');
const text = (html: string) => html.replace(/<!--.*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

const rule = (effect: Record<string, unknown>) =>
  ({
    id: 't1', app_id: 'a1', name: 'T', description: '', enabled: true, priority: 0, mode: 'tuning', condition_logic: 'and', action: 'log', script: '',
    created_at: '', updated_at: '',
    tuning: { scope: { logic: 'and', conditions: [{ field: 'path', operator: 'equals', value: '/x' }] }, target: { components: [], match: 'exact' }, effect }
  }) as unknown as CustomRule;

describe('a custom tuning rule', () => {
  test('is saved with action log when the choice is on, and with nothing when it is off', () => {
    const state = emptyTuningState();
    state.skipSemantic = ['sql'];
    expect(buildTuningPayload(state).effect).toEqual({ skip_semantic: ['sql'] });
    state.logOnly = true;
    expect(buildTuningPayload(state).effect).toEqual({ skip_semantic: ['sql'], action: 'log' });
    expect(buildTuningPayload(state).effect).not.toHaveProperty('weaken');
  });

  test('the choice alone is an effect', () => {
    const state = emptyTuningState();
    state.scopeConditions = [emptyConditionRow()];
    expect(tuningHasEffect(state)).toBe(false);
    expect(tuningStateError(state)).toContain('log only');
    state.logOnly = true;
    expect(tuningHasEffect(state)).toBe(true);
    expect(tuningStateError(state)).toBeNull();
  });

  test('shows a stored action as the choice, and a weaken of version 1 as the choice or as nothing', () => {
    expect(tuningFromRule(rule({ action: 'log' })).logOnly).toBe(true);
    expect(tuningFromRule(rule({ weaken: { score_multiplier: 0.5 } })).logOnly).toBe(true);
    expect(tuningFromRule(rule({ weaken: { threshold_delta: { block: 30 } } })).logOnly).toBe(true);
    for (const weaken of [{ score_multiplier: 1 }, { score_multiplier: 3 }, { threshold_delta: { log: 30 } }, { threshold_delta: { block: -5 } }, { sensitivity_delta: -1 }, {}]) {
      expect(tuningFromRule(rule({ skip_semantic: ['sql'], weaken })).logOnly).toBe(false);
    }
    // Saving what a v1 rule shows leaves the weaken behind.
    expect(buildTuningPayload(tuningFromRule(rule({ skip_semantic: ['sql'], weaken: { score_multiplier: 0.5 } }))).effect).toEqual({ skip_semantic: ['sql'], action: 'log' });
  });
});

describe('the tuning of a path rule', () => {
  test('is saved with action log, and a stored weaken is read the same way', () => {
    const form = emptyTuning();
    expect(tuningToJson(form)).toBeUndefined();
    form.effect.logOnly = true;
    expect(tuningToJson(form)).toEqual({ target: null, effect: { action: 'log' } });
    expect(tuningFromRaw({ effect: { skip_semantic: ['xss'], action: 'log' } }).effect).toEqual({ skip_semantic: ['xss'], logOnly: true });
    expect(tuningFromRaw({ effect: { weaken: { score_multiplier: 0.2 } } }).effect.logOnly).toBe(true);
    expect(tuningFromRaw({ effect: { weaken: { score_multiplier: 1.5 } } }).effect.logOnly).toBe(false);
  });

  test('a rule path that only logs keeps the choice through a save and loses the weaken', () => {
    const path = pathRuleFromRaw({ path: '/a', match: 'prefix', tuning: { target: null, effect: { weaken: { score_multiplier: 0.5, threshold_delta: { block: 10 } } } } });
    expect(path.tuning.effect.logOnly).toBe(true);
    expect(toJsonValue(pathRuleToJson(path)).tuning as Json).toEqual({ target: null, effect: { action: 'log' } });
  });
});

describe('the editors', () => {
  test('the custom rule editor and the path editor show one choice and no weaken controls', async () => {
    const state = emptyTuningState();
    state.logOnly = true;
    const custom = text(await renderComponent(TuningTab, { tuning: state } as never));
    const path = text(await renderComponent(PathTuningSection, { tuning: emptyTuning() } as never));
    for (const html of [custom, path]) {
      expect(html).toContain('Log only for matched requests');
      expect(html).toContain('A detection that would block is recorded as LOG and the request goes on.');
      for (const gone of ['Weaken detection', 'Score multiplier', 'Raise block threshold', 'Raise log threshold']) expect(html).not.toContain(gone);
    }
  });
});
