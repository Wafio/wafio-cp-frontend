import { describe, expect, test } from 'bun:test';
import {
  INFRASTRUCTURE_CHECKS,
  PIPELINE_STEPS,
  RULE_STAGES,
  SCRIPT_FAST_PATH,
  SCRIPT_SKIPPED_WHEN,
  stageLine,
} from '../src/lib/components/rules/rule-stages';

// The one description of when custom rules run, checked against the
// order of internal/application/analyze.go: infrastructure checks →
// EvalGUIRules → ResolveTuningPlan → path IP rules / login protection /
// upload scan → detection engines → decision engine → EvalScriptRules.
describe('custom rule stages', () => {
  const order = PIPELINE_STEPS.map((s) => s.mode ?? s.label);

  test('Match & act and tuning run before the engines, scripts after the decision', () => {
    const gui = order.indexOf('gui');
    const tuning = order.indexOf('tuning');
    const script = order.indexOf('script');
    const engines = PIPELINE_STEPS.findIndex((s) => /decision engine/i.test(s.label));
    expect(order[0]).toBe('Infrastructure checks');
    expect(gui).toBeGreaterThan(0);
    expect(tuning).toBe(gui + 1);
    expect(engines).toBeGreaterThan(tuning);
    expect(script).toBe(PIPELINE_STEPS.length - 1);
    expect(script).toBeGreaterThan(engines);
  });

  test('every rule type has one stage line, and the editor uses the same text', () => {
    for (const mode of ['gui', 'tuning', 'script'] as const) {
      expect(RULE_STAGES[mode].mode).toBe(mode);
      expect(stageLine(mode)).toBe(RULE_STAGES[mode].when);
    }
    expect(RULE_STAGES.gui.when).toMatch(/before/i);
    expect(RULE_STAGES.tuning.when).toMatch(/before/i);
    expect(RULE_STAGES.script.when).toMatch(/after/i);
  });

  test('the texts do not contradict the pipeline', () => {
    // A matching Match & act rule returns before scripts (analyze.go returns at EvalGUIRules).
    expect(RULE_STAGES.gui.effect).toMatch(/script rules/i);
    expect(RULE_STAGES.gui.effect).toMatch(/without conditions never matches/i);
    // Tuning never decides a request.
    expect(RULE_STAGES.tuning.effect).toMatch(/never allows or blocks/i);
    // Script budgets: engine.DefaultScriptRuleTimeout / DefaultScriptRulesBudget.
    expect(RULE_STAGES.script.effect).toContain('5 ms');
    expect(RULE_STAGES.script.effect).toContain('15 ms');
    expect(SCRIPT_FAST_PATH).toMatch(/score 0/);
    expect(SCRIPT_SKIPPED_WHEN).toMatch(/Match & act/);
    expect(SCRIPT_SKIPPED_WHEN).toMatch(/strong detection/);
    for (const check of ['body size', 'smuggling', 'GraphQL', 'L7 flood', 'geoblocking', 'bot']) {
      expect(INFRASTRUCTURE_CHECKS).toContain(check);
    }
    // No stage claims scripts run before the engines (the old contradiction).
    for (const text of [RULE_STAGES.script.when, RULE_STAGES.script.effect, SCRIPT_SKIPPED_WHEN, SCRIPT_FAST_PATH]) {
      expect(text).not.toMatch(/before the (detection )?engines/i);
    }
  });
});
