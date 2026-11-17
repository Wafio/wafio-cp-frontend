<!--
  ShareBars: a short categorical split (label, count, share, bar) such as
  decisions per analysis method or per HTTP method. Colours are categorical
  series tokens (`--cat-n`), never verdict colours; the count and the
  percentage are always written out.
-->
<script lang="ts">
  import { formatNumber, formatPercent } from '#lib/format.js';
  import type { ShareItem } from '#lib/detection-quality.js';

  let { items, label }: { items: ShareItem[]; label: string } = $props();
</script>

<ul class="shares" aria-label={label}>
  {#each items as item (item.label)}
    <li>
      <span class="swatch" style:background={item.color} aria-hidden="true"></span>
      <span class="name">{item.label}</span>
      <span class="value">{formatNumber(item.value)} <span class="pct">({formatPercent(item.pct, { digits: item.pct > 0 && item.pct < 0.01 ? 1 : 0 })})</span></span>
      <span class="bar" aria-hidden="true"><span style:width={`${item.pct * 100}%`} style:background={item.color}></span></span>
    </li>
  {/each}
</ul>

<style>
  .shares { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-3); }
  .shares li { display: grid; grid-template-columns: 10px minmax(0, 1fr) auto; grid-template-rows: auto auto; align-items: center; column-gap: var(--sp-2); row-gap: var(--sp-1); font-size: var(--fs-sm); }
  .swatch { width: 10px; height: 10px; border-radius: 2px; }
  .name { color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .value { color: var(--text-primary); font-variant-numeric: tabular-nums; }
  .pct { color: var(--text-muted); }
  .bar { grid-column: 2 / -1; height: 4px; background: var(--bg-tertiary); border-radius: 2px; overflow: hidden; }
  .bar span { display: block; height: 100%; }
</style>
