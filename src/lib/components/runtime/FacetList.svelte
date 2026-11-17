<!--
  FacetList: one facet of the Explore view: its top values with counts over
  the loaded window. Each value is a toggle button (aria-pressed); the active
  value filters the table. Counts are shown as numbers, never as colour.
-->
<script lang="ts">
  import { formatNumber } from '#lib/format.js';
  import type { FacetCount } from './explore';

  let {
    label,
    hint = undefined,
    values,
    active = undefined,
    ontoggle,
    mono = false,
    formatValue = (value: string) => value
  }: {
    label: string;
    hint?: string;
    values: FacetCount[];
    active?: string;
    ontoggle: (value: string | undefined) => void;
    /** Values are identifiers (process, event names): monospace. */
    mono?: boolean;
    formatValue?: (value: string) => string;
  } = $props();

  const uid = $props.id();
</script>

<section class="facet" aria-labelledby="{uid}-title">
  <h3 class="facet-title" id="{uid}-title" title={hint}>{label}</h3>
  {#if values.length === 0}
    <p class="facet-empty">No values in the loaded events.</p>
  {:else}
    <ul class="facet-values">
      {#each values as item (item.value)}
        {@const pressed = active === item.value}
        <li>
          <button
            type="button"
            class="facet-value"
            class:active={pressed}
            aria-pressed={pressed}
            title={pressed ? `Remove the ${label} filter` : `Show only ${formatValue(item.value)}`}
            onclick={() => ontoggle(pressed ? undefined : item.value)}
          >
            <span class="facet-name" class:mono>{formatValue(item.value)}</span>
            <span class="facet-count">{formatNumber(item.count, 'compact')}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .facet { min-width: 0; }
  .facet-title {
    margin: 0 0 var(--sp-1);
    font-size: var(--fs-xs);
    font-weight: var(--fw-semibold);
    color: var(--text-muted);
  }
  .facet-empty { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
  .facet-values { list-style: none; margin: 0; padding: 0; display: grid; gap: calc(var(--sp-1) / 2); }
  .facet-value {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-2);
    padding: var(--sp-1) var(--sp-2);
    border: 1px solid transparent;
    border-radius: var(--radius);
    background: none;
    color: var(--text-secondary);
    font-size: var(--fs-sm);
    text-align: left;
    cursor: pointer;
  }
  .facet-value:hover { background: var(--bg-hover); color: var(--text-primary); }
  .facet-value.active { border-color: var(--accent); background: var(--accent-soft); color: var(--text-primary); }
  .facet-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .facet-name.mono { font-family: var(--font-mono); font-size: var(--fs-xs); }
  .facet-count { flex-shrink: 0; color: var(--text-muted); font-size: var(--fs-xs); font-variant-numeric: tabular-nums; }
</style>
