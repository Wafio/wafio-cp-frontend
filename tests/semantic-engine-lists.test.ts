import { describe, expect, test } from 'bun:test';
import './support/runes';
import { engineForCategory, TUNABLE_SEMANTIC_ENGINES } from '../src/lib/components/apps/decision-actions';
import { SEMANTIC_ENGINES as SKIP_SEMANTIC_ENGINES, SEMANTIC_ENGINE_LABELS, semanticEngineError, semanticEngineLabel } from '../src/lib/components/rules/registry';
import { PATH_OVERRIDE_ENGINES, SEMANTIC_ENGINES } from '../src/lib/components/waf-policy/model';

// The twenty keys of the agent (wafio-agent-waf:
// crates/engine-rules/src/config.rs PATH_SEMANTIC_OVERRIDE_KEYS and custom_rules_validate.rs
// SEMANTIC_ENGINE_KEY_NAMES). The control plane has to accept the same names in skip_semantic.
const SERVER_KEYS = [
  'sql', 'xss', 'cmd', 'php', 'python', 'lfi', 'ssrf', 'java', 'nosql', 'ssti',
  'xxe', 'deser', 'ldap', 'proto_pollution', 'jwt', 'graphql',
  'header_injection', 'open_redirect', 'prompt_injection', 'anomaly',
];

const sorted = (keys: readonly string[]) => [...keys].sort();

describe('semantic engine lists follow the server', () => {
  test('skip_semantic multiselect offers exactly the server keys, each labelled', () => {
    expect(sorted(SKIP_SEMANTIC_ENGINES)).toEqual(sorted(SERVER_KEYS));
    for (const key of SERVER_KEYS) {
      expect(semanticEngineError(key)).toBeNull();
      expect(SEMANTIC_ENGINE_LABELS[key]).toBeTruthy();
    }
    expect(semanticEngineLabel('jwt')).toBe('JWT attacks');
    expect(semanticEngineLabel('graphql')).toBe('GraphQL introspection and batch limit');
    expect(semanticEngineLabel('header_injection')).toBe('Header and line-break injection');
    expect(semanticEngineLabel('open_redirect')).toBe('Open redirect');
    expect(semanticEngineLabel('prompt_injection')).toBe('Prompt injection');
    expect(semanticEngineLabel('anomaly')).toBe('Anomalies and scanners');
  });

  test('tuning prefill engines are the server keys', () => {
    expect(sorted(TUNABLE_SEMANTIC_ENGINES)).toEqual(sorted(SERVER_KEYS));
  });

  test('JWT and GraphQL decision categories prefill their engine', () => {
    expect(engineForCategory('SEMANTIC_JWT')).toBe('jwt');
    expect(engineForCategory('semantic_graphql')).toBe('graphql');
    expect(engineForCategory('jwt')).toBe('jwt');
    expect(engineForCategory('GraphQL')).toBe('graphql');
  });

  test('path semantic_override covers every policy engine', () => {
    expect(PATH_OVERRIDE_ENGINES.map((e) => e.key)).toEqual(SEMANTIC_ENGINES.map((e) => e.key));
    expect(sorted(PATH_OVERRIDE_ENGINES.map((e) => e.key))).toEqual(sorted(SERVER_KEYS));
  });
});
