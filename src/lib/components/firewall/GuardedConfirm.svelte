<!--
  GuardedConfirm: confirmation for firewall changes that can cut access or
  protection. Lists what changes, shows the lockout
  checks, and applies the confirmation tier: `typed` asks for the host name,
  `simple` is one confirm. A failing check keeps Confirm disabled.
-->
<script lang="ts">
  import ConfirmModal from '#lib/components/ui/ConfirmModal.svelte';
  import Alert from '#lib/components/ui/Alert.svelte';
  import type { ConfirmTier } from '#lib/confirm-tiers.js';
  import LockoutCheckPanel from './LockoutCheckPanel.svelte';
  import { hasBlockingFailure, type CheckFix, type LockoutCheck } from './lockout';

  let {
    open = false,
    title,
    changes = [],
    checks = [],
    tier = 'simple',
    confirmText = '',
    confirmLabel = 'Apply',
    tone = 'warning',
    loading = false,
    error = null,
    onconfirm,
    onclose,
    onfix = undefined,
  }: {
    open?: boolean;
    title: string;
    /** Plain-language list of what the confirm applies. */
    changes?: string[];
    checks?: readonly LockoutCheck[];
    tier?: ConfirmTier;
    /** Text typed for the `typed` tier (the host name). */
    confirmText?: string;
    confirmLabel?: string;
    tone?: 'danger' | 'warning' | 'primary';
    loading?: boolean;
    /** Error of the last attempt, shown above the buttons. */
    error?: string | null;
    onconfirm: () => void;
    onclose: () => void;
    onfix?: (fix: CheckFix) => void;
  } = $props();

  const blocked = $derived(hasBlockingFailure(checks));
  const requireText = $derived(tier === 'typed' ? confirmText.trim() || 'confirm' : '');
</script>

<ConfirmModal
  {open}
  {title}
  {confirmLabel}
  {tone}
  {loading}
  {requireText}
  requireTextLabel={requireText ? `Type the host name, ${requireText}, to confirm` : undefined}
  confirmDisabled={blocked}
  size={checks.length ? 'lg' : undefined}
  {onconfirm}
  {onclose}
>
  <div class="guard">
    {#if changes.length}
      <div>
        <p class="guard-lead">This applies to the host now:</p>
        <ul class="guard-changes">
          {#each changes as change (change)}<li>{change}</li>{/each}
        </ul>
      </div>
    {/if}
    {#if checks.length}
      <LockoutCheckPanel {checks} headingLevel={3} onfix={onfix ? (fix) => { onclose(); onfix?.(fix); } : undefined} />
    {/if}
    {#if blocked}
      <Alert tone="error" compact message="Fix the checks marked “Blocks the change” before applying it." />
    {/if}
    {#if error}
      <Alert tone="error" compact title="The change was not applied" message={error} />
    {/if}
  </div>
</ConfirmModal>

<style>
  .guard { display: grid; gap: var(--sp-3); }
  .guard-lead { margin: 0; font-size: var(--fs-sm); color: var(--text-secondary); }
  .guard-changes { margin: var(--sp-1) 0 0; padding-left: var(--sp-5); font-size: var(--fs-sm); color: var(--text-primary); line-height: 1.6; }
</style>
