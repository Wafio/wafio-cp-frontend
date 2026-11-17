// Policy editor (scores of version 1, rule_override omission, save errors), viewer redaction,
// member errors, audit labels, listen-address conflicts, host stream cap
// and the Match & act stage text.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import './support/runes';
import { flushMicrotasks } from './support/runes';
import { goDefaultRules } from './support/waf-policy-fixtures';
import {
  draftFromRules,
  newPathRule,
  pathRuleFromRaw,
  pathRuleToJson,
  restrictsAccess,
  rulesFromDraft,
  toJsonValue,
  type Json
} from '../src/lib/components/waf-policy/model';
import { validatePathRule } from '../src/lib/components/waf-policy/validate';
import { policySaveError } from '../src/lib/components/waf-policy/save-errors';
import { HIDDEN_SECRET_TEXT, hasRedactedSecrets, isHiddenSecret } from '../src/lib/secret-redaction';
import { LAST_OWNER_MESSAGE, addMemberError, roleChangeError } from '../src/lib/member-errors';
import { PROJECT_AUDIT_CATEGORIES, auditActionLabel } from '../src/lib/audit-labels';
import { LISTEN_HOST_TAKEN_MESSAGE, APP_NAME_TAKEN_MESSAGE, appWriteErrorMessage } from '../src/lib/components/apps/route-errors';
import { RULE_STAGES, SCRIPT_SKIPPED_WHEN } from '../src/lib/components/rules/rule-stages';

const { createProjectEventStream, isStreamLimit, STREAM_LIMIT_MESSAGE, STREAM_LIMIT_RETRY_MS } = await import('../src/lib/sse');

describe('scores of version 1', () => {
  test('the default document holds no category, threshold or engine score', () => {
    const defaults = goDefaultRules();
    expect(defaults).not.toHaveProperty('categories');
    expect(defaults).not.toHaveProperty('thresholds');
    expect(JSON.stringify(defaults.semantic_policies)).not.toContain('base_score');
  });

  test('a base score of an engine is dropped whatever it holds, and a 0 is an engine that is off', () => {
    const rules = goDefaultRules();
    (rules.semantic_policies as Record<string, Json>).sql.base_score = 250;
    (rules.semantic_policies as Record<string, Json>).xss.base_score = 0;
    const draft = draftFromRules(rules);
    expect(draft.semantic.sql.enabled).toBe(true);
    expect(draft.semantic.xss.enabled).toBe(false);
    const sp = (toJsonValue(rulesFromDraft(draft, rules)) as Json).semantic_policies as Record<string, Json>;
    expect(sp.sql).toEqual({ block_threshold: 4, soft_threshold: 2.5 });
    expect(sp.xss).toMatchObject({ disabled: true });
    expect(JSON.stringify(sp)).not.toContain('base_score');
  });

  test('the editor has no field for rule_override: a stored one goes, and so does everything in it', () => {
    const raw = { path: '/api', match: 'prefix', rule_override: { block_threshold: 300, log_threshold: 200, categories: { SQLi: { base_score: 5 } }, future: true } };
    const rule = pathRuleFromRaw(raw);
    expect(rule).not.toHaveProperty('thresholdOverride');
    expect(toJsonValue(pathRuleToJson(rule))).toEqual({ path: '/api', match: 'prefix' });
  });

  test('a new rule path writes none, and a rule path without one gains none', () => {
    const rule = newPathRule();
    rule.path = '/api';
    expect('rule_override' in pathRuleToJson(rule)).toBe(false);
    expect('rule_override' in pathRuleToJson(pathRuleFromRaw({ path: '/api', match: 'prefix' }))).toBe(false);
  });

  test('a stored rule_override no longer makes the rule an exemption, because a save removes it', () => {
    const plain = pathRuleFromRaw({ path: '/login', match: 'prefix', rate_limit: { max_requests: 5, window_sec: 60 } });
    expect(restrictsAccess(plain)).toBe(true);
    const overridden = pathRuleFromRaw({ path: '/login', match: 'prefix', rate_limit: { max_requests: 5, window_sec: 60 }, rule_override: { block_threshold: 300 } });
    expect(restrictsAccess(overridden)).toBe(true);
  });

  test('the editor reports no problem for the scores a stored rule path holds', () => {
    const rule = pathRuleFromRaw({ path: '/api', match: 'prefix', rule_override: { log_threshold: 0 }, semantic_override: { ldap: { block_threshold: 99999 } } });
    expect(validatePathRule(rule)).toEqual([]);
  });
});

describe('policy save errors', () => {
  test('INVALID_RULES and RULES_JSON_REQUIRED show the server message under a title', () => {
    const invalid = policySaveError('rules_json: keys "Thresholds" and "thresholds" differ only in case', 'INVALID_RULES');
    expect(invalid.title).toMatch(/rejected/);
    expect(invalid.message).toContain('"Thresholds"');
    expect(policySaveError('rules_json is required', 'RULES_JSON_REQUIRED').title).toMatch(/not sent/);
    expect(policySaveError('', 'OTHER')).toEqual({ message: 'Could not save the policy. Your edits are kept; try again.', code: 'OTHER' });
  });
});

describe('viewer redaction', () => {
  test('a blank redacted secret that is configured shows as hidden', () => {
    expect(HIDDEN_SECRET_TEXT).toBe('Configured (hidden)');
    expect(isHiddenSecret(true, true, '')).toBe(true);
    expect(isHiddenSecret(true, false, '')).toBe(false);
    expect(isHiddenSecret(false, true, '')).toBe(false);
    expect(isHiddenSecret(true, true, 'typed')).toBe(false);
    expect(hasRedactedSecrets(null, { secrets_redacted: false }, { secrets_redacted: true })).toBe(true);
    expect(hasRedactedSecrets(undefined, {})).toBe(false);
  });
});

describe('member errors', () => {
  test('LAST_OWNER and USER_NOT_FOUND have their own messages', () => {
    expect(roleChangeError({ error: 'x', code: 'LAST_OWNER', status: 409 })).toEqual({ message: LAST_OWNER_MESSAGE, reload: true });
    expect(roleChangeError({ error: 'boom', status: 500 })).toEqual({ message: 'boom', reload: false });
    expect(roleChangeError({ code: 'MEMBER_NOT_FOUND', status: 404 }).reload).toBe(true);
    expect(addMemberError({ error: 'user not found', code: 'USER_NOT_FOUND', status: 404 })).toMatch(/no longer exists/);
    expect(addMemberError({ error: 'failed to add member', status: 500 })).toBe('failed to add member');
  });
});

describe('audit labels', () => {
  test('project and membership events are readable; unknown actions fall back to a sentence', () => {
    expect(auditActionLabel('user.login')).toBe('Signed in');
    expect(auditActionLabel('user.password_changed')).toBe('Changed password');
    expect(auditActionLabel('user.registered_by_invite')).toBe('Registered from an invitation');
    expect(auditActionLabel('member.joined_by_invite')).toBe('Joined from an invitation');
    expect(auditActionLabel('correlation.rule_created')).toBe('Created a correlation rule');
    expect(auditActionLabel('correlation.rule_updated')).toBe('Updated a correlation rule');
    expect(auditActionLabel('correlation.rule_deleted')).toBe('Deleted a correlation rule');
    expect(auditActionLabel('project.deleted')).toBe('Deleted the project');
    expect(auditActionLabel('widget.frobbed_twice')).toBe('Widget frobbed twice');
    expect(auditActionLabel('')).toBe('Unknown action');
  });

  test('correlation.* events are filtered under Runtime security', () => {
    const runtime = PROJECT_AUDIT_CATEGORIES.find((c) => c.id === 'runtime');
    expect(runtime?.action.split(',')).toContain('correlation.');
  });
});

describe('listen address conflicts', () => {
  test('LISTEN_HOST_TAKEN and CONFLICT are told apart', () => {
    expect(appWriteErrorMessage({ code: 'LISTEN_HOST_TAKEN', status: 409 }, 'fallback')).toBe(LISTEN_HOST_TAKEN_MESSAGE);
    expect(appWriteErrorMessage({ code: 'CONFLICT', status: 409 }, 'fallback')).toBe(APP_NAME_TAKEN_MESSAGE);
    expect(appWriteErrorMessage({ error: 'other', status: 400 }, 'fallback')).toBe('other');
    expect(appWriteErrorMessage(null, 'fallback')).toBe('fallback');
  });
});

describe('Match & act stage text', () => {
  test('only Allow and Block decide; Log and Challenge continue', () => {
    const text = RULE_STAGES.gui.effect;
    expect(text).toMatch(/Only Allow and Block decide on their own/);
    expect(text).toMatch(/Log records the match and the request continues/);
    expect(text).toMatch(/Challenge serves a browser challenge to the client even when the challenge trigger is "Only on bot detection", but only when the challenge is enabled for the application/);
    expect(text).toMatch(/Local clients .*good bots, non-browser clients and clients with a valid challenge cookie are not challenged; their request continues/);
    expect(SCRIPT_SKIPPED_WHEN).toMatch(/Allow or Block Match & act rule/);
  });
});

describe('host stream cap (429 STREAM_LIMIT)', () => {
  const originalFetch = globalThis.fetch;
  let urls: string[] = [];
  beforeEach(() => {
    urls = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      const body = url.endsWith('/stream-ticket')
        ? { status: 201, json: { ticket: 't', stream: 'host', expires_at: '2026-09-29T00:01:00Z', expires_in: 60 } }
        : { status: 429, json: { error: 'too many open host streams', code: 'STREAM_LIMIT' } };
      return new Response(JSON.stringify(body.json), { status: body.status, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('isStreamLimit matches only 429 + STREAM_LIMIT', () => {
    expect(isStreamLimit(429, 'STREAM_LIMIT')).toBe(true);
    expect(isStreamLimit(429, undefined)).toBe(false);
    expect(isStreamLimit(503, 'STREAM_LIMIT')).toBe(false);
    expect(STREAM_LIMIT_RETRY_MS).toBe(30_000);
  });

  test('reports the limit, keeps reconnecting and does not retry at once', async () => {
    const limits: string[] = [];
    const conn = createProjectEventStream({ projectId: 'p1', stream: 'host', events: {}, onLimit: (e) => limits.push(e.error) });
    for (let i = 0; i < 10; i++) {
      await flushMicrotasks();
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(conn.state).toBe('reconnecting');
    expect(limits).toEqual([STREAM_LIMIT_MESSAGE]);
    // One ticket + one stream request; the next attempt waits 30 s.
    expect(urls.filter((u) => u.endsWith('/stream-ticket'))).toHaveLength(1);
    conn.close();
  });
});
