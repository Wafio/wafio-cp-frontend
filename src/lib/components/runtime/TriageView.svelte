<!--
  TriageView: the incident queue first:
  incidents grouped by host × tactic × process with counts, bulk
  Acknowledge/Resolve with a note, "suppress from incident" that opens the
  detection-rule editor prefilled with an exception, then the activity of
  the page time range.
-->
<script lang="ts">
  import { tick, untrack } from 'svelte';
  import {
    ackIncident,
    getEnforcementLog,
    incidentStats,
    listFleetAgents,
    listHosts,
    listIncidents,
    resolveIncident,
    type EnforcementLogEntry,
    type HostIncident,
    type IncidentStats,
    type TraceStats,
  } from '#lib/api.js';
  import { formatDuration, formatNumber, formatRelative } from '#lib/format.js';
  import { createLifecycle, type HostScope } from '#lib/host-scope.svelte.js';
  import { severityTone } from '#lib/tone.js';
  import { toast } from '#lib/stores/toast.js';
  import Alert from '#lib/components/ui/Alert.svelte';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import ConfirmModal from '#lib/components/ui/ConfirmModal.svelte';
  import DataTable from '#lib/components/ui/DataTable.svelte';
  import DateTime from '#lib/components/ui/DateTime.svelte';
  import KpiStrip from '#lib/components/ui/KpiStrip.svelte';
  import Select from '#lib/components/ui/Select.svelte';
  import { timeRangeLabel, timeRangeMinutes, type TimeRangeKey } from '#lib/components/ui/time-range.js';
  import type { DataTableColumn, KpiItem } from '#lib/components/ui/types.js';
  import type { SortState } from '#lib/components/ui/table-sort.js';
  import ActivitySummary from './ActivitySummary.svelte';
  import type { FacetFilters, TraceFacet } from './explore';
  import type { IncidentScope, IncidentStatusFilter } from './url';
  import {
    NOTE_MAX_LENGTH,
    UNMAPPED_TACTIC,
    actionableIncidentIds,
    groupIncidents,
    incidentAccepts,
    runBulk,
    summarizeSelection,
    suppressionPrefill,
    type HostRef,
    type IncidentAction,
    type IncidentGroup,
    type SuppressionPrefill,
  } from './triage';

  type Stats = Partial<TraceStats> & { severity_window_range?: string };

  let {
    projectId,
    scope,
    hostLabel,
    range,
    stats,
    canConfigure = false,
    highlightIncident = '',
    technique = '',
    statusFilter = 'unresolved',
    scopeMode = 'host',
    onfilterchange = undefined,
    onclearTechnique = undefined,
    onexplore,
    onsuppress,
    oncounts = undefined,
  }: {
    projectId: string;
    scope: HostScope;
    hostLabel: string;
    range: TimeRangeKey;
    stats: Stats | null;
    canConfigure?: boolean;
    /** Incident id to reveal (deep link). */
    highlightIncident?: string;
    /** ATT&CK technique id to narrow the queue to (Overview "Review incidents" deep link). */
    technique?: string;
    /** Queue status filter and scope; the page keeps them in the URL. */
    statusFilter?: IncidentStatusFilter;
    scopeMode?: IncidentScope;
    onfilterchange?: (next: { incidentStatus?: IncidentStatusFilter; incidentScope?: IncidentScope }) => void;
    /** Removes the technique filter (the page drops it from the URL). */
    onclearTechnique?: () => void;
    onexplore: (next: { source?: 'events' | 'enforcement'; minSeverity?: string; traceFilters?: FacetFilters<TraceFacet> }) => void;
    /** Opens the detection-rule editor; `onsaved` runs after the rule is saved. */
    onsuppress: (prefill: SuppressionPrefill, onsaved: () => void) => void;
    oncounts?: (counts: { open: number }) => void;
  } = $props();

  const PAGE = 100;
  const CAP = 1000;
  const life = createLifecycle();
  // The view is keyed per host: it lives within one scope epoch.
  const hostEpoch = untrack(() => scope.epoch);
  const noPermission = 'Requires the member or owner role';
  const STATUS_OPTIONS: { value: IncidentStatusFilter; label: string }[] = [
    { value: 'unresolved', label: 'Unresolved' },
    { value: 'open', label: 'Open' },
    { value: 'acknowledged', label: 'Acknowledged' },
    { value: 'resolved', label: 'Resolved' },
    { value: '', label: 'All' },
  ];

  let incidents = $state.raw<HostIncident[]>([]);
  let totalIncidents = $state(0);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let hostMap = $state.raw<Map<string, HostRef> | null>(null);
  let selected = $state<string[]>([]);
  let expandedKeys = $state<Array<string | number>>([]);
  let stats30 = $state<IncidentStats | null>(null);
  let enforcement = $state.raw<EnforcementLogEntry[]>([]);
  let enforcementLoading = $state(false);
  let enforcementError = $state<string | null>(null);
  let suppressedGroup = $state<IncidentGroup | null>(null);

  let bulk = $state<{ action: IncidentAction; keys: string[] } | null>(null);
  let note = $state('');
  let bulkRunning = $state(false);
  let bulkProgress = $state({ done: 0, total: 0 });
  let bulkFailures = $state<Array<{ id: string; error: string }>>([]);

  let incidentBusy = $state<string[]>([]);
  const GROUP_PAGE = 25;
  let groupOffset = $state(0);
  let groupSort = $state<SortState | null>(null);
  /** The deep-linked incident is revealed once, not on every refresh. */
  let revealed = '';
  let resolveOne = $state<HostIncident | null>(null);
  let incSeq = 0;

  function stale(epoch = hostEpoch): boolean {
    return life.destroyed || scope.isStale(epoch);
  }

  async function loadHostMap() {
    if (hostMap) return;
    const [agents, hosts] = await Promise.all([listFleetAgents({ kind: 'host', projectId, limit: 100 }), listHosts(projectId, { limit: 100 })]);
    if (stale()) return;
    const names = new Map((hosts.data?.hosts ?? []).map((h) => [h.id, h.name]));
    const map = new Map<string, HostRef>();
    for (const agent of agents.data?.agents ?? []) {
      if (!agent.host_id) continue;
      map.set(agent.id, { id: agent.host_id, label: names.get(agent.host_id) ?? agent.hostname ?? agent.name });
    }
    hostMap = map;
  }

  async function loadIncidents() {
    const seq = ++incSeq;
    loading = true;
    error = null;
    if (scopeMode === 'all') await loadHostMap();
    const hostFilter = scopeMode === 'host' ? scope.hostId : '';
    const all: HostIncident[] = [];
    let total = 0;
    for (let offset = 0; offset < CAP; offset += PAGE) {
      const res = await listIncidents(projectId, statusFilter, PAGE, offset, hostFilter);
      if (seq !== incSeq || stale()) return;
      if (res.error || !res.data) {
        loading = false;
        error = res.error?.error ?? 'Incidents could not be loaded.';
        return;
      }
      total = res.data.total;
      all.push(...res.data.incidents);
      if (res.data.incidents.length < PAGE || all.length >= total) break;
    }
    const seen = new Set<string>();
    incidents = all.filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)));
    totalIncidents = total;
    loading = false;
    const keys = new Set(groups.map((g) => g.key));
    selected = selected.filter((key) => keys.has(key));
    if (scopeMode === 'host' && (statusFilter === 'unresolved' || statusFilter === 'open')) {
      oncounts?.({ open: incidents.filter((i) => i.status === 'open').length });
    }
    await revealHighlight();
  }

  async function revealHighlight() {
    if (!highlightIncident || revealed === highlightIncident) return;
    const index = groups.findIndex((g) => g.incidents.some((i) => i.id === highlightIncident));
    if (index < 0) return;
    revealed = highlightIncident;
    const group = groups[index];
    // Show the page that holds the group (default order).
    groupSort = null;
    groupOffset = Math.floor(index / GROUP_PAGE) * GROUP_PAGE;
    if (!expandedKeys.includes(group.key)) expandedKeys = [...expandedKeys, group.key];
    await tick();
    document.getElementById(`incident-${highlightIncident}`)?.scrollIntoView({ block: 'center' });
  }

  // Newest stats / enforcement load: a slower answer for the previous range
  // must not land under the new one (like incSeq for the queue).
  // A newer load also aborts the older request (and leaving the page aborts both).
  let statsSeq = 0;
  let enforcementSeq = 0;
  let statsAbort: AbortController | null = null;
  let enforcementAbort: AbortController | null = null;
  $effect(() => () => {
    statsAbort?.abort();
    enforcementAbort?.abort();
  });

  async function loadStats() {
    const seq = ++statsSeq;
    statsAbort?.abort();
    const controller = (statsAbort = new AbortController());
    const res = await incidentStats(projectId, range, controller.signal);
    if (seq !== statsSeq || stale() || controller.signal.aborted) return;
    stats30 = res.data ?? null;
  }

  async function loadEnforcement() {
    const seq = ++enforcementSeq;
    enforcementAbort?.abort();
    const controller = (enforcementAbort = new AbortController());
    enforcementLoading = true;
    enforcementError = null;
    const res = await getEnforcementLog(projectId, 1000, scope.agentId, scope.hostId, timeRangeMinutes(range) ?? undefined, controller.signal);
    if (seq !== enforcementSeq || stale() || controller.signal.aborted) return;
    enforcementLoading = false;
    if (res.error) enforcementError = res.error.error;
    else enforcement = res.data ?? [];
  }

  $effect(() => {
    void scopeMode;
    void statusFilter;
    untrack(() => {
      groupOffset = 0;
      void loadIncidents();
    });
  });

  $effect(() => {
    void range;
    untrack(() => {
      void loadStats();
      void loadEnforcement();
    });
  });

  // Refresh the queue once a minute while the tab is visible.
  life.poll(() => (bulkRunning || bulk ? undefined : loadIncidents()), 60_000, { immediate: false });

  // The Overview's "Review N incidents" link narrows the queue to one technique.
  const visibleIncidents = $derived(technique ? incidents.filter((i) => (i.technique_id || '') === technique) : incidents);
  const groups = $derived(
    groupIncidents(visibleIncidents, {
      hostOf: scopeMode === 'all' ? (agentId) => hostMap?.get(agentId) : undefined,
      fallbackHost: scopeMode === 'host' ? { id: scope.hostId, label: hostLabel || 'This host' } : undefined,
    }),
  );
  const selectedGroups = $derived(groups.filter((g) => selected.includes(g.key)));
  const selection = $derived(summarizeSelection(selectedGroups));
  const allSelected = $derived(groups.length > 0 && selectedGroups.length === groups.length);
  const someSelected = $derived(selectedGroups.length > 0 && !allSelected);
  const bulkGroups = $derived(bulk ? groups.filter((g) => bulk?.keys.includes(g.key)) : []);
  const bulkIds = $derived(bulk ? actionableIncidentIds(bulkGroups, bulk.action) : []);

  const totals = $derived.by(() => {
    let open = 0;
    let acknowledged = 0;
    let severe = 0;
    for (const incident of visibleIncidents) {
      if (incident.status === 'open') open += 1;
      if (incident.status === 'acknowledged') acknowledged += 1;
      if (incident.status !== 'resolved' && (incident.severity_name === 'critical' || incident.severity_name === 'high')) severe += 1;
    }
    return { open, acknowledged, severe };
  });

  const rangeText = $derived(range === 'all' ? 'all time' : timeRangeLabel(range).toLowerCase());
  const kpis = $derived<KpiItem[]>([
    { label: 'Incident groups', value: formatNumber(groups.length), detail: `${formatNumber(incidents.length)} incidents` },
    { label: 'Open', value: formatNumber(totals.open), detail: 'Not yet acknowledged' },
    { label: 'Acknowledged', value: formatNumber(totals.acknowledged), detail: 'Under review' },
    {
      label: 'Critical or high',
      value: formatNumber(totals.severe),
      tone: totals.severe > 0 ? 'danger' : 'default',
      toneText: totals.severe > 0 ? 'unresolved' : undefined,
      detail: 'Open or acknowledged',
    },
    { label: 'Time to acknowledge', value: stats30?.mtta_seconds != null ? formatDuration(stats30.mtta_seconds, 's') : 'n/a', detail: `Project-wide mean, ${rangeText}` },
    { label: 'Time to resolve', value: stats30?.mttr_seconds != null ? formatDuration(stats30.mttr_seconds, 's') : 'n/a', detail: `Project-wide mean, ${rangeText}` },
  ]);

  function toggleGroup(key: string, on: boolean) {
    selected = on ? [...new Set([...selected, key])] : selected.filter((k) => k !== key);
  }

  function toggleAll(on: boolean) {
    selected = on ? groups.map((g) => g.key) : [];
  }

  function openBulk(action: IncidentAction, keys: string[]) {
    if (!canConfigure) return;
    note = '';
    bulkFailures = [];
    bulkProgress = { done: 0, total: 0 };
    bulk = { action, keys };
  }

  function closeBulk() {
    if (bulkRunning) return;
    bulk = null;
    note = '';
    bulkFailures = [];
  }

  /** Acknowledge or resolve one incident; the note is stored in the audit event. */
  function changeIncident(id: string, action: IncidentAction, text: string) {
    return action === 'ack' ? ackIncident(projectId, id, text) : resolveIncident(projectId, id, text);
  }

  async function runBulkAction() {
    if (!bulk || !canConfigure || bulkIds.length === 0) return;
    const action = bulk.action;
    const ids = [...bulkIds];
    const text = note;
    bulkRunning = true;
    bulkFailures = [];
    bulkProgress = { done: 0, total: ids.length };
    const result = await runBulk(
      ids,
      async (id) => {
        const res = await changeIncident(id, action, text);
        return { ok: !res.error, error: res.error?.error };
      },
      { concurrency: 4, onProgress: (done, total) => (bulkProgress = { done, total }), signal: life.signal },
    );
    if (stale()) return;
    bulkRunning = false;
    const verb = action === 'ack' ? 'acknowledged' : 'resolved';
    if (result.succeeded.length) toast.success(`${formatNumber(result.succeeded.length)} incident${result.succeeded.length === 1 ? '' : 's'} ${verb}`, 'Incidents updated');
    if (result.failed.length) {
      bulkFailures = result.failed;
    } else {
      bulk = null;
      note = '';
      selected = [];
    }
    if (suppressedGroup && action === 'resolve') suppressedGroup = null;
    await loadIncidents();
  }

  async function ackOne(incident: HostIncident) {
    if (!canConfigure || incidentBusy.includes(incident.id)) return;
    incidentBusy = [...incidentBusy, incident.id];
    const res = await changeIncident(incident.id, 'ack', '');
    if (stale()) return;
    incidentBusy = incidentBusy.filter((id) => id !== incident.id);
    if (res.error) toast.error(res.error.error || 'The incident could not be acknowledged.', 'Incident not changed');
    else toast.success('The incident is marked as under review.', 'Incident acknowledged');
    await loadIncidents();
  }

  async function confirmResolveOne() {
    const incident = resolveOne;
    if (!incident || !canConfigure) return;
    incidentBusy = [...incidentBusy, incident.id];
    const res = await changeIncident(incident.id, 'resolve', '');
    if (stale()) return;
    incidentBusy = incidentBusy.filter((id) => id !== incident.id);
    resolveOne = null;
    if (res.error) toast.error(res.error.error || 'The incident could not be resolved.', 'Incident not changed');
    else toast.success('A new incident opens if the activity is observed again.', 'Incident resolved');
    await loadIncidents();
  }

  function suppress(group: IncidentGroup) {
    if (!canConfigure || group.host.id.startsWith('agent:')) return;
    onsuppress(suppressionPrefill(group), async () => {
      if (stale()) return;
      suppressedGroup = group;
      // The confirmation sits above the table: bring it into view.
      await tick();
      const saved = document.getElementById('triage-exception-saved');
      saved?.scrollIntoView({ block: 'nearest' });
      saved?.focus({ preventScroll: true });
    });
  }

  function exploreGroup(group: IncidentGroup) {
    // Incidents are raised for high and critical events only (host_ingest.go).
    onexplore({ minSeverity: 'high', traceFilters: { process: group.comm, tactic: group.tactic === UNMAPPED_TACTIC ? 'Unmapped' : group.tactic } });
  }

  function groupName(group: IncidentGroup): string {
    return `${group.comm} · ${group.tactic}${scopeMode === 'all' ? ` on ${group.host.label}` : ''}`;
  }

  const columns = $derived<DataTableColumn<IncidentGroup>[]>([
    { key: 'select', label: 'Select', hideLabel: true, width: '2.5rem' },
    { key: 'severity', label: 'Severity', nowrap: true, sortable: true, firstSortDir: 'desc', sortValue: (g) => g.severityRank },
    // In the all-hosts scope the host is shown under the process (keeps the table within 1440px).
    { key: 'process', label: scopeMode === 'all' ? 'Process · host' : 'Process', rowHeader: true, sortable: true, sortValue: (g) => (scopeMode === 'all' ? `${g.host.label}\u0000${g.comm}` : g.comm) },
    { key: 'tactic', label: 'Tactic', sortable: true, sortValue: (g) => g.tactic },
    { key: 'incidents', label: 'Incidents', sortable: true, firstSortDir: 'desc', sortValue: (g) => g.incidents.length },
    { key: 'events', label: 'Events', align: 'right', sortable: true, firstSortDir: 'desc', sortValue: (g) => g.eventCount },
    { key: 'last', label: 'Last seen', nowrap: true, sortable: true, firstSortDir: 'desc', sortValue: (g) => Date.parse(g.lastSeen) || 0 },
  ]);

  /** The suppressed group as currently loaded (its incidents change as they are resolved). */
  const suppressedCurrent = $derived(suppressedGroup ? (groups.find((g) => g.key === suppressedGroup?.key) ?? null) : null);
  const suppressedOpen = $derived(suppressedCurrent ? actionableIncidentIds([suppressedCurrent], 'resolve').length : 0);

  const bulkTitle = $derived(
    bulk ? `${bulk.action === 'ack' ? 'Acknowledge' : 'Resolve'} ${formatNumber(bulkIds.length)} incident${bulkIds.length === 1 ? '' : 's'}` : '',
  );
</script>

<div class="triage">
  <section class="queue" aria-labelledby="queue-title">
    <div class="queue-head">
      <div>
        <h2 id="queue-title" class="section-title">Incident queue</h2>
        <p class="caption">High and critical observations grouped by host, ATT&amp;CK tactic and process. Current state; not limited by the time range. Not confirmed compromise.</p>
      </div>
      <div class="filters">
        <fieldset class="segmented">
          <legend class="sr-only">Hosts</legend>
          <label class:active={scopeMode === 'host'}><input type="radio" name="triage-scope" value="host" checked={scopeMode === 'host'} onchange={() => onfilterchange?.({ incidentScope: 'host' })} /><span>This host</span></label>
          <label class:active={scopeMode === 'all'}><input type="radio" name="triage-scope" value="all" checked={scopeMode === 'all'} onchange={() => onfilterchange?.({ incidentScope: 'all' })} /><span>All hosts</span></label>
        </fieldset>
        <div class="field">
          <label class="field-label" for="triage-status">Status</label>
          <Select id="triage-status" class="status-filter" size="sm" options={STATUS_OPTIONS} value={statusFilter} onchange={(incidentStatus) => onfilterchange?.({ incidentStatus })} />
        </div>
        <Button variant="secondary" size="sm" onclick={() => loadIncidents()} disabled={loading} {loading}>Refresh</Button>
      </div>
    </div>

    <KpiStrip items={kpis} label="Incident summary" loading={loading && incidents.length === 0} />

    {#if suppressedGroup}
      <div class="saved" id="triage-exception-saved" tabindex="-1">
        <Alert tone="success" title="Exception saved" ondismiss={() => (suppressedGroup = null)}>
          New events of {suppressedGroup.comm} · {suppressedGroup.tactic} are suppressed at ingest. The existing incidents stay until you resolve them.
          {#snippet actions()}
            {#if suppressedOpen > 0}
              <Button variant="secondary" size="sm" disabled={!canConfigure} onclick={() => suppressedCurrent && openBulk('resolve', [suppressedCurrent.key])}>
                {suppressedOpen === 1 ? 'Resolve its incident…' : `Resolve its ${formatNumber(suppressedOpen)} incidents…`}
              </Button>
            {/if}
          {/snippet}
        </Alert>
      </div>
    {/if}

    {#if technique}
      <Alert tone="info" compact message={`Showing incidents of technique ${technique} only (${formatNumber(visibleIncidents.length)} of ${formatNumber(incidents.length)} loaded).`}>
        {#snippet actions()}
          {#if onclearTechnique}<Button variant="secondary" size="sm" onclick={() => onclearTechnique?.()}>Show all incidents</Button>{/if}
        {/snippet}
      </Alert>
    {/if}

    {#if totalIncidents > incidents.length}
      <Alert tone="warning" compact message={`Grouped the ${formatNumber(incidents.length)} highest-priority of ${formatNumber(totalIncidents)} incidents. Resolve or suppress groups to see the rest.`} />
    {/if}

    <div class="bulk-bar" aria-label="Bulk actions">
      <label class="check">
        <input type="checkbox" checked={allSelected} indeterminate={someSelected} disabled={groups.length === 0} onchange={(e) => toggleAll(e.currentTarget.checked)} />
        <span>{selectedGroups.length ? `${formatNumber(selection.groups)} group${selection.groups === 1 ? '' : 's'} selected · ${formatNumber(selection.incidents)} incidents` : 'Select all groups'}</span>
      </label>
      <div class="bulk-actions">
        <Button variant="secondary" size="sm" disabled={!canConfigure || selection.acknowledgeable === 0} title={canConfigure ? undefined : noPermission} onclick={() => openBulk('ack', selected)}>
          Acknowledge{selection.acknowledgeable ? ` ${formatNumber(selection.acknowledgeable)}` : ''}…
        </Button>
        <Button variant="secondary" size="sm" disabled={!canConfigure || selection.resolvable === 0} title={canConfigure ? undefined : noPermission} onclick={() => openBulk('resolve', selected)}>
          Resolve{selection.resolvable ? ` ${formatNumber(selection.resolvable)}` : ''}…
        </Button>
      </div>
    </div>

    <DataTable
      rows={groups}
      {columns}
      rowKey={(g) => g.key}
      caption="Incident groups"
      itemLabel="groups"
      pageSize={GROUP_PAGE}
      bind:offset={groupOffset}
      bind:sort={groupSort}
      {loading}
      {error}
      onretry={() => loadIncidents()}
      emptyTitle={statusFilter === 'unresolved' ? 'No unresolved incidents' : 'No incidents with this status'}
      emptyMessage={statusFilter === 'unresolved' ? 'Nothing is waiting for review. Incidents are raised for high and critical runtime events; capture loss can hide activity (see the Agent tab).' : 'Choose another status or scope.'}
      bind:expandedKeys
      expandLabel={(g) => `Incidents of ${groupName(g)}`}
      rowClass={(g) => (g.incidents.some((i) => i.id === highlightIncident) ? 'highlight' : undefined)}
    >
      {#snippet cell(group, column)}
        {#if column.key === 'select'}
          <input type="checkbox" checked={selected.includes(group.key)} aria-label={`Select ${groupName(group)}`} onchange={(e) => toggleGroup(group.key, e.currentTarget.checked)} />
        {:else if column.key === 'severity'}
          <Badge tone={severityTone(group.severity)}>{group.severity || 'unknown'}</Badge>
        {:else if column.key === 'process'}
          <code>{group.comm}</code>
          {#if scopeMode === 'all'}<span class="muted block">{group.host.label}</span>{/if}
        {:else if column.key === 'tactic'}
          <span class="nowrap">{group.tactic}</span>
          {#if group.techniques.length}<span class="muted block">{group.techniques.join(', ')}</span>{/if}
        {:else if column.key === 'incidents'}
          <span class="num">{formatNumber(group.incidents.length)}</span>
          <span class="muted block">
            {[group.open ? `${group.open} open` : '', group.acknowledged ? `${group.acknowledged} acknowledged` : '', group.resolved ? `${group.resolved} resolved` : ''].filter(Boolean).join(' · ')}
          </span>
        {:else if column.key === 'events'}
          <span class="num">{formatNumber(group.eventCount)}</span>
        {:else if column.key === 'last'}
          <DateTime value={group.lastSeen} />
          <span class="muted block">{formatRelative(group.lastSeen)}</span>
        {/if}
      {/snippet}
      {#snippet actions(group)}
        {@const ackable = actionableIncidentIds([group], 'ack').length}
        {@const resolvable = actionableIncidentIds([group], 'resolve').length}
        <Button variant="ghost" size="sm" disabled={!canConfigure || ackable === 0} title={canConfigure ? `Acknowledge ${ackable} open incidents of ${groupName(group)}` : noPermission} aria-label={`Acknowledge ${groupName(group)}`} onclick={() => openBulk('ack', [group.key])}>Acknowledge</Button>
        <Button variant="ghost" size="sm" disabled={!canConfigure || resolvable === 0} title={canConfigure ? `Resolve ${resolvable} incidents of ${groupName(group)}` : noPermission} aria-label={`Resolve ${groupName(group)}`} onclick={() => openBulk('resolve', [group.key])}>Resolve</Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={!canConfigure || group.host.id.startsWith('agent:')}
          title={!canConfigure ? noPermission : group.host.id.startsWith('agent:') ? 'The host of this agent is unknown' : 'Create a detection-rule exception for these observations'}
          aria-label={`Suppress ${groupName(group)} from incidents`}
          onclick={() => suppress(group)}>Suppress…</Button
        >
      {/snippet}
      {#snippet expanded(group)}
        <div class="group-detail">
          <div class="group-facts">
            <p class="sample">{group.sample || 'No sample description was stored for these incidents.'}</p>
            <dl>
              <div><dt>Techniques</dt><dd>{group.techniques.join(', ') || 'Unmapped'}</dd></div>
              <div><dt>First seen</dt><dd><DateTime value={group.firstSeen} /></dd></div>
              <div><dt>Last seen</dt><dd><DateTime value={group.lastSeen} relative /></dd></div>
              <div><dt>Agents</dt><dd>{group.agentIds.length}</dd></div>
            </dl>
            <div class="group-links">
              <Button variant="secondary" size="sm" onclick={() => exploreGroup(group)}>Open events in Explore</Button>
            </div>
          </div>
          <table class="incident-table">
            <caption class="sr-only">Incidents of {groupName(group)}</caption>
            <thead>
              <tr><th scope="col">Severity</th><th scope="col">Technique and sample</th><th scope="col">Status</th><th scope="col" class="right">Events</th><th scope="col">First seen</th><th scope="col">Last seen</th><th scope="col"><span class="sr-only">Actions</span></th></tr>
            </thead>
            <tbody>
              {#each group.incidents as incident (incident.id)}
                <tr id="incident-{incident.id}" class:highlight={incident.id === highlightIncident}>
                  <td><Badge tone={severityTone(incident.severity_name)}>{incident.severity_name}</Badge></td>
                  <td>
                    <code title={`Incident ${incident.id} · agent ${incident.agent_id}`}>{incident.technique_id || 'Unmapped'}</code>
                    {#if incident.sample_description}<span class="muted block sample-line" title={incident.sample_description}>{incident.sample_description}</span>{/if}
                  </td>
                  <td>
                    {incident.status}
                    {#if incident.acknowledged_at}<span class="muted"> · acknowledged <DateTime value={incident.acknowledged_at} />{incident.acknowledged_by ? ` by ${incident.acknowledged_by}` : ''}</span>{/if}
                    {#if incident.resolved_at}<span class="muted"> · resolved <DateTime value={incident.resolved_at} />{incident.resolved_by ? ` by ${incident.resolved_by}` : ''}</span>{/if}
                  </td>
                  <td class="right num">{formatNumber(incident.event_count)}</td>
                  <td class="nowrap"><DateTime value={incident.first_seen_at} /></td>
                  <td class="nowrap"><DateTime value={incident.last_seen_at} relative /></td>
                  <td class="row-actions">
                    {#if incidentAccepts(incident, 'ack')}
                      <Button variant="ghost" size="sm" disabled={!canConfigure || incidentBusy.includes(incident.id)} title={canConfigure ? undefined : noPermission} onclick={() => ackOne(incident)}>Acknowledge</Button>
                    {/if}
                    {#if incidentAccepts(incident, 'resolve')}
                      <Button variant="ghost" size="sm" disabled={!canConfigure || incidentBusy.includes(incident.id)} title={canConfigure ? undefined : noPermission} onclick={() => (resolveOne = incident)}>Resolve…</Button>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/snippet}
    </DataTable>
  </section>

  <ActivitySummary {stats} {range} {enforcement} {enforcementLoading} {enforcementError} onexplore={(next) => onexplore(next)} />
</div>

<ConfirmModal
  open={bulk !== null}
  title={bulkTitle}
  confirmLabel={bulk?.action === 'ack' ? 'Acknowledge' : 'Resolve'}
  tone={bulk?.action === 'resolve' ? 'warning' : 'primary'}
  loading={bulkRunning}
  confirmDisabled={bulkIds.length === 0 || !canConfigure}
  dirty={note.trim().length > 0}
  size="md"
  onconfirm={runBulkAction}
  onclose={closeBulk}
>
  <div class="bulk-body">
    <p>
      {bulk?.action === 'ack' ? 'Marks the open incidents as under review.' : 'Closes the incidents. A new incident opens if the same activity is observed again.'}
      {formatNumber(bulkGroups.length)} group{bulkGroups.length === 1 ? '' : 's'}:
    </p>
    <ul class="bulk-list">
      {#each bulkGroups.slice(0, 5) as group (group.key)}
        <li><code>{group.comm}</code> · {group.tactic}{scopeMode === 'all' ? ` · ${group.host.label}` : ''} <span class="muted">({formatNumber(actionableIncidentIds([group], bulk?.action ?? 'ack').length)})</span></li>
      {/each}
      {#if bulkGroups.length > 5}<li class="muted">and {formatNumber(bulkGroups.length - 5)} more</li>{/if}
    </ul>
    <label class="note">
      <span class="field-label">Note (optional)</span>
      <textarea class="input" rows="3" maxlength={NOTE_MAX_LENGTH} bind:value={note} disabled={bulkRunning}></textarea>
      <span class="hint">Stored with each incident's entry in the project Audit log, next to who changed it and when.</span>
    </label>
    {#if bulkRunning}
      <p role="status">Updating {formatNumber(bulkProgress.done)} of {formatNumber(bulkProgress.total)}…</p>
    {/if}
    {#if bulkFailures.length}
      <Alert tone="error" title={`${formatNumber(bulkFailures.length)} incident${bulkFailures.length === 1 ? '' : 's'} not changed`} message={bulkFailures[0].error} compact />
    {/if}
  </div>
</ConfirmModal>

<ConfirmModal
  open={resolveOne !== null}
  title="Resolve this incident?"
  message={resolveOne ? `Closes the ${resolveOne.technique_id || 'unmapped'} incident of ${resolveOne.comm || 'an unknown process'}. A new incident opens if the activity is observed again.` : ''}
  confirmLabel="Resolve"
  tone="warning"
  loading={resolveOne ? incidentBusy.includes(resolveOne.id) : false}
  onconfirm={confirmResolveOne}
  onclose={() => (resolveOne = null)}
/>

<style>
  .triage { display: grid; gap: var(--sp-6); min-width: 0; }
  .queue { display: grid; gap: var(--sp-3); min-width: 0; }
  .queue-head { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: var(--sp-3); }
  .section-title { margin: 0; font-size: var(--fs-md); font-weight: var(--fw-semibold); }
  .caption { margin: var(--sp-1) 0 0; font-size: var(--fs-xs); color: var(--text-muted); max-width: 72ch; }
  .filters { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--sp-3); }
  .segmented { display: inline-flex; border: 1px solid var(--border-strong); border-radius: var(--radius); padding: calc(var(--sp-1) / 2); margin: 0; gap: calc(var(--sp-1) / 2); }
  .segmented label { position: relative; padding: var(--sp-1) var(--sp-3); border-radius: var(--radius); font-size: var(--fs-sm); color: var(--text-secondary); cursor: pointer; }
  .segmented label.active { background: var(--accent-soft); color: var(--text-primary); }
  .segmented input { position: absolute; inset: 0; opacity: 0; margin: 0; cursor: pointer; }
  .segmented label:has(input:focus-visible) { outline: var(--ring-width) solid var(--ring-color); outline-offset: 2px; }
  .field { display: grid; gap: var(--sp-1); }
  .field-label { font-size: var(--fs-xs); color: var(--text-muted); }
  .field :global(.status-filter) { min-width: 9rem; }
  .input { padding: var(--sp-1) var(--sp-2); border: 1px solid var(--border-strong); border-radius: var(--radius); background: var(--surface-input); color: var(--text-primary); font-size: var(--fs-sm); }
  textarea.input { width: 100%; resize: vertical; }
  .bulk-bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-card); }
  .bulk-actions { display: flex; flex-wrap: wrap; gap: var(--sp-2); }
  .check { display: inline-flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm); color: var(--text-secondary); }
  .muted { color: var(--text-muted); font-size: var(--fs-xs); }
  .block { display: block; }
  .num { font-variant-numeric: tabular-nums; }
  code { font-size: var(--fs-xs); }
  .group-detail { display: grid; gap: var(--sp-3); padding: var(--sp-2) 0; min-width: 0; }
  .group-facts { display: grid; gap: var(--sp-2); }
  .sample { margin: 0; font-size: var(--fs-sm); color: var(--text-secondary); }
  .group-facts dl { display: flex; flex-wrap: wrap; gap: var(--sp-2) var(--sp-5); margin: 0; font-size: var(--fs-xs); }
  .group-facts dt { color: var(--text-muted); }
  .group-facts dd { margin: 0; color: var(--text-primary); }
  .group-links { display: flex; flex-wrap: wrap; gap: var(--sp-2); }
  .incident-table { width: 100%; border-collapse: collapse; font-size: var(--fs-xs); }
  .incident-table th, .incident-table td { padding: var(--sp-1) var(--sp-2); border-top: 1px solid var(--border); text-align: left; vertical-align: middle; }
  .incident-table .right { text-align: right; }
  .nowrap { white-space: nowrap; }
  .sample-line { max-width: 28rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row-actions { white-space: nowrap; text-align: right; }
  tr.highlight td { background: var(--accent-soft); }
  .triage :global(tr.highlight > td), .triage :global(tr.highlight > th) { background: var(--accent-soft); }
  .bulk-body { display: grid; gap: var(--sp-2); font-size: var(--fs-sm); }
  .bulk-body p { margin: 0; }
  .bulk-list { margin: 0; padding-left: var(--sp-5); display: grid; gap: calc(var(--sp-1) / 2); }
  .note { display: grid; gap: var(--sp-1); }
  .hint { font-size: var(--fs-xs); color: var(--text-muted); }
  @media (max-width: 640px) { .incident-table { display: block; overflow-x: auto; } }
</style>
