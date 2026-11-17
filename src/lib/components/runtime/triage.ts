/**
 * Incident triage: incidents grouped by
 * host × tactic × process so repeated observations (sshd, cron, health
 * checks) collapse into one row with counts, bulk Acknowledge/Resolve, and a
 * "suppress from incident" prefill for a detection-rule exception.
 *
 * The control plane keys an unresolved incident by agent × technique ×
 * process; grouping by host (all of a host's agents) and tactic (all of its
 * techniques) is what makes the queue short.
 */
import type { HostIncident } from '#lib/api.js';
import { severityRank } from '../../tone';
import { eventNamesForTechniques } from './mitre';
import type { DetectionRuleDraft } from './detection';

export interface HostRef {
  id: string;
  label: string;
}

export interface IncidentGroup {
  key: string;
  host: HostRef;
  agentIds: string[];
  /** Tactic, or "Unmapped" when the event has no ATT&CK mapping. */
  tactic: string;
  techniques: string[];
  comm: string;
  incidents: HostIncident[];
  /** Sum of the incidents' recorded events. */
  eventCount: number;
  /** Most severe incident severity name. */
  severity: string;
  severityRank: number;
  open: number;
  acknowledged: number;
  resolved: number;
  firstSeen: string;
  lastSeen: string;
  /** Sample description of the most severe, most recent incident. */
  sample: string;
}

export const UNMAPPED_TACTIC = 'Unmapped';
export const UNKNOWN_PROCESS = 'unknown';

export function incidentGroupKey(hostId: string, tactic: string, comm: string): string {
  return `${hostId}\u0000${tactic}\u0000${comm}`;
}

function time(value: string | null | undefined): number {
  const t = value ? Date.parse(value) : NaN;
  return Number.isFinite(t) ? t : 0;
}

export interface GroupOptions {
  /** Host of an incident's agent (all-hosts scope); undefined when unknown. */
  hostOf?: (agentId: string) => HostRef | undefined;
  /** Host used when hostOf gives none (the selected host). */
  fallbackHost?: HostRef;
}

/** Groups incidents by host × tactic × process. Sorted by {@link compareGroups}. */
export function groupIncidents(incidents: readonly HostIncident[], opts: GroupOptions = {}): IncidentGroup[] {
  const groups = new Map<string, IncidentGroup>();
  for (const incident of incidents) {
    const host = opts.hostOf?.(incident.agent_id) ?? opts.fallbackHost ?? { id: `agent:${incident.agent_id}`, label: `Agent ${incident.agent_id.slice(0, 8)}` };
    const tactic = incident.tactic?.trim() || UNMAPPED_TACTIC;
    const comm = incident.comm?.trim() || UNKNOWN_PROCESS;
    const key = incidentGroupKey(host.id, tactic, comm);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        host,
        agentIds: [],
        tactic,
        techniques: [],
        comm,
        incidents: [],
        eventCount: 0,
        severity: incident.severity_name,
        severityRank: -1,
        open: 0,
        acknowledged: 0,
        resolved: 0,
        firstSeen: incident.first_seen_at,
        lastSeen: incident.last_seen_at,
        sample: '',
      };
      groups.set(key, group);
    }
    group.incidents.push(incident);
    if (!group.agentIds.includes(incident.agent_id)) group.agentIds.push(incident.agent_id);
    const technique = incident.technique_id?.trim();
    if (technique && !group.techniques.includes(technique)) group.techniques.push(technique);
    group.eventCount += Number(incident.event_count) || 0;
    if (incident.status === 'open') group.open += 1;
    else if (incident.status === 'acknowledged') group.acknowledged += 1;
    else if (incident.status === 'resolved') group.resolved += 1;
    const rank = severityRank(incident.severity_name || incident.severity);
    const newest = group.incidents.length === 1 || time(incident.last_seen_at) >= time(group.lastSeen);
    if (rank > group.severityRank || (rank === group.severityRank && newest)) {
      group.severityRank = rank;
      group.severity = incident.severity_name;
      if (incident.sample_description) group.sample = incident.sample_description;
    } else if (!group.sample && incident.sample_description) {
      group.sample = incident.sample_description;
    }
    if (time(incident.first_seen_at) && (!time(group.firstSeen) || time(incident.first_seen_at) < time(group.firstSeen))) group.firstSeen = incident.first_seen_at;
    if (time(incident.last_seen_at) > time(group.lastSeen)) group.lastSeen = incident.last_seen_at;
  }
  const out = [...groups.values()];
  for (const group of out) group.techniques.sort();
  return out.sort(compareGroups);
}

/** Groups with open incidents first, then severity, event volume and recency. */
export function compareGroups(a: IncidentGroup, b: IncidentGroup): number {
  return (
    Number(b.open > 0) - Number(a.open > 0) ||
    b.severityRank - a.severityRank ||
    b.eventCount - a.eventCount ||
    time(b.lastSeen) - time(a.lastSeen) ||
    a.key.localeCompare(b.key)
  );
}

export type IncidentAction = 'ack' | 'resolve';

/** An incident the action changes: ack needs "open", resolve anything unresolved. */
export function incidentAccepts(incident: HostIncident, action: IncidentAction): boolean {
  return action === 'ack' ? incident.status === 'open' : incident.status !== 'resolved';
}

/** Ids of the incidents in `groups` that `action` changes. */
export function actionableIncidentIds(groups: readonly IncidentGroup[], action: IncidentAction): string[] {
  const ids: string[] = [];
  for (const group of groups) {
    for (const incident of group.incidents) if (incidentAccepts(incident, action)) ids.push(incident.id);
  }
  return ids;
}

export interface SelectionSummary {
  groups: number;
  incidents: number;
  acknowledgeable: number;
  resolvable: number;
  events: number;
}

export function summarizeSelection(groups: readonly IncidentGroup[]): SelectionSummary {
  return {
    groups: groups.length,
    incidents: groups.reduce((n, g) => n + g.incidents.length, 0),
    acknowledgeable: actionableIncidentIds(groups, 'ack').length,
    resolvable: actionableIncidentIds(groups, 'resolve').length,
    events: groups.reduce((n, g) => n + g.eventCount, 0),
  };
}

/** Largest note the dialog accepts (kept short so it fits an audit entry). */
export const NOTE_MAX_LENGTH = 500;

export interface BulkResult {
  succeeded: string[];
  failed: Array<{ id: string; error: string }>;
}

export type BulkStep = (id: string) => Promise<{ ok: boolean; error?: string }>;

/**
 * Runs `step` for every id with at most `concurrency` requests in flight.
 * Failures are collected, never thrown; `onProgress(done, total)` after each.
 * Stops early (remaining ids are neither succeeded nor failed) when `signal`
 * aborts.
 */
export async function runBulk(
  ids: readonly string[],
  step: BulkStep,
  opts: { concurrency?: number; onProgress?: (done: number, total: number) => void; signal?: AbortSignal } = {},
): Promise<BulkResult> {
  const result: BulkResult = { succeeded: [], failed: [] };
  const queue = [...ids];
  const total = queue.length;
  let done = 0;
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 4, total || 1));
  async function worker() {
    while (queue.length > 0) {
      if (opts.signal?.aborted) return;
      const id = queue.shift() as string;
      try {
        const outcome = await step(id);
        if (outcome.ok) result.succeeded.push(id);
        else result.failed.push({ id, error: outcome.error || 'Request failed' });
      } catch (error) {
        result.failed.push({ id, error: error instanceof Error ? error.message : 'Request failed' });
      }
      done += 1;
      opts.onProgress?.(done, total);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return result;
}

export interface SuppressionPrefill {
  draft: DetectionRuleDraft;
  /** Host the rule is created for (detection rules are per host). */
  hostId: string;
  hostLabel?: string;
  /** Event names the exception covers (empty when the technique is unmapped). */
  eventNames: string[];
  /** Shown in the editor when the prefill could not be narrowed. */
  warning?: string;
}

/**
 * A detection-rule draft that suppresses the observations behind a group:
 * process name equals the group's process AND event name is one of the
 * events the control plane maps to the group's techniques. The operator
 * reviews and saves it; nothing is written here.
 */
export function suppressionPrefill(group: Pick<IncidentGroup, 'host' | 'tactic' | 'techniques' | 'comm' | 'incidents'>): SuppressionPrefill {
  const eventNames = eventNamesForTechniques(group.techniques);
  const conditions = [{ field: 'comm', op: 'eq', value: group.comm === UNKNOWN_PROCESS ? '' : group.comm }];
  if (eventNames.length > 0) conditions.push({ field: 'event_name', op: 'in', value: eventNames.join(', ') });
  const techniques = group.techniques.length ? group.techniques.join(', ') : 'no technique';
  const warning =
    eventNames.length === 0
      ? `These incidents have no ATT&CK technique mapping, so the exception cannot be narrowed to their events. As prefilled it suppresses every event of "${group.comm}" on this host; add a condition before saving.`
      : undefined;
  return {
    hostId: group.host.id,
    hostLabel: group.host.label,
    eventNames,
    warning,
    draft: {
      name: `Exception: ${group.comm} · ${group.tactic}`.slice(0, 120),
      description: `Created from ${group.incidents.length} incident${group.incidents.length === 1 ? '' : 's'} (${techniques}) on ${group.host.label}. Suppresses these observations at ingest.`,
      enabled: true,
      action: 'suppress',
      conditions,
      severity_override: null,
      priority: 100,
      tags: 'triage-exception',
    },
  };
}
