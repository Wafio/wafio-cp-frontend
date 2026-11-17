// The decision drawer explains a coverage gap, a row that only records the gap has nothing to tune, and a script rule
// that did not finish is not called a gap.
import './support/runes';
import './support/ssr';
import { describe, expect, test } from 'bun:test';
import type { WAFDecisionRow } from '../src/lib/api';
import { coverageGapNote, inspectionGapNote, scriptIncompleteNote, statusLabel } from '../src/lib/components/apps/decision-format';
import { renderComponent } from './support/ssr';

// The UI barrel pulls in PageHeader, which reads `dev` from SvelteKit.
Bun.plugin({
  name: 'app-environment-stub',
  setup(build) {
    build.module('$app/env', () => ({ loader: 'object', exports: { dev: false, browser: false, building: false, version: 'test' } }));
  },
});

const { default: DecisionDrawer } = await import('../src/lib/components/apps/DecisionDrawer.svelte');

function decision(over: Partial<WAFDecisionRow> = {}): WAFDecisionRow {
  return {
    id: 7,
    agent_id: 'agent-1',
    app_id: 'app-1',
    host: 'shop.example.com',
    method: 'POST',
    uri: '/upload',
    remote_addr: '203.0.113.9',
    country_code: 'NL',
    user_agent: 'curl/8',
    content_type: 'application/octet-stream',
    action: 'log',
    score: 0,
    categories: null,
    cwe: '',
    match_detail: 'coverage:body_binary',
    analyze_method: 'semantic',
    body_size: 10,
    latency_us: 800,
    body_preview: '',
    event_time: '2026-11-15T10:00:00Z',
    recorded_at: '2026-11-15T10:00:01Z',
    match_source: '',
    coverage: 'body_binary',
    ...over,
  };
}

const render = (row: WAFDecisionRow) =>
  renderComponent(DecisionDrawer, { decision: row, projectId: 'p1', appId: 'app-1', canConfigure: true, onclose: () => {} } as never);

describe('texts', () => {
  test('a coverage gap says that part of the request was not inspected', () => {
    expect(coverageGapNote()).toBe('Part of this request was not analyzed, so that part was not inspected.');
  });

  test('a row that only records a gap says nothing matched', () => {
    expect(inspectionGapNote()).toContain('not because something matched');
    expect(inspectionGapNote()).toContain('nothing to tune');
  });

  test('no gap text names the removed rule engine or an engine kind', () => {
    for (const text of [coverageGapNote(), inspectionGapNote(), scriptIncompleteNote()]) {
      expect(text).not.toMatch(/crs|rule set|rule-based|semantic/i);
    }
  });
});

describe('status label', () => {
  test('a status from 100 to 599 shows as the code, anything else as Not recorded', () => {
    expect(statusLabel(403)).toBe('403');
    expect(statusLabel(502)).toBe('502');
    expect(statusLabel(200)).toBe('200');
    for (const value of [0, undefined, null, -1, 99, 600, 40.5, Number.NaN]) expect(statusLabel(value)).toBe('Not recorded');
  });
});

describe('decision drawer', () => {
  test('a gap row is explained and offers no tuning', async () => {
    const html = await render(decision());
    expect(html).toContain(inspectionGapNote());
    expect(html).toContain(coverageGapNote());
    expect(html).not.toContain('Tune false positive');
    // The other actions stay.
    expect(html).toContain('Block IP');
  });

  test('the method column reads the values of an older agent as Semantic', async () => {
    for (const analyze_method of ['rule_based', 'hybrid']) {
      const html = await render(decision({ analyze_method, action: 'block', score: 180, categories: ['SQLi'], match_detail: 'sql:tautology', coverage: '' }));
      expect(html).toMatch(/Detection method<\/dt><dd[^>]*>Semantic<\/dd>/);
      expect(html).not.toMatch(/CRS|rule set/i);
    }
  });

  // Stored rows keep the text of the agent that wrote them; both read as plain match detail and neither is a scan gap.
  test('the old and the new text of a partly inspected request show as they are', async () => {
    for (const match_detail of ['inspection_incomplete:rule_based_off', 'inspection_incomplete:partial_coverage']) {
      const html = await render(decision({ action: 'log', score: 0, categories: null, match_detail, coverage: '' }));
      expect(html).toContain(match_detail);
      expect(html).not.toContain('was not inspected');
    }
  });

  test('the engines the operator switched off are listed on their own and are not a scan gap', async () => {
    const html = await render(decision({ action: 'allow', score: 0, categories: null, match_detail: '', coverage: '', engines_off: ['sql', 'xss'] }));
    expect(html).toContain('Engines off');
    expect(html).toContain('SQL injection');
    expect(html).toContain('XSS');
    expect(html).toContain('Complete');
    expect(html).not.toContain('was not inspected');
    expect(html).not.toContain('Engine off:');
  });

  test('a row of an older control plane with the marks in coverage reads the same', async () => {
    const html = await render(decision({ action: 'log', score: 0, categories: null, match_detail: 'coverage:engine_disabled:sql', coverage: 'engine_disabled:sql' }));
    expect(html).toContain('Engines off');
    expect(html).toContain('SQL injection');
    expect(html).toContain('Complete');
    expect(html).not.toContain('not because something matched');
    expect(html).not.toContain('Tune false positive');
    // A real gap next to a mark is still shown as a gap, the mark is not one of its badges.
    const both = await render(decision({ coverage: 'engine_disabled:sql,body_binary', match_detail: 'coverage:engine_disabled:sql,body_binary' }));
    expect(both).toContain('Binary body not scanned');
    expect(both).toContain(coverageGapNote());
    expect(both).toContain('SQL injection');
    expect(both).not.toContain('Engine off:');
  });

  test('a decision without switched-off engines has no such line', async () => {
    const html = await render(decision({ coverage: 'body_binary', engines_off: [] }));
    expect(html).not.toContain('Engines off');
  });

  test('the response status shows as the code, and as Not recorded for 0, never as 0', async () => {
    for (const status of [403, 502]) {
      const html = await render(decision({ status }));
      expect(html).toMatch(new RegExp(`Response status</dt><dd[^>]*>${status}</dd>`));
      expect(html).not.toMatch(/Response status<\/dt><dd[^>]*>Not recorded/);
    }
    for (const over of [{ status: 0 }, {}] as Partial<WAFDecisionRow>[]) {
      const html = await render(decision(over));
      expect(html).toMatch(/Response status<\/dt><dd[^>]*>Not recorded<\/dd>/);
      expect(html).not.toMatch(/Response status<\/dt><dd[^>]*>0</);
    }
  });

  // The row every request produces on a Rust agent whose application has an enabled script rule and no script runner.
  const scriptRow = () => decision({ action: 'log', score: 0, categories: null, analyze_method: 'custom_rule', match_detail: 'coverage:script_timeout', coverage: 'script_timeout' });

  test('a script rule that did not finish is not called an inspection gap', async () => {
    const html = await render(scriptRow());
    expect(html).toContain(scriptIncompleteNote());
    expect(html).toContain('Script rule did not finish');
    expect(html).not.toContain('not because something matched');
    expect(html).not.toContain('was not inspected');
    expect(html).not.toContain('Tune false positive');
    expect(html).toContain('/projects/p1/rules');
    expect(html).toContain('Script rules');
  });

  test('a script flag next to a scan gap keeps both explanations', async () => {
    const html = await render(decision({ coverage: 'body_binary,script_error', match_detail: 'coverage:body_binary,script_error' }));
    expect(html).toContain(scriptIncompleteNote());
    expect(html).toContain(inspectionGapNote());
    expect(html).toContain(coverageGapNote());
  });

  test('a decision that matched something keeps the tuning action and has no gap explanation', async () => {
    const matched = decision({ action: 'block', score: 180, categories: ['SQLi'], match_detail: 'sql:tautology', coverage: '' });
    const html = await render(matched);
    expect(html).toContain('Tune false positive');
    expect(html).not.toContain('not because something matched');
  });
});
