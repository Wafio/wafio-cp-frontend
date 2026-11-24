/**
 * HTTPS tab of an application: the checks the control plane makes on the settings (same field keys and
 * texts, never stricter), certificate dates and statuses, how often to poll, and the sending of an
 * uploaded certificate. Pure functions, no component state.
 */
import type {
  ApiError,
  ApiResult,
  AppTLSCertificate,
  AppTLSCertificateInput,
  AppTLSInput,
  AppTLSState,
  AppTLSStatus,
  AppTLSWarning,
  TLSMode,
  TLSSource,
} from '../../api';
import { formatDate } from '../../format';
import { ipToBytes, isIPv4 } from '../../validation';
import { quoted, stripFieldPrefix } from './maintenance';

/** The limits of the control plane (domain.TLSMaxHosts, CertChainMaxBytes, CertKeyMaxBytes). */
export const TLS_LIMITS = { hosts: 100, hostBytes: 253, labelBytes: 63, chainBytes: 64 << 10, keyBytes: 16 << 10 } as const;

export const DEFAULT_TLS_LISTEN = '0.0.0.0:443';

// ── Settings: the checks of domain.TLSSettings.Normalize ───────────────────

export type TLSField = 'mode' | 'hosts' | 'listen' | 'redirect_listen' | 'source';
export interface TLSFieldError {
  field: TLSField;
  message: string;
}

// The server folds A to Z only. Go trims every Unicode space (U+0085, U+00A0) and JavaScript's trim
// differs (U+FEFF), so only ASCII white space is trimmed here and a value with any other character
// goes to the server unjudged.
const NON_ASCII = /[^\u0000-\u007f]/;
const ASCII_SPACE = /^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g;

const trimAscii = (value: string): string => value.replace(ASCII_SPACE, '');
const lowerAscii = (value: string): string => value.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());

/** The reason a host name is not served, '' when it is fine. Only for ASCII names. */
function hostProblem(host: string): string {
  if (host === '') return 'is empty';
  if (host.length > TLS_LIMITS.hostBytes) return `is longer than ${TLS_LIMITS.hostBytes} bytes`;
  if (host.includes('*')) return 'must not contain a wildcard';
  if (host.includes(':')) return 'must not contain a port or be an IPv6 address';
  if (host.endsWith('.')) return 'must not end with a dot';
  if (isIPv4(host)) return 'must be a DNS name, not an IP address';
  if (!host.includes('.')) return 'must contain at least one dot';
  const labels = host.split('.');
  const last = labels[labels.length - 1];
  // A browser reads a name like 10.1.1 as an address.
  if (/^[0-9]+$/.test(last)) return 'must not end with a label of digits only';
  for (const label of labels) {
    if (label === '') return 'has an empty label';
    if (label.length > TLS_LIMITS.labelBytes) return `has a label longer than ${TLS_LIMITS.labelBytes} bytes`;
    if (label.startsWith('-') || label.endsWith('-')) return 'has a label that starts or ends with a hyphen';
    if (!/^[a-z0-9-]+$/.test(label)) return 'must use only letters, digits, hyphens and dots (write an international name in its xn-- form)';
  }
  return '';
}

const LISTEN_MESSAGE = 'must be ip:port or [ipv6]:port with a port from 1 to 65535';

interface ListenAddress {
  /** 4 bytes for IPv4, 16 for IPv6 (a 4-in-6 address is IPv6, as in Go). */
  ip: number[];
  port: number;
}

/** netip.ParseAddrPort, without zones and port 0. */
function parseListen(value: string): ListenAddress | null {
  const colon = value.lastIndexOf(':');
  if (colon < 0) return null;
  let host = value.slice(0, colon);
  const port = value.slice(colon + 1);
  if (!host || !port) return null;
  const bracketed = host.startsWith('[');
  if (bracketed) {
    if (host.length < 2 || !host.endsWith(']')) return null;
    host = host.slice(1, -1);
  }
  if (!/^[0-9]+$/.test(port) || Number(port) < 1 || Number(port) > 65535) return null;
  const ip = ipToBytes(host);
  // Brackets are for IPv6 only, and IPv6 needs them.
  if (!ip || bracketed !== (ip.length === 16)) return null;
  return { ip, port: Number(port) };
}

/** netip.Addr.String: lower case, the first longest run of two or more zero groups as "::", "::ffff:a.b.c.d" for a 4-in-6 address. */
function formatIP(ip: number[]): string {
  if (ip.length === 4) return ip.join('.');
  const groups = Array.from({ length: 8 }, (_, i) => (ip[2 * i] << 8) | ip[2 * i + 1]);
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) return `::ffff:${ip.slice(12).join('.')}`;
  let start = -1;
  let length = 1;
  for (let i = 0; i < 8; ) {
    let end = i;
    while (end < 8 && groups[end] === 0) end++;
    if (end - i > length) {
      start = i;
      length = end - i;
    }
    i = Math.max(end, i + 1);
  }
  const hex = (list: number[]) => list.map((g) => g.toString(16)).join(':');
  return start < 0 ? hex(groups) : `${hex(groups.slice(0, start))}::${hex(groups.slice(start + length))}`;
}

/** The address as the server stores it; null when it is not ip:port with a port from 1 to 65535. */
export function canonicalListen(value: string): string | null {
  const parsed = parseListen(value);
  if (!parsed) return null;
  const ip = formatIP(parsed.ip);
  return parsed.ip.length === 4 ? `${ip}:${parsed.port}` : `[${ip}]:${parsed.port}`;
}

const isWildcard = (ip: number[]): boolean => ip.every((byte) => byte === 0);

/** "::" takes every address, "0.0.0.0" every IPv4 one. */
function wildcardTakes(wildcard: ListenAddress['ip'], other: ListenAddress['ip']): boolean {
  return isWildcard(wildcard) && (wildcard.length === 16 || other.length === 4);
}

/**
 * Two different addresses on one port that cannot both be bound, because one is a wildcard
 * (domain.listenersOverlap). The same address twice is one listener, not an overlap.
 */
export function listenersOverlap(a: string, b: string): boolean {
  if (a === b || !a || !b) return false;
  const x = parseListen(a);
  const y = parseListen(b);
  if (!x || !y || x.port !== y.port) return false;
  return wildcardTakes(x.ip, y.ip) || wildcardTakes(y.ip, x.ip);
}

/** Listeners of different kinds can never be the same socket, so the same address clashes too. */
const listenersClash = (a: string, b: string): boolean => a !== '' && b !== '' && (a === b || listenersOverlap(a, b));

/** The address as typed, or its canonical form; null when it is refused. A non-ASCII value is left to the server. */
function listenValue(value: string): string | null {
  return NON_ASCII.test(value) ? value : canonicalListen(value);
}

export type NormalizedTLS = { settings: AppTLSInput; error?: undefined } | { settings?: undefined; error: TLSFieldError };

/**
 * What the server would do with `input`: the stored form (host names trimmed, lower-cased and kept once,
 * listeners canonical, the default HTTPS address filled in) or the first refused field. The 100-host limit
 * is judged only when every name was, since the server may fold some of the others into one.
 */
export function normalizeTLS(input: AppTLSInput): NormalizedTLS {
  const fail = (field: TLSField, message: string): NormalizedTLS => ({ error: { field, message } });
  if (input.mode !== 'proxy' && input.mode !== 'gateway') return fail('mode', 'must be "proxy" or "gateway"');
  if (input.source !== '' && input.source !== 'acme' && input.source !== 'uploaded') return fail('source', 'must be "acme" or "uploaded"');
  const gateway = input.mode === 'gateway';
  if (gateway && input.source === '') return fail('source', 'is required when mode is "gateway"');

  const hosts: string[] = [];
  const seen = new Set<string>();
  let judgedAll = true;
  for (const raw of input.hosts ?? []) {
    const host = lowerAscii(trimAscii(raw));
    if (seen.has(host)) continue;
    seen.add(host);
    if (NON_ASCII.test(host)) {
      judgedAll = false;
    } else {
      const problem = hostProblem(host);
      if (problem) return fail('hosts', `${quoted(host)} ${problem}`);
    }
    hosts.push(host);
  }
  if (judgedAll && hosts.length > TLS_LIMITS.hosts) return fail('hosts', `at most ${TLS_LIMITS.hosts} hosts`);
  if (gateway && hosts.length === 0) return fail('hosts', 'at least one host is required when mode is "gateway"');

  const listen = listenValue(trimAscii(input.listen ?? '') || DEFAULT_TLS_LISTEN);
  if (listen === null) return fail('listen', LISTEN_MESSAGE);
  let redirect = '';
  const redirectText = trimAscii(input.redirect_listen ?? '');
  if (redirectText) {
    const value = listenValue(redirectText);
    if (value === null) return fail('redirect_listen', LISTEN_MESSAGE);
    if (value === listen) return fail('redirect_listen', 'must differ from listen');
    if (listenersOverlap(listen, value)) return fail('redirect_listen', 'must not use the port of listen on an address that overlaps it');
    redirect = value;
  }
  return { settings: { mode: input.mode, hosts, listen, redirect_listen: redirect, source: input.source } };
}

export const OWN_LISTENER = 'The listen address on the Routing tab of this application uses it.';

/** The listener the application opens for itself on the Routing tab: `host` '' is 0.0.0.0, no port means no listener. */
export interface OwnListener {
  host: string;
  port: number | null;
}

/** The own listener as ip:port, null without a port. */
function ownAddress(own: OwnListener): string | null {
  if (!own.port) return null;
  const host = own.host.trim() || '0.0.0.0';
  return host.includes(':') ? `[${host}]:${own.port}` : `${host}:${own.port}`;
}

/**
 * Gateway only: the HTTPS or redirect address of `settings` (as normalizeTLS returns it) that clashes with the
 * listener the application opens for itself on the Routing tab.
 */
export function checkTLSFit(settings: Pick<AppTLSInput, 'listen' | 'redirect_listen'>, own: OwnListener): TLSFieldError | null {
  const address = ownAddress(own);
  const mine = address && canonicalListen(address);
  if (!mine) return null;
  for (const field of ['listen', 'redirect_listen'] as const) {
    if (listenersClash(settings[field], mine)) return { field, message: OWN_LISTENER };
  }
  return null;
}

/** Whether a certificate with these DNS names serves `host` (domain.CertificateCoversHost): a name matches exactly, or a leading "*." matches exactly one label. */
export function certificateCoversHost(names: readonly string[], host: string): boolean {
  const wanted = lowerAscii(host);
  const dot = wanted.indexOf('.');
  return names.some((name) => {
    const have = lowerAscii(name);
    return have === wanted || (have.startsWith('*.') && dot > 0 && wanted.slice(dot + 1) === have.slice(2));
  });
}

// ── Dates ──────────────────────────────────────────────────────────────────

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface Expiry {
  /** not_after is at or before now. */
  expired: boolean;
  /** Whole days left, rounded down as the server does: 0 on the last day, negative once expired. */
  days: number;
  /** Hours left rounded up, so a certificate that has not expired never shows 0; 0 once expired. */
  hours: number;
}

/** null when `notAfter` is not a date. */
export function expiryOf(notAfter: string, now: number): Expiry | null {
  const end = Date.parse(notAfter);
  if (Number.isNaN(end)) return null;
  const left = end - now;
  return { expired: left <= 0, days: Math.floor(left / DAY_MS), hours: left <= 0 ? 0 : Math.ceil(left / HOUR_MS) };
}

/** Epoch ms at which the agent starts to renew a Let's Encrypt certificate: a third of its lifetime before it ends. */
export function renewalStart(notBefore: string | null, notAfter: string | null): number | null {
  const from = notBefore ? Date.parse(notBefore) : NaN;
  const to = notAfter ? Date.parse(notAfter) : NaN;
  if (Number.isNaN(from) || Number.isNaN(to) || to <= from) return null;
  return to - (to - from) / 3;
}

// ── Requests ───────────────────────────────────────────────────────────────

/** The control plane takes one Let's Encrypt request per application every 5 minutes. */
export const ACME_REQUEST_GAP_MS = 5 * 60 * 1000;

/** Epoch ms until which a 409 ACME_REQUEST_TOO_SOON says to wait; null for any other answer. */
export function retryUntil(error: ApiError | undefined, now: number): number | null {
  return error?.code === 'ACME_REQUEST_TOO_SOON' && typeof error.retry_after === 'number' ? now + error.retry_after * 1000 : null;
}

/**
 * Epoch ms from which a new request is accepted (0: now). The wait a refusal named wins while it runs, since
 * the local requested_at may be stale or measured on another clock; then the gap after the last request counts.
 */
export function requestOpensAt(requestedAt: string | null | undefined, retryAt: number | null | undefined, now: number): number {
  if (retryAt != null && retryAt > now) return retryAt;
  const at = requestedAt ? Date.parse(requestedAt) : NaN;
  return Number.isNaN(at) ? 0 : at + ACME_REQUEST_GAP_MS;
}

// ── Status and polling ─────────────────────────────────────────────────────

/**
 * The agent's report when it is about what is saved: the same source, and the id of the saved Let's Encrypt
 * request or uploaded certificate. After a change the old row stays until the agent reports on the new id.
 */
export function currentStatus(state: Pick<AppTLSState, 'source' | 'acme' | 'certificate' | 'status'>): AppTLSStatus | null {
  const status = state.status;
  if (!status || status.source !== state.source) return null;
  if (state.source === 'acme') return status.request_id !== '' && status.request_id === state.acme?.request_id ? status : null;
  return state.source === 'uploaded' && status.certificate_id !== null && status.certificate_id === state.certificate?.id ? status : null;
}

/** The state after a poll: the server's own, plus the DNS hints of the last save, which only a save's answer carries. */
export function mergePoll(current: AppTLSState, polled: AppTLSState): AppTLSState {
  const dns = (warning: { code: string }) => warning.code === 'dns_mismatch';
  return { ...polled, warnings: [...polled.warnings.filter((w) => !dns(w)), ...current.warnings.filter(dns)] };
}

/** A draft after a poll: a field the person changed since `base` stays as typed, the others follow `polled`. */
export function mergeEdits<T extends object>(draft: T, base: T, polled: T): T {
  const merged = { ...polled };
  for (const key of Object.keys(draft) as (keyof T)[]) {
    if (JSON.stringify(draft[key]) !== JSON.stringify(base[key])) merged[key] = draft[key];
  }
  return merged;
}

/** Counts what the panel waits for: of several answers in flight only the newest may be adopted. */
export function createEpoch() {
  let latest = 0;
  return { next: () => ++latest, isCurrent: (token: number) => token === latest };
}

export const POLL_FAST_MS = 10_000;
export const POLL_SLOW_MS = 60_000;
/** How long the agent gets to report before the card says so. */
export const NO_REPORT_AFTER_MS = 2 * 60 * 1000;

/** In Gateway with an agent, and the agent has not yet reported on what is saved. */
export function waitingForAgent(state: AppTLSState, hasAgent: boolean): boolean {
  if (state.mode !== 'gateway' || !hasAgent) return false;
  const status = currentStatus(state);
  return !status || status.state === 'pending' || status.state === 'missing';
}

/** 10 s while waiting for the agent and for 2 minutes after an action of this tab, else 60 s. */
export function pollIntervalMs(state: AppTLSState, hasAgent: boolean, lastActionAt: number | null, now: number): number {
  if (state.mode !== 'gateway' || !hasAgent) return POLL_SLOW_MS;
  const afterAction = lastActionAt !== null && now - lastActionAt < NO_REPORT_AFTER_MS;
  return afterAction || waitingForAgent(state, hasAgent) ? POLL_FAST_MS : POLL_SLOW_MS;
}

/** Epoch ms the wait for the agent counts from: the later of the request (the upload, for an uploaded certificate) and the last action of this tab; 0 when neither is known. */
export function waitingSince(state: Pick<AppTLSState, 'source' | 'acme' | 'certificate'>, lastActionAt: number | null): number {
  const made = state.source === 'uploaded' ? state.certificate?.created_at : state.acme?.requested_at;
  const at = made ? Date.parse(made) : NaN;
  return Math.max(Number.isNaN(at) ? 0 : at, lastActionAt ?? 0);
}

/** The agent had 2 minutes and has not reported. */
export function noReportYet(state: Pick<AppTLSState, 'source' | 'acme' | 'certificate'>, lastActionAt: number | null, now: number): boolean {
  return now - waitingSince(state, lastActionAt) >= NO_REPORT_AFTER_MS;
}

// ── The form of the tab ────────────────────────────────────────────────────

export const DEFAULT_REDIRECT_LISTEN = '0.0.0.0:80';

/** What the person edits: host names one per line, the redirect as a switch and an address. */
export interface TLSForm {
  mode: TLSMode;
  hosts: string;
  listen: string;
  redirect: boolean;
  redirectListen: string;
  source: TLSSource;
}

export function formFromTLS(settings: AppTLSInput): TLSForm {
  return {
    mode: settings.mode,
    hosts: settings.hosts.join('\n'),
    listen: settings.listen,
    redirect: settings.redirect_listen !== '',
    redirectListen: settings.redirect_listen,
    source: settings.source,
  };
}

/** The settings as typed: blank lines dropped, the rest left to the checks. */
export function inputFromForm(form: TLSForm): AppTLSInput {
  return {
    mode: form.mode,
    hosts: form.hosts.split('\n').map(trimAscii).filter((host) => host !== ''),
    listen: form.listen,
    redirect_listen: form.redirect ? form.redirectListen : '',
    source: form.source,
  };
}

/** The redirect switch; turning it on with no address takes port 80. */
export function setRedirect(form: TLSForm, on: boolean): TLSForm {
  return { ...form, redirect: on, redirectListen: on && !form.redirectListen.trim() ? DEFAULT_REDIRECT_LISTEN : form.redirectListen };
}

/**
 * Choosing Gateway for the first time turns the redirect on at port 80. Choosing Behind a proxy puts the
 * saved listeners back, since that mode does not show them and an edit there could not be seen or fixed.
 */
export function chooseMode(form: TLSForm, mode: TLSMode, stored: AppTLSInput): TLSForm {
  if (mode === 'proxy') {
    const { listen, redirect, redirectListen } = formFromTLS(stored);
    return { ...form, mode, listen, redirect, redirectListen };
  }
  const first = stored.mode !== 'gateway' && form.redirectListen.trim() === '';
  return first ? setRedirect({ ...form, mode }, true) : { ...form, mode };
}

/** The same settings once the server's normal form is applied; unreadable settings count as they are typed. */
export function sameTLS(a: AppTLSInput, b: AppTLSInput): boolean {
  const key = (value: AppTLSInput) => {
    const s = normalizeTLS(value).settings ?? value;
    return JSON.stringify([s.mode, s.hosts, s.listen, s.redirect_listen, s.source]);
  };
  return key(a) === key(b);
}

/** normalizeTLS without what only Gateway requires (a source, a host name): the dialog of a switch to Gateway checks those. */
export function normalizeFormats(input: AppTLSInput): NormalizedTLS {
  return normalizeTLS({ ...input, mode: 'proxy' });
}

/** The first field the server would refuse, or the address that clashes with the application's own listener in Gateway. */
export function tlsProblem(input: AppTLSInput, own: OwnListener, toGateway = false): TLSFieldError | null {
  const result = toGateway ? normalizeFormats(input) : normalizeTLS(input);
  if (result.error) return result.error;
  return input.mode === 'gateway' ? checkTLSFit(result.settings, own) : null;
}

/** The Gateway switch needs an agent that serves certificates; `null` (not known) passes. An app already in Gateway stays editable. */
export function switchDisabled(o: { canConfigure: boolean; busy: boolean; to: TLSMode | null; supported: boolean | null }): boolean {
  return !o.canConfigure || o.busy || (o.to === 'gateway' && o.supported === false);
}

// ── Texts ──────────────────────────────────────────────────────────────────

/** The agent's name, or "The WAF agent" at the start of a sentence. */
const agentStart = (agent: string): string => agent || 'The WAF agent';
/** The agent's name, or "the WAF agent" inside a sentence. */
const agentMid = (agent: string): string => agent || 'the WAF agent';

export function unsupportedText(agent: string): string {
  return `${agentStart(agent)} cannot serve certificates: it is older than this feature, or its key directory /var/lib/wafio-waf-agent/tls/ was unusable at start (its log says why). Upgrade it, or fix the directory and restart it.`;
}

export function notHostBoundText(agent: string): string {
  return `${agentStart(agent)} needs a credential bound to its host to receive an uploaded key. On a registered host, set WAFIO_HOST_KEY in /etc/wafio/waf-agent.env and restart it. Otherwise enroll it under a new name with a host key from the Hosts page, then move this application to it on the Assignment tab.`;
}

export type TLSNotice = 'unassigned' | 'unsupported' | 'unsupported-gateway' | 'offline' | 'readonly';

/** The alerts above the form, in the order they are shown. `mode` is the saved one. */
export function tlsNotices(o: { assigned: boolean; mode: TLSMode; supported: boolean | null; online: boolean | undefined; canConfigure: boolean }): TLSNotice[] {
  const out: TLSNotice[] = [];
  if (!o.assigned) out.push('unassigned');
  if (o.supported === false) out.push(o.mode === 'gateway' ? 'unsupported-gateway' : 'unsupported');
  if (o.online === false) out.push('offline');
  if (!o.canConfigure) out.push('readonly');
  return out;
}

export function noticeText(notice: TLSNotice, agent: string): string {
  switch (notice) {
    case 'unassigned':
      return 'No WAF agent serves this application. These settings take effect once one is assigned on the Assignment tab.';
    case 'unsupported':
      return unsupportedText(agent);
    case 'unsupported-gateway':
      return `${agentStart(agent)} no longer serves certificates, so it serves this application in plain HTTP at its Routing listen address.`;
    case 'offline':
      return `${agentStart(agent)} is offline. The change takes effect when it reconnects.`;
    case 'readonly':
      return 'Read-only: changing HTTPS settings needs member or owner access.';
  }
}

/** "port 443", "ports 443 and 80": the ports of the HTTPS address and, when there is one, the redirect address. */
export function portsText(listen: string, redirect: string): string {
  const ports = new Set<number>();
  for (const address of [listen || DEFAULT_TLS_LISTEN, redirect]) {
    const parsed = address ? parseListen(address) : null;
    if (parsed) ports.add(parsed.port);
  }
  const list = [...ports];
  if (list.length === 0) return 'the listening ports';
  return list.length === 1 ? `port ${list[0]}` : `ports ${list.join(' and ')}`;
}

/** What a source choice does right away, in Gateway: the first order of Let's Encrypt, or the upload being sent to the agent. */
export function sourceSwitchText(source: 'acme' | 'uploaded', o: { agent: string; redirect: boolean }): string {
  const http = o.redirect ? ', and HTTP visitors get 503' : '. Nothing answers on HTTP';
  return source === 'acme'
    ? `Until the certificate is issued, HTTPS visitors get a browser warning, then a 503 page${http}. A try takes up to 3 minutes; after a failure the agent waits 10 minutes, then longer. Switching places the first request: by switching, you accept the Let's Encrypt Subscriber Agreement.`
    : `Until ${agentMid(o.agent)} has the certificate, usually within a minute, HTTPS connections fail${http}.`;
}

/** What the person does outside WAFio for a switch to Gateway. */
export function gatewaySteps(o: { agent: string; ports: string; source: TLSSource }): string[] {
  return [
    "Point each host name's DNS at this server, or at a CDN that connects here over HTTPS (Cloudflare: Full).",
    `Free ${o.ports} on ${agentMid(o.agent)}'s host: stop or move the web server there. Until then ${agentMid(o.agent)} keeps its current settings for all its applications and retries every minute.`,
    'If you reach this dashboard through that web server, set up another way in first, or switching back needs a shell.',
    `Open ${o.ports} to visitors in every firewall${o.source === 'acme' ? "; Let's Encrypt checks from several networks" : ''}.`,
  ];
}

export function backToProxyText(o: { agent: string; own: OwnListener; ports: string }): string {
  return `${agentStart(o.agent)} stops serving HTTPS for this application and listens on ${ownAddress(o.own) ?? 'the listen address on the Routing tab'} again, which frees ${o.ports}. Then start the web server in front of it; a load balancer on another machine can be switched first.`;
}

export const TRUST_WARNING =
  'Forwarded headers are trusted from loopback and the private ranges. In Gateway mode a load balancer or NAT that hides client addresses, a machine on your network or a container could set any client address. With nothing in front, turn this off on the Routing tab; behind a CDN, keep only its addresses.';

export function savedInGatewayText(agent: string): string {
  return `Saved. ${agentStart(agent)} applies it within about a minute. If it cannot (a port in use, say), it keeps its current settings for all its applications; its log says why.`;
}

/** The DNS hint of a save: what a host resolves to against what the agent's host reports. */
export function dnsWarningText(warning: AppTLSWarning, agent: string): string {
  return `${warning.host} resolves to ${(warning.resolved ?? []).join(', ')}, but ${agentMid(agent)}'s host reports ${(warning.agent_addresses ?? []).join(', ')}. Visitors and Let's Encrypt go where DNS points; behind a CDN that is expected.`;
}

// ── The checks of a switch to Gateway ──────────────────────────────────────

export type CheckState = 'passed' | 'failed' | 'warning' | 'unknown';

export interface TLSCheck {
  id: 'source' | 'hosts' | 'agent' | 'certificate' | 'bound' | 'trust';
  state: CheckState;
  text: string;
}

function certificateCheck(certificate: AppTLSCertificate | null, hosts: readonly string[], now: number): TLSCheck {
  const check = (state: CheckState, text: string): TLSCheck => ({ id: 'certificate', state, text });
  if (!certificate) return check('failed', 'No certificate is uploaded. Upload one before you switch.');
  if (expiryOf(certificate.not_after, now)?.expired ?? true) return check('failed', 'The uploaded certificate has expired.');
  const missing = hosts.find((host) => !certificateCoversHost(certificate.names, host));
  if (missing) return check('failed', `The uploaded certificate does not cover ${missing}.`);
  return check('passed', `The uploaded certificate covers every host name and is valid until ${formatDate(certificate.not_after)}.`);
}

/**
 * What a switch to Gateway needs: a source, a host name, an agent that serves certificates and, for an uploaded
 * certificate, one that is valid now, covers every host and can reach the agent. A failed check keeps the switch
 * from being confirmed; "not known" and a warning do not, and the server checks again.
 */
export function gatewayChecks(o: {
  input: Pick<AppTLSInput, 'hosts' | 'source'>;
  certificate: AppTLSCertificate | null;
  supported: boolean | null;
  hostBound: boolean | null;
  /** Forwarded headers are on with no trusted proxy listed. */
  trustWithoutList: boolean;
  agent: string;
  now: number;
}): TLSCheck[] {
  const hosts = [...new Set(o.input.hosts.map(lowerAscii))];
  const source = o.input.source;
  const checks: TLSCheck[] = [
    source === ''
      ? { id: 'source', state: 'failed', text: 'Choose a certificate source.' }
      : { id: 'source', state: 'passed', text: source === 'acme' ? "Let's Encrypt gives the certificate." : 'The certificate is the one you uploaded.' },
    hosts.length === 0
      ? { id: 'hosts', state: 'failed', text: 'Add at least one host name.' }
      : { id: 'hosts', state: 'passed', text: hosts.length === 1 ? 'One host name.' : `${hosts.length} host names.` },
    o.supported === false
      ? { id: 'agent', state: 'failed', text: unsupportedText(o.agent) }
      : o.supported === null
        ? { id: 'agent', state: 'unknown', text: 'It is not known yet whether the WAF agent can serve certificates. The control plane checks again when you switch.' }
        : { id: 'agent', state: 'passed', text: `${agentStart(o.agent)} can serve certificates.` },
  ];
  if (source === 'uploaded') {
    checks.push(certificateCheck(o.certificate, hosts, o.now));
    checks.push(
      o.hostBound === false
        ? { id: 'bound', state: 'failed', text: notHostBoundText(o.agent) }
        : o.hostBound === null
          ? { id: 'bound', state: 'unknown', text: 'It is not known yet whether the WAF agent can receive an uploaded key. The control plane checks again when you switch.' }
          : { id: 'bound', state: 'passed', text: `${agentStart(o.agent)} can receive an uploaded key.` },
    );
  }
  checks.push(
    o.trustWithoutList
      ? { id: 'trust', state: 'warning', text: TRUST_WARNING }
      : { id: 'trust', state: 'passed', text: 'Forwarded headers are off, or trusted only from your own list.' },
  );
  return checks;
}

// ── Refusals of a save ─────────────────────────────────────────────────────

/** Where the answer of a refused save is shown: under a field, above the form with a link to Routing, or above the form. */
export type TLSRefusal =
  | { kind: 'field'; field: 'hosts' | 'listen' | 'redirect_listen' | 'source'; message: string }
  | { kind: 'routing' | 'unsupported' | 'save'; message: string };

/**
 * A 400 INVALID_TLS_SETTINGS and the conflicts and size refusals that name a field belong under it, and
 * CERTIFICATE_DOES_NOT_COVER under the host names (its text names the host). A LISTEN_CONFLICT on `listen_port`
 * is a Routing setting. The rest is shown above the form, TLS_UNSUPPORTED also telling the panel the agent cannot.
 */
export function classifyTLSRefusal(error: ApiError | undefined, agent: string): TLSRefusal {
  const text = error?.error || 'Could not save the HTTPS settings.';
  const field = error?.field;
  const named = field === 'hosts' || field === 'listen' || field === 'redirect_listen' || field === 'source';
  if (error?.code === 'INVALID_TLS_SETTINGS' && named) return { kind: 'field', field, message: stripFieldPrefix(text, field) };
  if ((error?.code === 'LISTEN_CONFLICT' || error?.code === 'HOST_CONFLICT' || error?.code === 'TLS_BUNDLE_TOO_LARGE') && named) return { kind: 'field', field, message: text };
  if (error?.code === 'LISTEN_CONFLICT' && field === 'listen_port') return { kind: 'routing', message: text };
  if (error?.code === 'CERTIFICATE_DOES_NOT_COVER') return { kind: 'field', field: 'hosts', message: text };
  return { kind: error?.code === 'TLS_UNSUPPORTED' ? 'unsupported' : 'save', message: (error && codeText(error, agent)) ?? text };
}

// ── Sending a certificate ──────────────────────────────────────────────────

/** What the person typed or chose. The key lives here only until the send ends. */
export interface CertificateForm {
  chain: string;
  key: string;
  /** A chosen key file; its text is read when sending and never shown. It wins over `key`. */
  keyFile: File | null;
}

export type CertificatePlace = 'chain' | 'key' | 'form';

/** `place` is where the text belongs: under the chain, under the key, or above both. */
export type CertificateOutcome =
  | { ok: true; certificate: AppTLSCertificate }
  | { ok: false; aborted: boolean; place: CertificatePlace; message: string };

const KEY_IN_CHAIN = 'This text holds a private key. Put only certificates here and the key in the key field.';
const NOT_PEM_TEXT = 'This file is not PEM text. Convert it first (.pfx: openssl pkcs12 -in file.pfx -nodes -nocerts for the key, -nokeys for the chain).';
const PRIVATE_KEY_BLOCK = /PRIVATE KEY-----/;

/**
 * The text of a chosen file, or why it is not used. A file over its cap is not read; a file that is not UTF-8
 * (DER, PKCS#12) is not PEM; a chain file that holds a private key is not returned, so the key never reaches the screen.
 */
export async function readPemFile(file: File, kind: 'chain' | 'key'): Promise<{ text: string; message?: undefined } | { text?: undefined; message: string }> {
  const cap = kind === 'chain' ? TLS_LIMITS.chainBytes : TLS_LIMITS.keyBytes;
  if (file.size > cap) return { message: `This file is larger than ${cap >> 10} KiB.` };
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
  } catch {
    return { message: NOT_PEM_TEXT };
  }
  return kind === 'chain' && PRIVATE_KEY_BLOCK.test(text) ? { message: KEY_IN_CHAIN } : { text };
}

/** The dashboard's text for an answer that names no field, null for any other. */
function codeText(error: ApiError, agent: string): string | null {
  switch (error.code) {
    case 'KEY_ENCRYPTION_UNAVAILABLE':
      return 'The control plane cannot store keys: totp.enc_key is not set.';
    case 'AGENT_NOT_HOST_BOUND':
      return notHostBoundText(agent);
    case 'TLS_UNSUPPORTED':
      return unsupportedText(agent);
    case 'CERTIFICATE_REQUIRED':
      return 'Upload a certificate that is valid now before you choose Uploaded certificate.';
    case 'CERTIFICATE_IN_USE':
      return 'In use. Switch to Let\'s Encrypt or Behind a proxy first, or upload a replacement.';
    default:
      return null;
  }
}

/** The texts of the answers an upload can get that carry no field. */
function uploadErrorText(error: ApiError, agent: string): string | null {
  return error.status === 429 ? 'Too many uploads in the last minute. Try again soon.' : codeText(error, agent);
}

const failure = (place: CertificatePlace, message: string, aborted = false): CertificateOutcome => ({ ok: false, aborted, place, message });

/**
 * Sends the chain and key through `send` (the upload call). However the send ends, the key and its file are
 * dropped from `form`, and nothing here keeps a reference to them; strings cannot be wiped, so this is best
 * effort. Nothing is sent for a chain that holds a private key (the chain is cleared too) or a key file that
 * is over its cap or not text. `agent` is the WAF agent's name for the texts that name it.
 */
export async function sendCertificate(
  form: CertificateForm,
  send: (body: AppTLSCertificateInput) => Promise<ApiResult<AppTLSCertificate>>,
  agent = '',
): Promise<CertificateOutcome> {
  try {
    if (PRIVATE_KEY_BLOCK.test(form.chain)) {
      form.chain = '';
      return failure('chain', KEY_IN_CHAIN);
    }
    let key = form.key;
    if (form.keyFile) {
      const read = await readPemFile(form.keyFile, 'key');
      if (read.message !== undefined) return failure('key', read.message);
      key = read.text;
    }
    const { data, error } = await send({ chain_pem: form.chain, key_pem: key });
    if (data) return { ok: true, certificate: data };
    if (error?.kind === 'aborted') return failure('form', '', true);
    if (!error) return failure('form', 'Invalid response from server');
    const place = error.field === 'chain_pem' ? 'chain' : error.field === 'key_pem' ? 'key' : 'form';
    return failure(place, uploadErrorText(error, agent) ?? error.error);
  } catch (cause) {
    // Never the message of the exception: a failed send must not echo what it carried.
    const aborted = cause instanceof Error && cause.name === 'AbortError';
    return failure('form', aborted ? '' : 'Unable to reach the server. Please retry.', aborted);
  } finally {
    form.key = '';
    form.keyFile = null;
  }
}
