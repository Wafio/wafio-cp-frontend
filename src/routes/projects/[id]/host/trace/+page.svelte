<!--
  Runtime security. One host at a time, four URL tabs:

    Triage  , incident groups (host × tactic × process), bulk actions,
               suppress-from-incident, then the activity of the time range
    Explore , runtime events and enforcement actions: facets, paging,
               keyed rows, detail drawer
    Policies: Enforcement, Detection, Correlations, Templates
    Agent   , status, capture health, trace configuration

  Every per-host field lives behind a HostScope: switching hosts resets it,
  bumps the epoch (stale responses are dropped) and stops the stream and
  timers, so nothing from host A can be saved onto host B.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { base } from '#lib/paths.js';
  import {
    getHost,
    getTraceEventTypes,
    getTraceStats,
    getTraceStatus,
    listIncidents,
    type DetectionRule,
    type EnforcementLogEntry,
    type EnforcementPolicy,
    type TraceEvent,
    type TraceEventTypeInfo,
    type TraceStats,
    type TraceStatus,
  } from '#lib/api.js';
  import { formatDateTime, formatNumber } from '#lib/format.js';
  import { traceLossNotice } from '#lib/trace-status.js';
  import { createHostScope, createLifecycle } from '#lib/host-scope.svelte.js';
  import { getProjectContext } from '#lib/project-context.svelte.js';
  import { usePageTitle } from '#lib/page-meta.svelte.js';
  import { createSSEConnection, type SSEConnectionState, type SSEFatalError } from '#lib/sse.js';
  import HostPicker from '#lib/components/HostPicker.svelte';
  import HostSwitcher from '#lib/components/HostSwitcher.svelte';
  import { writeLastHost } from '#lib/host-nav.js';
  import Alert from '#lib/components/ui/Alert.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import EmptyState from '#lib/components/ui/EmptyState.svelte';
  import PageHeader from '#lib/components/ui/PageHeader.svelte';
  import Spinner from '#lib/components/ui/Spinner.svelte';
  import StatusDot from '#lib/components/ui/StatusDot.svelte';
  import Tabs from '#lib/components/ui/Tabs.svelte';
  import TimeRangePicker from '#lib/components/ui/TimeRangePicker.svelte';
  import type { TimeRangeKey } from '#lib/components/ui/time-range.js';
  import type { TabItem } from '#lib/components/ui/types.js';
  import { tabDomIds } from '#lib/components/ui/tabs.js';
  import AgentView from '#lib/components/runtime/AgentView.svelte';
  import DetectionRuleEditor from '#lib/components/runtime/DetectionRuleEditor.svelte';
  import ExploreView from '#lib/components/runtime/ExploreView.svelte';
  import PoliciesView from '#lib/components/runtime/PoliciesView.svelte';
  import PolicyEditor from '#lib/components/runtime/PolicyEditor.svelte';
  import TriageView from '#lib/components/runtime/TriageView.svelte';
  import { LiveBuffer } from '#lib/components/runtime/live.svelte.js';
  import { enforcementEntryKey, timeOf, traceEventKey } from '#lib/components/runtime/explore.js';
  import type { DetectionRuleDraft } from '#lib/components/runtime/detection.js';
  import { draftFromEvent, type PolicyDraft } from '#lib/components/runtime/policy.js';
  import type { SuppressionPrefill } from '#lib/components/runtime/triage.js';
  import {
    RUNTIME_TABS,
    exploreSearch,
    readRuntimeUrl,
    runtimeSearch,
    type PolicySection,
    type RuntimeTab,
    type RuntimeUrlPatch,
  } from '#lib/components/runtime/url.js';

  type Stats = Partial<TraceStats> & { severity_window_range?: string };

  const project = getProjectContext();
  const projectId = $derived(page.params.id ?? '');
  const hostId = $derived(page.url.searchParams.get('host') ?? '');
  const isEmbed = $derived(page.url.searchParams.get('embed') === '1');
  const url = $derived(readRuntimeUrl(page.url.searchParams));
  const canConfigure = $derived(project.canConfigure);
  const canManage = $derived(project.canManage);

  const scope = createHostScope();
  /** The live stream; reset on host change, range change and when Live is turned off. */
  const stream = createLifecycle();

  let loading = $state(false);
  let initError = $state<string | null>(null);
  let status = $state<TraceStatus | null>(null);
  let statusError = $state<string | null>(null);
  let stats = $state<Stats | null>(null);
  let eventTypes = $state.raw<TraceEventTypeInfo[]>([]);
  let hostName = $state('');
  let openIncidents = $state<number | null>(null);

  let live = $state(true);
  let sseState = $state<SSEConnectionState>('closed');
  /** 429 STREAM_LIMIT: the stream retries every 30 s; polling covers the gap. */
  let sseLimited = $state(false);
  let sseFatal = $state<SSEFatalError | null>(null);
  let streamKey = '';
  let enforcementClearedAt = $state<string | null>(null);

  const liveTrace = new LiveBuffer<TraceEvent>(traceEventKey, (e) => e.timestamp);
  const liveEnforcement = new LiveBuffer<EnforcementLogEntry>(enforcementEntryKey, (e) => e.timestamp);

  // Page-level editors, opened from any tab.
  let policyEditor = $state<{ policy: EnforcementPolicy | null; prefill: PolicyDraft | null } | null>(null);
  let ruleEditor = $state<{
    hostId: string;
    hostLabel: string;
    rule: DetectionRule | null;
    prefill: { draft: DetectionRuleDraft; warning?: string; context?: string } | null;
    onsaved?: () => void;
  } | null>(null);
  let policiesVersion = $state(0);
  let rulesVersion = $state(0);

  scope.onReset(() => {
    loading = false;
    stream.reset();
    streamKey = '';
    sseState = 'closed';
    sseFatal = null;
    status = null;
    statusError = null;
    initError = null;
    stats = null;
    eventTypes = [];
    hostName = '';
    openIncidents = null;
    enforcementClearedAt = null;
    liveTrace.clear();
    liveEnforcement.clear();
    liveEnforcement.setAccept(() => true);
    policyEditor = null;
    ruleEditor = null;
  });

  $effect(() => {
    const p = projectId;
    const h = hostId;
    untrack(() => {
      if (scope.setScope(p, h) && h) void init();
    });
  });

  async function init() {
    const epoch = scope.epoch;
    loading = true;
    initError = null;
    const [agentId, host] = await Promise.all([scope.resolveAgent(), getHost(projectId, scope.hostId)]);
    if (scope.isStale(epoch)) return;
    hostName = host.data?.host?.name || scope.agent?.hostname || scope.agent?.host_info?.hostname || '';
    if (host.data?.host && host.data.host.status !== 'revoked') writeLastHost(projectId, scope.hostId);
    if (host.error && host.error.status === 404) {
      loading = false;
      initError = 'This host does not exist in the project any more.';
      return;
    }
    if (!agentId) {
      loading = false;
      return;
    }
    await Promise.all([loadStatus(epoch), loadStats(epoch), loadEventTypes(epoch), loadOpenCount(epoch)]);
    if (scope.isStale(epoch)) return;
    loading = false;
    // Status and statistics by polling only while the stream does not deliver them.
    scope.poll(() => (sseState === 'open' ? undefined : Promise.all([loadStatus(epoch), loadStats(epoch)])), 15_000, { epoch, immediate: false });
    syncStream();
  }

  async function loadStatus(epoch = scope.epoch) {
    const res = await getTraceStatus(projectId, scope.agentId, scope.hostId);
    if (scope.isStale(epoch)) return;
    if (res.error || !res.data) {
      statusError = res.error?.error ?? 'Runtime status could not be loaded.';
      return;
    }
    statusError = null;
    const wasOnline = status?.agent_online === true;
    status = res.data;
    if ((status.agent_online === true) !== wasOnline) syncStream();
  }

  async function loadStats(epoch = scope.epoch) {
    const res = await getTraceStats(projectId, scope.agentId, scope.hostId);
    if (scope.isStale(epoch)) return;
    // The endpoint answers {} before the agent reported statistics.
    if (res.data && Object.keys(res.data).length > 0) stats = res.data as Stats;
  }

  async function loadEventTypes(epoch = scope.epoch) {
    const res = await getTraceEventTypes(projectId, scope.agentId, scope.hostId);
    if (scope.isStale(epoch)) return;
    eventTypes = res.data ?? [];
  }

  async function loadOpenCount(epoch = scope.epoch) {
    const res = await listIncidents(projectId, 'open', 1, 0, scope.hostId);
    if (scope.isStale(epoch)) return;
    openIncidents = res.data?.total ?? null;
  }

  /** Opens, restarts or closes the stream to match Live, the agent state and the range. */
  function syncStream() {
    const agentId = scope.agentId;
    const want = live && Boolean(agentId) && status?.agent_online === true && !sseFatal;
    const key = want ? `${scope.epoch}|${agentId}|${url.range}` : '';
    if (key === streamKey) return;
    stream.reset();
    streamKey = key;
    sseState = 'closed';
    if (!want) return;
    const epoch = scope.epoch;
    const statsRange = url.range;
    stream.start(() => {
      const conn = createSSEConnection({
        projectId,
        agentId,
        hostId: scope.hostId,
        channels: ['trace', 'stats', 'enforcement', 'status'],
        statsRange,
        onStateChange: (state) => {
          if (scope.isStale(epoch)) return;
          sseState = state;
          if (state === 'open') sseLimited = false;
        },
        onLimit: () => {
          if (!scope.isStale(epoch)) sseLimited = true;
        },
        onTrace: (events) => {
          if (!scope.isStale(epoch)) liveTrace.push(events);
        },
        onStats: (next) => {
          if (!scope.isStale(epoch)) stats = next as Stats;
        },
        onEnforcement: (entries) => {
          if (!scope.isStale(epoch)) liveEnforcement.push(entries);
        },
        onStatus: (data) => {
          if (!scope.isStale(epoch) && data.trace) status = { ...(status ?? {}), ...data.trace } as TraceStatus;
        },
        onFatal: (error) => {
          if (scope.isStale(epoch)) return;
          sseFatal = error;
          streamKey = '';
        },
      });
      return () => conn.close();
    });
  }

  // The stream carries range-adjusted statistics: restart it on a range change.
  $effect(() => {
    void url.range;
    untrack(() => syncStream());
  });

  function setLive(on: boolean) {
    live = on;
    if (on) sseFatal = null;
    syncStream();
  }

  function navigate(search: string, replace: boolean) {
    return goto(`${page.url.pathname}${search}${page.url.hash}`, { replace, reset: false });
  }

  function patchUrl(patch: RuntimeUrlPatch, replace = true) {
    return navigate(runtimeSearch(page.url.searchParams, patch), replace);
  }

  // Tabs: the value follows the URL; a navigation cancelled by an
  // unsaved-changes prompt puts the selection back.
  let tabValue = $state<string>('triage');
  $effect.pre(() => {
    tabValue = url.tab;
  });

  function changeTab(id: string) {
    void patchUrl({ tab: id as RuntimeTab }, false).finally(() => {
      tabValue = readRuntimeUrl(page.url.searchParams).tab;
    });
  }

  function changeRange(range: TimeRangeKey) {
    void patchUrl({ range });
  }

  function openExplore(next: Parameters<typeof exploreSearch>[1]) {
    void navigate(exploreSearch(page.url.searchParams, next), false);
  }

  /** Back to the host table; `?pick=1` keeps it visible (no remembered or single-host auto-select). */
  function clearHost() {
    const params = new URLSearchParams(page.url.search);
    params.delete('host');
    params.delete('incident');
    params.delete('technique');
    params.set('pick', '1');
    void goto(`${page.url.pathname}?${params}`, { reset: false });
  }

  function onEnforcementCleared(clearedAt: string) {
    enforcementClearedAt = clearedAt;
    liveEnforcement.setAccept((entry) => timeOf(entry.timestamp) >= timeOf(clearedAt));
  }

  function openRuleEditor(options: { rule?: DetectionRule | null; prefill?: SuppressionPrefill | null; onsaved?: () => void; hostId?: string; hostLabel?: string }) {
    if (!options.rule && !canConfigure) return;
    ruleEditor = {
      hostId: options.hostId ?? options.prefill?.hostId ?? scope.hostId,
      hostLabel: options.hostLabel ?? hostName,
      rule: options.rule ?? null,
      prefill: options.prefill ? { draft: options.prefill.draft, warning: options.prefill.warning } : null,
      onsaved: options.onsaved,
    };
  }

  function suppressEvent(event: TraceEvent) {
    const conditions = [{ field: 'comm', op: 'eq', value: event.comm ?? '' }];
    if (event.event_name) conditions.push({ field: 'event_name', op: 'eq', value: event.event_name });
    openRuleEditor({
      prefill: {
        hostId: scope.hostId,
        eventNames: event.event_name ? [event.event_name] : [],
        draft: {
          name: `Exception: ${event.comm || 'process'} ${event.event_name}`.trim(),
          description: `Created from a ${event.event_name} event of ${event.comm || 'an unknown process'} at ${formatDateTime(event.timestamp, { seconds: true })}.`,
          enabled: true,
          action: 'suppress',
          conditions,
          severity_override: null,
          priority: 100,
          tags: 'explore-exception',
        },
      },
    });
  }

  const runtimeTabs = $derived<TabItem[]>(
    RUNTIME_TABS.map((tab) => (tab.id === 'triage' && openIncidents ? { ...tab, count: formatNumber(openIncidents, 'compact') } : tab)),
  );

  const agentOnline = $derived(status?.agent_online === true);
  const neverReported = $derived(Boolean((status as (TraceStatus & { never_reported?: boolean }) | null)?.never_reported));
  const lossNotice = $derived(traceLossNotice(status));
  const hostLabel = $derived(hostName || (scope.hostId ? `Host ${scope.hostId.slice(0, 8)}` : ''));
  const streamText = $derived.by(() => {
    if (!live) return 'Live off';
    if (sseFatal) return 'Live unavailable';
    if (!status) return loading ? 'Live starts once the agent answers' : 'Live waits for the agent status';
    if (!agentOnline) return 'Live paused: agent offline';
    switch (sseState) {
      case 'open':
        return 'Live';
      case 'connecting':
        return 'Connecting…';
      case 'reconnecting':
        return sseLimited ? 'Live waiting: too many live views open, retrying every 30 s' : 'Reconnecting…';
      case 'failed':
        return 'Live unavailable';
      default:
        return stream.hidden ? 'Live paused while the tab is hidden' : 'Live off';
    }
  });
  const streamDot = $derived<'online' | 'pending' | 'offline' | 'disabled'>(
    !live ? 'disabled' : sseState === 'open' ? 'online' : sseFatal || sseState === 'failed' ? 'offline' : 'pending',
  );
  usePageTitle(() => (hostName ? `${hostName} | Runtime security` : null));
</script>

<div class="runtime-page">
  {#if !isEmbed}
    <PageHeader
      title="Runtime security"
      subtitle="Triage host incidents, explore runtime events and manage the policies that act on them."
      backHref={`${base}/projects/${projectId}`}
    />
  {/if}

  {#if !hostId && !isEmbed}
    <HostPicker {projectId} title="Select a host" description="Runtime security shows one host at a time. Choose the host whose runtime agent you want to review." />
  {:else}
    {#if project.project && !canConfigure}
      <Alert tone="info" compact message="Read-only access: you can review incidents, events and policies; changing them requires the member or owner role." />
    {/if}

    <section class="host-bar" aria-label="Selected host">
      <div class="host-id">
        {#if isEmbed}
          <h2 class="host-name">{hostLabel || 'Host'}</h2>
        {:else}
          <h2 class="sr-only">Host {hostLabel || ''}</h2>
          <HostSwitcher {projectId} {hostId} hostName={hostName} drop={['incident']} />
        {/if}
        {#if scope.agentStatus === 'ready'}
          <StatusDot
            status={agentOnline ? 'online' : status ? 'offline' : loading ? 'pending' : 'unknown'}
            label={agentOnline ? 'Agent online' : status ? `Agent offline · last seen ${formatDateTime(status.agent_last_seen, { relative: true, fallback: 'unknown' })}` : loading ? 'Checking the agent…' : 'Agent status unknown'}
          />
          {#if status && neverReported}
            <span class="fact">No runtime report yet</span>
          {:else if status}
            <span class="fact">{status.running ? 'Tracing' : 'Tracing stopped'}</span>
            <span class="fact">{status.enforcement ? `Enforcing · ${formatNumber(status.policies_total)} policies` : 'Detection only'}</span>
          {/if}
        {/if}
      </div>
      {#if scope.agentStatus === 'ready'}
        <div class="host-controls">
          <TimeRangePicker value={url.range} includeAll label="Time range for events, activity and enforcement" onchange={changeRange} />
          <label class="live" title="Stream new events, statistics and status from the agent">
            <input type="checkbox" checked={live} onchange={(e) => setLive(e.currentTarget.checked)} />
            <span>Live</span>
          </label>
          <StatusDot status={streamDot} label={streamText} pulse={sseState === 'open'} />
        </div>
      {/if}
    </section>

    {#if sseFatal && live}
      <Alert tone="warning" compact message={`Live updates stopped: ${sseFatal.error}. Lists still refresh when you reload them.`}>
        {#snippet actions()}<Button variant="secondary" size="sm" onclick={() => setLive(true)}>Retry live updates</Button>{/snippet}
      </Alert>
    {/if}
    {#if lossNotice?.tone === 'warning'}
      <Alert tone="warning" compact message={`${lossNotice.title}: ${lossNotice.detail} Details in the Agent tab.`} />
    {:else if status && Object.keys(status.missing_probes ?? {}).length > 0}
      <Alert tone="warning" compact message={`Partial capture: ${Object.keys(status.missing_probes ?? {}).length} probes unavailable. Details in the Agent tab.`} />
    {:else if lossNotice}
      <Alert tone="info" compact message={`${lossNotice.title}: ${lossNotice.detail} Details in the Agent tab.`} />
    {/if}

    {#if initError}
      <Alert tone="error" message={initError} />
    {:else if scope.agentStatus === 'resolving' || (loading && scope.agentStatus !== 'missing' && scope.agentStatus !== 'error')}
      <Spinner layout="block" tone="accent" label="Loading runtime security" />
    {:else if scope.agentStatus === 'missing'}
      <EmptyState title="No runtime agent on this host" message="Runtime security needs the host agent. Install wafio-host-agent on this host with its host key (shown once when the host was registered; rotate it on the host page if it is lost), or choose another host." level={2}>
        {#snippet action()}
          <div class="empty-actions">
            <Button variant="primary" href={`${base}/projects/${projectId}/hosts/${encodeURIComponent(scope.hostId)}`}>Open host details</Button>
            {#if !isEmbed}<Button variant="ghost" onclick={clearHost}>Choose another host</Button>{/if}
          </div>
        {/snippet}
      </EmptyState>
    {:else if scope.agentStatus === 'error'}
      <Alert tone="error" title="The host's agent could not be looked up">
        Check your connection and retry.
        {#snippet actions()}
          <Button
            variant="secondary"
            size="sm"
            onclick={() => {
              scope.reset();
              void init();
            }}>Retry</Button
          >
        {/snippet}
      </Alert>
    {:else if scope.agentStatus === 'ready'}
      {#if statusError && !status}
        <Alert tone="error" message={statusError} />
      {/if}
      {#key `${scope.hostId}|${scope.agentId}`}
        <!--
          Panels follow the committed URL (url.tab), not the tab being
          clicked: the open panel stays mounted until the navigation is
          allowed, so its unsaved-changes guard (Agent → trace configuration)
          runs before it would be destroyed.
        -->
        <Tabs tabs={runtimeTabs} bind:value={tabValue} onchange={changeTab} label="Runtime security sections" id="runtime" panels="external" />
        {@const panelIds = tabDomIds('runtime', url.tab)}
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <div class="panel-body" role="tabpanel" id={panelIds.panel} aria-labelledby={panelIds.tab} tabindex="0">
              {#if url.tab === 'triage'}
                <TriageView
                  {projectId}
                  {scope}
                  {hostLabel}
                  range={url.range}
                  {stats}
                  {canConfigure}
                  highlightIncident={url.incident}
                  technique={url.technique}
                  statusFilter={url.incidentStatus}
                  scopeMode={url.incidentScope}
                  onfilterchange={(next) => void patchUrl(next)}
                  onclearTechnique={() => void patchUrl({ technique: null })}
                  onexplore={openExplore}
                  onsuppress={(prefill, onsaved) => openRuleEditor({ prefill, onsaved, hostLabel: prefill.hostLabel })}
                  oncounts={(counts) => (openIncidents = counts.open)}
                />
              {:else if url.tab === 'explore'}
                <ExploreView
                  {projectId}
                  {scope}
                  range={url.range}
                  source={url.source}
                  minSeverity={url.minSeverity}
                  traceFilters={url.traceFilters}
                  enforcementFilters={url.enforcementFilters}
                  {liveTrace}
                  {liveEnforcement}
                  streaming={sseState === 'open'}
                  {canConfigure}
                  {enforcementClearedAt}
                  onnavigate={(patch, replace) => void patchUrl(patch, replace ?? true)}
                  oncleared={onEnforcementCleared}
                  onsuppress={suppressEvent}
                  onnewpolicy={(event) => (policyEditor = { policy: null, prefill: draftFromEvent(event) })}
                />
              {:else if url.tab === 'policies'}
                <PoliciesView
                  {projectId}
                  {scope}
                  section={url.section}
                  {canConfigure}
                  {canManage}
                  {policiesVersion}
                  {rulesVersion}
                  onsection={(section: PolicySection) => void patchUrl({ section }, false)}
                  oneditpolicy={(policy) => (policyEditor = { policy, prefill: null })}
                  oneditrule={(rule) => openRuleEditor({ rule })}
                  onpoliciesimported={() => (policiesVersion += 1)}
                />
              {:else if url.tab === 'agent'}
                <AgentView {projectId} {scope} {hostLabel} {status} {stats} {eventTypes} {canConfigure} onsaved={() => void loadStatus()} />
              {/if}
        </div>
      {/key}
    {/if}
  {/if}
</div>

{#if scope.agentStatus === 'ready'}
  <PolicyEditor
    open={policyEditor !== null}
    {projectId}
    {scope}
    policy={policyEditor?.policy ?? null}
    prefill={policyEditor?.prefill ?? null}
    {eventTypes}
    range={url.range}
    {canConfigure}
    onclose={() => (policyEditor = null)}
    onsaved={() => {
      policyEditor = null;
      policiesVersion += 1;
      void loadStatus();
    }}
  />
  <DetectionRuleEditor
    open={ruleEditor !== null}
    {projectId}
    hostId={ruleEditor?.hostId ?? scope.hostId}
    hostLabel={ruleEditor?.hostLabel ?? hostName}
    rule={ruleEditor?.rule ?? null}
    prefill={ruleEditor?.prefill ?? null}
    {canConfigure}
    onclose={() => (ruleEditor = null)}
    onsaved={() => {
      const done = ruleEditor?.onsaved;
      ruleEditor = null;
      rulesVersion += 1;
      done?.();
    }}
  />
{/if}

<style>
  .runtime-page {
    display: grid;
    gap: var(--sp-4);
    align-content: start;
    width: 100%;
    min-width: 0;
    padding: var(--page-top) var(--page-gutter) var(--sp-7);
  }
  .host-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-3);
    padding: var(--sp-3) var(--sp-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--bg-card);
    min-width: 0;
  }
  .host-id,
  .host-controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--sp-2) var(--sp-3);
    min-width: 0;
  }
  .host-name {
    margin: 0;
    font-size: var(--fs-md);
    font-weight: var(--fw-semibold);
    overflow-wrap: anywhere;
  }
  .fact {
    font-size: var(--fs-xs);
    color: var(--text-muted);
  }
  .fact::before {
    content: '·';
    margin-right: var(--sp-2);
  }
  .live {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-1);
    font-size: var(--fs-sm);
    color: var(--text-secondary);
    cursor: pointer;
  }
  .panel-body {
    padding-top: var(--sp-4);
    min-width: 0;
  }
  .empty-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-2);
    justify-content: center;
  }
</style>
