/**
 * URL state of the Runtime security page: the tab, the
 * policy section, the page-level time range and the Explore filters live in
 * the query string so links and Back restore the view.
 *
 *   ?host=<id>&tab=explore&range=24h&source=events&sev=high&process=sshd
 */
import type { TabItem } from '#lib/components/ui/types.js';
import { parseTimeRange, type TimeRangeKey } from '../ui/time-range';
import { resolveTabId } from '../ui/tabs';
import { parseMinSeverity, type EnforcementFacet, type FacetFilters, type TraceFacet } from './explore';
import type { ReadonlyURLSearchParams } from '$app/state';

export type RuntimeTab = 'triage' | 'explore' | 'policies' | 'agent';
export type PolicySection = 'enforcement' | 'detection' | 'correlations' | 'templates';
export type ExploreSource = 'events' | 'enforcement';
/** Triage queue status filter; '' = every status. */
export type IncidentStatusFilter = 'unresolved' | 'open' | 'acknowledged' | 'resolved' | '';
export type IncidentScope = 'host' | 'all';

const INCIDENT_STATUSES: readonly IncidentStatusFilter[] = ['unresolved', 'open', 'acknowledged', 'resolved'];
export const DEFAULT_INCIDENT_STATUS: IncidentStatusFilter = 'unresolved';

/** `?istatus=` value → filter: missing → unresolved, `all` → every status, unknown → unresolved. */
export function parseIncidentStatus(raw: string | null | undefined): IncidentStatusFilter {
  if (raw === 'all') return '';
  return INCIDENT_STATUSES.includes(raw as IncidentStatusFilter) ? (raw as IncidentStatusFilter) : DEFAULT_INCIDENT_STATUS;
}

export const DEFAULT_TAB: RuntimeTab = 'triage';
export const DEFAULT_SECTION: PolicySection = 'enforcement';
export const DEFAULT_RANGE: TimeRangeKey = '1h';

export const RUNTIME_TABS: readonly TabItem[] = [
  { id: 'triage', label: 'Triage' },
  { id: 'explore', label: 'Explore' },
  { id: 'policies', label: 'Policies' },
  { id: 'agent', label: 'Agent' },
];

export const POLICY_SECTIONS: readonly TabItem[] = [
  { id: 'enforcement', label: 'Enforcement' },
  { id: 'detection', label: 'Detection' },
  { id: 'correlations', label: 'Correlations' },
  { id: 'templates', label: 'Templates' },
];

const TRACE_FILTER_PARAMS: Record<TraceFacet, string> = {
  severity: 'severity',
  category: 'category',
  event: 'event',
  process: 'process',
  tactic: 'tactic',
  action: 'action',
  container: 'workload',
};

const ENFORCEMENT_FILTER_PARAMS: Record<EnforcementFacet, string> = {
  policy: 'policy',
  action: 'action',
  mode: 'mode',
  result: 'result',
};

/** Every query parameter the Explore tab owns (cleared when switching source). */
export const EXPLORE_PARAMS: readonly string[] = ['source', 'sev', ...new Set([...Object.values(TRACE_FILTER_PARAMS), ...Object.values(ENFORCEMENT_FILTER_PARAMS)])];

function params(search: ReadonlyURLSearchParams | string): URLSearchParams {
  return new URLSearchParams(typeof search === 'string' ? search : search.toString());
}

export interface RuntimeUrlState {
  tab: RuntimeTab;
  section: PolicySection;
  range: TimeRangeKey;
  source: ExploreSource;
  minSeverity: '' | 'low' | 'medium' | 'high' | 'critical';
  traceFilters: FacetFilters<TraceFacet>;
  enforcementFilters: FacetFilters<EnforcementFacet>;
  /** Incident to reveal in Triage (deep link). */
  incident: string;
  /** ATT&CK technique the Triage queue is narrowed to (Overview deep link). */
  technique: string;
  /** Triage queue status filter (`?istatus=`, default unresolved, `all` = '') . */
  incidentStatus: IncidentStatusFilter;
  /** Triage queue scope (`?iscope=all`, default this host). */
  incidentScope: IncidentScope;
}

export function readRuntimeUrl(search: ReadonlyURLSearchParams | string): RuntimeUrlState {
  const p = params(search);
  const traceFilters: FacetFilters<TraceFacet> = {};
  for (const [facet, key] of Object.entries(TRACE_FILTER_PARAMS) as Array<[TraceFacet, string]>) {
    const value = p.get(key)?.trim();
    if (value) traceFilters[facet] = value;
  }
  const enforcementFilters: FacetFilters<EnforcementFacet> = {};
  for (const [facet, key] of Object.entries(ENFORCEMENT_FILTER_PARAMS) as Array<[EnforcementFacet, string]>) {
    const value = p.get(key)?.trim();
    if (value) enforcementFilters[facet] = value;
  }
  return {
    tab: (resolveTabId(RUNTIME_TABS, p.get('tab'), DEFAULT_TAB) ?? DEFAULT_TAB) as RuntimeTab,
    section: (resolveTabId(POLICY_SECTIONS, p.get('section'), DEFAULT_SECTION) ?? DEFAULT_SECTION) as PolicySection,
    range: parseTimeRange(p.get('range'), { includeAll: true, fallback: DEFAULT_RANGE }),
    source: p.get('source') === 'enforcement' ? 'enforcement' : 'events',
    minSeverity: parseMinSeverity(p.get('sev')),
    traceFilters,
    enforcementFilters,
    incident: p.get('incident')?.trim() ?? '',
    technique: p.get('technique')?.trim() ?? '',
    incidentStatus: parseIncidentStatus(p.get('istatus')),
    incidentScope: p.get('iscope') === 'all' ? 'all' : 'host',
  };
}

export type RuntimeUrlPatch = Partial<{
  tab: RuntimeTab;
  section: PolicySection;
  range: TimeRangeKey;
  source: ExploreSource;
  minSeverity: string;
  traceFilters: FacetFilters<TraceFacet>;
  enforcementFilters: FacetFilters<EnforcementFacet>;
  incident: string | null;
  technique: string | null;
  incidentStatus: IncidentStatusFilter;
  incidentScope: IncidentScope;
}>;

function setOrDelete(p: URLSearchParams, key: string, value: string | null | undefined, defaultValue = ''): void {
  if (value === null || value === undefined || value === '' || value === defaultValue) p.delete(key);
  else p.set(key, value);
}

/**
 * Query string (with leading "?", or "") for the current search with `patch`
 * applied. Defaults are left out; filter maps replace every filter of their
 * source. Other parameters (host, embed) are kept.
 */
export function runtimeSearch(search: ReadonlyURLSearchParams | string, patch: RuntimeUrlPatch): string {
  const p = params(search);
  if (patch.tab !== undefined) setOrDelete(p, 'tab', patch.tab, DEFAULT_TAB);
  if (patch.section !== undefined) setOrDelete(p, 'section', patch.section, DEFAULT_SECTION);
  if (patch.range !== undefined) setOrDelete(p, 'range', patch.range, DEFAULT_RANGE);
  if (patch.source !== undefined) setOrDelete(p, 'source', patch.source, 'events');
  if (patch.minSeverity !== undefined) setOrDelete(p, 'sev', parseMinSeverity(patch.minSeverity));
  if (patch.traceFilters !== undefined) {
    for (const [facet, key] of Object.entries(TRACE_FILTER_PARAMS) as Array<[TraceFacet, string]>) setOrDelete(p, key, patch.traceFilters[facet]);
  }
  if (patch.enforcementFilters !== undefined) {
    for (const [facet, key] of Object.entries(ENFORCEMENT_FILTER_PARAMS) as Array<[EnforcementFacet, string]>) setOrDelete(p, key, patch.enforcementFilters[facet]);
  }
  if (patch.incident !== undefined) setOrDelete(p, 'incident', patch.incident);
  if (patch.technique !== undefined) setOrDelete(p, 'technique', patch.technique);
  if (patch.incidentStatus !== undefined) setOrDelete(p, 'istatus', patch.incidentStatus === '' ? 'all' : patch.incidentStatus, DEFAULT_INCIDENT_STATUS);
  if (patch.incidentScope !== undefined) setOrDelete(p, 'iscope', patch.incidentScope, 'host');
  const text = p.toString();
  return text ? `?${text}` : '';
}

/** Query string that opens Explore with only the given filters (other Explore state cleared). */
export function exploreSearch(search: ReadonlyURLSearchParams | string, next: { source?: ExploreSource; minSeverity?: string; traceFilters?: FacetFilters<TraceFacet>; enforcementFilters?: FacetFilters<EnforcementFacet> }): string {
  const p = params(search);
  for (const key of EXPLORE_PARAMS) p.delete(key);
  const source = next.source ?? 'events';
  // Both sources use the "action" parameter: write only the chosen source's filters.
  return runtimeSearch(p, {
    tab: 'explore',
    source,
    minSeverity: next.minSeverity ?? '',
    ...(source === 'events' ? { traceFilters: next.traceFilters ?? {} } : { enforcementFilters: next.enforcementFilters ?? {} }),
  });
}
