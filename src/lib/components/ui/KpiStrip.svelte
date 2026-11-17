<!--
  KpiStrip: summary row: label, value, optional unit/detail,
  divided by hairlines, no cards. A tone colours `toneText` (or the value when
  there is none, and only when it is above zero) and never stands alone: the text says what it means. Items
  with `href`/`onclick` become links/buttons named "<label>: <value>".
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { KpiItem } from './types';
  import { toneApplies } from './kpi-tone';

  let {
    items,
    label = 'Summary',
    loading = false,
    minItemWidth = '160px',
    class: className = undefined,
    item: itemSnippet = undefined
  }: {
    items: KpiItem[];
    /** Accessible name of the strip. */
    label?: string;
    /** Values render as "n/a" and the strip is aria-busy. */
    loading?: boolean;
    /** Minimum column width before items wrap (CSS length). */
    minItemWidth?: string;
    class?: string;
    /** Custom value rendering; receives the item and its index. */
    item?: Snippet<[KpiItem, number]>;
  } = $props();

  function accessibleName(kpi: KpiItem): string {
    return [`${kpi.label}: ${kpi.value}${kpi.unit ? ` ${kpi.unit}` : ''}`, kpi.toneText, kpi.detail].filter(Boolean).join(', ');
  }
</script>

{#snippet valueContent(kpi: KpiItem, index: number)}
  {#if loading}
    <span class="kpi-number">n/a</span>
  {:else if itemSnippet}
    {@render itemSnippet(kpi, index)}
  {:else}
    <span class="kpi-number" class:toned={!kpi.toneText && kpi.tone && kpi.tone !== 'default' && toneApplies(kpi.value)}>{kpi.value}</span>
    {#if kpi.unit}<span class="kpi-unit">{kpi.unit}</span>{/if}
    {#if kpi.toneText}<span class="kpi-tone-text">{kpi.toneText}</span>{/if}
  {/if}
{/snippet}

<section class={['kpi-strip', className]} aria-label={label} aria-busy={loading || undefined} style:--kpi-min={minItemWidth}>
  <dl class="kpi-list">
    {#each items as kpi, index (kpi.label)}
      <div class="kpi tone-{kpi.tone ?? 'default'}" title={kpi.hint}>
        <dt class="kpi-label">{kpi.label}</dt>
        <dd class="kpi-value">
          {#if kpi.href && !loading}
            <a class="kpi-link" href={kpi.href} aria-label={accessibleName(kpi)}>{@render valueContent(kpi, index)}</a>
          {:else if kpi.onclick && !loading}
            <button type="button" class="kpi-link" onclick={kpi.onclick} aria-label={accessibleName(kpi)}>{@render valueContent(kpi, index)}</button>
          {:else}
            {@render valueContent(kpi, index)}
          {/if}
        </dd>
        {#if kpi.detail}<dd class="kpi-detail">{kpi.detail}</dd>{/if}
      </div>
    {/each}
  </dl>
</section>

<style>
  /* Every item has a left hairline and gutter; the list is shifted left by
     one gutter + 1px and the strip clips it, so whichever item starts a row
     (at any wrap width) shows no separator and its text starts at the strip
     edge, in line with the page content above and below. The clip reaches
     --sp-1 past the edge so focus outlines of first-column links stay
     visible, while the separator (a whole gutter out) stays hidden. */
  .kpi-strip {
    --kpi-gutter: var(--sp-5);
    min-width: 0;
    clip-path: inset(calc(-1 * var(--sp-1)));
    border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
    padding: var(--sp-5) 0;
  }
  .kpi-list {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(var(--kpi-min, 160px), 100%), 1fr));
    row-gap: var(--sp-4);
    margin: 0 0 0 calc(-1 * var(--kpi-gutter) - 1px);
  }
  .kpi {
    --kpi-tone: var(--text-primary);
    min-width: 0;
    padding: 0 var(--kpi-gutter);
    border-left: 1px solid var(--border);
  }
  .tone-allow { --kpi-tone: var(--allow); }
  .tone-log { --kpi-tone: var(--log); }
  .tone-block { --kpi-tone: var(--block); }
  .tone-danger { --kpi-tone: var(--danger); }
  .tone-warning { --kpi-tone: var(--warning); }
  .tone-success { --kpi-tone: var(--success); }
  .tone-info { --kpi-tone: var(--info); }

  .kpi-label { font-size: var(--fs-sm); color: var(--text-secondary); }
  .kpi-value {
    margin: var(--sp-1) 0;
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: var(--sp-1) var(--sp-2);
    min-width: 0;
  }
  .kpi-number { font-size: var(--fs-xl); font-weight: var(--fw-medium); letter-spacing: -0.02em; line-height: 1.2; color: var(--text-primary); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  .kpi-number.toned { color: var(--kpi-tone); }
  .kpi-unit { font-size: var(--fs-md); color: var(--text-muted); }
  .kpi-tone-text { font-size: var(--fs-xs); color: var(--kpi-tone); font-weight: var(--fw-medium); }
  .kpi-detail { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.45; }

  .kpi-link {
    display: inline-flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: var(--sp-1) var(--sp-2);
    min-width: 44px;
    min-height: 24px;
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    text-decoration: none;
    cursor: pointer;
    border-radius: var(--radius);
  }
  .kpi-link:hover .kpi-number { text-decoration: underline; text-underline-offset: 3px; }
  .kpi-link:focus-visible { outline: var(--ring-width) solid var(--ring-color); outline-offset: 1px; }

  @media (max-width: 760px) {
    .kpi-strip { --kpi-gutter: var(--sp-3); }
    .kpi-list { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
</style>
