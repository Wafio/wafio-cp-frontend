// Trusted proxies in the routing model, and the script size /
// SCRIPT_INVALID handling.
import { describe, expect, test } from 'bun:test';
import type { AgentRoute, App } from '../src/lib/api';
import { formatDate } from '../src/lib/format';
import {
  CLOUDFLARE_RANGES,
  CLOUDFLARE_RANGES_DATE,
  agentRouteBodyFrom,
  appUpdateBodyFrom,
  routeFormFromAgentRoute,
  routeFormFromApp,
  cloudflareHint,
  defaultProxyForm,
  emptyRouteForm,
  holdsOtherProxies,
  isTrustedProxyEntry,
  proxyConfigFrom,
  proxyErrorField,
  proxyFormFrom,
  trustedProxyList,
  validateRouteForm,
  validateTrustedProxies,
  withCloudflare,
} from '../src/lib/components/apps/route-model';
import { SCRIPT_MAX_BYTES, ruleSaveError, scriptBytes, scriptSizeError } from '../src/lib/components/rules/script-access';
import { configWarningTone } from '../src/lib/tone';

describe('trusted proxies', () => {
  test('a new form trusts nothing', () => {
    expect(defaultProxyForm().trustForwarded).toBe(false);
    expect(proxyConfigFrom(defaultProxyForm()).trust_forwarded).toBe(false);
    expect(proxyConfigFrom(defaultProxyForm()).trusted_proxies).toEqual([]);
  });

  test('round trip keeps the list and drops the migration marker', () => {
    const form = proxyFormFrom({ trust_forwarded: true, trusted_proxies: ['10.0.0.5', '192.0.2.0/24'], _trust_forwarded_backfill: '000091', other: 1 });
    expect(form.trustedProxies).toBe('10.0.0.5\n192.0.2.0/24');
    const out = proxyConfigFrom(form);
    expect(out.trusted_proxies).toEqual(['10.0.0.5', '192.0.2.0/24']);
    expect(out.trust_forwarded).toBe(true);
    expect('_trust_forwarded_backfill' in out).toBe(false);
    expect(out.other).toBe(1);
  });

  test('validation: IP or CIDR, at least /8 (IPv4) or /16 (IPv6), at most 64', () => {
    expect(validateTrustedProxies('10.0.0.1\n2001:db8::/32, 172.16.0.0/12, 10.0.0.0/8, 2001::/16')).toBeNull();
    expect(validateTrustedProxies('0.0.0.0/0')).toContain('too broad');
    expect(validateTrustedProxies('::/0')).toContain('too broad');
    // Two halves that together cover everything are refused too.
    expect(validateTrustedProxies('0.0.0.0/1\n128.0.0.0/1')).toContain('too broad');
    expect(validateTrustedProxies('10.0.0.0/7')).toContain('too broad');
    expect(validateTrustedProxies('2000::/15')).toContain('too broad');
    expect(validateTrustedProxies('proxy.local')).toContain('proxy.local');
    const many = Array.from({ length: 65 }, (_, i) => `10.0.${i}.1`).join('\n');
    expect(validateTrustedProxies(many)).toContain('64');
  });

  test('the form only validates the list while trust is on; off keeps valid entries only', () => {
    const form = emptyRouteForm();
    form.proxy.trustedProxies = 'bad';
    expect(validateRouteForm(form, { requireRouting: false })['proxy.trustedProxies']).toBeUndefined();
    expect(trustedProxyList(form.proxy)).toEqual([]);
    form.proxy.trustForwarded = true;
    expect(validateRouteForm(form, { requireRouting: false })['proxy.trustedProxies']).toBeTruthy();
  });

  test('server INVALID_PROXY_CONFIG messages map to the field', () => {
    expect(proxyErrorField('trusted_proxies[2]: "x" is not an IP address or CIDR')).toBe('proxy.trustedProxies');
    expect(proxyErrorField('trusted_proxies: too many entries (max 64)')).toBe('proxy.trustedProxies');
    expect(proxyErrorField('Could not save the routing.')).toBeNull();
    expect(proxyErrorField(null)).toBeNull();
  });

  // PUT replaces the whole stored proxy_config: an edit must never turn trust
  // on for an app stored as {}, and must round-trip trusted_proxies.
  const baseApp = (proxy_config: App['proxy_config']): App => ({
    id: 'app-1',
    project_id: 'p',
    name: 'shop',
    upstream_url: 'http://10.0.0.5:3000',
    listen_host: '0.0.0.0',
    listen_port: 8080,
    proxy_config,
    created_at: '',
    updated_at: '',
  });
  const route = (proxy_config: AgentRoute['proxy_config']): AgentRoute => ({
    app_id: 'app-1',
    name: 'shop',
    listen_host: '0.0.0.0',
    listen_port: 8080,
    upstream: 'http://10.0.0.5:3000',
    mode: 'block',
    proxy_config,
  });

  test('an app stored as {} keeps trust off after an unrelated edit', () => {
    const form = routeFormFromApp(baseApp({}));
    form.name = 'shop-renamed';
    const body = appUpdateBodyFrom(form);
    expect(body.proxy_config?.trust_forwarded).toBe(false);
    expect(body.proxy_config?.trusted_proxies).toEqual([]);
    const routeForm = routeFormFromAgentRoute(route({}));
    routeForm.listenPort = 8081;
    expect(agentRouteBodyFrom(routeForm).proxy_config?.trust_forwarded).toBe(false);
  });

  test('an app with trusted_proxies keeps the list after an unrelated edit', () => {
    const stored = { trust_forwarded: true, trusted_proxies: ['10.0.0.5', '2001:db8::/32'] };
    const form = routeFormFromApp(baseApp(stored));
    form.name = 'shop-renamed';
    const body = appUpdateBodyFrom(form);
    expect(body.proxy_config?.trust_forwarded).toBe(true);
    expect(body.proxy_config?.trusted_proxies).toEqual(['10.0.0.5', '2001:db8::/32']);
    const routeForm = routeFormFromAgentRoute(route(stored));
    routeForm.listenPort = 8081;
    expect(agentRouteBodyFrom(routeForm).proxy_config?.trusted_proxies).toEqual(['10.0.0.5', '2001:db8::/32']);
  });

  test('warnings use the generic warning tone', () => {
    expect(configWarningTone('TRUSTED_PROXIES_UNSET')).toBe('warning');
    expect(configWarningTone('')).toBe('neutral');
  });
});

describe('Cloudflare preset', () => {
  test('the list is valid for the server, without repeats, and within 64 entries', () => {
    expect(CLOUDFLARE_RANGES.length).toBeGreaterThan(0);
    expect(CLOUDFLARE_RANGES.length).toBeLessThanOrEqual(64);
    expect(new Set(CLOUDFLARE_RANGES).size).toBe(CLOUDFLARE_RANGES.length);
    for (const entry of CLOUDFLARE_RANGES) expect(isTrustedProxyEntry(entry)).toBe(true);
    expect(validateTrustedProxies(CLOUDFLARE_RANGES.join('\n'))).toBeNull();
    expect(CLOUDFLARE_RANGES.some((entry) => entry.includes(':'))).toBe(true);
    expect(CLOUDFLARE_RANGES.some((entry) => !entry.includes(':'))).toBe(true);
  });

  test('replaces the list and trusts forwarded headers, and the saved routing carries exactly those entries', () => {
    const form = emptyRouteForm();
    form.proxy.trustedProxies = '10.0.0.5\n192.0.2.0/24';
    form.proxy.rejectInvalidPathEncoding = false;
    form.proxy = withCloudflare(form.proxy);
    expect(form.proxy.trustForwarded).toBe(true);
    expect(trustedProxyList(form.proxy)).toEqual([...CLOUDFLARE_RANGES]);
    expect(validateRouteForm(form, { requireRouting: false })['proxy.trustedProxies']).toBeUndefined();
    const out = proxyConfigFrom(form.proxy);
    expect(out.trust_forwarded).toBe(true);
    expect(out.trusted_proxies).toEqual([...CLOUDFLARE_RANGES]);
    // The other proxy settings stay as they were.
    expect(out.reject_invalid_path_encoding).toBe(false);
  });

  test('asks first only when the list holds an entry that is not Cloudflare\'s', () => {
    expect(holdsOtherProxies('')).toBe(false);
    expect(holdsOtherProxies(' \n\n')).toBe(false);
    expect(holdsOtherProxies(CLOUDFLARE_RANGES.join('\n'))).toBe(false);
    expect(holdsOtherProxies(CLOUDFLARE_RANGES.slice(0, 3).join(', '))).toBe(false);
    expect(holdsOtherProxies('10.0.0.5')).toBe(true);
    expect(holdsOtherProxies(`${CLOUDFLARE_RANGES[0]}\n10.0.0.5`)).toBe(true);
    // An entry that is not an address is still the person's own text.
    expect(holdsOtherProxies('proxy.local')).toBe(true);
  });

  test('the hint carries the date of the copy and the advice to accept only your zone', () => {
    const hint = cloudflareHint();
    expect(hint.startsWith(`Cloudflare's addresses on ${formatDate(CLOUDFLARE_RANGES_DATE)}. `)).toBe(true);
    expect(hint).toContain("Every Cloudflare customer's traffic comes from them, so another Cloudflare account may be able to set the client address WAFio sees.");
    expect(hint).toContain("To accept only your zone, use Authenticated Origin Pulls with your zone's own certificate, or a Cloudflare Tunnel.");
  });
});

describe('script limits', () => {
  test('64 KiB is measured in UTF-8 bytes', () => {
    expect(scriptBytes('é')).toBe(2);
    expect(scriptSizeError('a'.repeat(SCRIPT_MAX_BYTES))).toBeNull();
    expect(scriptSizeError('a'.repeat(SCRIPT_MAX_BYTES + 1))).toContain('64 KiB');
  });

  test('SCRIPT_INVALID keeps the server message and is a script problem', () => {
    const err = ruleSaveError({ error: 'script nests too deeply (max 64)', code: 'SCRIPT_INVALID' });
    expect(err.message).toBe('script nests too deeply (max 64)');
    expect(err.scriptProblem).toBe(true);
    expect(ruleSaveError({ error: 'x', code: 'OTHER' }).scriptProblem).toBe(false);
  });
});
