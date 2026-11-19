/**
 * Typed model of an application's routing: the one form behind "Add
 * application" on a WAF agent, "New application" on Applications and the
 * Routing tab of the application page.
 *
 * Wire formats mirrored here:
 * - handlers/waf_agent.go agentRouteBody (POST/PUT …/agents/:agentId/routes)
 * - handlers/apps.go updateAppBody (PUT …/apps/:appId)
 * - internal/domain/proxyconfig.go ProxyConfig + Validate()
 *
 * Timeouts keep the domain's tri-state: 0 = unset (the agent default
 * applies), -1 = unlimited, >0 = milliseconds.
 */
import type { AgentRoute, AgentRouteBody, App, AppUpdateBody, ProxyConfig } from '../../api';
import { isIP, isIPOrCIDR, parseCIDR, parseList } from '../../validation';

export type UpstreamType = 'http' | 'fcgi';
export type ProtectionMode = 'block' | 'monitor';
export type HostHeaderMode = 'preserve' | 'upstream' | 'custom';

/** One request/response header rule: set a header, or remove one. */
export interface HeaderRule {
  action: 'set' | 'remove';
  name: string;
  value: string;
}

export interface ProxyForm {
  connectMs: number;
  upstreamMs: number;
  readMs: number;
  writeMs: number;
  maxBodyBytes: number;
  readBuf: number;
  writeBuf: number;
  maxConns: number;
  connWaitMs: number;
  idleConnMs: number;
  hostMode: HostHeaderMode;
  hostValue: string;
  /** proxy_config.trust_forwarded; absent or null = false. */
  trustForwarded: boolean;
  /** proxy_config.trusted_proxies as editable text, one IP or CIDR per line. */
  trustedProxies: string;
  /** proxy_config.reject_invalid_path_encoding; missing/null = true. */
  rejectInvalidPathEncoding: boolean;
  reqHeaders: HeaderRule[];
  respHeaders: HeaderRule[];
  /**
   * proxy_config keys this form does not edit (e.g. trusted_proxies from a
   * newer control plane), written back unchanged so a save never drops them.
   */
  extra: Record<string, unknown>;
}

export interface RouteForm {
  name: string;
  upstreamType: UpstreamType;
  /** Address without the `fcgi:` prefix. */
  upstreamAddr: string;
  fcgiDocRoot: string;
  fcgiIndex: string;
  /** Keep the FastCGI connection open between requests (the agent closes it after each reply when off). */
  fcgiKeepConn: boolean;
  /** Bind address (IP); empty = 0.0.0.0. */
  listenHost: string;
  listenPort: number | null;
  mode: ProtectionMode;
  proxy: ProxyForm;
}

export const TIMEOUT_DEFAULT = 0;
export const TIMEOUT_UNLIMITED = -1;

/** Defaults the agent applies when a value is unset (domain/proxyconfig.go). */
export const PROXY_DEFAULTS = Object.freeze({
  upstreamMs: 30_000,
  readMs: 60_000,
  writeMs: 60_000,
  maxBodyBytes: 64 * 1024 * 1024,
  buf: 16_384,
  maxConns: 512,
  connWaitMs: 5_000,
  idleConnMs: 10_000,
});

/** Bounds enforced by ProxyConfig.Validate(). */
export const PROXY_LIMITS = Object.freeze({
  timeoutMaxMs: 600_000,
  bufMin: 1024,
  bufMax: 1_048_576,
  bodyMin: 1024,
  bodyMax: 1_073_741_824,
  connsMin: 1,
  connsMax: 65_535,
  waitMaxMs: 600_000,
  maxHeaderRules: 32,
  maxHeaderBytes: 8192,
  maxTrustedProxies: 64,
});

export const DEFAULT_LISTEN_PORT = 8080;
export const DEFAULT_FCGI_INDEX = 'index.php';

export function defaultProxyForm(): ProxyForm {
  return {
    connectMs: TIMEOUT_DEFAULT,
    upstreamMs: TIMEOUT_DEFAULT,
    readMs: TIMEOUT_DEFAULT,
    writeMs: TIMEOUT_DEFAULT,
    maxBodyBytes: PROXY_DEFAULTS.maxBodyBytes,
    readBuf: PROXY_DEFAULTS.buf,
    writeBuf: PROXY_DEFAULTS.buf,
    maxConns: PROXY_DEFAULTS.maxConns,
    connWaitMs: PROXY_DEFAULTS.connWaitMs,
    idleConnMs: PROXY_DEFAULTS.idleConnMs,
    hostMode: 'preserve',
    hostValue: '',
    // A new route trusts no forwarded header: the socket is the client.
    trustForwarded: false,
    trustedProxies: '',
    rejectInvalidPathEncoding: true,
    reqHeaders: [],
    respHeaders: [],
    extra: {},
  };
}

export function emptyRouteForm(): RouteForm {
  return {
    name: '',
    upstreamType: 'http',
    upstreamAddr: '',
    fcgiDocRoot: '',
    fcgiIndex: DEFAULT_FCGI_INDEX,
    fcgiKeepConn: false,
    listenHost: '',
    listenPort: DEFAULT_LISTEN_PORT,
    mode: 'block',
    proxy: defaultProxyForm(),
  };
}

export function cloneRouteForm(form: RouteForm): RouteForm {
  return {
    ...form,
    proxy: {
      ...form.proxy,
      reqHeaders: form.proxy.reqHeaders.map((r) => ({ ...r })),
      respHeaders: form.proxy.respHeaders.map((r) => ({ ...r })),
      extra: { ...form.proxy.extra },
    },
  };
}

// ── Wire → form ─────────────────────────────────────────────────────────────

/** Splits a stored upstream (`fcgi:unix:/run/php.sock`) into type and address. */
export function parseUpstream(raw: string | null | undefined): { type: UpstreamType; addr: string } {
  const value = (raw ?? '').trim();
  if (value.startsWith('fcgi:')) return { type: 'fcgi', addr: value.slice(5).replace(/^\/\//, '') };
  return { type: 'http', addr: value };
}

function timeoutFrom(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return TIMEOUT_DEFAULT;
  if (value === TIMEOUT_UNLIMITED) return TIMEOUT_UNLIMITED;
  return value > 0 ? Math.round(value) : TIMEOUT_DEFAULT;
}

function positive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}

/** `{add, remove}` → editable rules (set rules sorted by name, then removals). */
export function headerRulesFrom(h: { add?: Record<string, string>; remove?: string[] } | null | undefined): HeaderRule[] {
  if (!h) return [];
  const set = Object.entries(h.add ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => ({ action: 'set' as const, name, value: String(value) }));
  const remove = (h.remove ?? []).map((name) => ({ action: 'remove' as const, name, value: '' }));
  return [...set, ...remove];
}

/** proxy_config keys the routing form edits; any other key is carried in `extra`. */
export const MANAGED_PROXY_KEYS: readonly string[] = Object.freeze([
  'timeouts',
  'max_body_bytes',
  'read_buf',
  'write_buf',
  'max_conns',
  'conn_wait_ms',
  'idle_conn_ms',
  'host_header',
  'req_headers',
  'resp_headers',
  'trust_forwarded',
  'trusted_proxies',
  'reject_invalid_path_encoding',
]);

/**
 * proxy_config keys dropped on save: the migration 000091 marker is replaced
 * by the explicit trust_forwarded the form writes.
 */
export const DROPPED_PROXY_KEYS: readonly string[] = Object.freeze(['_trust_forwarded_backfill']);

function unmanagedProxyKeys(cfg: object): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(cfg)) {
    if (!MANAGED_PROXY_KEYS.includes(key) && !DROPPED_PROXY_KEYS.includes(key)) extra[key] = value;
  }
  return extra;
}

export function proxyFormFrom(pc: ProxyConfig | null | undefined): ProxyForm {
  const cfg = pc && typeof pc === 'object' ? pc : {};
  const mode = cfg.host_header?.mode;
  return {
    connectMs: timeoutFrom(cfg.timeouts?.connect_ms),
    upstreamMs: timeoutFrom(cfg.timeouts?.upstream_ms),
    readMs: timeoutFrom(cfg.timeouts?.read_ms),
    writeMs: timeoutFrom(cfg.timeouts?.write_ms),
    maxBodyBytes: positive(cfg.max_body_bytes, PROXY_DEFAULTS.maxBodyBytes),
    readBuf: positive(cfg.read_buf, PROXY_DEFAULTS.buf),
    writeBuf: positive(cfg.write_buf, PROXY_DEFAULTS.buf),
    maxConns: positive(cfg.max_conns, PROXY_DEFAULTS.maxConns),
    connWaitMs: positive(cfg.conn_wait_ms, PROXY_DEFAULTS.connWaitMs),
    idleConnMs: positive(cfg.idle_conn_ms, PROXY_DEFAULTS.idleConnMs),
    hostMode: mode === 'upstream' || mode === 'custom' ? mode : 'preserve',
    hostValue: cfg.host_header?.value ?? '',
    // Absent or null means not trusted; only explicit true opts in.
    trustForwarded: cfg.trust_forwarded === true,
    trustedProxies: Array.isArray(cfg.trusted_proxies) ? cfg.trusted_proxies.filter((v): v is string => typeof v === 'string').join('\n') : '',
    // Missing or null means on (the agent default); only explicit false opts out.
    rejectInvalidPathEncoding: cfg.reject_invalid_path_encoding !== false,
    reqHeaders: headerRulesFrom(cfg.req_headers),
    respHeaders: headerRulesFrom(cfg.resp_headers),
    extra: unmanagedProxyKeys(cfg),
  };
}

export function routeFormFromAgentRoute(route: AgentRoute): RouteForm {
  const upstream = parseUpstream(route.upstream);
  return {
    name: route.name ?? '',
    upstreamType: upstream.type,
    upstreamAddr: upstream.addr,
    fcgiDocRoot: route.fcgi_doc_root ?? '',
    fcgiIndex: route.fcgi_index || DEFAULT_FCGI_INDEX,
    fcgiKeepConn: route.fcgi_keep_conn === true,
    listenHost: route.listen_host === '0.0.0.0' ? '' : (route.listen_host ?? ''),
    listenPort: route.listen_port > 0 ? route.listen_port : null,
    mode: route.mode === 'monitor' ? 'monitor' : 'block',
    proxy: proxyFormFrom(route.proxy_config),
  };
}

/**
 * The application record as a form. When the app is assigned, its agent
 * route carries the binding mode and the FastCGI fields the app record lacks.
 */
export function routeFormFromApp(app: App, route?: AgentRoute | null): RouteForm {
  if (route) return { ...routeFormFromAgentRoute(route), name: app.name || route.name };
  const upstream = parseUpstream(app.upstream_url);
  const host = app.listen_host ?? '';
  return {
    name: app.name ?? '',
    upstreamType: upstream.type,
    upstreamAddr: upstream.addr,
    fcgiDocRoot: app.fcgi_doc_root ?? '',
    fcgiIndex: app.fcgi_index || DEFAULT_FCGI_INDEX,
    fcgiKeepConn: app.fcgi_keep_conn === true,
    listenHost: host === '0.0.0.0' ? '' : host,
    listenPort: typeof app.listen_port === 'number' && app.listen_port > 0 ? app.listen_port : null,
    mode: 'block',
    proxy: proxyFormFrom(app.proxy_config),
  };
}

// ── Form → wire ─────────────────────────────────────────────────────────────

/** Editable rules → `{add, remove}`; blank rows are skipped. */
export function headerRulesTo(rules: readonly HeaderRule[]): { add: Record<string, string>; remove: string[] } {
  const add: Record<string, string> = {};
  const remove: string[] = [];
  for (const rule of rules) {
    const name = rule.name.trim();
    if (!name) continue;
    if (rule.action === 'remove') {
      if (!remove.includes(name)) remove.push(name);
    } else {
      add[name] = rule.value.trim();
    }
  }
  return { add, remove };
}

/** Form → proxy_config: unmanaged keys first, then every key the form edits. */
export function proxyConfigFrom(p: ProxyForm): ProxyConfig {
  return {
    ...(p.extra ?? {}),
    timeouts: {
      connect_ms: p.connectMs,
      upstream_ms: p.upstreamMs,
      read_ms: p.readMs,
      write_ms: p.writeMs,
    },
    max_body_bytes: p.maxBodyBytes,
    read_buf: p.readBuf,
    write_buf: p.writeBuf,
    max_conns: p.maxConns,
    conn_wait_ms: p.connWaitMs,
    idle_conn_ms: p.idleConnMs,
    host_header: { mode: p.hostMode, value: p.hostMode === 'custom' ? p.hostValue.trim() : '' },
    req_headers: headerRulesTo(p.reqHeaders),
    resp_headers: headerRulesTo(p.respHeaders),
    trust_forwarded: p.trustForwarded,
    trusted_proxies: trustedProxyList(p),
    reject_invalid_path_encoding: p.rejectInvalidPathEncoding,
  };
}

/** Shortest prefix the server accepts for a trusted proxy: /8 for IPv4, /16 for IPv6. */
export const TRUSTED_PROXY_MIN_PREFIX = { 4: 8, 6: 16 } as const;

/** True when entry is a CIDR broader than the server allows (e.g. /0, 0.0.0.0/1). */
function isTooBroad(entry: string): boolean {
  const cidr = parseCIDR(entry);
  return cidr !== null && cidr.prefix < TRUSTED_PROXY_MIN_PREFIX[cidr.version];
}

/** A trusted-proxy entry the server accepts: an IP, or a CIDR of at least /8 (IPv4) or /16 (IPv6). */
export function isTrustedProxyEntry(entry: string): boolean {
  return isIPOrCIDR(entry) && !isTooBroad(entry);
}

/**
 * Entries to save. With trust off the field is locked, so only valid entries
 * are kept (the server warns TRUSTED_PROXIES_IGNORED) and a stale bad entry
 * cannot block the save.
 */
export function trustedProxyList(p: Pick<ProxyForm, 'trustForwarded' | 'trustedProxies'>): string[] {
  const entries = parseList(p.trustedProxies ?? '');
  return p.trustForwarded ? entries : entries.filter(isTrustedProxyEntry);
}

/** Problem with the trusted-proxy list, or null. */
export function validateTrustedProxies(text: string): string | null {
  const entries = parseList(text ?? '');
  if (entries.length > PROXY_LIMITS.maxTrustedProxies) return `At most ${PROXY_LIMITS.maxTrustedProxies} trusted proxies.`;
  const broad = entries.find((e) => isIPOrCIDR(e) && isTooBroad(e));
  if (broad) return `"${broad}" is too broad (at least /8 for IPv4, /16 for IPv6); list the proxies' own addresses.`;
  const bad = entries.filter((e) => !isIPOrCIDR(e));
  if (bad.length) return `Not an IP address or CIDR: ${bad.slice(0, 3).join(', ')}${bad.length > 3 ? ` and ${bad.length - 3} more` : ''}.`;
  return null;
}

/**
 * Field of a 400 INVALID_PROXY_CONFIG message such as
 * `trusted_proxies[2]: "x" is not an IP address or CIDR`, or null.
 */
export function proxyErrorField(message: string | null | undefined): RouteField | null {
  if (!message) return null;
  if (/^trusted_proxies\b/.test(message.trim())) return 'proxy.trustedProxies';
  return null;
}

/** Stored upstream string: `fcgi:` + address for FastCGI. */
export function upstreamFrom(form: Pick<RouteForm, 'upstreamType' | 'upstreamAddr'>): string {
  const addr = form.upstreamAddr.trim();
  if (!addr) return '';
  if (form.upstreamType === 'fcgi') return 'fcgi:' + addr.replace(/^fcgi:/, '');
  return addr;
}

/**
 * FastCGI fields of a route body. The handlers patch only the fields sent
 * (absent = keep the stored value, an empty index = index.php), so an empty
 * document root is left out instead of clearing the stored one.
 */
function fcgiFields(form: RouteForm): { fcgi_doc_root?: string; fcgi_index?: string; fcgi_keep_conn?: boolean } {
  if (form.upstreamType !== 'fcgi') return {};
  const docRoot = form.fcgiDocRoot.trim();
  return {
    ...(docRoot ? { fcgi_doc_root: docRoot } : {}),
    fcgi_index: form.fcgiIndex.trim() || DEFAULT_FCGI_INDEX,
    fcgi_keep_conn: form.fcgiKeepConn,
  };
}

/** Body of POST/PUT …/agents/:agentId/routes[/:appId]. */
export function agentRouteBodyFrom(form: RouteForm): AgentRouteBody {
  return {
    name: form.name.trim(),
    listen_host: form.listenHost.trim() || '0.0.0.0',
    listen_port: form.listenPort ?? 0,
    upstream: upstreamFrom(form),
    mode: form.mode,
    proxy_config: proxyConfigFrom(form.proxy),
    ...fcgiFields(form),
  };
}

/** Body of PUT …/apps/:appId (handlers/apps.go updateAppBody); defined in api.ts. */
export type { AppUpdateBody };

/**
 * FastCGI fields are patched one by one (absent = keep the stored value). An
 * empty document root is left out; with no document root the index is sent
 * only when it is not the default, because control planes before 2026-09-27
 * did not return either field from GET …/apps/:appId and the form then shows
 * the default for an index it does not know.
 */
export function appUpdateBodyFrom(form: RouteForm): AppUpdateBody {
  const fcgi = fcgiFields(form);
  if (!fcgi.fcgi_doc_root && fcgi.fcgi_index === DEFAULT_FCGI_INDEX) delete fcgi.fcgi_index;
  const body: AppUpdateBody = {
    name: form.name.trim(),
    proxy_config: proxyConfigFrom(form.proxy),
    ...fcgi,
  };
  if (form.listenHost.trim()) body.listen_host = form.listenHost.trim();
  if (form.listenPort) body.listen_port = form.listenPort;
  const upstream = upstreamFrom(form);
  if (upstream) body.upstream_url = upstream;
  return body;
}

/** Body of POST …/apps (handlers/apps.go createAppBody: name, listen_host, upstream_url). */
export function appCreateBodyFrom(form: RouteForm): { name: string; listen_host?: string; upstream_url?: string } {
  const body: { name: string; listen_host?: string; upstream_url?: string } = { name: form.name.trim() };
  if (form.listenHost.trim()) body.listen_host = form.listenHost.trim();
  const upstream = upstreamFrom(form);
  if (upstream) body.upstream_url = upstream;
  return body;
}

/** True when the form holds settings POST …/apps cannot carry (a follow-up PUT sends them). */
export function needsAppUpdateAfterCreate(form: RouteForm): boolean {
  const defaults = proxyConfigFrom(defaultProxyForm());
  return (
    form.listenPort !== null ||
    form.upstreamType === 'fcgi' ||
    JSON.stringify(proxyConfigFrom(form.proxy)) !== JSON.stringify(defaults)
  );
}

// ── Validation ──────────────────────────────────────────────────────────────

export type RouteField =
  | 'name'
  | 'upstreamAddr'
  | 'fcgiDocRoot'
  | 'fcgiIndex'
  | 'listenHost'
  | 'listenPort'
  | 'proxy.connectMs'
  | 'proxy.upstreamMs'
  | 'proxy.readMs'
  | 'proxy.writeMs'
  | 'proxy.maxBodyBytes'
  | 'proxy.readBuf'
  | 'proxy.writeBuf'
  | 'proxy.maxConns'
  | 'proxy.connWaitMs'
  | 'proxy.idleConnMs'
  | 'proxy.hostValue'
  | 'proxy.trustedProxies'
  | 'proxy.reqHeaders'
  | 'proxy.respHeaders';

export type RouteErrors = Partial<Record<RouteField, string>>;

export const ROUTE_FIELD_LABELS: Record<RouteField, string> = {
  name: 'Name',
  upstreamAddr: 'Upstream',
  fcgiDocRoot: 'Document root',
  fcgiIndex: 'Index file',
  listenHost: 'Listen address',
  listenPort: 'Listen port',
  'proxy.connectMs': 'Connect timeout',
  'proxy.upstreamMs': 'Upstream timeout',
  'proxy.readMs': 'Read timeout',
  'proxy.writeMs': 'Write timeout',
  'proxy.maxBodyBytes': 'Max body size',
  'proxy.readBuf': 'Read buffer',
  'proxy.writeBuf': 'Write buffer',
  'proxy.maxConns': 'Max upstream connections',
  'proxy.connWaitMs': 'Connection wait timeout',
  'proxy.idleConnMs': 'Idle connection timeout',
  'proxy.hostValue': 'Custom Host value',
  'proxy.trustedProxies': 'Trusted proxies',
  'proxy.reqHeaders': 'Request headers',
  'proxy.respHeaders': 'Response headers',
};

/** Only [A-Za-z0-9-] (domain validHeaderName). */
export function isProxyHeaderName(name: string): boolean {
  return /^[A-Za-z0-9-]+$/.test(name);
}

const HOST_PORT = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/;

/** HTTP upstream: http(s) URL with a host, or a unix socket (`unix:/path`). */
export function validateHttpUpstream(value: string): string | null {
  const v = value.trim();
  if (/\s/.test(v)) return 'Upstream must not contain spaces.';
  if (v.startsWith('unix:') || v.startsWith('http://unix:') || v.startsWith('https://unix:')) {
    return /unix:\/./.test(v) ? null : 'A unix socket upstream needs an absolute path, e.g. unix:/run/app.sock.';
  }
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return 'Upstream must be an http:// or https:// URL, or unix:/path/to.sock.';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'Upstream must use http, https or a unix socket.';
  if (!url.hostname) return 'Upstream URL must include a host.';
  if (url.username || url.password) return 'Upstream URL must not contain credentials.';
  return null;
}

/** FastCGI address: `unix:/path` or `host:port`. */
export function validateFcgiUpstream(value: string): string | null {
  const v = value.trim().replace(/^fcgi:/, '').replace(/^\/\//, '');
  if (/\s/.test(v)) return 'FastCGI address must not contain spaces.';
  if (v.startsWith('unix:')) return /^unix:\/./.test(v) ? null : 'A unix socket needs an absolute path, e.g. unix:/run/php/php-fpm.sock.';
  const match = HOST_PORT.exec(v);
  if (!match) return 'FastCGI address must be unix:/path/to.sock or host:port, e.g. 127.0.0.1:9000.';
  const port = Number(match[2]);
  return port >= 1 && port <= 65_535 ? null : 'FastCGI port must be between 1 and 65535.';
}

function timeoutError(value: number, label: string): string | null {
  if (!Number.isInteger(value)) return `${label} must be a whole number of milliseconds.`;
  if (value === TIMEOUT_UNLIMITED || value === TIMEOUT_DEFAULT) return null;
  if (value < 0 || value > PROXY_LIMITS.timeoutMaxMs) return `${label} must be at most 10 minutes (600000 ms).`;
  return null;
}

function rangeError(value: number, lo: number, hi: number, label: string, unit = ''): string | null {
  if (!Number.isInteger(value) || value < lo || value > hi) return `${label} must be between ${lo}${unit} and ${hi}${unit}.`;
  return null;
}

/** First problem of a header rule list, or null. */
export function validateHeaderRules(rules: readonly HeaderRule[]): string | null {
  const used = rules.filter((r) => r.name.trim() !== '' || r.value.trim() !== '');
  if (used.length > PROXY_LIMITS.maxHeaderRules) return `At most ${PROXY_LIMITS.maxHeaderRules} header rules.`;
  let bytes = 0;
  const setNames = new Set<string>();
  for (const [index, rule] of used.entries()) {
    const name = rule.name.trim();
    const row = `Rule ${index + 1}`;
    if (!name) return `${row}: enter a header name.`;
    if (!isProxyHeaderName(name)) return `${row}: "${name}" is not a valid header name (letters, digits and "-" only).`;
    if (rule.action === 'set') {
      if (name.toLowerCase() === 'host') return `${row}: set Host with the Host header option, not a header rule.`;
      if (/[\r\n]/.test(rule.value)) return `${row}: the value must not contain line breaks.`;
      const key = name.toLowerCase();
      if (setNames.has(key)) return `${row}: "${name}" is set twice.`;
      setNames.add(key);
      bytes += name.length + rule.value.trim().length;
    } else {
      bytes += name.length;
    }
  }
  if (bytes > PROXY_LIMITS.maxHeaderBytes) return `Header rules are too large (at most ${PROXY_LIMITS.maxHeaderBytes} bytes).`;
  return null;
}

export interface ValidateRouteOptions {
  /**
   * Upstream and listen port are required for a route served by an agent.
   * An unassigned application may be saved as a draft without them.
   */
  requireRouting?: boolean;
}

export function validateRouteForm(form: RouteForm, opts: ValidateRouteOptions = {}): RouteErrors {
  const requireRouting = opts.requireRouting ?? true;
  const errors: RouteErrors = {};
  const name = form.name.trim();
  if (!name) errors.name = 'Enter a name.';
  else if (name.length < 2 || name.length > 64) errors.name = 'Name must be 2–64 characters.';

  const addr = form.upstreamAddr.trim();
  if (!addr) {
    if (requireRouting) errors.upstreamAddr = form.upstreamType === 'fcgi' ? 'Enter the FastCGI address.' : 'Enter the upstream URL.';
  } else {
    const problem = form.upstreamType === 'fcgi' ? validateFcgiUpstream(addr) : validateHttpUpstream(addr);
    if (problem) errors.upstreamAddr = problem;
    else if (addr.length > 512) errors.upstreamAddr = 'Upstream must be at most 512 characters.';
  }
  if (form.upstreamType === 'fcgi') {
    const root = form.fcgiDocRoot.trim();
    if (!root) {
      if (requireRouting) errors.fcgiDocRoot = 'Enter the document root (SCRIPT_FILENAME base path).';
    } else if (!root.startsWith('/')) errors.fcgiDocRoot = 'Document root must be an absolute path, e.g. /var/www/html.';
    else if (root.length > 512) errors.fcgiDocRoot = 'Document root must be at most 512 characters.';
    const index = form.fcgiIndex.trim();
    if (index && (index.includes('/') || index.length > 128)) errors.fcgiIndex = 'Index file is a file name such as index.php.';
  }

  const host = form.listenHost.trim();
  if (host && !isIP(host)) errors.listenHost = 'Listen address must be an IP address, e.g. 0.0.0.0 or 127.0.0.1.';
  if (form.listenPort === null || Number.isNaN(form.listenPort)) {
    if (requireRouting) errors.listenPort = 'Enter the listen port.';
  } else if (!Number.isInteger(form.listenPort) || form.listenPort < 1 || form.listenPort > 65_535) {
    errors.listenPort = 'Listen port must be between 1 and 65535.';
  }

  const p = form.proxy;
  const timeouts: [RouteField, number][] = [
    ['proxy.connectMs', p.connectMs],
    ['proxy.upstreamMs', p.upstreamMs],
    ['proxy.readMs', p.readMs],
    ['proxy.writeMs', p.writeMs],
  ];
  for (const [field, value] of timeouts) {
    const problem = timeoutError(value, ROUTE_FIELD_LABELS[field]);
    if (problem) errors[field] = problem;
  }
  const L = PROXY_LIMITS;
  const ranges: [RouteField, number, number, number, string][] = [
    ['proxy.maxBodyBytes', p.maxBodyBytes, L.bodyMin, L.bodyMax, ' bytes'],
    ['proxy.readBuf', p.readBuf, L.bufMin, L.bufMax, ' bytes'],
    ['proxy.writeBuf', p.writeBuf, L.bufMin, L.bufMax, ' bytes'],
    ['proxy.maxConns', p.maxConns, L.connsMin, L.connsMax, ''],
    ['proxy.connWaitMs', p.connWaitMs, 0, L.waitMaxMs, ' ms'],
    ['proxy.idleConnMs', p.idleConnMs, 0, L.waitMaxMs, ' ms'],
  ];
  for (const [field, value, lo, hi, unit] of ranges) {
    const problem = rangeError(value, lo, hi, ROUTE_FIELD_LABELS[field], unit);
    if (problem) errors[field] = problem;
  }
  if (p.hostMode === 'custom') {
    if (!p.hostValue.trim()) errors['proxy.hostValue'] = 'Enter the Host value to send upstream.';
    else if (/[\r\n]/.test(p.hostValue)) errors['proxy.hostValue'] = 'Host value must not contain line breaks.';
  }
  if (p.trustForwarded) {
    const proxies = validateTrustedProxies(p.trustedProxies);
    if (proxies) errors['proxy.trustedProxies'] = proxies;
  }
  const req = validateHeaderRules(p.reqHeaders);
  if (req) errors['proxy.reqHeaders'] = req;
  const resp = validateHeaderRules(p.respHeaders);
  if (resp) errors['proxy.respHeaders'] = resp;
  return errors;
}

/** Errors in field order, for a summary list. */
export function routeErrorList(errors: RouteErrors): { field: RouteField; label: string; message: string }[] {
  return (Object.keys(ROUTE_FIELD_LABELS) as RouteField[])
    .filter((field) => errors[field])
    .map((field) => ({ field, label: ROUTE_FIELD_LABELS[field], message: errors[field] as string }));
}

/** True when any advanced (proxy) field has an error, the section must open. */
export function hasProxyErrors(errors: RouteErrors): boolean {
  return Object.keys(errors).some((key) => key.startsWith('proxy.'));
}

/** Short description of the listen address, e.g. "0.0.0.0:8080". */
export function listenLabel(host: string | null | undefined, port: number | null | undefined): string {
  const h = (host ?? '').trim() || '0.0.0.0';
  if (!port) return h;
  return h.includes(':') ? `[${h}]:${port}` : `${h}:${port}`;
}

/** Protection-mode consequence text shown next to the choice. */
export const PROTECTION_MODE_TEXT: Record<ProtectionMode, { label: string; consequence: string }> = {
  block: {
    label: 'Block',
    consequence: 'Requests with a strong detection are rejected before they reach the application.',
  },
  monitor: {
    label: 'Monitor',
    consequence: 'Every request is forwarded to the application. Attacks are only logged; nothing is blocked.',
  },
};
