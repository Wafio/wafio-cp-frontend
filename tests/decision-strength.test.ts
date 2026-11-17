// The decision feed and the decision drawer show how strong the detection behind a decision was ("Block" or "Weak"),
// not a score. The control plane derives it; the dashboard only names it.
import './support/runes';
import './support/ssr';
import { describe, expect, test } from 'bun:test';
import type { WAFDecisionRow } from '../src/lib/api';
import { strengthLabel } from '../src/lib/components/apps/decision-format';
import { strengthTone } from '../src/lib/tone';
import { renderComponent } from './support/ssr';

// The UI barrel pulls in PageHeader, which reads `dev` from SvelteKit.
Bun.plugin({
  name: 'app-environment-stub',
  setup(build) {
    build.module('$app/env', () => ({ loader: 'object', exports: { dev: false, browser: false, building: false, version: 'test' } }));
  },
});

const { default: DecisionDrawer } = await import('../src/lib/components/apps/DecisionDrawer.svelte');
const text = (html: string) => html.replace(/<!--.*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const read = (path: string) => Bun.file(new URL(`../${path}`, import.meta.url).pathname).text();

function decision(over: Partial<WAFDecisionRow> = {}): WAFDecisionRow {
  return {
    id: 7, agent_id: 'agent-1', app_id: 'app-1', host: 'shop.example.com', method: 'GET', uri: '/search?q=1', remote_addr: '203.0.113.9', country_code: 'NL',
    user_agent: 'curl/8', content_type: '', action: 'block', score: 180, categories: ['SQLi'], cwe: 'CWE-89', match_detail: 'sql:tautology',
    analyze_method: 'semantic', body_size: 0, latency_us: 800, body_preview: '', event_time: '2026-11-15T10:00:00Z', recorded_at: '2026-11-15T10:00:01Z',
    match_source: 'query:q', coverage: '', strength: 'block', ...over
  };
}

const render = (row: WAFDecisionRow) =>
  renderComponent(DecisionDrawer, { decision: row, projectId: 'p1', appId: 'app-1', canConfigure: true, onclose: () => {} } as never);

describe('strength', () => {
  test('is named Block or Weak, and n/a when no detection stands behind the decision', () => {
    expect(strengthLabel('block')).toBe('Block');
    expect(strengthLabel('weak')).toBe('Weak');
    for (const none of [null, undefined, '', 'strong']) expect(strengthLabel(none)).toBe('n/a');
  });

  test('has the tone of the verdict it leads to: a strong detection blocks, a weak one logs', () => {
    expect(strengthTone('block')).toBe('block');
    expect(strengthTone('weak')).toBe('log');
    for (const none of [null, undefined, 'strong']) expect(strengthTone(none)).toBe('neutral');
  });
});

describe('the decision drawer', () => {
  test('shows the strength where it showed the score', async () => {
    const strong = text(await render(decision()));
    expect(strong).toContain('Strength Block');
    expect(strong).not.toMatch(/\bScore\b/);
    const weak = text(await render(decision({ action: 'log', score: 115, strength: 'weak', categories: ['Anomaly'] })));
    expect(weak).toContain('Strength Weak');
    const none = text(await render(decision({ action: 'allow', score: 0, categories: null, strength: null, match_detail: '', cwe: '' })));
    expect(none).toContain('Strength n/a');
  });

  test('a block held back as LOG is strong, and the row still says which engine held it', async () => {
    const html = text(await render(decision({ action: 'log', strength: 'block', engines_log_only: ['sql'], coverage: '' })));
    expect(html).toContain('Strength Block');
    expect(html).toContain('Log only');
  });
});

describe('the decision feed and the project overview', () => {
  test('have a Strength column and no Score column, and the saved column choice is a new one', async () => {
    const feed = await read('src/lib/components/apps/DecisionFeed.svelte');
    expect(feed).toContain("{ key: 'strength', label: 'Strength' }");
    expect(feed).not.toContain("label: 'Score'");
    expect(feed).toContain("COLUMNS_STORAGE = 'wafio.appDecisions.columns.v3'");
    const overview = await read('src/routes/projects/[id]/+page.svelte');
    expect(overview).toContain("'Categories', 'Strength']");
    expect(overview).not.toContain("'Categories', 'Score']");
  });
});
