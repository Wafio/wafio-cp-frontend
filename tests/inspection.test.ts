// The inspection switch: how a stored scope reads, what is saved, the texts around it, and the script rule messages.
import { describe, expect, test } from 'bun:test';
import {
  INSPECTION_KEYS,
  NOT_CHECKED,
  PATH_INSPECTION_OFF,
  PATH_INSPECTION_OFF_ALERT,
  POLICY_INSPECTION_OFF,
  SCRIPT_RULES_UNSUPPORTED,
  SCRIPT_RULES_UNSUPPORTED_MESSAGE,
  SCRIPT_RULES_UNSUPPORTED_TITLE,
  SKIP_ALL_ENGINES_TEXT,
  TUNING_INSPECTION_OFF_TEXT,
  inspectionFlagsToSave,
  inspectionOffFromFlags,
  inspectionSummary,
  policyInspectionOffAlert,
  scriptRulesWarning,
} from '../src/lib/inspection';
import { RuleSaveError, ruleSaveError } from '../src/lib/components/rules/script-access';

describe('reading a stored scope', () => {
  test.each([
    [{}, false],
    [{ inspection_off: true }, true],
    [{ inspection_off: false }, false],
    [{ inspection_off: 'true' }, false],
    [{ inspection_off: true, disable_semantic: false }, true],
    // A version 1 document: the old pair, or disable_semantic alone, is off; disable_rule_based alone means nothing.
    [{ disable_semantic: false, disable_rule_based: false }, false],
    [{ disable_semantic: true }, true],
    [{ disable_semantic: true, disable_rule_based: true }, true],
    [{ disable_semantic: true, disable_rule_based: false }, true],
    [{ disable_rule_based: true }, false],
    [{ disable_semantic: false, disable_rule_based: true }, false],
  ] as const)('%j is inspection off: %s', (flags, off) => {
    expect(inspectionOffFromFlags(flags)).toBe(off);
  });

  test('no document at all reads as on', () => {
    expect(inspectionOffFromFlags(null)).toBe(false);
    expect(inspectionOffFromFlags(undefined)).toBe(false);
  });
});

describe('saving a switch position', () => {
  test('off saves inspection_off only, none of the version 1 keys', () => {
    expect(inspectionFlagsToSave(true)).toEqual({ inspection_off: true });
  });

  test('on saves no flag', () => {
    expect(inspectionFlagsToSave(false)).toEqual({});
  });

  test('what is saved reads back as the same position', () => {
    for (const off of [true, false]) expect(inspectionOffFromFlags(inspectionFlagsToSave(off))).toBe(off);
  });

  test('the keys a save removes are the current key and the two of version 1', () => {
    expect([...INSPECTION_KEYS].sort()).toEqual(['disable_rule_based', 'disable_semantic', 'inspection_off']);
  });
});

describe('texts', () => {
  test('every place that turns inspection off says requests are not checked', () => {
    expect(POLICY_INSPECTION_OFF.hint).toContain(NOT_CHECKED);
    expect(policyInspectionOffAlert('app')).toContain('not checked for attacks');
    expect(policyInspectionOffAlert('app')).toContain('application');
    expect(policyInspectionOffAlert('project')).toContain('project');
    expect(PATH_INSPECTION_OFF.description).toContain('not checked for attacks');
    expect(PATH_INSPECTION_OFF_ALERT).toContain('not checked for attacks');
    expect(TUNING_INSPECTION_OFF_TEXT).toContain('Inspection off for matched requests');
    expect(TUNING_INSPECTION_OFF_TEXT).toContain('not checked for attacks');
    expect(SKIP_ALL_ENGINES_TEXT).toContain('Inspection off for matched requests');
  });

  test('no text names the removed rule engine or an engine kind', () => {
    const texts = [
      POLICY_INSPECTION_OFF.label, POLICY_INSPECTION_OFF.hint, policyInspectionOffAlert('app'), policyInspectionOffAlert('project'),
      PATH_INSPECTION_OFF.label, PATH_INSPECTION_OFF.description, PATH_INSPECTION_OFF_ALERT, TUNING_INSPECTION_OFF_TEXT, SKIP_ALL_ENGINES_TEXT,
      inspectionSummary(true), inspectionSummary(false),
      scriptRulesWarning(false, 'app') ?? '', scriptRulesWarning(false, 'agent') ?? '', SCRIPT_RULES_UNSUPPORTED_TITLE, SCRIPT_RULES_UNSUPPORTED_MESSAGE,
    ];
    for (const text of texts) expect(text).not.toMatch(/crs|coraza|rule.?set|rule-based|semantic only|paranoia/i);
  });

});

describe('script rules the agent cannot run', () => {
  test('only an explicit false warns; absent or null is unknown', () => {
    expect(scriptRulesWarning(false, 'app')).toContain('cannot run script rules');
    expect(scriptRulesWarning(false, 'agent')).toContain('cannot run script rules');
    expect(scriptRulesWarning(true, 'app')).toBeNull();
    expect(scriptRulesWarning(null, 'app')).toBeNull();
    expect(scriptRulesWarning(undefined, 'agent')).toBeNull();
  });

  test('the 400 code SCRIPT_RULES_UNSUPPORTED has its own title and message', () => {
    const error = ruleSaveError({ status: 400, error: 'script rules are not supported by the WAF agent', code: SCRIPT_RULES_UNSUPPORTED });
    expect(error).toBeInstanceOf(RuleSaveError);
    expect(error.code).toBe('SCRIPT_RULES_UNSUPPORTED');
    expect(error.title).toBe(SCRIPT_RULES_UNSUPPORTED_TITLE);
    expect(error.title).toBe('This WAF agent cannot run script rules. Nothing was saved.');
    expect(error.message).toBe(SCRIPT_RULES_UNSUPPORTED_MESSAGE);
    expect(error.scriptProblem).toBe(false);
  });

  test('other codes keep their own handling and carry no title', () => {
    expect(ruleSaveError({ status: 400, error: 'bad', code: 'INVALID_RULE' }).title).toBeUndefined();
    expect(ruleSaveError({ status: 403, error: 'x', code: 'SCRIPT_RULE_OWNER_REQUIRED' }).title).toBeUndefined();
    expect(ruleSaveError(undefined, 'Could not save.').message).toBe('Could not save.');
  });
});
