<!--
  PageHeader: header: back link, one h1.page-title, one p.page-subtitle.
  The back link names its target: pass `backLabel`, or let it be
  derived for the two known targets (project root → "← Overview",
  project list → "← Projects"). Any other target needs an explicit label;
  without one the link reads "← Back" and a development warning is logged.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { dev } from '$app/env';
  import { backLabelText, defaultBackLabel } from './page-header';

  let {
    title,
    subtitle = undefined,
    backHref = undefined,
    backLabel = undefined,
    actions = undefined,
    children = undefined
  }: {
    title: string;
    subtitle?: string;
    backHref?: string;
    /** Link text; a leading "←" is optional (the arrow is always rendered, hidden from AT). */
    backLabel?: string;
    actions?: Snippet;
    /** Extra content under the subtitle (e.g. status chips). */
    children?: Snippet;
  } = $props();

  const derivedLabel = $derived(defaultBackLabel(backHref));
  const linkText = $derived(backLabelText(backLabel ?? derivedLabel ?? 'Back'));

  $effect(() => {
    if (dev && backHref && !backLabel && !derivedLabel) {
      console.warn(`PageHeader: pass backLabel for back link "${backHref}" (link text names its target).`);
    }
  });
</script>

<header class="page-header" aria-label={title}>
  <div class="ph-text">
    {#if backHref}<a href={backHref} class="back-link"><span aria-hidden="true">←</span> {linkText}</a>{/if}
    <h1 class="page-title">{title}</h1>
    {#if subtitle}<p class="page-subtitle">{subtitle}</p>{/if}
    {@render children?.()}
  </div>
  {#if actions}<div class="ph-actions">{@render actions()}</div>{/if}
</header>

<style>
  .page-header { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--sp-4); margin-bottom: var(--sp-5); }
  .back-link { display: inline-flex; gap: var(--sp-1); color: var(--accent); text-decoration: none; font-size: var(--fs-base); }
  .back-link:hover { text-decoration: underline; }
  .page-title { margin: var(--sp-1) 0 0; font-size: var(--fs-2xl); font-weight: 550; letter-spacing: -.035em; line-height: 1.2; color: var(--text-primary); }
  .page-subtitle { color: var(--text-muted); margin: var(--sp-1) 0 0; font-size: var(--fs-base); line-height: 1.6; }
  .ph-text { min-width: 0; max-width: 100%; overflow-wrap: anywhere; }
  .ph-actions { min-width: 0; max-width: 100%; flex-shrink: 0; display: flex; flex-wrap: wrap; gap: var(--sp-2); }
  @media (max-width: 760px) { .page-header { flex-direction: column; } .ph-actions { width: 100%; } }
</style>
