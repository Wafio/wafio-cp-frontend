<!--
  PolicySection: one numbered section of the WAF policy editor: heading,
  purpose line, "Unsaved" / "N problems" markers from the form, and content.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import Badge from '#lib/components/ui/Badge.svelte';
  import type { WafPolicyForm } from './waf-policy-form.svelte';
  import type { SectionId } from './validate';

  let {
    id,
    title,
    description = undefined,
    form,
    children,
    aside = undefined
  }: {
    id: SectionId;
    title: string;
    description?: string;
    form: WafPolicyForm;
    children: Snippet;
    /** Content at the right of the heading (status, a link). */
    aside?: Snippet;
  } = $props();

  const problems = $derived(form.issueCount(id));
  const changed = $derived(form.changedSection(id));
</script>

<section class="wp-section" id="wp-section-{id}" aria-labelledby="wp-section-{id}-title">
  <header class="wp-section-head">
    <div class="wp-section-titles">
      <h3 id="wp-section-{id}-title" tabindex="-1">{title}</h3>
      {#if description}<p>{description}</p>{/if}
    </div>
    <div class="wp-section-status">
      {#if problems > 0}<Badge tone="danger">{problems} {problems === 1 ? 'problem' : 'problems'}</Badge>{/if}
      {#if changed}<Badge tone="info">Unsaved</Badge>{/if}
      {@render aside?.()}
    </div>
  </header>
  <div class="wp-section-body">{@render children()}</div>
</section>

<style>
  .wp-section {
    min-width: 0;
    scroll-margin-top: calc(var(--header-height) + var(--sp-4));
    padding: var(--sp-5);
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow-wrap: anywhere;
  }
  .wp-section-head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: var(--sp-3); margin-bottom: var(--sp-4); }
  .wp-section-titles { min-width: 0; flex: 1 1 20rem; }
  h3 { margin: 0; font-size: var(--fs-md); font-weight: var(--fw-semibold); color: var(--text-primary); }
  .wp-section-titles p { margin: var(--sp-1) 0 0; font-size: var(--fs-sm); line-height: 1.55; color: var(--text-muted); max-width: 72ch; }
  .wp-section-status { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); }
  .wp-section-body { min-width: 0; }
  @media (max-width: 640px) { .wp-section { padding: var(--sp-4); } }
</style>
