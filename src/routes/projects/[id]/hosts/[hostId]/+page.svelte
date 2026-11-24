<!--
  Host detail, one host's inventory, agents, key lifecycle and a summary of
  its firewall and runtime security.

  Host security has one implementation: the Firewall and Runtime security
  pages. This page shows what the host is doing and deep-links there for
  every change, so the lockout guards and confirmations live in one place.
  All host state sits behind a HostScope: every call passes the host id and
  its host agent, a response for a previous host is dropped, and streams and
  pollers stop with the page or while the browser tab is hidden. The Overview
  tab carries a Firewall and a Runtime security card, each linking to its
  page for this host; both say so when the host has no host agent.

  Tabs are in the URL (?tab=overview|agents). The old ?tab=firewall and
  ?tab=runtime|security open Overview scrolled to the matching card.
-->
<script lang="ts">
  import { page } from '$app/state';
  import { base } from '#lib/paths.js';
  import { goto } from '$app/navigation';
  import { tick, untrack } from 'svelte';
  import { DateTime } from '#lib/components/ui/index.js';
  import PageHeader from '#lib/components/ui/PageHeader.svelte';
  import Tabs from '#lib/components/ui/Tabs.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Alert from '#lib/components/ui/Alert.svelte';
  import InlineError from '#lib/components/ui/InlineError.svelte';
  import EmptyState from '#lib/components/ui/EmptyState.svelte';
  import Spinner from '#lib/components/ui/Spinner.svelte';
  import StatusDot from '#lib/components/ui/StatusDot.svelte';
  import KpiStrip from '#lib/components/ui/KpiStrip.svelte';
  import DataTable from '#lib/components/ui/DataTable.svelte';
  import ConfirmModal from '#lib/components/ui/ConfirmModal.svelte';
  import type { DataTableColumn, KpiItem, StatusKind, TabItem } from '#lib/components/ui/types.js';
  import { readTabParam, tabSearch } from '#lib/components/ui/tabs.js';
  import KeyRevealModal from '#lib/components/KeyRevealModal.svelte';
  import FirewallStatusBanner from '#lib/components/firewall/FirewallStatusBanner.svelte';
  import HostLabelsModal from '#lib/components/hosts/HostLabelsModal.svelte';
  import HostConnectGuide from '#lib/components/hosts/HostConnectGuide.svelte';
  import { ENROLL_DEFAULTS, rotatedKeySteps } from '#lib/host-connect.js';
  import { REMOVED_AGENT_TEXT } from '#lib/components/apps/tls.js';
  import {
    getHost,
    listHostAgents,
    rotateHostKey,
    revokeHost,
    deleteHost,
    getEBPFStatus,
    getEBPFMetrics,
    getEBPFBlocklist,
    getEBPFAllowlist,
    getEBPFEgressBlocklist,
    getEBPFGeoBlocked,
    getEBPFPortPolicies,
    getTraceStatus,
    getTraceStats,
    getTraceEvents,
    type ApiError,
    type EBPFMetrics,
    type EBPFPortPolicyConfig,
    type EBPFStatus,
    type FleetAgent,
    type Host,
    type TraceEvent,
    type TraceStats,
    type TraceStatus,
  } from '#lib/api.js';
  import { createSSEConnection, type SSEConnectionState } from '#lib/sse.js';
  import { createHostScope } from '#lib/host-scope.svelte.js';
  import { legacyHostTabAnchor, writeLastHost } from '#lib/host-nav.js';
  import { createPoller } from '#lib/polling.svelte.js';
  import { getProjectContext } from '#lib/project-context.svelte.js';
  import { tierFor } from '#lib/confirm-tiers.js';
  import { agentKindTone, enforcementTone, severityRank, severityTone, statusTone } from '#lib/tone.js';
  import {
    formatBitRate,
    formatBytes,
    formatCount,
    formatDateTime,
    formatDuration,
    formatNumber,
    formatPercent,
    formatRelative,
    toISO,
  } from '#lib/format.js';
  import { toast } from '#lib/stores/toast.js';
  import { usePageDetail } from '#lib/page-meta.svelte.js';
  import {
    hostDisks,
    hostInfoDisplay,
    hostInterfaces,
    hostLoadAverage,
    usedPercent,
    type HostInfoField,
  } from '../host-info';

  const project = getProjectContext();
  const projectId = $derived(page.params.id ?? '');
  const hostId = $derived(page.params.hostId ?? '');
  const canConfigure = $derived(project.canConfigure);
  const canDelete = $derived(project.canDelete);

  // ── Per-host state (cleared by the scope on every host change) ─────────
  let host = $state<Host | null>(null);
  let hostError = $state<ApiError | null>(null);
  let agents = $state<FleetAgent[]>([]);
  let agentsTotal = $state(0);
  let hostInfoState = $state<SSEConnectionState>('closed');
  /** 429 STREAM_LIMIT on the host stream: retried every 30 s. */
  let hostInfoLimited = $state(false);
  let hostInfoAt = $state<number | null>(null);

  let fwStatus = $state<EBPFStatus | null>(null);
  let fwStatusError = $state<string | null>(null);
  let fwMetrics = $state<EBPFMetrics | null>(null);
  /** Access-rule totals; a count whose request failed is null ("n/a"), never 0. */
  let fwCounts = $state<{ block: number | null; allow: number | null; egress: number | null; geo: number | null; ports: number | null; portPolicy: EBPFPortPolicyConfig | null; failed: boolean } | null>(null);
  let fwCountsLoading = $state(false);

  let rtStatus = $state<Partial<TraceStatus> | null>(null);
  let rtStats = $state<Partial<TraceStats> | null>(null);
  let rtEvents = $state<TraceEvent[]>([]);
  let rtLoaded = $state(false);
  let rtLoading = $state(false);
  let rtError = $state<string | null>(null);
  let rtState = $state<SSEConnectionState>('closed');
  let rtLimited = $state(false);

  type HostAction = 'rotate' | 'revoke' | 'delete';
  let action = $state<HostAction | null>(null);
  let actionBusy = $state(false);
  let actionError = $state<string | null>(null);
  let revealedKey = $state<string | null>(null);
  /** Enrollment window the rotated key opened (from the rotate response). */
  let revealedEnrollUntil = $state<string | null>(null);
  let labelsOpen = $state(false);
  let expandedAgents = $state<Array<string | number>>([]);

  const scope = createHostScope({
    // One request answers both "which agents run here" and "which is the host agent".
    resolveAgent: async ({ projectId: pid, hostId: hid, signal }) => {
      const res = await listHostAgents(pid, hid, { limit: 100 });
      if (res.error) throw new Error(res.error.error);
      const list = res.data?.agents ?? [];
      if (!signal.aborted) {
        agents = list;
        agentsTotal = res.data?.total ?? list.length;
      }
      return list.find((agent) => agent.kind === 'host');
    },
  });

  scope.onReset(() => {
    host = null;
    hostError = null;
    agents = [];
    agentsTotal = 0;
    hostInfoState = 'closed';
    hostInfoAt = null;
    fwStatus = null;
    fwStatusError = null;
    fwMetrics = null;
    fwCounts = null;
    fwCountsLoading = false;
    rtStatus = null;
    rtStats = null;
    rtEvents = [];
    rtLoaded = false;
    rtLoading = false;
    rtError = null;
    rtState = 'closed';
    action = null;
    actionBusy = false;
    actionError = null;
    revealedKey = null;
    expandedAgents = [];
  });

  $effect(() => {
    const p = projectId;
    const h = hostId;
    untrack(() => {
      if (scope.setScope(p, h) && p && h) void init();
    });
  });

  const ids = () => [scope.projectId, scope.agentId, scope.hostId] as const;

  async function init() {
    const epoch = scope.epoch;
    const [pid, , hid] = ids();
    const [hostRes] = await Promise.all([getHost(pid, hid), scope.resolveAgent()]);
    if (scope.isStale(epoch)) return;
    if (hostRes.error) hostError = hostRes.error;
    else host = hostRes.data?.host ?? null;
    if (host && host.status !== 'revoked') writeLastHost(pid, hid);
  }

  async function reloadHost() {
    const epoch = scope.epoch;
    const [pid, , hid] = ids();
    const res = await getHost(pid, hid);
    if (scope.isStale(epoch) || res.error) return;
    host = res.data?.host ?? host;
  }

  function retry() {
    scope.reset();
    void init();
  }

  // ── Tabs (URL) ─────────────────────────────────────────────────────────
  type HostTab = 'overview' | 'agents';
  const hostAgentReady = $derived(scope.agentStatus === 'ready');
  const noHostAgentReason = $derived(
    scope.agentStatus === 'missing' ? 'This host has no host agent; install wafio-host-agent to use the firewall and runtime security.'
      : scope.agentStatus === 'error' ? 'The agent list did not load.'
      : 'Looking up the host agent…',
  );
  const tabItems = $derived<TabItem[]>([
    { id: 'overview', label: 'Overview' },
    { id: 'agents', label: 'Agents', count: agentsTotal || undefined },
  ]);
  const activeTab = $derived((readTabParam(page.url.searchParams, 'tab', tabItems, 'overview') ?? 'overview') as HostTab);

  // Old links (?tab=firewall, ?tab=runtime|security): the summaries are Overview cards now.
  const legacyAnchor = $derived(legacyHostTabAnchor(page.url.searchParams.get('tab')));
  let scrolledTo = '';
  $effect(() => {
    const anchor = legacyAnchor;
    const key = `${hostId}|${anchor}`;
    if (!anchor || !host || scrolledTo === key) return;
    scrolledTo = key;
    void tick().then(() => {
      const card = document.getElementById(anchor);
      if (!card) return;
      card.scrollIntoView({ block: 'start' });
      card.focus({ preventScroll: true });
    });
  });

  function selectTab(id: string) {
    void goto(`${page.url.pathname}${tabSearch(page.url.searchParams, 'tab', id, 'overview')}`, { replace: true, reset: false });
  }

  const firewallHref = (params: Record<string, string> = {}) => {
    const search = new URLSearchParams({ host: hostId, ...params });
    return `${base}/projects/${projectId}/host/firewall?${search}`;
  };
  const runtimeHref = $derived(`${base}/projects/${projectId}/host/trace?host=${encodeURIComponent(hostId)}`);
  const agentsTabHref = $derived(`${page.url.pathname}?tab=agents`);

  // ── Overview: live host inventory ──────────────────────────────────────
  const hostInfoWanted = $derived(activeTab === 'overview' && hostAgentReady && !scope.hidden && host !== null && host.status !== 'revoked');
  $effect(() => {
    if (!hostInfoWanted) {
      hostInfoState = 'closed';
      return;
    }
    const epoch = untrack(() => scope.epoch);
    const [pid, aid, hid] = untrack(ids);
    const conn = createSSEConnection({
      projectId: pid,
      agentId: aid,
      hostId: hid,
      channels: ['hostinfo'],
      onStateChange: (state) => {
        if (scope.isStale(epoch)) return;
        hostInfoState = state;
        if (state === 'open') hostInfoLimited = false;
      },
      onLimit: () => { if (!scope.isStale(epoch)) hostInfoLimited = true; },
      onHostInfo: (info) => {
        if (scope.isStale(epoch) || !host || !info || typeof info !== 'object') return;
        // Merge live telemetry into the snapshot, keeping static fields.
        host = { ...host, host_info: { ...(host.host_info ?? {}), ...info } };
        hostInfoAt = Date.now();
      },
    });
    return () => conn.close();
  });

  const info = $derived((host?.host_info ?? null) as Record<string, unknown> | null);
  const disks = $derived(hostDisks(info));
  const nics = $derived(hostInterfaces(info));
  const STREAM_LIMIT_LABEL = 'Waiting: too many live views open for this project, retrying every 30 s';
  const infoStream = $derived.by((): { status: StatusKind; label: string } => {
    if (!hostAgentReady) return { status: 'disabled', label: 'Snapshot (no host agent streaming)' };
    if (scope.hidden) return { status: 'disabled', label: 'Paused while this tab is hidden' };
    switch (hostInfoState) {
      case 'open': return { status: 'online', label: hostInfoAt ? `Live, updated ${formatRelative(hostInfoAt)}` : 'Live' };
      case 'connecting': return { status: 'pending', label: 'Connecting…' };
      case 'reconnecting': return { status: 'degraded', label: hostInfoLimited ? STREAM_LIMIT_LABEL : 'Reconnecting…' };
      case 'failed': return { status: 'offline', label: 'Live updates stopped; showing the last snapshot' };
      default: return { status: 'disabled', label: 'Snapshot' };
    }
  });

  const SYSTEM_FIELDS: Array<[string, HostInfoField]> = [
    ['Hostname', 'hostname'],
    ['OS', 'os'],
    ['Version', 'os_version'],
    ['Distribution', 'distribution'],
    ['Kernel', 'kernel'],
    ['Architecture', 'arch'],
    ['Boot time', 'boot_time'],
    ['Uptime', 'uptime_seconds'],
    ['Timezone', 'timezone'],
  ];
  const HARDWARE_FIELDS: Array<[string, HostInfoField]> = [
    ['CPU cores', 'cpu_cores'],
    ['CPU model', 'cpu_model'],
    ['CPU clock', 'cpu_mhz'],
    ['Memory total', 'memory_total'],
    ['Memory free', 'memory_free'],
  ];
  const SECURITY_FIELDS: Array<[string, HostInfoField]> = [
    ['SELinux', 'selinux'],
    ['AppArmor', 'apparmor'],
    ['Container runtime', 'container_runtime'],
    ['Virtualization', 'virtualization'],
    ['Agent version', 'agent_version'],
  ];

  // ── Firewall summary ───────────────────────────────────────────────────
  $effect(() => {
    if (activeTab !== 'overview' || !hostAgentReady) return;
    const epoch = untrack(() => scope.epoch);
    untrack(() => { if (!fwCounts && !fwCountsLoading) void loadFirewallCounts(epoch); });
    createPoller(() => loadFirewallStatus(epoch), 30_000);
  });

  async function loadFirewallStatus(epoch: number) {
    const [pid, aid, hid] = ids();
    const [statusRes, metricsRes] = await Promise.all([getEBPFStatus(pid, aid, hid), getEBPFMetrics(pid, aid, hid)]);
    if (scope.isStale(epoch)) return;
    if (statusRes.error) fwStatusError = statusRes.error.error;
    else {
      fwStatusError = null;
      fwStatus = statusRes.data ?? null;
    }
    const metrics = metricsRes.data as EBPFMetrics | undefined;
    fwMetrics = metrics && typeof metrics.pps === 'number' ? metrics : null;
  }

  async function loadFirewallCounts(epoch: number) {
    const [pid, aid, hid] = ids();
    fwCountsLoading = true;
    // limit=1: only the totals are needed here; the lists live on the Firewall page.
    const [block, allow, egress, geo, ports] = await Promise.all([
      getEBPFBlocklist(pid, 1, aid, hid),
      getEBPFAllowlist(pid, 1, aid, hid),
      getEBPFEgressBlocklist(pid, 1, aid, hid),
      getEBPFGeoBlocked(pid, aid, hid),
      getEBPFPortPolicies(pid, aid, hid),
    ]);
    if (scope.isStale(epoch)) return;
    fwCountsLoading = false;
    const total = (res: { data?: { total?: number; count?: number }; error?: unknown }) => (res.error || !res.data ? null : (res.data.total ?? res.data.count ?? 0));
    fwCounts = {
      block: total(block),
      allow: total(allow),
      egress: total(egress),
      geo: geo.error || !geo.data ? null : (geo.data.countries ?? []).filter((entry) => entry.blocked).length,
      ports: ports.error || !ports.data ? null : (ports.data.policies?.length ?? 0),
      portPolicy: ports.data?.config ?? null,
      failed: Boolean(block.error || allow.error || egress.error || geo.error || ports.error),
    };
  }

  const fwLiveItems = $derived.by((): KpiItem[] => {
    const m = fwMetrics;
    if (!m) return [];
    const rate = m.drop_rate_pct ?? 0;
    return [
      { label: 'Packets per second', value: formatNumber(m.pps, 'compact') },
      { label: 'Throughput', value: formatBitRate((m.bps ?? 0) * 8) },
      { label: 'Drop rate', value: formatPercent(rate, { input: 'percent', digits: 2 }), tone: rate > 5 ? 'danger' : rate > 1 ? 'warning' : 'default', toneText: rate > 5 ? 'high' : rate > 1 ? 'elevated' : undefined },
      { label: 'Dropped packets', value: formatNumber(m.dropped_packets), detail: 'since the agent started' },
      { label: 'Flows tracked', value: formatNumber(m.conntrack_entries), detail: 'since the agent started' },
    ];
  });
  const fwRuleItems = $derived.by((): KpiItem[] => {
    const c = fwCounts;
    if (!c) return [];
    const value = (n: number | null) => (n === null ? 'n/a' : formatNumber(n));
    const unloaded = 'did not load';
    return [
      { label: 'Blocklist', value: value(c.block), detail: c.block === null ? unloaded : 'source addresses', href: firewallHref({ tab: 'rules', type: 'block' }) },
      { label: 'Allowlist', value: value(c.allow), detail: c.allow === null ? unloaded : 'bypass every check', href: firewallHref({ tab: 'rules', type: 'allow' }) },
      { label: 'Egress blocklist', value: value(c.egress), detail: c.egress === null ? unloaded : 'destinations', href: firewallHref({ tab: 'rules', type: 'egress' }) },
      { label: 'Geo-blocking', value: value(c.geo), detail: c.geo === null ? unloaded : c.geo === 1 ? 'country' : 'countries', href: firewallHref({ tab: 'rules', type: 'geo' }) },
      { label: 'Port rules', value: value(c.ports), detail: c.ports === null ? unloaded : c.portPolicy ? (c.portPolicy.enabled ? 'applied' : 'turned off') : undefined, href: firewallHref({ tab: 'rules', type: 'port' }) },
    ];
  });

  // ── Runtime summary ────────────────────────────────────────────────────
  const RT_MAX_EVENTS = 25;

  // A REST snapshot every time Overview opens; the stream restarts with it.
  $effect(() => {
    if (activeTab !== 'overview' || !hostAgentReady) return;
    const epoch = untrack(() => scope.epoch);
    void loadRuntime(epoch);
  });

  async function loadRuntime(epoch: number) {
    const [pid, aid, hid] = ids();
    rtLoading = true;
    const [statusRes, statsRes, eventsRes] = await Promise.all([
      getTraceStatus(pid, aid, hid),
      getTraceStats(pid, aid, hid),
      getTraceEvents(pid, RT_MAX_EVENTS, undefined, aid, hid),
    ]);
    if (scope.isStale(epoch)) return;
    rtLoading = false;
    rtLoaded = true;
    const failed = [statusRes, statsRes, eventsRes].find((res) => res.error);
    rtError = failed?.error?.error ?? null;
    // The endpoints answer {} (stats) or {running:false} (status) before the agent reports.
    if (statusRes.data) rtStatus = statusRes.data as Partial<TraceStatus>;
    if (statsRes.data) rtStats = statsRes.data as Partial<TraceStats>;
    if (Array.isArray(eventsRes.data)) rtEvents = eventsRes.data.slice(0, RT_MAX_EVENTS);
  }

  const rtStreamWanted = $derived(activeTab === 'overview' && hostAgentReady && rtLoaded && !scope.hidden);
  $effect(() => {
    if (!rtStreamWanted) {
      rtState = 'closed';
      return;
    }
    const epoch = untrack(() => scope.epoch);
    const [pid, aid, hid] = untrack(ids);
    const conn = createSSEConnection({
      projectId: pid,
      agentId: aid,
      hostId: hid,
      channels: ['trace', 'status', 'stats'],
      onStateChange: (state) => {
        if (scope.isStale(epoch)) return;
        rtState = state;
        if (state === 'open') rtLimited = false;
      },
      onLimit: () => { if (!scope.isStale(epoch)) rtLimited = true; },
      onTrace: (events) => {
        if (scope.isStale(epoch) || !Array.isArray(events) || !events.length) return;
        rtEvents = [...events, ...rtEvents].slice(0, RT_MAX_EVENTS);
      },
      onStatus: (data) => { if (!scope.isStale(epoch) && data?.trace) rtStatus = data.trace; },
      onStats: (data) => { if (!scope.isStale(epoch) && data && typeof data === 'object') rtStats = data; },
    });
    return () => conn.close();
  });

  const rtSeverities = $derived(
    Object.entries(rtStats?.by_severity ?? {})
      .map(([name, count]) => ({ name, count: Number(count) || 0 }))
      .sort((a, b) => severityRank(b.name) - severityRank(a.name)),
  );
  const rtCategories = $derived(
    Object.entries(rtStats?.by_category ?? {})
      .map(([name, count]) => ({ name, count: Number(count) || 0 }))
      .sort((a, b) => b.count - a.count),
  );
  const rtStream = $derived.by((): { status: StatusKind; label: string } => {
    if (scope.hidden) return { status: 'disabled', label: 'Paused while this tab is hidden' };
    switch (rtState) {
      case 'open': return { status: 'online', label: 'Live' };
      case 'connecting': return { status: 'pending', label: 'Connecting…' };
      case 'reconnecting': return { status: 'degraded', label: rtLimited ? STREAM_LIMIT_LABEL : 'Reconnecting…' };
      case 'failed': return { status: 'offline', label: 'Live stream stopped' };
      default: return { status: 'disabled', label: 'Not streaming' };
    }
  });

  type EventRow = TraceEvent & { key: string };
  const rtRows = $derived.by((): EventRow[] => {
    const seen = new Map<string, number>();
    return rtEvents.map((event) => {
      const baseKey = `${event.timestamp}|${event.pid}|${event.event_name}|${event.comm}`;
      const n = (seen.get(baseKey) ?? 0) + 1;
      seen.set(baseKey, n);
      return { ...event, key: `${baseKey}#${n}` };
    });
  });
  const rtColumns: DataTableColumn<EventRow>[] = [
    { key: 'timestamp', label: 'Time', nowrap: true },
    { key: 'severity', label: 'Severity', nowrap: true },
    { key: 'category', label: 'Category' },
    { key: 'event_name', label: 'Event' },
    { key: 'comm', label: 'Process' },
    { key: 'pid', label: 'PID', align: 'right' },
    { key: 'action', label: 'Action' },
    { key: 'detail', label: 'Detail' },
  ];

  // ── Agents ─────────────────────────────────────────────────────────────
  const agentColumns: DataTableColumn<FleetAgent>[] = [
    { key: 'name', label: 'Agent', sortable: true, rowHeader: true },
    { key: 'kind', label: 'Kind', sortable: true },
    { key: 'status', label: 'Status', sortable: true, value: (row) => (row.is_online ? 'online' : 'offline') },
    { key: 'version', label: 'Version', sortable: true },
    { key: 'service_name', label: 'Service' },
    { key: 'last_seen', label: 'Last seen', sortable: true, firstSortDir: 'desc', sortValue: (row) => (row.last_seen ? Date.parse(row.last_seen) : 0), nowrap: true },
  ];
  const kindLabel = (kind: string) => (kind === 'host' ? 'Host agent' : kind === 'waf' ? 'WAF agent' : kind);

  // ── Host key and lifecycle (typed confirmations) ─────────────────
  const ACTION_TIER: Record<HostAction, ReturnType<typeof tierFor>> = {
    rotate: tierFor('rotate-host-key'),
    revoke: tierFor('revoke-host'),
    delete: tierFor('delete-host'),
  };
  const actionText = $derived.by(() => {
    const name = host?.name ?? 'this host';
    switch (action) {
      case 'rotate': return { title: `Rotate the host key of ${name}?`, label: 'Rotate key', tone: 'warning' as const, body: `The new key is shown once. The current key keeps working for 10 minutes; after that, agents on ${name} that present it (installed with the key in their env file) are refused at their next reconnect until they are restarted with the new key. Agents enrolled with the one-command install do not use the key and stay connected. The new key opens a ${ENROLL_DEFAULTS.window_hours}-hour enrollment window for the one-command install; the old key can no longer enroll.` };
      case 'revoke': return { title: `Revoke ${name}?`, label: 'Revoke host', tone: 'danger' as const, body: `The host key is invalidated and every agent on ${name} disconnects: its firewall rules stay in the kernel but receive no updates, and no telemetry is reported. A revoked host cannot be re-enabled; register it again to reconnect.`, credentials: true };
      case 'delete': return { title: `Delete ${name}?`, label: 'Delete host', tone: 'danger' as const, body: `${name}, its agents, firewall rules and telemetry are removed permanently. This cannot be undone.`, credentials: true };
      default: return { title: '', label: 'Confirm', tone: 'danger' as const, body: '' };
    }
  });

  function askAction(next: HostAction) {
    actionError = null;
    action = next;
  }

  async function runAction() {
    if (!action || !host || actionBusy) return;
    const current = action;
    const epoch = scope.epoch;
    const [pid, , hid] = ids();
    actionBusy = true;
    actionError = null;
    const res = current === 'rotate' ? await rotateHostKey(pid, hid)
      : current === 'revoke' ? await revokeHost(pid, hid)
      : await deleteHost(pid, hid);
    if (scope.isStale(epoch)) return;
    actionBusy = false;
    if (res.error) {
      actionError = res.error.error;
      return;
    }
    action = null;
    const data = res.data as { host_key?: string; enroll_expires_at?: string | null; credentials_revoked?: number } | undefined;
    const revokedCreds = data?.credentials_revoked ? ` ${formatCount(data.credentials_revoked, 'enrolled credential')} revoked with it.` : '';
    if (current === 'delete') {
      toast.success(`${host.name} was deleted.${revokedCreds}`, 'Host deleted');
      void goto(`${base}/projects/${pid}/hosts`);
      return;
    }
    if (current === 'rotate') {
      revealedKey = data?.host_key ?? null;
      revealedEnrollUntil = data?.enroll_expires_at ?? null;
      toast.success('Copy the new host key now; the old key no longer works.', 'Host key rotated');
    } else {
      toast.success(`${host.name} was revoked.${revokedCreds}`, 'Host revoked');
    }
    await reloadHost();
  }

  const STATUS_TEXT: Record<Host['status'], string> = { online: 'Online', pending: 'Pending', offline: 'Offline', revoked: 'Revoked' };
  usePageDetail(() => host?.name);
</script>

<div class="page">
  <PageHeader
    title={host?.name ?? 'Host'}
    subtitle="Firewall and runtime security at a glance, system inventory, agents and key of this host."
    backHref={`${base}/projects/${projectId}/hosts`}
    backLabel="← Hosts"
  >
    {#snippet actions()}
      {#if host}<Badge tone={statusTone(host.status)}>{STATUS_TEXT[host.status] ?? host.status}</Badge>{/if}
    {/snippet}
  </PageHeader>

  {#if hostError && !host}
    <Alert tone="error" title={hostError.status === 404 ? 'Host not found' : 'The host did not load'} message={hostError.status === 404 ? 'This host does not exist in the project or you no longer have access to it.' : hostError.error}>
      {#snippet actions()}
        {#if hostError?.status !== 404}<Button variant="secondary" size="sm" onclick={retry}>Retry</Button>{/if}
        <a href={`${base}/projects/${projectId}/hosts`}>Back to hosts</a>
      {/snippet}
    </Alert>
  {:else if !host}
    <Spinner label="Loading the host…" layout="block" />
  {:else}
    <dl class="evidence">
      <div><dt>Registered</dt><dd><DateTime value={host.created_at} /></dd></div>
      <div><dt>Last seen</dt><dd><DateTime value={host.last_seen} relative fallback="Never reported" /></dd></div>
      <div><dt>Host key</dt><dd><code>{host.host_key_prefix}…</code></dd></div>
      {#if host.revoked_at}<div><dt>Revoked</dt><dd><DateTime value={host.revoked_at} /></dd></div>{/if}
    </dl>

    {#if project.project && !canConfigure}
      <Alert tone="info" compact message="Read-only access: your role can view this host but not change its key or agents." />
    {/if}
    {#if scope.agentStatus === 'missing'}
      <Alert tone="info" compact title="No host agent on this host" message="Firewall and Runtime security need wafio-host-agent running on this host with its host key. WAF agents do not run the kernel firewall.">
        {#snippet actions()}
          {#if host.status !== 'revoked' && activeTab === 'overview'}<a href="#host-connect">Connect this host</a>{/if}
          <a href={agentsTabHref}>See the agents on this host</a>
        {/snippet}
      </Alert>
    {:else if scope.agentStatus === 'error'}
      <InlineError message="The agents of this host did not load, so Firewall and Runtime security are unavailable." onretry={retry} />
    {/if}

    <Tabs tabs={tabItems} value={activeTab} label="Host sections" onchange={selectTab}>
      {#snippet children(active)}
        {#if active === 'overview'}
          <div class="ov">
          {#if scope.agentStatus === 'missing' && host.status !== 'revoked'}
            <section class="card" id="host-connect" aria-labelledby="hd-connect" tabindex="-1">
              <h2 id="hd-connect">Connect this host</h2>
              <p class="note">Install wafio-host-agent on {host.name} for the firewall and runtime security. This page notices the agent within seconds.</p>
              <HostConnectGuide {projectId} hostId={host.id} hostName={host.name} enrollExpiresAt={host.enroll_expires_at} {canConfigure} onconnected={() => retry()} />
            </section>
          {/if}
          <section class="card sec-card" id="host-firewall" aria-labelledby="hd-fw" tabindex="-1">
            <div class="card-head">
              <h2 id="hd-fw">Firewall</h2>
              <span class="head-actions">
                <Button variant="ghost" size="sm" href={firewallHref({ tab: 'settings' })}>Settings</Button>
                <Button variant="primary" size="sm" href={firewallHref()}>Manage firewall</Button>
              </span>
            </div>
            <p class="note">Kernel packet filtering on {host.name}. Rules, settings and live traffic are changed on the Firewall page, which checks for lockouts before any change.</p>
            {#if !hostAgentReady}
              <p class="note">{noHostAgentReason}</p>
            {:else}
              {#if fwStatusError && !fwStatus}
                <InlineError message={fwStatusError} onretry={() => void loadFirewallStatus(scope.epoch)} />
              {:else if !fwStatus}
                <Spinner label="Loading firewall status…" layout="block" />
              {:else}
                <FirewallStatusBanner status={fwStatus} metrics={fwMetrics} setupHref={agentsTabHref} setupLabel="See the agents on this host" enforceHref={firewallHref()} />
                {#if fwLiveItems.length}
                  <section class="sub" aria-labelledby="hd-fw-live">
                    <div class="card-head"><h3 id="hd-fw-live">Traffic now</h3><a href={firewallHref({ tab: 'live' })}>Open live traffic</a></div>
                    <KpiStrip label="Firewall counters" items={fwLiveItems} />
                  </section>
                {/if}
                <section class="sub" aria-labelledby="hd-fw-rules">
                  <div class="card-head"><h3 id="hd-fw-rules">Access rules</h3><a href={firewallHref({ tab: 'rules' })}>Manage access rules</a></div>
                  {#if fwCounts}
                    <KpiStrip label="Access rules by type" items={fwRuleItems} minItemWidth="140px" />
                    {#if fwCounts.failed}
                      <Alert tone="error" compact title="Some rule counts did not load" message="The counts shown as “n/a” could not be read.">
                        {#snippet actions()}<Button variant="secondary" size="sm" disabled={fwCountsLoading} onclick={() => void loadFirewallCounts(scope.epoch)}>Retry</Button>{/snippet}
                      </Alert>
                    {/if}
                    {#if fwCounts.portPolicy}
                      <p class="note">
                        Port rules are {fwCounts.portPolicy.enabled ? 'on' : 'off'}; ingress default {fwCounts.portPolicy.default_ingress === 'deny' ? 'Deny all' : 'Allow all'}, egress default {fwCounts.portPolicy.default_egress === 'deny' ? 'Deny all' : 'Allow all'}.
                        <a href={firewallHref({ tab: 'settings' })}>Change in firewall settings</a>
                      </p>
                    {/if}
                  {:else}
                    <Spinner size="sm" label="Counting rules…" />
                  {/if}
                </section>
              {/if}
            {/if}
          </section>
          <section class="card sec-card" id="host-runtime" aria-labelledby="hd-rt" tabindex="-1">
            <div class="card-head">
              <h2 id="hd-rt">Runtime security</h2>
              <Button variant="primary" size="sm" href={runtimeHref}>Manage runtime security</Button>
            </div>
            <p class="note">Probe status, event counts and the latest events on {host.name}. Incidents, policies and the full event explorer are on the Runtime security page.</p>
            {#if !hostAgentReady}
              <p class="note">{noHostAgentReason}</p>
            {:else}
              {#if rtError}<InlineError message={rtError} onretry={() => void loadRuntime(scope.epoch)} />{/if}
              {#if !rtLoaded}
                <Spinner label="Loading runtime security…" layout="block" />
              {:else}
                <section class="sub" aria-labelledby="hd-rt-status">
                  <div class="card-head">
                    <h3 id="hd-rt-status">Tracing</h3>
                    <StatusDot status={rtStatus?.running ? 'online' : rtStatus ? 'offline' : 'unknown'} label={rtStatus?.running ? 'Running' : rtStatus ? 'Stopped' : 'Not reported'} />
                  </div>
                  {#if rtStatus}
                    <dl class="facts facts-inline">
                      <div><dt>Probes attached</dt><dd>{formatNumber(rtStatus.probes ?? 0)}{rtStatus.expected_probes ? ` of ${formatNumber(rtStatus.expected_probes)}` : ''}</dd></div>
                      <div><dt>Enforcement</dt><dd>{#if rtStatus.enforcement}<Badge tone="mode-block">On</Badge>{:else}<Badge tone="neutral">Detection only</Badge>{/if}</dd></div>
                      <div><dt>Policies</dt><dd>{formatNumber(rtStatus.policies_total ?? 0)}</dd></div>
                      <div><dt>Uptime</dt><dd>{rtStatus.uptime_ms ? formatDuration(rtStatus.uptime_ms, 'ms') : 'n/a'}</dd></div>
                      {#if rtStatus.agent_online === false}<div><dt>Agent</dt><dd>Offline{rtStatus.agent_last_seen ? `, last seen ${formatRelative(rtStatus.agent_last_seen)}` : ''}</dd></div>{/if}
                    </dl>
                  {:else}
                    <p class="note">The runtime security agent has not reported yet.</p>
                  {/if}
                </section>

                <section class="sub" aria-labelledby="hd-rt-stats">
                  <div class="card-head">
                    <h3 id="hd-rt-stats">Events since the agent started</h3>
                    <span class="muted">{formatCount(rtStats?.total_events ?? 0, 'event')}</span>
                  </div>
                  {#if rtSeverities.length || rtCategories.length}
                    <div class="counts">
                      {#if rtSeverities.length}
                        <ul class="count-list" aria-label="Events by severity">
                          {#each rtSeverities as sev (sev.name)}<li><Badge tone={severityTone(sev.name)}>{sev.name}</Badge> <span>{formatNumber(sev.count)}</span></li>{/each}
                        </ul>
                      {/if}
                      {#if rtCategories.length}
                        <ul class="count-list" aria-label="Events by category">
                          {#each rtCategories as cat (cat.name)}<li><span class="cat">{cat.name}</span> <span>{formatNumber(cat.count)}</span></li>{/each}
                        </ul>
                      {/if}
                    </div>
                  {:else}
                    <p class="note">No event counts reported yet.</p>
                  {/if}
                </section>

                <section class="sub" aria-labelledby="hd-rt-events">
                  <div class="card-head">
                    <h3 id="hd-rt-events">Latest events</h3>
                    <StatusDot status={rtStream.status} label={rtStream.label} pulse={rtStream.status === 'online'} />
                  </div>
                  <DataTable
                    rows={rtRows}
                    columns={rtColumns}
                    rowKey={(row) => row.key}
                    caption={`Latest ${RT_MAX_EVENTS} runtime events on ${host.name}`}
                    density="compact"
                    loading={rtLoading && !rtEvents.length}
                    emptyTitle="No runtime events yet"
                    emptyMessage="Events appear once the host agent traces process, file and network activity."
                  >
                    {#snippet cell(row, column)}
                      {#if column.key === 'timestamp'}<DateTime value={row.timestamp} seconds />
                      {:else if column.key === 'severity'}<Badge tone={severityTone(row.severity_name)}>{row.severity_name}</Badge>
                      {:else if column.key === 'category'}{row.category}
                      {:else if column.key === 'event_name'}<code>{row.event_name}</code>
                      {:else if column.key === 'comm'}<code>{row.comm}</code>
                      {:else if column.key === 'pid'}{row.pid}
                      {:else if column.key === 'action'}<Badge tone={enforcementTone(row.action_name)}>{row.action_name}</Badge>
                      {:else}<span class="detail">{row.description ?? row.filename ?? row.addr ?? 'n/a'}</span>{/if}
                    {/snippet}
                  </DataTable>
                </section>
              {/if}
            {/if}
          </section>
            <div class="ov-live"><StatusDot status={infoStream.status} label={infoStream.label} pulse={infoStream.status === 'online'} /></div>
            <div class="cards">
              <section class="card" aria-labelledby="hd-system">
                <h2 id="hd-system">System</h2>
                <dl class="facts">
                  {#each SYSTEM_FIELDS as [label, field] (field)}<div><dt>{label}</dt><dd>{hostInfoDisplay(info, field)}</dd></div>{/each}
                </dl>
              </section>
              <section class="card" aria-labelledby="hd-hardware">
                <h2 id="hd-hardware">Hardware</h2>
                <dl class="facts">
                  {#each HARDWARE_FIELDS as [label, field] (field)}<div><dt>{label}</dt><dd>{hostInfoDisplay(info, field)}</dd></div>{/each}
                  <div><dt>Load 1 / 5 / 15 min</dt><dd>{hostLoadAverage(info)}</dd></div>
                </dl>
              </section>
              <section class="card" aria-labelledby="hd-disk">
                <h2 id="hd-disk">Disk</h2>
                {#if disks.length}
                  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
                  <div class="mini-scroll" role="region" aria-labelledby="hd-disk" tabindex="0">
                    <table class="mini">
                      <thead><tr><th scope="col">Mount</th><th scope="col">Size</th><th scope="col">Used</th><th scope="col">File system</th></tr></thead>
                      <tbody>
                        {#each disks as disk, index (index)}
                          <tr>
                            <th scope="row"><code>{disk.mount}</code></th>
                            <td>{disk.total === null ? 'n/a' : formatBytes(disk.total)}</td>
                            <td>{disk.used === null ? 'n/a' : `${formatBytes(disk.used)} (${usedPercent(disk.used, disk.total)})`}</td>
                            <td>{disk.fs}</td>
                          </tr>
                        {/each}
                      </tbody>
                    </table>
                  </div>
                {:else}
                  <dl class="facts">
                    <div><dt>Root total</dt><dd>{hostInfoDisplay(info, 'disk_total')}</dd></div>
                    <div><dt>Root free</dt><dd>{hostInfoDisplay(info, 'disk_free')}</dd></div>
                  </dl>
                  <p class="note">A per-mount breakdown needs agent version 2 or later.</p>
                {/if}
              </section>
              <section class="card" aria-labelledby="hd-network">
                <h2 id="hd-network">Network</h2>
                {#if nics.length}
                  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
                  <div class="mini-scroll" role="region" aria-labelledby="hd-network" tabindex="0">
                    <table class="mini">
                      <thead><tr><th scope="col">Interface</th><th scope="col">Addresses</th><th scope="col">MAC</th></tr></thead>
                      <tbody>
                        {#each nics as nic, index (index)}
                          <tr><th scope="row"><code>{nic.name}</code></th><td>{nic.addresses.join(', ') || 'n/a'}</td><td><code>{nic.mac}</code></td></tr>
                        {/each}
                      </tbody>
                    </table>
                  </div>
                {:else}
                  <dl class="facts">
                    <div><dt>Primary address</dt><dd>{hostInfoDisplay(info, 'primary_ip')}</dd></div>
                    <div><dt>Interface</dt><dd>{hostInfoDisplay(info, 'interface')}</dd></div>
                  </dl>
                {/if}
              </section>
              <section class="card" aria-labelledby="hd-security">
                <h2 id="hd-security">Security and runtime</h2>
                <dl class="facts">
                  {#each SECURITY_FIELDS as [label, field] (field)}<div><dt>{label}</dt><dd>{hostInfoDisplay(info, field)}</dd></div>{/each}
                </dl>
              </section>
              <section class="card" aria-labelledby="hd-labels">
                <div class="card-head">
                  <h2 id="hd-labels">Labels</h2>
                  <Button variant="ghost" size="sm" disabled={!canConfigure} title={canConfigure ? undefined : 'Your role cannot edit labels'} onclick={() => (labelsOpen = true)}>Edit labels…</Button>
                </div>
                {#if Object.keys(host.labels ?? {}).length}
                  <ul class="labels">{#each Object.entries(host.labels ?? {}) as [k, v] (k)}<li class="label">{k}={v}</li>{/each}</ul>
                {:else}
                  <p class="note">No labels.</p>
                {/if}
              </section>
            </div>

            <section class="card lifecycle" aria-labelledby="hd-lifecycle">
              <h2 id="hd-lifecycle">Host key and lifecycle</h2>
              <p class="note">Every agent on this host authenticates with its host key (prefix <code>{host.host_key_prefix}…</code>). Each action below asks you to type the host name.</p>
              <ul class="lifecycle-list">
                <li>
                  <div><strong>Rotate the host key</strong><span class="note">Issues a new key and opens a {ENROLL_DEFAULTS.window_hours}-hour enrollment window; agents disconnect until restarted with it.</span></div>
                  <Button variant="secondary" size="sm" disabled={!canConfigure || host.status === 'revoked'} title={!canConfigure ? 'Your role cannot rotate host keys' : host.status === 'revoked' ? 'The host is revoked' : undefined} onclick={() => askAction('rotate')}>Rotate key…</Button>
                </li>
                <li>
                  <div><strong>Revoke the host</strong><span class="note">Invalidates the key and the credentials enrolled for this host for good; the host stays listed as revoked.</span></div>
                  <Button variant="outline" size="sm" disabled={!canConfigure || host.status === 'revoked'} title={!canConfigure ? 'Your role cannot revoke hosts' : host.status === 'revoked' ? 'Already revoked' : undefined} onclick={() => askAction('revoke')}>Revoke…</Button>
                </li>
                <li>
                  <div><strong>Delete the host</strong><span class="note">Removes the host, its agents, rules and telemetry. Owners only.</span></div>
                  <Button variant="danger" size="sm" disabled={!canDelete} title={canDelete ? undefined : 'Only project owners can delete hosts'} onclick={() => askAction('delete')}>Delete…</Button>
                </li>
              </ul>
            </section>
          </div>

        {:else}
          <div class="summary">
            {#if !agents.length && scope.agentStatus !== 'resolving'}
              <EmptyState title="No agents on this host yet" message="Install wafio-host-agent with this host's host key for the firewall and runtime security, or wafio-waf-agent with a project credential for L7 inspection; assign applications from WAF agents." level={2}>
                {#snippet action()}<a href={`${base}/projects/${projectId}/settings/credentials`}>Open credentials</a>{/snippet}
              </EmptyState>
            {:else}
              <DataTable
                rows={agents}
                columns={agentColumns}
                rowKey={(row) => row.id}
                caption={`Agents on ${host.name}`}
                itemLabel="agents"
                loading={scope.agentStatus === 'resolving' && !agents.length}
                bind:expandedKeys={expandedAgents}
                expandLabel={(row) => `Details for ${row.name}`}
              >
                {#snippet cell(row, column)}
                  {#if column.key === 'name'}<span class="agent-name">{row.name}</span>
                  {:else if column.key === 'kind'}<Badge tone={agentKindTone(row.kind)}>{kindLabel(row.kind)}</Badge>
                  {:else if column.key === 'status'}<StatusDot status={row.is_online ? 'online' : row.last_seen ? 'offline' : 'unknown'} label={row.is_online ? 'Online' : row.last_seen ? 'Offline' : 'Never seen'} />
                  {:else if column.key === 'version'}{row.version ?? 'n/a'}
                  {:else if column.key === 'service_name'}{#if row.service_name}<code>{row.service_name}</code>{:else}n/a{/if}
                  {:else if column.key === 'last_seen'}{#if row.last_seen}<time datetime={toISO(row.last_seen)} title={formatDateTime(row.last_seen, { seconds: true })}>{formatRelative(row.last_seen)}</time>{:else}Never{/if}{/if}
                {/snippet}
                {#snippet expanded(row)}
                  <dl class="facts facts-inline">
                    <div><dt>Agent ID</dt><dd><code>{row.id}</code></dd></div>
                    <div><dt>Kind</dt><dd>{kindLabel(row.kind)}</dd></div>
                    <div><dt>Service</dt><dd>{#if row.service_name}<code>{row.service_name}</code>{:else}n/a{/if}</dd></div>
                    <div><dt>Runs as</dt><dd>{row.service_user ?? 'root'}</dd></div>
                    <div><dt>Binary</dt><dd>{#if row.binary_path}<code>{row.binary_path}</code>{:else}n/a{/if}</dd></div>
                    <div><dt>Install directory</dt><dd>{#if row.install_dir}<code>{row.install_dir}</code>{:else}n/a{/if}</dd></div>
                    <div><dt>Version</dt><dd>{row.version ?? 'n/a'}</dd></div>
                    <div><dt>Registered</dt><dd><DateTime value={row.created_at} /></dd></div>
                    <div><dt>Last seen</dt><dd><DateTime value={row.last_seen} seconds fallback="Never" /></dd></div>
                  </dl>
                {/snippet}
              </DataTable>
              <p class="note">Agents are registered by installing them on the host. Remove a WAF agent from WAF agents.</p>
            {/if}
          </div>
        {/if}
      {/snippet}
    </Tabs>
  {/if}
</div>

<ConfirmModal
  open={action !== null}
  title={actionText.title}
  confirmLabel={actionText.label}
  tone={actionText.tone}
  loading={actionBusy}
  requireText={action && ACTION_TIER[action] === 'typed' ? host?.name ?? '' : ''}
  requireTextLabel={host ? `Type the host name, ${host.name}, to confirm` : undefined}
  onconfirm={runAction}
  onclose={() => { if (!actionBusy) action = null; }}
>
  <div class="confirm">
    <p>{actionText.body}</p>
    {#if actionText.credentials}
      <p>Every credential enrolled for this host with its host key is revoked too and its streams are closed. Project-wide credentials made on the Credentials page are not bound to a host and stay valid: revoke them on the Credentials page.</p>
      <p>{REMOVED_AGENT_TEXT}</p>
    {/if}
    {#if actionError}<Alert tone="error" compact title="Not done" message={actionError} />{/if}
  </div>
</ConfirmModal>

{#if revealedKey && host}
  <KeyRevealModal
    title={`New host key for ${host.name}`}
    description={`Restart every WAFio agent on ${host.name} with this key (steps below). The new key also opens an enrollment window${revealedEnrollUntil ? ` until ${formatDateTime(revealedEnrollUntil)}` : ` of ${ENROLL_DEFAULTS.window_hours} hours`}: running the one-command install again on the host renews its certificates.`}
    value={revealedKey}
    label="Host key"
    snippet={rotatedKeySteps(revealedKey)}
    snippetLabel="Update the host"
    onclose={() => (revealedKey = null)}
  />
{/if}

{#if host}
  <HostLabelsModal open={labelsOpen} {projectId} hosts={[host]} onclose={() => (labelsOpen = false)} onsaved={() => void reloadHost()} />
{/if}

<style>
  .page { display: grid; gap: var(--sp-4); width: 100%; min-width: 0; box-sizing: border-box; padding: var(--page-top) var(--page-gutter) var(--sp-7); align-content: start; }
  .evidence { display: flex; flex-wrap: wrap; gap: var(--sp-2) var(--sp-5); margin: 0; font-size: var(--fs-xs); }
  .evidence div { display: flex; gap: var(--sp-2); }
  .evidence dt { color: var(--text-muted); }
  .evidence dd { margin: 0; color: var(--text-primary); }
  code { font-family: var(--font-mono); font-size: var(--fs-xs); }
  .ov, .summary { display: grid; gap: var(--sp-4); min-width: 0; }
  .ov-live { display: flex; justify-content: flex-end; font-size: var(--fs-xs); }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr)); gap: var(--sp-4); }
  .card { display: grid; gap: var(--sp-3); align-content: start; min-width: 0; padding: var(--sp-4); border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-card); }
  .card h2 { margin: 0; font-size: var(--fs-base); font-weight: var(--fw-semibold); color: var(--text-primary); }
  .card-head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: var(--sp-2) var(--sp-4); }
  .card-head a, .note a { color: var(--accent); font-size: var(--fs-sm); }
  .facts { display: grid; gap: 0; margin: 0; }
  .facts div { display: grid; grid-template-columns: minmax(110px, 0.8fr) minmax(0, 1.4fr); gap: var(--sp-3); padding: var(--sp-2) 0; border-bottom: 1px solid var(--border); font-size: var(--fs-sm); }
  .facts div:last-child { border-bottom: 0; }
  .facts dt { color: var(--text-muted); }
  .facts dd { margin: 0; color: var(--text-primary); overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
  .facts-inline { grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr)); column-gap: var(--sp-5); }
  .note { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.5; }
  .muted { color: var(--text-muted); font-size: var(--fs-xs); }
  .mini-scroll { position: relative; overflow-x: auto; }
  .mini-scroll:focus-visible { outline: var(--ring-width) solid var(--ring-color); outline-offset: 2px; }
  .mini { width: 100%; border-collapse: collapse; font-size: var(--fs-xs); }
  .mini th, .mini td { padding: var(--sp-2); border-bottom: 1px solid var(--border); text-align: left; white-space: nowrap; }
  .mini thead th { color: var(--text-muted); font-weight: var(--fw-medium); }
  .mini tbody th { font-weight: normal; }
  .mini td { color: var(--text-primary); font-variant-numeric: tabular-nums; }
  .labels { display: flex; flex-wrap: wrap; gap: var(--sp-2); margin: 0; padding: 0; list-style: none; }
  .label { padding: 0 var(--sp-2); border: 1px solid var(--border); border-radius: var(--radius); font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--text-secondary); }
  .lifecycle-list { display: grid; gap: 0; margin: 0; padding: 0; list-style: none; }
  .lifecycle-list li { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: var(--sp-2) var(--sp-4); padding: var(--sp-3) 0; border-top: 1px solid var(--border); }
  .lifecycle-list li div { display: grid; gap: calc(var(--sp-1) / 2); min-width: 0; flex: 1 1 260px; }
  .lifecycle-list strong { font-size: var(--fs-sm); font-weight: var(--fw-medium); color: var(--text-primary); }
  .head-actions { display: inline-flex; flex-wrap: wrap; gap: var(--sp-2); }
  .sec-card { scroll-margin-top: var(--sp-4); }
  .sec-card:focus-visible { outline: var(--ring-width) solid var(--ring-color); outline-offset: 2px; }
  .sub { display: grid; gap: var(--sp-3); min-width: 0; padding-top: var(--sp-3); border-top: 1px solid var(--border); }
  .sub h3 { margin: 0; font-size: var(--fs-sm); font-weight: var(--fw-semibold); color: var(--text-primary); }
  .counts { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr)); gap: var(--sp-4); }
  .count-list { display: grid; gap: var(--sp-2); margin: 0; padding: 0; list-style: none; }
  .count-list li { display: flex; justify-content: space-between; align-items: center; gap: var(--sp-3); font-size: var(--fs-sm); color: var(--text-primary); font-variant-numeric: tabular-nums; }
  .cat { color: var(--text-secondary); }
  .detail { display: inline-block; max-width: 36ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; color: var(--text-secondary); }
  .agent-name { font-weight: var(--fw-medium); color: var(--text-primary); }
  .confirm { display: grid; gap: var(--sp-3); }
  .confirm p { margin: 0; font-size: var(--fs-sm); color: var(--text-secondary); line-height: 1.5; }
</style>
