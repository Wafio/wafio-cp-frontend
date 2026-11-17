<!--
  HostPicker: shown by host-scoped pages (Firewall, Runtime security) until
  a host is chosen. Picking a host sets `?host=<id>` (the page reads it) and
  drops `?pick`. Loads every host of the project (offset paging, 100 a page)
  into a compact, searchable table (name, status, labels, last seen).

  Without `?pick=1` it opens a host on its own (replaceState): the host last
  opened in this project (`wafio.lastHost.<id>` in localStorage) when it
  still exists and is not revoked, else the only usable host. `?pick=1` (the
  "All hosts" entry of the HostSwitcher) keeps the list visible. Revoked
  hosts are listed but cannot be picked.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { base } from '#lib/paths.js';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import Icon from 'svelte-awesome/components/Icon.svelte';
  import desktop from 'svelte-awesome/icons/desktop';
  import StatusDot from '#lib/components/ui/StatusDot.svelte';
  import Spinner from '#lib/components/ui/Spinner.svelte';
  import InlineError from '#lib/components/ui/InlineError.svelte';
  import EmptyState from '#lib/components/ui/EmptyState.svelte';
  import DataTable from '#lib/components/ui/DataTable.svelte';
  import type { DataTableColumn } from '#lib/components/ui/types.js';
  import { listHosts, type Host } from '#lib/api.js';
  import { formatCount, formatDateTime, formatRelative, toISO } from '#lib/format.js';
  import { HOST_STATUS, fetchAllHosts, filterHosts, isPickable, readLastHost, resolveInitialHost, sortHosts, switchHostSearch } from '#lib/host-nav.js';

  interface Props {
    projectId: string;
    title?: string;
    description?: string;
    /** Select the only usable host without asking (default true; `?pick=1` overrides). */
    autoSelect?: boolean;
  }

  let { projectId, title = 'Select a host', description = 'Pick the host whose agent you want to manage.', autoSelect = true }: Props = $props();

  let hosts: Host[] = $state([]);
  let loading = $state(true);
  let error = $state('');
  let query = $state('');

  const searchId = $derived(`host-picker-search-${projectId}`);
  const sorted = $derived(sortHosts(hosts));
  const visible = $derived(filterHosts(sorted, query));

  async function load() {
    loading = true;
    error = '';
    const id = projectId;
    const res = await fetchAllHosts((p) => listHosts(id, p), () => id !== projectId);
    if (id !== projectId) return;
    loading = false;
    if (res.error) { error = res.error; return; }
    hosts = res.hosts ?? [];
    const initial = resolveInitialHost({
      hosts,
      remembered: readLastHost(id),
      pickRequested: page.url.searchParams.get('pick') === '1',
      autoSelect,
    });
    if (initial) pick(initial, true);
  }

  function pick(h: Host, replace = false) {
    if (!isPickable(h)) return;
    void goto(`${page.url.pathname}${switchHostSearch(page.url.searchParams, h.id)}`, { replace, reset: false });
  }

  const columns: DataTableColumn<Host>[] = [
    { key: 'name', label: 'Host', sortable: true, rowHeader: true },
    { key: 'status', label: 'Status', sortable: true, sortValue: (h) => HOST_STATUS[h.status]?.order ?? 9 },
    { key: 'labels', label: 'Labels', value: (h) => Object.entries(h.labels ?? {}).map(([k, v]) => `${k}=${v}`).join(' ') },
    { key: 'last_seen', label: 'Last seen', sortable: true, firstSortDir: 'desc', sortValue: (h) => (h.last_seen ? Date.parse(h.last_seen) : 0), nowrap: true },
  ];

  $effect(() => { projectId; untrack(() => { hosts = []; error = ''; query = ''; void load(); }); });
</script>

<section class="picker" aria-labelledby="host-picker-title">
  <div class="picker-header">
    <h2 id="host-picker-title" class="picker-title"><span aria-hidden="true"><Icon data={desktop} scale={0.9} /></span> {title}</h2>
    <p class="picker-desc">{description}</p>
  </div>

  {#if loading}
    <Spinner label="Loading hosts…" layout="block" />
  {:else if error}
    <InlineError message={error} onretry={() => void load()} />
  {:else if hosts.length === 0}
    <EmptyState title="No hosts registered yet" message="Register a host, then install the host agent on it to manage its firewall and runtime security." level={3}>
      {#snippet action()}<a class="picker-cta" href={`${base}/projects/${projectId}/hosts`}>Register a host</a>{/snippet}
    </EmptyState>
  {:else}
    <div class="picker-tools">
      <label class="search" for={searchId}>
        <span class="sr-only">Search hosts</span>
        <input
          id={searchId}
          type="search"
          placeholder="Search by name, status, OS or label (env=prod)"
          autocomplete="off"
          bind:value={query}
          aria-describedby={`${searchId}-count`}
        />
      </label>
      <span id={`${searchId}-count`} class="picker-count" aria-live="polite">
        {query.trim() ? `${formatCount(visible.length, 'host')} of ${hosts.length}` : formatCount(hosts.length, 'host')}
      </span>
    </div>
    <DataTable
      rows={visible}
      {columns}
      rowKey={(h) => h.id}
      caption="Hosts in this project"
      itemLabel="hosts"
      density="compact"
      pageSize={25}
      onrowclick={(h) => pick(h)}
      rowClass={(h) => (isPickable(h) ? 'pickable' : 'revoked')}
      emptyTitle="No host matches"
      emptyMessage="Try another name, status, OS or label."
    >
      {#snippet cell(h, column)}
        {#if column.key === 'name'}
          {#if isPickable(h)}
            <button type="button" class="host-link" onclick={(e) => { e.stopPropagation(); pick(h); }}>{h.name}</button>
          {:else}
            <span class="host-revoked">{h.name} <span class="muted">(revoked, cannot be managed)</span></span>
          {/if}
        {:else if column.key === 'status'}
          <StatusDot status={HOST_STATUS[h.status]?.dot ?? 'unknown'} label={HOST_STATUS[h.status]?.label ?? h.status} />
        {:else if column.key === 'labels'}
          {#if Object.keys(h.labels ?? {}).length}
            <span class="labels">{#each Object.entries(h.labels ?? {}) as [k, v] (k)}<span class="lbl">{k}={v}</span>{/each}</span>
          {:else}<span class="muted">n/a</span>{/if}
        {:else if column.key === 'last_seen'}
          {#if h.last_seen}<time datetime={toISO(h.last_seen)} title={formatDateTime(h.last_seen, { seconds: true })}>{formatRelative(h.last_seen)}</time>{:else}<span class="muted">Never</span>{/if}
        {/if}
      {/snippet}
    </DataTable>
    <div class="picker-foot">
      <a href={`${base}/projects/${projectId}/hosts`} class="foot-link">Manage hosts</a>
    </div>
  {/if}
</section>

<style>
  .picker { display: grid; gap: var(--sp-4); min-width: 0; }
  .picker-header { display: grid; gap: var(--sp-1); }
  .picker-title { display: inline-flex; align-items: center; gap: var(--sp-2); margin: 0; font-size: var(--fs-base); font-weight: var(--fw-semibold); color: var(--text-primary); }
  .picker-desc { margin: 0; color: var(--text-muted); font-size: var(--fs-sm); line-height: 1.5; }
  .picker-cta { display: inline-block; padding: var(--sp-2) var(--sp-4); background: var(--accent); color: var(--text-on-accent); border-radius: var(--radius); text-decoration: none; font-weight: var(--fw-semibold); font-size: var(--fs-sm); }
  .picker-tools { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2) var(--sp-4); }
  .search { flex: 1 1 280px; max-width: 480px; }
  .search input {
    width: 100%; box-sizing: border-box; padding: var(--sp-2) var(--sp-3);
    font: inherit; font-size: var(--fs-sm); color: var(--text-primary);
    background: var(--bg-primary); border: 1px solid var(--border-strong); border-radius: var(--radius);
  }
  .search input:focus-visible { outline: var(--ring-width) solid var(--ring-color); outline-offset: 1px; }
  .picker-count { font-size: var(--fs-xs); color: var(--text-muted); }
  .host-link {
    padding: 0; border: 0; background: none; font: inherit; font-weight: var(--fw-medium);
    color: var(--accent); text-align: left; cursor: pointer; overflow-wrap: anywhere;
  }
  .host-link:hover { text-decoration: underline; }
  .host-link:focus-visible { outline: var(--ring-width) solid var(--ring-color); outline-offset: 2px; border-radius: var(--radius); }
  .host-revoked { color: var(--text-muted); overflow-wrap: anywhere; }
  .labels { display: flex; flex-wrap: wrap; gap: var(--sp-1); }
  .lbl { font-family: var(--font-mono); font-size: var(--fs-xs); padding: 0 var(--sp-2); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text-secondary); }
  .muted { color: var(--text-muted); font-size: var(--fs-xs); }
  .picker :global(tr.pickable) { cursor: pointer; }
  .picker-foot { display: flex; justify-content: flex-end; }
  .foot-link { color: var(--accent); font-size: var(--fs-sm); }
</style>
