<!--
  ApplyResultsTable: one row per host of an apply: status, the guard's own sentence plus what
  to do (firewall/guard-codes.ts), warnings, item counts. "Retry failed
  hosts" re-sends only the hosts whose failure is worth retrying as-is
  (deadline, state conflict, state unavailable, internal error).
-->
<script lang="ts">
  import Badge from '#lib/components/ui/Badge.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import DataTable from '#lib/components/ui/DataTable.svelte';
  import type { DataTableColumn } from '#lib/components/ui/types.js';
  import type { HostApplyResponse, HostApplyResult, HostApplyStatus } from '#lib/api.js';
  import { firewallErrorMessage, firewallWarningText } from '#lib/components/firewall/guard-codes.js';
  import { APPLY_STATUS_TEXT, applyCodeText, applyCountText, retryableHostIds } from '#lib/host-fleet.js';

  let {
    response,
    caption = 'Result per host',
    onretry = undefined,
    retrying = false,
  }: {
    response: HostApplyResponse;
    caption?: string;
    /** Re-send these host ids (not offered for dry runs). */
    onretry?: (hostIds: string[]) => void;
    retrying?: boolean;
  } = $props();

  const STATUS_TONE: Record<HostApplyStatus, 'success' | 'info' | 'neutral' | 'danger' | 'warning'> = {
    applied: 'success',
    would_apply: 'info',
    unchanged: 'neutral',
    failed: 'danger',
    skipped: 'warning',
  };
  const ORDER: Record<HostApplyStatus, number> = { failed: 0, skipped: 1, would_apply: 2, applied: 3, unchanged: 4 };

  const retryIds = $derived(response.dry_run ? [] : retryableHostIds(response.results));
  const summaryText = $derived(
    (Object.keys(APPLY_STATUS_TEXT) as HostApplyStatus[])
      .filter((s) => response.summary[s])
      .map((s) => `${response.summary[s]} ${APPLY_STATUS_TEXT[s].toLowerCase()}`)
      .join(' · ') || 'No hosts',
  );

  function detail(r: HostApplyResult): string {
    if (r.status !== 'failed' && r.status !== 'skipped') return '';
    const text = r.error || applyCodeText(r.code);
    return r.status === 'failed' ? firewallErrorMessage({ error: text, code: r.code }, applyCodeText(r.code) || 'Not applied.') : text;
  }

  function counts(r: HostApplyResult): string {
    return applyCountText(r, response.op, response.dry_run);
  }

  const columns: DataTableColumn<HostApplyResult>[] = [
    { key: 'host_name', label: 'Host', rowHeader: true, sortable: true },
    { key: 'status', label: 'Result', sortable: true, nowrap: true, sortValue: (r) => ORDER[r.status] ?? 9 },
    { key: 'detail', label: 'Details', value: (r) => detail(r) },
    { key: 'count', label: 'Items', value: (r) => counts(r), nowrap: true },
  ];
</script>

<div class="art">
  <div class="art-head">
    <p class="art-summary" aria-live="polite">{summaryText}</p>
    {#if onretry && retryIds.length}
      <Button variant="secondary" size="sm" loading={retrying} onclick={() => onretry?.(retryIds)}>Retry {retryIds.length} failed {retryIds.length === 1 ? 'host' : 'hosts'}</Button>
    {/if}
  </div>
  <DataTable
    rows={response.results}
    {columns}
    rowKey={(r) => r.host_id}
    {caption}
    itemLabel="hosts"
    pageSize={25}
    sort={{ key: 'status', dir: 'asc' }}
    density="compact"
    emptyTitle="No hosts in the result"
  >
    {#snippet cell(r, column)}
      {#if column.key === 'host_name'}
        <span class="art-host">{r.host_name || r.host_id}</span>
        {#if r.agent_online === false && r.status !== 'skipped'}<span class="art-muted">agent offline: delivered on reconnect</span>{/if}
      {:else if column.key === 'status'}
        <Badge tone={STATUS_TONE[r.status] ?? 'neutral'}>{APPLY_STATUS_TEXT[r.status] ?? r.status}</Badge>
        {#if r.code}<code class="art-code">{r.code}</code>{/if}
      {:else if column.key === 'detail'}
        {@const text = detail(r)}
        {#if text}<span class="art-detail">{text}</span>{/if}
        {#if r.warnings?.length}
          <ul class="art-warnings">
            {#each r.warnings as w (w.code + w.message)}<li>{firewallWarningText(w)}</li>{/each}
          </ul>
        {/if}
        {#if !text && !r.warnings?.length}<span class="art-muted">n/a</span>{/if}
      {:else if column.key === 'count'}
        {counts(r) || 'n/a'}
      {/if}
    {/snippet}
  </DataTable>
</div>

<style>
  .art { display: grid; gap: var(--sp-2); min-width: 0; }
  .art-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--sp-2); }
  .art-summary { margin: 0; font-size: var(--fs-sm); color: var(--text-primary); }
  .art-host { display: block; overflow-wrap: anywhere; }
  .art-muted { display: block; font-size: var(--fs-xs); color: var(--text-muted); font-weight: normal; }
  .art-code { display: block; margin-top: var(--sp-1); font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--text-muted); }
  .art-detail { font-size: var(--fs-sm); color: var(--text-secondary); }
  .art-warnings { margin: var(--sp-1) 0 0; padding-left: var(--sp-4); font-size: var(--fs-xs); color: var(--text-secondary); }
</style>
