// The detection settings of the policy editor: the switch component, the decimal fields of the engine sensitivity,
// the "Record weak detections" switch and its stored key, what a save does with the scores of a document of version 1,
// and what the editor no longer shows.
import './support/runes';
import './support/ssr';
import { describe, expect, test } from 'bun:test';
import { renderComponent } from './support/ssr';
import { fullRules, goDefaultRules } from './support/waf-policy-fixtures';
import {
  SENSITIVITY_ENGINES,
  customSensitivityCount,
  draftFromRules,
  pathRuleFromRaw,
  pathRuleToJson,
  resetSensitivity,
  pathSensitivityOf,
  setPathSensitivity,
  sensitivityLevelOf,
  sensitivityValues,
  rulesFromDraft,
  setEngineAction,
  toJsonValue,
  type Json
} from '../src/lib/components/waf-policy/model';
import { formatDecimal, parseDecimal } from '../src/lib/components/waf-policy/decimal';
import { validatePathRule, validatePolicy } from '../src/lib/components/waf-policy/validate';
import { diffPolicy } from '../src/lib/components/waf-policy/review';

// The UI barrel pulls in PageHeader, which reads `dev` from SvelteKit.
Bun.plugin({
  name: 'app-environment-stub',
  setup(build) {
    build.module('$app/env', () => ({ loader: 'object', exports: { dev: false, browser: false, building: false, version: 'test' } }));
  }
});

const { WafPolicyForm } = await import('../src/lib/components/waf-policy/waf-policy-form.svelte');
const { default: Switch } = await import('../src/lib/components/ui/Switch.svelte');
const { default: DecimalInput } = await import('../src/lib/components/waf-policy/DecimalInput.svelte');
const { default: EngineTable } = await import('../src/lib/components/waf-policy/EngineTable.svelte');
const { default: ProtectionSection } = await import('../src/lib/components/waf-policy/ProtectionSection.svelte');
const { default: ReviewDrawer } = await import('../src/lib/components/waf-policy/ReviewDrawer.svelte');
const { default: PolicyIndex } = await import('../src/lib/components/waf-policy/PolicyIndex.svelte');

const render = (component: unknown, props: Record<string, unknown>) => renderComponent(component as never, props as never);
const read = (path: string) => Bun.file(new URL(`../${path}`, import.meta.url).pathname).text();
const text = (html: string) => html.replace(/<!--.*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/&#39;|&apos;/g, "'").replace(/\s+/g, ' ');
const saved = (draft: ReturnType<typeof draftFromRules>, original: Json) => toJsonValue(rulesFromDraft(draft, original)) as Json;

describe('the switch component', () => {
  test('is a button with role switch, named by its label, with the hint as its description', async () => {
    const html = await render(Switch, { checked: false, label: 'Scan all request headers', hint: 'On by default.', id: 'sw-a' });
    expect(html).toMatch(/<button[^>]*type="button"[^>]*role="switch"[^>]*id="sw-a"/);
    expect(html).toMatch(/<label for="sw-a"[^>]*>Scan all request headers<\/label>/);
    expect(html).toContain('aria-describedby="sw-a-hint"');
    expect(html).toMatch(/<p id="sw-a-hint"[^>]*>On by default\.<\/p>/);
    // A native button: Space and Enter operate it and it is one tab stop, with no tabindex of its own.
    expect(html).not.toContain('tabindex');
  });

  test('says its state in words as well as by position: aria-checked and On or Off', async () => {
    const on = await render(Switch, { checked: true, label: 'A' });
    expect(on).toContain('aria-checked="true"');
    expect(text(on)).toContain('On');
    const off = await render(Switch, { checked: false, label: 'A' });
    expect(off).toContain('aria-checked="false"');
    expect(text(off)).toMatch(/A\s+Off/);
  });

  test('a disabled switch is a disabled button', async () => {
    expect(await render(Switch, { checked: true, label: 'A', id: 'sw-b', disabled: true })).toMatch(/<button[^>]*id="sw-b"[^>]*disabled/);
  });

  test('is a 44 px target with a visible focus ring and no removed outline', async () => {
    const source = await read('src/lib/components/ui/Switch.svelte');
    expect(source).toContain('min-height: 44px');
    expect(source).toContain('.sw-control:focus-visible { outline: var(--ring-width) solid var(--ring-color);');
    expect(source).not.toMatch(/outline:\s*(none|0)/);
  });

  test('the three plain on or off settings use it', async () => {
    const html = await render(ProtectionSection, { form: WafPolicyForm.fromRules({}) });
    expect(html).toMatch(/role="switch"[^>]*id="wp-engines-recordWeakDetections"/);
    const options = await render((await import('../src/lib/components/waf-policy/InspectionOptions.svelte')).default, { form: WafPolicyForm.fromRules({}) });
    expect(options).toMatch(/role="switch"[^>]*id="wp-engines-inspectionOff"/);
    expect(options).toMatch(/role="switch"[^>]*id="wp-engines-scanAllHeaders"/);
  });
});

describe('decimal fields', () => {
  test('a number is read with a point or a comma, an empty field is the default, anything else is not a number', () => {
    expect(parseDecimal('2.5')).toBe(2.5);
    expect(parseDecimal(' 4 ')).toBe(4);
    expect(parseDecimal('.5')).toBe(0.5);
    expect(parseDecimal('2,5')).toBe(2.5);
    expect(parseDecimal('')).toBeNull();
    expect(parseDecimal('   ')).toBeNull();
    for (const bad of ['abc', '2.5.1', '1,000.5', '1e3', '-1', '2,', '2 5', '٢٫٥']) expect(parseDecimal(bad)).toBeUndefined();
  });

  test('a number is always written with a decimal point, whatever the browser language', () => {
    expect(formatDecimal(2.5)).toBe('2.5');
    expect(formatDecimal(4)).toBe('4');
    expect(formatDecimal(null)).toBe('');
    expect(formatDecimal(Number.NaN)).toBe('');
  });

  test('the field is a text input with a decimal keypad, showing the stored value with a point', async () => {
    const html = await render(DecimalInput, { value: 2.5, id: 'd-1', placeholder: '4', 'aria-label': 'SQL injection block value' });
    expect(html).toMatch(/<input[^>]*type="text"/);
    expect(html).toContain('inputmode="decimal"');
    expect(html).toContain('value="2.5"');
    expect(html).toContain('placeholder="4"');
    expect(html).not.toContain('type="number"');
  });
});

describe('engine sensitivity', () => {
  const table = async (rules: Json = {}) => {
    const html = await render(EngineTable, { form: WafPolicyForm.fromRules(rules) });
    return { html, sensitivity: html.slice(html.indexOf('id="wp-engine-sensitivity"')) };
  };

  test('is a disclosure under the engine table, closed by default', async () => {
    const { html } = await table();
    expect(html.indexOf('aria-label="Detection engines"')).toBeLessThan(html.indexOf('Engine sensitivity'));
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*aria-controls="wp-engine-sensitivity"/);
    expect(html).toMatch(/<div id="wp-engine-sensitivity"[^>]*hidden/);
    expect(text(html)).toContain('all Balanced');
  });

  test('has a row for each engine that has thresholds and for no other, with the defaults as placeholders', async () => {
    const { sensitivity } = await table();
    expect(SENSITIVITY_ENGINES.map((meta) => meta.key)).toEqual(['sql', 'xss', 'cmd', 'php', 'python', 'lfi', 'ssrf', 'java', 'nosql', 'ssti', 'xxe', 'deser']);
    expect(sensitivity.match(/<tr/g)?.length).toBe(2 * (1 + SENSITIVITY_ENGINES.length));
    for (const meta of SENSITIVITY_ENGINES) {
      expect(sensitivity).toMatch(new RegExp(`id="wp-semantic-${meta.key}-block"[^>]*placeholder="${meta.defaultBlock}"`));
      expect(sensitivity).toMatch(new RegExp(`id="wp-semantic-${meta.key}-soft"[^>]*placeholder="${meta.defaultSoft}"`));
    }
    for (const key of ['ldap', 'proto_pollution', 'jwt', 'graphql', 'header_injection', 'open_redirect', 'prompt_injection', 'anomaly']) {
      expect(sensitivity).not.toContain(`wp-semantic-${key}-`);
    }
    expect(sensitivity.match(/type="number"/g)).toBeNull();
    expect(sensitivity.match(/inputmode="decimal"/g)?.length).toBe(2 * SENSITIVITY_ENGINES.length);
  });

  test('says what a lower and a higher value do', async () => {
    const { sensitivity } = await table();
    const t = text(sensitivity);
    expect(t).toContain('A lower value reports more from the parsed text and can raise false alarms; a higher value reports less and can miss attacks.');
    expect(sensitivity.match(/<p /g)?.length).toBe(2);
  });

  test('each engine has a level choice at Balanced, and the numbers sit in a second closed disclosure', async () => {
    const { sensitivity } = await table();
    const levels = sensitivity.slice(0, sensitivity.indexOf('id="wp-engine-evidence"'));
    expect(levels.match(/role="radiogroup"/g)?.length).toBe(SENSITIVITY_ENGINES.length);
    expect(levels.match(/value="balanced"[^>]*checked/g)?.length).toBe(SENSITIVITY_ENGINES.length);
    expect(levels.match(/value="(strict|relaxed)"[^>]*checked/g)).toBeNull();
    expect(levels).not.toContain('Custom:');
    expect(sensitivity).toMatch(/<button[^>]*aria-expanded="false"[^>]*aria-controls="wp-engine-evidence"/);
    expect(sensitivity).toMatch(/<div id="wp-engine-evidence"[^>]*hidden/);
  });

  test('the levels are the measured pairs, and any other pair is Custom', async () => {
    const pairs = (level: 'strict' | 'relaxed') => Object.fromEntries(SENSITIVITY_ENGINES.map((meta) => { const v = sensitivityValues(meta, level); return [meta.key, [v.block, v.soft]]; }));
    expect(pairs('strict')).toEqual({ sql: [3.2, 2], xss: [3, 1.8], cmd: [2.6, 1.3], php: [2.6, 1.3], python: [2.6, 1.3], lfi: [3.2, 1.2], ssrf: [2, 1.2], java: [2.6, 1.3], nosql: [2.4, 1.2], ssti: [2.4, 1.4], xxe: [2, 1.2], deser: [2, 1.2] });
    expect(pairs('relaxed')).toEqual({ sql: [5, 3.1], xss: [4.8, 2.8], cmd: [4, 2], php: [4, 2], python: [4, 2], lfi: [4, 1.9], ssrf: [3.1, 1.9], java: [4, 2], nosql: [3.8, 1.9], ssti: [3.8, 2.2], xxe: [3.1, 1.9], deser: [3.1, 1.9] });
    const sql = SENSITIVITY_ENGINES[0];
    expect(sensitivityLevelOf(sql, null, undefined)).toBe('balanced');
    expect(sensitivityLevelOf(sql, 3.2, 2)).toBe('strict');
    expect(sensitivityLevelOf(sql, 5, 3.1)).toBe('relaxed');
    expect(sensitivityLevelOf(sql, 3.5, 2.5)).toBe('custom');
    const { sensitivity } = await table({ semantic_policies: { sql: { block_threshold: 3.5, soft_threshold: 2.5 }, xss: { block_threshold: 3, soft_threshold: 1.8 } } });
    const levels = sensitivity.slice(0, sensitivity.indexOf('id="wp-engine-evidence"'));
    expect(text(levels)).toContain('Custom: block 3.5, soft 2.5');
    expect(levels.match(/value="strict"[^>]*checked/g)?.length).toBe(1);
    expect(levels.match(/value="balanced"[^>]*checked/g)?.length).toBe(SENSITIVITY_ENGINES.length - 2);
  });

  test('shows a stored value with a decimal point and counts the engines that differ', async () => {
    const { html, sensitivity } = await table({ semantic_policies: { sql: { block_threshold: 3.5, soft_threshold: 2.5 } } });
    expect(sensitivity).toMatch(/id="wp-semantic-sql-block"[^>]*value="3.5"/);
    expect(text(html)).toContain('1 engine changed');
  });

  test('reset puts every threshold back to its default and an empty field counts as the default', () => {
    const draft = draftFromRules({ semantic_policies: { sql: { block_threshold: 9, soft_threshold: 1 }, xss: { block_threshold: 2 } } });
    expect(customSensitivityCount(draft)).toBe(2);
    resetSensitivity(draft);
    expect(customSensitivityCount(draft)).toBe(0);
    expect(draft.semantic.sql).toMatchObject({ block: 4, soft: 2.5 });
    draft.semantic.sql.block = null;
    draft.semantic.sql.soft = null;
    expect(customSensitivityCount(draft)).toBe(0);
    const out = (saved(draft, {}).semantic_policies as Record<string, Json>).sql;
    expect(out).toMatchObject({ block_threshold: 4, soft_threshold: 2.5 });
  });

  test('a value that is not a number, out of range or a soft value above the block value is reported next to its field', () => {
    const draft = draftFromRules({});
    draft.semantic.sql.block = Number.NaN;
    draft.semantic.xss.block = 101;
    draft.semantic.cmd.block = 2;
    draft.semantic.cmd.soft = 3;
    const byPath = Object.fromEntries(validatePolicy(draft).map((issue) => [issue.path, issue]));
    expect(byPath['semantic.sql.block'].message).toBe('SQL injection: block threshold must be a number such as 2.5.');
    expect(byPath['semantic.xss.block'].message).toContain('between 0 and 100');
    expect(byPath['semantic.cmd.soft'].message).toContain('must not exceed');
    for (const issue of Object.values(byPath)) expect(issue.group).toBe('sensitivity');
    // Empty fields are the defaults.
    const empty = draftFromRules({});
    empty.semantic.sql.block = null;
    empty.semantic.sql.soft = null;
    expect(validatePolicy(empty)).toEqual([]);
  });

  test('on a rule path the same fields take a decimal point and the same checks', () => {
    const rule = pathRuleFromRaw({ path: '/a', match: 'prefix', semantic_override: { sql: { disabled: false, block_threshold: 4, soft_threshold: 2.5 } } });
    expect(validatePathRule(rule)).toEqual([]);
    rule.semanticOverride.sql!.block = Number.NaN;
    expect(validatePathRule(rule).map((issue) => [issue.path, issue.tab])).toEqual([['semanticOverride.sql.block', 'sensitivity']]);
  });
});

describe('sensitivity on a rule path', () => {
  const sql = SENSITIVITY_ENGINES[0];
  test('no entry follows the policy; a level gives the path its own values; Policy drops them', () => {
    const draft = draftFromRules({});
    const rule = pathRuleFromRaw({ path: '/a', match: 'prefix' });
    expect(pathSensitivityOf(rule, sql)).toBe('policy');
    setPathSensitivity(rule, draft, sql, 'strict');
    expect(rule.semanticOverride.sql).toMatchObject({ disabled: false, block: 3.2, soft: 2 });
    expect(pathSensitivityOf(rule, sql)).toBe('strict');
    setPathSensitivity(rule, draft, sql, 'custom');
    expect(pathSensitivityOf(rule, sql)).toBe('strict');
    setPathSensitivity(rule, draft, sql, 'policy');
    expect(rule.semanticOverride.sql).toBeUndefined();
  });

  test('a stored pair that is no level is Custom, and an entry that is off follows the policy', () => {
    const custom = pathRuleFromRaw({ path: '/a', match: 'prefix', semantic_override: { sql: { disabled: false, block_threshold: 3.5, soft_threshold: 2.5 } } });
    expect(pathSensitivityOf(custom, sql)).toBe('custom');
    const off = pathRuleFromRaw({ path: '/a', match: 'prefix', semantic_override: { sql: { disabled: true } } });
    expect(pathSensitivityOf(off, sql)).toBe('policy');
  });
});

describe('record weak detections', () => {
  test('is stored as record_weak_detections: absent reads as on, false as off', () => {
    expect(draftFromRules({}).engines.recordWeakDetections).toBe(true);
    expect(draftFromRules({ semantic_policies: { record_weak_detections: true } }).engines.recordWeakDetections).toBe(true);
    expect(draftFromRules({ semantic_policies: { record_weak_detections: false } }).engines.recordWeakDetections).toBe(false);
  });

  test('turning it off writes false, and turning it on again removes the key', () => {
    const rules = goDefaultRules();
    const draft = draftFromRules(rules);
    draft.engines.recordWeakDetections = false;
    expect((saved(draft, rules).semantic_policies as Json).record_weak_detections).toBe(false);
    const stored = saved(draft, rules);
    const back = draftFromRules(stored);
    expect(back.engines.recordWeakDetections).toBe(false);
    back.engines.recordWeakDetections = true;
    expect(saved(back, stored).semantic_policies).not.toHaveProperty('record_weak_detections');
    expect(saved(back, stored)).toEqual(rules);
  });

  test('a document of version 1 with the LOG score at or above the BLOCK score reads as off, and a save writes the key, not the scores', () => {
    for (const thresholds of [{ log: 150, block: 150 }, { log: 200, block: 180 }]) {
      const rules = { thresholds, future_top_level: { kept: true } };
      const draft = draftFromRules(rules);
      expect(draft.engines.recordWeakDetections).toBe(false);
      const out = saved(draft, rules);
      expect(out).not.toHaveProperty('thresholds');
      expect((out.semantic_policies as Json).record_weak_detections).toBe(false);
      expect(out.future_top_level).toEqual({ kept: true });
    }
    for (const thresholds of [{ log: 100, block: 180 }, { log: 20, block: 300 }, { log: 80, block: 150 }]) {
      const rules = { thresholds };
      expect(draftFromRules(rules).engines.recordWeakDetections).toBe(true);
      expect(saved(draftFromRules(rules), rules)).not.toHaveProperty('thresholds');
    }
  });

  test('the diff and the draft summary say recorded or not, never a score', async () => {
    const before = draftFromRules(goDefaultRules());
    const after = draftFromRules(goDefaultRules());
    after.engines.recordWeakDetections = false;
    expect(diffPolicy(before, after)).toEqual([expect.objectContaining({ label: 'Record weak detections', before: 'On', after: 'Off' })]);
    const form = WafPolicyForm.fromRules({ semantic_policies: { record_weak_detections: false } });
    const html = await render(PolicyIndex, { form, sections: [] });
    expect(text(html)).toContain('Weak detections Not recorded');
    expect(text(html)).not.toMatch(/LOG|BLOCK/);
  });

  test('the switch shows the state the document has, and the hint says what it does', async () => {
    const on = await render(ProtectionSection, { form: WafPolicyForm.fromRules({}) });
    expect(on).toMatch(/role="switch"[^>]*id="wp-engines-recordWeakDetections"[^>]*aria-checked="true"/);
    expect(text(on)).toContain('Record weak detections');
    expect(text(on)).toContain('Requests with a weaker sign of an attack are let through and recorded as LOG. Off: they are let through and recorded as a plain allowed request, without the detection.');
    const off = await render(ProtectionSection, { form: WafPolicyForm.fromRules({ semantic_policies: { record_weak_detections: false } }) });
    expect(off).toMatch(/role="switch"[^>]*id="wp-engines-recordWeakDetections"[^>]*aria-checked="false"/);
  });

  test('a read-only editor cannot flip it', async () => {
    const html = await render(ProtectionSection, { form: WafPolicyForm.fromRules({}), readonly: true });
    expect(html).toMatch(/role="switch"[^>]*id="wp-engines-recordWeakDetections"[^>]*disabled/);
  });

  test('the review drawer says nothing about decision scores, whatever scores a document of version 1 holds', async () => {
    const drawer = (rules: Json) => render(ReviewDrawer, { open: true, form: WafPolicyForm.fromRules(rules), onclose: () => {}, onsave: () => {}, ongoto: () => {} }).then(text);
    for (const rules of [{}, { thresholds: { log: 120, block: 150 } }, { thresholds: { log: 150, block: 150 } }, { thresholds: { log: 80, block: 200 } }]) {
      expect(await drawer(rules)).not.toMatch(/decision scores|custom decision/);
    }
  });
});

describe('what a save does with the scores of a document of version 1', () => {
  const stored = (): Json => ({
    thresholds: { log: 120, block: 180 },
    categories: {
      ProtocolAttack: { base_score: 90 }, LFI: { base_score: 181 }, RCE: { base_score: 201 }, PHP: { base_score: 191 }, SSRF: { base_score: 182 },
      Python: { base_score: 192 }, XSS: { base_score: 151 }, SQLi: { base_score: 183 }, Java: { base_score: 193 }
    },
    semantic_policies: {
      sql: { block_threshold: 3.5, soft_threshold: 2, base_score: 220 },
      xss: { block_threshold: 3.8, soft_threshold: 2.2, base_score: 0 },
      cmd: { block_threshold: 3.2, soft_threshold: 1.6 },
      nosql: { block_threshold: 3, soft_threshold: 1.5, base_score: 250 },
      ssti: { block_threshold: 3, soft_threshold: 1.8, base_score: 0 },
      xxe: { block_threshold: 2.5, soft_threshold: 1.5, base_score: 9999 },
      deser: { block_threshold: 2.5, soft_threshold: 1.5, base_score: 191 },
      ldap: { base_score: 90 },
      proto_pollution: { base_score: 95 },
      jwt: { base_score: 400 },
      graphql: { base_score: 0 }
    },
    path_exceptions: [
      {
        path: '/api',
        match: 'prefix',
        rule_override: { block_threshold: 300, log_threshold: 200, categories: { XSS: { base_score: 50 } }, future: true },
        semantic_override: { sql: { disabled: false, block_threshold: 5, soft_threshold: 3, base_score: 77 }, ldap: { disabled: false, base_score: 61 } }
      }
    ]
  });

  const baseScores = (value: unknown, path = ''): string[] => {
    if (!value || typeof value !== 'object') return [];
    return Object.entries(value).flatMap(([key, child]) => (key === 'base_score' ? [`${path}.${key}`] : baseScores(child, `${path}.${key}`)));
  };

  test('no threshold, category, base score or path override is written, and the other settings of the document stay', () => {
    const rules = stored();
    const out = saved(draftFromRules(rules), rules);
    expect(out).not.toHaveProperty('thresholds');
    expect(out).not.toHaveProperty('categories');
    expect(baseScores(out.semantic_policies)).toEqual([]);
    const path = (out.path_exceptions as Json[])[0];
    expect(path).not.toHaveProperty('rule_override');
    expect(path.semantic_override).toEqual({ sql: { disabled: false, block_threshold: 5, soft_threshold: 3 }, ldap: { disabled: false } });
    const sp = out.semantic_policies as Record<string, Json>;
    expect(sp.sql).toMatchObject({ block_threshold: 3.5, soft_threshold: 2 });
    expect(sp.nosql).toMatchObject({ block_threshold: 3, soft_threshold: 1.5 });
    expect(sp).not.toHaveProperty('ldap');
    expect(sp).not.toHaveProperty('proto_pollution');
    expect(sp).not.toHaveProperty('jwt');
  });

  test('a base score of 0 is an engine that stays off', () => {
    const rules = stored();
    const draft = draftFromRules(rules);
    for (const key of ['xss', 'ssti', 'graphql'] as const) expect(draft.semantic[key].enabled).toBe(false);
    for (const key of ['sql', 'nosql', 'xxe', 'deser', 'ldap', 'proto_pollution', 'jwt'] as const) expect(draft.semantic[key].enabled).toBe(true);
    const sp = saved(draft, rules).semantic_policies as Record<string, Json>;
    for (const key of ['xss', 'ssti', 'graphql']) expect(sp[key]).toMatchObject({ disabled: true });
  });

  test('so does a document with something else changed: an engine off, a switch, a flood limit, a rule path comment', () => {
    const rules = stored();
    const draft = draftFromRules(rules);
    setEngineAction('sql', draft.semantic.sql, 'off');
    setEngineAction('ldap', draft.semantic.ldap, 'off');
    draft.flood.enabled = true;
    draft.engines.scanAllHeaders = false;
    draft.pathRules[0].comment = 'changed';
    const out = saved(draft, rules);
    expect(baseScores(out.semantic_policies)).toEqual([]);
    expect((out.semantic_policies as Record<string, Json>).ldap).toEqual({ disabled: true });
    expect(out).not.toHaveProperty('thresholds');
  });

  test('the fully populated test document has no score to keep', () => {
    const rules = fullRules();
    expect(baseScores(rules)).toEqual(['.bot_protection.base_score']);
    const out = saved(draftFromRules(rules), rules);
    expect(out).not.toHaveProperty('thresholds');
    expect(out).not.toHaveProperty('categories');
    expect(baseScores(out)).toEqual(['.bot_protection.base_score']);
  });
});

describe('what the detection section no longer shows', () => {
  const gone = [
    'Base score', 'base score', 'Decision score', 'Decision scores', 'LOG from score', 'BLOCK from score',
    'Reset all scoring', 'scoring value', 'Advanced scoring', 'Custom scoring', 'recorded score only', 'Category scores', 'block score', 'LOG score', 'custom decision'
  ];

  test('the section, the engine table and the inspection options have none of those words', async () => {
    const html = await render(ProtectionSection, { form: WafPolicyForm.fromRules({ thresholds: { log: 120, block: 200 }, semantic_policies: { ldap: { base_score: 90 }, graphql: { base_score: 0 } } }) });
    expect(html).not.toContain('Its score is 0');
    const t = text(html);
    for (const word of gone) expect(t).not.toContain(word);
    expect(html).not.toMatch(/id="wp-(semantic-[a-z_]+-baseScore|categories-[A-Za-z]+-baseScore|thresholds-(block|log))"/);
    expect(html).not.toContain('Reset engines to defaults');
  });

  test('the path editor has no field for the LOG score of a path or for a base score', async () => {
    const source = await read('src/lib/components/waf-policy/PathRuleEditor.svelte');
    for (const word of ['LOG from score', 'Decision score', 'thresholdOverride', 'base score', 'Advanced scores']) expect(source).not.toContain(word);
    expect(source).toContain("sensitivity: 'Engine sensitivity'");
  });

  test('the files of the removed block are gone', async () => {
    expect(await Bun.file(new URL('../src/lib/components/waf-policy/AdvancedScoring.svelte', import.meta.url).pathname).exists()).toBe(false);
  });
});
