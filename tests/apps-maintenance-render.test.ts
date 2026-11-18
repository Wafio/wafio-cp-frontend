// What the Maintenance tab and the Assignment tab show, rendered on the server without a DOM: the notices, the list
// of what maintenance mode does, the hints and whether the switch can be used. Clicks cannot run here (Bun has no
// DOM), so what a click decides is tested as functions in apps-maintenance.test.ts.
import './support/runes';
import './support/ssr';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { AppWAFAssignment, FleetAgent, Maintenance, MaintenanceState } from '../src/lib/api';
import { renderComponent } from './support/ssr';

// The UI barrel pulls in PageHeader, which reads `dev` from SvelteKit.
Bun.plugin({
  name: 'app-environment-stub',
  setup(build) {
    build.module('$app/env', () => ({ loader: 'object', exports: { dev: false, browser: false, building: false, version: 'test' } }));
  },
});

const { default: AppMaintenance } = await import('../src/lib/components/apps/AppMaintenance.svelte');
const { default: AppAssignment } = await import('../src/lib/components/AppAssignment.svelte');

const backend = JSON.parse(readFileSync(new URL('./fixtures/backend/maintenance.json', import.meta.url), 'utf8')) as { default_message: string; stock_html: string };

function maintenance(over: Partial<Maintenance> = {}): Maintenance {
  return { enabled: false, message: '', end_time: '', custom_html: '', allow_ips: [], allow_paths: [], started_at: '', ...over };
}

function state(over: Partial<Maintenance> = {}, supported: boolean | null = true): MaintenanceState {
  return { maintenance: maintenance(over), agent_supported: supported, client_ip: '203.0.113.42', default_message: backend.default_message, stock_html: backend.stock_html };
}

const ON = { enabled: true, started_at: '2026-11-18T10:00:00Z' };

type Props = { assigned?: boolean; agentName?: string; agentOnline?: boolean; canConfigure?: boolean };

async function render(initial: MaintenanceState, props: Props = {}): Promise<string> {
  return renderComponent(AppMaintenance, {
    projectId: 'p1',
    appId: 'a1',
    appName: 'shop-frontend',
    assigned: true,
    agentName: 'edge-1',
    agentOnline: true,
    canConfigure: true,
    dirty: false,
    initial,
    ...props,
  } as never);
}

/** The opening tag of the switch, to read its attributes. */
function switchTag(html: string): string {
  const tag = /<button[^>]*role="switch"[^>]*>/.exec(html);
  expect(tag).not.toBeNull();
  return tag![0];
}

const FACTS = [
  'Requests get the maintenance page with status 503 unless they come from an allowed IP address or go to an allowed path. This is decided before the request body is read, so uploads of any size get it too.',
  'Open WebSocket connections and live event streams of visitors who are not allowed are closed; downloads already running finish.',
  'Browser apps on other sites can read the JSON answer. A request that sends cookies and needs a preflight still fails in the browser.',
  'While maintenance mode is on, the application can only move to a WAF agent that supports it.',
];

describe('Maintenance tab, before the settings are read', () => {
  test('shows that it is loading, and no notice or switch yet; the list is already there', async () => {
    const html = await renderComponent(AppMaintenance, { projectId: 'p1', appId: 'a1', canConfigure: true, dirty: false } as never);
    expect(html).toContain('Loading the maintenance settings');
    expect(html).not.toContain('role="switch"');
    expect(html).toContain(FACTS[0]);
  });
});

describe('Maintenance tab, off with an agent that supports it', () => {
  test('lists what maintenance mode does, right under the header', async () => {
    const html = await render(state());
    for (const fact of FACTS) expect(html).toContain(`<li>${fact}</li>`);
    // The list follows the opening paragraph of the header and comes before the form.
    expect(html.indexOf('so nothing reaches your upstream.')).toBeLessThan(html.indexOf(FACTS[0]));
    expect(html.indexOf(FACTS[3])).toBeLessThan(html.indexOf('Visitor page'));
  });

  test('has no notice and the switch is off and can be used', async () => {
    const html = await render(state());
    expect(html).not.toContain('mt-notices');
    const tag = switchTag(html);
    expect(tag).toContain('aria-checked="false"');
    expect(tag).not.toContain('disabled');
  });

  test('says how many paths, and in which unit', async () => {
    const html = await render(state());
    expect(html).toContain('One path per line, up to 20, at most 256 bytes each.');
    expect(html).not.toContain('256 characters');
  });

  test('has no bytes hint for the custom page while the standard page is used', async () => {
    const html = await render(state());
    expect(html).not.toContain('4,193,280');
  });
});

describe('Maintenance tab, on with an agent that does not support it', () => {
  test('warns that visitors still see the site, and the switch can still be turned off', async () => {
    const html = await render(state(ON, false));
    expect(html).toContain('Maintenance mode is on, but edge-1 does not support it, so visitors still see the site. Upgrade the WAF agent or turn maintenance mode off.');
    const tag = switchTag(html);
    expect(tag).toContain('aria-checked="true"');
    expect(tag).not.toContain('disabled');
    expect(html).toContain('On since');
  });

  test('off with such an agent: a warning, and the switch cannot go on', async () => {
    const html = await render(state({}, false));
    expect(html).toContain('edge-1 does not support maintenance mode. Upgrade the WAF agent to the latest release, then turn it on here.');
    expect(switchTag(html)).toContain('disabled');
  });

  test('the list is still there', async () => {
    const html = await render(state(ON, false));
    for (const fact of FACTS) expect(html).toContain(fact);
  });
});

describe('Maintenance tab, no WAF agent serves the application', () => {
  test('says the settings wait for an agent, and the switch works', async () => {
    const html = await render(state(ON, null), { assigned: false, agentName: '', agentOnline: undefined });
    expect(html).toContain('No WAF agent serves this application. These settings take effect once one is assigned on the Assignment tab.');
    expect(html).not.toContain('is offline');
    expect(switchTag(html)).not.toContain('disabled');
  });
});

describe('Maintenance tab, the agent is offline', () => {
  test('names the agent and says the change waits for it', async () => {
    const html = await render(state(), { agentOnline: false });
    expect(html).toContain('edge-1 is offline. The change takes effect when it reconnects.');
  });
});

describe('Maintenance tab, read-only', () => {
  test('says so, locks the switch, the fields and the buttons', async () => {
    const html = await render(state({ allow_paths: ['/healthz'] }), { canConfigure: false });
    expect(html).toContain('Read-only: changing maintenance mode needs member or owner access.');
    expect(switchTag(html)).toContain('disabled');
    expect(html).toMatch(/<fieldset[^>]*mt-fieldset[^>]*disabled/);
    // A button is disabled when its own opening tag says so and its text follows before it closes.
    for (const label of ['Discard changes', 'Save changes']) expect(html).toMatch(new RegExp(`<button[^>]*disabled[^>]*>(?:(?!</button>)[\\s\\S])*${label}`));
    // The explanation of the list does not depend on who looks.
    for (const fact of FACTS) expect(html).toContain(fact);
  });
});

describe('Maintenance tab, the end time passed', () => {
  test('warns that visitors still see the page, while on', async () => {
    const html = await render(state({ ...ON, end_time: '2020-01-01T00:00:00Z' }));
    expect(html).toContain('The expected end time passed');
    expect(html).toContain('Visitors still see the maintenance page until you turn maintenance mode off.');
  });
});

describe('Maintenance tab, a custom page', () => {
  const custom = state({ ...ON, custom_html: '<h1>{{WAFIO_MESSAGE}}</h1>' });

  test('tells that the pages of all applications on an agent share what the agent can receive', async () => {
    const html = await render(custom);
    expect(html).toContain('Up to 64 KiB.');
    expect(html).toContain('The custom pages of all applications on one WAF agent count toward the 4,193,280 bytes (about 4 MiB) of configuration that agent can receive, and each &lt;, > and &amp; counts as six bytes there.');
  });

  test('shows the editor, the size and the placeholders', async () => {
    const html = await render(custom);
    expect(html).toContain('KiB of 64 KiB');
    expect(html).toContain('{{WAFIO_MESSAGE}}');
    expect(html).toContain('{{WAFIO_END_TIME}}');
    expect(html).toContain('Placeholders');
  });

  test('the answer of the server about a too large page is not there before a save', async () => {
    const html = await render(custom);
    expect(html).not.toContain('can receive a configuration of at most');
  });
});

describe('Assignment tab', () => {
  const agents: FleetAgent[] = [{ id: 'g1', name: 'edge-1', is_online: true } as FleetAgent];
  const assignment = { agent_id: 'g1', app_id: 'a1', mode: 'block' } as AppWAFAssignment;
  const props = { projectId: 'p1', appId: 'a1', appName: 'shop-frontend', agents, assignment, canConfigure: true, onchanged: () => {} };
  const note = 'While maintenance mode is on, the application can only move to a WAF agent that supports it.';

  test('says that the agent cannot be chosen freely while maintenance mode is on', async () => {
    const html = await renderComponent(AppAssignment, { ...props, maintenance: true } as never);
    expect(html).toContain(note);
  });

  test('says nothing of it while maintenance mode is off, or when the prop is not given', async () => {
    expect(await renderComponent(AppAssignment, { ...props, maintenance: false } as never)).not.toContain(note);
    expect(await renderComponent(AppAssignment, props as never)).not.toContain(note);
  });

  test('also when no agent is assigned yet: the application is still in maintenance mode', async () => {
    const html = await renderComponent(AppAssignment, { ...props, assignment: null, maintenance: true } as never);
    expect(html).toContain(note);
  });
});
