<!--
  Table: simple table shell; the page renders <tr> rows as children.
  The scroll wrapper is a keyboard-focusable, named region so wide tables
  scroll inside their own box (WCAG 2.1.1). A column with an empty
  label is an action column: it gets a visually hidden `blankLabel`.
  For sorting, pagination and states use DataTable.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  type TableColumn = string | { label: string; hideLabel?: boolean; align?: 'left' | 'center' | 'right'; width?: string };

  let {
    columns,
    label = undefined,
    caption = undefined,
    blankLabel = 'Actions',
    class: className = undefined,
    children = undefined
  }: {
    columns: TableColumn[];
    /** Accessible name of the scroll region (default: caption, else the first column names). */
    label?: string;
    /** Visually hidden table caption. */
    caption?: string;
    /** Hidden header text for columns whose label is empty (default "Actions"). */
    blankLabel?: string;
    class?: string;
    children?: Snippet;
  } = $props();

  const normalized = $derived(
    columns.map((column) => {
      const col = typeof column === 'string' ? { label: column } : column;
      const blank = col.label.trim() === '';
      return {
        text: blank ? blankLabel : col.label,
        hidden: blank || Boolean(col.hideLabel),
        align: col.align,
        width: col.width
      };
    })
  );

  const regionLabel = $derived(
    label ??
      caption ??
      `Table: ${normalized
        .filter((col) => !col.hidden)
        .slice(0, 3)
        .map((col) => col.text)
        .join(', ')}`
  );
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div class={['table-wrap', className]} role="region" aria-label={regionLabel} tabindex="0">
  <table class="ui-table">
    {#if caption}<caption class="sr-only">{caption}</caption>{/if}
    <thead>
      <tr>
        {#each normalized as col, index (index)}
          <th scope="col" style:text-align={col.align} style:width={col.width}>
            {#if col.hidden}<span class="sr-only">{col.text}</span>{:else}{col.text}{/if}
          </th>
        {/each}
      </tr>
    </thead>
    <tbody>{@render children?.()}</tbody>
  </table>
</div>

<style>
  .table-wrap { position: relative; min-width: 0; max-width: 100%; overflow-x: auto; border: 1px solid var(--border); border-radius: var(--radius-lg); }
  .table-wrap:focus-visible { outline: var(--ring-width) solid var(--ring-color); outline-offset: 2px; }
  .ui-table { width: 100%; border-collapse: collapse; font-size: var(--fs-base); font-variant-numeric: tabular-nums; }
  .ui-table :global(th), .ui-table :global(td) { text-align: left; padding: var(--sp-3) var(--sp-4); }
  .ui-table thead th { position: sticky; top: 0; background: var(--bg-secondary); color: var(--text-muted); font-size: var(--fs-sm); font-weight: var(--fw-medium); border-bottom: 1px solid var(--border); }
  .ui-table :global(tbody tr) { border-top: 1px solid var(--border); }
  .ui-table :global(tbody tr:hover) { background: var(--bg-hover); }
</style>
