import { describe, expect, test } from 'bun:test';
import './support/runes';
import {
  draftFromRules,
  rulesFromDraft,
  toJsonValue,
  pathRuleFromRaw,
  pathRuleToJson,
  semanticMeta,
  PATH_OVERRIDE_ENGINES,
  SEMANTIC_ENGINES,
  type Json
} from '../src/lib/components/waf-policy/model';
import { validatePathRule, validatePolicy } from '../src/lib/components/waf-policy/validate';

const sp = (rules: Json) => toJsonValue(rules).semantic_policies as Record<string, Json>;

describe('JWT and GraphQL rows', () => {
  test('absent = on, and the row takes only a switch', () => {
    const draft = draftFromRules({});
    expect(draft.semantic.jwt).toEqual({ enabled: true, block: null, soft: null });
    expect(draft.semantic.graphql).toEqual({ enabled: true, block: null, soft: null });
    expect(semanticMeta('jwt').switchOnly).toBe(true);
    expect(semanticMeta('graphql').switchOnly).toBe(true);
  });

  test('untouched detectors are not written; a stored switch round-trips', () => {
    expect(sp(rulesFromDraft(draftFromRules({}), {}))).not.toHaveProperty('jwt');
    const rules = { semantic_policies: { graphql: { disabled: true } } };
    const draft = draftFromRules(rules);
    expect(draft.semantic.graphql.enabled).toBe(false);
    expect(sp(rulesFromDraft(draft, rules)).graphql).toEqual({ disabled: true });
  });

  test('the base score of a version 1 document goes; a 0 is a detector that is off', () => {
    const rules = { semantic_policies: { jwt: { base_score: 400 }, graphql: { base_score: 0 } } };
    const draft = draftFromRules(rules);
    expect(draft.semantic.jwt.enabled).toBe(true);
    expect(draft.semantic.graphql.enabled).toBe(false);
    const out = sp(rulesFromDraft(draft, rules));
    expect(out).not.toHaveProperty('jwt');
    expect(out.graphql).toEqual({ disabled: true });
  });

  test('every semantic engine, detectors included, is a path override', () => {
    const keys = PATH_OVERRIDE_ENGINES.map((e) => e.key);
    expect(keys).toContain('jwt');
    expect(keys).toContain('graphql');
    expect(keys).toEqual(SEMANTIC_ENGINES.map((e) => e.key));
    const rule = pathRuleFromRaw({ path: '/a', semantic_override: { sql: { disabled: true } } });
    expect(rule.semanticOverride).not.toHaveProperty('jwt');
    expect(pathRuleToJson(rule).semantic_override).toEqual({ sql: { disabled: true, block_threshold: 4, soft_threshold: 2.5 } });
  });

  test('a path detector override is a switch; a stored base score of a version 1 document goes', () => {
    const rule = pathRuleFromRaw({ path: '/a', semantic_override: { jwt: { disabled: true }, graphql: { base_score: 50 }, ldap: { base_score: 0 } } });
    expect(rule.semanticOverride.jwt).toEqual({ disabled: true, block: null, soft: null });
    expect(rule.semanticOverride.graphql).toEqual({ disabled: false, block: null, soft: null });
    expect(rule.semanticOverride.ldap).toEqual({ disabled: true, block: null, soft: null });
    expect(toJsonValue(pathRuleToJson(rule).semantic_override as Json)).toEqual({
      jwt: { disabled: true },
      graphql: { disabled: false },
      ldap: { disabled: true }
    });
  });

  test('a stored path base score is not checked', () => {
    const draft = draftFromRules({ path_exceptions: [{ path: '/a', semantic_override: { jwt: { base_score: 10000 } } }] } as Json);
    expect(validatePathRule(draft.pathRules[0])).toEqual([]);
    expect(toJsonValue(pathRuleToJson(draft.pathRules[0])).semantic_override).toEqual({ jwt: { disabled: false } });
  });
});

describe('field rule source', () => {
  test('keeps every source the agent reads instead of widening it to any', () => {
    const rule = pathRuleFromRaw({
      path: '/a',
      field_rules: ['urlencoded', 'multipart', 'form', 'JSON', 'header'].map((source) => ({ field: 'f', source, action: 'mask' }))
    });
    expect(rule.fieldRules.map((fr) => fr.source)).toEqual(['urlencoded', 'multipart', 'form', 'body.json', 'header']);
    expect((pathRuleToJson(rule).field_rules as Json[]).map((fr) => (fr as { source: string }).source)).toEqual(['urlencoded', 'multipart', 'form', 'body.json', 'header']);
  });
});
