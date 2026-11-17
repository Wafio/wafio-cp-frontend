<!--
  AppBlockWindow: the Block window tab: clients the WAF agent currently
  blocks (WAF rules, Login Protection, Block Policy), grouped per key, with
  "Request unblock" (simple confirmation). Block windows are
  agent-wide: they cover every application on the agent. Refreshes every
  10 s while visible.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { deleteBlockWindowEntry, listBlockWindow, type BlockWindowEntry } from '#lib/api.js';
  import { createPoller } from '#lib/polling.svelte.js';
  import { Badge, Button, ConfirmModal, DataTable, DateTime, type DataTableColumn } from '#lib/components/ui/index.js';
  import { categoryTone } from '#lib/tone.js';
  import { formatDateTime, formatRelative } from '#lib/format.js';
  import { toast } from '#lib/stores/toast.js';
  import { groupBlockEntries, reasonLabel, unblockOperationText, type BlockGroup } from './block-window';

  let { projectId, agentId, agentName = '', canConfigure = false }: { projectId: string; agentId: string; agentName?: string; canConfigure?: boolean } = $props();

  let entries = $state<BlockWindowEntry[]>([]);
  let loading = $state(true);
  let error = $state('');
  let now = $state(Date.now());
  let epoch = 0;

  async function load() {
    const my = ++epoch;
    const project = projectId;
    const agent = agentId;
    const result = await listBlockWindow(project, agent);
    if (my !== epoch) return;
    loading = false;
    now = Date.now();
    if (result.error) {
      error = result.error.error || 'Could not load the block window.';
      return;
    }
    error = '';
    entries = result.data?.entries ?? [];
  }

  const poller = createPoller(() => load(), 10_000, { immediate: false });

  $effect(() => {
    void `${projectId}/${agentId}`;
    untrack(() => {
      epoch++;
      entries = [];
      loading = true;
      void poller.trigger();
    });
  });

  const groups = $derived(groupBlockEntries(entries));

  const columns: DataTableColumn<BlockGroup>[] = [
    { key: 'key', label: 'Blocked key', rowHeader: true },
    { key: 'type', label: 'Key type', nowrap: true },
    { key: 'reasons', label: 'Reason' },
    { key: 'paths', label: 'Paths' },
    { key: 'blocked', label: 'Last blocked', nowrap: true },
    { key: 'expires', label: 'Expires', nowrap: true },
  ];

  const KEY_TYPES = ['ip', 'field', 'ua'];
  const REASONS = ['loginprotection', 'blockpolicy'];

  let confirm = $state<BlockGroup | null>(null);
  let unblocking = $state(false);

  async function unblock() {
    const group = confirm;
    if (!group || !canConfigure || unblocking) return;
    unblocking = true;
    const results = await Promise.all(group.ids.map((id) => deleteBlockWindowEntry(projectId, agentId, id)));
    unblocking = false;
    confirm = null;
    const failed = results.find((r) => r.error);
    if (failed?.error) toast.error(failed.error.error || 'The unblock request failed.', 'Unblock not requested');
    else toast.success('The agent removes the block once it acknowledges the request.', 'Unblock requested');
    await poller.trigger();
  }
</script>

<section class="bw" aria-labelledby="bw-title">
  <header class="bw-head">
    <div>
      <h2 id="bw-title">Block window</h2>
      <p>Clients that {agentName ? `agent ${agentName}` : 'the agent'} blocks right now, from WAF rules, Login Protection and Block Policy. Blocks are agent-wide and cover every application on the agent.</p>
    </div>
    <Button variant="secondary" size="sm" loading={loading && entries.length > 0} onclick={() => void poller.trigger()}>Refresh</Button>
  </header>

  <DataTable
    rows={groups}
    {columns}
    rowKey={(g) => g.key}
    caption="Active blocks"
    {loading}
    error={error || null}
    onretry={() => void poller.trigger()}
    emptyTitle="No active blocks"
    emptyMessage="Clients blocked by WAF rules, Login Protection or Block Policy appear here until their block expires."
    actionsLabel="Unblock"
    density="compact"
  >
    {#snippet cell(g, column)}
      {#if column.key === 'key'}
        <code class="bw-key">{g.key}</code>
      {:else if column.key === 'type'}
        <Badge tone={categoryTone(g.keyType, KEY_TYPES)}>{g.keyType}</Badge>
      {:else if column.key === 'reasons'}
        <span class="bw-tags">
          {#each g.reasons as reason (reason)}<Badge tone={categoryTone(reason.toLowerCase(), REASONS)}>{reasonLabel(reason)}</Badge>{/each}
          {#if g.unblock}<Badge tone={g.unblock === 'failed' || g.unblock === 'timeout' ? 'warning' : 'info'} title="Status of the last unblock request">Unblock {g.unblock}</Badge>{/if}
        </span>
        {#if g.operations.length > 0}
          <ul class="bw-ops" aria-label={`Unblock requests for ${g.key}`}>
            {#each g.operations as op (op.command_id)}<li>Unblock {unblockOperationText(op)}</li>{/each}
          </ul>
        {/if}
      {:else if column.key === 'paths'}
        {#if g.pathCount === 1}<code class="bw-path" title={g.firstPath}>{g.firstPath || 'n/a'}</code>{:else}{g.pathCount} paths{/if}
      {:else if column.key === 'blocked'}
        <DateTime value={g.blockedAt} seconds />
      {:else if column.key === 'expires'}
        <time datetime={g.expiresAt} title={formatDateTime(g.expiresAt, { seconds: true })}>{Date.parse(g.expiresAt) <= now ? 'Expired' : formatRelative(g.expiresAt, now)}</time>
      {/if}
    {/snippet}
    {#snippet actions(g)}
      <Button
        variant="ghost"
        size="sm"
        disabled={!canConfigure || g.unblock === 'pending'}
        title={!canConfigure ? 'Member access required' : g.unblock === 'pending' ? 'An unblock request is pending' : undefined}
        aria-label={`Request unblock of ${g.key}`}
        onclick={() => (confirm = g)}
      >Request unblock</Button>
    {/snippet}
  </DataTable>
  <p class="bw-note">Unblock requests go to the agent and expire after 10 seconds; a timeout, a disconnect or a control-plane restart leaves delivery unknown. Tracking is in memory, not a durable history.</p>
</section>

<ConfirmModal
  open={confirm !== null}
  tone="warning"
  title={`Unblock ${confirm?.key ?? ''}?`}
  confirmLabel="Request unblock"
  loading={unblocking}
  onconfirm={() => void unblock()}
  onclose={() => (confirm = null)}
>
  <p class="bw-confirm">
    Removes the current blocks for <code>{confirm?.key}</code> ({confirm?.keyType}) on every application of this agent.
    {#if confirm?.persistent}This key was blocked by Login Protection or Block Policy.{/if}
    New violating traffic is blocked again.
  </p>
</ConfirmModal>

<style>
  .bw { display: flex; flex-direction: column; gap: var(--sp-3); min-width: 0; }
  .bw-head { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--sp-4); flex-wrap: wrap; }
  .bw-head h2 { margin: 0; font-size: var(--fs-md); }
  .bw-head p { margin: var(--sp-1) 0 0; font-size: var(--fs-sm); color: var(--text-muted); max-width: 68ch; line-height: 1.5; }
  .bw-key, .bw-path { font-family: var(--font-mono); font-size: var(--fs-xs); overflow-wrap: anywhere; }
  /* An address stays on one line; the table scrolls sideways when it must. */
  .bw-key { overflow-wrap: normal; white-space: nowrap; }
  .bw-tags { display: inline-flex; flex-wrap: wrap; gap: var(--sp-1); }
  .bw-ops { list-style: none; margin: var(--sp-1) 0 0; padding: 0; font-size: var(--fs-xs); color: var(--text-muted); overflow-wrap: anywhere; }
  .bw-note { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.5; }
  .bw-confirm { margin: 0; color: var(--text-secondary); line-height: 1.5; }
  .bw-confirm code { font-family: var(--font-mono); color: var(--text-primary); }
</style>
