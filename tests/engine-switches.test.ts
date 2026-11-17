// What each detection engine does: the stored key, the policy table, the per-path inherit / block / log only / off
// choice, the counts and the warnings. The keys are copied from the agent source (wafio-agent-waf, commit 7e3274b):
// crates/engine-rules/src/config.rs (SemanticPoliciesConfig::engine_policies and PATH_SEMANTIC_OVERRIDE_KEYS, 20 keys with
// a `disabled` flag and an `action`; the last four take only those two). The Log only action has its own file,
// engine-log-only.test.ts.
import './support/runes';
import './support/ssr';
import { describe, expect, test } from 'bun:test';
import { renderComponent } from './support/ssr';
import {
  ENGINE_ACTIONS,
  SEMANTIC_ENGINES,
  draftFromRules,
  engineActionOf,
  engineOffNote,
  engineOnAction,
  engineOptions,
  pathEngineOptions,
  engineStateOf,
  enginesOff,
  enginesOffLine,
  newPathRule,
  pathEnginesOff,
  pathRuleFromRaw,
  pathRuleToJson,
  rulesFromDraft,
  setEngineAction,
  setEngineState,
  toJsonValue,
  type EngineState,
  type Json,
  type PolicyDraft,
  type SemanticKey
} from '../src/lib/components/waf-policy/model';
import { describePathRule, diffPolicy, enginesOffSummary } from '../src/lib/components/waf-policy/review';
import { goDefaultRules } from './support/waf-policy-fixtures';

// The UI barrel pulls in PageHeader, which reads `dev` from SvelteKit.
Bun.plugin({
  name: 'app-environment-stub',
  setup(build) {
    build.module('$app/env', () => ({ loader: 'object', exports: { dev: false, browser: false, building: false, version: 'test' } }));
  }
});

const { WafPolicyForm } = await import('../src/lib/components/waf-policy/waf-policy-form.svelte');
const { default: EngineTable } = await import('../src/lib/components/waf-policy/EngineTable.svelte');
const { default: PathEngineSwitches } = await import('../src/lib/components/waf-policy/PathEngineSwitches.svelte');
const { default: PathRulesSection } = await import('../src/lib/components/waf-policy/PathRulesSection.svelte');
const { default: ProtectionSection } = await import('../src/lib/components/waf-policy/ProtectionSection.svelte');
const { default: ReviewDrawer } = await import('../src/lib/components/waf-policy/ReviewDrawer.svelte');

const AGENT_SWITCH_KEYS = [
  'sql', 'xss', 'cmd', 'php', 'python', 'lfi', 'ssrf', 'java', 'nosql', 'ssti', 'xxe', 'deser', 'ldap', 'proto_pollution', 'jwt', 'graphql',
  'header_injection', 'open_redirect', 'prompt_injection', 'anomaly'
];
// The keys that take only `disabled` and `action`: no thresholds, no base score.
const SWITCH_ONLY_KEYS = ['ldap', 'proto_pollution', 'jwt', 'graphql', 'header_injection', 'open_redirect', 'prompt_injection', 'anomaly'];

const sp = (rules: Json) => rules.semantic_policies as Record<string, Json>;
const saveRules = (draft: PolicyDraft, original: Json = {}) => toJsonValue(rulesFromDraft(draft, original));
const render = (component: unknown, props: Record<string, unknown>) => renderComponent(component as never, props as never);

describe('the engines that have a switch', () => {
  test('are exactly the keys the agent reads a disabled flag for', () => {
    expect(SEMANTIC_ENGINES.map((meta) => meta.key).sort()).toEqual([...AGENT_SWITCH_KEYS].sort());
  });

  test('the eight that take only a switch have no thresholds and no base score', () => {
    for (const key of SWITCH_ONLY_KEYS) {
      const meta = SEMANTIC_ENGINES.find((engine) => engine.key === key);
      expect(meta?.switchOnly).toBe(true);
    }
    expect(SEMANTIC_ENGINES.filter((meta) => meta.switchOnly).map((meta) => meta.key)).toEqual(SWITCH_ONLY_KEYS);
  });

  test('every engine says in one sentence what it finds, and the sentence does not repeat its name', () => {
    for (const meta of SEMANTIC_ENGINES) {
      expect(meta.summary.length).toBeGreaterThan(10);
      expect(meta.summary.endsWith('.')).toBe(true);
      expect(meta.summary.toLowerCase()).not.toContain(meta.label.toLowerCase());
    }
  });

  test('the warning is one short line that names the engines that are off', () => {
    const named = (...keys: string[]) => SEMANTIC_ENGINES.filter((meta) => keys.includes(meta.key));
    expect(enginesOffLine([])).toBe('');
    expect(enginesOffLine(named('sql'))).toBe('1 engine is off: SQL injection.');
    expect(enginesOffLine(named('xss', 'anomaly'))).toBe('2 engines are off: Cross-site scripting, Anomalies and scanners.');
    expect(enginesOffLine(named('sql', 'jwt'), ' on this path')).toBe('2 engines are off on this path: SQL injection, JWT attacks.');
  });

  test('the line under an engine that is off is one sentence; anomalies and prompt injection say what else happens', () => {
    const only = (key: string) => engineOffNote(SEMANTIC_ENGINES.find((meta) => meta.key === key)!);
    expect(only('sql')).toBe('Requests are not checked for this.');
    expect(only('anomaly')).toBe('Scanner User-Agents are no longer blocked, and the list of known query parameters keeps learning.');
    expect(only('prompt_injection')).toBe('Chat paths of language models are no longer blocked.');
    for (const meta of SEMANTIC_ENGINES) expect(engineOffNote(meta).match(/\./g)?.length).toBe(1);
  });
});

describe('what an engine does', () => {
  test('the policy table and the path editor take their choices from one list: Block, Log only and Off, with Inherit on a path', () => {
    expect(ENGINE_ACTIONS.map((action) => [action.value, action.label])).toEqual([['block', 'Block'], ['log', 'Log only'], ['off', 'Off']]);
    expect(engineOptions('sql').map((option) => option.label)).toEqual(['Block', 'Log only', 'Off']);
    expect(engineOptions('open_redirect').map((option) => option.label)).toEqual(['Log', 'Off']);
    expect(pathEngineOptions('sql').map((option) => option.label)).toEqual(['Inherit', 'Block', 'Log only', 'Off']);
    expect(pathEngineOptions('open_redirect').map((option) => option.label)).toEqual(['Inherit', 'Log', 'Off']);
  });

  test('Block is the engine on and Off is the engine off, both ways', () => {
    const draft = draftFromRules({});
    expect(engineActionOf('sql', draft.semantic.sql)).toBe('block');
    setEngineAction('sql', draft.semantic.sql, 'off');
    expect(draft.semantic.sql.enabled).toBe(false);
    expect(engineActionOf('sql', draft.semantic.sql)).toBe('off');
    // An engine that only logs reads as Log while it is on, and its stored key is the same flag.
    expect(engineActionOf('open_redirect', draft.semantic.open_redirect)).toBe('log');
    setEngineAction('sql', draft.semantic.sql, 'block');
    expect(draft.semantic.sql.enabled).toBe(true);
  });
});

describe('the policy switch', () => {
  test.each(AGENT_SWITCH_KEYS)('%s: stored disabled true reads as off, and off saves disabled true', (key) => {
    const rules = { semantic_policies: { [key]: { disabled: true } } };
    const draft = draftFromRules(rules);
    expect(draft.semantic[key as SemanticKey].enabled).toBe(false);
    expect(enginesOff(draft).map((meta) => meta.key)).toEqual([key]);
    expect(sp(saveRules(draft, rules))[key].disabled).toBe(true);
  });

  test('on reads from a missing key or disabled false, and on does not save disabled true', () => {
    const rules = { semantic_policies: { sql: { disabled: false }, xss: { block_threshold: 3.8, soft_threshold: 2.2 } } };
    const draft = draftFromRules(rules);
    expect(enginesOff(draft)).toEqual([]);
    const saved = sp(saveRules(draft, rules));
    for (const key of AGENT_SWITCH_KEYS) expect(saved[key]?.disabled).not.toBe(true);
  });

  test('switching an engine off and on again: the off flag is written, the on flag only where one is stored', () => {
    const rules = goDefaultRules();
    const draft = draftFromRules(rules);
    draft.semantic.php.enabled = false;
    expect(sp(saveRules(draft, rules)).php.disabled).toBe(true);
    // The stored document lacks the flag, and absent means on: switching back writes nothing.
    draft.semantic.php.enabled = true;
    expect(sp(saveRules(draft, rules)).php).not.toHaveProperty('disabled');
    const off = draftFromRules(rules);
    off.semantic.php.enabled = false;
    const storedOff = saveRules(off, rules);
    const on = draftFromRules(storedOff);
    expect(on.semantic.php.enabled).toBe(false);
    on.semantic.php.enabled = true;
    expect(sp(saveRules(on, storedOff)).php.disabled).toBe(false);
    // The detectors keep no entry while they are on and untouched.
    const untouched = sp(saveRules(draftFromRules(rules), rules));
    expect(untouched).not.toHaveProperty('jwt');
    expect(untouched).not.toHaveProperty('graphql');
    draft.semantic.jwt.enabled = false;
    expect(sp(saveRules(draft, rules)).jwt).toEqual({ disabled: true });
  });

  test('a base score of an engine or of its category, from a version 1 document, is not written back', () => {
    const rules = { categories: { SQLi: { base_score: 150 } }, semantic_policies: { sql: { block_threshold: 4, base_score: 220 } } };
    const draft = draftFromRules(rules);
    expect(draft.semantic.sql.enabled).toBe(true);
    const saved = saveRules(draft, rules);
    expect(saved).not.toHaveProperty('categories');
    expect(sp(saved).sql).not.toHaveProperty('base_score');
  });

  describe('the keys that take only a switch', () => {
    test.each(SWITCH_ONLY_KEYS)('%s: off writes only disabled true, on writes no key', (key) => {
      const draft = draftFromRules({});
      draft.semantic[key as SemanticKey].enabled = false;
      expect(sp(saveRules(draft))[key]).toEqual({ disabled: true });
      draft.semantic[key as SemanticKey].enabled = true;
      // A document that never named the key stays free of it: an agent older than the key refuses it.
      expect(sp(saveRules(draft))).not.toHaveProperty(key);
    });

    test('a stored entry is read, and turning it on again removes the key but keeps other entries of it', () => {
      const rules = { semantic_policies: { open_redirect: { disabled: true }, anomaly: { disabled: true, future: 1 } } };
      const draft = draftFromRules(rules);
      expect(enginesOff(draft).map((meta) => meta.key)).toEqual(['open_redirect', 'anomaly']);
      expect(sp(saveRules(draft, rules))).toMatchObject({ open_redirect: { disabled: true }, anomaly: { disabled: true, future: 1 } });
      draft.semantic.open_redirect.enabled = true;
      draft.semantic.anomaly.enabled = true;
      const saved = sp(saveRules(draft, rules));
      expect(saved).not.toHaveProperty('open_redirect');
      expect(saved.anomaly).toEqual({ disabled: false, future: 1 });
    });

    test('they never carry thresholds or a base score, whatever the draft holds', () => {
      const draft = draftFromRules({});
      for (const key of SWITCH_ONLY_KEYS) {
        draft.semantic[key as SemanticKey].enabled = false;
        draft.semantic[key as SemanticKey].block = 5;
      }
      for (const key of SWITCH_ONLY_KEYS) expect(sp(saveRules(draft))[key]).toEqual({ disabled: true });
    });

    test('on a rule path they are inherit, block or off with only the flag and the action', () => {
      for (const key of SWITCH_ONLY_KEYS) {
        const rule = newPathRule();
        rule.path = '/a';
        const draft = draftFromRules({});
        draft.semantic[key as SemanticKey].enabled = false;
        setEngineState(rule, draft, key as SemanticKey, engineOnAction(key as SemanticKey));
        // Open redirect never blocks, so its entry names no action; the others name the one chosen.
        const on = key === 'open_redirect' ? { disabled: false } : { disabled: false, action: 'block' };
        expect((toJsonValue(pathRuleToJson(rule)).semantic_override as Record<string, Json>)[key]).toEqual(on);
        setEngineState(rule, draft, key as SemanticKey, 'off');
        expect((toJsonValue(pathRuleToJson(rule)).semantic_override as Record<string, Json>)[key]).toEqual({ disabled: true });
        expect(engineStateOf(pathRuleFromRaw(toJsonValue(pathRuleToJson(rule))), key as SemanticKey, draft)).toBe('off');
      }
    });

    test('a skip list names all twenty, and a path skip of one counts as off', () => {
      const rule = pathRuleFromRaw({ path: '/a', match: 'prefix', tuning: { target: null, effect: { skip_semantic: ['anomaly', 'header_injection'] } } });
      expect(pathEnginesOff(rule)).toEqual(['header_injection', 'anomaly']);
    });
  });

  test('the review drawer lists engines that are off, and the diff shows the choice', () => {
    const rules = {};
    const before = draftFromRules(rules);
    const after = draftFromRules(rules);
    after.semantic.sql.enabled = false;
    expect(diffPolicy(before, after)).toEqual([expect.objectContaining({ path: 'semantic.sql.enabled', label: 'SQL injection: engine', before: 'Block', after: 'Off' })]);
    expect(enginesOffSummary(after)).toEqual({ policy: ['SQL injection'], paths: [] });
    expect(enginesOffSummary(before)).toEqual({ policy: [], paths: [] });
  });
});

describe('the switch of a rule path', () => {
  const policy = () => draftFromRules(goDefaultRules());

  test('absent is inherit, disabled true is off, an entry that is on and names no action does what the policy does', () => {
    const rule = pathRuleFromRaw({ path: '/a', match: 'prefix', semantic_override: { sql: { disabled: true }, xss: { disabled: false, block_threshold: 4, soft_threshold: 2 }, cmd: { disabled: false, action: 'block', block_threshold: 4, soft_threshold: 2 } } });
    const states: Record<string, EngineState> = {};
    for (const meta of SEMANTIC_ENGINES) states[meta.key] = engineStateOf(rule, meta.key, policy());
    expect(states.sql).toBe('off');
    expect(states.xss).toBe('inherit');
    expect(states.cmd).toBe('block');
    expect(states.php).toBe('inherit');
    expect(pathEnginesOff(rule)).toEqual(['sql']);
    // Against a policy that has the engine off, the same entry starts it.
    const off = policy();
    off.semantic.xss.enabled = false;
    expect(engineStateOf(rule, 'xss', off)).toBe('block');
  });

  test.each(SEMANTIC_ENGINES.map((meta) => meta.key))('%s: inherit, each on choice and off write the path key and read back', (key) => {
    // Against a policy that has the engine off, every choice reads back as it was set.
    const against = policy();
    against.semantic[key].enabled = false;
    for (const state of ['inherit', ...engineOptions(key).map((option) => option.value)] as const) {
      const rule = newPathRule();
      rule.path = '/a';
      setEngineState(rule, against, key, state);
      expect(engineStateOf(rule, key, against)).toBe(state);
      const saved = pathRuleToJson(rule);
      const override = (saved.semantic_override as Record<string, Json> | undefined)?.[key];
      if (state === 'inherit') expect(override).toBeUndefined();
      else expect(override?.disabled).toBe(state === 'off');
      if (state === 'block' || (state === 'log' && key !== 'open_redirect')) expect(override?.action).toBe(state);
      else expect(override).not.toHaveProperty('action');
      expect(engineStateOf(pathRuleFromRaw(saved), key, against)).toBe(state);
    }
  });

  test('an entry starts from the policy values, so a switch does not move thresholds', () => {
    const rule = newPathRule();
    rule.path = '/a';
    const draft = policy();
    draft.semantic.sql.block = 5;
    draft.semantic.sql.soft = 3;
    setEngineState(rule, draft, 'sql', 'off');
    expect(pathRuleToJson(rule).semantic_override).toEqual({ sql: { disabled: true, block_threshold: 5, soft_threshold: 3 } });
    setEngineState(rule, draft, 'sql', 'block');
    expect(rule.semanticOverride.sql).toEqual({ disabled: false, block: 5, soft: 3, action: 'block' });
    setEngineState(rule, draft, 'jwt', 'off');
    expect(pathRuleToJson(rule).semantic_override).toMatchObject({ jwt: { disabled: true } });
    expect((toJsonValue(pathRuleToJson(rule)).semantic_override as Record<string, Json>).jwt).toEqual({ disabled: true });
  });

  test('block starts an engine the policy has off', () => {
    const draft = policy();
    draft.semantic.xss.enabled = false;
    const rule = newPathRule();
    rule.path = '/editor';
    setEngineState(rule, draft, 'xss', 'block');
    expect((pathRuleToJson(rule).semantic_override as Record<string, Json>).xss.disabled).toBe(false);
  });

  test('a skip in the path tuning counts as off, and so does an override: the count is the union', () => {
    const rule = pathRuleFromRaw({
      path: '/a',
      match: 'prefix',
      semantic_override: { sql: { disabled: true, block_threshold: 4, soft_threshold: 2.5 }, php: { disabled: false, block_threshold: 3.2, soft_threshold: 1.6 } },
      tuning: { target: null, effect: { skip_semantic: ['php', 'xss'] } }
    });
    expect(pathEnginesOff(rule)).toEqual(['sql', 'xss', 'php']);
    expect(describePathRule(rule)).toContain('3 engines off');
    // Skipping every engine is inspection off, not a count.
    const all = pathRuleFromRaw({ path: '/b', match: 'prefix', tuning: { target: null, effect: { skip_semantic: ['*'] } } });
    expect(pathEnginesOff(all)).toEqual([]);
    expect(describePathRule(all)).toContain('inspection off');
  });

  test('the review summary names the engines off per path', () => {
    const draft = draftFromRules({ path_exceptions: [{ path: '/api', match: 'prefix', semantic_override: { lfi: { disabled: true, block_threshold: 3.2, soft_threshold: 1.5 } } }, { path: '/ok', match: 'exact' }] });
    expect(enginesOffSummary(draft)).toEqual({ policy: [], paths: [{ path: '/api', engines: ['Local file inclusion'] }] });
    const before = draftFromRules({});
    expect(diffPolicy(before, draft).find((c) => c.path === 'pathRules.0')?.note).toContain('1 engine off');
  });

  test('changing a path switch shows in the path diff', () => {
    const rules = { path_exceptions: [{ path: '/api', match: 'prefix' }] };
    const before = draftFromRules(rules);
    const after = draftFromRules(rules);
    setEngineState(after.pathRules[0], after, 'sql', 'off');
    expect(diffPolicy(before, after).find((c) => c.path === 'pathRules.0')?.note).toContain('engines off');
  });
});

describe('what the editor renders', () => {
  const radios = (html: string) => html.match(/<input[^>]*type="radio"[^>]*>/g) ?? [];

  test('the table has one row per engine of the twenty with its name, one sentence and a Block, Log only and Off choice', async () => {
    const html = await render(EngineTable, { form: WafPolicyForm.fromRules({}) });
    // The first table is the engine table; the sensitivity table follows it.
    const table = html.slice(html.indexOf('aria-label="Detection engines"'), html.indexOf('Engine sensitivity'));
    expect(table.match(/<tr/g)?.length).toBe(1 + SEMANTIC_ENGINES.length);
    expect(SEMANTIC_ENGINES).toHaveLength(20);
    for (const meta of SEMANTIC_ENGINES) {
      expect(table).toContain(`id="wp-engine-${meta.key}"`);
      expect(table).toContain(meta.summary);
      // The name appears once in its row: the sentence does not repeat it.
      expect(table.split(`>${meta.label}</span>`).length - 1).toBe(1);
    }
    // Open redirect never blocks: it has Log and Off, the others Block, Log only and Off.
    expect(radios(table)).toHaveLength(3 * (SEMANTIC_ENGINES.length - 1) + 2);
    for (const label of ['Block', 'Log only', 'Log', 'Off']) expect(table).toContain(`<span>${label}</span>`);
    expect(table).not.toContain('type="checkbox"');
    for (const key of SWITCH_ONLY_KEYS) expect(html).not.toMatch(new RegExp(`id="wp-semantic-${key}-(block|soft|baseScore)"`));
    expect(html).not.toContain('Base score');
    expect(html).not.toContain('Category scores');
  });

  test('the note under the table says what is always on in two sentences', async () => {
    const html = await render(EngineTable, { form: WafPolicyForm.fromRules({}) });
    expect(html).toContain('Request smuggling checks are always on. Invalid percent-encoding in a path is a route setting of the application.');
    expect(html).not.toContain('Open redirect, prompt injection and anomalies use built-in policies');
  });

  test('an engine that is off is marked in its row and named once in the warning line', async () => {
    const html = await render(EngineTable, { form: WafPolicyForm.fromRules({ semantic_policies: { sql: { disabled: true }, jwt: { disabled: true } } }) });
    expect(html).toContain('2 engines are off: SQL injection, JWT attacks.');
    expect(html).toContain('Requests are not checked for this.');
    expect(html.match(/No longer detected/g)).toBeNull();
    // Off is the chosen radio of its row and Block is the chosen one of the others.
    const sql = html.slice(html.indexOf('id="wp-engine-sql"'), html.indexOf('id="wp-engine-xss"'));
    expect(sql).toMatch(/value="off"[^>]*checked/);
    const xss = html.slice(html.indexOf('id="wp-engine-xss"'), html.indexOf('id="wp-engine-cmd"'));
    expect(xss).toMatch(/value="block"[^>]*checked/);
  });

  test('anomalies and prompt injection say what else happens while they are off', async () => {
    const html = await render(EngineTable, { form: WafPolicyForm.fromRules({ semantic_policies: { anomaly: { disabled: true }, prompt_injection: { disabled: true }, header_injection: { disabled: true } } }) });
    expect(html).toContain('3 engines are off: Header and line-break injection, Prompt injection, Anomalies and scanners.');
    expect(html.match(/Scanner User-Agents are no longer blocked, and the list of known query parameters keeps learning\./g)?.length).toBe(1);
    expect(html.match(/Chat paths of language models are no longer blocked\./g)?.length).toBe(1);
  });

  test('a read-only editor disables every choice', async () => {
    const html = await render(EngineTable, { form: WafPolicyForm.fromRules({}), readonly: true });
    for (const radio of radios(html.slice(0, html.indexOf('Engine sensitivity')))) expect(radio).toContain('disabled');
  });

  test('the detection section shows the table, the weak-detections switch and no decision scores', async () => {
    const html = await render(ProtectionSection, { form: WafPolicyForm.fromRules({ semantic_policies: { lfi: { disabled: true } } }) });
    expect(html).toContain('Detection engines');
    expect(html).toContain('1 engine is off: Local file inclusion.');
    expect(html).toContain('Record weak detections');
    expect(html).not.toContain('Decision score');
    expect(html).not.toContain('LOG from score');
    expect(html).not.toContain('BLOCK from score');
    expect(html).not.toContain('Advanced scoring');
  });

  test('the path choices: a row per engine with Inherit, Block, Log only and Off, and a warning for the ones off', async () => {
    const draft = draftFromRules({ semantic_policies: { xss: { disabled: true } } });
    const rule = pathRuleFromRaw({ path: '/a', match: 'prefix', semantic_override: { sql: { disabled: true, block_threshold: 4, soft_threshold: 2.5 } } });
    const html = await render(PathEngineSwitches, { rule, policy: draft });
    expect(html).toContain('Detection engines on this path');
    expect(html.match(/<tr/g)?.length).toBe(1 + SEMANTIC_ENGINES.length);
    for (const label of ['Inherit', 'Block', 'Log only', 'Log', 'Off']) expect(html).toContain(`<span>${label}</span>`);
    expect(html).not.toContain('<span>On</span>');
    expect(radios(html)).toHaveLength(4 * (SEMANTIC_ENGINES.length - 1) + 3);
    expect(html).toContain('1 engine is off on this path: SQL injection.');
    // Against a policy that has the engine on, "Block" is not offered; against one that has it off, it is.
    const xssRow = html.slice(html.indexOf('id="pe-xss"'), html.indexOf('id="pe-cmd"'));
    const sqlRow = html.slice(html.indexOf('id="pe-sql"'), html.indexOf('id="pe-xss"'));
    expect(xssRow).not.toMatch(/value="block"[^>]*disabled/);
    expect(sqlRow).toMatch(/value="block"[^>]*disabled/);
  });

  test('the path choices offer the four switch-only keys too', async () => {
    const rule = pathRuleFromRaw({ path: '/a', match: 'prefix', semantic_override: { anomaly: { disabled: true }, prompt_injection: { disabled: true } } });
    const html = await render(PathEngineSwitches, { rule, policy: draftFromRules({}) });
    for (const label of ['Header and line-break injection', 'Open redirect', 'Prompt injection', 'Anomalies and scanners']) expect(html).toContain(label);
    expect(html).toContain('2 engines are off on this path: Prompt injection, Anomalies and scanners.');
  });

  test('the paths list shows a count of engines off', async () => {
    const form = WafPolicyForm.fromRules({
      path_exceptions: [
        { path: '/a', match: 'prefix', semantic_override: { sql: { disabled: true, block_threshold: 4, soft_threshold: 2.5 } }, tuning: { target: null, effect: { skip_semantic: ['xss'] } } },
        { path: '/b', match: 'exact' }
      ]
    });
    const html = await render(PathRulesSection, { form });
    expect(html).toContain('2 engines off');
    expect(html.match(/engines? off/g)?.length).toBe(1);
  });

  test('the review drawer lists the engines that are off in the policy and on paths', async () => {
    const form = WafPolicyForm.fromRules({
      semantic_policies: { ssti: { disabled: true } },
      path_exceptions: [{ path: '/api', match: 'prefix', semantic_override: { lfi: { disabled: true, block_threshold: 3.2, soft_threshold: 1.5 } } }]
    });
    const html = await render(ReviewDrawer, { open: true, form, onclose: () => {}, onsave: () => {}, ongoto: () => {} });
    expect(html).toContain('Engines that are off');
    expect(html).toContain('Policy: Template injection (SSTI)');
    expect(html).toContain('/api');
    expect(html).toContain('Local file inclusion');
  });
});
