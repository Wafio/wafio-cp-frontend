<script lang="ts">
  import { PROJECT_AUDIT_CATEGORIES } from '#lib/audit-labels.js';
  import { untrack } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { base } from '#lib/paths.js';
  import Icon from 'svelte-awesome/components/Icon.svelte';
  import refresh from 'svelte-awesome/icons/refresh';
  import { listProjectAuditEvents, type AuditLogEvent } from '#lib/api.js';
  import { getProjectContext } from '#lib/project-context.svelte.js';
  import { formatDateTime } from '#lib/format.js';
  import { DateTime } from '#lib/components/ui/index.js';
  import PageHeader from '#lib/components/ui/PageHeader.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Tabs from '#lib/components/ui/Tabs.svelte';
  import DataTable from '#lib/components/ui/DataTable.svelte';
  import { readTabParam, tabSearch } from '#lib/components/ui/tabs.js';
  import type { DataTableColumn } from '#lib/components/ui/types.js';
  import { auditActionTone } from '#lib/tone.js';
  import { pageOffset, pageParamFor, querySearch, readPageParam } from '#lib/url-state.js';

  const project = getProjectContext();
  const projectId = $derived(page.params.id ?? '');

  const CATEGORIES = PROJECT_AUDIT_CATEGORIES;

  const category = $derived(readTabParam(page.url.searchParams, 'category', CATEGORIES, 'all') ?? 'all');

  let events: AuditLogEvent[] = $state([]);
  let total = $state(0);
  let limit = $state(50);
  // The page number lives in the URL (?page=N) so reload, Back and shared links keep it.
  const pageNo = $derived(readPageParam(page.url.searchParams));
  const offset = $derived(pageOffset(pageNo, limit));
  let loading = $state(true);
  let error = $state('');
  let searchQuery = $state('');
  let expandedKeys = $state<Array<string | number>>([]);
  let epoch = 0;
  let now = $state(Date.now());

  async function load() {
    const scope = projectId;
    const run = ++epoch;
    const cat = CATEGORIES.find((c) => c.id === category);
    loading = true;
    error = '';
    const res = await listProjectAuditEvents(scope, { action: cat?.action || undefined, limit, offset });
    if (run !== epoch || scope !== projectId) return;
    loading = false;
    now = Date.now();
    if (res.error || !res.data) {
      error = res.error?.error ?? 'Audit events could not be loaded.';
      return;
    }
    events = res.data.events ?? [];
    total = res.data.total ?? events.length;
    expandedKeys = [];
    // A page past the end (fewer events now, or an old link): show the last one.
    if (offset > 0 && offset >= total) setPage(Math.max(0, total - 1));
  }

  // Another project: its rows only, never the previous project's.
  $effect(() => {
    void projectId;
    untrack(() => {
      events = [];
      total = 0;
      expandedKeys = [];
      searchQuery = '';
    });
  });

  $effect(() => {
    void projectId;
    void category;
    void offset;
    void limit;
    untrack(() => void load());
  });

  function navigateSearch(qs: string) {
    void goto(`${page.url.pathname}${qs}`, { replace: true, reset: false });
  }

  /** Shows the page holding `nextOffset` (first page: no parameter). */
  function setPage(nextOffset: number) {
    navigateSearch(querySearch(page.url.searchParams, { page: pageParamFor(nextOffset, limit) }));
  }

  // New category: back to the first page.
  function selectCategory(id: string) {
    const params = new URLSearchParams(page.url.search);
    params.delete('page');
    navigateSearch(tabSearch(params, 'category', id, 'all'));
  }

  const visible = $derived.by(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return events;
    return events.filter((e) =>
      [e.action, e.target_name, e.target_id, e.target_type, e.ip, e.actor_name, e.actor_email].some((v) => (v ?? '').toLowerCase().includes(q))
    );
  });

  function scope(action: string): string {
    return action.split('.')[0] ?? action;
  }

  function actionLabel(action: string): string {
    const rest = action.split('.').slice(1).join(' ').replace(/_/g, ' ');
    return rest || action;
  }

  function actorLabel(e: AuditLogEvent): string {
    if (e.actor_name || e.actor_email) return e.actor_name || e.actor_email || '';
    if (e.actor_user_id) return `user ${e.actor_user_id.slice(0, 8)}…`;
    return 'System';
  }

  const columns: DataTableColumn<AuditLogEvent>[] = [
    { key: 'created_at', label: 'Time', nowrap: true, width: '13rem' },
    { key: 'action', label: 'Action' },
    { key: 'target', label: 'Target' },
    { key: 'actor', label: 'Actor' },
    { key: 'ip', label: 'IP address', nowrap: true },
  ];
</script>

<div class="audit-page">
  <PageHeader title="Audit log" subtitle="Every change made in this project, newest first. Times are in your local time zone." backHref="{base}/projects/{projectId}">
    {#snippet actions()}
      <Button variant="secondary" onclick={load} loading={loading} aria-label="Reload audit events">
        <Icon data={refresh} scale={0.8} aria-hidden="true" /> Reload
      </Button>
    {/snippet}
  </PageHeader>

  <Tabs tabs={CATEGORIES} value={category} onchange={selectCategory} label="Event category" size="sm">
    {#snippet end()}
      <div class="search">
        <label for="audit-search" class="sr-only">Filter the events on this page</label>
        <input id="audit-search" type="search" class="search-input" placeholder="Filter this page" bind:value={searchQuery} />
      </div>
    {/snippet}
    {#snippet children()}
      <DataTable
        rows={visible}
        {columns}
        rowKey={(e) => e.id}
        caption="Audit events"
        manualSort
        density="compact"
        {loading}
        loadingLabel="Loading audit events…"
        error={error || null}
        onretry={load}
        emptyTitle={searchQuery.trim() ? 'No events on this page match the filter' : 'No events in this category'}
        onpage={(next) => setPage(next)}
        {total}
        {offset}
        {limit}
        pageSizes={[20, 50, 100]}
        onlimitchange={(next) => {
          limit = next;
          setPage(0);
        }}
        itemLabel="events"
        bind:expandedKeys
        expandLabel={(e) => `Details of ${e.action} at ${formatDateTime(e.created_at, { seconds: true })}`}
      >
        {#snippet cell(e, column)}
          {#if column.key === 'created_at'}
            <DateTime value={e.created_at} seconds relative {now} />
          {:else if column.key === 'action'}
            <span class="action">
              <Badge tone={auditActionTone(e.action)}>{actionLabel(e.action)}</Badge>
              <span class="scope">{scope(e.action)}</span>
            </span>
          {:else if column.key === 'target'}
            {#if e.target_name || e.target_id}
              <span class="target" title={e.target_id ?? undefined}>{e.target_name || e.target_id}</span>
              {#if e.target_type}<span class="sub">{e.target_type}</span>{/if}
            {:else}
              <span class="sub">{e.target_type || 'n/a'}</span>
            {/if}
          {:else if column.key === 'actor'}
            <span class="actor">{actorLabel(e)}</span>
          {:else if column.key === 'ip'}
            <span class="mono">{e.ip || 'n/a'}</span>
          {/if}
        {/snippet}
        {#snippet expanded(e)}
          <dl class="detail">
            <div><dt>Time</dt><dd><DateTime value={e.created_at} seconds relative {now} /></dd></div>
            <div><dt>Action</dt><dd class="mono">{e.action}</dd></div>
            {#if e.target_type}<div><dt>Target type</dt><dd>{e.target_type}</dd></div>{/if}
            {#if e.target_id}<div><dt>Target id</dt><dd class="mono">{e.target_id}</dd></div>{/if}
            {#if e.target_name}<div><dt>Target name</dt><dd>{e.target_name}</dd></div>{/if}
            {#if e.actor_user_id}
              <div><dt>Actor</dt><dd>{e.actor_name || e.actor_email || 'n/a'}{#if e.actor_email && e.actor_name} ({e.actor_email}){/if}<br /><span class="mono sub">{e.actor_user_id}</span></dd></div>
            {/if}
            {#if e.ip}<div><dt>IP address</dt><dd class="mono">{e.ip}</dd></div>{/if}
            {#if e.user_agent}<div class="wide"><dt>User agent</dt><dd class="sub">{e.user_agent}</dd></div>{/if}
            {#if e.metadata && Object.keys(e.metadata).length > 0}
              <div class="wide"><dt>Details</dt><dd><pre class="json">{JSON.stringify(e.metadata, null, 2)}</pre></dd></div>
            {/if}
          </dl>
        {/snippet}
      </DataTable>
    {/snippet}
  </Tabs>
</div>

<style>
  .audit-page {
    padding: var(--page-top, 32px) var(--page-gutter, 24px) 48px;
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
  }
  .search { display: flex; align-items: center; padding-bottom: var(--sp-1); }
  .search-input {
    width: 220px;
    max-width: 40vw;
    height: 30px;
    padding: 0 var(--sp-2);
    background: var(--surface-input);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    color: var(--text-primary);
    font-size: var(--fs-sm);
  }
  .sub { font-size: var(--fs-xs); color: var(--text-muted); }
  .action { display: inline-flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); }
  .scope { font-size: var(--fs-xs); color: var(--text-muted); font-family: var(--font-mono); }
  .target { display: block; color: var(--text-primary); overflow-wrap: anywhere; }
  .actor { color: var(--text-secondary); overflow-wrap: anywhere; }
  .mono { font-family: var(--font-mono); font-size: var(--fs-xs); }
  .detail { margin: 0; padding: var(--sp-2) 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: var(--sp-2) var(--sp-5); }
  .detail .wide { grid-column: 1 / -1; }
  .detail dt { font-size: var(--fs-xs); color: var(--text-muted); }
  .detail dd { margin: 2px 0 0; font-size: var(--fs-sm); color: var(--text-primary); overflow-wrap: anywhere; }
  .json {
    margin: var(--sp-1) 0 0;
    padding: var(--sp-2) var(--sp-3);
    background: var(--bg-code);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    color: var(--text-primary);
    white-space: pre-wrap;
    overflow-x: auto;
  }
  @media (max-width: 640px) {
    .search-input { width: 100%; max-width: none; }
  }
</style>
