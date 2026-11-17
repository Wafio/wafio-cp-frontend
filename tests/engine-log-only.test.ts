// The Log only action of an engine: the stored `action` key on semantic_policies.<key> and on a path's
// semantic_override.<key>, the choices, the summaries and the decisions that name the engines that held a block back.
// The contract is the one of the control plane (wafio-cp-backend, api/openapi.yaml WafRulesSemanticPolicy) and the
// Rust agent (wafio-agent-waf, crates/engine-rules/src/config.rs): `action` is "block" or "log", absent means block,
// `disabled` wins over it, a path entry without `action` inherits the policy's, and a decision lists the keys whose block
// was held back as `engines_log_only`, taken from the `engine_log_only:<key>` marks of its coverage text.
import './support/runes';
import './support/ssr';
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { renderComponent } from './support/ssr';
import type { WAFDecisionRow } from '../src/lib/api';
import {
  ENGINE_LOG_ONLY_NOTE,
  LOG_ONLY_ENGINES,
  SEMANTIC_ENGINES,
  draftFromRules,
  engineActionLabel,
  engineActionOf,
  engineOptions,
  engineStateOf,
  enginesLogOnly,
  enginesLogOnlyLine,
  enginesOff,
  newPathRule,
  pathEnginesLogOnly,
  pathEnginesOff,
  pathHasOwnValues,
  pathRuleFromRaw,
  pathRuleToJson,
  rulesFromDraft,
  setEngineAction,
  setEngineState,
  setOwnValues,
  toJsonValue,
  type Json,
  type PolicyDraft,
  type SemanticKey
} from '../src/lib/components/waf-policy/model';
import { describePathRule, diffPolicy, enginesLogOnlySummary } from '../src/lib/components/waf-policy/review';
import {
  coverageLabel,
  enginesLogOnlyOf,
  enginesLogOnlyText,
  gapFlags,
  logOnlyNote
} from '../src/lib/components/apps/decision-format';
import { goDefaultRules, v1DefaultRules } from './support/waf-policy-fixtures';

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
const { default: PolicyIndex } = await import('../src/lib/components/waf-policy/PolicyIndex.svelte');
const { default: ReviewDrawer } = await import('../src/lib/components/waf-policy/ReviewDrawer.svelte');
const { default: DecisionDrawer } = await import('../src/lib/components/apps/DecisionDrawer.svelte');

const KEYS = SEMANTIC_ENGINES.map((meta) => meta.key);
const CAN_BLOCK = KEYS.filter((key) => !LOG_ONLY_ENGINES.includes(key));
const sp = (rules: Json) => rules.semantic_policies as Record<string, Json>;
const saveRules = (draft: PolicyDraft, original: Json = {}) => toJsonValue(rulesFromDraft(draft, original));
const render = (component: unknown, props: Record<string, unknown>) => renderComponent(component as never, props as never);

describe('the policy action', () => {
  test.each(KEYS)('%s: a stored action log reads as Log only (Log for open redirect) and is written back', (key) => {
    const rules = { semantic_policies: { [key]: { action: 'log' } } };
    const draft = draftFromRules(rules);
    expect(draft.semantic[key].enabled).toBe(true);
    expect(engineActionOf(key, draft.semantic[key])).toBe('log');
    expect(sp(saveRules(draft, rules))[key].action).toBe('log');
    expect(enginesLogOnly(draft).map((meta) => meta.key)).toEqual(key === 'open_redirect' ? [] : [key]);
  });

  test.each(CAN_BLOCK)('%s: Log only writes action log and no disabled flag, and Block removes it again', (key) => {
    const rules = goDefaultRules();
    const draft = draftFromRules(rules);
    setEngineAction(key, draft.semantic[key], 'log');
    const logged = saveRules(draft, rules);
    expect(sp(logged)[key].action).toBe('log');
    expect(sp(logged)[key].disabled).not.toBe(true);
    const back = draftFromRules(logged);
    expect(engineActionOf(key, back.semantic[key])).toBe('log');
    setEngineAction(key, back.semantic[key], 'block');
    expect(engineActionOf(key, back.semantic[key])).toBe('block');
    expect(sp(saveRules(back, logged))[key]).not.toHaveProperty('action');
  });

  test('a document that never named an action has none after a save, in the default document and in a version 1 document', () => {
    for (const rules of [{}, goDefaultRules(), v1DefaultRules()]) {
      const saved = sp(saveRules(draftFromRules(rules), rules));
      for (const key of KEYS) expect(saved[key] ?? {}).not.toHaveProperty('action');
    }
  });

  test('a stored block stays as it is while the engine is on, and a value that is neither block nor log is dropped', () => {
    const rules = { semantic_policies: { sql: { action: 'block' }, xss: { action: 'warn' }, jwt: { action: 'Log' }, anomaly: { action: 'block' } } };
    const draft = draftFromRules(rules);
    expect(KEYS.map((key) => engineActionOf(key, draft.semantic[key])).filter((action) => action === 'log')).toEqual(['log']); // open redirect only
    const saved = sp(saveRules(draft, rules));
    expect(saved.sql.action).toBe('block');
    expect(saved.anomaly.action).toBe('block');
    expect(saved.xss).not.toHaveProperty('action');
    expect(saved.jwt).not.toHaveProperty('action');
  });

  test('open redirect never blocks: its on choice is Log, it keeps a stored action untouched and never gets one', () => {
    const draft = draftFromRules({});
    expect(engineOptions('open_redirect').map((option) => option.label)).toEqual(['Log', 'Off']);
    setEngineAction('open_redirect', draft.semantic.open_redirect, 'log');
    expect(draft.semantic.open_redirect.action).toBeUndefined();
    expect(sp(saveRules(draft))).not.toHaveProperty('open_redirect');
    const rules = { semantic_policies: { open_redirect: { action: 'log' } } };
    expect(sp(saveRules(draftFromRules(rules), rules)).open_redirect).toEqual({ action: 'log' });
  });

  test('disabled wins: an engine that is off writes no new action, keeps the stored one, and a switch back to Block clears it', () => {
    const rules = goDefaultRules();
    const draft = draftFromRules(rules);
    setEngineAction('sql', draft.semantic.sql, 'log');
    setEngineAction('sql', draft.semantic.sql, 'off');
    expect(engineActionOf('sql', draft.semantic.sql)).toBe('off');
    const off = saveRules(draft, rules);
    expect(sp(off).sql.disabled).toBe(true);
    expect(sp(off).sql).not.toHaveProperty('action');
    // A stored document that has both reads as off and keeps both, the way the agent reads it.
    const both = { semantic_policies: { sql: { disabled: true, action: 'log' }, open_redirect: { disabled: true, action: 'log' } } };
    const stored = draftFromRules(both);
    expect(enginesOff(stored).map((meta) => meta.key)).toEqual(['sql', 'open_redirect']);
    expect(enginesLogOnly(stored)).toEqual([]);
    expect(sp(saveRules(stored, both)).sql).toMatchObject({ disabled: true, action: 'log' });
    setEngineAction('sql', stored.semantic.sql, 'block');
    expect(sp(saveRules(stored, both)).sql).toMatchObject({ disabled: false });
    expect(sp(saveRules(stored, both)).sql).not.toHaveProperty('action');
    // Off, then Log only, then Off again in one session leaves the engine off without an action that was never stored.
    const session = draftFromRules({});
    setEngineAction('xss', session.semantic.xss, 'log');
    setEngineAction('xss', session.semantic.xss, 'off');
    expect(sp(saveRules(session)).xss).toEqual({ disabled: true, block_threshold: 3.8, soft_threshold: 2.2 });
  });

  test('the keys that take only a switch carry the action and nothing else', () => {
    const draft = draftFromRules({});
    for (const key of ['header_injection', 'prompt_injection', 'anomaly', 'jwt', 'graphql', 'ldap', 'proto_pollution'] as SemanticKey[]) setEngineAction(key, draft.semantic[key], 'log');
    const saved = sp(saveRules(draft));
    // The flag that means "on" is left out when the document did not have it, so the entry is the action alone.
    expect(saved.header_injection).toEqual({ action: 'log' });
    expect(saved.prompt_injection).toEqual({ action: 'log' });
    expect(saved.anomaly).toEqual({ action: 'log' });
    for (const key of ['jwt', 'graphql', 'ldap', 'proto_pollution']) expect(saved[key]).toEqual({ action: 'log' });
    // They carry no threshold and no score.
    for (const key of ['header_injection', 'prompt_injection', 'anomaly', 'jwt', 'graphql', 'ldap', 'proto_pollution']) expect(Object.keys(saved[key])).toEqual(['action']);
  });

  test('a key outside the editor in the same entry survives, and so does the document around it', () => {
    const rules = { future: { kept: 1 }, semantic_policies: { sql: { action: 'log', future_key: 2, block_threshold: 3.5, soft_threshold: 2 } } };
    const saved = saveRules(draftFromRules(rules), rules);
    expect(saved.future).toEqual({ kept: 1 });
    expect(sp(saved).sql).toMatchObject({ action: 'log', future_key: 2, block_threshold: 3.5, soft_threshold: 2 });
  });

  test('the choice and its label come from one place', () => {
    const draft = draftFromRules({ semantic_policies: { sql: { action: 'log' }, xss: { disabled: true } } });
    expect(engineActionLabel('sql', draft.semantic.sql)).toBe('Log only');
    expect(engineActionLabel('xss', draft.semantic.xss)).toBe('Off');
    expect(engineActionLabel('cmd', draft.semantic.cmd)).toBe('Block');
    expect(engineActionLabel('open_redirect', draft.semantic.open_redirect)).toBe('Log');
  });
});

describe('the action of a rule path', () => {
  const policy = () => draftFromRules(goDefaultRules());
  const override = (rule: ReturnType<typeof newPathRule>, key: string) => (toJsonValue(pathRuleToJson(rule)).semantic_override as Record<string, Json> | undefined)?.[key];

  test('block and log write the action on an entry that is on, off writes only disabled, inherit removes the entry', () => {
    const rule = newPathRule();
    rule.path = '/a';
    const draft = policy();
    setEngineState(rule, draft, 'sql', 'log');
    expect(override(rule, 'sql')).toMatchObject({ disabled: false, action: 'log' });
    expect(engineStateOf(pathRuleFromRaw(toJsonValue(pathRuleToJson(rule))), 'sql', draft)).toBe('log');
    setEngineState(rule, draft, 'sql', 'block');
    expect(override(rule, 'sql')).toMatchObject({ disabled: false, action: 'block' });
    setEngineState(rule, draft, 'sql', 'off');
    expect(override(rule, 'sql').disabled).toBe(true);
    expect(override(rule, 'sql')).not.toHaveProperty('action');
    setEngineState(rule, draft, 'sql', 'inherit');
    expect(override(rule, 'sql')).toBeUndefined();
  });

  test('an entry that was stored off with an action reads as off and is saved without the action', () => {
    const rule = pathRuleFromRaw({ path: '/a', match: 'prefix', semantic_override: { sql: { disabled: true, action: 'log', block_threshold: 4, soft_threshold: 2.5 } } });
    expect(engineStateOf(rule, 'sql', policy())).toBe('off');
    expect(pathEnginesOff(rule)).toEqual(['sql']);
    expect(pathEnginesLogOnly(rule)).toEqual([]);
    expect(override(rule, 'sql')).toEqual({ disabled: true, block_threshold: 4, soft_threshold: 2.5 });
  });

  test('an entry that names no action inherits: it is Inherit against a policy that has the engine on, and the policy action against one that has it off', () => {
    const rule = pathRuleFromRaw({ path: '/a', match: 'prefix', semantic_override: { sql: { disabled: false, block_threshold: 4, soft_threshold: 2.5 } } });
    expect(engineStateOf(rule, 'sql', policy())).toBe('inherit');
    const off = draftFromRules({ semantic_policies: { sql: { disabled: true } } });
    expect(engineStateOf(rule, 'sql', off)).toBe('block');
    const offLog = draftFromRules({ semantic_policies: { sql: { disabled: true, action: 'log' } } });
    expect(engineStateOf(rule, 'sql', offLog)).toBe('log');
    const logging = draftFromRules({ semantic_policies: { sql: { action: 'log' } } });
    expect(engineStateOf(rule, 'sql', logging)).toBe('inherit');
    // Saved as it was: the entry names no action.
    expect(override(rule, 'sql')).not.toHaveProperty('action');
  });

  test('Block on a path against a policy that logs only is a choice of its own, stored as action block', () => {
    const logging = draftFromRules({ semantic_policies: { sql: { action: 'log' } } });
    const rule = newPathRule();
    rule.path = '/pay';
    setEngineState(rule, logging, 'sql', 'block');
    expect(engineStateOf(rule, 'sql', logging)).toBe('block');
    expect(override(rule, 'sql')).toMatchObject({ disabled: false, action: 'block' });
  });

  test('the entry carries the policy thresholds, so an action does not move them', () => {
    const draft = policy();
    draft.semantic.sql.block = 5;
    draft.semantic.sql.soft = 3;
    const rule = newPathRule();
    rule.path = '/a';
    setEngineState(rule, draft, 'sql', 'log');
    expect(override(rule, 'sql')).toEqual({ disabled: false, action: 'log', block_threshold: 5, soft_threshold: 3 });
  });

  test('open redirect on a path is on or off and never carries an action', () => {
    const off = draftFromRules({ semantic_policies: { open_redirect: { disabled: true } } });
    const rule = newPathRule();
    rule.path = '/a';
    setEngineState(rule, off, 'open_redirect', 'log');
    expect(override(rule, 'open_redirect')).toEqual({ disabled: false });
    const stored = pathRuleFromRaw({ path: '/a', match: 'prefix', semantic_override: { open_redirect: { disabled: false, action: 'log' } } });
    expect(pathEnginesLogOnly(stored)).toEqual([]);
    expect(override(stored, 'open_redirect')).toEqual({ disabled: false, action: 'log' });
  });

  test('Own values keep an entry that is on and names no action, and are locked while the path sets an action', () => {
    const rule = newPathRule();
    rule.path = '/a';
    const draft = policy();
    setOwnValues(rule, draft, 'sql', true);
    expect(rule.semanticOverride.sql).toEqual({ disabled: false, block: 4, soft: 2.5 });
    expect(pathHasOwnValues(rule, draft)).toBe(true);
    setOwnValues(rule, draft, 'sql', false);
    expect(rule.semanticOverride.sql).toBeUndefined();
    // A path that only sets Log only has no values of its own, until they differ from the policy's.
    setEngineState(rule, draft, 'sql', 'log');
    expect(pathHasOwnValues(rule, draft)).toBe(false);
    rule.semanticOverride.sql!.block = 6;
    expect(pathHasOwnValues(rule, draft)).toBe(true);
  });

  test('the engines a path holds on Log only are listed, in table order, and counted in its description', () => {
    const rule = pathRuleFromRaw({
      path: '/a',
      match: 'prefix',
      semantic_override: { xss: { disabled: false, action: 'log', block_threshold: 3.8, soft_threshold: 2.2 }, sql: { disabled: false, action: 'log', block_threshold: 4, soft_threshold: 2.5 }, php: { disabled: false, action: 'block', block_threshold: 3.2, soft_threshold: 1.6 } }
    });
    expect(pathEnginesLogOnly(rule)).toEqual(['sql', 'xss']);
    expect(describePathRule(rule)).toContain('2 engines log only');
    expect(describePathRule(pathRuleFromRaw({ path: '/b', match: 'prefix', semantic_override: { lfi: { disabled: false, action: 'log', block_threshold: 3.2, soft_threshold: 1.5 } } }))).toContain('1 engine log only');
  });
});

describe('the summaries', () => {
  test('the notice is one neutral line that names the engines', () => {
    const named = (...keys: string[]) => SEMANTIC_ENGINES.filter((meta) => keys.includes(meta.key));
    expect(enginesLogOnlyLine([])).toBe('');
    expect(enginesLogOnlyLine(named('sql'))).toBe('1 engine only logs: SQL injection.');
    expect(enginesLogOnlyLine(named('sql', 'xss'))).toBe('2 engines only log: SQL injection, Cross-site scripting.');
    expect(enginesLogOnlyLine(named('sql', 'jwt'), ' on this path')).toBe('2 engines only log on this path: SQL injection, JWT attacks.');
    expect(ENGINE_LOG_ONLY_NOTE).toBe('Detections are recorded as LOG and the request is let through.');
  });

  test('the review diff shows Block to Log only, Log only to Off and back, and the drawer summary names the engines', () => {
    const before = draftFromRules({});
    const after = draftFromRules({});
    setEngineAction('sql', after.semantic.sql, 'log');
    expect(diffPolicy(before, after)).toEqual([expect.objectContaining({ path: 'semantic.sql.enabled', label: 'SQL injection: engine', before: 'Block', after: 'Log only' })]);
    setEngineAction('sql', after.semantic.sql, 'off');
    expect(diffPolicy(before, after)).toEqual([expect.objectContaining({ before: 'Block', after: 'Off' })]);
    expect(diffPolicy(after, before)).toEqual([expect.objectContaining({ before: 'Off', after: 'Block' })]);
    expect(diffPolicy(draftFromRules({ semantic_policies: { sql: { action: 'log' } } }), after)).toEqual([expect.objectContaining({ before: 'Log only', after: 'Off' })]);
    const logging = draftFromRules({ semantic_policies: { sql: { action: 'log' }, xss: { action: 'log', disabled: true } }, path_exceptions: [{ path: '/api', match: 'prefix', semantic_override: { lfi: { disabled: false, action: 'log', block_threshold: 3.2, soft_threshold: 1.5 } } }] });
    expect(enginesLogOnlySummary(logging)).toEqual({ policy: ['SQL injection'], paths: [{ path: '/api', engines: ['Local file inclusion'] }] });
    expect(enginesLogOnlySummary(before)).toEqual({ policy: [], paths: [] });
  });

  test('changing the action of a path shows in the path diff', () => {
    const rules = { path_exceptions: [{ path: '/api', match: 'prefix' }] };
    const before = draftFromRules(rules);
    const after = draftFromRules(rules);
    setEngineState(after.pathRules[0], after, 'sql', 'log');
    expect(diffPolicy(before, after).find((c) => c.path === 'pathRules.0')?.note).toContain('engines log only');
    const same = draftFromRules(rules);
    expect(diffPolicy(before, same)).toEqual([]);
  });
});

describe('what the editor renders', () => {
  const radios = (html: string) => html.match(/<input[^>]*type="radio"[^>]*>/g) ?? [];

  test('the table offers Block, Log only and Off, and Log and Off for open redirect', async () => {
    const html = await render(EngineTable, { form: WafPolicyForm.fromRules({}) });
    const row = (key: string, next: string) => html.slice(html.indexOf(`id="wp-engine-${key}"`), html.indexOf(`id="wp-engine-${next}"`));
    const sql = row('sql', 'xss');
    expect(sql.match(/<input[^>]*type="radio"/g)).toHaveLength(3);
    for (const value of ['block', 'log', 'off']) expect(sql).toContain(`value="${value}"`);
    expect(sql).toContain('<span>Log only</span>');
    const redirect = row('open_redirect', 'prompt_injection');
    expect(redirect.match(/<input[^>]*type="radio"/g)).toHaveLength(2);
    expect(redirect).toContain('<span>Log</span>');
    expect(redirect).not.toContain('Log only');
    expect(html).not.toContain(ENGINE_LOG_ONLY_NOTE);
    expect(html).not.toContain('engines only log');
  });

  test('an engine on Log only is the chosen radio of its row, says what happens, and is named once in a neutral notice', async () => {
    const html = await render(EngineTable, { form: WafPolicyForm.fromRules({ semantic_policies: { sql: { action: 'log' }, jwt: { action: 'log' }, xss: { disabled: true } } }) });
    expect(html).toContain('2 engines only log: SQL injection, JWT attacks.');
    expect(html).toContain('1 engine is off: Cross-site scripting.');
    expect(html.split(ENGINE_LOG_ONLY_NOTE).length - 1).toBe(2);
    const sql = html.slice(html.indexOf('id="wp-engine-sql"'), html.indexOf('id="wp-engine-xss"'));
    expect(sql).toMatch(/value="log"[^>]*checked/);
    expect(sql).toContain(ENGINE_LOG_ONLY_NOTE);
    const xss = html.slice(html.indexOf('id="wp-engine-xss"'), html.indexOf('id="wp-engine-cmd"'));
    expect(xss).not.toContain(ENGINE_LOG_ONLY_NOTE);
    expect(html).not.toContain('engine only logs');
  });

  test('the path editor has four choices, shows the policy action, and a path on Log only says what happens', async () => {
    const policy = draftFromRules({ semantic_policies: { sql: { action: 'log' } } });
    const rule = pathRuleFromRaw({ path: '/a', match: 'prefix', semantic_override: { xss: { disabled: false, action: 'log', block_threshold: 3.8, soft_threshold: 2.2 } } });
    const html = await render(PathEngineSwitches, { rule, policy });
    const row = (key: string, next: string) => html.slice(html.indexOf(`id="pe-${key}"`), html.indexOf(`id="pe-${next}"`));
    const sql = row('sql', 'xss');
    expect(sql.match(/<input[^>]*type="radio"/g)).toHaveLength(4);
    // The policy already logs only, so Log only adds nothing there; Block and Off do.
    expect(sql).toMatch(/value="log"[^>]*disabled/);
    expect(sql).not.toMatch(/value="block"[^>]*disabled/);
    expect(sql).toMatch(/<td[^>]*>Log only<\/td>/);
    // On a narrow screen the cell says what it is before its value.
    expect(sql).toContain('data-label="In the policy"');
    const xss = row('xss', 'cmd');
    expect(xss).toMatch(/value="log"[^>]*checked/);
    expect(xss).toContain(ENGINE_LOG_ONLY_NOTE);
    expect(html).toContain('1 engine only logs on this path: Cross-site scripting.');
  });

  test('the rule paths list names the engines a path holds on Log only', async () => {
    const form = WafPolicyForm.fromRules({
      path_exceptions: [
        { path: '/a', match: 'prefix', semantic_override: { sql: { disabled: false, action: 'log', block_threshold: 4, soft_threshold: 2.5 } } },
        { path: '/b', match: 'exact' }
      ]
    });
    const html = await render(PathRulesSection, { form });
    expect(html).toContain('1 engine log only');
    expect(html).not.toContain('Own engine values');
  });

  test('the policy index counts the engines that only log, and the review drawer lists them', async () => {
    const form = WafPolicyForm.fromRules({
      semantic_policies: { ssti: { action: 'log' }, sql: { action: 'log' } },
      path_exceptions: [{ path: '/api', match: 'prefix', semantic_override: { lfi: { disabled: false, action: 'log', block_threshold: 3.2, soft_threshold: 1.5 } } }]
    });
    const index = await render(PolicyIndex, { form, sections: [] });
    expect(index).toMatch(/Engines log only<\/dt>\s*<dd[^>]*>2<\/dd>/);
    const drawer = await render(ReviewDrawer, { open: true, form, onclose: () => {}, onsave: () => {}, ongoto: () => {} });
    expect(drawer).toContain('Engines that only log');
    expect(drawer).toContain('Policy: SQL injection, Template injection (SSTI)');
    expect(drawer).toContain('/api');
    expect(drawer).toContain('Local file inclusion');
    expect(drawer).toContain('Their detections are recorded as LOG and the request is let through.');
    const plain = await render(ReviewDrawer, { open: true, form: WafPolicyForm.fromRules({}), onclose: () => {}, onsave: () => {}, ongoto: () => {} });
    expect(plain).not.toContain('Engines that only log');
  });
});

describe('the decisions', () => {
  const decision = (over: Partial<WAFDecisionRow> = {}): WAFDecisionRow => ({
    id: 9,
    agent_id: 'agent-1',
    app_id: 'app-1',
    host: 'shop.example.com',
    method: 'GET',
    uri: '/search?q=1%27+or+1%3D1',
    remote_addr: '203.0.113.9',
    country_code: 'NL',
    user_agent: 'curl/8',
    content_type: '',
    action: 'log',
    score: 150,
    categories: ['SQLi'],
    cwe: 'CWE-89',
    match_detail: "' or 1=1",
    analyze_method: 'semantic',
    body_size: 0,
    latency_us: 640,
    body_preview: '',
    event_time: '2026-11-15T10:00:00Z',
    recorded_at: '2026-11-15T10:00:01Z',
    match_source: 'query:q',
    coverage: '',
    status: 200,
    ...over
  });

  test('the engines come from engines_log_only, and from the marks of a coverage text that still carries them', () => {
    expect(enginesLogOnlyOf({ engines_log_only: ['sql'] })).toEqual(['sql']);
    expect(enginesLogOnlyOf({ coverage: 'body_binary,engine_log_only:xss', engines_log_only: [] })).toEqual(['xss']);
    expect(enginesLogOnlyOf({ coverage: 'engine_log_only:sql', engines_log_only: ['sql', 'jwt'] })).toEqual(['sql', 'jwt']);
    expect(enginesLogOnlyOf({ coverage: null, engines_log_only: null })).toEqual([]);
    expect(enginesLogOnlyOf({ coverage: 'body_binary' })).toEqual([]);
  });

  test('the marks are not gaps, and a mark that is left in the coverage text has a label', () => {
    expect(gapFlags('engine_log_only:sql,body_binary,engine_disabled:xss')).toEqual(['body_binary']);
    expect(gapFlags('coverage:engine_log_only:sql')).toEqual([]);
    expect(coverageLabel('engine_log_only:sql')).toBe('Log only: SQL injection');
    expect(coverageLabel('engine_log_only:some_new_engine')).toBe('Log only: some new engine');
    expect(enginesLogOnlyText(['sql', 'xss'])).toBe('Log only: SQL injection, XSS');
  });

  test('the sentence says the request would have been blocked with the engine on Block', () => {
    expect(logOnlyNote(['sql'])).toBe('The request would have been blocked if SQL injection were set to Block.');
    expect(logOnlyNote(['sql', 'xss'])).toBe('The request would have been blocked if these engines were set to Block.');
  });

  test('the drawer names the engine and says so, and a row without one does not', async () => {
    const html = await render(DecisionDrawer, { decision: decision({ engines_log_only: ['sql'] }), projectId: 'p1', appId: 'app-1', canConfigure: true, onclose: () => {} });
    expect(html).toMatch(/<dt[^>]*>Log only<\/dt>/);
    expect(html).toContain('SQL injection');
    expect(html).toContain('The request would have been blocked if SQL injection were set to Block.');
    expect(html).toContain('Complete');
    const plain = await render(DecisionDrawer, { decision: decision(), projectId: 'p1', appId: 'app-1', canConfigure: true, onclose: () => {} });
    expect(plain).not.toMatch(/<dt[^>]*>Log only<\/dt>/);
    expect(plain).not.toContain('would have been blocked');
    // A coverage text that carries the mark (a control plane without the field) shows the same line and no gap flag.
    const marked = await render(DecisionDrawer, { decision: decision({ coverage: 'engine_log_only:sql' }), projectId: 'p1', appId: 'app-1', canConfigure: true, onclose: () => {} });
    expect(marked).toContain('The request would have been blocked if SQL injection were set to Block.');
    expect(marked).toContain('Complete');
  });
});

describe('against the agent source, when its checkout is next to this repository', () => {
  const root = process.env.WAFIO_AGENT_DIR ?? new URL('../../wafio-agent-waf', import.meta.url).pathname;
  const config = `${root}/crates/engine-rules/src/config.rs`;
  const decisionSource = `${root}/crates/proxy/src/decision.rs`;
  const present = existsSync(config) && existsSync(decisionSource);

  test.skipIf(!present)('the action values and the coverage mark are the ones the agent reads and writes', () => {
    const source = readFileSync(config, 'utf8');
    expect(source).toContain('pub const ENGINE_ACTION_LOG: &str = "log";');
    expect(source).toContain('pub const ENGINE_ACTION_BLOCK: &str = "block";');
    const proxy = readFileSync(decisionSource, 'utf8');
    expect(proxy).toContain('("engine_log_only:", &verdict.engines_log_only)');
    // The key list of a path override is the twenty keys of the dashboard.
    const list = source.slice(source.indexOf('PATH_SEMANTIC_OVERRIDE_KEYS'));
    for (const key of KEYS) expect(list).toContain(`"${key}"`);
  });
});
