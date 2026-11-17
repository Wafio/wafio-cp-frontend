import { describe, expect, test } from 'bun:test';
import {
  MAX_RULES_PER_APP,
  buildImportBodies,
  buildRulesExport,
  capacityError,
  checkImportEntry,
  defaultImportSelection,
  exportFileName,
  importsEnabled,
  parseRulesFile,
  summarizeImport,
} from '../src/lib/custom-rules-io';
import type { CustomRule } from '../src/lib/api';

const gui = (over: Record<string, unknown> = {}) => ({
  name: 'Block admin',
  mode: 'gui',
  action: 'block',
  enabled: true,
  priority: 10,
  condition_logic: 'and',
  conditions: [{ field: 'path', operator: 'starts_with', value: '/admin' }],
  ...over,
});

const script = (over: Record<string, unknown> = {}) => ({
  name: 'Score gate',
  mode: 'script',
  action: 'block',
  enabled: true,
  script: 'if (score > 80.0) then:\n    waf_block()\nend\n',
  ...over,
});

const tuning = (over: Record<string, unknown> = {}) => ({
  name: 'Search FP',
  mode: 'tuning',
  enabled: false,
  conditions: [{ field: 'path', operator: 'equals', value: '/search' }],
  tuning: {
    scope: { logic: 'and', conditions: [{ field: 'path', operator: 'equals', value: '/search' }] },
    target: { components: [], match: 'exact' },
    effect: { skip_semantic: ['sql'] },
  },
  ...over,
});

describe('export', () => {
  const rule: CustomRule = {
    id: 'r1',
    app_id: 'a1',
    name: 'Block admin',
    description: 'desc',
    enabled: true,
    priority: 5,
    mode: 'gui',
    conditions: [{ field: 'path', operator: 'starts_with', value: '/admin' }],
    condition_logic: 'and',
    action: 'block',
    script: '',
    created_at: '2026-09-27T00:00:00Z',
    updated_at: '2026-09-27T00:00:00Z',
  };

  test('strips ids and timestamps, keeps the rule content', () => {
    const out = buildRulesExport([rule], { id: 'a1', name: 'Shop' }, new Date('2026-09-27T10:00:00Z'));
    expect(out.app_id).toBe('a1');
    expect(out.app_name).toBe('Shop');
    expect(out.exported_at).toBe('2026-09-27T10:00:00.000Z');
    expect(out.rules[0]).toEqual({
      name: 'Block admin',
      description: 'desc',
      enabled: true,
      priority: 5,
      mode: 'gui',
      conditions: rule.conditions,
      condition_logic: 'and',
      action: 'block',
      script: '',
    });
    expect('id' in out.rules[0]).toBe(false);
  });

  test('an export parses back into valid rows', () => {
    const out = buildRulesExport([rule], { id: 'a1', name: 'Shop' });
    const parsed = parseRulesFile(JSON.stringify(out));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.rows).toHaveLength(1);
      expect(parsed.rows[0].error).toBeNull();
      expect(parsed.appName).toBe('Shop');
    }
  });

  test('file name is a slug', () => {
    expect(exportFileName('My Shop / API')).toBe('custom-rules-my-shop-api.json');
    expect(exportFileName(undefined)).toBe('custom-rules-app.json');
    expect(exportFileName('***')).toBe('custom-rules-app.json');
  });
});

describe('entry validation', () => {
  test('accepts the three modes', () => {
    expect(checkImportEntry(gui()).body?.mode).toBe('gui');
    expect(checkImportEntry(script()).body?.mode).toBe('script');
    const t = checkImportEntry(tuning());
    expect(t.body?.mode).toBe('tuning');
    expect(t.body?.action).toBe('log');
  });

  test('rejects what the server rejects', () => {
    expect(checkImportEntry(null).error).toBe('entry is not an object');
    expect(checkImportEntry(gui({ name: '  ' })).error).toBe('name is missing');
    expect(checkImportEntry(gui({ mode: 'lua' })).error).toContain('unknown mode');
    expect(checkImportEntry(gui({ action: 'drop' })).error).toContain('unknown action');
    expect(checkImportEntry(gui({ conditions: [] })).error).toContain('at least one condition');
    expect(checkImportEntry(gui({ conditions: [{ field: 'nope', operator: 'equals', value: 'x' }] })).error).toContain('unknown condition field');
    expect(checkImportEntry(gui({ conditions: [{ field: 'header:', operator: 'equals', value: 'x' }] })).error).toContain('needs a name');
    expect(checkImportEntry(gui({ conditions: [{ field: 'path', operator: 'like', value: 'x' }] })).error).toContain('unknown operator');
    expect(checkImportEntry(gui({ conditions: [{ field: 'path', operator: 'equals', value: 5 }] })).error).toContain('value must be text');
    expect(checkImportEntry(gui({ conditions: [{ field: 'path', operator: 'equals', value: 'x', transforms: ['rot13'] }] })).error).toContain('unknown transform');
    expect(checkImportEntry(gui({ condition_logic: 'xor' })).error).toContain('condition_logic');
    expect(checkImportEntry(gui({ priority: 1.5 })).error).toContain('priority');
    expect(checkImportEntry(gui({ enabled: 'yes' })).error).toContain('enabled');
    expect(checkImportEntry(script({ script: '   ' })).error).toBe('script is empty');
  });

  test('accepts legacy operators and server-only transforms', () => {
    expect(checkImportEntry(gui({ conditions: [{ field: 'path', operator: 'not_contains', value: 'x', transforms: ['trim_left'] }] })).error).toBeUndefined();
  });

  test('tuning: engine keys and the action are checked, a weaken of a version 1 file is not', () => {
    const withEffect = (effect: Record<string, unknown>) => tuning({ tuning: { ...tuning().tuning, effect } });
    expect(checkImportEntry(withEffect({ skip_semantic: ['deserialization'] })).error).toContain('skip_semantic');
    expect(checkImportEntry(withEffect({ action: 'block' })).error).toContain('action');
    expect(checkImportEntry(withEffect({ action: 'log', skip_semantic: ['sql'] })).error).toBeUndefined();
    expect(checkImportEntry(withEffect({ weaken: { score_multiplier: 2 } })).error).toBeUndefined();
    expect(checkImportEntry(withEffect({ weaken: { threshold_delta: { block: -10 } } })).error).toBeUndefined();
    expect(checkImportEntry(withEffect({ scan_mode: 'off' })).error).toContain('scan mode');
    expect(checkImportEntry(tuning({ tuning: undefined })).error).toContain('no tuning settings');
    expect(checkImportEntry(tuning({ tuning: { ...tuning().tuning, scope: { logic: 'xor', conditions: [] } } })).error).toContain('scope logic');
    expect(
      checkImportEntry(tuning({ tuning: { ...tuning().tuning, scope: { logic: 'and', conditions: [{ field: 'nope', operator: 'equals', value: 'x' }] } } })).error
    ).toContain('unknown condition field');
  });

  test('a v1 file loads without an error and the keys of the removed rule engine are not saved', () => {
    const v1 = tuning({
      tuning: {
        scope: { logic: 'and', conditions: [{ field: 'path', operator: 'equals', value: '/search' }] },
        target: { components: ['query:q'], match: 'exact' },
        engine: 'crs',
        effect: { skip_crs: ['942100', 'tag:attack-sqli', 'not a rule'], skip_semantic: ['sql'], scan_mode: 'crs_only', weaken: { sensitivity_delta: -1, score_multiplier: 0.5, threshold_delta: { block: 10 } } },
      },
    });
    const { body, error } = checkImportEntry(v1);
    expect(error).toBeUndefined();
    expect(body?.tuning).toEqual({
      scope: { logic: 'and', conditions: [{ field: 'path', operator: 'equals', value: '/search' }] },
      target: { components: [], match: 'exact' },
      effect: { skip_semantic: ['sql'], action: 'log' },
    });
    // A weaken that changed no verdict is dropped.
    const dropped = checkImportEntry(tuning({ tuning: { ...tuning().tuning, effect: { skip_semantic: ['sql'], weaken: { score_multiplier: 2, threshold_delta: { log: 30 } } } } }));
    expect(dropped.body?.tuning?.effect).toEqual({ skip_semantic: ['sql'] });
    // semantic_only reads as the default too.
    const semanticOnly = checkImportEntry(tuning({ tuning: { ...tuning().tuning, effect: { scan_mode: 'semantic_only', skip_semantic: ['sql'] } } }));
    expect(semanticOnly.error).toBeUndefined();
    expect(semanticOnly.body?.tuning?.effect).toEqual({ skip_semantic: ['sql'] });
    // Scan modes the editor still has are kept.
    const both = checkImportEntry(tuning({ tuning: { ...tuning().tuning, effect: { scan_mode: 'both' } } })).body;
    expect(both?.tuning?.effect).toEqual({ scan_mode: 'both' });
    const disabled = checkImportEntry(tuning({ tuning: { ...tuning().tuning, effect: { scan_mode: 'disabled' } } })).body;
    expect(disabled?.tuning?.effect).toEqual({ scan_mode: 'disabled' });
  });

  test('the tuning scope is what the agent evaluates; top-level conditions are rewritten to it', () => {
    const body = checkImportEntry(tuning({ conditions: [] })).body;
    expect(body?.conditions).toEqual([{ field: 'path', operator: 'equals', value: '/search' }]);
    expect(body?.tuning?.scope.conditions).toEqual([{ field: 'path', operator: 'equals', value: '/search' }]);
  });

  test('an empty tuning scope is valid (it applies to every request) and is not filled from top-level conditions', () => {
    const entry = tuning({
      conditions: [{ field: 'path', operator: 'equals', value: '/search' }],
      tuning: { ...tuning().tuning, scope: { logic: 'and', conditions: [] } },
    });
    const body = checkImportEntry(entry).body;
    expect(body).toBeDefined();
    expect(body?.tuning?.scope.conditions).toEqual([]);
    expect(body?.conditions).toEqual([]);
    const parsed = parseRulesFile(JSON.stringify([{ ...entry, enabled: true }]));
    if (!parsed.ok) throw new Error('parse failed');
    const summary = summarizeImport(parsed.rows, defaultImportSelection(parsed.rows), true);
    expect(summary.risky.map((r) => r.risk.kind)).toEqual(['tuning-everywhere']);
  });
});

describe('file parsing and preview', () => {
  test('bad files', () => {
    expect(parseRulesFile('{')).toEqual({ ok: false, error: 'The file is not valid JSON.' });
    expect(parseRulesFile('{"items":[]}')).toEqual({ ok: false, error: 'The file has no "rules" list.' });
    expect(parseRulesFile('{"rules":[]}')).toEqual({ ok: false, error: 'The file contains no rules.' });
  });

  test('a bare array is accepted', () => {
    const parsed = parseRulesFile(JSON.stringify([gui()]));
    expect(parsed.ok).toBe(true);
  });

  test('rows keep invalid entries with a reason and mark duplicates', () => {
    const parsed = parseRulesFile(JSON.stringify({ rules: [gui(), gui({ action: 'nope', name: 'Broken' }), gui(), script()] }), ['score gate']);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const [a, b, c, d] = parsed.rows;
    expect(a.error).toBeNull();
    expect(a.duplicate).toBe(false);
    expect(b.body).toBeNull();
    expect(b.error).toContain('unknown action');
    expect(b.name).toBe('Broken');
    expect(c.duplicate).toBe(true); // same name earlier in the file
    expect(d.duplicate).toBe(true); // same name as an existing rule
  });

  test('invalid rows are never selected or counted', () => {
    const parsed = parseRulesFile(JSON.stringify({ rules: [gui(), { name: 'x', mode: 'gui' }, script()] }));
    if (!parsed.ok) throw new Error('parse failed');
    const selection = defaultImportSelection(parsed.rows);
    expect([...selection]).toEqual([0, 2]);
    selection.add(1); // even if a caller forces it
    const summary = summarizeImport(parsed.rows, selection, false);
    expect(summary).toMatchObject({ total: 3, valid: 2, invalid: 1, selected: 2, enabledOnImport: 0 });
    expect(buildImportBodies(parsed.rows, selection, { keepEnabled: false })).toHaveLength(2);
  });
});

describe('imported rules start disabled', () => {
  const parsed = parseRulesFile(JSON.stringify({ rules: [gui({ action: 'allow' }), script({ enabled: false }), gui({ name: 'No flag', enabled: undefined })] }));
  if (!parsed.ok) throw new Error('parse failed');
  const all = defaultImportSelection(parsed.rows);

  test('by default every rule is created disabled', () => {
    const bodies = buildImportBodies(parsed.rows, all, { keepEnabled: false });
    expect(bodies.map((b) => b.enabled)).toEqual([false, false, false]);
    expect(summarizeImport(parsed.rows, all, false).risky).toHaveLength(0);
  });

  test('keeping the file state is explicit and reports risky rules', () => {
    const bodies = buildImportBodies(parsed.rows, all, { keepEnabled: true });
    expect(bodies.map((b) => b.enabled)).toEqual([true, false, true]);
    const summary = summarizeImport(parsed.rows, all, true);
    expect(summary.enabledOnImport).toBe(2);
    expect(summary.risky.map((r) => r.risk.kind)).toEqual(['allow-bypass']);
    expect(importsEnabled(parsed.rows[2], true)).toBe(true); // absent flag = server default (enabled)
  });

  test('only selected rows are built', () => {
    const bodies = buildImportBodies(parsed.rows, new Set([1]), { keepEnabled: false });
    expect(bodies.map((b) => b.name)).toEqual(['Score gate']);
  });
});

describe('capacity', () => {
  test('stays under the per-application cap', () => {
    expect(capacityError(10, 5)).toBeNull();
    expect(capacityError(MAX_RULES_PER_APP - 1, 1)).toBeNull();
    expect(capacityError(198, 5)).toContain('at most 2 more');
  });
});
