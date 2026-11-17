<!--
  SaveBar: sticky footer of the policy editor: number of unsaved changes,
  problems, and Review / Discard / Save.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import type { WafPolicyForm } from './waf-policy-form.svelte';

  let {
    form,
    saving = false,
    readonly = false,
    onreview,
    ondiscard,
    onsave,
    notice = undefined
  }: {
    form: WafPolicyForm;
    saving?: boolean;
    readonly?: boolean;
    onreview: () => void;
    ondiscard: () => void;
    onsave: () => void;
    /** Message above the buttons (save error, conflict). */
    notice?: Snippet;
  } = $props();

  const problems = $derived(form.visibleIssues.length);
</script>

<div class="wp-savebar" class:is-dirty={form.isDirty} role="region" aria-label="Unsaved policy changes">
  {#if notice}<div class="wp-savebar-notice">{@render notice()}</div>{/if}
  <div class="wp-savebar-row">
  <p class="wp-savebar-status" aria-live="polite">
    {#if readonly}
      Read-only: you need member access to change this policy.
    {:else if saving}
      Saving…
    {:else if form.isDirty}
      <strong>{form.changeCount} unsaved {form.changeCount === 1 ? 'change' : 'changes'}</strong>
    {:else}
      No unsaved changes
    {/if}
    {#if problems > 0 && !readonly}<span class="wp-savebar-problems"> · {problems} {problems === 1 ? 'problem' : 'problems'} to fix</span>{/if}
  </p>
  <div class="wp-savebar-actions">
    <Button variant="ghost" size="sm" onclick={onreview} disabled={!form.isDirty}>Review changes</Button>
    {#if !readonly}
      <Button variant="secondary" size="sm" onclick={ondiscard} disabled={!form.isDirty || saving}>Discard</Button>
      <Button size="sm" onclick={onsave} loading={saving} disabled={!form.isDirty || saving}>Save policy</Button>
    {/if}
  </div>
  </div>
</div>

<style>
  .wp-savebar {
    position: sticky;
    bottom: 0;
    z-index: 5;
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
    padding: var(--sp-3) var(--sp-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg) var(--radius-lg) 0 0;
    background: var(--bg-elevated);
    box-shadow: var(--shadow-md);
  }
  .wp-savebar-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--sp-3); }
  .wp-savebar.is-dirty { border-top: 2px solid var(--accent); }
  .wp-savebar-status { margin: 0; font-size: var(--fs-sm); color: var(--text-secondary); }
  .wp-savebar-status strong { color: var(--text-primary); font-weight: var(--fw-semibold); }
  .wp-savebar-problems { color: var(--danger); font-weight: var(--fw-medium); }
  .wp-savebar-actions { display: flex; flex-wrap: wrap; gap: var(--sp-2); margin-left: auto; }
  @media (max-width: 640px) {
    .wp-savebar { gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); }
    .wp-savebar-row { gap: var(--sp-2); }
    .wp-savebar-status { font-size: var(--fs-xs); }
    .wp-savebar-actions { gap: var(--sp-1); }
  }
</style>
