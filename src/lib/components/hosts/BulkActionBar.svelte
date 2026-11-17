<!--
  BulkActionBar: actions on the selected hosts of the fleet table. Shown only for roles that can configure.
  No bulk rotate, revoke or delete: those stay per host.
-->
<script lang="ts">
  import Button from '#lib/components/ui/Button.svelte';

  let {
    count,
    onlabels,
    onaddrule,
    onremoverule,
    oncopypolicies,
    oncopyrules,
    onclear,
  }: {
    count: number;
    onlabels: () => void;
    onaddrule: () => void;
    onremoverule: () => void;
    oncopypolicies: () => void;
    oncopyrules: () => void;
    onclear: () => void;
  } = $props();
</script>

<div class="bab" role="region" aria-label="Actions on selected hosts">
  <p class="bab-count" aria-live="polite">{count} {count === 1 ? 'host' : 'hosts'} selected</p>
  <div class="bab-actions">
    <Button variant="secondary" size="sm" disabled={!count} onclick={onlabels}>Edit labels…</Button>
    <Button variant="secondary" size="sm" disabled={!count} onclick={onaddrule}>Add firewall rule…</Button>
    <Button variant="secondary" size="sm" disabled={!count} onclick={onremoverule}>Remove firewall rule…</Button>
    <Button variant="secondary" size="sm" disabled={!count} onclick={oncopypolicies}>Copy runtime policies…</Button>
    <Button variant="secondary" size="sm" disabled={!count} onclick={oncopyrules}>Copy detection rules…</Button>
    <Button variant="ghost" size="sm" disabled={!count} onclick={onclear}>Clear selection</Button>
  </div>
</div>

<style>
  .bab {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-2) var(--sp-4);
    padding: var(--sp-2) var(--sp-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--accent-soft);
  }
  .bab-count { margin: 0; font-size: var(--fs-sm); font-weight: var(--fw-semibold); color: var(--text-primary); }
  .bab-actions { display: flex; flex-wrap: wrap; gap: var(--sp-2); }
</style>
