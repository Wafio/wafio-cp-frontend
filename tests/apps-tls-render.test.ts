// What the HTTPS tab shows, rendered on the server without a DOM: the notices, the mode and what each mode shows, the
// refusals that exist before any click, the DNS hint kept from a save. Clicks cannot run here (Bun has no DOM), so what
// a click decides (the checks of a switch, the texts of the dialogs, where a refusal goes) is tested as functions in
// apps-tls.test.ts.
import './support/runes';
import './support/ssr';
import { describe, expect, test } from 'bun:test';
import type { AppTLSState, AppTLSWarning } from '../src/lib/api';
import { renderComponent } from './support/ssr';

// The UI barrel pulls in PageHeader, which reads `dev` from SvelteKit.
Bun.plugin({
  name: 'app-environment-stub',
  setup(build) {
    build.module('$app/env', () => ({ loader: 'object', exports: { dev: false, browser: false, building: false, version: 'test' } }));
  },
});

const { default: AppTLS } = await import('../src/lib/components/apps/AppTLS.svelte');

const DNS: AppTLSWarning = { code: 'dns_mismatch', host: 'shop.example.com', resolved: ['203.0.113.7'], agent_addresses: ['198.51.100.2'] };

function state(over: Partial<AppTLSState> = {}): AppTLSState {
  return {
    mode: 'proxy',
    hosts: ['shop.example.com'],
    listen: '0.0.0.0:443',
    redirect_listen: '',
    source: 'acme',
    certificate: null,
    acme: null,
    status: null,
    agent_supported: true,
    agent_host_bound: true,
    warnings: [],
    ...over,
  };
}

const GATEWAY = { mode: 'gateway' as const, redirect_listen: '0.0.0.0:80' };

type Props = {
  assigned?: boolean;
  agentName?: string;
  agentOnline?: boolean;
  canConfigure?: boolean;
  routing?: { listenHost: string; listenPort: number | null; proxy: { trustForwarded: boolean; trustedProxies: string } };
};

const ROUTING = { listenHost: '', listenPort: 8080, proxy: { trustForwarded: false, trustedProxies: '' } };

async function render(initial: AppTLSState | undefined, props: Props = {}): Promise<string> {
  return renderComponent(AppTLS, {
    projectId: 'p1',
    appId: 'a1',
    appName: 'shop-frontend',
    assigned: true,
    agentName: 'edge-1',
    agentOnline: true,
    canConfigure: true,
    routing: ROUTING,
    routingHref: '/projects/p1/apps/a1?tab=routing',
    dirty: false,
    initial,
    ...props,
  } as never);
}

/** The opening tag of the first element of `html` that matches `pattern`. */
function tag(html: string, pattern: RegExp): string {
  const found = pattern.exec(html);
  expect(found).not.toBeNull();
  return found![0];
}

/** A button is disabled when its own opening tag says so and its text follows before it closes. */
const disabledButton = (label: string) => new RegExp(`<button[^>]*disabled[^>]*>(?:(?!</button>)[\\s\\S])*${label}`);

describe('HTTPS tab, before the settings are read', () => {
  test('shows that it is loading, and no form yet; the intro is already there', async () => {
    const html = await render(undefined);
    expect(html).toContain('Loading the HTTPS settings');
    expect(html).toContain('Choose how visitors reach this application and which certificate the WAF agent serves for HTTPS.');
    expect(html).not.toContain('Host names');
    expect(html).not.toContain('role="switch"');
  });
});

describe('HTTPS tab, Behind a proxy', () => {
  test('offers both modes with a line each, Behind a proxy chosen', async () => {
    const html = await render(state());
    expect(html).toContain('How traffic reaches WAFio');
    expect(html).toContain('WAFio receives traffic straight from the internet and handles HTTPS');
    expect(html).toContain('WAFio sits behind a web server, load balancer or CDN');
    expect(tag(html, /<input[^>]*type="radio"[^>]*value="proxy"[^>]*>/)).toContain('checked');
    expect(tag(html, /<input[^>]*type="radio"[^>]*value="gateway"[^>]*>/)).not.toContain('checked');
  });

  test('shows the host names and the certificate source, and no listener', async () => {
    const html = await render(state());
    expect(html).toContain('One per line, up to 100, such as shop.example.com. No wildcards, IP addresses or ports; international names in xn-- form.');
    expect(html).toContain('shop.example.com</textarea>');
    expect(html).toContain("The agent requests a certificate for these host names and renews it.");
    expect(html).toContain('A certificate you bought or issued with your own CA. Its key can be replaced, never read back.');
    expect(tag(html, /<input[^>]*type="radio"[^>]*value="acme"[^>]*>/)).toContain('checked');
    expect(html).not.toContain('HTTPS address');
    expect(html).not.toContain('Redirect HTTP to HTTPS');
  });

  test('the host names are not sent to a spell checker, an autocomplete or a writing assistant', async () => {
    const html = await render(state());
    const field = tag(html, /<textarea[^>]*>/);
    for (const attribute of ['spellcheck="false"', 'autocomplete="off"', 'autocapitalize="off"']) expect(field).toContain(attribute);
  });

  test('has no notice, and nothing to save yet', async () => {
    const html = await render(state());
    expect(html).not.toContain('tls-notices');
    expect(html).toMatch(disabledButton('Save changes'));
    expect(html).toMatch(disabledButton('Discard changes'));
    expect(html).not.toContain('Switch to Gateway');
    expect(html).not.toMatch(/<fieldset[^>]*tls-fieldset[^>]*disabled/);
  });

  test('keeps the text of the dialogs out of the page until one opens', async () => {
    const html = await render(state());
    for (const text of ['Subscriber Agreement', 'Outside WAFio', 'stops serving HTTPS']) expect(html).not.toContain(text);
  });
});

describe('HTTPS tab, Gateway', () => {
  test('shows the addresses, the redirect and its address', async () => {
    const html = await render(state(GATEWAY));
    expect(tag(html, /<input[^>]*type="radio"[^>]*value="gateway"[^>]*>/)).toContain('checked');
    expect(html).toContain('HTTPS address');
    expect(html).toContain('ip:port or [ipv6]:port. Empty means 0.0.0.0:443.');
    expect(html).toContain("Sends HTTP visitors to HTTPS once a certificate is in use (503 before that) and answers Let's Encrypt's HTTP-01 check. Keep it on behind a CDN.");
    expect(tag(html, /<button[^>]*role="switch"[^>]*>/)).toContain('aria-checked="true"');
    expect(html).toContain('Redirect address');
    expect(html).toContain('value="0.0.0.0:80"');
  });

  test('with the redirect off there is no redirect address', async () => {
    const html = await render(state({ mode: 'gateway', redirect_listen: '' }));
    expect(tag(html, /<button[^>]*role="switch"[^>]*>/)).toContain('aria-checked="false"');
    expect(html).not.toContain('Redirect address');
  });

  test('says nothing of a save before one is made', async () => {
    const html = await render(state(GATEWAY));
    expect(html).not.toContain('applies it within about a minute');
    expect(html).not.toContain('tls-notices');
  });
});

describe('HTTPS tab, notices', () => {
  test('no WAF agent: the settings wait for one, and the tab can still be edited', async () => {
    const html = await render(state({ agent_supported: null, agent_host_bound: null }), { assigned: false, agentName: '', agentOnline: undefined });
    expect(html).toContain('No WAF agent serves this application. These settings take effect once one is assigned on the Assignment tab.');
    expect(html).not.toContain('is offline');
    expect(html).not.toMatch(/<fieldset[^>]*tls-fieldset[^>]*disabled/);
  });

  test('an offline agent is named', async () => {
    const html = await render(state(), { agentOnline: false });
    expect(html).toContain('edge-1 is offline. The change takes effect when it reconnects.');
  });

  test('an agent that cannot serve certificates: a warning before Gateway', async () => {
    const html = await render(state({ agent_supported: false }));
    expect(html).toContain('edge-1 cannot serve certificates: it is older than this feature, or its key directory /var/lib/wafio-waf-agent/tls/ was unusable at start (its log says why). Upgrade it, or fix the directory and restart it.');
    expect(html).not.toContain('no longer serves certificates');
  });

  test('a Gateway app whose agent cannot serve certificates says so and stays editable', async () => {
    const html = await render(state({ ...GATEWAY, agent_supported: false }));
    expect(html).toContain('edge-1 no longer serves certificates, so it serves this application in plain HTTP at its Routing listen address.');
    expect(html).not.toContain('is older than this feature');
    expect(html).not.toMatch(/<fieldset[^>]*tls-fieldset[^>]*disabled/);
    const address = tag(html, /<input[^>]*placeholder="0\.0\.0\.0:443"[^>]*>/);
    expect(address).not.toContain('disabled');
    expect(tag(html, /<textarea[^>]*>/)).not.toContain('disabled');
    expect(tag(html, /<button[^>]*role="switch"[^>]*>/)).not.toContain('disabled');
  });

  test('a viewer reads the settings and changes nothing', async () => {
    const html = await render(state(GATEWAY), { canConfigure: false });
    expect(html).toContain('Read-only: changing HTTPS settings needs member or owner access.');
    expect(html).toMatch(/<fieldset[^>]*tls-fieldset[^>]*disabled/);
    expect(tag(html, /<button[^>]*role="switch"[^>]*>/)).toContain('disabled');
    for (const label of ['Discard changes', 'Save changes']) expect(html).toMatch(disabledButton(label));
  });
});

describe('HTTPS tab, the listener of the Routing tab', () => {
  const own = (port: number | null, host = '') => ({ ...ROUTING, listenHost: host, listenPort: port });
  const clash = 'The listen address on the Routing tab of this application uses it.';

  test('in Gateway, an application listening where the agent would serve HTTPS says so under the address', async () => {
    const html = await render(state(GATEWAY), { routing: own(443) });
    expect(html).toContain(clash);
    expect(tag(html, /<input[^>]*placeholder="0\.0\.0\.0:443"[^>]*>/)).toContain('aria-invalid="true"');
  });

  test('the same for the redirect address, under that address', async () => {
    const html = await render(state(GATEWAY), { routing: own(80, '10.0.0.5') });
    expect(html).toContain(clash);
    expect(tag(html, /<input[^>]*placeholder="0\.0\.0\.0:80"[^>]*>/)).toContain('aria-invalid="true"');
    expect(tag(html, /<input[^>]*placeholder="0\.0\.0\.0:443"[^>]*>/)).not.toContain('aria-invalid');
  });

  test('another port, no port, or Behind a proxy: no clash', async () => {
    expect(await render(state(GATEWAY), { routing: own(8080) })).not.toContain(clash);
    expect(await render(state(GATEWAY), { routing: own(null) })).not.toContain(clash);
    expect(await render(state(), { routing: own(443) })).not.toContain(clash);
  });
});

describe('HTTPS tab, the DNS hint of a save', () => {
  test('is shown with its way back, while the app is in Gateway', async () => {
    const html = await render(state({ ...GATEWAY, warnings: [DNS] }));
    expect(html).toContain("shop.example.com resolves to 203.0.113.7, but edge-1's host reports 198.51.100.2. Visitors and Let's Encrypt go where DNS points; behind a CDN that is expected.");
    expect(html).toMatch(/<button[^>]*>(?:(?!<\/button>)[\s\S])*Switch back to Behind a proxy/);
  });

  test('is not shown once the app is behind a proxy again, whatever the state still holds', async () => {
    expect(await render(state({ warnings: [DNS] }))).not.toContain('resolves to');
  });

  test('is not kept by the page: the state it hands back to the tab shows no hint', async () => {
    const { withoutDnsHints } = await import('../src/lib/components/apps/tls');
    expect(await render(withoutDnsHints(state({ ...GATEWAY, warnings: [DNS] })))).not.toContain('resolves to');
  });

  test('survives a poll: the state after it still shows the hint', async () => {
    const { mergePoll } = await import('../src/lib/components/apps/tls');
    const merged = mergePoll(state({ ...GATEWAY, warnings: [DNS] }), state({ ...GATEWAY, warnings: [] }));
    expect(await render(merged)).toContain('shop.example.com resolves to 203.0.113.7');
  });

  test('one hint for each host, and a viewer gets no way back', async () => {
    const other: AppTLSWarning = { ...DNS, host: 'www.example.com', resolved: ['203.0.113.9'] };
    const html = await render(state({ ...GATEWAY, warnings: [DNS, other] }), { canConfigure: false });
    expect(html).toContain('shop.example.com resolves to');
    expect(html).toContain('www.example.com resolves to');
    expect(html).not.toContain('Switch back to Behind a proxy');
  });

  test('warnings of other kinds are not shown on this tab', async () => {
    const html = await render(state({ ...GATEWAY, warnings: [{ code: 'not_trusted' }, { code: 'expires_soon', days_left: 5 }] }));
    expect(html).not.toContain('resolves to');
    expect(html).not.toContain('tls-notices');
  });
});
