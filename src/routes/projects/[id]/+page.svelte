<script lang="ts" module>
  /** Projects whose Get started checklist was complete this session; not re-checked. */
  const setupDoneProjects = new Set<string>();
</script>

<script lang="ts">
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { untrack } from 'svelte';
  import { base } from '#lib/paths.js';
  import {
    getDashboardByMethod,
    getDashboardLogs,
    getOverviewEvidence,
    getProjectOverview,
    getWAFEventsRecent,
    listAgentMTLSCredentials,
    listAgentRoutes,
    listApps,
    listIncidents,
    type DashboardLogEntry,
    type EBPFEvent,
    type FleetAgent,
    type Host,
    type HostIncident,
    type OverviewEvidence as OverviewEvidenceData,
    type TraceEvent,
    type TraceStats,
    type WAFEventSummary,
    type WAFEventTimelineBucket,
    type WAFEventTopRow,
  } from '#lib/api.js';
  import {
    describeDecisionFilter,
    groupAttention,
    installCommand,
    matchesDecisionFilter,
    mergeEvidenceActions,
    overviewBucketSeconds,
    requestDelta,
    scopedWAFAgents,
    setupChecklist,
    type AttentionGroup,
    type DecisionFilter,
    type SetupState,
  } from '#lib/overview.js';
  import { formatDateTime, formatDuration, formatNumber, formatPercent, formatRelative } from '#lib/format.js';
  import { decisionMethodSplit, httpMethodSplit } from '#lib/detection-quality.js';
  import { EMPTY_FEED_FILTER, writeFeedFilter } from '#lib/waf-live.js';
  import { appPath, appTabSearch } from '#lib/components/apps/app-page.js';
  import DetectionQuality, { type ReviewTarget } from '#lib/components/DetectionQuality.svelte';
  import ShareBars from '#lib/components/ShareBars.svelte';
  import { actionTone, enforcementTone, severityColor, severityTone, strengthTone, SEVERITIES } from '#lib/tone.js';
  import { countryFlag, formatCountryName } from '#lib/geo.js';
  import { createPoller } from '#lib/polling.svelte.js';
  import { toast } from '#lib/stores/toast.js';
  import { getProjectContext } from '#lib/project-context.svelte.js';
  import OverviewEvidence from '#lib/components/OverviewEvidence.svelte';
  import { DateTime, InlineError } from '#lib/components/ui/index.js';
  import PageHeader from '#lib/components/ui/PageHeader.svelte';
  import EmptyState from '#lib/components/ui/EmptyState.svelte';
  import Table from '#lib/components/ui/Table.svelte';
  import Badge from '#lib/components/ui/Badge.svelte';
  import { strengthLabel } from '#lib/components/apps/decision-format.js';
  import Button from '#lib/components/ui/Button.svelte';
  import Alert from '#lib/components/ui/Alert.svelte';
  import Select from '#lib/components/ui/Select.svelte';
  import KpiStrip from '#lib/components/ui/KpiStrip.svelte';
  import StatusDot from '#lib/components/ui/StatusDot.svelte';
  import Drawer from '#lib/components/ui/Drawer.svelte';
  import TimeRangePicker from '#lib/components/ui/TimeRangePicker.svelte';
  import { DEFAULT_TIME_RANGE, parseTimeRange, timeRangeLabel, timeRangeMinutes, type TimeRangeKey } from '#lib/components/ui/time-range.js';
  import type { KpiItem, StatusKind } from '#lib/components/ui/types.js';

  const project = getProjectContext();

  // ── URL state: one range and one host scope for every widget ─────
  const projectId = $derived(page.params.id ?? '');
  const root = $derived(`${base}/projects/${projectId}`);
  const range = $derived(parseTimeRange(page.url.searchParams.get('range')));
  const minutes = $derived(timeRangeMinutes(range) ?? 60);
  const rangeText = $derived(timeRangeLabel(range).toLowerCase());
  const hostFilter = $derived(page.url.searchParams.get('host') ?? '');
  const forceSetup = $derived(page.url.searchParams.get('setup') === '1');

  function setQuery(patch: Record<string, string | null>) {
    const url = new URL(page.url.href);
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === '') url.searchParams.delete(key);
      else url.searchParams.set(key, value);
    }
    void goto(`${url.pathname}${url.search}${url.hash}`, { replace: true, reset: false });
  }

  function setRange(key: TimeRangeKey) {
    setQuery({ range: key === DEFAULT_TIME_RANGE ? null : key });
  }

  /** The current URL with ?setup=1 added (range and host kept). */
  const setupHref = $derived.by(() => {
    const url = new URL(page.url.href);
    url.searchParams.set('setup', '1');
    return `${url.pathname}${url.search}#get-started`;
  });

  // ── Overview snapshot ─────────────────────────────────────────────────
  let overviewLoading = $state(false);
  let overviewLoaded = $state(false);
  let overviewError = $state('');
  let generatedAt = $state<string | null>(null);
  let windowStart = $state<string | null>(null);
  let windowEnd = $state<string | null>(null);
  let widgetStatus = $state<Record<string, { state: string; message?: string }>>({});
  let wafSummary = $state<WAFEventSummary | null>(null);
  let wafSummaryPrev = $state<WAFEventSummary | null>(null);
  let wafAgents = $state<FleetAgent[]>([]);
  let timeline = $state<WAFEventTimelineBucket[]>([]);
  let topIps = $state<WAFEventTopRow[]>([]);
  let topCategories = $state<WAFEventTopRow[]>([]);
  let topCountries = $state<{ label: string; code: string; count: number }[]>([]);
  let fwDrops = $state(0);
  let firewallEvents = $state<EBPFEvent[]>([]);
  let traceStats = $state<Partial<TraceStats> | null>(null);
  let runtimeEvents = $state<TraceEvent[]>([]);
  let hosts = $state<Host[]>([]);
  let traceRunning = $state(0);
  let nowTs = $state(Date.now());
  let overviewVersion = 0;

  /** Bumped with every overview load so Detection quality refreshes with it. */
  let fpToken = $state(0);

  async function loadOverview() {
    const version = ++overviewVersion;
    const pid = projectId;
    fpToken++;
    void loadMethods();
    overviewLoading = true;
    overviewError = '';
    const res = await getProjectOverview(pid, {
      minutes,
      bucketSeconds: overviewBucketSeconds(minutes),
      hostId: hostFilter || undefined,
      limit: 8,
    });
    if (version !== overviewVersion) return;
    overviewLoading = false;
    overviewLoaded = true;
    nowTs = Date.now();
    if (res.error || !res.data) {
      overviewError = res.error?.error ?? 'The overview could not be loaded.';
      return;
    }
    const d = res.data;
    widgetStatus = d.widgets ?? {};
    const available = (key: string) => widgetStatus[key]?.state !== 'unavailable';
    windowStart = d.waf_window_start ?? null;
    windowEnd = d.waf_window_end ?? null;
    generatedAt = d.generated_at ?? null;
    wafSummary = available('waf_summary') ? d.waf_summary ?? null : null;
    wafSummaryPrev = available('waf_summary_prev') ? d.waf_summary_prev ?? null : null;
    wafAgents = d.waf_agents?.agents ?? [];
    timeline = d.waf_timeline?.buckets ?? [];
    topIps = d.waf_top_ips?.rows ?? [];
    topCategories = d.waf_top_categories?.rows ?? [];
    topCountries = d.waf_top_countries?.rows ?? [];
    fwDrops = d.host_fw_drops_windowed ?? 0;
    firewallEvents = d.host_firewall_events?.events ?? [];
    // GET /overview can answer {} for trace stats: every field is optional.
    traceStats = available('host_trace_stats') ? (d.host_trace_stats as Partial<TraceStats> | null) ?? null : null;
    runtimeEvents = d.host_trace_events ?? [];
    hosts = d.hosts?.hosts ?? [];
    traceRunning = d.host_agg_status?.trace_running ?? 0;
    if (!setupDoneProjects.has(pid)) void loadSetup(pid);
  }

  // ── HTTP method split (GET …/dashboard/stats/by-method) ────────────
  // Project-wide: the endpoint has no host filter, so the panel says so.
  let httpMethods = $state<{ key: string; count: number }[] | null>(null);
  let httpMethodsError = $state('');
  let methodsVersion = 0;
  let methodsController: AbortController | null = null;

  async function loadMethods() {
    const version = ++methodsVersion;
    methodsController?.abort();
    const ctl = new AbortController();
    methodsController = ctl;
    const to = Math.floor(Date.now() / 1000);
    const res = await getDashboardByMethod(projectId, { from_ts: to - minutes * 60, to_ts: to }, ctl.signal);
    if (version !== methodsVersion || ctl.signal.aborted) return;
    if (res.error || !res.data) {
      httpMethods = null;
      httpMethodsError = res.error?.error || 'The HTTP method split could not be loaded.';
      return;
    }
    httpMethodsError = '';
    httpMethods = res.data.by_method ?? [];
  }

  /** An application's Decisions tab, filtered to blocked decisions (to assess them). */
  function reviewHref(target: ReviewTarget): string | null {
    if (!target.appId) return target.category ? null : `${root}/apps`;
    const search = writeFeedFilter('', { ...EMPTY_FEED_FILTER, action: 'block' });
    return `${appPath(base, projectId, target.appId)}${appTabSearch(search, 'decisions')}`;
  }

  // ── Needs attention (all evidence pages + unresolved incidents) ────────
  const EVIDENCE_PAGE_CAP = 15;
  const INCIDENT_PAGE_CAP = 5;
  let attentionLoading = $state(false);
  let attentionError = $state('');
  let attentionNotices = $state<string[]>([]);
  let evidence = $state<OverviewEvidenceData | null>(null);
  let incidents = $state<HostIncident[] | null>(null);
  let attentionVersion = 0;

  async function loadIncidents(pid: string, host: string): Promise<{ rows: HostIncident[]; total: number } | null> {
    const first = await listIncidents(pid, 'unresolved', 100, 0, host);
    if (first.error || !first.data) return null;
    const rows = [...(first.data.incidents ?? [])];
    const total = first.data.total ?? rows.length;
    const offsets: number[] = [];
    for (let offset = rows.length; offset < total && offsets.length < INCIDENT_PAGE_CAP - 1 && rows.length > 0; offset += 100) offsets.push(offset);
    const pages = await Promise.all(offsets.map((offset) => listIncidents(pid, 'unresolved', 100, offset, host)));
    for (const next of pages) {
      if (next.error || !next.data) return null;
      rows.push(...(next.data.incidents ?? []));
    }
    return { rows, total };
  }

  async function loadAttention() {
    const version = ++attentionVersion;
    const pid = projectId;
    const host = hostFilter;
    attentionLoading = true;
    attentionError = '';
    const [first, incidentResult] = await Promise.all([getOverviewEvidence(pid, host, 0), loadIncidents(pid, host)]);
    if (version !== attentionVersion) return;
    if (first.error || !first.data) {
      attentionLoading = false;
      attentionError = first.error?.error ?? 'Evidence unavailable';
      return;
    }
    const pageSize = first.data.actions.length || 20;
    const offsets: number[] = [];
    for (let offset = pageSize; offset < first.data.total && offsets.length < EVIDENCE_PAGE_CAP - 1; offset += pageSize) offsets.push(offset);
    const rest = await Promise.all(offsets.map((offset) => getOverviewEvidence(pid, host, offset)));
    if (version !== attentionVersion) return;
    const notices: string[] = [];
    const pages = [first.data.actions];
    for (const next of rest) {
      if (next.data) pages.push(next.data.actions);
      else notices.push('Part of the evidence list failed to load; some rows may be missing.');
    }
    const actions = mergeEvidenceActions(pages);
    if (actions.length < first.data.total) notices.push(`Showing ${actions.length} of ${first.data.total} evidence rows.`);
    if (!incidentResult) notices.push('Incident details (rule, process) are unavailable, so incidents are grouped by host only.');
    else if (incidentResult.rows.length < incidentResult.total) notices.push(`Grouped ${incidentResult.rows.length} of ${incidentResult.total} unresolved incidents.`);
    evidence = { ...first.data, actions };
    incidents = incidentResult?.rows ?? null;
    attentionNotices = [...new Set(notices)];
    attentionLoading = false;
  }

  const hostNames = $derived(Object.fromEntries(hosts.map((h) => [h.id, h.name || h.id.slice(0, 8)])));
  const attentionGroups: AttentionGroup[] = $derived(
    evidence ? groupAttention({ evidence, incidents, projectRoot: root, hostNames }) : [],
  );

  // ── Get started checklist ─────────────────────────────────────
  let setup = $state<SetupState | null>(null);
  let setupLoading = $state(false);
  let installKind = $state<'waf' | 'host'>('waf');
  const INSTALL_KINDS: { value: 'waf' | 'host'; label: string }[] = [
    { value: 'waf', label: 'WAF agent' },
    { value: 'host', label: 'Host agent' },
  ];
  let copied = $state(false);
  let setupVersion = 0;

  async function loadSetup(pid: string) {
    const version = ++setupVersion;
    setupLoading = true;
    const agentsNow = wafAgents;
    const hostsNow = hosts;
    const summaryNow = wafSummary;
    const [credentials, apps] = await Promise.all([listAgentMTLSCredentials(pid, { limit: 1 }), listApps(pid, { limit: 1 })]);
    if (version !== setupVersion) return;
    const appCount = apps.data ? apps.data.total ?? apps.data.apps.length : null;
    let assigned: number | null = null;
    if (appCount === 0 || agentsNow.length === 0) assigned = 0;
    else if (appCount !== null) {
      assigned = 0;
      for (const agent of agentsNow.slice(0, 10)) {
        const routes = await listAgentRoutes(pid, agent.id, { limit: 1 });
        if (version !== setupVersion) return;
        if (routes.error || !routes.data) { assigned = null; break; }
        const count = routes.data.total ?? routes.data.routes.length;
        if (count > 0) { assigned = count; break; }
      }
    }
    let decisions: number | null = summaryNow && summaryNow.requests > 0 ? summaryNow.requests : null;
    if (decisions === null) {
      const recent = await getWAFEventsRecent(pid, { limit: 1 });
      if (version !== setupVersion) return;
      decisions = recent.data ? (recent.data.decisions ?? []).length : null;
    }
    const seen = agentsNow.filter((a) => a.last_seen).length + hostsNow.filter((h) => h.last_seen || h.status === 'online').length;
    setup = {
      hosts: hostsNow.length,
      credentials: credentials.data ? credentials.data.total ?? credentials.data.credentials.length : null,
      credentialName: credentials.data?.credentials?.[0]?.name ?? null,
      apps: appCount,
      assignedApps: assigned,
      wafAgents: agentsNow.length,
      agentsSeen: seen,
      decisions,
    };
    setupLoading = false;
    if (setupChecklist(setup, root).complete) setupDoneProjects.add(pid);
  }

  const checklist = $derived(setup ? setupChecklist(setup, root) : null);
  const showChecklist = $derived(Boolean(checklist && (!checklist.complete || forceSetup)));
  const nextStep = $derived(checklist?.steps.find((step) => step.done !== true) ?? null);
  const command = $derived(installCommand(setup?.credentialName ?? 'agent', installKind));

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(command);
      copied = true;
      setTimeout(() => (copied = false), 2000);
    } catch {
      copied = false;
      toast.error('Copy failed. Select the command and copy it by hand.');
    }
  }

  // ── Loading lifecycle ─────────────────────────────────────────────────
  $effect(() => {
    void projectId;
    untrack(() => {
      setup = null;
      // A check of the previous project still running never finishes now
      // (version bump): it must not leave "Checking project setup…" behind.
      setupLoading = false;
      evidence = null;
      incidents = null;
      overviewLoaded = false;
      setupVersion++;
    });
  });
  $effect(() => {
    void projectId; void minutes; void hostFilter;
    if (!projectId) return;
    untrack(() => void loadOverview());
  });
  $effect(() => {
    void projectId; void hostFilter;
    if (!projectId) return;
    untrack(() => void loadAttention());
  });
  $effect(() => () => {
    methodsVersion++;
    methodsController?.abort();
    overviewVersion++;
    attentionVersion++;
    setupVersion++;
  });

  let autoRefresh = $state(false);
  const overviewPoller = createPoller(() => loadOverview(), 30_000, { immediate: false });
  const attentionPoller = createPoller(() => loadAttention(), 120_000, { immediate: false });
  const clock = createPoller(() => { nowTs = Date.now(); }, 15_000, { immediate: false });
  $effect(() => {
    if (autoRefresh) { overviewPoller.start(); attentionPoller.start(); } else { overviewPoller.stop(); attentionPoller.stop(); }
  });
  $effect(() => {
    clock.start();
    return () => clock.stop();
  });

  function refreshAll() {
    void loadOverview();
    void loadAttention();
  }

  // ── Derived display values ────────────────────────────────────────────
  const scopedAgents = $derived(scopedWAFAgents(wafAgents, hostFilter));
  const scopedHosts = $derived(hostFilter ? hosts.filter((h) => h.id === hostFilter) : hosts);
  const hostScopeLabel = $derived(hostFilter ? `Host ${hostNames[hostFilter] ?? hostFilter.slice(0, 8)}` : 'All hosts');
  const firstHostId = $derived(hostFilter || hosts.find((h) => h.status === 'online')?.id || hosts[0]?.id || '');
  // Every stored action has one bucket: allow + upstream error are delivered,
  // log + monitor + challenge are recorded without a block.
  const bucketAllowed = (b: WAFEventTimelineBucket) => (b.allows ?? 0) + (b.errors ?? 0);
  const bucketLogged = (b: WAFEventTimelineBucket) => (b.monitors ?? 0) + (b.logs ?? 0) + (b.challenges ?? 0);
  const bucketTotal = (b: WAFEventTimelineBucket) => bucketAllowed(b) + (b.blocks ?? 0) + bucketLogged(b);
  const timelineMax = $derived(timeline.length ? Math.max(...timeline.map(bucketTotal), 1) : 1);
  const bucketMinutes = $derived(overviewBucketSeconds(minutes) / 60);
  const sevCounts = $derived(SEVERITIES.map((name) => ({ name, count: traceStats?.by_severity?.[name] ?? 0 })));
  const sevMax = $derived(Math.max(...sevCounts.map((s) => s.count), 1));
  const categoryTotals = $derived(
    Object.entries(traceStats?.by_category ?? {}).filter(([, v]) => (v ?? 0) > 0).sort((a, b) => b[1] - a[1]).slice(0, 5),
  );
  const topIpMax = $derived(topIps[0]?.count || 1);
  const topCatMax = $derived(topCategories[0]?.count || 1);
  const topCountryMax = $derived(topCountries[0]?.count || 1);
  const unavailableWidgets = $derived(Object.entries(widgetStatus).filter(([, v]) => v.state === 'unavailable').map(([k]) => k.replaceAll('_', ' ')));
  const stale = $derived(Boolean(generatedAt && nowTs - Date.parse(generatedAt) > 90_000));
  const summaryReady = $derived(overviewLoaded && !overviewError);
  const decisionMix = $derived(decisionMethodSplit(wafSummary));
  const methodMix = $derived(httpMethodSplit(httpMethods));

  const kpis: KpiItem[] = $derived([
    {
      label: 'Recorded requests',
      value: summaryReady && wafSummary ? formatNumber(wafSummary.requests, 'compact') : 'n/a',
      detail: wafSummary ? requestDelta(wafSummary.requests, wafSummaryPrev?.requests ?? null) : 'Request counts unavailable',
      hint: `WAF decisions stored by agents, ${rangeText}`,
    },
    {
      label: 'Blocked decisions',
      value: summaryReady && wafSummary ? formatNumber(wafSummary.blocks, 'compact') : 'n/a',
      detail:
        summaryReady && wafSummary && wafSummary.requests > 0
          ? `${formatPercent(wafSummary.block_rate, { digits: wafSummary.block_rate > 0 && wafSummary.block_rate < 0.01 ? 2 : 1 })} of requests; not confirmed attacks`
          : 'Recorded action, not confirmed attacks',
      onclick: summaryReady && wafSummary && wafSummary.blocks > 0 ? () => openDecisions({ kind: 'action', value: 'block', label: 'block' }) : undefined,
      hint: 'Open the blocked decisions of this range',
    },
    {
      label: 'Firewall drops',
      value: summaryReady && ['ok', 'empty'].includes(widgetStatus.host_fw_drops?.state ?? '') ? formatNumber(fwDrops, 'compact') : 'n/a',
      detail: 'Stored drop events',
    },
    {
      label: 'Average decision latency',
      value: summaryReady && wafSummary && wafSummary.requests > 0 ? formatDuration(wafSummary.avg_latency_us, 'us') : 'n/a',
      detail: 'Recorded mean; p99 unavailable',
    },
  ]);

  function hostStatus(status: string): StatusKind {
    if (status === 'online') return 'online';
    if (status === 'pending') return 'pending';
    if (status === 'offline') return 'offline';
    if (status === 'revoked') return 'disabled';
    return 'unknown';
  }

  function relativeOrNever(value: string | null | undefined): string {
    return value ? formatRelative(value, nowTs) : 'never';
  }

  // ── Decision explorer drawer (top-N and KPI filters) ──────────────────
  const SCAN_PAGE = 200;
  const SCAN_PAGES_PER_STEP = 5;
  let drawerFilter = $state<DecisionFilter | null>(null);
  let drawerRows = $state<DashboardLogEntry[]>([]);
  let drawerScanned = $state(0);
  let drawerTotal = $state<number | null>(null);
  let drawerLoading = $state(false);
  let drawerError = $state('');
  let drawerVersion = 0;

  function windowSeconds(): { from_ts: number; to_ts: number } {
    const end = windowEnd ? Date.parse(windowEnd) : Date.now();
    const start = windowStart ? Date.parse(windowStart) : end - minutes * 60_000;
    return { from_ts: Math.floor(start / 1000), to_ts: Math.ceil(end / 1000) };
  }

  function openDecisions(filter: DecisionFilter) {
    drawerFilter = filter;
    drawerRows = [];
    drawerScanned = 0;
    drawerTotal = null;
    drawerError = '';
    drawerVersion++;
    void scanDecisions();
  }

  function closeDecisions() {
    drawerFilter = null;
    drawerVersion++;
  }

  async function scanDecisions() {
    const filter = drawerFilter;
    if (!filter) return;
    const version = drawerVersion;
    const pid = projectId;
    const window = windowSeconds();
    drawerLoading = true;
    drawerError = '';
    if (filter.kind === 'action') {
      const res = await getDashboardLogs(pid, { ...window, action: filter.value, limit: 50, offset: drawerScanned });
      if (version !== drawerVersion) return;
      drawerLoading = false;
      if (res.error || !res.data) { drawerError = res.error?.error ?? 'Decisions could not be loaded.'; return; }
      drawerRows = [...drawerRows, ...(res.data.logs ?? [])];
      drawerScanned += (res.data.logs ?? []).length;
      drawerTotal = res.data.total;
      return;
    }
    const wanted = drawerRows.length + 50;
    for (let step = 0; step < SCAN_PAGES_PER_STEP; step++) {
      const res = await getDashboardLogs(pid, { ...window, limit: SCAN_PAGE, offset: drawerScanned });
      if (version !== drawerVersion) return;
      if (res.error || !res.data) { drawerError = res.error?.error ?? 'Decisions could not be loaded.'; break; }
      const logs = res.data.logs ?? [];
      drawerTotal = res.data.total;
      drawerScanned += logs.length;
      drawerRows = [...drawerRows, ...logs.filter((row) => matchesDecisionFilter(row, filter))];
      if (logs.length === 0 || drawerScanned >= res.data.total || drawerRows.length >= wanted) break;
    }
    drawerLoading = false;
  }

  /** Top-list filters start with blocked and monitored decisions only; this widens them to every decision. */
  function setIncludeAllowed(include: boolean) {
    if (drawerFilter) openDecisions({ ...drawerFilter, flaggedOnly: !include });
  }

  const drawerDone = $derived(drawerTotal !== null && drawerScanned >= drawerTotal);
  const drawerTitle = $derived(drawerFilter ? `Decisions: ${describeDecisionFilter(drawerFilter)}` : 'Decisions');
</script>

<div class="overview">
  <PageHeader title="Overview" subtitle="Recorded WAF and host-security activity, and what needs attention." backHref="{base}/projects" />

  <div class="toolbar" role="group" aria-label="Overview filters">
    <TimeRangePicker value={range} onchange={setRange} label="Time range for every chart and count" showLabel />
    {#if hosts.length > 1}
      <div class="host-filter">
        <label for="overview-host">Host</label>
        <Select
          id="overview-host"
          class="host-select"
          options={[{ value: '', label: 'All hosts' }, ...hosts.map((h) => ({ value: h.id, label: `${h.name} (${h.status})` }))]}
          value={hostFilter}
          onchange={(host) => setQuery({ host: host || null })}
        />
      </div>
    {/if}
    <div class="toolbar-actions">
      <label class="auto"><input type="checkbox" bind:checked={autoRefresh} /> Refresh every 30 s</label>
      <Button variant="secondary" size="sm" onclick={refreshAll} loading={overviewLoading} disabled={overviewLoading}>Refresh</Button>
    </div>
  </div>

  {#if overviewError}
    <Alert tone="error" title="Overview data failed to load" message={overviewError}>
      {#snippet actions()}<Button size="sm" variant="secondary" onclick={() => loadOverview()}>Retry</Button>{/snippet}
    </Alert>
  {/if}

  {#if showChecklist && checklist}
    <section class="setup" id="get-started" aria-labelledby="setup-title">
      <div class="setup-head">
        <div>
          <h2 id="setup-title">Get started</h2>
          <p>{checklist.complete ? 'Every setup step is done.' : `${checklist.steps.length - checklist.remaining} of ${checklist.steps.length} steps done. The list follows the project's live state and disappears when every step is done.`}</p>
          {#if project.project && !project.canConfigure}
            <p class="setup-role">Your role is read-only: a project member or owner completes these steps.</p>
          {/if}
        </div>
        {#if forceSetup}<Button variant="ghost" size="sm" onclick={() => setQuery({ setup: null })}>Hide checklist</Button>{/if}
      </div>
      <ol class="steps">
        {#each checklist.steps as step, i (step.id)}
          <li class="step" class:done={step.done === true} class:current={nextStep?.id === step.id}>
            <span class="step-mark" aria-hidden="true">{step.done === true ? '✓' : i + 1}</span>
            <div class="step-body">
              <p class="step-title">{step.title} <span class="step-state">{step.done === true ? 'Done' : step.done === null ? 'Unknown: status could not be read' : step.waitingFor ? `Waiting for ${step.waitingFor}` : 'To do'}</span></p>
              {#if step.done !== true}
                <p class="step-desc">{step.description}</p>
                {#if step.action}<a class="step-link" href={step.action.href}>{step.action.label}</a>{/if}
              {/if}
              {#if step.id === 'credential' && setup?.credentials && !setup.agentsSeen}
                <div class="install">
                  <div class="install-head">
                    <p>Install command for credential <strong>{setup.credentialName ?? 'agent'}</strong></p>
                    <label class="sr-only" for="overview-install-kind">Agent type</label>
                    <Select id="overview-install-kind" size="sm" options={INSTALL_KINDS} bind:value={installKind} />
                    <Button size="sm" variant="secondary" onclick={copyCommand}>{copied ? 'Copied' : 'Copy'}</Button>
                  </div>
                  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
                  <pre class="command" tabindex="0" aria-label="Install command"><code>{command}</code></pre>
                  <p class="install-note">Run it in the unpacked agent release, next to the bundle you downloaded when the credential was issued. The private key is shown only once: if the bundle is lost, issue a new credential. The installer also asks for the control plane address.</p>
                </div>
              {/if}
            </div>
          </li>
        {/each}
      </ol>
    </section>
  {:else if setupLoading && !setup}
    <p class="muted" role="status">Checking project setup…</p>
  {/if}

  <KpiStrip items={kpis} label={`Recorded activity, ${rangeText}`} loading={overviewLoading && !overviewLoaded} />

  <OverviewEvidence
    groups={attentionGroups}
    {evidence}
    loading={attentionLoading}
    error={attentionError}
    notices={attentionNotices}
    scopeLabel={hostScopeLabel}
    onrefresh={() => loadAttention()}
  />

  {#if unavailableWidgets.length}
    <Alert tone="warning" compact message={`Unavailable: ${unavailableWidgets.join(', ')}. Missing values are not zero.`} />
  {/if}
  {#if stale}
    <Alert tone="warning" compact message="This snapshot is more than 90 seconds old. Refresh to check current agent availability." />
  {/if}

  {#if overviewLoading && !overviewLoaded}
    <p class="muted" role="status">Loading activity…</p>
  {:else if !overviewError}
    <div class="row2">
      <section class="panel" aria-labelledby="activity-title">
        <div class="panel-head">
          <h2 id="activity-title">Request activity</h2>
          <ul class="legend" aria-label="Legend">
            <li><i style="background:var(--allow)"></i>Allow</li>
            <li><i style="background:var(--block)"></i>Block</li>
            <li><i style="background:var(--log)"></i>Log, monitor, challenge</li>
          </ul>
        </div>
        {#if timeline.length > 0}
          {@const gap = timeline.length > 200 ? 1 : 2}
          <p class="chart-scale">Decisions per {bucketMinutes} min · peak {formatNumber(timelineMax)}</p>
          <div class="timeline" style="gap:{gap}px" role="img" aria-label={`Recorded WAF decisions, ${rangeText}; peak ${timelineMax} per ${bucketMinutes}-minute bucket. Bucket values are listed below the chart.`}>
            {#each timeline as bucket (bucket.bucket_start)}
              {@const total = bucketTotal(bucket)}
              <div class="bar-wrap" title={`${formatDateTime(bucket.bucket_start)}: ${total} decisions (${bucketAllowed(bucket)} allow, ${bucket.blocks ?? 0} block, ${bucket.logs ?? 0} log, ${bucket.monitors ?? 0} monitor, ${bucket.challenges ?? 0} challenge)`}>
                <div class="bar" style="height:{total > 0 ? Math.max((total / timelineMax) * 100, 3) : 0}%">
                  {#if bucket.blocks}<div class="seg" style="flex:{bucket.blocks};background:var(--block)"></div>{/if}
                  {#if bucketLogged(bucket)}<div class="seg" style="flex:{bucketLogged(bucket)};background:var(--log)"></div>{/if}
                  {#if bucketAllowed(bucket)}<div class="seg" style="flex:{bucketAllowed(bucket)};background:var(--allow)"></div>{/if}
                </div>
              </div>
            {/each}
          </div>
          <div class="axis"><span><DateTime value={timeline[0].bucket_start} /></span><span><DateTime value={timeline[timeline.length - 1].bucket_start} /></span></div>
          <details class="chart-data"><summary>Bucket values</summary>
            <ul>{#each timeline as bucket (bucket.bucket_start)}<li><DateTime value={bucket.bucket_start} /> · allow {bucketAllowed(bucket)}, block {bucket.blocks ?? 0}, log {bucket.logs ?? 0}, monitor {bucket.monitors ?? 0}, challenge {bucket.challenges ?? 0}</li>{/each}</ul>
          </details>
        {:else}
          <p class="panel-empty">No WAF decisions recorded in the {rangeText}.</p>
        {/if}
      </section>

      <section class="panel" aria-labelledby="runtime-title">
        <div class="panel-head">
          <h2 id="runtime-title">Runtime events by severity</h2>
          <a class="panel-link" href="{root}/host/trace{firstHostId ? `?host=${firstHostId}` : ''}">Open runtime security</a>
        </div>
        {#if traceStats}
          <ul class="sev-chart">
            {#each sevCounts as s (s.name)}
              <li>
                <span class="sev-label"><Badge tone={severityTone(s.name)}>{s.name}</Badge></span>
                <span class="track" aria-hidden="true"><span class="fill" style="width:{Math.max((s.count / sevMax) * 100, s.count > 0 ? 2 : 0)}%;background:{severityColor(s.name)}"></span></span>
                <span class="num">{formatNumber(s.count, 'compact')}</span>
              </li>
            {/each}
          </ul>
          <p class="panel-foot">Total {formatNumber(traceStats.total_events ?? 0)} events{traceRunning > 0 ? ` · ${traceRunning} tracing ${traceRunning === 1 ? 'agent' : 'agents'} online` : ''}</p>
          {#if categoryTotals.length}
            <p class="cats">{#each categoryTotals as [cat, count] (cat)}<span>{cat.replaceAll('_', ' ')}: {formatNumber(count, 'compact')}</span>{/each}</p>
          {/if}
        {:else}
          <p class="panel-empty">No runtime security data for this scope.</p>
        {/if}
      </section>
    </div>

    <DetectionQuality
      projectId={projectId}
      {range}
      reloadToken={fpToken}
      scopeNote={hostFilter ? 'Assessments are not split by host: this panel covers every host.' : ''}
      {reviewHref}
    />

    <div class="row2">
      <section class="panel" aria-labelledby="mix-title">
        <div class="panel-head">
          <div>
            <h2 id="mix-title">How decisions were made</h2>
            <p class="panel-sub">Stored decisions by analysis method, including allowed traffic, {rangeText}.</p>
          </div>
        </div>
        {#if !wafSummary}
          <p class="panel-empty">Decision counts are unavailable.</p>
        {:else if decisionMix.total === 0}
          <p class="panel-empty">No analysis results in the {rangeText}.</p>
        {:else}
          <div class="panel-body"><ShareBars items={decisionMix.items} label="Decisions by analysis method" /></div>
        {/if}
      </section>

      <section class="panel" aria-labelledby="http-methods-title">
        <div class="panel-head">
          <div>
            <h2 id="http-methods-title">HTTP methods</h2>
            <p class="panel-sub">Stored decisions by request method, {rangeText}{hostFilter ? '; every host (no host split)' : ''}.</p>
          </div>
        </div>
        {#if httpMethodsError}
          <InlineError message={httpMethodsError} onretry={() => void loadMethods()} />
        {:else if httpMethods === null}
          <p class="panel-empty" role="status">Loading…</p>
        {:else if methodMix.total === 0}
          <p class="panel-empty">No WAF decisions recorded in the {rangeText}.</p>
        {:else}
          <div class="panel-body"><ShareBars items={methodMix.items} label="Decisions by HTTP method" /></div>
        {/if}
      </section>
    </div>

    <div class="row3">
      <section class="panel" aria-labelledby="ips-title">
        <div class="panel-head"><h2 id="ips-title">Top blocked or monitored IPs</h2></div>
        {#if topIps.length}
          <ol class="top-list">
            {#each topIps as row (row.label)}
              <li>
                <button type="button" class="top-row" onclick={() => openDecisions({ kind: 'ip', value: row.label, label: row.label, flaggedOnly: true })} aria-label={`Show blocked and monitored decisions from ${row.label}, ${row.count}`}>
                  <code class="top-label">{row.label}</code>
                  <span class="track" aria-hidden="true"><span class="fill" style="width:{Math.max((row.count / topIpMax) * 100, 2)}%"></span></span>
                  <span class="num">{formatNumber(row.count, 'compact')}</span>
                </button>
              </li>
            {/each}
          </ol>
        {:else}
          <p class="panel-empty">No blocked or monitored clients in the {rangeText}.</p>
        {/if}
      </section>

      <section class="panel" aria-labelledby="cats-title">
        <div class="panel-head"><h2 id="cats-title">Matched categories</h2></div>
        {#if topCategories.length}
          <ol class="top-list">
            {#each topCategories as row (row.label)}
              <li>
                <button type="button" class="top-row" onclick={() => openDecisions({ kind: 'category', value: row.label, label: row.label, flaggedOnly: true })} aria-label={`Show blocked and monitored decisions matching ${row.label}, ${row.count}`}>
                  <span class="top-label">{row.label}</span>
                  <span class="track" aria-hidden="true"><span class="fill" style="width:{Math.max((row.count / topCatMax) * 100, 2)}%"></span></span>
                  <span class="num">{formatNumber(row.count, 'compact')}</span>
                </button>
              </li>
            {/each}
          </ol>
        {:else}
          <p class="panel-empty">No matched categories in the {rangeText}.</p>
        {/if}
      </section>

      <section class="panel" aria-labelledby="countries-title">
        <div class="panel-head"><h2 id="countries-title">Countries of the top 50 clients</h2></div>
        {#if topCountries.length}
          <ol class="top-list">
            {#each topCountries as row (row.code || row.label)}
              {@const name = formatCountryName(row.label, row.code)}
              <li>
                <button type="button" class="top-row" disabled={!row.code} onclick={() => openDecisions({ kind: 'country', value: row.code, label: name, flaggedOnly: true })} aria-label={`Show blocked and monitored decisions from ${name}, ${row.count}`}>
                  <span class="top-label">{name}</span>
                  <span class="track" aria-hidden="true"><span class="fill" style="width:{Math.max((row.count / topCountryMax) * 100, 2)}%"></span></span>
                  <span class="num">{formatNumber(row.count, 'compact')}</span>
                </button>
              </li>
            {/each}
          </ol>
        {:else}
          <p class="panel-empty">No country data for blocked or monitored clients in the {rangeText}.</p>
        {/if}
      </section>
    </div>

    <div class="row2">
      <section class="panel" aria-labelledby="hosts-title">
        <div class="panel-head">
          <h2 id="hosts-title">Hosts <span class="count">{scopedHosts.length}</span></h2>
          <a class="panel-link" href="{root}/hosts">Open hosts</a>
        </div>
        {#if scopedHosts.length}
          <ul class="entity-list">
            {#each scopedHosts as h (h.id)}
              <li>
                <a href="{root}/hosts/{h.id}">
                  <StatusDot status={hostStatus(h.status)} hideLabel />
                  <span class="entity-name">{h.name || h.id.slice(0, 12)}</span>
                  <span class="entity-meta">{h.status} · last seen <time datetime={h.last_seen ?? ''} title={formatDateTime(h.last_seen, { seconds: true, fallback: 'never' })}>{relativeOrNever(h.last_seen)}</time></span>
                  {#if h.labels && Object.keys(h.labels).length}
                    <span class="entity-labels">{Object.entries(h.labels).slice(0, 3).map(([k, v]) => `${k}=${v}`).join(' · ')}</span>
                  {/if}
                </a>
              </li>
            {/each}
          </ul>
        {:else}
          <EmptyState compact title="No hosts registered" message="Register a host to collect firewall and runtime data." level={3}>
            {#snippet action()}<Button size="sm" variant="secondary" href="{root}/hosts">Register a host</Button>{/snippet}
          </EmptyState>
        {/if}
      </section>

      <section class="panel" aria-labelledby="agents-title">
        <div class="panel-head">
          <h2 id="agents-title">WAF agents <span class="count">{scopedAgents.length}</span></h2>
          <a class="panel-link" href="{root}/waf">Open WAF agents</a>
        </div>
        {#if scopedAgents.length}
          <ul class="entity-list">
            {#each scopedAgents as a (a.id)}
              <li>
                <a href="{root}/waf/{a.id}">
                  <StatusDot status={a.is_online ? 'online' : 'offline'} hideLabel />
                  <span class="entity-name">{a.name}</span>
                  <span class="entity-meta">{a.is_online ? 'online' : 'offline'} · last seen <time datetime={a.last_seen ?? ''} title={formatDateTime(a.last_seen, { seconds: true, fallback: 'never' })}>{relativeOrNever(a.last_seen)}</time></span>
                </a>
              </li>
            {/each}
          </ul>
        {:else}
          <EmptyState compact title="No WAF agents registered" message={project.canConfigure ? 'Register a WAF agent to inspect HTTP traffic.' : 'A project member or owner can register a WAF agent.'} level={3}>
            {#snippet action()}<Button size="sm" variant="secondary" href="{root}/waf">Open WAF agents</Button>{/snippet}
          </EmptyState>
        {/if}
      </section>
    </div>

    <div class="row2">
      <section class="panel" aria-labelledby="fw-title">
        <div class="panel-head">
          <h2 id="fw-title">Latest firewall events</h2>
          <a class="panel-link" href="{root}/host/firewall{firstHostId ? `?host=${firstHostId}` : ''}">Open firewall</a>
        </div>
        {#if firewallEvents.length}
          <ul class="event-list">
            {#each firewallEvents as ev, i (`${ev.timestamp}-${ev.src_ip}-${i}`)}
              <li>
                <Badge tone={actionTone(ev.action)}>{ev.action ?? 'unknown'}</Badge>
                <code>{ev.src_ip}</code>
                <span class="entity-meta">{ev.proto ?? ''}{ev.dst_port ? `:${ev.dst_port}` : ''}{ev.reason ? ` · ${ev.reason}` : ''}</span>
                <span class="entity-meta end"><DateTime value={ev.timestamp} seconds /></span>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="panel-empty">No firewall events stored for this scope.</p>
        {/if}
      </section>

      <section class="panel" aria-labelledby="rt-title">
        <div class="panel-head">
          <h2 id="rt-title">Latest high-severity runtime events</h2>
          <a class="panel-link" href="{root}/host/trace{firstHostId ? `?host=${firstHostId}` : ''}">Open runtime security</a>
        </div>
        {#if runtimeEvents.length}
          <Table columns={['Severity', 'Event', 'Process', 'Target', 'Action', 'Time']} label="Latest high-severity runtime events">
            {#each runtimeEvents as evt, i (`${evt.timestamp}-${evt.pid}-${i}`)}
              <tr>
                <td><Badge tone={severityTone(evt.severity_name)}>{evt.severity_name}</Badge></td>
                <td>{evt.event_name}</td>
                <td><code>{evt.comm}</code> <span class="entity-meta">pid {evt.pid}</span></td>
                <td><code class="clip" title={evt.filename ?? evt.addr ?? ''}>{evt.filename ?? evt.addr ?? 'n/a'}</code></td>
                <td>{#if evt.action_name}<Badge tone={enforcementTone(evt.action_name)}>{evt.action_name}</Badge>{:else}n/a{/if}</td>
                <td class="nowrap"><DateTime value={evt.timestamp} seconds /></td>
              </tr>
            {/each}
          </Table>
        {:else}
          <p class="panel-empty">No high or critical runtime events were returned. This does not establish that there were none.</p>
        {/if}
      </section>
    </div>

    <details class="provenance">
      <summary>About this data</summary>
      <div class="provenance-body">
        <dl>
          <dt>Time range</dt><dd>{timeRangeLabel(range)}: <DateTime value={windowStart} seconds /> to <DateTime value={windowEnd} seconds /></dd>
          <dt>Snapshot</dt><dd><DateTime value={generatedAt} seconds relative now={nowTs} /></dd>
          <dt>Scope</dt><dd>{hostScopeLabel}</dd>
          <dt>Windowed</dt><dd>Request counts, the activity chart, top lists, firewall drops and runtime events by severity.</dd>
          <dt>Latest rows</dt><dd>Firewall events and high-severity runtime events are the 8 most recent rows, not limited to the range.</dd>
          <dt>Current state</dt><dd>Needs attention, hosts and WAF agents show the state now.</dd>
        </dl>
        <p>Counts are what agents stored; telemetry can be sampled or incomplete, and every source has its own observation time. Top lists count blocked and monitored decisions only.</p>
        {#if Object.keys(widgetStatus).length}
          <p class="widget-states">{#each Object.entries(widgetStatus) as [name, value] (name)}<span>{name.replaceAll('_', ' ')}: {value.state}{value.message ? ` (${value.message})` : ''}</span>{/each}</p>
        {/if}
      </div>
    </details>

    {#if checklist?.complete && !forceSetup}
      <p class="setup-done"><a href={setupHref}>Show the Get started checklist</a> · every setup step is done.</p>
    {/if}
  {/if}
</div>

<Drawer open={drawerFilter !== null} title={drawerTitle} onclose={closeDecisions} size="xl">
  {#if drawerFilter}
    <p class="drawer-scope">{timeRangeLabel(range)} · <DateTime value={windowStart} /> to <DateTime value={windowEnd} />{hostFilter ? ' · every host (the host filter does not apply to this list)' : ''}</p>
    {#if drawerFilter.kind !== 'action'}
      <label class="drawer-toggle">
        <input type="checkbox" checked={!drawerFilter.flaggedOnly} onchange={(event) => setIncludeAllowed(event.currentTarget.checked)} />
        Include allowed requests <span class="entity-meta">(the top lists count blocked and monitored decisions only)</span>
      </label>
    {/if}
    {#if drawerFilter.kind === 'ip'}
      <p class="drawer-actions"><a href="{root}/host/firewall{firstHostId ? `?host=${firstHostId}&` : '?'}tab=blocklist&ip={encodeURIComponent(drawerFilter.value)}">Block this IP on the host firewall</a></p>
    {/if}
    {#if drawerError}<Alert tone="error" compact message={drawerError} />{/if}
    {#if drawerRows.length}
      <Table columns={['Time', 'Action', 'Request', 'Client', 'Categories', 'Strength']} label={drawerTitle}>
        {#each drawerRows as row (row.id)}
          <tr>
            <td class="nowrap"><DateTime value={row.ts} seconds epochUnit="s" /></td>
            <td><Badge tone={actionTone(row.action)}>{row.action === 'log' ? 'monitor' : row.action}</Badge></td>
            <td><code class="clip wide" title={`${row.method ?? ''} ${row.host ?? ''}${row.uri ?? ''}`}>{row.method} {row.host}{row.uri}</code></td>
            <td><code>{row.remote_addr}</code>{#if row.country_code} <span class="entity-meta"><span aria-hidden="true">{countryFlag(row.country_code)}</span> {row.country_code}</span>{/if}</td>
            <td>{row.categories || 'n/a'}</td>
            <td>{#if row.strength}<Badge tone={strengthTone(row.strength)}>{strengthLabel(row.strength)}</Badge>{:else}n/a{/if}</td>
          </tr>
        {/each}
      </Table>
    {:else if !drawerLoading && !drawerError}
      <p class="panel-empty">{drawerDone ? 'No matching decisions in this range.' : 'No matches yet in the decisions scanned so far.'}</p>
    {/if}
    {#if drawerLoading}<p class="muted" role="status">Loading decisions…</p>{/if}
    <p class="drawer-foot" aria-live="polite">
      {#if drawerFilter.kind === 'action'}
        {drawerRows.length} of {drawerTotal ?? '…'} decisions shown.
      {:else}
        {drawerRows.length} matching {drawerFilter.flaggedOnly ? 'blocked or monitored ' : ''}{drawerRows.length === 1 ? 'decision' : 'decisions'} among the {formatNumber(drawerScanned)} most recent of {drawerTotal === null ? '…' : formatNumber(drawerTotal)} in this range.
      {/if}
    </p>
  {/if}
  {#snippet footer()}
    {#if drawerFilter && !drawerDone}
      <Button variant="secondary" onclick={() => scanDecisions()} loading={drawerLoading} disabled={drawerLoading}>{drawerFilter.kind === 'action' ? 'Load more' : 'Search further back'}</Button>
    {/if}
    <Button variant="ghost" onclick={closeDecisions}>Close</Button>
  {/snippet}
</Drawer>

<style>
  .overview { min-width: 0; width: 100%; padding: var(--page-top) var(--page-gutter) var(--sp-7); display: grid; gap: var(--sp-5); }
  .overview > :global(*) { min-width: 0; }
  .toolbar { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--sp-4); }
  .host-filter { display: grid; gap: var(--sp-1); font-size: var(--fs-xs); color: var(--text-secondary); }
  .host-filter :global(.host-select) { max-width: min(100%, 24rem); }
  .toolbar-actions { margin-left: auto; display: flex; align-items: center; gap: var(--sp-3); flex-wrap: wrap; }
  .auto { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm); color: var(--text-secondary); }
  .muted { color: var(--text-muted); font-size: var(--fs-sm); margin: 0; }

  .setup { border: 1px solid var(--border); border-left: 3px solid var(--accent); border-radius: var(--radius-lg); background: var(--bg-card); padding: var(--sp-4) var(--sp-5); }
  .setup-head { display: flex; justify-content: space-between; gap: var(--sp-4); align-items: flex-start; }
  .setup h2 { margin: 0 0 var(--sp-1); font-size: var(--fs-md); font-weight: var(--fw-semibold); }
  .setup-head p { margin: 0; font-size: var(--fs-sm); color: var(--text-secondary); }
  .setup-head .setup-role { margin-top: var(--sp-1); color: var(--text-muted); font-size: var(--fs-xs); }
  .steps { list-style: none; margin: var(--sp-4) 0 0; padding: 0; display: grid; gap: var(--sp-1); }
  .step { display: grid; grid-template-columns: 1.75rem minmax(0, 1fr); gap: var(--sp-3); padding: var(--sp-3) 0; border-top: 1px solid var(--border); }
  .step-mark {
    width: 1.75rem;
    height: 1.75rem;
    display: grid;
    place-items: center;
    border-radius: 50%;
    border: 1px solid var(--border-strong);
    font-size: var(--fs-xs);
    color: var(--text-secondary);
  }
  .step.done .step-mark { background: var(--success-tint); border-color: var(--success); color: var(--success); }
  .step.current .step-mark { border-color: var(--accent); color: var(--accent-dim); }
  .step-body { min-width: 0; }
  .step-title { margin: 0; font-weight: var(--fw-medium); display: flex; flex-wrap: wrap; gap: var(--sp-2); align-items: baseline; }
  .step.done .step-title { color: var(--text-secondary); font-weight: 400; }
  .step-state { font-size: var(--fs-xs); color: var(--text-muted); font-weight: 400; }
  .step-desc { margin: var(--sp-1) 0 var(--sp-2); font-size: var(--fs-sm); color: var(--text-secondary); line-height: 1.55; max-width: 76ch; }
  .step-link { font-size: var(--fs-sm); color: var(--accent-dim); }
  .install { margin-top: var(--sp-3); border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-tertiary); padding: var(--sp-3); }
  .install-head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); }
  .install-head p { margin: 0 auto 0 0; font-size: var(--fs-sm); color: var(--text-secondary); }
  .command { margin: var(--sp-2) 0; padding: var(--sp-3); background: var(--bg-code); border: 1px solid var(--border); border-radius: var(--radius); overflow-x: auto; font-size: var(--fs-xs); line-height: 1.6; }
  .install-note { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }

  .row2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--sp-5); }
  .row3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--sp-5); }
  .panel { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-lg); min-width: 0; overflow: hidden; }
  .panel-head { padding: var(--sp-4) var(--sp-5); display: flex; justify-content: space-between; align-items: center; gap: var(--sp-3); flex-wrap: wrap; }
  .panel-head h2 { margin: 0; font-size: var(--fs-base); font-weight: var(--fw-semibold); }
  .panel-sub { margin: var(--sp-1) 0 0; font-size: var(--fs-xs); color: var(--text-muted); }
  .panel-body { padding: 0 var(--sp-5) var(--sp-4); }
  .count { font-size: var(--fs-xs); font-weight: 400; color: var(--text-muted); margin-left: var(--sp-1); }
  .panel-link { font-size: var(--fs-sm); color: var(--accent-dim); }
  .panel-empty { padding: var(--sp-5); margin: 0; color: var(--text-muted); font-size: var(--fs-sm); text-align: center; }
  .panel-foot { margin: 0; padding: var(--sp-3) var(--sp-5); border-top: 1px solid var(--border); font-size: var(--fs-xs); color: var(--text-muted); }
  .legend { list-style: none; margin: 0; padding: 0; display: flex; gap: var(--sp-3); font-size: var(--fs-xs); color: var(--text-secondary); }
  .legend li { display: flex; align-items: center; gap: var(--sp-1); }
  .legend i { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }
  .chart-scale { margin: 0 var(--sp-5) var(--sp-2); font-size: var(--fs-xs); color: var(--text-muted); }
  .timeline {
    height: 180px;
    display: flex;
    align-items: flex-end;
    margin: 0 var(--sp-5);
    border-bottom: 1px solid var(--border);
    background: repeating-linear-gradient(to top, transparent 0, transparent 44px, var(--chart-grid) 45px);
  }
  .bar-wrap { height: 100%; flex: 1; display: flex; align-items: flex-end; min-width: 0; }
  .bar { display: flex; flex-direction: column; width: 100%; }
  .seg { min-height: 1px; }
  .axis { display: flex; justify-content: space-between; gap: var(--sp-2); flex-wrap: wrap; margin: var(--sp-1) var(--sp-5) 0; font-size: var(--fs-xs); color: var(--text-muted); }
  .chart-data { margin: var(--sp-2) var(--sp-5) var(--sp-4); font-size: var(--fs-xs); color: var(--text-muted); }
  .chart-data summary { cursor: pointer; }
  .chart-data ul { list-style: none; margin: var(--sp-2) 0 0; padding: 0; max-height: 12rem; overflow: auto; }
  .sev-chart { list-style: none; margin: 0; padding: 0 var(--sp-5) var(--sp-3); display: grid; gap: var(--sp-3); }
  .sev-chart li { display: grid; grid-template-columns: 6rem minmax(0, 1fr) 3.5rem; align-items: center; gap: var(--sp-3); font-size: var(--fs-sm); }
  .track { height: 6px; background: var(--bg-hover); border-radius: 3px; overflow: hidden; display: block; }
  .fill { display: block; height: 100%; background: var(--chart-neutral); border-radius: 3px; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .cats { display: flex; flex-wrap: wrap; gap: var(--sp-2); margin: 0; padding: 0 var(--sp-5) var(--sp-4); font-size: var(--fs-xs); color: var(--text-secondary); }
  .cats span { border: 1px solid var(--border); border-radius: var(--radius); padding: 2px var(--sp-2); }
  .top-list { list-style: none; margin: 0; padding: 0 0 var(--sp-2); }
  .top-row {
    width: 100%;
    display: grid;
    grid-template-columns: minmax(0, 2fr) minmax(0, 2fr) 3.5rem;
    align-items: center;
    gap: var(--sp-3);
    padding: var(--sp-2) var(--sp-5);
    border: 0;
    border-top: 1px solid var(--border);
    background: transparent;
    color: var(--text-primary);
    font-size: var(--fs-sm);
    text-align: left;
    cursor: pointer;
  }
  .top-row:hover:not(:disabled) { background: var(--bg-hover); }
  .top-row:disabled { cursor: default; }
  .top-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: flex; align-items: center; gap: var(--sp-2); }
  .entity-list, .event-list { list-style: none; margin: 0; padding: 0; }
  .entity-list a { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: var(--sp-3); padding: var(--sp-3) var(--sp-5); border-top: 1px solid var(--border); color: var(--text-primary); text-decoration: none; font-size: var(--fs-sm); }
  .entity-list a:hover { background: var(--bg-hover); }
  .entity-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .entity-meta { font-size: var(--fs-xs); color: var(--text-muted); }
  .entity-labels { grid-column: 2 / -1; font-size: var(--fs-xs); color: var(--text-muted); font-family: var(--font-mono); overflow-wrap: anywhere; }
  .event-list li { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2) var(--sp-3); padding: var(--sp-3) var(--sp-5); border-top: 1px solid var(--border); font-size: var(--fs-sm); }
  .end { margin-left: auto; }
  .clip { display: inline-block; max-width: 16rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; }
  .clip.wide { max-width: 22rem; }
  .nowrap { white-space: nowrap; }
  .provenance { border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-card); }
  .provenance summary { padding: var(--sp-3) var(--sp-5); cursor: pointer; font-size: var(--fs-sm); color: var(--text-secondary); }
  .provenance-body { padding: 0 var(--sp-5) var(--sp-4); font-size: var(--fs-xs); color: var(--text-muted); }
  .provenance-body dl { display: grid; grid-template-columns: minmax(6rem, 1fr) minmax(0, 4fr); gap: var(--sp-1) var(--sp-3); margin: 0 0 var(--sp-3); }
  .provenance-body dt { color: var(--text-secondary); }
  .provenance-body dd { margin: 0; overflow-wrap: anywhere; }
  .provenance-body p { margin: 0 0 var(--sp-2); line-height: 1.6; }
  .widget-states { display: flex; flex-wrap: wrap; gap: var(--sp-1) var(--sp-3); }
  .setup-done { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
  .setup-done a { color: var(--accent-dim); }
  .drawer-scope, .drawer-actions, .drawer-foot { margin: 0 0 var(--sp-3); font-size: var(--fs-sm); color: var(--text-secondary); }
  .drawer-actions a { color: var(--accent-dim); }
  .drawer-toggle { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); margin: 0 0 var(--sp-3); font-size: var(--fs-sm); color: var(--text-secondary); }
  .drawer-foot { margin-top: var(--sp-3); color: var(--text-muted); font-size: var(--fs-xs); }
  @media (max-width: 1100px) {
    .row3 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .row3 > :last-child { grid-column: 1 / -1; }
  }
  @media (max-width: 760px) {
    .row2, .row3 { grid-template-columns: minmax(0, 1fr); }
    .row3 > :last-child { grid-column: auto; }
    .toolbar-actions { margin-left: 0; }
    .panel-head { padding: var(--sp-4); }
    .setup { padding: var(--sp-4); }
    .entity-list a { grid-template-columns: auto minmax(0, 1fr); }
    .entity-list a .entity-meta { grid-column: 2; }
    .provenance-body dl { grid-template-columns: minmax(0, 1fr); }
  }
</style>
