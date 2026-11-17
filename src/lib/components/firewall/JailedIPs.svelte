<!--
  JailedIPs: read-only list of the addresses the WAF agent jailed at XDP:
  after repeated L7 blocks a source is dropped at the NIC until its jail
  ends. Jails live in their own kernel map, outside the desired state, so a
  firewall change never lifts them; the host reports them in its status.
-->
<script lang="ts">
  import './controls.css';
  import DataTable from '#lib/components/ui/DataTable.svelte';
  import DateTime from '#lib/components/ui/DateTime.svelte';
  import type { DataTableColumn } from '#lib/components/ui/types.js';
  import type { EBPFIPListEntry } from '#lib/api.js';
  import { formatDateTime, formatNumber, toISO } from '#lib/format.js';
  import { timeLeft } from './rules';

  let { entries = [], total = 0 }: { entries?: readonly EBPFIPListEntry[]; total?: number } = $props();

  const columns: DataTableColumn<EBPFIPListEntry>[] = [
    { key: 'ip', label: 'Address', sortable: true, rowHeader: true },
    { key: 'expires', label: 'Jail ends', sortable: true, sortValue: (row) => (row.expires_at ? Date.parse(row.expires_at) : Number.MAX_SAFE_INTEGER), nowrap: true },
    { key: 'hits', label: 'Packets dropped', sortable: true, align: 'right', firstSortDir: 'desc', sortValue: (row) => row.hit_count, nowrap: true },
    { key: 'added', label: 'Jailed', sortable: true, firstSortDir: 'desc', sortValue: (row) => Date.parse(row.added_at), nowrap: true },
  ];
</script>

<section class="jail" aria-labelledby="jail-title">
  <h3 id="jail-title" class="jail-title">Jailed by the WAF agent</h3>
  <p class="jail-desc">
    Sources the WAF agent blocked repeatedly are dropped at the network interface until their jail ends. Firewall changes do not lift a jail; an allowlisted address is never dropped by one.
    {#if total > entries.length}Showing the {formatNumber(entries.length)} jails that end last of {formatNumber(total)}.{/if}
  </p>
  <DataTable
    rows={entries}
    {columns}
    rowKey={(row) => row.ip}
    caption="Jailed addresses"
    itemLabel="jailed addresses"
    pageSize={10}
    emptyTitle="No address is jailed"
    emptyMessage="The WAF agent jails a source after repeated blocks, when its IP jail is on."
  >
    {#snippet cell(row, column)}
      {#if column.key === 'ip'}
        <code class="fw-mono">{row.ip}</code>
      {:else if column.key === 'expires'}
        {#if row.expires_at}<time datetime={toISO(row.expires_at)} title={formatDateTime(row.expires_at, { seconds: true })}>{timeLeft(row.expires_at)}</time>{:else}<span class="fw-muted">n/a</span>{/if}
      {:else if column.key === 'hits'}
        {formatNumber(row.hit_count)}
      {:else if column.key === 'added'}
        <DateTime value={row.added_at} />
      {/if}
    {/snippet}
  </DataTable>
</section>

<style>
  .jail { display: grid; gap: var(--sp-2); min-width: 0; margin-top: var(--sp-5); }
  .jail-title { margin: 0; font-size: var(--fs-sm); font-weight: var(--fw-semibold); color: var(--text-primary); }
  .jail-desc { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.5; }
</style>
