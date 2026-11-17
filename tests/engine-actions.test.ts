// What each detection engine can do, as the policy table and the path editor offer it. The list is read from the agent
// source, wafio-agent-waf:
//   crates/engine/src/fastscan.rs, scan_window: engine_result(true, ...) is a result that blocks, soft_score(...) a result
//     that only logs. Section 15 (open redirect) has no blocking result.
//   crates/application/src/analyze.rs: three engines whose fast scan only logs still block elsewhere: the GraphQL batch
//     over the limit ("GraphQL batch exceeds operation limit", ProtocolAttack), a scanner User-Agent (anomaly,
//     self_declared_probe, probe = true) and prompt injection on a chat path (is_llm_chat_path).
// When the agent checkout is next to this repository the test also reads those two files.
import './support/runes';
import './support/ssr';
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { renderComponent } from './support/ssr';
import {
  LOG_ONLY_ENGINES,
  SEMANTIC_ENGINES,
  draftFromRules,
  engineStateOf,
  newPathRule,
  pathRuleFromRaw,
  pathRuleToJson,
  setEngineState,
  toJsonValue,
  type SemanticKey
} from '../src/lib/components/waf-policy/model';

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

type Behaviour = 'blocks' | 'mixed' | 'logs';

// blocks: only blocking results. mixed: blocking results and results that only log. logs: results that only log.
const AGENT: Record<SemanticKey, Behaviour> = {
  sql: 'mixed', xss: 'mixed', cmd: 'mixed', php: 'mixed', python: 'mixed', lfi: 'mixed', ssrf: 'mixed', java: 'mixed',
  nosql: 'mixed', ssti: 'mixed', xxe: 'mixed', deser: 'mixed', ldap: 'mixed', proto_pollution: 'mixed',
  jwt: 'blocks',
  graphql: 'mixed', // introspection logs; a batch over the limit blocks
  header_injection: 'mixed', // a mail or cache command behind a line break blocks; a plain header line logs
  open_redirect: 'logs',
  prompt_injection: 'mixed', // blocks on a chat path; logs elsewhere
  anomaly: 'mixed' // a scanner User-Agent blocks; control characters, odd long values and unseen parameters log
};

const render = (component: unknown, props: Record<string, unknown>) => renderComponent(component as never, props as never);

describe('the engines that can block', () => {
  test('the dashboard names every engine of the agent and only open redirect is log only', () => {
    expect(SEMANTIC_ENGINES.map((meta) => meta.key).sort()).toEqual(Object.keys(AGENT).sort());
    const logs = (Object.keys(AGENT) as SemanticKey[]).filter((key) => AGENT[key] === 'logs');
    expect([...LOG_ONLY_ENGINES]).toEqual(logs);
    expect(logs).toEqual(['open_redirect']);
  });

  test('an engine that can block offers Block and Log only and one that only logs offers Log, in the table and on a path', async () => {
    const html = await render(EngineTable, { form: WafPolicyForm.fromRules({}) });
    const row = (key: string, next: string) => html.slice(html.indexOf(`id="wp-engine-${key}"`), html.indexOf(`id="wp-engine-${next}"`));
    expect(row('open_redirect', 'prompt_injection')).toMatch(/value="log"/);
    expect(row('open_redirect', 'prompt_injection')).not.toMatch(/value="block"/);
    expect(row('open_redirect', 'prompt_injection')).toContain('<span>Log</span>');
    expect(row('graphql', 'header_injection')).toMatch(/value="block"/);
    expect(row('jwt', 'graphql')).toMatch(/value="block"/);
    const path = await render(PathEngineSwitches, { rule: newPathRule(), policy: draftFromRules({}) });
    const pathRow = (key: string, next: string) => path.slice(path.indexOf(`id="pe-${key}"`), path.indexOf(`id="pe-${next}"`));
    expect(pathRow('open_redirect', 'prompt_injection')).toMatch(/value="log"/);
    expect(pathRow('open_redirect', 'prompt_injection')).not.toMatch(/value="block"/);
    expect(pathRow('sql', 'xss')).toMatch(/value="block"/);
  });

  test('a mixed engine whose detections mostly only log says so in its sentence, and open redirect says it never blocks', () => {
    const summary = (key: SemanticKey) => SEMANTIC_ENGINES.find((meta) => meta.key === key)!.summary;
    for (const key of ['graphql', 'header_injection', 'prompt_injection', 'anomaly'] as SemanticKey[]) expect(summary(key)).toMatch(/only logged/);
    expect(summary('open_redirect')).toContain('never blocks');
    expect(summary('prompt_injection')).toContain('chat paths');
    expect(summary('graphql')).toContain('batch over the operation limit');
    expect(summary('anomaly')).toContain('scanner User-Agents');
  });

  test('the line under an engine that is off says what stops, for blocks and for logs', () => {
    const note = (key: SemanticKey) => SEMANTIC_ENGINES.find((meta) => meta.key === key)!.offNote;
    expect(note('open_redirect')).toBe('Open redirects are no longer logged.');
    expect(note('graphql')).toContain('no longer blocked');
    expect(note('graphql')).toContain('no longer logged');
    expect(note('anomaly')).toContain('Scanner User-Agents are no longer blocked');
  });

  test('on a rule path the on choice of a log-only engine is Log, stored as the same disabled flag', () => {
    const rule = newPathRule();
    rule.path = '/a';
    const policy = draftFromRules({ semantic_policies: { open_redirect: { disabled: true } } });
    setEngineState(rule, policy, 'open_redirect', 'log');
    expect(engineStateOf(rule, 'open_redirect', policy)).toBe('log');
    const saved = toJsonValue(pathRuleToJson(rule));
    expect((saved.semantic_override as Record<string, unknown>).open_redirect).toEqual({ disabled: false });
    expect(engineStateOf(pathRuleFromRaw(saved), 'open_redirect', policy)).toBe('log');
    setEngineState(rule, policy, 'open_redirect', 'off');
    expect(engineStateOf(rule, 'open_redirect', policy)).toBe('off');
  });
});

describe('against the agent source, when its checkout is next to this repository', () => {
  const root = process.env.WAFIO_AGENT_DIR ?? new URL('../../wafio-agent-waf', import.meta.url).pathname;
  const fastscan = `${root}/crates/engine/src/fastscan.rs`;
  const analyze = `${root}/crates/application/src/analyze.rs`;
  const present = existsSync(fastscan) && existsSync(analyze);

  test.skipIf(!present)('only the engines the table calls log only or mixed lack a blocking result in the fast scan, and analyze.rs blocks for the mixed ones', () => {
    const source = readFileSync(fastscan, 'utf8');
    const body = source.slice(source.indexOf('pub(crate) fn scan_window'), source.indexOf('// ── Gates'));
    const sections = body.split(/\n    \/\/ (\d+[a-z]?\)[^\n]*)/);
    const KEY: [RegExp, SemanticKey][] = [
      [/^\d+\) SQL/, 'sql'], [/^\d+\) XSS/, 'xss'], [/^\d+\) CMD/, 'cmd'], [/^\d+\) PHP/, 'php'], [/^\d+\) Python/, 'python'],
      [/^\d+\) LFI/, 'lfi'], [/^\d+\) SSRF/, 'ssrf'], [/^\d+\) Java/, 'java'], [/^\d+\) NoSQL/, 'nosql'], [/^\d+\) LDAP/, 'ldap'],
      [/^\d+\) Prototype/, 'proto_pollution'], [/^\d+\) SSTI/, 'ssti'], [/^\d+\) XXE/, 'xxe'], [/^\d+\) Deserialization/, 'deser'],
      [/^\d+\) Open redirect/, 'open_redirect'], [/^\d+\) Prompt injection/, 'prompt_injection'], [/^\d+b\) JWT/, 'jwt'],
      [/^\d+\) Heuristic anomaly/, 'anomaly'], [/^\d+b\) GraphQL/, 'graphql'], [/^\d+\) Header/, 'header_injection']
    ];
    const withoutBlock: SemanticKey[] = [];
    for (let i = 1; i < sections.length; i += 2) {
      const key = KEY.find(([pattern]) => pattern.test(sections[i]))?.[1];
      expect(key).toBeDefined();
      if (!/engine_result\(\s*true/.test(sections[i + 1])) withoutBlock.push(key!);
    }
    expect(withoutBlock.sort()).toEqual(['anomaly', 'graphql', 'open_redirect', 'prompt_injection']);
    const analysis = readFileSync(analyze, 'utf8');
    expect(analysis).toContain('GraphQL batch exceeds operation limit');
    expect(analysis).toContain('scanner_user_agent:');
    expect(analysis).toMatch(/REASON_SEMANTIC_PROMPT_INJECTION\s*&&\s*\(is_llm_chat_path/);
    // The engines without a blocking fast-scan result that block elsewhere are exactly the mixed ones of that list.
    const logOnly = withoutBlock.filter((key) => !['anomaly', 'graphql', 'prompt_injection'].includes(key));
    expect(logOnly).toEqual([...LOG_ONLY_ENGINES]);
  });
});
