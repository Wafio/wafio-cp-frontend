<!--
  Pagination: offset/limit footer: "1–20 of 134", Previous/Next disabled on
  the edges (so "1–1 of 1" offers neither), optional page-size select.
  Works with an unknown total through `count` + `hasMore`.
-->
<script lang="ts">
  import Button from './Button.svelte';
  import Select from './Select.svelte';
  import { formatPageRange, pageInfo, singularLabel } from './pagination';

  let {
    offset,
    limit,
    total = undefined,
    count = undefined,
    hasMore = false,
    onchange,
    pageSizes = undefined,
    onlimitchange = undefined,
    label = 'Pagination',
    itemLabel = undefined,
    disabled = false,
    class: className = undefined
  }: {
    offset: number;
    limit: number;
    /** Total rows reported by the server; omit when unknown. */
    total?: number | null;
    /** Rows on this page (unknown-total mode). */
    count?: number;
    /** More rows exist after this page (unknown-total mode). */
    hasMore?: boolean;
    /** Called with the new offset. */
    onchange: (offset: number) => void;
    /** Page-size choices; shown with `onlimitchange`. */
    pageSizes?: number[];
    onlimitchange?: (limit: number) => void;
    /** Accessible name of the navigation landmark, e.g. "Audit events pages". */
    label?: string;
    /** Noun after the range, e.g. "events" → "1–20 of 134 events". */
    itemLabel?: string;
    disabled?: boolean;
    class?: string;
  } = $props();

  const uid = $props.id();
  const info = $derived(pageInfo({ offset, limit, total, count, hasMore }));
  const oneRow = $derived(info.total === 1 || (info.total === null && info.to > 0 && info.from === info.to));
  const rangeText = $derived(`${formatPageRange(info)}${itemLabel && info.to > 0 ? ` ${oneRow ? singularLabel(itemLabel) : itemLabel}` : ''}`);
</script>

<nav class={['ui-pagination', className]} aria-label={label}>
  <p class="ui-pagination-range" aria-live="polite">{rangeText}</p>
  <div class="ui-pagination-controls">
    {#if pageSizes?.length && onlimitchange}
      <!-- The label stays out of the wrapper: the list opens inside the Select, and a click on an option must not reach a label. -->
      <div class="ui-pagination-size">
        <label for="{uid}-size">Rows per page</label>
        <Select id="{uid}-size" size="sm" options={pageSizes.map((size) => ({ value: size, label: String(size) }))} value={info.limit} {disabled} onchange={(size) => onlimitchange?.(size)} />
      </div>
    {/if}
    <Button variant="secondary" size="sm" disabled={disabled || !info.hasPrev} onclick={() => onchange(info.prevOffset)}>
      <span aria-hidden="true">←</span> Previous
    </Button>
    <Button variant="secondary" size="sm" disabled={disabled || !info.hasNext} onclick={() => onchange(info.nextOffset)}>
      Next <span aria-hidden="true">→</span>
    </Button>
  </div>
</nav>

<style>
  .ui-pagination {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: var(--sp-2) var(--sp-4);
    padding: var(--sp-3) var(--sp-4);
    font-size: var(--fs-sm);
    color: var(--text-secondary);
    min-width: 0;
  }
  .ui-pagination-range { margin: 0; font-variant-numeric: tabular-nums; }
  .ui-pagination-controls { display: flex; align-items: center; flex-wrap: wrap; gap: var(--sp-2); }
  .ui-pagination-size { display: inline-flex; align-items: center; gap: var(--sp-2); margin-right: var(--sp-2); }
</style>
