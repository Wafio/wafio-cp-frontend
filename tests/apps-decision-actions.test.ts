// Decision drawer actions: cURL, tuning-rule prefill, block IP.
import { describe, expect, test } from 'bun:test';
import type { WAFDecisionRow } from '../src/lib/api';
import {
  blockIpRuleBody,
  canTuneDecision,
  curlBodyTruncated,
  curlCommand,
  curlUnavailableReason,
  engineForCategory,
  isInspectionGap,
  isScriptIncomplete,
  shellQuote,
  TUNABLE_SEMANTIC_ENGINES,
  tuningDraftFromDecision,
  tuningRuleHref,
  tuningRuleSearch,
} from '../src/lib/components/apps/decision-actions';

function decision(over: Partial<WAFDecisionRow> = {}): WAFDecisionRow {
  return {
    id: 42,
    agent_id: 'ag',
    app_id: 'app-1',
    host: 'shop.example.com',
    method: 'POST',
    uri: '/search?q=%27+or+1%3D1',
    remote_addr: '203.0.113.9',
    country_code: 'NL',
    user_agent: 'curl/8',
    content_type: 'form',
    action: 'block',
    score: 180,
    categories: ['SQLi'],
    cwe: 'CWE-89',
    match_detail: "sql:tautology",
    analyze_method: 'semantic',
    body_size: 10,
    latency_us: 800,
    body_preview: "q=' or 1=1",
    event_time: '2026-09-27T10:00:00Z',
    recorded_at: '2026-09-27T10:00:01Z',
    match_source: 'query:q',
    request_headers: { 'User-Agent': 'curl/8', Host: 'shop.example.com', 'Content-Length': '12', Accept: '*/*' },
    coverage: '',
    ...over,
  };
}

describe('cURL', () => {
  test('shell quoting survives single quotes', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  test('builds a multi-line command without Host/Content-Length', () => {
    const cmd = curlCommand(decision());
    expect(cmd.split(' \\\n')).toEqual([
      "curl 'http://shop.example.com/search?q=%27+or+1%3D1'",
      "  -X 'POST'",
      "  -H 'Accept: */*'",
      "  -H 'User-Agent: curl/8'",
      `  --data-raw 'q='\\'' or 1=1'`,
    ]);
    expect(curlCommand(decision({ method: 'GET' }), { scheme: 'https' })).not.toContain('--data-raw');
    expect(curlCommand(decision({ method: 'GET' }), { scheme: 'https' })).toContain("'https://shop.example.com/search");
    expect(curlCommand(decision({ method: 'HEAD', request_headers: {} }))).toBe("curl 'http://shop.example.com/search?q=%27+or+1%3D1' \\\n  --head");
  });

  test('WebSocket and host-less decisions cannot be copied', () => {
    expect(curlUnavailableReason(decision({ method: 'WEBSOCKET' }))).toContain('WebSocket');
    expect(curlUnavailableReason(decision({ match_source: 'ws:text' }))).toContain('WebSocket');
    expect(curlUnavailableReason(decision({ host: '' }))).toContain('Host');
    expect(curlUnavailableReason(decision())).toBeNull();
  });

  test('flags a truncated body', () => {
    expect(curlBodyTruncated(decision({ body_size: 5000 }))).toBe(true);
    expect(curlBodyTruncated(decision())).toBe(false);
  });
});

describe('tuning draft', () => {
  test('categories and match detail map to engines', () => {
    expect(engineForCategory('SQLi')).toBe('sql');
    expect(engineForCategory('PrototypePollution')).toBe('proto_pollution');
    expect(engineForCategory('Deserialization')).toBe('deser');
    expect(engineForCategory('deser')).toBe('deser');
    expect(engineForCategory('RCE')).toBe('cmd');
    expect(engineForCategory('Scanner')).toBeNull();
    // The four detectors that take only a switch are skippable too.
    expect(engineForCategory('OpenRedirect')).toBe('open_redirect');
    expect(engineForCategory('PromptInjection')).toBe('prompt_injection');
    expect(engineForCategory('Anomaly')).toBe('anomaly');
    expect(engineForCategory('HeaderInjection')).toBe('header_injection');
    // The detectors the agent names JWT and GraphQL can be skipped.
    expect(engineForCategory('JWT')).toBe('jwt');
    expect(engineForCategory('GraphQL')).toBe('graphql');
  });

  test('every prefilled engine is one the backend accepts in skip_semantic', () => {
    const categories = ['SQLi', 'XSS', 'RCE', 'PHP', 'Python', 'LFI', 'SSRF', 'Java', 'LDAP', 'NoSQLi', 'SSTI', 'XXE', 'Deserialization', 'PrototypePollution', 'OpenRedirect', 'PromptInjection', 'Anomaly', 'HeaderInjection', 'JWT', 'GraphQL'];
    for (const category of categories) {
      const engine = engineForCategory(category);
      if (engine) expect(TUNABLE_SEMANTIC_ENGINES as readonly string[]).toContain(engine);
    }
    // Every category the agent names (see agent-labels.test.ts) that is a detector maps to an engine key.
    for (const category of categories) expect(engineForCategory(category)).not.toBeNull();
    const draft = tuningDraftFromDecision(decision({ match_detail: 'deser:java_gadget', categories: ['Deserialization', 'OpenRedirect'] }), 'app-1');
    expect(draft.skipSemantic).toEqual(['deser', 'open_redirect']);
    const scanner = tuningDraftFromDecision(decision({ match_detail: 'scanner_user_agent:sqlmap', categories: ['Anomaly'], analyze_method: 'semantic' }), 'app-1');
    expect(scanner.skipSemantic).toEqual(['anomaly']);
  });

  test('a decision prefills a skip of the engine it names, for the whole request', () => {
    const draft = tuningDraftFromDecision(decision(), 'app-1');
    expect(draft).toEqual({
      app: 'app-1',
      decision: '42',
      name: 'Tune sql on /search',
      path: '/search',
      method: 'POST',
      skipSemantic: ['sql'],
    });
  });

  test('a stored row of an older agent (rule_based) prefills the same engines as semantic', () => {
    const draft = tuningDraftFromDecision(decision({ analyze_method: 'rule_based', match_detail: '', categories: ['SQLi', 'XSS'] }), 'app-1');
    expect(draft.skipSemantic).toEqual(['sql', 'xss']);
  });

  test('a decision with no engine to name prefills no skip', () => {
    const draft = tuningDraftFromDecision(decision({ match_detail: 'Geo', categories: ['Geo'], analyze_method: 'geo' }), 'app-1');
    expect(draft.skipSemantic).toEqual([]);
    expect(draft.name).toBe('Tune detection on /search');
  });

  test('search string carries every field for Custom rules', () => {
    const draft = tuningDraftFromDecision(decision(), 'app-1');
    const p = new URLSearchParams(tuningRuleSearch(draft));
    expect(p.get('create')).toBe('tuning');
    expect(p.get('app')).toBe('app-1');
    expect(p.get('decision')).toBe('42');
    expect(p.get('skip_semantic')).toBe('sql');
    for (const key of ['target', 'engine', 'skip_crs']) expect(p.has(key)).toBe(false);
    expect(tuningRuleHref('/base', 'p 1', draft).startsWith('/base/projects/p%201/rules?create=tuning')).toBe(true);
  });

  test('only decisions that matched something can be tuned', () => {
    expect(canTuneDecision(decision())).toBe(true);
    expect(canTuneDecision(decision({ action: 'allow' }))).toBe(false);
    expect(canTuneDecision(decision({ action: 'log', score: 0, categories: null, match_detail: '' }))).toBe(false);
  });

  test('a row that only records an inspection gap is explained, not tunable', () => {
    const gap = decision({ action: 'log', score: 0, categories: null, match_detail: 'coverage:body_binary', coverage: 'body_binary' });
    expect(isInspectionGap(gap)).toBe(true);
    expect(canTuneDecision(gap)).toBe(false);
    // The note alone is enough when the coverage column is empty, and an empty category list is no category.
    expect(isInspectionGap(decision({ action: 'log', score: 0, categories: [], match_detail: 'coverage:field_cap', coverage: '' }))).toBe(true);
    // A match with a gap on top is still a match: it can be tuned.
    const matched = decision({ action: 'block', score: 180, categories: ['SQLi'], match_detail: 'sql:tautology; coverage:field_cap', coverage: 'field_cap' });
    expect(isInspectionGap(matched)).toBe(false);
    expect(canTuneDecision(matched)).toBe(true);
    // No coverage flag and no note: not a gap.
    expect(isInspectionGap(decision({ action: 'log', score: 0, categories: null, match_detail: 'ip_reputation', coverage: '' }))).toBe(false);
  });

  test('the marks of switched-off engines are not a gap, from a current or an older control plane', () => {
    // Current control plane: the marks are in engines_off, coverage has gap flags only.
    const current = decision({ action: 'allow', score: 0, categories: null, match_detail: '', coverage: '', engines_off: ['xss', 'sql'] });
    expect(isInspectionGap(current)).toBe(false);
    expect(canTuneDecision(current)).toBe(false);
    // Older control plane or old rows: the marks sit in coverage, and in the note of the match detail.
    const old = decision({ action: 'log', score: 0, categories: null, match_detail: 'coverage:engine_disabled:xss', coverage: 'engine_disabled:xss' });
    expect(isInspectionGap(old)).toBe(false);
    expect(isScriptIncomplete(old)).toBe(false);
    expect(canTuneDecision(old)).toBe(false);
    const noteOnly = decision({ action: 'log', score: 0, categories: [], match_detail: 'coverage:engine_disabled:xss,engine_disabled:sql', coverage: '' });
    expect(isInspectionGap(noteOnly)).toBe(false);
    expect(canTuneDecision(noteOnly)).toBe(false);
    // A real gap next to a mark is still a gap, and a match next to a mark can still be tuned.
    const both = decision({ action: 'log', score: 0, categories: null, match_detail: 'coverage:engine_disabled:xss,body_binary', coverage: 'engine_disabled:xss,body_binary' });
    expect(isInspectionGap(both)).toBe(true);
    const matched = decision({ action: 'block', score: 180, categories: ['SQLi'], match_detail: 'sql:tautology; coverage:engine_disabled:xss', coverage: 'engine_disabled:xss' });
    expect(isInspectionGap(matched)).toBe(false);
    expect(canTuneDecision(matched)).toBe(true);
    // engine_weakened keeps its meaning: it stays a gap flag.
    expect(isInspectionGap(decision({ action: 'log', score: 0, categories: null, match_detail: 'coverage:engine_weakened:sql', coverage: 'engine_weakened:sql' }))).toBe(true);
  });

  test('a script rule that did not finish is no inspection gap, and still nothing to tune', () => {
    const script = decision({ action: 'log', score: 0, categories: null, analyze_method: 'custom_rule', match_detail: 'coverage:script_timeout', coverage: 'script_timeout' });
    expect(isInspectionGap(script)).toBe(false);
    expect(isScriptIncomplete(script)).toBe(true);
    expect(canTuneDecision(script)).toBe(false);
    // The note alone is enough, and script_error counts the same.
    const note = decision({ action: 'log', score: 0, categories: null, match_detail: 'coverage:script_error', coverage: '' });
    expect(isInspectionGap(note)).toBe(false);
    expect(isScriptIncomplete(note)).toBe(true);
    expect(canTuneDecision(note)).toBe(false);
    // Body, header and budget flags stay a gap; next to a script flag the row is both.
    const both = decision({ action: 'log', score: 0, categories: null, match_detail: 'coverage:body_binary,script_timeout', coverage: 'body_binary,script_timeout' });
    expect(isInspectionGap(both)).toBe(true);
    expect(isScriptIncomplete(both)).toBe(true);
    expect(isScriptIncomplete(decision({ coverage: 'body_binary', match_detail: 'coverage:body_binary' }))).toBe(false);
    // A block that matched keeps its action and can be tuned, with the script flag on top.
    const blocked = decision({ action: 'block', score: 180, categories: ['SQLi'], match_detail: 'sql:tautology; coverage:script_timeout', coverage: 'script_timeout' });
    expect(isScriptIncomplete(blocked)).toBe(true);
    expect(canTuneDecision(blocked)).toBe(true);
  });
});

describe('block IP rule', () => {
  test('is an enabled GUI block rule on the client IP', () => {
    const body = blockIpRuleBody(' 203.0.113.9 ', decision());
    expect(body.mode).toBe('gui');
    expect(body.action).toBe('block');
    expect(body.enabled).toBe(true);
    expect(body.conditions).toEqual([{ field: 'ip', operator: 'equals', value: '203.0.113.9' }]);
    expect(body.name).toBe('Block 203.0.113.9');
    expect(body.description).toContain('decision #42');
    expect(blockIpRuleBody('1.2.3.4', decision({ id: 0 })).description).toContain('live decision');
  });
});
