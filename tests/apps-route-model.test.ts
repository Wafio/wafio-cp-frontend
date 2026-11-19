// Route form model: one typed model for create and edit,
// mirroring handlers/waf_agent.go, handlers/apps.go and domain/proxyconfig.go.
import { describe, expect, test } from 'bun:test';
import type { AgentRoute, App } from '../src/lib/api';
import {
  PROXY_DEFAULTS,
  TIMEOUT_UNLIMITED,
  agentRouteBodyFrom,
  appCreateBodyFrom,
  appUpdateBodyFrom,
  cloneRouteForm,
  emptyRouteForm,
  hasProxyErrors,
  headerRulesFrom,
  headerRulesTo,
  listenLabel,
  needsAppUpdateAfterCreate,
  parseUpstream,
  proxyConfigFrom,
  proxyFormFrom,
  routeErrorList,
  routeFormFromAgentRoute,
  routeFormFromApp,
  validateFcgiUpstream,
  validateHeaderRules,
  validateHttpUpstream,
  validateRouteForm,
} from '../src/lib/components/apps/route-model';
import { bytesFromInput, bytesToInput, durationFromParts, durationParts } from '../src/lib/components/apps/inputs';

describe('duration and byte inputs', () => {
  test('durations pick the largest exact unit and parse back', () => {
    expect(durationParts(0)).toEqual({ amount: '', unit: 's' });
    expect(durationParts(-1)).toEqual({ amount: '', unit: 's' });
    expect(durationParts(30_000)).toEqual({ amount: '30', unit: 's' });
    expect(durationParts(120_000)).toEqual({ amount: '2', unit: 'min' });
    expect(durationParts(1500)).toEqual({ amount: '1500', unit: 'ms' });
    expect(durationFromParts('', 's')).toBe(0);
    expect(durationFromParts('1.5', 's')).toBe(1500);
    expect(durationFromParts('2', 'min')).toBe(120_000);
    expect(Number.isNaN(durationFromParts('-3', 's'))).toBe(true);
    expect(Number.isNaN(durationFromParts('0.0001', 's'))).toBe(true);
    expect(Number.isNaN(durationFromParts('abc', 'ms'))).toBe(true);
  });

  test('byte sizes show exact binary units and accept typed units', () => {
    expect(bytesToInput(64 * 1024 * 1024)).toBe('64 MiB');
    expect(bytesToInput(16384)).toBe('16 KiB');
    expect(bytesToInput(1500)).toBe('1500');
    expect(bytesToInput(1024 ** 3)).toBe('1 GiB');
    expect(bytesFromInput('10 MB')).toBe(10 * 1024 * 1024);
    expect(bytesFromInput('512KiB')).toBe(512 * 1024);
    expect(Number.isNaN(bytesFromInput('ten'))).toBe(true);
  });
});

const route: AgentRoute = {
  app_id: 'app-1',
  name: 'checkout',
  listen_host: '0.0.0.0',
  listen_port: 8086,
  upstream: 'fcgi:unix:/run/php/php-fpm.sock',
  mode: 'monitor',
  fcgi_doc_root: '/var/www/html',
  fcgi_index: 'app.php',
  proxy_config: {
    timeouts: { connect_ms: 0, upstream_ms: -1, read_ms: 45000, write_ms: 0 },
    max_body_bytes: 1048576,
    max_conns: 64,
    host_header: { mode: 'custom', value: 'shop.example.com' },
    req_headers: { add: { 'X-B': '2', 'X-A': '1' }, remove: ['X-Powered-By'] },
    trust_forwarded: false,
  },
};

describe('wire → form', () => {
  test('parseUpstream splits the FastCGI prefix', () => {
    expect(parseUpstream('fcgi:127.0.0.1:9000')).toEqual({ type: 'fcgi', addr: '127.0.0.1:9000' });
    expect(parseUpstream('fcgi://127.0.0.1:9000')).toEqual({ type: 'fcgi', addr: '127.0.0.1:9000' });
    expect(parseUpstream('http://127.0.0.1:3000')).toEqual({ type: 'http', addr: 'http://127.0.0.1:3000' });
    expect(parseUpstream(null)).toEqual({ type: 'http', addr: '' });
  });

  test('an agent route becomes a typed form', () => {
    const form = routeFormFromAgentRoute(route);
    expect(form.upstreamType).toBe('fcgi');
    expect(form.upstreamAddr).toBe('unix:/run/php/php-fpm.sock');
    expect(form.listenHost).toBe('');
    expect(form.listenPort).toBe(8086);
    expect(form.mode).toBe('monitor');
    expect(form.fcgiIndex).toBe('app.php');
    expect(form.proxy.upstreamMs).toBe(TIMEOUT_UNLIMITED);
    expect(form.proxy.readMs).toBe(45000);
    expect(form.proxy.writeMs).toBe(0);
    expect(form.proxy.readBuf).toBe(PROXY_DEFAULTS.buf);
    expect(form.proxy.trustForwarded).toBe(false);
    expect(form.proxy.hostMode).toBe('custom');
    expect(form.proxy.reqHeaders.map((r) => `${r.action}:${r.name}`)).toEqual(['set:X-A', 'set:X-B', 'remove:X-Powered-By']);
  });

  test('absent or null trust_forwarded means not trusted; unknown host modes preserve', () => {
    expect(proxyFormFrom(undefined).trustForwarded).toBe(false);
    expect(proxyFormFrom({ trust_forwarded: null }).trustForwarded).toBe(false);
    expect(proxyFormFrom({ trust_forwarded: true }).trustForwarded).toBe(true);
    expect(proxyFormFrom({ host_header: { mode: 'weird' as 'preserve' } }).hostMode).toBe('preserve');
  });

  test('an unassigned app uses its own record', () => {
    const app: App = {
      id: 'app-2',
      project_id: 'p',
      name: 'api',
      upstream_url: 'http://10.0.0.5:3000',
      listen_host: '127.0.0.1',
      listen_port: null,
      created_at: '',
      updated_at: '',
    };
    const form = routeFormFromApp(app);
    expect(form.name).toBe('api');
    expect(form.listenHost).toBe('127.0.0.1');
    expect(form.listenPort).toBeNull();
    expect(form.upstreamType).toBe('http');
    expect(routeFormFromApp({ ...app, name: 'renamed' }, route).name).toBe('renamed');
    expect(routeFormFromApp(app, route).fcgiDocRoot).toBe('/var/www/html');
    // Older control planes omit the FastCGI fields: unknown root, default index.
    expect(form.fcgiDocRoot).toBe('');
    expect(form.fcgiIndex).toBe('index.php');
  });

  test('an unassigned FastCGI app shows its stored document root', () => {
    const app: App = {
      id: 'app-3',
      project_id: 'p',
      name: 'php',
      upstream_url: 'fcgi:127.0.0.1:9000',
      fcgi_doc_root: '/srv/www',
      fcgi_index: '',
      created_at: '',
      updated_at: '',
    };
    const form = routeFormFromApp(app);
    expect(form.upstreamType).toBe('fcgi');
    expect(form.fcgiDocRoot).toBe('/srv/www');
    expect(form.fcgiIndex).toBe('index.php');
    expect(appUpdateBodyFrom(form).fcgi_doc_root).toBe('/srv/www');
  });

  test('an index-only change sends the index and no empty document root', () => {
    const app: App = {
      id: 'app-4',
      project_id: 'p',
      name: 'php',
      upstream_url: 'fcgi:127.0.0.1:9000',
      created_at: '',
      updated_at: '',
    };
    const form = routeFormFromApp(app);
    form.fcgiIndex = 'app.php';
    const body = appUpdateBodyFrom(form);
    expect(body).not.toHaveProperty('fcgi_doc_root');
    expect(body.fcgi_index).toBe('app.php');
  });

  test('FastCGI connection reuse is off unless the stored value is true', () => {
    const app: App = {
      id: 'app-5',
      project_id: 'p',
      name: 'php',
      upstream_url: 'fcgi:127.0.0.1:9000',
      created_at: '',
      updated_at: '',
    };
    expect(emptyRouteForm().fcgiKeepConn).toBe(false);
    expect(routeFormFromApp(app).fcgiKeepConn).toBe(false);
    expect(routeFormFromApp({ ...app, fcgi_keep_conn: false }).fcgiKeepConn).toBe(false);
    expect(routeFormFromApp({ ...app, fcgi_keep_conn: true }).fcgiKeepConn).toBe(true);
    expect(routeFormFromAgentRoute(route).fcgiKeepConn).toBe(false);
    expect(routeFormFromAgentRoute({ ...route, fcgi_keep_conn: true }).fcgiKeepConn).toBe(true);
    expect(routeFormFromApp(app, { ...route, fcgi_keep_conn: true }).fcgiKeepConn).toBe(true);
  });
});

describe('form → wire', () => {
  test('agent route body round-trips and adds the FastCGI prefix', () => {
    const body = agentRouteBodyFrom(routeFormFromAgentRoute(route));
    expect(body.upstream).toBe('fcgi:unix:/run/php/php-fpm.sock');
    expect(body.listen_host).toBe('0.0.0.0');
    expect(body.listen_port).toBe(8086);
    expect(body.mode).toBe('monitor');
    expect(body.fcgi_doc_root).toBe('/var/www/html');
    expect(body.fcgi_index).toBe('app.php');
    expect(body.proxy_config?.timeouts).toEqual({ connect_ms: 0, upstream_ms: -1, read_ms: 45000, write_ms: 0 });
    expect(body.proxy_config?.req_headers).toEqual({ add: { 'X-A': '1', 'X-B': '2' }, remove: ['X-Powered-By'] });
    expect(body.proxy_config?.host_header).toEqual({ mode: 'custom', value: 'shop.example.com' });
    expect(body.proxy_config?.trust_forwarded).toBe(false);
  });

  test('HTTP routes carry no FastCGI fields and a non-custom host sends no value', () => {
    const form = emptyRouteForm();
    form.name = 'api';
    form.upstreamAddr = 'http://127.0.0.1:3000';
    form.proxy.hostValue = 'stale';
    const body = agentRouteBodyFrom(form);
    expect('fcgi_doc_root' in body).toBe(false);
    expect(body.proxy_config?.host_header).toEqual({ mode: 'preserve', value: '' });
  });

  test('FastCGI bodies carry fcgi_keep_conn, HTTP bodies do not', () => {
    const fcgi = routeFormFromAgentRoute({ ...route, fcgi_keep_conn: true });
    expect(agentRouteBodyFrom(fcgi).fcgi_keep_conn).toBe(true);
    expect(appUpdateBodyFrom(fcgi).fcgi_keep_conn).toBe(true);
    fcgi.fcgiKeepConn = false;
    expect(agentRouteBodyFrom(fcgi).fcgi_keep_conn).toBe(false);
    expect(appUpdateBodyFrom(fcgi).fcgi_keep_conn).toBe(false);

    const http = routeFormFromAgentRoute({ ...route, upstream: 'http://127.0.0.1:3000', fcgi_keep_conn: true });
    expect(agentRouteBodyFrom(http)).not.toHaveProperty('fcgi_keep_conn');
    expect(appUpdateBodyFrom(http)).not.toHaveProperty('fcgi_keep_conn');
  });

  test('app bodies omit empty routing and flag a follow-up update', () => {
    const form = emptyRouteForm();
    form.name = 'draft';
    form.listenPort = null;
    expect(appCreateBodyFrom(form)).toEqual({ name: 'draft' });
    expect(needsAppUpdateAfterCreate(form)).toBe(false);
    form.listenPort = 8080;
    expect(needsAppUpdateAfterCreate(form)).toBe(true);
    const update = appUpdateBodyFrom(form);
    expect(update.listen_port).toBe(8080);
    expect(update.upstream_url).toBeUndefined();
    expect(update.listen_host).toBeUndefined();
  });

  test('header rules skip blank rows and dedupe removals', () => {
    expect(
      headerRulesTo([
        { action: 'set', name: ' X-A ', value: ' 1 ' },
        { action: 'remove', name: 'Server', value: '' },
        { action: 'remove', name: 'Server', value: '' },
        { action: 'set', name: '', value: 'x' },
      ]),
    ).toEqual({ add: { 'X-A': '1' }, remove: ['Server'] });
    expect(headerRulesFrom(undefined)).toEqual([]);
  });

  test('clone is deep for header rules', () => {
    const form = routeFormFromAgentRoute(route);
    const copy = cloneRouteForm(form);
    copy.proxy.reqHeaders[0].name = 'changed';
    expect(form.proxy.reqHeaders[0].name).toBe('X-A');
  });

  test('proxyConfigFrom keeps the unlimited sentinel', () => {
    const form = emptyRouteForm();
    form.proxy.upstreamMs = TIMEOUT_UNLIMITED;
    expect(proxyConfigFrom(form.proxy).timeouts?.upstream_ms).toBe(-1);
  });
});

describe('validation', () => {
  function valid() {
    const form = emptyRouteForm();
    form.name = 'checkout';
    form.upstreamAddr = 'http://127.0.0.1:3000';
    return form;
  }

  test('a complete route is valid', () => {
    expect(validateRouteForm(valid())).toEqual({});
  });

  test('required fields and bounds', () => {
    const form = valid();
    form.name = '';
    form.upstreamAddr = '';
    form.listenPort = 70000;
    form.listenHost = 'api.example.com';
    const errors = validateRouteForm(form);
    expect(Object.keys(errors).sort()).toEqual(['listenHost', 'listenPort', 'name', 'upstreamAddr']);
    expect(routeErrorList(errors).map((e) => e.field)).toEqual(['name', 'upstreamAddr', 'listenHost', 'listenPort']);
  });

  test('drafts may omit upstream and port', () => {
    const form = valid();
    form.upstreamAddr = '';
    form.listenPort = null;
    expect(validateRouteForm(form, { requireRouting: false })).toEqual({});
    expect(validateRouteForm(form).listenPort).toBeTruthy();
  });

  test('IPv6 listen addresses are accepted', () => {
    const form = valid();
    form.listenHost = '::';
    expect(validateRouteForm(form).listenHost).toBeUndefined();
    expect(listenLabel('::', 8080)).toBe('[::]:8080');
    expect(listenLabel('', 8080)).toBe('0.0.0.0:8080');
  });

  test('upstream syntax per type', () => {
    expect(validateHttpUpstream('http://127.0.0.1:3000')).toBeNull();
    expect(validateHttpUpstream('unix:/run/app.sock')).toBeNull();
    expect(validateHttpUpstream('ftp://x')).toBeTruthy();
    expect(validateHttpUpstream('127.0.0.1:3000')).toBeTruthy();
    expect(validateHttpUpstream('http://user:pw@host')).toBeTruthy();
    expect(validateFcgiUpstream('127.0.0.1:9000')).toBeNull();
    expect(validateFcgiUpstream('unix:/run/php/php-fpm.sock')).toBeNull();
    expect(validateFcgiUpstream('php-fpm')).toBeTruthy();
    expect(validateFcgiUpstream('127.0.0.1:99999')).toBeTruthy();
  });

  test('FastCGI needs an absolute document root', () => {
    const form = valid();
    form.upstreamType = 'fcgi';
    form.upstreamAddr = '127.0.0.1:9000';
    expect(validateRouteForm(form).fcgiDocRoot).toBeTruthy();
    form.fcgiDocRoot = 'var/www';
    expect(validateRouteForm(form).fcgiDocRoot).toContain('absolute');
    form.fcgiDocRoot = '/var/www';
    expect(validateRouteForm(form)).toEqual({});
  });

  test('an unassigned FastCGI app keeps its unknown document root', () => {
    // GET …/apps/:appId has no FastCGI fields: an empty root is "unchanged",
    // never an empty value that overwrites the stored one.
    const form = valid();
    form.upstreamType = 'fcgi';
    form.upstreamAddr = 'unix:/run/php/php-fpm.sock';
    form.fcgiDocRoot = '';
    expect(validateRouteForm(form, { requireRouting: false }).fcgiDocRoot).toBeUndefined();
    const body = appUpdateBodyFrom(form);
    expect(body.fcgi_doc_root).toBeUndefined();
    expect(body.fcgi_index).toBeUndefined();
    expect(body.upstream_url).toBe('fcgi:unix:/run/php/php-fpm.sock');
    form.fcgiDocRoot = '/srv/www';
    expect(appUpdateBodyFrom(form)).toMatchObject({ fcgi_doc_root: '/srv/www', fcgi_index: 'index.php' });
  });

  test('proxy bounds mirror ProxyConfig.Validate', () => {
    const form = valid();
    form.proxy.readBuf = 512;
    form.proxy.maxBodyBytes = 2 * 1024 * 1024 * 1024;
    form.proxy.upstreamMs = 700_000;
    form.proxy.connectMs = TIMEOUT_UNLIMITED;
    form.proxy.maxConns = 0;
    form.proxy.hostMode = 'custom';
    const errors = validateRouteForm(form);
    expect(Object.keys(errors).sort()).toEqual([
      'proxy.hostValue',
      'proxy.maxBodyBytes',
      'proxy.maxConns',
      'proxy.readBuf',
      'proxy.upstreamMs',
    ]);
    expect(hasProxyErrors(errors)).toBe(true);
  });

  test('header rules: names, Host, CR/LF, duplicates and count', () => {
    expect(validateHeaderRules([{ action: 'set', name: 'X-Ok', value: '1' }])).toBeNull();
    expect(validateHeaderRules([{ action: 'set', name: 'X Bad', value: '1' }])).toContain('not a valid header name');
    expect(validateHeaderRules([{ action: 'set', name: 'Host', value: 'x' }])).toContain('Host');
    expect(validateHeaderRules([{ action: 'set', name: 'X-A', value: 'a\r\nb' }])).toContain('line breaks');
    expect(validateHeaderRules([{ action: 'set', name: 'X-A', value: '1' }, { action: 'set', name: 'x-a', value: '2' }])).toContain('twice');
    expect(validateHeaderRules([{ action: 'set', name: '', value: 'v' }])).toContain('header name');
    const many = Array.from({ length: 33 }, (_, i) => ({ action: 'remove' as const, name: `X-${i}`, value: '' }));
    expect(validateHeaderRules(many)).toContain('At most 32');
    expect(validateHeaderRules([{ action: 'set', name: 'X-Big', value: 'v'.repeat(9000) }])).toContain('too large');
  });
});
