/**
 * Runtime events explorer: keyed rows,
 * facets and client filters over a window fetched from the server.
 *
 * Paging: /host/trace/events and /host/trace/enforcement take `limit`
 * (capped at 1000 by the server), `since_minutes` and `min_severity`, but no
 * offset. The explorer asks the server for a window of the newest rows that
 * match the time range and minimum severity, pages through that window, and
 * grows it (up to the server cap) when the operator pages past its end.
 */
import type { EnforcementLogEntry, TraceEvent } from '#lib/api.js';
import { normalizeSeverity, severityRank } from '../../tone';
import { tacticForEvent } from './mitre';

// ── Keys ─────────────────────────────────────────────────────────────────

/**
 * Stable identity of a trace event: the agent's event_id when present (an
 * outcome update of the same event gets its own key), otherwise time,
 * process, thread and event type.
 */
export function traceEventKey(event: TraceEvent): string {
  const update = (event as TraceEvent & { outcome_update?: boolean }).outcome_update ? ':update' : '';
  if (event.event_id) return `id:${event.event_id}:${event.timestamp}${update}`;
  return `ev:${event.timestamp_ns ?? event.timestamp}:${event.pid}:${event.tid}:${event.event_type}:${event.event_name}${update}`;
}

/** Milliseconds of an RFC 3339 timestamp (0 when missing or invalid). */
export function timeOf(value: string | null | undefined): number {
  const t = value ? Date.parse(value) : NaN;
  return Number.isFinite(t) ? t : 0;
}

/** Newest first (stable for equal times). */
export function sortNewestFirst<T>(rows: readonly T[], timestampOf: (row: T) => string | null | undefined): T[] {
  return rows
    .map((row, index) => ({ row, index, t: timeOf(timestampOf(row)) }))
    .sort((a, b) => b.t - a.t || a.index - b.index)
    .map((item) => item.row);
}

export function enforcementEntryKey(entry: EnforcementLogEntry): string {
  return `enf:${entry.timestamp}:${entry.policy_id}:${entry.action}:${entry.event ? traceEventKey(entry.event) : ''}`;
}

/** Keeps the first row of every key (keyed rendering never sees duplicates). */
export function dedupeByKey<T>(rows: readonly T[], keyOf: (row: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    const key = keyOf(row);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/** `incoming` (newest first) in front of `existing`, deduplicated, at most `cap` rows. */
export function mergeNewest<T>(incoming: readonly T[], existing: readonly T[], keyOf: (row: T) => string, cap: number): T[] {
  return dedupeByKey([...incoming, ...existing], keyOf).slice(0, Math.max(0, cap));
}

// ── Server window ────────────────────────────────────────────────────────

export const WINDOW_INITIAL = 200;
export const WINDOW_STEP = 200;
/** Server cap on ?limit= for trace events and the enforcement log. */
export const WINDOW_CAP = 1000;
export const EXPLORE_PAGE_SIZE = 50;

/** The server may hold older rows: it filled the window and the window can grow. */
export function windowCanGrow(loaded: number, requested: number): boolean {
  return loaded >= requested && requested < WINDOW_CAP;
}

/** Window size that covers rows up to `needed`, grown in steps, capped. */
export function nextWindow(current: number, needed: number): number {
  let next = Math.max(current, WINDOW_INITIAL);
  while (next < needed && next < WINDOW_CAP) next += WINDOW_STEP;
  return Math.min(next, WINDOW_CAP);
}

// ── Minimum severity ─────────────────────────────────────────────────────

export const MIN_SEVERITY_OPTIONS = [
  { value: '', label: 'All severities' },
  { value: 'low', label: 'Low and above' },
  { value: 'medium', label: 'Medium and above' },
  { value: 'high', label: 'High and above' },
  { value: 'critical', label: 'Critical only' },
] as const;

export function parseMinSeverity(value: string | null | undefined): '' | 'low' | 'medium' | 'high' | 'critical' {
  const sev = normalizeSeverity(value);
  return sev && sev !== 'info' ? sev : '';
}

/** The event is at least `min` (''/info = everything). */
export function meetsMinSeverity(event: Pick<TraceEvent, 'severity_name' | 'severity'>, min: string): boolean {
  if (!min || min === 'info') return true;
  const rank = severityRank(event.severity_name || event.severity);
  return rank >= severityRank(min);
}

// ── Facets and filters ───────────────────────────────────────────────────

export type TraceFacet = 'severity' | 'category' | 'event' | 'process' | 'tactic' | 'action' | 'container';
export type EnforcementFacet = 'policy' | 'action' | 'mode' | 'result';

export const TRACE_FACETS: ReadonlyArray<{ id: TraceFacet; label: string; hint?: string }> = [
  { id: 'severity', label: 'Severity' },
  { id: 'category', label: 'Category' },
  { id: 'event', label: 'Event' },
  { id: 'process', label: 'Process' },
  { id: 'tactic', label: 'ATT&CK tactic', hint: 'Heuristic mapping from the event name; not evidence of a technique.' },
  { id: 'action', label: 'Policy action' },
  { id: 'container', label: 'Workload' },
];

export const ENFORCEMENT_FACETS: ReadonlyArray<{ id: EnforcementFacet; label: string }> = [
  { id: 'policy', label: 'Policy' },
  { id: 'action', label: 'Action' },
  { id: 'mode', label: 'Where enforced' },
  { id: 'result', label: 'Result' },
];

export const UNMAPPED = 'Unmapped';

/** Values of a facet for one event (category can list several, e.g. "file,security"). */
export function traceFacetValues(event: TraceEvent, facet: TraceFacet): string[] {
  switch (facet) {
    case 'severity':
      return [normalizeSeverity(event.severity_name || event.severity) ?? 'unknown'];
    case 'category':
      return (event.category || '')
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean);
    case 'event':
      return event.event_name ? [event.event_name] : [];
    case 'process':
      return event.comm ? [event.comm] : [];
    case 'tactic':
      return [tacticForEvent(event.event_name) ?? UNMAPPED];
    case 'action':
      return [eventActionName(event)];
    case 'container':
      return [event.is_container ? 'Container' : 'Host process'];
  }
}

/** Policy action recorded on an event; "monitor" when no policy acted. */
export function eventActionName(event: Pick<TraceEvent, 'action' | 'action_name'>): string {
  return event.action > 0 && event.action_name ? event.action_name : 'monitor';
}

export function enforcementFacetValues(entry: EnforcementLogEntry, facet: EnforcementFacet): string[] {
  switch (facet) {
    case 'policy':
      return [entry.policy_name || `Policy #${entry.policy_id}`];
    case 'action':
      return entry.action ? [entry.action] : [];
    case 'mode':
      return [enforcementModeLabel(entry.mode)];
    case 'result':
      return [entry.success ? 'Accepted' : 'Failed'];
  }
}

export function enforcementModeLabel(mode: EnforcementLogEntry['mode'] | string | undefined): string {
  switch (mode) {
    case 'kernel':
      return 'Kernel signal';
    case 'deferred_outcome':
      return 'Deferred request';
    case 'userspace':
      return 'Userspace';
    default:
      return 'Unknown';
  }
}

export type FacetFilters<F extends string> = Partial<Record<F, string>>;

function matchesFacets<T, F extends string>(row: T, filters: FacetFilters<F>, valuesOf: (row: T, facet: F) => string[], except?: F): boolean {
  for (const [facet, wanted] of Object.entries(filters) as Array<[F, string | undefined]>) {
    if (!wanted || facet === except) continue;
    if (!valuesOf(row, facet).includes(wanted)) return false;
  }
  return true;
}

/**
 * Free-text search over the fields an analyst reads. Numbers (pid, ppid,
 * uid) match exactly; text matches case-insensitively as a substring.
 */
export function traceMatchesSearch(event: TraceEvent, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (/^\d+$/.test(q)) {
    const n = Number(q);
    if (event.pid === n || event.ppid === n || event.uid === n || event.port === n) return true;
  }
  const text = [event.comm, event.parent_comm, event.grandparent_comm, event.filename, event.description, event.event_name, event.args, event.addr, event.container_image, event.container_name];
  return text.some((value) => typeof value === 'string' && value.toLowerCase().includes(q));
}

export function enforcementMatchesSearch(entry: EnforcementLogEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if ((entry.policy_name || '').toLowerCase().includes(q)) return true;
  if ((entry.failure_reason || '').toLowerCase().includes(q)) return true;
  return entry.event ? traceMatchesSearch(entry.event, q) : false;
}

export function filterTraceEvents(rows: readonly TraceEvent[], filters: FacetFilters<TraceFacet>, query: string): TraceEvent[] {
  return rows.filter((row) => matchesFacets(row, filters, traceFacetValues) && traceMatchesSearch(row, query));
}

export function filterEnforcement(rows: readonly EnforcementLogEntry[], filters: FacetFilters<EnforcementFacet>, query: string): EnforcementLogEntry[] {
  return rows.filter((row) => matchesFacets(row, filters, enforcementFacetValues) && enforcementMatchesSearch(row, query));
}

export interface FacetCount {
  value: string;
  count: number;
}

/**
 * Counts per facet value over the rows that pass every other active filter
 * and the search (standard faceting: a facet never filters its own counts).
 * Largest first, at most `top` values; the active value is always kept.
 */
export function computeFacets<T, F extends string>(
  rows: readonly T[],
  facets: readonly F[],
  filters: FacetFilters<F>,
  valuesOf: (row: T, facet: F) => string[],
  matchesSearch: (row: T) => boolean,
  top = 8,
): Record<F, FacetCount[]> {
  const out = {} as Record<F, FacetCount[]>;
  const searched = rows.filter(matchesSearch);
  for (const facet of facets) {
    const counts = new Map<string, number>();
    for (const row of searched) {
      if (!matchesFacets(row, filters, valuesOf, facet)) continue;
      for (const value of new Set(valuesOf(row, facet))) counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    let list = [...counts.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
    const active = filters[facet];
    const head = list.slice(0, top);
    if (active && !head.some((item) => item.value === active)) head.push(list.find((item) => item.value === active) ?? { value: active, count: 0 });
    list = head;
    out[facet] = list;
  }
  return out;
}

/** Label for UID values: only uid 0 is named, because it is root by definition. */
export function uidLabel(uid: number | null | undefined): string {
  if (uid === null || uid === undefined) return 'n/a';
  return uid === 0 ? '0 (root)' : String(uid);
}
