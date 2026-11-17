/**
 * Firewall access rules.
 *
 * Pure helpers shared by the Firewall page and its managers:
 * - one row model for the five host lists (blocklist, allowlist, egress
 *   blocklist, geo-blocking, port rules) so they render in one table;
 * - input parsing with the same limits the control plane enforces
 *   (internal/ebpf/ip_range.go ExpandIPRange, handlers validateIPEntry);
 * - TTL chips (15m / 1h / 24h / permanent, plus a custom duration).
 */
import type { EBPFAllowlistEntry, EBPFIPListEntry, EBPFPortPolicy, EBPFPortScope } from '#lib/api.js';
import { ipToBytes, ipVersion, parseCIDR, parseList } from '#lib/validation.js';

// ── Rule types ─────────────────────────────────────────────────────────────

export type AccessRuleType = 'block' | 'allow' | 'egress' | 'geo' | 'port';

export interface AccessRuleTypeInfo {
  id: AccessRuleType;
  /** Filter / section label. */
  label: string;
  /** Singular noun for a row of this type. */
  noun: string;
  description: string;
}

export const ACCESS_RULE_TYPES: readonly AccessRuleTypeInfo[] = [
  { id: 'block', label: 'Blocklist', noun: 'Blocked address', description: 'Inbound packets from these addresses are dropped at XDP, before the kernel network stack.' },
  { id: 'allow', label: 'Allowlist', noun: 'Allowed address', description: 'These addresses bypass geo-blocking, the blocklist, port rules and rate limits: on every port, or only on the ports an entry is scoped to. On other ports, and for ICMP, a scoped source meets the normal checks.' },
  { id: 'egress', label: 'Egress blocklist', noun: 'Blocked destination', description: 'Outbound packets to these addresses are dropped at TC egress (exfiltration, C2 callbacks).' },
  { id: 'geo', label: 'Geo-blocking', noun: 'Blocked country', description: 'Inbound packets from these countries are dropped after a GeoIP lookup at XDP.' },
  { id: 'port', label: 'Port rules', noun: 'Port rule', description: 'Allow, drop or log packets by port, protocol and direction. Ingress at XDP, egress at TC.' },
];

export function accessRuleType(id: AccessRuleType): AccessRuleTypeInfo {
  return ACCESS_RULE_TYPES.find((type) => type.id === id) ?? ACCESS_RULE_TYPES[0];
}

export type RuleAction = 'drop' | 'allow' | 'log';
export type RuleDirection = 'ingress' | 'egress' | 'both';

export interface AccessRule {
  /** Stable identity: type plus target. */
  key: string;
  type: AccessRuleType;
  /** What the API identifies the rule by: address, country code or "22/tcp". */
  target: string;
  /** Display text (country name, "22/tcp", address). */
  label: string;
  action: RuleAction;
  direction: RuleDirection;
  /** Protocol of a port rule. */
  proto?: string;
  addedAt?: string;
  /** Absent = permanent. */
  expiresAt?: string;
  permanent: boolean;
  /** Packets matched; null where the agent does not count (geo-blocking). */
  hits: number | null;
  /** CIDR entry, evaluated by the kernel LPM trie. */
  subnet: boolean;
  /** The source port rule (port rows only). */
  port?: EBPFPortPolicy;
  /** Allowlist rows: port scopes ([] = all ports). */
  ports?: EBPFPortScope[];
  /** Allowlist rows: the entry is a management escape hatch (isLockoutEscape). */
  lockoutEscape?: boolean;
}

export interface AccessRuleSources {
  blocklist?: readonly EBPFIPListEntry[] | null;
  allowlist?: readonly EBPFAllowlistEntry[] | null;
  egress?: readonly EBPFIPListEntry[] | null;
  /** sshd ports the host reported, for the allowlist lockout-escape fallback. */
  sshPorts?: readonly number[] | null;
  geo?: readonly { code: string; blocked: boolean }[] | null;
  /** Geo policy mode; in allow mode the geo rows are the allowed countries. */
  geoMode?: 'block' | 'allow';
  /** Allowed countries (allow mode). */
  geoAllowed?: readonly string[] | null;
  ports?: readonly EBPFPortPolicy[] | null;
}

function timeOf(value: string | undefined | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** An entry whose expiry lies in the past (the agent removes it on its next sweep). */
export function isExpired(expiresAt: string | undefined | null, now = Date.now()): boolean {
  const ms = timeOf(expiresAt);
  return ms !== null && ms <= now;
}

function normalizeDirection(direction: string | undefined): RuleDirection {
  return direction === 'egress' || direction === 'both' ? direction : 'ingress';
}

function normalizeAction(action: string | undefined): RuleAction {
  return action === 'allow' || action === 'log' ? action : 'drop';
}

/** Port rule identity used by the delete endpoint. */
export function portRuleKey(rule: Pick<EBPFPortPolicy, 'port' | 'proto' | 'direction'>): string {
  return `${rule.port}/${(rule.proto || 'any').toLowerCase()}/${normalizeDirection(rule.direction)}`;
}

export function portRuleLabel(rule: Pick<EBPFPortPolicy, 'port' | 'proto'>): string {
  const proto = (rule.proto || 'any').toLowerCase();
  return proto === 'any' ? `${rule.port}/any` : `${rule.port}/${proto}`;
}

/** A port rule that neither carries a TTL nor an expiry. */
export function isPermanentPortRule(rule: Pick<EBPFPortPolicy, 'ttl_ms' | 'expires_at'>): boolean {
  return (rule.ttl_ms ?? 0) === 0 && !rule.expires_at;
}

/**
 * A non-expiring ALLOW rule on a real port that applies to ingress. Listed as
 * "management ports" in the UI; which of them keeps SSH open under ingress
 * Deny all is decided by sshAllowed().
 */
export function isPermanentIngressAllow(rule: EBPFPortPolicy): boolean {
  const direction = rule.direction ?? '';
  return rule.port > 0 && rule.action === 'allow' && isPermanentPortRule(rule) && (direction === 'ingress' || direction === 'both' || direction === '');
}

export function permanentIngressAllows(rules: readonly EBPFPortPolicy[] | null | undefined): EBPFPortPolicy[] {
  return (rules ?? []).filter(isPermanentIngressAllow);
}

/** Egress (or both-direction) ALLOW rules that have not expired. */
export function egressAllows(rules: readonly EBPFPortPolicy[] | null | undefined, now = Date.now()): EBPFPortPolicy[] {
  return (rules ?? []).filter((rule) => rule.action === 'allow' && (rule.direction === 'egress' || rule.direction === 'both') && !isExpired(rule.expires_at, now));
}

// ── Dataplane lookup (mirrors shared/hostpolicy/firewall_validation.go) ──

/** The SSH port guarded when the host agent reported no sshd listener. */
export const DEFAULT_SSH_PORT = 22;
/** Agent gRPC port of the control plane (server.agent_grpc_addr default). */
export const DEFAULT_CONTROL_PLANE_PORT = 9090;

/** BPF map slot of a rule: "" proto = any, "" direction = ingress; values are case-sensitive. */
function slotOf(rule: Pick<EBPFPortPolicy, 'port' | 'proto' | 'direction'>): string {
  const proto = rule.proto === 'tcp' || rule.proto === 'udp' ? rule.proto : 'any';
  const direction = rule.direction === 'egress' || rule.direction === 'both' ? rule.direction : 'ingress';
  return `${rule.port}/${proto}/${direction}`;
}

function expires(rule: Pick<EBPFPortPolicy, 'ttl_ms' | 'expires_at'>): boolean {
  return (rule.ttl_ms ?? 0) !== 0 || Boolean(rule.expires_at);
}

/** Map content after writing `rules` in order: the last rule of a slot wins, expired rules are gone. */
function effectiveRules(rules: readonly EBPFPortPolicy[] | null | undefined, now: number): Map<string, EBPFPortPolicy> {
  const out = new Map<string, EBPFPortPolicy>();
  for (const rule of rules ?? []) {
    const slot = slotOf(rule);
    if (isExpired(rule.expires_at, now)) out.delete(slot);
    else out.set(slot, rule);
  }
  return out;
}

/**
 * True when `port/proto` in `direction` is always allowed: the first live
 * rule in dataplane lookup order (exact protocol before any, the direction
 * before both) is a non-expiring ALLOW, and no expiring DROP sits ahead of it.
 */
export function portAlwaysAllowed(
  rules: readonly EBPFPortPolicy[] | null | undefined,
  port: number,
  proto: 'tcp' | 'udp',
  direction: 'ingress' | 'egress',
  now = Date.now(),
): boolean {
  const live = effectiveRules(rules, now);
  for (const slot of [`${port}/${proto}/${direction}`, `${port}/${proto}/both`, `${port}/any/${direction}`, `${port}/any/both`]) {
    const rule = live.get(slot);
    if (!rule) continue;
    if (expires(rule)) {
      if (rule.action === 'drop') return false;
      continue;
    }
    return rule.action === 'allow';
  }
  return false;
}

/** SSH ports the guard checks: the agent-reported listeners, else 22. */
export function guardedSSHPorts(sshPorts: readonly number[] | null | undefined): number[] {
  const ports = (sshPorts ?? []).filter((p) => Number.isInteger(p) && p > 0 && p < 65_536);
  return ports.length ? [...new Set(ports)] : [DEFAULT_SSH_PORT];
}

/**
 * Ingress deny all keeps SSH open (SSH_ALLOW_REQUIRED): one of the SSH ports
 * is always allowed over TCP inbound.
 */
export function sshAllowed(rules: readonly EBPFPortPolicy[] | null | undefined, sshPorts?: readonly number[] | null, now = Date.now()): boolean {
  return guardedSSHPorts(sshPorts).some((port) => portAlwaysAllowed(rules, port, 'tcp', 'ingress', now));
}

/**
 * True when removing `rule` under ingress Deny all leaves no SSH port always
 * allowed, the control plane would refuse it (SSH_ALLOW_REQUIRED) and the
 * operator's SSH session would be cut.
 */
export function removalLocksOut(
  rule: EBPFPortPolicy,
  rules: readonly EBPFPortPolicy[],
  portPolicy: { enabled: boolean; default_ingress: string } | null | undefined,
  sshPorts?: readonly number[] | null,
  now = Date.now(),
): boolean {
  if (!portPolicy?.enabled || portPolicy.default_ingress !== 'deny') return false;
  if (!sshAllowed(rules, sshPorts, now)) return false;
  const slot = slotOf(rule);
  return !sshAllowed(rules.filter((other) => slotOf(other) !== slot), sshPorts, now);
}

/**
 * A permanent allowlist entry that keeps management access through a block of
 * 0.0.0.0/0, ::/0 or half a family (mirrors permanentAllowlistFamily in
 * shared/hostpolicy/firewall_validation.go): no ports, or a tcp/any scope that
 * covers an SSH port (the reported ones, else 22). The server's
 * `lockout_escape` wins when present; an expiring entry never counts.
 */
export function isLockoutEscape(entry: EBPFAllowlistEntry, sshPorts?: readonly number[] | null): boolean {
  if (entry.expires_at) return false;
  if (typeof entry.lockout_escape === 'boolean') return entry.lockout_escape;
  const ports = entry.ports ?? [];
  if (!ports.length) return true;
  return guardedSSHPorts(sshPorts).some((port) => ports.some((scope) => scopeCovers(scope, port, 'tcp')));
}

/** Lockout-escape allowlist entry (IP, CIDR or range) of the address family. */
export function hasPermanentAllowlistFamily(entries: readonly EBPFAllowlistEntry[] | null | undefined, family: 4 | 6, sshPorts?: readonly number[] | null): boolean {
  return (entries ?? []).some((entry) => entryFamily(entry.ip) === family && isLockoutEscape(entry, sshPorts));
}

function entryFamily(entry: string): 4 | 6 | 0 {
  let text = entry.trim();
  const dash = text.indexOf('-');
  if (dash > 0) text = text.slice(0, dash).trim();
  const slash = text.indexOf('/');
  if (slash > 0) text = text.slice(0, slash);
  const version = ipVersion(text);
  return version === 4 || version === 6 ? version : 0;
}

/** Families (4, 6) a live list blocks entirely with 0.0.0.0/0 or ::/0. */
export function wildcardFamilies(entries: readonly EBPFIPListEntry[] | null | undefined, now = Date.now()): (4 | 6)[] {
  const live = (entries ?? []).filter((entry) => !isExpired(entry.expires_at, now)).map((entry) => entry.ip.trim());
  const out: (4 | 6)[] = [];
  if (live.includes('0.0.0.0/0')) out.push(4);
  if (live.includes('::/0')) out.push(6);
  return out;
}

function listRows(type: 'block' | 'allow' | 'egress', entries: readonly EBPFAllowlistEntry[] | null | undefined, now: number, sshPorts?: readonly number[] | null): AccessRule[] {
  const action: RuleAction = type === 'allow' ? 'allow' : 'drop';
  const direction: RuleDirection = type === 'egress' ? 'egress' : 'ingress';
  return (entries ?? [])
    .filter((entry) => !isExpired(entry.expires_at, now))
    .map((entry) => ({
      key: `${type}:${entry.ip}`,
      type,
      target: entry.ip,
      label: entry.ip,
      action,
      direction,
      addedAt: entry.added_at,
      expiresAt: entry.expires_at || undefined,
      permanent: !entry.expires_at,
      hits: typeof entry.hit_count === 'number' ? entry.hit_count : null,
      subnet: entry.ip.includes('/'),
      ...(type === 'allow' ? { ports: [...(entry.ports ?? [])], lockoutEscape: isLockoutEscape(entry, sshPorts) } : {}),
    }));
}

/** One row per rule across the five host lists; expired entries are left out. */
export function buildAccessRules(sources: AccessRuleSources, now = Date.now()): AccessRule[] {
  const allowMode = sources.geoMode === 'allow';
  const geoCodes = allowMode
    ? (sources.geoAllowed ?? [])
    : (sources.geo ?? []).filter((entry) => entry.blocked).map((entry) => entry.code);
  const geo: AccessRule[] = geoCodes
    .map((raw) => {
      const code = raw.toUpperCase();
      return {
        key: `geo:${code}`,
        type: 'geo' as const,
        target: code,
        label: countryName(code),
        action: allowMode ? ('allow' as const) : ('drop' as const),
        direction: 'ingress' as const,
        permanent: true,
        hits: null,
        subnet: false,
      };
    });
  const ports: AccessRule[] = (sources.ports ?? [])
    .filter((rule) => !isExpired(rule.expires_at, now))
    .map((rule) => ({
      key: `port:${portRuleKey(rule)}`,
      type: 'port' as const,
      target: portRuleLabel(rule),
      label: portRuleLabel(rule),
      action: normalizeAction(rule.action),
      direction: normalizeDirection(rule.direction),
      proto: (rule.proto || 'any').toLowerCase(),
      addedAt: rule.added_at,
      expiresAt: rule.expires_at || undefined,
      permanent: isPermanentPortRule(rule),
      hits: typeof rule.hit_count === 'number' ? rule.hit_count : 0,
      subnet: false,
      port: rule,
    }));
  return [
    ...listRows('block', sources.blocklist, now),
    ...listRows('allow', sources.allowlist, now, sources.sshPorts),
    ...listRows('egress', sources.egress, now),
    ...geo,
    ...ports,
  ];
}

export type AccessRuleFilter = AccessRuleType | 'all';

/** A capped list: how many of the host's entries were loaded. */
export interface ListWindow {
  /** Entries returned. */
  loaded: number;
  /** All entries on the host. */
  total: number;
}

export function isAccessRuleFilter(value: unknown): value is AccessRuleFilter {
  return value === 'all' || ACCESS_RULE_TYPES.some((type) => type.id === value);
}

/** Rows of `type` whose target, label, protocol or direction contains `query`. */
export function filterAccessRules(rules: readonly AccessRule[], filter: { type?: AccessRuleFilter; query?: string }): AccessRule[] {
  const type = filter.type ?? 'all';
  const query = (filter.query ?? '').trim().toLowerCase();
  return rules.filter((rule) => {
    if (type !== 'all' && rule.type !== type) return false;
    if (!query) return true;
    return [rule.target, rule.label, rule.proto ?? '', rule.direction, rule.action, rule.ports ? allowPortsLabel(rule.ports) : ''].some((text) => text.toLowerCase().includes(query));
  });
}

export function countByType(rules: readonly AccessRule[]): Record<AccessRuleType, number> {
  const counts: Record<AccessRuleType, number> = { block: 0, allow: 0, egress: 0, geo: 0, port: 0 };
  for (const rule of rules) counts[rule.type] += 1;
  return counts;
}

// ── Addresses ──────────────────────────────────────────────────────────────

/** Most addresses one entry may expand to (handlers validateIPEntry). */
export const MAX_ENTRY_ADDRESSES = 100_000;

function compareBytes(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function ipv4ToNumber(bytes: number[]): number {
  return ((bytes[0] << 24) >>> 0) + (bytes[1] << 16) + (bytes[2] << 8) + bytes[3];
}

/**
 * Why `value` is not a valid firewall address entry, or null when it is one.
 * Accepts an address, a CIDR prefix, or an IPv4 dash range, with the size
 * limits the control plane applies.
 */
export function addressError(value: string): string | null {
  const text = value.trim();
  if (!text) return 'Enter an address.';
  if (text.includes('-')) {
    const parts = text.split('-');
    if (parts.length !== 2) return 'A range has exactly one "-" (1.2.3.1-1.2.3.50).';
    const [left, right] = parts.map((part) => part.trim());
    const leftVersion = ipVersion(left);
    const rightVersion = ipVersion(right);
    if (!leftVersion || !rightVersion) return 'Both ends of a range must be addresses (1.2.3.1-1.2.3.50).';
    if (leftVersion !== 4 || rightVersion !== 4) return 'Ranges are IPv4 only; use a CIDR prefix for IPv6.';
    const first = ipToBytes(left) ?? [];
    const last = ipToBytes(right) ?? [];
    if (compareBytes(first, last) > 0) return 'The range is reversed; put the lower address first.';
    const size = ipv4ToNumber(last) - ipv4ToNumber(first) + 1;
    if (size > MAX_ENTRY_ADDRESSES) return `The range covers ${size.toLocaleString('en-US')} addresses; the limit is ${MAX_ENTRY_ADDRESSES.toLocaleString('en-US')}.`;
    return null;
  }
  if (text.includes('/')) {
    if (text === '0.0.0.0/0' || text === '::/0') return null;
    const cidr = parseCIDR(text);
    if (!cidr) return 'Not a valid CIDR prefix (10.0.0.0/24, 2001:db8::/112).';
    const hostBits = (cidr.version === 4 ? 32 : 128) - cidr.prefix;
    if (hostBits >= 63 || 2 ** hostBits > MAX_ENTRY_ADDRESSES) {
      const smallest = cidr.version === 4 ? '/16' : '/112';
      return `The prefix covers more than ${MAX_ENTRY_ADDRESSES.toLocaleString('en-US')} addresses; use ${smallest} or longer.`;
    }
    return null;
  }
  if (ipVersion(text)) return null;
  return 'Not a valid IPv4 or IPv6 address.';
}

/** "0.0.0.0/0" and "::/0" match every address of their family. */
export function matchesEverything(value: string): boolean {
  const text = value.trim();
  return text === '0.0.0.0/0' || text === '::/0';
}

export interface AddressListResult {
  valid: string[];
  invalid: Array<{ value: string; error: string }>;
}

/** Parses a pasted list (newlines, commas or spaces; "# comments" dropped). */
export function parseAddressList(text: string): AddressListResult {
  const entries = parseList(text, { separators: /[\n,\s]+/ });
  const result: AddressListResult = { valid: [], invalid: [] };
  for (const entry of entries) {
    const error = addressError(entry);
    if (error) result.invalid.push({ value: entry, error });
    else result.valid.push(entry);
  }
  return result;
}

// ── Countries ──────────────────────────────────────────────────────────────

let regionNames: Intl.DisplayNames | null | undefined;

function regions(): Intl.DisplayNames | null {
  if (regionNames === undefined) {
    try {
      regionNames = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });
    } catch {
      regionNames = null;
    }
  }
  return regionNames;
}

/** English name of an ISO 3166-1 alpha-2 code, or the code itself when unknown. */
export function countryName(code: string): string {
  const upper = code.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(upper)) return upper;
  try {
    return regions()?.of(upper) ?? upper;
  } catch {
    return upper;
  }
}

/** True for a two-letter code that names a country or territory. */
export function isCountryCode(code: string): boolean {
  const upper = code.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(upper) || upper === 'XX' || upper === 'ZZ') return false;
  const names = regions();
  if (!names) return true;
  try {
    return names.of(upper) !== undefined;
  } catch {
    return false;
  }
}

export interface CountryListResult {
  valid: string[];
  invalid: string[];
}

export function parseCountryCodes(text: string): CountryListResult {
  const entries = parseList(text.toUpperCase(), { separators: /[\n,;\s]+/ });
  const result: CountryListResult = { valid: [], invalid: [] };
  for (const entry of entries) (isCountryCode(entry) ? result.valid : result.invalid).push(entry);
  return result;
}

// ── Ports ──────────────────────────────────────────────────────────────────

/** Port rules are added one request per port; keep a bulk add reviewable. */
export const MAX_PORTS_PER_ADD = 20;

export interface PortListResult {
  ports: number[];
  invalid: string[];
  error: string | null;
}

export function parsePortInput(text: string, max = MAX_PORTS_PER_ADD): PortListResult {
  const entries = parseList(text, { separators: /[\n,\s]+/ });
  const ports: number[] = [];
  const invalid: string[] = [];
  for (const entry of entries) {
    if (/^\d{1,5}$/.test(entry) && Number(entry) >= 1 && Number(entry) <= 65535) {
      const port = Number(entry);
      if (!ports.includes(port)) ports.push(port);
    } else {
      invalid.push(entry);
    }
  }
  let error: string | null = null;
  if (invalid.length) error = `Not a port (1–65535): ${invalid.join(', ')}.`;
  else if (!ports.length) error = 'Enter at least one port.';
  else if (ports.length > max) error = `Add at most ${max} ports at a time.`;
  return { ports, invalid, error };
}

// ── Allowlist port scopes ─────────────────

/** Most scope items one allowlist entry may carry after normalising (ALLOWLIST_PORTS_TOO_MANY). */
export const MAX_ALLOW_PORT_SCOPES = 8;

const PROTO_ORDER: Record<EBPFPortScope['proto'], number> = { any: 0, tcp: 1, udp: 2 };

function scopeEnd(scope: EBPFPortScope): number {
  return scope.to && scope.to > 0 ? scope.to : scope.from;
}

/** True when `scope` covers `port` for `proto` ("any" covers TCP and UDP). */
export function scopeCovers(scope: EBPFPortScope, port: number, proto: 'tcp' | 'udp'): boolean {
  return (scope.proto === 'any' || scope.proto === proto) && port >= scope.from && port <= scopeEnd(scope);
}

/** "22/tcp", "8000-8100/udp", "53/any". */
export function formatPortScope(scope: EBPFPortScope): string {
  const end = scopeEnd(scope);
  return `${end === scope.from ? scope.from : `${scope.from}-${end}`}/${scope.proto}`;
}

/** Badge text of an allowlist entry: "All ports" or "22/tcp, 5432/tcp". */
export function allowPortsLabel(ports: readonly EBPFPortScope[] | null | undefined): string {
  return ports?.length ? ports.map(formatPortScope).join(', ') : 'All ports';
}

/**
 * The server's normal form: sorted by port, overlapping or adjacent ranges of
 * one protocol merged, tcp/udp ranges inside an "any" range dropped; a single
 * port carries no `to`.
 */
export function normalizePortScopes(scopes: readonly EBPFPortScope[]): EBPFPortScope[] {
  type Range = { proto: EBPFPortScope['proto']; lo: number; hi: number };
  const merged: Range[] = [];
  for (const proto of ['any', 'tcp', 'udp'] as const) {
    const ranges = scopes
      .filter((scope) => scope.proto === proto)
      .map((scope): Range => ({ proto, lo: scope.from, hi: scopeEnd(scope) }))
      .sort((a, b) => a.lo - b.lo || a.hi - b.hi);
    const out: Range[] = [];
    for (const range of ranges) {
      const last = out[out.length - 1];
      if (last && range.lo <= last.hi + 1) last.hi = Math.max(last.hi, range.hi);
      else out.push({ ...range });
    }
    merged.push(...out);
  }
  const anyRanges = merged.filter((range) => range.proto === 'any');
  return merged
    .filter((range) => range.proto === 'any' || !anyRanges.some((any) => any.lo <= range.lo && range.hi <= any.hi))
    .sort((a, b) => a.lo - b.lo || PROTO_ORDER[a.proto] - PROTO_ORDER[b.proto] || a.hi - b.hi)
    .map((range): EBPFPortScope => (range.lo === range.hi ? { proto: range.proto, from: range.lo } : { proto: range.proto, from: range.lo, to: range.hi }));
}

const SCOPE_RE = /^(\d{1,5})(?:-(\d{1,5}))?(?:\/([a-z+]*))?$/;

/** One "22/tcp", "8000-8100/udp" or "53/any" item ("tcp+udp" = any), or why it is not one. */
export function parsePortScopeItem(token: string): { scope: EBPFPortScope | null; error: string | null } {
  const match = SCOPE_RE.exec(token.trim().toLowerCase());
  if (!match) return { scope: null, error: 'Write a port or range with a protocol, e.g. 22/tcp or 8000-8100/udp.' };
  const from = Number(match[1]);
  const to = match[2] === undefined ? from : Number(match[2]);
  if (from < 1 || from > 65535 || to < 1 || to > 65535) return { scope: null, error: 'Ports run from 1 to 65535.' };
  if (from > to) return { scope: null, error: 'The range is reversed; put the lower port first.' };
  const raw = match[3];
  const port = match[2] === undefined ? match[1] : `${match[1]}-${match[2]}`;
  if (raw === undefined || raw === '') return { scope: null, error: `Add a protocol: ${port}/tcp, ${port}/udp or ${port}/any.` };
  const proto = raw === 'tcp+udp' ? 'any' : raw;
  if (proto !== 'tcp' && proto !== 'udp' && proto !== 'any') return { scope: null, error: 'The protocol is tcp, udp or any (TCP and UDP).' };
  return { scope: from === to ? { proto, from } : { proto, from, to }, error: null };
}

export interface PortScopeListResult {
  /** Normalised scopes (normalizePortScopes). */
  scopes: EBPFPortScope[];
  invalid: Array<{ value: string; error: string }>;
  error: string | null;
}

function scopeTokens(text: string): string[] {
  return text.split(/[\n,;\s]+/).map((token) => token.trim()).filter(Boolean);
}

/** Parses "22/tcp, 5432/tcp, 8000-8100/udp, 53/any" with the server's limits. */
export function parsePortScopes(text: string, max = MAX_ALLOW_PORT_SCOPES): PortScopeListResult {
  const parsed: EBPFPortScope[] = [];
  const invalid: Array<{ value: string; error: string }> = [];
  for (const token of scopeTokens(text)) {
    const item = parsePortScopeItem(token);
    if (item.scope) parsed.push(item.scope);
    else invalid.push({ value: token, error: item.error ?? 'Not a port scope.' });
  }
  const scopes = normalizePortScopes(parsed);
  let error: string | null = null;
  if (invalid.length === 1) error = `${invalid[0].value}: ${invalid[0].error}`;
  else if (invalid.length) error = `${invalid.length} items are not valid (${invalid.map((item) => item.value).join(', ')}); write each as 22/tcp, 8000-8100/udp or 53/any.`;
  else if (!scopes.length) error = 'Enter at least one port, or choose All ports.';
  else if (scopes.length > max) error = `${scopes.length} port scopes after merging; an entry takes at most ${max}. Merge ports into ranges.`;
  return { scopes, invalid, error };
}

/** Adds `token` to a comma-separated scope list, or removes it when present (preset chips). */
export function togglePortToken(text: string, token: string): string {
  const tokens = scopeTokens(text);
  const key = token.toLowerCase();
  const kept = tokens.filter((item) => item.toLowerCase() !== key);
  return (kept.length === tokens.length ? [...tokens, token] : kept).join(', ');
}

/** True when the comma-separated list names `token`. */
export function hasPortToken(text: string, token: string): boolean {
  const key = token.toLowerCase();
  return scopeTokens(text).some((item) => item.toLowerCase() === key);
}

export interface PortPreset {
  label: string;
  token: string;
}

/** Presets of the allowlist Ports field: the host's SSH ports (22 when none reported), then common services. */
export function allowPortPresets(sshPorts?: readonly number[] | null): PortPreset[] {
  const presets: PortPreset[] = guardedSSHPorts(sshPorts).map((port) => ({ label: `SSH (${port}/tcp)`, token: `${port}/tcp` }));
  for (const preset of [
    { label: 'HTTPS (443/tcp)', token: '443/tcp' },
    { label: 'PostgreSQL (5432/tcp)', token: '5432/tcp' },
  ]) {
    if (!presets.some((item) => item.token === preset.token)) presets.push(preset);
  }
  return presets;
}

/** Why an allowlist add with `ports` cannot be sent, or null (ALLOWLIST_WILDCARD_SCOPED). */
export function allowAddProblem(addresses: readonly string[], ports: readonly EBPFPortScope[] | undefined): string | null {
  if (!ports?.length) return null;
  const wildcard = addresses.filter(matchesEverything);
  if (wildcard.length) return `${wildcard.join(' and ')} cannot be scoped to ports; use a port rule for that.`;
  return null;
}

// ── TTL ────────────────────────────────────────────────────────────────────

export type TtlKey = '15m' | '1h' | '24h' | 'permanent' | 'custom';

export interface TtlOption {
  key: TtlKey;
  label: string;
  longLabel: string;
  /** Milliseconds; null = permanent or custom. */
  ms: number | null;
}

export const TTL_OPTIONS: readonly TtlOption[] = [
  { key: '15m', label: '15m', longLabel: 'Expires after 15 minutes', ms: 15 * 60_000 },
  { key: '1h', label: '1h', longLabel: 'Expires after 1 hour', ms: 60 * 60_000 },
  { key: '24h', label: '24h', longLabel: 'Expires after 24 hours', ms: 24 * 60 * 60_000 },
  { key: 'permanent', label: 'Permanent', longLabel: 'Never expires', ms: null },
  { key: 'custom', label: 'Custom', longLabel: 'Custom expiry', ms: null },
];

export type TtlUnit = 'minutes' | 'hours' | 'days';

const UNIT_MS: Record<TtlUnit, number> = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 };

/** Longest custom expiry (one year). */
export const MAX_TTL_MS = 365 * 86_400_000;

export interface TtlResult {
  /** Milliseconds, or undefined for a permanent rule. */
  ms: number | undefined;
  error: string | null;
}

/** The ttl_ms to send for a chip (and a custom amount); undefined = permanent. */
export function resolveTtl(key: TtlKey, custom?: { amount: number | string | null | undefined; unit: TtlUnit }): TtlResult {
  if (key === 'permanent') return { ms: undefined, error: null };
  if (key !== 'custom') return { ms: TTL_OPTIONS.find((option) => option.key === key)?.ms ?? undefined, error: null };
  const amount = Number(custom?.amount);
  if (!custom || custom.amount === '' || custom.amount === null || custom.amount === undefined || !Number.isInteger(amount) || amount < 1) {
    return { ms: undefined, error: 'Enter a whole number of minutes, hours or days (at least 1).' };
  }
  const ms = amount * UNIT_MS[custom.unit];
  if (ms > MAX_TTL_MS) return { ms: undefined, error: 'Expiry can be at most 365 days; choose Permanent for longer.' };
  return { ms, error: null };
}

/** "Permanent", "15m", "1h", "24h", or "3d" style text for a TTL in ms. */
export function describeTtl(ms: number | undefined): string {
  if (ms === undefined) return 'Permanent';
  const option = TTL_OPTIONS.find((item) => item.ms === ms);
  if (option) return option.label;
  if (ms % UNIT_MS.days === 0) return `${ms / UNIT_MS.days}d`;
  if (ms % UNIT_MS.hours === 0) return `${ms / UNIT_MS.hours}h`;
  return `${Math.round(ms / UNIT_MS.minutes)}m`;
}

// ── Add requests ───────────────────────────────────────────────────────────

export type AccessRuleAdd =
  | { type: 'block' | 'egress'; addresses: string[]; ttlMs?: number }
  | { type: 'allow'; addresses: string[]; ttlMs?: number; /** Empty or absent = all ports. */ ports?: EBPFPortScope[] }
  | { type: 'geo'; codes: string[]; /** Adds to the allowed countries (allow mode). */ allow?: boolean }
  | { type: 'port'; ports: number[]; proto: string; direction: RuleDirection; action: RuleAction; ttlMs?: number };

function count(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/** One line for the review step, e.g. "Block 3 source addresses inbound, expires after 1h". */
export function describeAdd(request: AccessRuleAdd): string {
  const expiry = (ms: number | undefined) => (ms === undefined ? 'permanent' : `expires after ${describeTtl(ms)}`);
  switch (request.type) {
    case 'block':
      return `Block ${count(request.addresses.length, 'source address', 'source addresses')} inbound, ${expiry(request.ttlMs)}`;
    case 'allow':
      return request.ports?.length
        ? `Allow ${count(request.addresses.length, 'source address', 'source addresses')} past the inbound checks on ${allowPortsLabel(request.ports)} only, ${expiry(request.ttlMs)}`
        : `Allow ${count(request.addresses.length, 'source address', 'source addresses')} past every inbound check on every port, ${expiry(request.ttlMs)}`;
    case 'egress':
      return `Block outbound traffic to ${count(request.addresses.length, 'address', 'addresses')}, ${expiry(request.ttlMs)}`;
    case 'geo':
      return request.allow
        ? `Allow inbound traffic from ${count(request.codes.length, 'more country', 'more countries')}`
        : `Block inbound traffic from ${count(request.codes.length, 'country', 'countries')}`;
    case 'port': {
      const verb = request.action === 'allow' ? 'Allow' : request.action === 'log' ? 'Log' : 'Drop';
      const proto = request.proto === 'any' ? 'any protocol' : request.proto.toUpperCase();
      const direction = request.direction === 'both' ? 'both directions' : request.direction;
      return `${verb} ${proto} on ${count(request.ports.length, 'port')} (${request.ports.join(', ')}), ${direction}, ${expiry(request.ttlMs)}`;
    }
  }
}

export interface AddContext {
  /** Geo-blocking switch in Settings. */
  geoEnabled?: boolean;
  /** Connection tracking switch in Settings. */
  conntrack?: boolean;
  /** Current allowlist, for the wildcard-block guard. */
  allowlist?: readonly EBPFAllowlistEntry[] | null;
  /** sshd ports the host reported (empty = 22), for the lockout-escape check. */
  sshPorts?: readonly number[] | null;
  portPolicy?: { enabled: boolean; default_ingress: string; default_egress: string } | null;
}

/** Consequences the operator should read before adding (shown in the review step). */
export function addWarnings(request: AccessRuleAdd, ctx: AddContext = {}): string[] {
  const warnings: string[] = [];
  if (request.type === 'block' || request.type === 'allow' || request.type === 'egress') {
    const everything = request.addresses.filter(matchesEverything);
    if (everything.length) {
      const which = everything.join(' and ');
      if (request.type === 'block') {
        warnings.push(`${which} blocks every source that is not allowlisted. This cuts off all inbound access to the host, including SSH.`);
        for (const value of everything) {
          const family = value.includes(':') ? 6 : 4;
          if (!hasPermanentAllowlistFamily(ctx.allowlist, family, ctx.sshPorts)) {
            warnings.push(`${value} needs a permanent IPv${family} allowlist entry for your management network first, on all ports or covering the SSH port over TCP; the control plane refuses it otherwise (WILDCARD_BLOCK_NEEDS_ALLOWLIST).`);
          }
        }
      }
      if (request.type === 'allow') warnings.push(`${which} lets every source bypass inbound filtering; geo-blocking, the blocklist, port rules and rate limits stop applying.`);
      if (request.type === 'egress') warnings.push(`${which} blocks every outbound connection, DNS included. Replies to inbound connections, the control-plane connection, DHCP and IPv6 neighbour discovery stay open.`);
      if ((request.type === 'block' || request.type === 'egress') && ctx.conntrack === false) {
        warnings.push('Blocking 0.0.0.0/0 or ::/0 requires connection tracking; turn it on in Settings first (CONNTRACK_REQUIRED).');
      }
    }
    if (request.type === 'allow') warnings.push(...allowWarnings(request, ctx));
  }
  if (request.type === 'geo' && !request.allow && ctx.geoEnabled === false) {
    warnings.push('Geo-blocking is turned off in Settings; these countries are stored but not blocked until you turn it on.');
  }
  if (request.type === 'port') {
    if (ctx.portPolicy && !ctx.portPolicy.enabled) warnings.push('Port rules are turned off in Settings; this rule is stored but not applied until you turn them on.');
    if (request.action === 'drop' && request.direction !== 'egress' && request.ports.includes(22)) {
      warnings.push('Dropping port 22 inbound closes SSH to this host unless your address is allowlisted.');
    }
    if (request.action === 'allow' && request.direction !== 'egress' && request.ttlMs !== undefined && ctx.portPolicy?.default_ingress === 'deny') {
      warnings.push('An expiring ALLOW rule does not keep SSH open under ingress Deny all; only a permanent TCP ALLOW on the SSH port counts.');
    }
    if (request.action === 'drop' && request.direction !== 'egress' && request.ttlMs !== undefined && ctx.portPolicy?.default_ingress === 'deny' && request.ports.includes(DEFAULT_SSH_PORT)) {
      warnings.push('An expiring DROP on the SSH port overrides its ALLOW until it lapses; the control plane refuses it under ingress Deny all (SSH_ALLOW_REQUIRED).');
    }
  }
  return warnings;
}

function allowWarnings(request: Extract<AccessRuleAdd, { type: 'allow' }>, ctx: AddContext): string[] {
  const warnings: string[] = [];
  const ports = request.ports ?? [];
  if (ports.length) {
    warnings.push(`These sources bypass geo-blocking, the blocklist, port rules and rate limits only on ${allowPortsLabel(ports)}; on other ports, and for ICMP, they meet the normal checks.`);
  } else {
    warnings.push('These sources bypass geo-blocking, the blocklist, port rules and rate limits on every port, ICMP included.');
  }
  const existing = new Map((ctx.allowlist ?? []).map((entry) => [entry.ip.trim(), entry] as const));
  const replaced = request.addresses.filter((address) => existing.has(address.trim()));
  if (replaced.length) {
    const list = replaced.length > 3 ? `${replaced.slice(0, 3).join(', ')} and ${replaced.length - 3} more` : replaced.join(', ');
    warnings.push(`${list} ${replaced.length === 1 ? 'is' : 'are'} already allowlisted; ${replaced.length === 1 ? 'its' : 'their'} ports and expiry are replaced with these.`);
    const permanent = !request.ttlMs;
    const staysEscape = permanent && isLockoutEscape({ ip: '', added_at: '', hit_count: 0, ports }, ctx.sshPorts);
    const lost = replaced.filter((address) => {
      const entry = existing.get(address.trim());
      return entry ? isLockoutEscape(entry, ctx.sshPorts) : false;
    });
    if (lost.length && !staysEscape) {
      warnings.push(`${lost.join(', ')} ${lost.length === 1 ? 'stops' : 'stop'} being a lockout escape (permanent, on all ports or covering the SSH port over TCP). If a 0.0.0.0/0 or ::/0 block relies on it, the control plane refuses the change (WILDCARD_BLOCK_NEEDS_ALLOWLIST).`);
    }
  }
  return warnings;
}

/** Time left until `expiresAt`: "12 min", "3 h", "2 d", or "expiring" when due. */
export function timeLeft(expiresAt: string | undefined | null, now = Date.now()): string {
  const ms = timeOf(expiresAt);
  if (ms === null) return 'Permanent';
  const left = ms - now;
  if (left <= 0) return 'Expiring';
  const minutes = Math.ceil(left / 60_000);
  if (minutes < 60) return `${minutes} min left`;
  const hours = Math.ceil(left / 3_600_000);
  if (hours < 48) return `${hours} h left`;
  return `${Math.ceil(left / 86_400_000)} d left`;
}
