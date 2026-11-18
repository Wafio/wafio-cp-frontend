<!--
  ExploreView: the one runtime events explorer: runtime events
  or enforcement actions of the selected host, filtered on the server by the
  page time range and minimum severity, faceted and searched over the loaded
  window, paged with keyed rows and a detail drawer. Live rows wait in a
  "Show N new" banner so the table never shifts under the pointer.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import {
    clearEnforcementLog,
    getEnforcementLog,
    getTraceEvents,
    type EnforcementLogEntry,
    type TraceEvent,
  } from '#lib/api.js';
  import { formatDateTime, formatNumber } from '#lib/format.js';
  import { createLifecycle, type HostScope } from '#lib/host-scope.svelte.js';
  import { enforcementTone, severityTone } from '#lib/tone.js';
  import { toast } from '#lib/stores/toast.js';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import ConfirmModal from '#lib/components/ui/ConfirmModal.svelte';
  import DataTable from '#lib/components/ui/DataTable.svelte';
  import DateTime from '#lib/components/ui/DateTime.svelte';
  import Drawer from '#lib/components/ui/Drawer.svelte';
  import Select from '#lib/components/ui/Select.svelte';
  import { timeRangeLabel, timeRangeMinutes, type TimeRangeKey } from '#lib/components/ui/time-range.js';
  import type { DataTableColumn } from '#lib/components/ui/types.js';
  import FacetList from './FacetList.svelte';
  import TraceEventDetail from './TraceEventDetail.svelte';
  import type { LiveBuffer } from './live.svelte';
  import {
    ENFORCEMENT_FACETS,
    EXPLORE_PAGE_SIZE,
    MIN_SEVERITY_OPTIONS,
    TRACE_FACETS,
    WINDOW_CAP,
    WINDOW_INITIAL,
    WINDOW_STEP,
    computeFacets,
    dedupeByKey,
    enforcementEntryKey,
    enforcementFacetValues,
    enforcementMatchesSearch,
    enforcementModeLabel,
    eventActionName,
    filterEnforcement,
    filterTraceEvents,
    meetsMinSeverity,
    mergeNewest,
    nextWindow,
    sortNewestFirst,
    timeOf,
    traceEventKey,
    traceFacetValues,
    traceMatchesSearch,
    uidLabel,
    windowCanGrow,
    type EnforcementFacet,
    type FacetFilters,
    type TraceFacet,
  } from './explore';
  import type { ExploreSource, RuntimeUrlPatch } from './url';

  let {
    projectId,
    scope,
    range,
    source,
    minSeverity,
    traceFilters,
    enforcementFilters,
    liveTrace,
    liveEnforcement,
    streaming = false,
    canConfigure = false,
    enforcementClearedAt = null,
    onnavigate,
    oncleared,
    onsuppress,
    onnewpolicy,
  }: {
    projectId: string;
    scope: HostScope;
    range: TimeRangeKey;
    source: ExploreSource;
    minSeverity: string;
    traceFilters: FacetFilters<TraceFacet>;
    enforcementFilters: FacetFilters<EnforcementFacet>;
    liveTrace: LiveBuffer<TraceEvent>;
    liveEnforcement: LiveBuffer<EnforcementLogEntry>;
    /** The live stream is open. */
    streaming?: boolean;
    canConfigure?: boolean;
    /** Enforcement records before this time were cleared (hide late arrivals). */
    enforcementClearedAt?: string | null;
    /** Updates the URL: `replace` for filter changes, push for source changes. */
    onnavigate: (patch: RuntimeUrlPatch, replace?: boolean) => void;
    oncleared: (clearedAt: string) => void;
    onsuppress: (event: TraceEvent) => void;
    onnewpolicy: (event: TraceEvent) => void;
  } = $props();

  const life = createLifecycle();
  // The view is keyed per host: it lives within one scope epoch.
  const hostEpoch = untrack(() => scope.epoch);
  const noPermission = 'Requires the member or owner role';

  let traceRows = $state.raw<TraceEvent[]>([]);
  let enforcementRows = $state.raw<EnforcementLogEntry[]>([]);
  let windowLimit = $state(WINDOW_INITIAL);
  let returned = $state(0);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let offset = $state(0);
  let search = $state('');
  let selected = $state<{ event: TraceEvent; entry?: EnforcementLogEntry } | null>(null);
  let confirmClear = $state(false);
  let clearing = $state(false);
  let requestSeq = 0;

  function stale(epoch: number): boolean {
    return life.destroyed || scope.isStale(epoch);
  }

  function afterClear(entry: EnforcementLogEntry): boolean {
    return !enforcementClearedAt || timeOf(entry.timestamp) >= timeOf(enforcementClearedAt);
  }

  async function load(keepOffset = false) {
    const seq = ++requestSeq;
    const epoch = hostEpoch;
    if (stale(epoch)) return;
    loading = true;
    error = null;
    const minutes = timeRangeMinutes(range) ?? undefined;
    const limit = windowLimit;
    if (source === 'events') {
      const res = await getTraceEvents(projectId, limit, minSeverity || undefined, scope.agentId, scope.hostId, minutes);
      if (seq !== requestSeq || stale(epoch)) return;
      loading = false;
      if (res.error || !res.data) {
        error = res.error?.error ?? 'Runtime events could not be loaded.';
        return;
      }
      returned = res.data.length;
      traceRows = dedupeByKey(sortNewestFirst(res.data, (e) => e.timestamp), traceEventKey);
      liveTrace.clear();
    } else {
      const res = await getEnforcementLog(projectId, limit, scope.agentId, scope.hostId, minutes);
      if (seq !== requestSeq || stale(epoch)) return;
      loading = false;
      if (res.error || !res.data) {
        error = res.error?.error ?? 'Enforcement actions could not be loaded.';
        return;
      }
      returned = res.data.length;
      enforcementRows = dedupeByKey(sortNewestFirst(res.data.filter(afterClear), (e) => e.timestamp), enforcementEntryKey);
      liveEnforcement.clear();
    }
    if (!keepOffset) offset = 0;
  }

  // Server query: source, time range and minimum severity. Reset the window.
  $effect(() => {
    void source;
    void range;
    void minSeverity;
    untrack(() => {
      windowLimit = WINDOW_INITIAL;
      selected = null;
      void load();
    });
  });

  // Client filters: back to the first page.
  $effect(() => {
    void JSON.stringify(source === 'events' ? traceFilters : enforcementFilters);
    void search;
    untrack(() => {
      offset = 0;
    });
  });

  const traceFacetIds = TRACE_FACETS.map((f) => f.id);
  const enforcementFacetIds = ENFORCEMENT_FACETS.map((f) => f.id);

  const filteredTrace = $derived(source === 'events' ? filterTraceEvents(traceRows, traceFilters, search) : []);
  const filteredEnforcement = $derived(source === 'enforcement' ? filterEnforcement(enforcementRows, enforcementFilters, search) : []);
  const traceFacets = $derived(
    source === 'events' ? computeFacets(traceRows, traceFacetIds, traceFilters, traceFacetValues, (e) => traceMatchesSearch(e, search)) : null,
  );
  const enforcementFacets = $derived(
    source === 'enforcement'
      ? computeFacets(enforcementRows, enforcementFacetIds, enforcementFilters, enforcementFacetValues, (e) => enforcementMatchesSearch(e, search))
      : null,
  );

  const filteredCount = $derived(source === 'events' ? filteredTrace.length : filteredEnforcement.length);
  const loadedCount = $derived(source === 'events' ? traceRows.length : enforcementRows.length);
  const canGrow = $derived(windowCanGrow(returned, windowLimit));
  const tracePage = $derived(filteredTrace.slice(offset, offset + EXPLORE_PAGE_SIZE));
  const enforcementPage = $derived(filteredEnforcement.slice(offset, offset + EXPLORE_PAGE_SIZE));
  const hasMore = $derived(offset + EXPLORE_PAGE_SIZE < filteredCount);

  const pendingTrace = $derived(liveTrace.pending.filter((e) => meetsMinSeverity(e, minSeverity)));
  const pendingEnforcement = $derived(liveEnforcement.pending.filter(afterClear));
  const pendingCount = $derived(source === 'events' ? pendingTrace.length : pendingEnforcement.length);

  const activeFilters = $derived(
    Object.entries(source === 'events' ? traceFilters : enforcementFilters).filter(([, value]) => Boolean(value)) as Array<[string, string]>,
  );

  function changePage(next: number) {
    const lastPageStart = Math.max(0, Math.floor(Math.max(0, filteredCount - 1) / EXPLORE_PAGE_SIZE) * EXPLORE_PAGE_SIZE);
    offset = Math.max(0, Math.min(next, lastPageStart));
  }

  /** Grows the server window (the endpoints take a limit, not an offset) and keeps the current page. */
  async function loadOlder() {
    if (!canGrow || loading) return;
    windowLimit = nextWindow(windowLimit, windowLimit + WINDOW_STEP);
    await load(true);
  }

  function showPending() {
    if (source === 'events') {
      const rows = liveTrace.take().filter((e) => meetsMinSeverity(e, minSeverity));
      traceRows = mergeNewest(rows, traceRows, traceEventKey, WINDOW_CAP);
    } else {
      const rows = liveEnforcement.take().filter(afterClear);
      enforcementRows = mergeNewest(rows, enforcementRows, enforcementEntryKey, WINDOW_CAP);
    }
    offset = 0;
  }

  function setFacet(facet: string, value: string | undefined) {
    if (source === 'events') onnavigate({ traceFilters: { ...traceFilters, [facet]: value } }, true);
    else onnavigate({ enforcementFilters: { ...enforcementFilters, [facet]: value } }, true);
  }

  function clearFilters() {
    search = '';
    if (source === 'events') onnavigate({ traceFilters: {} }, true);
    else onnavigate({ enforcementFilters: {} }, true);
  }

  function changeSource(next: ExploreSource) {
    if (next === source) return;
    search = '';
    onnavigate({ source: next, traceFilters: {}, enforcementFilters: {}, minSeverity: '' }, false);
  }

  function facetLabel(facet: string): string {
    return [...TRACE_FACETS, ...ENFORCEMENT_FACETS].find((f) => f.id === facet)?.label ?? facet;
  }

  async function doClear() {
    if (!canConfigure) return;
    const epoch = hostEpoch;
    clearing = true;
    const res = await clearEnforcementLog(projectId, scope.agentId, scope.hostId);
    if (stale(epoch)) return;
    clearing = false;
    if (res.error) {
      toast.error(res.error.error || 'The enforcement log could not be cleared.', 'Log not cleared');
      return;
    }
    confirmClear = false;
    oncleared(res.data?.cleared_at ?? new Date().toISOString());
    enforcementRows = [];
    liveEnforcement.clear();
    offset = 0;
    toast.success('New enforcement actions appear as policies act.', 'Enforcement log cleared');
  }

  const traceColumns: DataTableColumn<TraceEvent>[] = [
    { key: 'time', label: 'Time', nowrap: true, width: '11rem' },
    { key: 'severity', label: 'Severity', nowrap: true },
    { key: 'event', label: 'Event', rowHeader: true },
    { key: 'process', label: 'Process' },
    { key: 'pid', label: 'PID', align: 'right' },
    { key: 'uid', label: 'UID', align: 'right', nowrap: true },
    { key: 'action', label: 'Policy action', nowrap: true },
    { key: 'description', label: 'Description' },
  ];

  const enforcementColumns: DataTableColumn<EnforcementLogEntry>[] = [
    { key: 'time', label: 'Time', nowrap: true, width: '11rem' },
    { key: 'policy', label: 'Policy', rowHeader: true },
    { key: 'action', label: 'Action', nowrap: true },
    { key: 'mode', label: 'Where enforced', nowrap: true },
    { key: 'result', label: 'Result' },
    { key: 'process', label: 'Process' },
    { key: 'event', label: 'Event' },
  ];

  const rangeText = $derived(range === 'all' ? 'all retained history' : timeRangeLabel(range).toLowerCase());
  const noun = $derived(source === 'events' ? 'events' : 'enforcement actions');
</script>

<div class="explore">
  <div class="toolbar">
    <fieldset class="source">
      <legend class="sr-only">Data</legend>
      <label class:active={source === 'events'}>
        <input type="radio" name="explore-source" value="events" checked={source === 'events'} onchange={() => changeSource('events')} />
        <span>Runtime events</span>
      </label>
      <label class:active={source === 'enforcement'}>
        <input type="radio" name="explore-source" value="enforcement" checked={source === 'enforcement'} onchange={() => changeSource('enforcement')} />
        <span>Enforcement actions</span>
      </label>
    </fieldset>

    <label class="field">
      <span class="field-label">{source === 'events' ? 'Search process, file, address, PID or UID' : 'Search policy, process or reason'}</span>
      <input class="input" type="search" bind:value={search} />
    </label>

    {#if source === 'events'}
      <div class="field">
        <label class="field-label" for="explore-min-severity">Minimum severity</label>
        <Select id="explore-min-severity" class="severity-filter" size="sm" options={MIN_SEVERITY_OPTIONS} value={minSeverity} onchange={(next) => onnavigate({ minSeverity: next }, true)} />
      </div>
    {/if}

    <div class="toolbar-end">
      <Button variant="secondary" size="sm" onclick={() => load()} loading={loading} disabled={loading}>Refresh</Button>
      {#if source === 'enforcement' && enforcementClearedAt}
        <span class="muted">Cleared <DateTime value={enforcementClearedAt} relative /></span>
      {/if}
      {#if source === 'enforcement'}
        <Button variant="danger" size="sm" disabled={!canConfigure || clearing} title={canConfigure ? 'Permanently delete the enforcement log of this host' : noPermission} onclick={() => (confirmClear = true)}>Clear log…</Button>
      {/if}
    </div>
  </div>

  {#if pendingCount > 0}
    <div class="live-banner" role="status">
      <span>{formatNumber(pendingCount)} new {noun} since this list loaded.</span>
      <Button variant="secondary" size="sm" onclick={showPending}>Show new {noun}</Button>
    </div>
  {:else if !streaming}
    <p class="hint">Live updates are off; use Refresh to load newer {noun}.</p>
  {/if}

  {#if activeFilters.length > 0 || search}
    <div class="chips" aria-label="Active filters">
      {#each activeFilters as [facet, value] (facet)}
        <button type="button" class="chip" onclick={() => setFacet(facet, undefined)} aria-label={`Remove filter ${facetLabel(facet)}: ${value}`}>
          <span class="chip-key">{facetLabel(facet)}</span> {value} <span aria-hidden="true">×</span>
        </button>
      {/each}
      {#if search}<span class="chip static"><span class="chip-key">Search</span> {search}</span>{/if}
      <Button variant="ghost" size="sm" onclick={clearFilters}>Clear filters</Button>
    </div>
  {/if}

  <div class="layout">
    <aside class="facets" aria-label="Facets">
      <details open>
        <summary>Facets <span class="muted">over {formatNumber(loadedCount)} loaded {noun}</span></summary>
        <div class="facet-stack">
          {#if source === 'events' && traceFacets}
            {#each TRACE_FACETS as facet (facet.id)}
              <FacetList
                label={facet.label}
                hint={facet.hint}
                values={traceFacets[facet.id]}
                active={traceFilters[facet.id]}
                mono={facet.id === 'event' || facet.id === 'process'}
                ontoggle={(value) => setFacet(facet.id, value)}
              />
            {/each}
          {:else if enforcementFacets}
            {#each ENFORCEMENT_FACETS as facet (facet.id)}
              <FacetList
                label={facet.label}
                values={enforcementFacets[facet.id]}
                active={enforcementFilters[facet.id]}
                ontoggle={(value) => setFacet(facet.id, value)}
              />
            {/each}
          {/if}
        </div>
      </details>
    </aside>

    <div class="results">
      <p class="window-note">
        Newest {formatNumber(loadedCount)} {noun} from {rangeText}{source === 'events' && minSeverity ? `, ${minSeverity} severity and above` : ''}.
        Facets and search apply to these loaded rows.
        {#if !canGrow && returned >= WINDOW_CAP}The server returns at most {formatNumber(WINDOW_CAP)} rows: narrow the time range{source === 'events' ? ' or raise the minimum severity' : ''} to reach older ones.{/if}
        {#if canGrow}
          <Button variant="ghost" size="sm" onclick={loadOlder} disabled={loading}>Load {formatNumber(Math.min(WINDOW_STEP, WINDOW_CAP - windowLimit))} older {noun}</Button>
        {/if}
      </p>

      {#if source === 'events'}
        <DataTable
          rows={tracePage}
          columns={traceColumns}
          rowKey={traceEventKey}
          caption="Runtime events"
          itemLabel="events"
          density="compact"
          {loading}
          {error}
          onretry={() => load()}
          emptyTitle={activeFilters.length || search ? 'No events match these filters' : 'No runtime events in this window'}
          emptyMessage={activeFilters.length || search ? 'Remove a filter or widen the search.' : `No events were captured in ${rangeText}. Capture loss can hide activity; check the Agent tab.`}
          onpage={changePage}
          {offset}
          limit={EXPLORE_PAGE_SIZE}
          total={filteredCount}
          {hasMore}
          onrowclick={(row) => (selected = { event: row })}
          rowClass={(row) => (row.severity_name === 'critical' || row.severity_name === 'high' ? `sev-row sev-row-${row.severity_name}` : undefined)}
        >
          {#snippet cell(row, column)}
            {#if column.key === 'time'}
              <DateTime value={row.timestamp} seconds />
            {:else if column.key === 'severity'}
              <Badge tone={severityTone(row.severity_name || row.severity)}>{row.severity_name || 'unknown'}</Badge>
            {:else if column.key === 'event'}
              <code>{row.event_name}</code> <span class="muted">{row.category}</span>
            {:else if column.key === 'process'}
              <code>{row.comm || 'n/a'}</code>{#if row.is_container}<span class="muted"> · container</span>{/if}
            {:else if column.key === 'pid'}
              <span class="mono">{row.pid}</span>
            {:else if column.key === 'uid'}
              <span class="mono">{uidLabel(row.uid)}</span>
            {:else if column.key === 'action'}
              {#if eventActionName(row) === 'monitor'}
                <span class="muted" title="No policy acted on this event">monitor</span>
              {:else}
                <Badge tone={enforcementTone(eventActionName(row))}>{eventActionName(row)}</Badge>
              {/if}
            {:else if column.key === 'description'}
              <span class="clip" title={row.description || row.filename || ''}>{row.description || row.filename || 'n/a'}</span>
            {/if}
          {/snippet}
          {#snippet actions(row)}
            <Button variant="ghost" size="sm" aria-label={`Details of ${row.event_name} by ${row.comm || 'unknown process'} at ${formatDateTime(row.timestamp, { seconds: true })}`} onclick={() => (selected = { event: row })}>Details</Button>
          {/snippet}
        </DataTable>
      {:else}
        <DataTable
          rows={enforcementPage}
          columns={enforcementColumns}
          rowKey={enforcementEntryKey}
          caption="Enforcement actions"
          itemLabel="actions"
          density="compact"
          {loading}
          {error}
          onretry={() => load()}
          emptyTitle={activeFilters.length || search ? 'No actions match these filters' : 'No enforcement actions in this window'}
          emptyMessage={activeFilters.length || search ? 'Remove a filter or widen the search.' : 'Actions appear here when policies alert, simulate or kill.'}
          onpage={changePage}
          {offset}
          limit={EXPLORE_PAGE_SIZE}
          total={filteredCount}
          {hasMore}
          onrowclick={(row) => row.event && (selected = { event: row.event, entry: row })}
        >
          {#snippet cell(row, column)}
            {#if column.key === 'time'}
              <DateTime value={row.timestamp} seconds />
            {:else if column.key === 'policy'}
              {row.policy_name || 'Unnamed policy'} <span class="muted">#{row.policy_id}</span>
            {:else if column.key === 'action'}
              <Badge tone={enforcementTone(row.action)}>{row.action}</Badge>
            {:else if column.key === 'mode'}
              {enforcementModeLabel(row.mode)}
            {:else if column.key === 'result'}
              <span class={row.success ? '' : 'failed'}>{row.event?.signal_outcome || (row.success ? 'Accepted' : 'Failed')}</span>
              {#if !row.success && row.failure_reason}<span class="muted"> · {row.failure_reason}</span>{/if}
            {:else if column.key === 'process'}
              <code>{row.event?.comm || 'n/a'}</code> <span class="muted">PID {row.event?.pid ?? 'n/a'}</span>
            {:else if column.key === 'event'}
              <code>{row.event?.event_name || 'n/a'}</code>
            {/if}
          {/snippet}
          {#snippet actions(row)}
            <Button variant="ghost" size="sm" disabled={!row.event} aria-label={`Details of ${row.action} by ${row.policy_name || 'policy'} at ${formatDateTime(row.timestamp, { seconds: true })}`} onclick={() => row.event && (selected = { event: row.event, entry: row })}>Details</Button>
          {/snippet}
        </DataTable>
      {/if}
    </div>
  </div>
</div>

<Drawer open={selected !== null} title={selected?.entry ? 'Enforcement action' : 'Runtime event'} size="lg" onclose={() => (selected = null)}>
  {#if selected}
    <TraceEventDetail
      event={selected.event}
      entry={selected.entry}
      {canConfigure}
      onfilterprocess={source === 'events'
        ? (comm) => {
            selected = null;
            setFacet('process', comm);
          }
        : undefined}
      onsuppress={(event) => {
        selected = null;
        onsuppress(event);
      }}
      onnewpolicy={(event) => {
        selected = null;
        onnewpolicy(event);
      }}
    />
  {/if}
</Drawer>

<ConfirmModal
  open={confirmClear}
  title="Clear the enforcement log?"
  message="Every stored enforcement record of this host is deleted; the agent is asked to drop its in-memory copy when it can be reached. Policies keep running, and the audit log records who cleared the log."
  confirmLabel="Clear log"
  tone="danger"
  loading={clearing}
  onconfirm={doClear}
  onclose={() => (confirmClear = false)}
/>

<style>
  .explore { display: grid; gap: var(--sp-3); min-width: 0; }
  .toolbar { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--sp-3); }
  .toolbar-end { margin-left: auto; display: flex; gap: var(--sp-2); align-items: center; }
  .source { display: inline-flex; border: 1px solid var(--border-strong); border-radius: var(--radius); padding: calc(var(--sp-1) / 2); margin: 0; gap: calc(var(--sp-1) / 2); }
  .source label { position: relative; padding: var(--sp-1) var(--sp-3); border-radius: var(--radius); font-size: var(--fs-sm); color: var(--text-secondary); cursor: pointer; }
  .source label.active { background: var(--accent-soft); color: var(--text-primary); }
  .source input { position: absolute; opacity: 0; inset: 0; margin: 0; cursor: pointer; }
  .source label:has(input:focus-visible) { outline: var(--ring-width) solid var(--ring-color); outline-offset: 2px; }
  .field { display: grid; gap: var(--sp-1); min-width: 0; }
  .field-label { font-size: var(--fs-xs); color: var(--text-muted); }
  .field :global(.severity-filter) { min-width: 12rem; }
  .input { min-width: 12rem; padding: var(--sp-1) var(--sp-2); border: 1px solid var(--border-strong); border-radius: var(--radius); background: var(--surface-input); color: var(--text-primary); font-size: var(--fs-sm); }
  .live-banner { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); border: 1px solid var(--border); border-left: 3px solid var(--info); border-radius: var(--radius); background: var(--bg-card); font-size: var(--fs-sm); color: var(--text-secondary); }
  .hint, .window-note { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
  .chips { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); }
  .chip { display: inline-flex; align-items: center; gap: var(--sp-1); padding: calc(var(--sp-1) / 2) var(--sp-2); border: 1px solid var(--border-strong); border-radius: var(--radius); background: var(--bg-card); color: var(--text-primary); font-size: var(--fs-xs); cursor: pointer; }
  .chip.static { cursor: default; }
  .chip-key { color: var(--text-muted); }
  .layout { display: grid; grid-template-columns: minmax(12rem, 15rem) minmax(0, 1fr); gap: var(--sp-4); align-items: start; }
  .facets { min-width: 0; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-card); padding: var(--sp-3); }
  .facets summary { cursor: pointer; font-size: var(--fs-sm); font-weight: var(--fw-semibold); color: var(--text-primary); }
  .facets .muted { display: block; font-weight: 400; }
  .facet-stack { display: grid; gap: var(--sp-4); margin-top: var(--sp-3); }
  .results { display: grid; gap: var(--sp-2); min-width: 0; }
  .muted { color: var(--text-muted); font-size: var(--fs-xs); }
  .mono { font-family: var(--font-mono); font-size: var(--fs-xs); }
  code { font-size: var(--fs-xs); }
  .clip { display: inline-block; max-width: 28rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; }
  .failed { color: var(--danger); }
  .results :global(.sev-row-critical > td:first-child) { box-shadow: inset 3px 0 0 var(--sev-critical); }
  .results :global(.sev-row-high > td:first-child) { box-shadow: inset 3px 0 0 var(--sev-high); }
  @media (max-width: 900px) {
    .layout { grid-template-columns: minmax(0, 1fr); }
    .toolbar-end { margin-left: 0; }
    .input { min-width: 0; width: 100%; }
    .field :global(.severity-filter) { min-width: 0; }
    .field { flex: 1 1 12rem; }
  }
</style>
