<!--
  EmptyState: says what is missing and what to do next. The title is a
  heading; pick `level` so it sits one below the enclosing section heading.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    title,
    message = undefined,
    level = 3,
    compact = false,
    action = undefined,
    children = undefined
  }: {
    title: string;
    message?: string;
    /** Heading level of the title (default 3). */
    level?: 2 | 3 | 4 | 5 | 6;
    /** Less vertical padding, for use inside table cells and small panels. */
    compact?: boolean;
    action?: Snippet;
    /** Extra content under the message (e.g. a link to the setup guide). */
    children?: Snippet;
  } = $props();
</script>

<div class="empty-state" class:compact>
  <svelte:element this={`h${level}`} class="es-title">{title}</svelte:element>
  {#if message}<p class="es-message">{message}</p>{/if}
  {@render children?.()}
  {#if action}<div class="es-action">{@render action()}</div>{/if}
</div>

<style>
  .empty-state { text-align: center; padding: var(--sp-7) var(--sp-4); color: var(--text-muted); }
  .empty-state.compact { padding: var(--sp-5) var(--sp-4); }
  .es-title { margin: 0; font-size: var(--fs-md); font-weight: var(--fw-semibold); line-height: 1.4; color: var(--text-secondary); }
  .es-message { margin: var(--sp-2) auto 0; max-width: 60ch; font-size: var(--fs-base); }
  .es-action { margin-top: var(--sp-4); display: flex; justify-content: center; gap: var(--sp-2); flex-wrap: wrap; }
</style>
