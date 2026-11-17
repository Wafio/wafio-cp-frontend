<!--
  DecisionFeed: stored WAF decisions of one application, newest first, with
  the filters in the URL (the page owns them through `filter` /
  `onfilterchange`), a column chooser (8 of 13 columns by default: country and attack categories
  included; the response status is optional), a
  keyboard-operable detail drawer, cursor paging inside the page's time range
  (from_ts/to_ts, next_cursor, total capped at 10,000), and live
  updates (on by default): the ticket-authenticated decision stream with
  ?app_id= sends a `stored` signal (at most one per 2 s) once decisions of this
  app are written, and the feed then fetches only the rows newer than the
  newest it shows, with the filters applied by the server. A burst of traffic
  costs one small query per 2 s, not one event per decision.
-->
<script lang="ts">
  import { countryFlag } from '#lib/geo.js';
  import Select from '#lib/components/ui/Select.svelte';
  import { untrack } from 'svelte';
  import { getAppWAFDecisions, type WAFDecisionRow } from '#lib/api.js';
  import { createProjectEventStream, type SSEConnection, type SSEConnectionState } from '#lib/sse.js';
  import { createPoller } from '#lib/polling.svelte.js';
  import { Badge, Button, DataTable, DateTime, InlineError, StatusDot, TimeRangePicker, type DataTableColumn, type StatusKind } from '#lib/components/ui/index.js';
  import { timeRangeLabel, type TimeRangeKey } from '#lib/components/ui/time-range.js';
  import { isIP } from '#lib/validation.js';
  import {
    currentCursor,
    decisionKey,
    decisionsErrorMessage,
    decisionsWindow,
    emptyDecisionsText,
    firstCursorPage,
    formatDecisionTotal,
    mergeNewer,
    newerReadFrom,
    newerReadWindow,
    nextCursorPage,
    prevCursorPage,
    type CursorPages,
  } from './decision-paging';
  import { actionTone, strengthTone } from '#lib/tone.js';
  import { formatDateTime, formatDuration } from '#lib/format.js';
  import {
    EMPTY_FEED_FILTER,
    FEED_ACTIONS,
    FEED_SOURCES,
    feedFilterActive,
    isWSDecision,
    normalizeFeedFilter,
    type FeedFilter,
  } from '#lib/waf-live.js';
  import DecisionDrawer from './DecisionDrawer.svelte';
  import { METHOD_OPTIONS, actionLabel, analyzeMethodLabel, categoryOptions, enginesLogOnlyOf, enginesLogOnlyText, enginesOffOf, enginesOffText, statusLabel, strengthLabel } from './decision-format';

  let {
    projectId,
    appId,
    filter,
    onfilterchange,
    range,
    onrangechange,
    canConfigure = false,
    countries = undefined,
  }: {
    projectId: string;
    appId: string;
    filter: FeedFilter;
    onfilterchange: (filter: FeedFilter) => void;
    /** The page's time range (shared with Monitoring); bounds the stored feed. */
    range: TimeRangeKey;
    onrangechange: (range: TimeRangeKey) => void;
    canConfigure?: boolean;
    /** IP → country code from the geo lookup, for rows without one. */
    countries?: Map<string, string>;
  } = $props();

  const PAGE_SIZE = 25;
  /** The longest range the feed can read (the server caps a window at 30 days). */
  const WIDEST_RANGE: TimeRangeKey = '30d';
  const REFRESH_MS = 30_000;
  /** Full reload while live updates arrive: keeps the total and the range edge current. */
  const LIVE_REFRESH_MS = 120_000;
  /** Page 1 grows by live rows up to this many rows, then it is reloaded. */
  const MAX_LIVE_ROWS = PAGE_SIZE * 4;
  /** How long a row that arrived live stays highlighted. */
  const FRESH_MS = 10_000;

  // ── Columns ─────────────────────────────────────────────────────────────
  type ColumnKey = 'time' | 'action' | 'method' | 'uri' | 'client' | 'strength' | 'host' | 'country' | 'detection' | 'payload' | 'categories' | 'latency' | 'status';
  const ALL_COLUMNS: { key: ColumnKey; label: string; fixed?: boolean }[] = [
    { key: 'time', label: 'Time', fixed: true },
    { key: 'action', label: 'Action', fixed: true },
    { key: 'method', label: 'Method' },
    { key: 'uri', label: 'URI', fixed: true },
    { key: 'client', label: 'Client IP' },
    { key: 'country', label: 'Country' },
    { key: 'categories', label: 'Categories' },
    { key: 'strength', label: 'Strength' },
    { key: 'host', label: 'Host' },
    { key: 'detection', label: 'Detection method' },
    { key: 'payload', label: 'Payload' },
    { key: 'latency', label: 'Latency' },
    { key: 'status', label: 'Response status' },
  ];
  const DEFAULT_COLUMNS: ColumnKey[] = ['time', 'action', 'method', 'uri', 'client', 'country', 'categories', 'strength'];
  // v3: strength replaced the score column; a choice saved under an older key
  // predates it and would keep it hidden.
  const COLUMNS_STORAGE = 'wafio.appDecisions.columns.v3';

  function loadColumns(): ColumnKey[] {
    try {
      const raw = localStorage.getItem(COLUMNS_STORAGE);
      const parsed = raw ? (JSON.parse(raw) as unknown) : null;
      if (Array.isArray(parsed)) {
        const keys = parsed.filter((k): k is ColumnKey => ALL_COLUMNS.some((c) => c.key === k));
        if (keys.length) return [...new Set([...ALL_COLUMNS.filter((c) => c.fixed).map((c) => c.key), ...keys])];
      }
    } catch {
      // Storage unavailable (private window, blocked site data): defaults.
    }
    return [...DEFAULT_COLUMNS];
  }

  let visible = $state<ColumnKey[]>(loadColumns());

  function toggleColumn(key: ColumnKey, on: boolean) {
    visible = on ? [...new Set([...visible, key])] : visible.filter((k) => k !== key);
    try {
      localStorage.setItem(COLUMNS_STORAGE, JSON.stringify(visible));
    } catch {
      // Per-viewer convenience only.
    }
  }

  const ALIGN: Partial<Record<ColumnKey, 'right'>> = { latency: 'right' };
  const columns: DataTableColumn<WAFDecisionRow>[] = $derived(
    ALL_COLUMNS.filter((c) => visible.includes(c.key)).map((c) => ({
      key: c.key,
      label: c.label,
      align: ALIGN[c.key],
      nowrap: c.key !== 'uri' && c.key !== 'categories',
      class: `col-${c.key}`,
    })),
  );

  // ── State ───────────────────────────────────────────────────────────────
  let live = $state(true);
  let streamState = $state<SSEConnectionState | 'off'>('off');
  let streamError = $state('');
  let connection: SSEConnection | null = null;
  /** Keys of rows that arrived live, highlighted for FRESH_MS. */
  let freshKeys = $state<Set<string>>(new Set());

  // ── Stored rows ─────────────────────────────────────────────────────────
  let rows = $state<WAFDecisionRow[]>([]);
  let total = $state(0);
  let totalCapped = $state(false);
  let pages = $state<CursorPages>(firstCursorPage());
  let nextCursor = $state<string | null>(null);
  let ipError = $state('');
  let loading = $state(true);
  let error = $state('');
  let loadedAt = $state<number | null>(null);
  /** Any decision in the longest range, known only while the shown range is empty; null until asked. */
  let anyStored = $state<boolean | null>(null);
  let epoch = 0;

  const f = $derived(normalizeFeedFilter(filter));
  const filterKey = $derived(`${projectId}|${appId}|${f.action}|${f.source}|${f.q}|${f.method}|${f.category}|${f.ip}|${range}`);
  const pageOffset = $derived(pages.index * PAGE_SIZE);

  async function load() {
    const my = ++epoch;
    const project = projectId;
    const app = appId;
    const current = f;
    const cursor = currentCursor(pages);
    if (current.ip && !isIP(current.ip)) {
      // Not worth a round trip: the server would answer 400 WAF_DECISIONS_BAD_IP.
      ipError = decisionsErrorMessage({ error: '', code: 'WAF_DECISIONS_BAD_IP' });
      loading = false;
      rows = [];
      total = 0;
      totalCapped = false;
      nextCursor = null;
      return;
    }
    ipError = '';
    loading = true;
    newerMissed = false;
    const result = await getAppWAFDecisions(project, app, {
      ...decisionsWindow(range),
      cursor,
      action: current.action || undefined,
      source: current.source || undefined,
      ip: current.ip || undefined,
      q: current.q || undefined,
      method: current.method || undefined,
      category: current.category || undefined,
      limit: PAGE_SIZE,
    });
    if (my !== epoch) return;
    loading = false;
    if (result.error) {
      const code = result.error.code;
      if (code === 'WAF_DECISIONS_BAD_CURSOR' && pages.index > 0) {
        // A stale or damaged position: start again from the newest page.
        pages = firstCursorPage();
        error = '';
        void load().then(() => { if (!error) error = decisionsErrorMessage(result.error); });
        return;
      }
      if (code === 'WAF_DECISIONS_BAD_IP') {
        ipError = decisionsErrorMessage(result.error);
        error = '';
        rows = [];
        return;
      }
      error = decisionsErrorMessage(result.error);
      return;
    }
    error = '';
    rows = result.data?.decisions ?? [];
    total = result.data?.total ?? 0;
    totalCapped = result.data?.total_capped === true;
    nextCursor = result.data?.next_cursor ?? null;
    loadedAt = Date.now();
    seenTo = 0;
    if (rows.length > 0) anyStored = true;
    else if (!feedFilterActive(current)) void probeStored(project, app, my);
    if (newerMissed) void fetchNewer();
  }

  /**
   * Whether the application has any decision in the longest range the feed reads. Asked only when the shown range has
   * none, to tell "none in this range" from "none at all".
   */
  async function probeStored(project: string, app: string, mine: number) {
    if (range === WIDEST_RANGE) {
      anyStored = false;
      return;
    }
    const probe = await getAppWAFDecisions(project, app, { ...decisionsWindow(WIDEST_RANGE), limit: 1 });
    if (mine !== epoch) return;
    anyStored = probe.error ? null : (probe.data?.decisions.length ?? 0) > 0;
  }

  // ── Live updates: rows newer than the newest shown ─────────────────────
  let newerBusy = false;
  let newerAgain = false;
  /** A signal arrived while a full load was running; its query may predate the write. */
  let newerMissed = false;
  /**
   * Server time (ms, to_ts) up to which the last newer-row read saw page 1;
   * 0 after a full load, whose window end is the browser's clock. Reads start
   * here, so their window is a few seconds however old the newest row is.
   */
  let seenTo = 0;

  /** Runs one newer-row read at a time; signals during a read queue one more. */
  async function fetchNewer() {
    if (pages.index !== 0) return; // later pages stay put; page 1 catches up when shown again
    if (loading) {
      newerMissed = true;
      return;
    }
    if (newerBusy) {
      newerAgain = true;
      return;
    }
    newerBusy = true;
    try {
      do {
        newerAgain = false;
        await loadNewer();
      } while (newerAgain && pages.index === 0 && !loading);
      if (newerAgain && loading) newerMissed = true; // the full load finishes it
    } finally {
      newerBusy = false;
    }
  }

  async function loadNewer() {
    const my = epoch;
    const current = f;
    if (current.ip && !isIP(current.ip)) return;
    const result = await getAppWAFDecisions(projectId, appId, {
      from_ts: newerReadWindow(newerReadFrom(seenTo, rows[0]), decisionsWindow(range).from_ts),
      action: current.action || undefined,
      source: current.source || undefined,
      ip: current.ip || undefined,
      q: current.q || undefined,
      method: current.method || undefined,
      category: current.category || undefined,
      limit: PAGE_SIZE,
    });
    if (my !== epoch || pages.index !== 0 || loading || result.error || !result.data) return;
    const page = result.data;
    seenTo = Date.parse(page.to_ts) || seenTo;
    const rangeFrom = decisionsWindow(range).from_ts;
    const merged = mergeNewer(rows, nextCursor, page, { rangeFromMs: rangeFrom ? Date.parse(rangeFrom) : 0, maxRows: MAX_LIVE_ROWS });
    switch (merged.kind) {
      case 'none':
        return;
      case 'reload':
        void poller.trigger();
        return;
      case 'replace':
        rows = merged.rows;
        nextCursor = merged.nextCursor;
        if (page.total_capped) totalCapped = true;
        else if (!totalCapped) total += merged.totalDelta;
        break;
      case 'merge':
        rows = merged.rows;
        if (!totalCapped) total += merged.added.length;
        break;
    }
    loadedAt = Date.now();
    markFresh(merged.added.map(rowKey));
  }

  const freshTimers = new Set<ReturnType<typeof setTimeout>>();
  function markFresh(keys: string[]) {
    if (!keys.length) return;
    freshKeys = new Set([...freshKeys, ...keys]);
    const timer = setTimeout(() => {
      freshTimers.delete(timer);
      const next = new Set(freshKeys);
      for (const key of keys) next.delete(key);
      freshKeys = next;
    }, FRESH_MS);
    freshTimers.add(timer);
  }
  $effect(() => () => {
    for (const timer of freshTimers) clearTimeout(timer);
    freshTimers.clear();
  });

  const poller = createPoller(() => load(), REFRESH_MS, { immediate: false });

  // One request per filter/page change; the first run is the initial load.
  let lastKey = '';
  $effect(() => {
    const key = filterKey;
    untrack(() => {
      if (key !== lastKey) {
        lastKey = key;
        epoch++; // drop a response for the previous filter
        pages = firstCursorPage();
        nextCursor = null;
        rows = [];
        // The count and the "updated" line belong to the previous range or filter until the new page is loaded.
        total = 0;
        totalCapped = false;
        loadedAt = null;
        anyStored = null;
        freshKeys = new Set();
      }
      void poller.trigger();
    });
  });

  // Pagination reports offsets; the feed pages by cursor one step at a time.
  function changePage(next: number) {
    const moved = next > pageOffset ? nextCursorPage(pages, nextCursor) : next < pageOffset ? prevCursorPage(pages) : pages;
    if (moved === pages) return;
    epoch++;
    pages = moved;
    void poller.trigger();
  }

  // ── Live updates ────────────────────────────────────────────────────────
  // The stream carries `stored` signals only (?app_id=); rows come from the
  // same endpoint as the page, so filters and the country are the server's.
  $effect(() => {
    if (!live) {
      streamState = 'off';
      return;
    }
    const project = projectId;
    const app = appId;
    // live, projectId and appId drive this effect; nothing else may subscribe it.
    const conn = untrack(() => {
      streamError = '';
      return createProjectEventStream({
        projectId: project,
        stream: 'agent-decisions',
        params: { app_id: app },
        events: {
          stored: () => void fetchNewer(),
        },
        onStateChange: (state) => {
          streamState = state;
          // Catch up on rows written while (re)connecting.
          if (state === 'open') void fetchNewer();
        },
        onFatal: (fatal) => (streamError = fatal.error),
      });
    });
    connection = conn;
    return () => {
      conn.close();
      if (connection === conn) connection = null;
    };
  });

  // Signals keep page 1 current; the full reload only refreshes the total.
  $effect(() => {
    const ms = streamState === 'open' ? LIVE_REFRESH_MS : REFRESH_MS;
    untrack(() => poller.setIntervalMs(ms));
  });

  const liveStatus: StatusKind = $derived(
    streamState === 'open' ? 'online' : streamState === 'connecting' || streamState === 'reconnecting' ? 'pending' : streamState === 'failed' ? 'offline' : 'disabled',
  );
  const liveLabel = $derived(
    streamState === 'open'
      ? 'Live'
      : streamState === 'connecting'
        ? 'Connecting…'
        : streamState === 'reconnecting'
          ? 'Reconnecting…'
          : streamState === 'failed'
            ? 'Live updates unavailable'
            : 'Live off',
  );

  // ── Filters ─────────────────────────────────────────────────────────────
  let searchText = $state(untrack(() => filter.q));
  let ipText = $state(untrack(() => filter.ip ?? ''));
  $effect(() => {
    const ip = f.ip;
    untrack(() => {
      if (ip !== ipText.trim()) ipText = ip;
    });
  });

  function applyIP() {
    const ip = ipText.trim();
    if (ip === f.ip) return;
    setFilter({ ip });
  }
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    // The URL is the source of truth (Back, deep links).
    const q = f.q;
    untrack(() => {
      if (q !== searchText.trim()) searchText = q;
    });
  });
  $effect(() => () => {
    if (searchTimer) clearTimeout(searchTimer);
  });

  function setFilter(patch: Partial<FeedFilter>) {
    onfilterchange(normalizeFeedFilter({ ...f, ...patch }));
  }

  function onSearch(text: string) {
    searchText = text;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => setFilter({ q: text }), 350);
  }

  function resetFilters() {
    if (searchTimer) clearTimeout(searchTimer);
    searchText = '';
    ipText = '';
    onfilterchange({ ...EMPTY_FEED_FILTER });
  }

  const categories = $derived(categoryOptions(rows.flatMap((r) => r.categories ?? []), f.category ? [f.category] : []));
  const active = $derived(feedFilterActive(f));
  const emptyText = $derived(emptyDecisionsText(range, { filtered: active, anyStored }));

  // ── Drawer ──────────────────────────────────────────────────────────────
  let selected = $state<WAFDecisionRow | null>(null);

  const rowKey = (row: WAFDecisionRow): string => decisionKey(row);

  function countryOf(row: WAFDecisionRow): string {
    return (row.country_code || countries?.get(row.remote_addr) || '').toUpperCase();
  }

  function truncate(text: string, n: number): string {
    return text.length > n ? `${text.slice(0, n - 1)}…` : text;
  }
</script>

<section class="feed" aria-labelledby="decision-feed-title">
  <header class="feed-head">
    <div>
      <h2 id="decision-feed-title">Decisions</h2>
      <p class="feed-sub">Stored decisions of the {timeRangeLabel(range).toLowerCase()}, newest first. The range is shared with Monitoring.</p>
    </div>
    <div class="feed-live">
      <TimeRangePicker value={range} onchange={onrangechange} label="Decision time range" />
      <StatusDot status={liveStatus} label={liveLabel} pulse={streamState === 'open'} />
      <label class="switch">
        <input type="checkbox" bind:checked={live} />
        <span>Live updates</span>
      </label>
    </div>
  </header>

  {#if streamError}
    <InlineError message={`Live updates stopped: ${streamError}`} onretry={() => connection?.reconnect()} />
  {/if}

  <div class="feed-toolbar" role="search" aria-label="Filter decisions">
    <div class="feed-search">
      <label class="sr-only" for="decision-search">Search decisions</label>
      <input
        id="decision-search"
        type="search"
        placeholder="Search IP, URI, host, user agent or match detail"
        value={searchText}
        maxlength="256"
        oninput={(event) => onSearch(event.currentTarget.value)}
      />
    </div>
    <div class="seg" role="group" aria-label="Action">
      {#each FEED_ACTIONS as option (option.value)}
        <button type="button" class:active={f.action === option.value} aria-pressed={f.action === option.value} onclick={() => setFilter({ action: option.value })}>{option.label}</button>
      {/each}
    </div>
    <div class="feed-ip">
      <label class="sr-only" for="decision-ip">Client IP (exact)</label>
      <input
        id="decision-ip"
        type="text"
        inputmode="text"
        placeholder="Exact client IP"
        maxlength="64"
        autocomplete="off"
        spellcheck="false"
        bind:value={ipText}
        aria-invalid={ipError ? 'true' : undefined}
        aria-describedby={ipError ? 'decision-ip-error' : undefined}
        onchange={applyIP}
        onkeydown={(event) => { if (event.key === 'Enter') applyIP(); }}
      />
    </div>
    <label class="sr-only" for="decision-source">Source</label>
    <Select id="decision-source" class="feed-select" options={FEED_SOURCES} value={f.source} onchange={(source) => setFilter({ source })} />
    <label class="sr-only" for="decision-method">HTTP method</label>
    <Select id="decision-method" class="feed-select" options={[{ value: '', label: 'All methods' }, ...METHOD_OPTIONS.map((m) => ({ value: m, label: m }))]} value={f.method} onchange={(method) => setFilter({ method })} />
    <label class="sr-only" for="decision-category">Category</label>
    <Select id="decision-category" class="feed-select" options={[{ value: '', label: 'All categories' }, ...categories.map((c) => ({ value: c, label: c }))]} value={f.category} onchange={(category) => setFilter({ category })} />
    {#if active}
      <Button variant="ghost" size="sm" onclick={resetFilters}>Reset filters</Button>
    {/if}
    <details class="columns">
      <summary>Columns</summary>
      <fieldset>
        <legend class="sr-only">Visible columns</legend>
        {#each ALL_COLUMNS as column (column.key)}
          <label>
            <input type="checkbox" checked={visible.includes(column.key)} disabled={column.fixed} onchange={(event) => toggleColumn(column.key, event.currentTarget.checked)} />
            {column.label}
          </label>
        {/each}
      </fieldset>
    </details>
  </div>

  {#if ipError}
    <InlineError id="decision-ip-error" message={ipError} />
  {/if}

  <DataTable
    {rows}
    {columns}
    {rowKey}
    caption="Application decisions"
    manualSort
    {loading}
    error={error || null}
    onretry={() => void poller.trigger()}
    emptyTitle={emptyText.title}
    emptyMessage={emptyText.message}
    onrowclick={(row) => (selected = row)}
    rowClass={(row) => (freshKeys.has(rowKey(row)) ? 'is-new' : undefined)}
    onpage={changePage}
    total={null}
    offset={pageOffset}
    hasMore={nextCursor !== null}
    limit={PAGE_SIZE}
    itemLabel="decisions"
    density="compact"
    actionsLabel="Details"
  >
    {#snippet cell(row, column)}
      {#if column.key === 'time'}
        <DateTime value={row.event_time} seconds />
      {:else if column.key === 'action'}
        {@const logOnly = enginesLogOnlyOf(row)}
        <Badge tone={actionTone(row.action)}>{actionLabel(row.action)}</Badge>{#if logOnly.length > 0}<span class="log-only">{enginesLogOnlyText(logOnly)}</span>{/if}
      {:else if column.key === 'method'}
        <span class="mono">{row.method}</span>{#if isWSDecision(row)}<span class="ws" title={`WebSocket (${row.match_source || 'ws'})`}> WS</span>{/if}
      {:else if column.key === 'uri'}
        <code class="uri" title={row.uri}>{truncate(row.uri, 72)}</code>
      {:else if column.key === 'client'}
        <span class="mono">{row.remote_addr || 'n/a'}</span>
      {:else if column.key === 'strength'}
        {#if row.strength}<Badge tone={strengthTone(row.strength)}>{strengthLabel(row.strength)}</Badge>{:else}n/a{/if}
      {:else if column.key === 'host'}
        <span class="mono">{row.host || 'n/a'}</span>
      {:else if column.key === 'country'}
        {@const code = countryOf(row)}
        {#if code}<span class="country" title={code}><span aria-hidden="true">{countryFlag(code)}</span> {code}</span>{:else}n/a{/if}
      {:else if column.key === 'detection'}
        {@const off = enginesOffOf(row)}
        {analyzeMethodLabel(row.analyze_method)}{#if off.length > 0} <span class="engines-off" title={enginesOffText(off)}>{off.length === 1 ? '1 engine off' : `${off.length} engines off`}<span class="sr-only">. {enginesOffText(off)}</span></span>{/if}
      {:else if column.key === 'payload'}
        {row.payload_type || row.content_type || 'n/a'}
      {:else if column.key === 'categories'}
        {#if row.categories?.length}<span class="tags">{#each row.categories as category (category)}<Badge tone="neutral">{category}</Badge>{/each}</span>{:else if row.analyze_method === 'custom_rule'}{analyzeMethodLabel(row.analyze_method)}{:else}n/a{/if}
      {:else if column.key === 'latency'}
        <span class="mono">{formatDuration(row.latency_us, 'us')}</span>
      {:else if column.key === 'status'}
        {#if statusLabel(row.status) === 'Not recorded'}<span class="status-none">Not recorded</span>{:else}<span class="mono">{statusLabel(row.status)}</span>{/if}
      {/if}
    {/snippet}
    {#snippet actions(row)}
      <Button variant="ghost" size="sm" aria-label={`Details of ${actionLabel(row.action)} ${row.method} ${row.uri} at ${formatDateTime(row.event_time, { seconds: true })}`} onclick={() => (selected = row)}>Details</Button>
    {/snippet}
    {#snippet footer()}
      {#if loadedAt}<span class="feed-updated">{formatDecisionTotal(total, totalCapped)} matching in range · Updated <DateTime value={loadedAt} seconds /> · {streamState === 'open' ? 'new decisions appear as they are stored' : 'refreshes every 30 s while visible'}</span>{/if}
    {/snippet}
  </DataTable>
</section>

<DecisionDrawer
  decision={selected}
  {projectId}
  {appId}
  country={selected ? countryOf(selected) : ''}
  {canConfigure}
  onclose={() => (selected = null)}
  onfilterip={(ip) => {
    selected = null;
    setFilter({ ip });
  }}
/>

<style>
  .feed { display: flex; flex-direction: column; gap: var(--sp-3); min-width: 0; }
  .feed-head { display: flex; align-items: flex-end; justify-content: space-between; gap: var(--sp-4); flex-wrap: wrap; }
  .feed-head h2 { margin: 0; font-size: var(--fs-md); }
  .feed-sub { margin: var(--sp-1) 0 0; font-size: var(--fs-sm); color: var(--text-muted); }
  .feed-live { display: flex; align-items: center; gap: var(--sp-3); flex-wrap: wrap; }
  .switch { display: inline-flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm); color: var(--text-primary); cursor: pointer; }

  .feed-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); }
  .feed-search { flex: 1 1 18rem; min-width: 0; }
  .feed-ip { flex: 0 1 12rem; min-width: 0; }
  .feed-ip input { font-family: var(--font-mono); }
  .feed-ip input[aria-invalid='true'] { border-color: var(--danger); }
  .feed-search input, .feed-ip input {
    width: 100%;
    padding: var(--sp-2) var(--sp-3);
    background: var(--surface-input);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    color: var(--text-primary);
    font-size: var(--fs-sm);
  }
  .feed-toolbar :global(.feed-select) { width: auto; min-width: 9rem; max-width: 12rem; }
  .seg { display: inline-flex; flex-wrap: wrap; border: 1px solid var(--border-strong); border-radius: var(--radius); overflow: hidden; }
  .seg button { background: transparent; border: 0; padding: var(--sp-2) var(--sp-3); font-size: var(--fs-sm); color: var(--text-secondary); cursor: pointer; }
  .seg button + button { border-left: 1px solid var(--border); }
  .seg button.active { background: var(--accent-soft); color: var(--text-primary); font-weight: var(--fw-medium); }
  .seg button:focus-visible { outline: var(--ring-width) solid var(--ring-color); outline-offset: -2px; }

  .columns { position: relative; }
  .columns > summary { cursor: pointer; padding: var(--sp-2) var(--sp-3); border: 1px solid var(--border-strong); border-radius: var(--radius); font-size: var(--fs-sm); color: var(--text-secondary); list-style: none; }
  .columns > summary::-webkit-details-marker { display: none; }
  .columns[open] > fieldset {
    position: absolute;
    right: 0;
    z-index: 5;
    margin: var(--sp-1) 0 0;
    padding: var(--sp-3);
    min-width: 12rem;
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-md);
  }
  .columns label { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm); color: var(--text-primary); }

  .mono { font-family: var(--font-mono); font-size: var(--fs-sm); }
  .uri { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--text-primary); overflow-wrap: anywhere; }
  .ws { font-size: var(--fs-xs); color: var(--text-muted); }
  .engines-off, .status-none { font-size: var(--fs-xs); color: var(--text-muted); }
  .log-only { display: block; margin-top: calc(var(--sp-1) / 2); font-size: var(--fs-xs); color: var(--text-muted); white-space: normal; max-width: 14rem; }
  .tags { display: inline-flex; flex-wrap: wrap; gap: var(--sp-1); }
  .feed-updated { font-size: var(--fs-xs); color: var(--text-muted); }
  :global(.ui-dt-row.is-new) { background: var(--info-tint); }

  @media (max-width: 640px) {
    .feed-toolbar :global(.feed-select) { max-width: none; flex: 1 1 45%; }
    /* Narrow: the list opens in the flow under the toolbar instead of floating past the screen edge. */
    .columns[open] { flex: 1 1 100%; }
    .columns[open] > fieldset { position: static; width: 100%; }
  }
</style>
