<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from 'svelte-awesome/components/Icon.svelte';
  import refresh from 'svelte-awesome/icons/refresh';
  import { listSystemAudit, type SystemAuditEvent } from '#lib/api.js';
  import { formatDateTime } from '#lib/format.js';
  import { auditActionLabel } from '#lib/audit-labels.js';
  import { auditOutcomeTone } from '#lib/tone.js';
  import { DateTime } from '#lib/components/ui/index.js';
  import PageHeader from '#lib/components/ui/PageHeader.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Badge from '#lib/components/ui/Badge.svelte';
  import DataTable from '#lib/components/ui/DataTable.svelte';
  import type { DataTableColumn } from '#lib/components/ui/types.js';

  // GET /api/admin/audit-log with limit/offset (listSystemAudit; up to 100 per page).
  let limit = $state(20);

  let events = $state<SystemAuditEvent[]>([]);
  let total = $state(0);
  let offset = $state(0);
  let error = $state('');
  let loading = $state(true);
  let now = $state(Date.now());
  let expandedKeys = $state<Array<string | number>>([]);

  let epoch = 0;

  async function load() {
    const run = ++epoch;
    loading = true;
    error = '';
    const res = await listSystemAudit({ limit, offset });
    if (run !== epoch) return; // a newer page request is on its way
    loading = false;
    now = Date.now();
    if (res.error || !res.data) {
      error = res.error?.error ?? 'Audit events could not be loaded.';
      return;
    }
    events = res.data.events ?? [];
    total = res.data.total ?? events.length;
    expandedKeys = [];
  }

  onMount(load);

  function actorLabel(e: SystemAuditEvent) {
    return e.actor_email || (e.actor_user_id ? `user ${e.actor_user_id.slice(0, 8)}…` : 'System');
  }

  const columns: DataTableColumn<SystemAuditEvent>[] = [
    { key: 'created_at', label: 'Time', nowrap: true, width: '13rem' },
    { key: 'actor', label: 'Actor' },
    { key: 'action', label: 'Action' },
    { key: 'target', label: 'Target' },
    { key: 'outcome', label: 'Outcome', nowrap: true },
  ];
</script>

<div class="admin-page">
  <PageHeader title="Global audit log" subtitle="Administrator sign-ins and changes to users, invitations and security data, newest first. Passwords and invitation tokens are never recorded. Times are in your local time zone.">
    {#snippet actions()}
      <Button variant="secondary" {loading} onclick={load}>
        <Icon data={refresh} scale={0.8} aria-hidden="true" /> Reload
      </Button>
    {/snippet}
  </PageHeader>

  <DataTable
    rows={events}
    {columns}
    rowKey={(e) => e.id}
    caption="Administrator audit events"
    manualSort
    density="compact"
    {loading}
    loadingLabel="Loading audit events…"
    error={error || null}
    onretry={load}
    emptyTitle="No audit events recorded"
    onpage={(next) => {
      offset = next;
      void load();
    }}
    {total}
    {offset}
    {limit}
    pageSizes={[20, 50, 100]}
    onlimitchange={(next) => {
      limit = next;
      offset = 0;
      void load();
    }}
    itemLabel="events"
    bind:expandedKeys
    expandLabel={(e) => `Details of ${auditActionLabel(e.action)} at ${formatDateTime(e.created_at, { seconds: true })}`}
  >
    {#snippet cell(e, column)}
      {#if column.key === 'created_at'}
        <DateTime value={e.created_at} seconds relative {now} />
      {:else if column.key === 'actor'}
        {actorLabel(e)}
      {:else if column.key === 'action'}
        <span class="action-label">{auditActionLabel(e.action)}</span>
        <code class="mono sub">{e.action}</code>
      {:else if column.key === 'target'}
        {#if e.target_id}
          <span class="target" title={e.target_id}>{e.target_id}</span>
          {#if e.target_type}<span class="sub">{e.target_type}</span>{/if}
        {:else}
          <span class="sub">{e.target_type || 'n/a'}</span>
        {/if}
      {:else if column.key === 'outcome'}
        <Badge tone={auditOutcomeTone(e.outcome)}>{e.outcome === 'success' ? 'Succeeded' : 'Failed'} · HTTP {e.http_status}</Badge>
      {/if}
    {/snippet}
    {#snippet expanded(e)}
      <dl class="detail">
        <div><dt>Time</dt><dd><DateTime value={e.created_at} seconds relative {now} /></dd></div>
        <div><dt>Actor id</dt><dd class="mono">{e.actor_user_id || 'n/a'}</dd></div>
        <div><dt>IP address</dt><dd class="mono">{e.ip || 'n/a'}</dd></div>
        {#if e.user_agent}<div class="wide"><dt>User agent</dt><dd class="sub">{e.user_agent}</dd></div>{/if}
        {#if e.metadata && Object.keys(e.metadata).length > 0}
          <div class="wide"><dt>Details</dt><dd class="mono">{JSON.stringify(e.metadata)}</dd></div>
        {/if}
      </dl>
    {/snippet}
  </DataTable>
</div>

<style>
  .admin-page {
    padding: var(--page-top, 32px) var(--page-gutter, 24px) 48px;
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
  }
  .sub { display: block; font-size: var(--fs-xs); color: var(--text-muted); }
  .mono { font-family: var(--font-mono); font-size: var(--fs-xs); overflow-wrap: anywhere; }
  .target {
    display: inline-block;
    max-width: 28ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    vertical-align: bottom;
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
  }
  .detail { margin: 0; padding: var(--sp-2) 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: var(--sp-2) var(--sp-5); }
  .detail .wide { grid-column: 1 / -1; }
  .detail dt { font-size: var(--fs-xs); color: var(--text-muted); }
  .detail dd { margin: 2px 0 0; font-size: var(--fs-sm); color: var(--text-primary); overflow-wrap: anywhere; }
</style>
