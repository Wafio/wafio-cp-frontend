/**
 * Host fleet helpers: the Hosts page's
 * client-side filters and their URL form, KPI counts, label facets, the
 * selection model of the fleet table, and the request/response helpers of
 * "apply to many hosts" (firewall rule → apply op, id chunking, retryable
 * hosts, text for attention and degraded codes).
 *
 * Pure functions: no Svelte, no API client.
 */

import type {
  FirewallApplyEntry,
  FirewallApplyOp,
  FirewallApplyPortPolicy,
  FleetAttention,
  FleetFirewallState,
  FleetHost,
  FleetRuntimeState,
  HostApplyResponse,
  HostApplyResult,
  HostApplyStatus,
} from './api';
import type { AccessRuleAdd, RuleDirection } from './components/firewall/rules';
import { filterHosts } from './host-nav';
import { hasUnsafeChars } from './validation';
import type { ReadonlyURLSearchParams } from '$app/state';

// ── Filters (URL state) ───────────────────────────────────────────────────

export const HOST_STATUSES = ['online', 'pending', 'offline', 'revoked'] as const;
export const FIREWALL_STATES: readonly FleetFirewallState[] = ['enforce', 'monitor', 'off', 'not_running', 'no_agent', 'unknown'];
export const RUNTIME_STATES: readonly FleetRuntimeState[] = ['on', 'off', 'no_agent', 'unknown'];

export interface FleetFilterState {
  /** Host status, '' = any. */
  status: '' | (typeof HOST_STATUSES)[number];
  fw: '' | FleetFirewallState;
  rt: '' | FleetRuntimeState;
  /** Only hosts with at least one attention code. */
  attention: boolean;
  label: { key: string; value: string } | null;
  /** Free text, matched with `filterHosts` of $lib/host-nav. */
  q: string;
}

export const EMPTY_FLEET_FILTERS: FleetFilterState = { status: '', fw: '', rt: '', attention: false, label: null, q: '' };

/** URL keys the fleet filters own. */
export const FLEET_FILTER_KEYS = ['status', 'fw', 'rt', 'attention', 'label', 'q'] as const;

function oneOf<T extends string>(value: string | null, allowed: readonly T[]): T | '' {
  return value && (allowed as readonly string[]).includes(value) ? (value as T) : '';
}

/** `k=v` → label selector (split at the first `=`); anything else → null. */
export function parseLabelParam(value: string | null | undefined): { key: string; value: string } | null {
  if (!value) return null;
  const eq = value.indexOf('=');
  if (eq <= 0) return null;
  return { key: value.slice(0, eq), value: value.slice(eq + 1) };
}

export function labelParam(label: { key: string; value: string }): string {
  return `${label.key}=${label.value}`;
}

/** Filter state from the page URL; unknown values fall back to "any". */
export function readFleetFilters(search: ReadonlyURLSearchParams): FleetFilterState {
  return {
    status: oneOf(search.get('status'), HOST_STATUSES),
    fw: oneOf(search.get('fw'), FIREWALL_STATES),
    rt: oneOf(search.get('rt'), RUNTIME_STATES),
    attention: search.get('attention') === '1',
    label: parseLabelParam(search.get('label')),
    q: (search.get('q') ?? '').slice(0, 200),
  };
}

/**
 * The query string for `state`: sets or drops each filter key and keeps
 * every other parameter. Returns '' or a string starting with '?'.
 */
export function fleetFilterSearch(search: ReadonlyURLSearchParams, state: FleetFilterState): string {
  const next = new URLSearchParams(search.toString());
  for (const key of FLEET_FILTER_KEYS) next.delete(key);
  if (state.status) next.set('status', state.status);
  if (state.fw) next.set('fw', state.fw);
  if (state.rt) next.set('rt', state.rt);
  if (state.attention) next.set('attention', '1');
  if (state.label) next.set('label', labelParam(state.label));
  if (state.q.trim()) next.set('q', state.q.trim());
  const s = next.toString();
  return s ? `?${s}` : '';
}

export function hasActiveFilters(state: FleetFilterState): boolean {
  return Boolean(state.status || state.fw || state.rt || state.attention || state.label || state.q.trim());
}

/** The rows matching every active filter, in input order. */
export function applyFleetFilters<H extends FleetHost>(hosts: readonly H[], state: FleetFilterState): H[] {
  const filtered = hosts.filter((host) => {
    if (state.status && host.status !== state.status) return false;
    if (state.fw && host.protection.firewall.state !== state.fw) return false;
    if (state.rt && host.protection.runtime.state !== state.rt) return false;
    if (state.attention && !host.protection.attention.length) return false;
    if (state.label && (host.labels ?? {})[state.label.key] !== state.label.value) return false;
    return true;
  });
  return state.q.trim() ? filterHosts(filtered, state.q) : filtered;
}

export interface LabelFacet {
  key: string;
  value: string;
  count: number;
}

/** Every `key=value` carried by the hosts, with its host count; by key, then value. */
export function labelFacets(hosts: readonly Pick<FleetHost, 'labels'>[]): LabelFacet[] {
  const counts = new Map<string, LabelFacet>();
  for (const host of hosts) {
    for (const [key, value] of Object.entries(host.labels ?? {})) {
      const id = `${key}\u0000${value}`;
      const facet = counts.get(id);
      if (facet) facet.count++;
      else counts.set(id, { key, value, count: 1 });
    }
  }
  return [...counts.values()].sort((a, b) => a.key.localeCompare(b.key) || a.value.localeCompare(b.value, undefined, { numeric: true }));
}

// ── KPI strip ─────────────────────────────────────────────────────────────

export interface FleetCounts {
  hosts: number;
  online: number;
  firewallEnforcing: number;
  runtimeOn: number;
  attention: number;
  outdated: number;
}

/** Counts for the KPI strip; revoked hosts count as hosts only. */
export function fleetCounts(hosts: readonly FleetHost[]): FleetCounts {
  const out: FleetCounts = { hosts: hosts.length, online: 0, firewallEnforcing: 0, runtimeOn: 0, attention: 0, outdated: 0 };
  for (const host of hosts) {
    if (host.status === 'online') out.online++;
    if (host.status === 'revoked') continue;
    const p = host.protection;
    if (p.firewall.state === 'enforce') out.firewallEnforcing++;
    if (p.runtime.state === 'on') out.runtimeOn++;
    if (p.attention.length) out.attention++;
    if (hasOutdatedAgent(host)) out.outdated++;
  }
  return out;
}

export function hasOutdatedAgent(host: Pick<FleetHost, 'protection'>): boolean {
  return host.protection.agents.host?.outdated === true || host.protection.agents.waf.outdated === true;
}

// ── Selection ─────────────────────────────────────────────────────────────

export type HeaderCheckState = 'all' | 'some' | 'none';

/** Header checkbox state over `ids` (the filtered rows). */
export function headerCheckState(selected: readonly string[], ids: readonly string[]): HeaderCheckState {
  if (!ids.length) return 'none';
  const set = new Set(selected);
  const hits = ids.filter((id) => set.has(id)).length;
  return hits === 0 ? 'none' : hits === ids.length ? 'all' : 'some';
}

/**
 * Header checkbox click: when every one of `ids` is selected, unselects them;
 * otherwise selects all of them. Selected ids outside `ids` stay.
 */
export function toggleAllIds(selected: readonly string[], ids: readonly string[]): string[] {
  if (headerCheckState(selected, ids) === 'all') {
    const drop = new Set(ids);
    return selected.filter((id) => !drop.has(id));
  }
  const out = [...selected];
  const have = new Set(selected);
  for (const id of ids) if (!have.has(id)) out.push(id);
  return out;
}

export function toggleId(selected: readonly string[], id: string): string[] {
  return selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id];
}

/** Keeps only selected ids that still exist (after a refresh). */
export function pruneSelection(selected: readonly string[], hosts: readonly Pick<FleetHost, 'id'>[]): string[] {
  const ids = new Set(hosts.map((h) => h.id));
  const next = selected.filter((id) => ids.has(id));
  return next.length === selected.length ? (selected as string[]) : next;
}

// ── Apply: firewall rule → request ────────────────────────────────────────

export type FirewallApplyPayload = { op: FirewallApplyOp; entries?: FirewallApplyEntry[]; policies?: FirewallApplyPortPolicy[] };

/** A firewall removal request of the bulk flow (geo is out of scope). */
export type FirewallRemove =
  | { type: 'block' | 'allow' | 'egress'; addresses: string[] }
  | { type: 'port'; ports: number[]; proto: string; direction: RuleDirection };

const LIST_OP: Record<'block' | 'allow' | 'egress', 'blocklist' | 'allowlist' | 'egress_blocklist'> = {
  block: 'blocklist',
  allow: 'allowlist',
  egress: 'egress_blocklist',
};

/**
 * The apply op and body items for an add request of the AddRulesDrawer.
 * Geo is refused (geo stays a per-host action).
 */
export function accessRuleToApply(request: AccessRuleAdd): { payload: FirewallApplyPayload | null; error: string | null } {
  switch (request.type) {
    case 'block':
    case 'egress':
    case 'allow': {
      const ports = request.type === 'allow' && request.ports?.length ? request.ports : undefined;
      const entries: FirewallApplyEntry[] = request.addresses.map((ip) => ({
        ip,
        ...(request.ttlMs !== undefined ? { ttl_ms: request.ttlMs } : {}),
        ...(ports ? { ports } : {}),
      }));
      return { payload: { op: `${LIST_OP[request.type]}.add` as FirewallApplyOp, entries }, error: null };
    }
    case 'port': {
      const policies: FirewallApplyPortPolicy[] = request.ports.map((port) => ({
        port,
        proto: request.proto,
        direction: request.direction,
        action: request.action,
        ...(request.ttlMs !== undefined ? { ttl_ms: request.ttlMs } : {}),
      }));
      return { payload: { op: 'port_policies.add', policies }, error: null };
    }
    case 'geo':
      return { payload: null, error: 'Countries cannot be applied to many hosts at once; change geo policy on each host’s Firewall page.' };
  }
}

/** The apply op and body items for a removal. */
export function removeRuleToApply(request: FirewallRemove): FirewallApplyPayload {
  if (request.type === 'port') {
    return { op: 'port_policies.remove', policies: request.ports.map((port) => ({ port, proto: request.proto, direction: request.direction })) };
  }
  return { op: `${LIST_OP[request.type]}.remove` as FirewallApplyOp, entries: request.addresses.map((ip) => ({ ip })) };
}

/** Item count of a payload (entries or port rules). */
export function payloadSize(payload: FirewallApplyPayload): number {
  return (payload.entries?.length ?? 0) + (payload.policies?.length ?? 0);
}

/** True when the payload holds a port-scoped allowlist entry (needs `allowlist_ports`). */
export function payloadNeedsAllowlistPorts(payload: FirewallApplyPayload | null): boolean {
  return Boolean(payload?.op === 'allowlist.add' && payload.entries?.some((e) => e.ports?.length));
}

/** One sentence for the review step. */
export function describeRemove(request: FirewallRemove): string {
  const n = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;
  switch (request.type) {
    case 'block':
      return `Remove ${n(request.addresses.length, 'blocklist entry', 'blocklist entries')}`;
    case 'allow':
      return `Remove ${n(request.addresses.length, 'allowlist entry', 'allowlist entries')}`;
    case 'egress':
      return `Remove ${n(request.addresses.length, 'egress blocklist entry', 'egress blocklist entries')}`;
    case 'port': {
      const proto = request.proto === 'any' ? 'any protocol' : request.proto.toUpperCase();
      const direction = request.direction === 'both' ? 'both directions' : request.direction;
      return `Remove ${n(request.ports.length, 'port rule')} (${request.ports.join(', ')}, ${proto}, ${direction})`;
    }
  }
}

// ── Apply: targets, chunks, results ──────────────────────────────────────

/** Most host ids one apply request takes. */
export const MAX_APPLY_HOSTS = 1000;

export function chunkIds<T>(ids: readonly T[], size = MAX_APPLY_HOSTS): T[][] {
  if (size < 1) throw new Error('chunk size must be at least 1');
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/** Codes of results worth re-sending as-is: load, races and timeouts. */
export const RETRYABLE_CODES = ['DEADLINE', 'STATE_CONFLICT', 'STATE_UNAVAILABLE', 'INTERNAL_ERROR', 'NOT_SENT'] as const;

/**
 * Client-side code of a host whose chunk was never answered: its request (or
 * an earlier chunk's) was refused, so nothing was sent for it.
 */
export const NOT_SENT_CODE = 'NOT_SENT';

/** Host ids of failed or skipped results whose code is retryable. */
export function retryableHostIds(results: readonly Pick<HostApplyResult, 'host_id' | 'status' | 'code'>[]): string[] {
  return results
    .filter((r) => (r.status === 'failed' || r.status === 'skipped') && (RETRYABLE_CODES as readonly string[]).includes(r.code))
    .map((r) => r.host_id);
}

const EMPTY_SUMMARY = (): Record<HostApplyStatus, number> => ({ applied: 0, would_apply: 0, unchanged: 0, failed: 0, skipped: 0 });

/** Summary counted from results (the server's summary of several chunks, or a filtered list). */
export function summarize(results: readonly Pick<HostApplyResult, 'status'>[]): Record<HostApplyStatus, number> {
  const out = EMPTY_SUMMARY();
  for (const r of results) if (r.status in out) out[r.status]++;
  return out;
}

/** Joins the responses of several chunks into one. */
export function mergeApplyResponses(responses: readonly HostApplyResponse[]): HostApplyResponse | null {
  if (!responses.length) return null;
  const results = responses.flatMap((r) => r.results ?? []);
  const digest = responses.find((r) => r.source_digest)?.source_digest;
  return {
    apply_id: responses.find((r) => r.apply_id)?.apply_id ?? null,
    op: responses[0].op,
    dry_run: responses[0].dry_run,
    results,
    summary: summarize(results),
    total: results.length,
    ...(digest ? { source_digest: digest } : {}),
  };
}

/**
 * Outcome of a chunked apply that stopped at a refused chunk: the answered
 * chunks' results plus every host of the refused and later chunks as failed
 * (`NOT_SENT`, carrying the request error), so no host goes missing and the
 * summary never reads as a clean success. null when no chunk was answered
 * (nothing was changed; the caller shows the error alone).
 */
export function partialApplyResponse(
  answered: readonly HostApplyResponse[],
  unsentIds: readonly string[],
  nameOf: (id: string) => string,
  error: string,
): HostApplyResponse | null {
  const merged = mergeApplyResponses(answered);
  if (!merged) return null;
  const seen = new Set(merged.results.map((r) => r.host_id));
  const results = [...merged.results];
  for (const id of unsentIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    results.push({ host_id: id, host_name: nameOf(id) || id, status: 'failed', code: NOT_SENT_CODE, error });
  }
  return { ...merged, results, summary: summarize(results), total: results.length };
}

/**
 * Replaces the results of hosts that were re-sent with the new ones (retry),
 * keeping every other host's earlier outcome.
 */
export function replaceResults(previous: HostApplyResponse, retry: HostApplyResponse): HostApplyResponse {
  const fresh = new Map(retry.results.map((r) => [r.host_id, r]));
  const results = previous.results.map((r) => fresh.get(r.host_id) ?? r);
  for (const r of retry.results) if (!previous.results.some((p) => p.host_id === r.host_id)) results.push(r);
  return { ...previous, apply_id: retry.apply_id ?? previous.apply_id, results, summary: summarize(results), total: results.length };
}

/** Non-revoked hosts carrying `key=value` (what a label target resolves to now). */
export function hostsWithLabel<H extends Pick<FleetHost, 'labels' | 'status'>>(hosts: readonly H[], label: { key: string; value: string }): H[] {
  return hosts.filter((h) => h.status !== 'revoked' && (h.labels ?? {})[label.key] === label.value);
}

/**
 * "Items" cell of an apply result. Copies report created / replaced /
 * already there; firewall adds and removes report `count` = entries added or
 * removed on that host ("2 added", "would remove 1"); nothing → "".
 */
export function applyCountText(
  r: Pick<HostApplyResult, 'count' | 'created' | 'replaced' | 'existing'>,
  op: string,
  dryRun: boolean,
): string {
  const parts: string[] = [];
  if (r.created) parts.push(`${r.created} created`);
  if (r.replaced) parts.push(`${r.replaced} replaced`);
  if (r.existing) parts.push(`${r.existing} already there`);
  if (parts.length || r.count === undefined) return parts.join(', ');
  if (!r.count) return '';
  const verb = op.endsWith('.remove') ? 'remove' : op.endsWith('.add') ? 'add' : null;
  if (!verb) return `${r.count} ${r.count === 1 ? 'item' : 'items'}`;
  return dryRun ? `would ${verb} ${r.count}` : `${r.count} ${verb === 'add' ? 'added' : 'removed'}`;
}

/** Text the typed confirmation expects, e.g. "12 hosts" / "1 host". */
export function hostCountPhrase(n: number): string {
  return `${n} ${n === 1 ? 'host' : 'hosts'}`;
}

// ── Target hints ─────────────────────────────────────────────────────────

export interface TargetHint {
  tone: 'warning' | 'info' | 'neutral';
  text: string;
}

/**
 * What will happen on one target host before the dry run: skipped without a
 * host agent, stored for later when its agent is offline, refused for a
 * port-scoped allowlist entry on an agent without `allowlist_ports`.
 * `needsAgent` is false for detection rules (they run at ingest).
 */
export function targetHints(
  host: Pick<FleetHost, 'status' | 'protection'>,
  opts: { needsAgent?: boolean; scopedAllowlist?: boolean } = {},
): TargetHint[] {
  const hints: TargetHint[] = [];
  const agent = host.protection.agents.host;
  if (host.status === 'revoked') return [{ tone: 'neutral', text: 'Revoked: skipped' }];
  if (!agent) {
    if (opts.needsAgent ?? true) hints.push({ tone: 'neutral', text: 'No host agent: skipped' });
    return hints;
  }
  if (!agent.online) hints.push({ tone: 'info', text: 'Agent offline: stored, delivered on reconnect' });
  if (opts.scopedAllowlist && !host.protection.firewall.features.includes('allowlist_ports')) {
    hints.push({ tone: 'warning', text: 'No port-scoped allowlist support: refused' });
  }
  return hints;
}

// ── Text ─────────────────────────────────────────────────────────────────

export const FIREWALL_STATE_TEXT: Record<FleetFirewallState, string> = {
  enforce: 'Enforcing',
  monitor: 'Monitor only',
  off: 'Off',
  not_running: 'Not running',
  no_agent: 'No host agent',
  unknown: 'Not reported',
};

export const RUNTIME_STATE_TEXT: Record<FleetRuntimeState, string> = {
  on: 'On',
  off: 'Off',
  no_agent: 'No host agent',
  unknown: 'Not reported',
};

export const ATTENTION_TEXT: Record<FleetAttention, string> = {
  host_offline: 'Host offline',
  no_host_agent: 'No host agent',
  host_agent_offline: 'Host agent offline',
  firewall_not_running: 'Firewall not running',
  firewall_degraded: 'Firewall degraded',
  incidents_critical: 'Open critical incidents',
  incidents_high: 'Open high incidents',
  agent_outdated: 'Agent older than the control plane',
};

export function attentionText(code: string): string {
  return (ATTENTION_TEXT as Record<string, string>)[code] ?? code;
}

const DEGRADED_TEXT: Record<string, string> = {
  bundle_failed: 'The last policy push failed on the agent',
  allowlist_scoped_skipped: 'Port-scoped allowlist entries were skipped (agent without port scopes)',
  xdp_detached: 'XDP program not attached',
  tc_egress_detached: 'TC egress program not attached',
  lockout_exemptions_missing: 'Lockout exemptions missing',
  coverage_warnings: 'Coverage warnings reported',
};

/** Text for a `degraded_reasons` code; `bundle_refused:<CODE>` and `geo_degraded:<CODE>` keep their code. */
export function degradedReasonText(reason: string): string {
  const colon = reason.indexOf(':');
  if (colon > 0) {
    const head = reason.slice(0, colon);
    const code = reason.slice(colon + 1);
    if (head === 'bundle_refused') return `Policy refused by the agent's lockout guard (${code})`;
    if (head === 'geo_degraded') return `Geo policy not enforced (${code})`;
  }
  return DEGRADED_TEXT[reason] ?? reason;
}

export const APPLY_STATUS_TEXT: Record<HostApplyStatus, string> = {
  applied: 'Applied',
  would_apply: 'Would apply',
  unchanged: 'Unchanged',
  failed: 'Failed',
  skipped: 'Skipped',
};

const SKIP_TEXT: Record<string, string> = {
  NO_HOST_AGENT: 'No host agent on this host.',
  HOST_REVOKED: 'The host is revoked.',
  SOURCE_HOST: 'This is the source host.',
  NOT_SENT: 'Not sent: the request for this host was refused.',
  DEADLINE: 'Not started before the request deadline; retry it.',
  STATE_CONFLICT: 'The host’s policy changed at the same time; retry it.',
  STATE_UNAVAILABLE: 'The host’s policy could not be read; retry it.',
  INTERNAL_ERROR: 'Internal error; retry it.',
};

/** Fallback text for a result code without a server message. */
export function applyCodeText(code: string): string {
  return SKIP_TEXT[code] ?? '';
}

// ── Label edits (POST /hosts/labels) ─────────────────────────────────────

export const LABEL_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,62}$/;
export const MAX_LABEL_VALUE = 128;
export const MAX_HOST_LABELS = 32;

export interface LabelEdit {
  set: Record<string, string>;
  remove: string[];
  errors: string[];
}

/**
 * Parses the "Set" field (`key=value` pairs, comma or newline separated)
 * and the "Remove" field (keys) with the server's rules: key pattern,
 * value trimmed and at most 128 characters without control, format or bidi characters, a
 * key never in both lists.
 */
export function parseLabelEdit(setText: string, removeText: string): LabelEdit {
  const set: Record<string, string> = {};
  const remove: string[] = [];
  const errors: string[] = [];
  for (const raw of setText.split(/[,\n]/)) {
    const entry = raw.trim();
    if (!entry) continue;
    const eq = entry.indexOf('=');
    const key = eq > 0 ? entry.slice(0, eq).trim() : '';
    if (!key || !LABEL_KEY_RE.test(key)) {
      errors.push(`“${entry}” is not key=value with a valid key (letters, digits, . _ / -; up to 63 characters).`);
      continue;
    }
    const value = entry.slice(eq + 1).trim();
    if (value.length > MAX_LABEL_VALUE) errors.push(`The value of ${key} is longer than ${MAX_LABEL_VALUE} characters.`);
    else if (hasUnsafeChars(value)) errors.push(`The value of ${key} contains control, formatting or bidi characters.`);
    else set[key] = value;
  }
  for (const raw of removeText.split(/[,\s]+/)) {
    const key = raw.trim();
    if (!key) continue;
    if (!LABEL_KEY_RE.test(key)) errors.push(`“${key}” is not a valid label key.`);
    else if (!remove.includes(key)) remove.push(key);
  }
  for (const key of remove) if (key in set) errors.push(`${key} is both set and removed; keep it in one list.`);
  return { set, remove, errors };
}

/** Labels of one host after an edit. */
export function labelsAfter(labels: Record<string, string> | null | undefined, edit: Pick<LabelEdit, 'set' | 'remove'>): Record<string, string> {
  const out: Record<string, string> = { ...(labels ?? {}) };
  for (const key of edit.remove) delete out[key];
  Object.assign(out, edit.set);
  return out;
}

function sameLabels(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => b[k] === a[k]);
}

/** What an edit does to the selected hosts: changed count and hosts past the 32-label cap. */
export function labelEditImpact(
  hosts: readonly { id: string; name: string; labels?: Record<string, string> | null }[],
  edit: Pick<LabelEdit, 'set' | 'remove'>,
): { changed: number; unchanged: number; overLimit: string[] } {
  let changed = 0;
  const overLimit: string[] = [];
  for (const host of hosts) {
    const before = host.labels ?? {};
    const after = labelsAfter(before, edit);
    if (!sameLabels(before, after)) changed++;
    if (Object.keys(after).length > MAX_HOST_LABELS) overLimit.push(host.name);
  }
  return { changed, unchanged: hosts.length - changed, overLimit };
}
