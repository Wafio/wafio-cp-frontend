// What the HTTPS tab shows, rendered on the server without a DOM: the notices, the mode and what each mode shows, the
// refusals that exist before any click, the DNS hint kept from a save. Clicks cannot run here (Bun has no DOM), so what
// a click decides (the checks of a switch, the texts of the dialogs, where a refusal goes) is tested as functions in
// apps-tls.test.ts.
import './support/runes';
import './support/ssr';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { AppTLSCertificate, AppTLSState, AppTLSStatus, AppTLSWarning } from '../src/lib/api';
import { formatDate } from '../src/lib/format';
import { renderComponent } from './support/ssr';

// The UI barrel pulls in PageHeader, which reads `dev` from SvelteKit.
Bun.plugin({
  name: 'app-environment-stub',
  setup(build) {
    build.module('$app/env', () => ({ loader: 'object', exports: { dev: false, browser: false, building: false, version: 'test' } }));
  },
});

const { default: AppTLS } = await import('../src/lib/components/apps/AppTLS.svelte');
const { default: CertificateUpload } = await import('../src/lib/components/apps/CertificateUpload.svelte');

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

// The card renders from the real clock, so its dates are made relative to it.
const NOW = Date.now();
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();
/** The In use badge: a Badge renders its text between two comment markers. */
const showsInUse = (html: string) => /<span[^>]*tone-success[^>]*>(?:<!---->)?In use/.test(html);

function certificate(over: Partial<AppTLSCertificate> = {}): AppTLSCertificate {
  return {
    id: 'cert-1',
    source: 'uploaded',
    names: ['shop.example.com'],
    issuer: 'Example CA',
    not_before: iso(NOW - 10 * DAY),
    not_after: iso(NOW + 80 * DAY + HOUR),
    days_left: 80,
    leaf_sha256: 'a'.repeat(64),
    key_type: 'ecdsa-p256',
    trusted: true,
    created_at: iso(NOW - HOUR),
    ...over,
  };
}

function report(over: Partial<AppTLSStatus> = {}): AppTLSStatus {
  return {
    agent_id: 'agent-1',
    source: 'acme',
    state: 'active',
    certificate_id: null,
    leaf_sha256: 'b'.repeat(64),
    error: '',
    next_attempt_at: null,
    request_id: 'req-1',
    received_at: iso(NOW - MINUTE),
    names: ['shop.example.com'],
    issuer: 'Let\'s Encrypt R11',
    not_before: iso(NOW - 30 * DAY),
    not_after: iso(NOW + 60 * DAY),
    ...over,
  };
}

/** Let's Encrypt in Gateway, requested 30 minutes ago. */
const acme = (over: Partial<AppTLSState> = {}) =>
  state({ ...GATEWAY, acme: { request_id: 'req-1', requested_at: iso(NOW - 30 * MINUTE) }, status: report(), ...over });

/** An uploaded certificate in Gateway whose leaf the agent serves. */
const uploaded = (over: Partial<AppTLSState> = {}, status: Partial<AppTLSStatus> | null = {}) =>
  state({
    ...GATEWAY,
    source: 'uploaded',
    certificate: certificate(),
    status: status && report({ source: 'uploaded', certificate_id: 'cert-1', request_id: '', leaf_sha256: 'a'.repeat(64), ...status }),
    ...over,
  });

describe('the certificate card, Behind a proxy', () => {
  test('no source saved: no card', async () => {
    expect(await render(state({ source: '' }))).not.toContain('Saved certificate');
  });

  test('Let\'s Encrypt: says the agent orders on the switch, and shows no report, request or In use', async () => {
    const html = await render(state({ status: report() }));
    expect(html).toContain('edge-1 orders the first certificate when you switch to Gateway.');
    for (const text of ['In use', 'Request a new certificate', 'Delete certificate']) expect(html).not.toContain(text);
  });

  test('uploaded: the facts of the certificate and its buttons, never In use', async () => {
    const html = await render(state({ source: 'uploaded', certificate: certificate(), status: report({ source: 'uploaded', certificate_id: 'cert-1' }) }));
    expect(html).toContain('Example CA');
    expect(html).toContain('ecdsa-p256');
    expect(html).toContain(`datetime="${certificate().not_after}"`);
    expect(html).toContain(formatDate(certificate().not_after));
    expect(html).toContain('(in 80 days)');
    expect(html).not.toContain('In use');
    expect(html).not.toMatch(disabledButton('Replace certificate'));
    expect(html).not.toMatch(disabledButton('Delete certificate'));
  });

  test('uploaded with nothing uploaded: an empty state with the upload', async () => {
    const html = await render(state({ source: 'uploaded', certificate: null }));
    expect(html).toContain('No certificate uploaded');
    expect(html).toMatch(/<button[^>]*>(?:(?!<\/button>)[\s\S])*Upload certificate/);
    expect(html).not.toContain('Replace certificate');
  });
});

describe('the certificate card, Gateway, before the agent has reported', () => {
  test('no agent: the notice of an unassigned application, in the card as well', async () => {
    const html = await render(acme({ status: null }), { assigned: false, agentName: '', agentOnline: undefined });
    expect(html.split('No WAF agent serves this application.').length - 1).toBe(2);
    expect(html).not.toContain('Request a new certificate');
  });

  test('no report: waiting, then the ports after 2 minutes', async () => {
    const fresh = await render(acme({ status: null, acme: { request_id: 'req-1', requested_at: iso(NOW - 30 * 1000) } }));
    expect(fresh).toContain('Waiting for edge-1 to report.');
    const late = await render(acme({ status: null }));
    expect(late).toContain('No report from edge-1 yet. Check that it is online and that nothing else holds ports 443 and 80 on its host.');
  });

  test('a report about an older request: the new one is awaited and what is served is shown', async () => {
    const html = await render(acme({ status: report({ request_id: 'req-0', issuer: 'Old CA', names: ['old.example.com'] }) }));
    expect(html).toContain('Waiting for edge-1 to take the new request.');
    expect(html).toContain('Served now');
    expect(html).toContain('Old CA');
    expect(html).toContain('old.example.com');
    expect(html).not.toContain('In use');
  });

  test('an older report with no leaf: the placeholder for Let\'s Encrypt, nothing for an upload, by what HTTP gets', async () => {
    const placeholder = await render(acme({ status: report({ request_id: 'req-0', leaf_sha256: '' }) }));
    expect(placeholder).toContain('Until it is issued, HTTPS visitors get a browser warning and a 503 page.');
    expect(placeholder).not.toContain('Served now');
    const nothing = await render(uploaded({}, { certificate_id: 'cert-0', leaf_sha256: '' }));
    expect(nothing).toContain('Waiting for edge-1 to take the new certificate.');
    expect(nothing).toContain('Nothing is served yet: HTTPS visitors get a connection error, and HTTP visitors get 503.');
    const off = await render(uploaded({ redirect_listen: '' }, { certificate_id: 'cert-0', leaf_sha256: '' }));
    expect(off).toContain('Nothing is served yet: HTTPS visitors get a connection error. Nothing answers on HTTP.');
  });
});

describe('the certificate card, Gateway, Let\'s Encrypt', () => {
  test('pending: requesting, with the placeholder or the current certificate', async () => {
    const none = await render(acme({ status: report({ state: 'pending', leaf_sha256: '' }) }));
    expect(none).toContain("Requesting a certificate from Let's Encrypt.");
    expect(none).toContain('Until it is issued, HTTPS visitors get a browser warning and a 503 page.');
    const leaf = await render(acme({ status: report({ state: 'pending' }) }));
    expect(leaf).toContain('The current certificate stays in use until then.');
    expect(leaf).toContain("Let's Encrypt R11");
    expect(showsInUse(leaf)).toBe(false);
  });

  test('active: the facts, the renewal start and the In use badge', async () => {
    const html = await render(acme());
    expect(html).toContain("Let's Encrypt R11");
    expect(html).toContain('Renewal starts');
    expect(html).toContain('Valid from');
    expect(showsInUse(html)).toBe(true);
    expect(html).not.toContain('Key type');
  });

  test('failed: the last request, the next try or none, and the retry button named for it', async () => {
    const next = iso(NOW + 10 * MINUTE);
    const html = await render(acme({ status: report({ state: 'failed', error: 'rate limited', next_attempt_at: next }) }));
    expect(html).toContain('The last request failed:');
    expect(html).toMatch(/<bdi[^>]*>rate limited<\/bdi>/);
    expect(html).toContain('Next try ');
    expect(html).toContain('Try again now');
    const none = await render(acme({ status: report({ state: 'failed', error: 'refused', leaf_sha256: '' }) }));
    expect(none).toContain('No new try is planned. Fix the cause, then try again.');
    expect(none).toContain('Until it is issued, HTTPS visitors get a browser warning and a 503 page.');
  });

  test('the badge is for Gateway only: the same report Behind a proxy says nothing of use', async () => {
    expect(showsInUse(await render(acme()))).toBe(true);
    expect(showsInUse(await render(acme({ mode: 'proxy', redirect_listen: '' })))).toBe(false);
  });
});

describe('the certificate card, Gateway, uploaded', () => {
  test('active: the facts of the upload and the In use badge', async () => {
    const html = await render(uploaded());
    expect(showsInUse(html)).toBe(true);
    expect(html).toContain('Key type');
    expect(html).toContain('Uploaded');
  });

  test('missing: not host-bound, the previous certificate, or nothing served', async () => {
    const bound = await render(uploaded({ agent_host_bound: false }, { state: 'missing', leaf_sha256: '' }));
    expect(bound).toContain('edge-1 needs a credential bound to its host to receive an uploaded key.');
    const previous = await render(uploaded({}, { state: 'missing', leaf_sha256: 'c'.repeat(64) }));
    expect(previous).toContain('edge-1 serves the previous certificate until it receives this one, within about a minute.');
    const nothing = await render(uploaded({}, { state: 'missing', leaf_sha256: '' }));
    expect(nothing).toContain('Nothing is served yet: HTTPS visitors get a connection error');
    expect(showsInUse(nothing)).toBe(false);
  });

  test('failed: the text of the code, or the agent text with the next try', async () => {
    const code = await render(uploaded({}, { state: 'failed', error: 'x509: bad', error_code: 'key_mismatch' }));
    expect(code).toContain('edge-1 refused this certificate (key_mismatch). Upload the chain and key again.');
    expect(code).not.toContain('x509: bad');
    const plain = await render(uploaded({}, { state: 'failed', error: 'something odd', error_code: '' }));
    expect(plain).toContain('edge-1 reported:');
    expect(plain).toMatch(/<bdi[^>]*>something odd<\/bdi>/);
    expect(plain).toContain('No new try is planned.');
  });
});

describe('the certificate card, escaping', () => {
  const RLO = '\u202e';
  const hostile = `<img src=x onerror=alert(1)> ${RLO}evil & <b>bold</b>`;

  test('an agent text is plain text in a bdi that wraps: markup shows as text and the reversal stays inside', async () => {
    const html = await render(acme({ status: report({ state: 'failed', error: hostile }) }));
    expect(html).toMatch(/<bdi[^>]*tls-error[^>]*>&lt;img src=x onerror=alert\(1\)> /);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>bold</b>');
    expect(html).toContain(`${RLO}evil &amp; &lt;b>bold&lt;/b>`);
  });

  test('the issuer and the names of a certificate are plain text too', async () => {
    const html = await render(uploaded({ certificate: certificate({ issuer: hostile, names: ['<script>x</script>.example.com'] }) }));
    expect(html).not.toContain('<script>x');
    expect(html).not.toContain('<img');
    expect(html).toMatch(/<bdi>&lt;script>x&lt;\/script>\.example\.com<\/bdi>/);
  });

  test('the styles keep the lines of the text and let a long word wrap', () => {
    const source = readFileSync(new URL('../src/lib/components/apps/AppTLS.svelte', import.meta.url), 'utf8');
    expect(source).toMatch(/\.tls-error \{[^}]*white-space: pre-wrap;[^}]*overflow-wrap: anywhere/);
  });
});

describe('the certificate card, expiry', () => {
  const soon = (not_after: string): AppTLSWarning[] => [{ code: 'expires_soon', days_left: 3, not_after }];

  test('an uploaded certificate close to its end: when, and to upload a new one', async () => {
    const end = iso(NOW + 3 * DAY + HOUR);
    const html = await render(uploaded({ certificate: certificate({ not_after: end, days_left: 3 }), warnings: soon(end) }));
    expect(html).toContain(`The certificate expires ${formatDate(end)} (in 3 days). Upload a new one before then.`);
  });

  test('a Let\'s Encrypt certificate: the renewal is late, and the last day is in hours', async () => {
    const end = iso(NOW + 5 * HOUR - MINUTE);
    const html = await render(acme({ status: report({ not_after: end }), warnings: soon(end) }));
    expect(html).toContain("(in 5 hours) and is not renewed yet. Check the status below, and that edge-1 can reach Let's Encrypt.");
  });

  test('past its end: the certificate expired and visitors get an error', async () => {
    const end = iso(NOW - HOUR);
    const html = await render(uploaded({ certificate: certificate({ not_after: end, days_left: -1 }), warnings: soon(end) }));
    expect(html).toContain(`The certificate expired ${formatDate(end)}. Visitors get a certificate error.`);
    expect(html).toContain('(expired)');
  });

  test('a chain that is not trusted says what it means for visitors', async () => {
    const html = await render(uploaded({ warnings: [{ code: 'not_trusted' }] }));
    expect(html).toContain('This chain does not lead to a root that browsers trust.');
    expect(html).toContain('which is normal for a private CA');
  });
});

describe('the certificate card, request', () => {
  const requestButton = (html: string) => /<button[^>]*>(?:(?!<\/button>)[\s\S])*(Request a new certificate|Try again now)/.exec(html)?.[0] ?? '';

  test('Let\'s Encrypt in Gateway with an agent: a button with the agreement line', async () => {
    const html = await render(acme());
    expect(requestButton(html)).not.toBe('');
    expect(requestButton(html)).not.toContain('disabled');
    expect(html).toContain("Starts a request now, unless Let's Encrypt set a wait after its rate limit. One request every 5 minutes. By requesting, you accept the Let's Encrypt Subscriber Agreement.");
    expect(html).not.toContain('You can request again at');
  });

  test('5 minutes after the last request: disabled, with the time', async () => {
    const html = await render(acme({ acme: { request_id: 'req-1', requested_at: iso(NOW - MINUTE) } }));
    expect(requestButton(html)).toContain('disabled');
    expect(html).toContain('You can request again at ');
    expect(html).toContain('One request every 5 minutes.');
  });

  test('no button Behind a proxy, for an upload, or for a viewer', async () => {
    expect(await render(state())).not.toContain('Request a new certificate');
    expect(await render(uploaded())).not.toContain('Request a new certificate');
    const viewer = await render(acme(), { canConfigure: false });
    expect(requestButton(viewer)).toContain('disabled');
    expect(viewer).toMatch(/<fieldset[^>]*tls-fieldset[^>]*disabled/);
  });
});

describe('the certificate card, delete and replace', () => {
  test('Gateway with an uploaded certificate: in use, so Delete is disabled and says why; Replace stays', async () => {
    const html = await render(uploaded());
    expect(html).toMatch(disabledButton('Delete certificate'));
    expect(html).not.toMatch(disabledButton('Replace certificate'));
    expect(html).toContain("In use. Switch to Let's Encrypt or Behind a proxy first, or upload a replacement.");
  });

  test('Behind a proxy: Delete is available and nothing says in use', async () => {
    const html = await render(state({ source: 'uploaded', certificate: certificate() }));
    expect(html).not.toMatch(disabledButton('Delete certificate'));
    expect(html).not.toContain('In use. Switch to');
  });

  test('the move advice is on the uploaded card', async () => {
    const html = await render(uploaded());
    expect(html).toContain('After a move to another WAF agent, or the removal of its agent, upload a new certificate with a new key: the old host may keep a copy of this one.');
  });

  test('an uploaded certificate still stored behind Let\'s Encrypt can be deleted', async () => {
    const html = await render(acme({ certificate: certificate() }));
    expect(html).toContain('An uploaded certificate of this application is still stored with its key.');
    expect(html).not.toMatch(disabledButton('Delete certificate'));
    expect(await render(acme())).not.toContain('Delete certificate');
  });

  test('a viewer can neither replace nor delete', async () => {
    const html = await render(uploaded({ mode: 'proxy', redirect_listen: '' }), { canConfigure: false });
    expect(html).toMatch(/<fieldset[^>]*tls-fieldset[^>]*disabled/);
    for (const label of ['Replace certificate', 'Delete certificate']) expect(html).toMatch(disabledButton(label));
  });

  test('the dialog of a delete is out of the page until it opens', async () => {
    const html = await render(uploaded());
    expect(html).not.toContain('Deletes the private key of every certificate uploaded for');
  });
});

describe('the upload dialog', () => {
  async function dialog(props: Record<string, unknown> = {}): Promise<string> {
    return renderComponent(CertificateUpload, {
      open: true,
      projectId: 'p1',
      appId: 'a1',
      appName: 'shop-frontend',
      agentName: 'edge-1',
      onuploaded: () => {},
      onclose: () => {},
      ...props,
    } as never);
  }

  test('has nothing in the page until it is opened', async () => {
    expect(await dialog({ open: false })).not.toContain('<textarea');
  });

  test('names the application, and says upload or replace', async () => {
    expect(await dialog()).toContain('Upload a certificate for shop-frontend');
    expect(await dialog()).toMatch(/<button[^>]*>(?:(?!<\/button>)[\s\S])*Upload certificate/);
    const replacing = await dialog({ replacing: true });
    expect(replacing).toContain('Replace the certificate of shop-frontend');
    expect(replacing).toMatch(/<button[^>]*>(?:(?!<\/button>)[\s\S])*Replace certificate/);
  });

  test('both textareas keep out spell checkers, autofill and writing assistants', async () => {
    const html = await dialog();
    const fields = html.match(/<textarea[^>]*>/g) ?? [];
    expect(fields).toHaveLength(2);
    for (const field of fields) {
      for (const attribute of ['spellcheck="false"', 'autocomplete="off"', 'autocapitalize="off"', 'data-gramm="false"', 'data-gramm_editor="false"', 'data-enable-grammarly="false"']) {
        expect(field).toContain(attribute);
      }
    }
  });

  test('the texts of the fields, and no key until one is given', async () => {
    const html = await dialog();
    expect(html).toContain('The server certificate first, then each intermediate. Up to 10 certificates, 64 KiB.');
    expect(html).toContain('One key without a passphrase: RSA of 2048 to 4096 bits, or ECDSA P-256 or P-384, up to 16 KiB. Sent once, stored encrypted, never shown again.');
    expect(html).not.toContain('The key field was cleared.');
    expect(html).not.toContain('<output');
  });

  test('a file for each: the chain takes certificates, the key also .key', async () => {
    const html = await dialog();
    const [chain, key] = html.match(/<input[^>]*type="file"[^>]*>/g) ?? [];
    expect(chain).toContain('accept=".pem,.crt,.cer,.der,.p12,.pfx,.txt"');
    expect(key).toContain('accept=".pem,.crt,.cer,.der,.p12,.pfx,.txt,.key"');
    expect(html.match(/Choose file(?! for the)/g)).toHaveLength(2);
  });

  test('says nothing of a source change for a replacement, and says it for another source', async () => {
    expect(await dialog({ replacing: true })).not.toContain('This upload becomes the source');
    expect(await dialog({ becomesSource: true })).toContain('This upload becomes the source of this application.');
    expect(await dialog({ becomesSource: true })).not.toContain('switches to it');
    const gateway = await dialog({ becomesSource: true, gateway: true });
    expect(gateway).toContain('This upload becomes the source of this application. edge-1 switches to it within about a minute and serves the current certificate until then, if it has one.');
  });

  test('nothing to send until a chain and a key are there', async () => {
    expect(await dialog()).toMatch(disabledButton('Upload certificate'));
  });

  test('the key is never shown: it is bound to a field and a file is listed by name only', () => {
    const source = readFileSync(new URL('../src/lib/components/apps/CertificateUpload.svelte', import.meta.url), 'utf8');
    expect(source).not.toMatch(/(?<!bind:value=)\{form\.key\}/);
    expect(source).toContain('chosenFileText(form.keyFile)');
  });
});
