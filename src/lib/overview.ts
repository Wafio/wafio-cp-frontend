/**
 * Overview logic: Get started, Needs attention and top-N
 * filters. Pure functions: the page loads the data, these decide what it
 * means, and web/tests cover them.
 */
import type { HostIncident, OverviewEvidence, OverviewEvidenceAction } from './api';
import { severityRank } from './tone';

export function coveragePercent(running: number, eligible: number): number | null {
  return eligible > 0 && running >= 0 && running <= eligible ? Math.round(running / eligible * 100) : null;
}

export function scopedWAFAgents<T extends { host_id?: string | null }>(agents: T[], hostID: string): T[] {
  return hostID ? agents.filter(agent => agent.host_id === hostID) : agents;
}

export function requestDelta(current: number, previous: number | null): string {
  if (previous === null) return 'Previous period unavailable';
  if (previous === 0) return current === 0 ? 'No requests in either period' : 'New activity; previous period had 0 requests';
  const delta = (current - previous) / previous * 100;
  return `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}% requests vs previous period`;
}

/**
 * Timeline bucket for a window: 24 buckets, at least one minute. Matches the
 * server's overview cache warm-up (handlers/waf_agent.go uiBucketSecs), so
 * the common windows are served from cache.
 */
export function overviewBucketSeconds(minutes: number): number {
  return Math.max(Math.ceil(minutes * 60 / 24), 60);
}

// ── Needs attention ─────────────────────────────────────────────────────

export type AttentionKind = 'incident' | 'heartbeat' | 'configuration' | 'certificate' | 'other';

export interface AttentionItem {
  id: string;
  label: string;
  detail: string;
  severity: string;
  observedAt: string | null;
  dueAt: string | null;
  href: string;
}

export interface AttentionGroup {
  /** Stable key, e.g. "incident:<host>:<technique>". */
  key: string;
  kind: AttentionKind;
  /** Worst severity in the group (critical, high, medium/warning, low, info). */
  severity: string;
  title: string;
  /** One line under the title: count, processes, events. */
  summary: string;
  count: number;
  /** Most recent observation in the group (ISO), for sorting and display. */
  lastObserved: string | null;
  /** The one action of the group: opens the item itself, or the list filtered to the group. */
  action: { label: string; href: string };
  items: AttentionItem[];
}

export interface AttentionInput {
  /** Every evidence action (all pages) and the agent evidence. */
  evidence: Pick<OverviewEvidence, 'actions' | 'agents'>;
  /** Unresolved incidents (open + acknowledged) with rule details; null when unavailable. */
  incidents: HostIncident[] | null;
  /** `${base}/projects/<id>`. */
  projectRoot: string;
  /** Host name by host id, for titles. */
  hostNames?: Record<string, string>;
}

const KIND_ORDER: Record<AttentionKind, number> = { incident: 0, certificate: 1, heartbeat: 2, configuration: 3, other: 4 };

function latest(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

function worst(a: string, b: string): string {
  return severityRank(b) > severityRank(a) ? b : a;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

function listPreview(values: string[], max = 3): string {
  const unique = [...new Set(values.filter(Boolean))];
  if (unique.length <= max) return unique.join(', ');
  return `${unique.slice(0, max).join(', ')} and ${unique.length - max} more`;
}

/** Runtime security deep link (Triage tab): `incident` reveals one incident, `technique` narrows the queue. */
export function runtimeHref(root: string, params: { host?: string | null; incident?: string; technique?: string }): string {
  const q = new URLSearchParams();
  if (params.host) q.set('host', params.host);
  q.set('tab', 'triage');
  if (params.incident) q.set('incident', params.incident);
  if (params.technique) q.set('technique', params.technique);
  return `${root}/host/trace?${q}`;
}

export function credentialsHref(root: string, params: { credential?: string; filter?: 'expiring' } = {}): string {
  const q = new URLSearchParams();
  if (params.credential) q.set('credential', params.credential);
  if (params.filter) q.set('filter', params.filter);
  const qs = q.toString();
  return `${root}/settings/credentials${qs ? `?${qs}` : ''}`;
}

/**
 * Groups the evidence into one row per problem: incidents by
 * host × detection rule (technique), heartbeat gaps per agent kind, pending
 * configuration, expiring certificates. Each group has one action that
 * opens the item when there is one, else the list filtered to the group.
 */
export function groupAttention(input: AttentionInput): AttentionGroup[] {
  const { evidence, projectRoot: root } = input;
  const agents = new Map(evidence.agents.map((agent) => [agent.id, agent]));
  const hostName = (hostId: string | null | undefined) => (hostId && input.hostNames?.[hostId]) || null;
  const groups = new Map<string, AttentionGroup>();
  /** Incident-group facts that only the summary line needs. */
  const incidentFacts = new Map<string, IncidentFacts>();
  const facts = (key: string, host: string | null, rule: string): IncidentFacts => {
    let value = incidentFacts.get(key);
    if (!value) {
      value = { events: 0, processes: [], host, rule };
      incidentFacts.set(key, value);
    }
    return value;
  };

  const add = (key: string, init: () => Omit<AttentionGroup, 'items' | 'count' | 'severity' | 'lastObserved'>, item: AttentionItem) => {
    let group = groups.get(key);
    if (!group) {
      group = { ...init(), items: [], count: 0, severity: item.severity, lastObserved: null };
      groups.set(key, group);
    }
    group.items.push(item);
    group.count += 1;
    group.severity = worst(group.severity, item.severity);
    group.lastObserved = latest(group.lastObserved, item.observedAt);
  };

  // Incidents: from the incident list when available (rule, process, counts),
  // otherwise from the evidence rows (host only).
  const incidentActions = evidence.actions.filter((a) => a.kind === 'incident');
  if (input.incidents) {
    for (const incident of input.incidents) {
      if (incident.status === 'resolved') continue;
      const hostId = agents.get(incident.agent_id)?.host_id ?? null;
      const host = hostName(hostId) ?? agents.get(incident.agent_id)?.name ?? 'Unknown host';
      const rule = incident.technique_id || incident.tactic || 'Runtime rule';
      const ruleName = [incident.technique_id, incident.tactic].filter(Boolean).join(' ') || 'Runtime incident';
      const key = `incident:${hostId ?? incident.agent_id}:${rule}`;
      add(key, () => ({
        key,
        kind: 'incident',
        title: `${ruleName} on ${host}`,
        summary: '',
        action: { label: '', href: '' },
      }), {
        id: incident.id,
        label: `${incident.comm || 'unknown process'}${incident.status === 'acknowledged' ? ' (acknowledged)' : ''}`,
        detail: `${plural(incident.event_count ?? 0, 'event')}${incident.sample_description ? ` · ${incident.sample_description}` : ''}`,
        severity: incident.severity_name || 'high',
        observedAt: incident.last_seen_at ?? null,
        dueAt: null,
        href: runtimeHref(root, { host: hostId, incident: incident.id }),
      });
      const fact = facts(key, hostId, incident.technique_id || '');
      fact.events += incident.event_count ?? 0;
      if (incident.comm) fact.processes.push(incident.comm);
    }
  } else {
    for (const action of incidentActions) {
      const agent = agents.get(action.target_id);
      const hostId = agent?.host_id ?? null;
      const host = hostName(hostId) ?? agent?.name ?? 'Unknown host';
      const key = `incident:${hostId ?? action.target_id}`;
      facts(key, hostId, '');
      add(key, () => ({
        key,
        kind: 'incident',
        title: `Runtime incidents on ${host}`,
        summary: '',
        action: { label: '', href: '' },
      }), {
        id: action.id,
        label: action.message,
        detail: `Incident ${action.id.slice(0, 8)}`,
        severity: action.severity,
        observedAt: action.observed_at,
        dueAt: null,
        href: runtimeHref(root, { host: hostId, incident: action.id }),
      });
    }
  }

  for (const action of evidence.actions) {
    if (action.kind === 'incident') continue;
    const agent = agents.get(action.target_id);
    const name = action.target_name || agent?.name || action.target_id;
    if (action.kind === 'heartbeat') {
      const waf = agent?.kind === 'waf';
      const kindKey = waf ? 'waf' : 'host';
      add(`heartbeat:${kindKey}`, () => ({
        key: `heartbeat:${kindKey}`,
        kind: 'heartbeat',
        title: waf ? 'WAF agents without a recent heartbeat' : 'Host agents without a recent heartbeat',
        summary: '',
        action: { label: '', href: waf ? `${root}/waf` : `${root}/hosts` },
      }), {
        id: action.id,
        label: name,
        detail: action.message,
        severity: action.severity,
        observedAt: action.observed_at,
        dueAt: null,
        href: waf ? `${root}/waf/${action.target_id}` : agent?.host_id ? `${root}/hosts/${agent.host_id}` : `${root}/hosts`,
      });
    } else if (action.kind === 'configuration') {
      add('configuration', () => ({
        key: 'configuration',
        kind: 'configuration',
        title: 'Configuration not confirmed by the agent',
        summary: '',
        action: { label: '', href: `${root}/waf` },
      }), {
        id: action.id,
        label: name,
        detail: action.message,
        severity: action.severity,
        observedAt: action.observed_at,
        dueAt: null,
        href: agent?.kind === 'waf' || !agent ? `${root}/waf/${action.target_id}` : agent.host_id ? `${root}/hosts/${agent.host_id}` : `${root}/hosts`,
      });
    } else if (action.kind === 'certificate') {
      add('certificate', () => ({
        key: 'certificate',
        kind: 'certificate',
        title: 'Agent certificates expired or expiring',
        summary: '',
        action: { label: '', href: credentialsHref(root, { filter: 'expiring' }) },
      }), {
        id: action.id,
        label: name,
        detail: action.message,
        severity: action.severity,
        observedAt: action.observed_at,
        dueAt: action.due_at,
        href: credentialsHref(root, { credential: action.target_id }),
      });
    } else {
      add(`other:${action.kind}`, () => ({
        key: `other:${action.kind}`,
        kind: 'other',
        title: action.kind.replaceAll('_', ' '),
        summary: '',
        action: { label: '', href: root },
      }), {
        id: action.id,
        label: name,
        detail: action.message,
        severity: action.severity,
        observedAt: action.observed_at,
        dueAt: action.due_at,
        href: root,
      });
    }
  }

  for (const group of groups.values()) {
    finishGroup(group, root, incidentFacts.get(group.key));
  }
  return [...groups.values()].sort((a, b) =>
    severityRank(b.severity) - severityRank(a.severity)
    || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
    || b.count - a.count
    || a.key.localeCompare(b.key));
}

interface IncidentFacts {
  events: number;
  processes: string[];
  host: string | null;
  rule: string;
}

function finishGroup(group: AttentionGroup, root: string, fact: IncidentFacts | undefined): void {
  group.items.sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || (Date.parse(b.observedAt ?? '') || 0) - (Date.parse(a.observedAt ?? '') || 0));
  const single = group.count === 1 ? group.items[0] : null;
  switch (group.kind) {
    case 'incident': {
      const parts = [plural(group.count, 'open incident')];
      if (fact?.processes.length) parts.push(listPreview(fact.processes));
      if (fact?.events) parts.push(plural(fact.events, 'event'));
      group.summary = parts.join(' · ');
      group.action = single
        ? { label: 'Open incident', href: single.href }
        : { label: `Review ${group.count} incidents`, href: runtimeHref(root, { host: fact?.host, technique: fact?.rule || undefined }) };
      break;
    }
    case 'heartbeat':
      group.summary = `${plural(group.count, 'agent')}: ${listPreview(group.items.map((i) => i.label))}`;
      group.action = single ? { label: 'Open agent', href: single.href } : { label: `Review ${group.count} agents`, href: group.action.href };
      break;
    case 'configuration':
      group.summary = `${plural(group.count, 'agent')}: ${listPreview(group.items.map((i) => i.label))}`;
      group.action = single ? { label: 'Open agent', href: single.href } : { label: `Review ${group.count} agents`, href: group.action.href };
      break;
    case 'certificate': {
      const expired = group.items.filter((i) => severityRank(i.severity) >= severityRank('critical')).length;
      group.summary = [
        expired ? `${plural(expired, 'certificate')} expired` : '',
        group.count - expired ? `${plural(group.count - expired, 'certificate')} expiring within 30 days` : '',
      ].filter(Boolean).join(' · ');
      group.action = single ? { label: 'Open credential', href: single.href } : { label: `Review ${group.count} credentials`, href: group.action.href };
      break;
    }
    default:
      group.summary = plural(group.count, 'item');
      group.action = single ? { label: 'Open', href: single.href } : { label: 'Review', href: group.action.href };
  }
}

/** Severity counts over groups' items, for the section heading. */
export function attentionTotals(groups: AttentionGroup[]): { groups: number; items: number } {
  return { groups: groups.length, items: groups.reduce((sum, g) => sum + g.count, 0) };
}

/** Evidence actions of every page, deduplicated by id (the endpoint pages its list). */
export function mergeEvidenceActions(pages: OverviewEvidenceAction[][]): OverviewEvidenceAction[] {
  const seen = new Set<string>();
  const out: OverviewEvidenceAction[] = [];
  for (const page of pages) {
    for (const action of page) {
      if (seen.has(action.id)) continue;
      seen.add(action.id);
      out.push(action);
    }
  }
  return out;
}

// ── Get started ──────────────────────────────────────────────────

export interface SetupState {
  hosts: number | null;
  credentials: number | null;
  /** Name of a credential, for the prefilled install command. */
  credentialName?: string | null;
  apps: number | null;
  /** Applications assigned to a WAF agent (routes). */
  assignedApps: number | null;
  wafAgents: number | null;
  /** Agents (any kind) with a recorded heartbeat. */
  agentsSeen: number | null;
  /** WAF decisions ever recorded (within retention); null when unknown. */
  decisions: number | null;
}

export interface SetupStep {
  id: 'host' | 'credential' | 'app' | 'heartbeat' | 'decision';
  title: string;
  /** true done, false to do, null unknown (source failed). */
  done: boolean | null;
  description: string;
  action?: { label: string; href: string };
  /** The step waits for an earlier one; shown, not actionable yet. */
  waitingFor?: string;
}

/**
 * The Get started checklist from API state. `complete` when every step is
 * done; unknown steps never count as done.
 */
export function setupChecklist(state: SetupState, root: string): { steps: SetupStep[]; complete: boolean; remaining: number } {
  const known = (n: number | null) => n !== null;
  const steps: SetupStep[] = [
    {
      id: 'host',
      title: 'Register a host',
      done: known(state.hosts) ? state.hosts! > 0 : null,
      description: 'Add each server you want to protect. Its host key lets the host agent report firewall and runtime data.',
      action: { label: 'Register a host', href: `${root}/hosts` },
    },
    {
      id: 'credential',
      title: 'Provision an agent credential',
      done: known(state.credentials) ? state.credentials! > 0 : null,
      description: 'Agents connect with an mTLS client certificate. Download the bundle once, then run the install command on the agent host.',
      action: { label: state.credentials ? 'Open credentials' : 'Provision a credential', href: `${root}/settings/credentials` },
    },
    {
      id: 'app',
      title: 'Create an application and assign it to a WAF agent',
      done: known(state.assignedApps) ? state.assignedApps! > 0 : known(state.apps) && state.apps === 0 ? false : null,
      description: 'An application is the upstream the WAF agent protects. Assigning it to an agent sends its listener and policy to that agent.',
      action: state.apps && state.apps > 0 && state.wafAgents && state.wafAgents > 0
        ? { label: 'Assign an application', href: `${root}/apps` }
        : state.wafAgents === 0
          ? { label: 'Register a WAF agent', href: `${root}/waf` }
          : { label: 'Create an application', href: `${root}/apps` },
    },
    {
      id: 'heartbeat',
      title: 'Receive the first agent heartbeat',
      done: known(state.agentsSeen) ? state.agentsSeen! > 0 : null,
      description: 'Start the agent on its host. The first heartbeat shows the agent online under WAF agents or Hosts.',
      action: { label: 'Open WAF agents', href: `${root}/waf` },
    },
    {
      id: 'decision',
      title: 'Record the first WAF decision',
      done: known(state.decisions) ? state.decisions! > 0 : null,
      description: 'Send a request through an assigned application. Its decision (allow, monitor or block) appears in the application monitoring view.',
      action: { label: 'Open applications', href: `${root}/apps` },
    },
  ];
  if (!steps[1].done) steps[3].waitingFor = 'an agent credential';
  if (!steps[2].done && steps[4].done !== true) steps[4].waitingFor = 'an assigned application';
  const remaining = steps.filter((s) => s.done !== true).length;
  return { steps, complete: remaining === 0, remaining };
}

/** File-name-safe credential name, as the credential bundle download uses it. */
export function credentialFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/** Certificate directory the agent installers default to (docs/agents-reference.md). */
export function agentCertDir(kind: 'waf' | 'host'): string {
  return `/etc/wafio/certs/${kind}`;
}

/**
 * Shell commands that put a credential bundle (Credentials page download) on
 * the agent host and run the agent installer, prefilled with the credential
 * name. The installer (install.sh at the top of the waf-agent or host-agent
 * release bundle, built from scripts/install-{waf,host}-agent.sh) checks that
 * the certificates exist, defaults to /etc/wafio/certs/<kind>/ and creates
 * its own systemd unit (wafio-waf-agent / wafio-host-agent); the bundle's
 * sample unit is only for a manual install without the installer.
 */
export function installCommand(credentialName: string, kind: 'waf' | 'host' = 'waf'): string {
  const safe = credentialFileName(credentialName || 'agent');
  // The name only appears in a comment; control characters must not end it.
  const label = (credentialName || 'agent').replace(/[\u0000-\u001f\u007f]/g, ' ').trim() || 'agent';
  const dir = agentCertDir(kind);
  const bundle = `wafio-${safe}-bundle.tar`;
  const lines = [
    `# On the agent host, in the unpacked agent release, with ${bundle} next to it:`,
    `sudo install -d -m 0750 ${dir}`,
    `sudo tar --no-same-owner -xf ${bundle} -C ${dir} ca.crt client.crt client.key`,
    `sudo chmod 0600 ${dir}/client.key`,
  ];
  if (kind === 'waf') {
    lines.push(
      '# The WAF agent runs as user wafio and must read its key:',
      'id wafio >/dev/null 2>&1 || sudo useradd --system --no-create-home --shell /usr/sbin/nologin wafio',
      `sudo chown -R wafio:wafio ${dir}`,
      `# Agent name: ${label}. Accept the default certificate paths.`,
      'sudo bash install.sh',
    );
  } else {
    lines.push(
      `# Agent name: ${label}. Accept the default certificate paths.`,
      'sudo bash install.sh',
      '# Then add the host key from Hosts and restart:',
      "echo 'WAFIO_HOST_KEY=<host key from Hosts>' | sudo tee -a /etc/wafio/host-agent.env >/dev/null",
      'sudo systemctl restart wafio-host-agent',
    );
  }
  return lines.join('\n');
}

// ── Top-N filters ────────────────────────────────────────────────

export type DecisionFilterKind = 'ip' | 'category' | 'country' | 'action';

export interface DecisionFilter {
  kind: DecisionFilterKind;
  value: string;
  /** Display text, e.g. the country name. */
  label: string;
  /**
   * Only blocked and monitored decisions, like the top lists the filter came
   * from (they count nothing else); allowed requests are left out.
   */
  flaggedOnly?: boolean;
}

export interface DecisionRowLike {
  remote_addr?: string;
  categories?: string;
  country_code?: string;
  action?: string;
}

/**
 * True when a decision row (GET …/dashboard/logs) matches the filter. Top IPs
 * and categories carry the stored value (raw remote_addr, category name), so
 * the comparison is exact; countries compare ISO codes case-insensitively.
 */
export function matchesDecisionFilter(row: DecisionRowLike, filter: DecisionFilter): boolean {
  if (filter.flaggedOnly && !['block', 'log', 'monitor'].includes(row.action ?? '')) return false;
  switch (filter.kind) {
    case 'ip':
      return (row.remote_addr ?? '') === filter.value;
    case 'category':
      return (row.categories ?? '').split(',').map((c) => c.trim()).includes(filter.value);
    case 'country':
      return (row.country_code ?? '').toUpperCase() === filter.value.toUpperCase();
    case 'action':
      return (row.action ?? '') === filter.value;
  }
}

export function describeDecisionFilter(filter: DecisionFilter): string {
  switch (filter.kind) {
    case 'ip': return `Client IP ${filter.label}`;
    case 'category': return `Category ${filter.label}`;
    case 'country': return `Country ${filter.label}`;
    case 'action': return `Action ${filter.label}`;
  }
}
