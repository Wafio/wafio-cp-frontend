// The category filter and the labels of the decision views list what the Rust WAF agent sends, and nothing else.
// The lists below are copied from the agent source (wafio-agent-waf, branch v2/engine-switches, commit f81cdb1, which
// adds the four detector switches to main 82f21f6); when the agent changes, copy the lists again and the tests say
// what the dashboard is missing or still shows.
import { describe, expect, test } from 'bun:test';
import {
  CATEGORY_OPTIONS,
  LABELED_ANALYZE_METHODS,
  LABELED_COVERAGE_FLAGS,
  analyzeMethodLabel,
  categoryOptions,
  coverageLabel,
  enginesOffOf,
  enginesOffText,
  gapFlags,
} from '../src/lib/components/apps/decision-format';
import { SEMANTIC_ENGINE_LABELS } from '../src/lib/components/rules/registry';

const sorted = (list: readonly string[]) => [...list].sort();

// Categories on a decision. Detection engines: crates/application/src/analyze.rs category_for_semantic_reason, plus
// the fallback "Semantic" of block_response_for_semantic_reason. The other stages: analyze.rs (block(...) calls,
// Malware, ContentScanIncomplete), crates/application/src/gui_rules.rs (CustomRule), login_protection.rs
// (LoginProtection), crates/proxy/src/pipeline.rs (ProtocolAttack for a bad path encoding, BotChallenge,
// IPReputation) and crates/proxy/src/websocket.rs (WebSocket).
const AGENT_CATEGORIES = [
  'SQLi', 'XSS', 'RCE', 'PHP', 'Python', 'LFI', 'SSRF', 'Java', 'LDAP', 'PrototypePollution', 'SSTI', 'XXE',
  'Deserialization', 'NoSQLi', 'OpenRedirect', 'HeaderInjection', 'PromptInjection', 'Anomaly', 'GraphQL', 'JWT', 'Semantic',
  'ProtocolAttack', 'BodyLimit', 'L7Flood', 'Policy', 'Geo', 'Bot', 'BotChallenge', 'IPReputation', 'Malware',
  'ContentScanIncomplete', 'CustomRule', 'LoginProtection', 'WebSocket',
];

// Categories the removed rule engine put on a decision. The agent never emits them, so the feed filter must not offer them.
const NEVER_EMITTED = ['RFI', 'Generic', 'Scanner', 'Method', 'Protocol', 'Multipart', 'SessionFixation'];

// Analyze methods: crates/domain/src/request.rs ANALYZE_METHOD_* (semantic, policy, geo, bot, body_limit, error,
// custom_rule, content_scan), crates/proxy/src/pipeline.rs (challenge_gate) and crates/proxy/src/websocket.rs
// (ws_origin_check, handshake, ws_frame_scan).
const AGENT_METHODS = [
  'semantic', 'policy', 'geo', 'bot', 'body_limit', 'error', 'custom_rule', 'content_scan',
  'challenge_gate', 'ws_origin_check', 'handshake', 'ws_frame_scan',
];

// Methods an older agent sent and stored rows still carry. The agent of this version never sends them.
const LEGACY_METHODS = ['rule_based', 'hybrid'];

// Coverage flags: crates/application/src/coverage.rs marker(), crates/domain/src/body_fields.rs (skipped "binary"),
// crates/domain/src/request.rs (body_scan_skipped values) and crates/engine-rules/src/custom_rules.rs
// (COVERAGE_FLAG_*). A body flag is "body_" plus a skipped value or a transport value.
const AGENT_PLAIN_FLAGS = [
  'truncated', 'field_cap', 'query_cap', 'body_binary', 'body_binary_text', 'body_decompress_limit', 'body_decompress_error',
  'body_decompress_budget', 'header_count', 'header_len', 'headers_unscanned', 'engine_panic', 'parse_budget', 'regex_budget',
  'script_timeout', 'script_error',
];
// Flags that carry a value: engine_disabled:<key> (keys: ENGINE_SET_KEYS of crates/engine-core/src/engine_activity.rs,
// fourteen engines and header_injection), engine_weakened:<key> (any of the twenty keys of
// crates/engine-rules/src/config.rs PATH_SEMANTIC_OVERRIDE_KEYS; jwt, graphql, open_redirect, prompt_injection and
// anomaly switch off without an engine_disabled mark) and body_content_encoding:<encoding>.
const AGENT_ENGINE_KEYS = ['sql', 'xss', 'cmd', 'php', 'python', 'lfi', 'ssrf', 'java', 'nosql', 'ssti', 'xxe', 'deser', 'ldap', 'proto_pollution', 'header_injection'];
const AGENT_ALL_KEYS = [...AGENT_ENGINE_KEYS.slice(0, 14), 'jwt', 'graphql', 'header_injection', 'open_redirect', 'prompt_injection', 'anomaly'];

// What the labels must never say: the agent has no rule engine of that kind.
const RULE_SET_WORDS = /crs|coraza|rule.?set|rule-based|rule based/i;

describe('category filter', () => {
  test('lists exactly the categories the agent can send', () => {
    expect(sorted(CATEGORY_OPTIONS)).toEqual(sorted(AGENT_CATEGORIES));
  });

  test('adds the categories that were missing and drops the ones the agent never sends', () => {
    for (const name of ['HeaderInjection', 'JWT', 'GraphQL']) expect(CATEGORY_OPTIONS).toContain(name);
    for (const name of NEVER_EMITTED) expect(CATEGORY_OPTIONS).not.toContain(name);
  });

  test('a category seen in the data (an older agent, a tuning rule id) still joins the list', () => {
    const options = categoryOptions(['Scanner', 'tuning_rule:12']);
    expect(options).toContain('Scanner');
    expect(options).toContain('tuning_rule:12');
    expect(options).toContain('SQLi');
  });
});

describe('analyze method labels', () => {
  test('every method the agent sends has a label of its own, and no other has one', () => {
    expect(sorted(LABELED_ANALYZE_METHODS)).toEqual(sorted(AGENT_METHODS));
  });

  test('the four that were missing', () => {
    expect(analyzeMethodLabel('error')).toBe('Error');
    expect(analyzeMethodLabel('handshake')).toBe('WebSocket handshake');
    expect(analyzeMethodLabel('ws_origin_check')).toBe('WebSocket origin check');
    expect(analyzeMethodLabel('ws_frame_scan')).toBe('WebSocket frame scan');
  });

  test('the values of an older agent and of stored rows read as Semantic', () => {
    for (const method of LEGACY_METHODS) {
      expect(LABELED_ANALYZE_METHODS).not.toContain(method);
      expect(analyzeMethodLabel(method)).toBe('Semantic');
    }
    expect(analyzeMethodLabel('semantic')).toBe('Semantic');
  });

  test('no label names the removed rule engine', () => {
    for (const method of [...AGENT_METHODS, ...LEGACY_METHODS]) expect(analyzeMethodLabel(method)).not.toMatch(RULE_SET_WORDS);
  });

  test('an unknown method is shown as text and an empty one as a dash', () => {
    expect(analyzeMethodLabel('some_new_stage')).toBe('some new stage');
    expect(analyzeMethodLabel('')).toBe('n/a');
    expect(analyzeMethodLabel(null)).toBe('n/a');
  });
});

describe('engines off', () => {
  test('engines_off lists the engines; the engine_disabled flags of older rows join them once', () => {
    expect(enginesOffOf({ coverage: '', engines_off: ['sql', 'xss'] })).toEqual(['sql', 'xss']);
    expect(enginesOffOf({ coverage: 'engine_disabled:sql,body_binary,engine_disabled:lfi' })).toEqual(['sql', 'lfi']);
    expect(enginesOffOf({ coverage: 'engine_disabled:sql', engines_off: ['sql', 'jwt'] })).toEqual(['sql', 'jwt']);
    expect(enginesOffOf({ coverage: null, engines_off: null })).toEqual([]);
    expect(enginesOffOf({ coverage: 'body_binary' })).toEqual([]);
  });

  test('the gap flags leave the marks out and keep every other flag', () => {
    expect(gapFlags('engine_disabled:sql,body_binary,engine_weakened:xss,engine_disabled:jwt')).toEqual(['body_binary', 'engine_weakened:xss']);
    expect(gapFlags('coverage:engine_disabled:sql')).toEqual([]);
    expect(gapFlags('')).toEqual([]);
  });

  test('the list of every key reads as engine names, header injection and the five detectors included', () => {
    expect(enginesOffText(['sql', 'xss'])).toBe('Engines off: SQL injection, XSS');
    for (const key of AGENT_ALL_KEYS) expect(enginesOffText([key])).toBe(`Engines off: ${SEMANTIC_ENGINE_LABELS[key]}`);
    expect(enginesOffText(['some_new_engine'])).toBe('Engines off: some new engine');
  });
});

describe('coverage flag labels', () => {
  test('every plain flag the agent sends has a label of its own, and no other has one', () => {
    expect(sorted(LABELED_COVERAGE_FLAGS)).toEqual(sorted(AGENT_PLAIN_FLAGS));
  });

  test('the flags that were missing or wrong', () => {
    expect(coverageLabel('engine_disabled:sql')).toBe('Engine off: SQL injection');
    expect(coverageLabel('engine_weakened:xss')).toBe('Engine weakened by tuning: XSS');
    expect(coverageLabel('regex_budget')).toBe('Regex time budget reached');
    expect(coverageLabel('script_timeout')).toBe('Script rule did not finish');
    expect(coverageLabel('script_error')).toBe('Script rule failed');
    // The binary-text flag is not "Body not decoded (binary text)": the text runs of the body were scanned.
    expect(coverageLabel('body_binary_text')).toBe('Binary body: only text runs scanned');
    expect(coverageLabel('body_content_encoding:zstd')).toBe('Body encoding not supported (zstd)');
  });

  test('every engine_disabled key has a name, header injection included', () => {
    for (const key of AGENT_ENGINE_KEYS) {
      expect(SEMANTIC_ENGINE_LABELS[key]).toBeTruthy();
      expect(coverageLabel(`engine_disabled:${key}`)).toBe(`Engine off: ${SEMANTIC_ENGINE_LABELS[key]}`);
    }
    expect(coverageLabel('engine_disabled:header_injection')).toBe('Engine off: Header and line-break injection');
  });

  test('every one of the twenty keys has a name for engine_weakened', () => {
    expect(AGENT_ALL_KEYS).toHaveLength(20);
    for (const key of AGENT_ALL_KEYS) {
      expect(SEMANTIC_ENGINE_LABELS[key]).toBeTruthy();
      expect(coverageLabel(`engine_weakened:${key}`)).toBe(`Engine weakened by tuning: ${SEMANTIC_ENGINE_LABELS[key]}`);
    }
  });

  test('no label names the removed rule engine', () => {
    const flags = [...AGENT_PLAIN_FLAGS, ...AGENT_ALL_KEYS.flatMap((key) => [`engine_disabled:${key}`, `engine_weakened:${key}`]), 'body_content_encoding:gzip'];
    for (const flag of flags) expect(coverageLabel(flag)).not.toMatch(RULE_SET_WORDS);
  });
});
