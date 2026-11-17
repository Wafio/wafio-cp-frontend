<!--
  TopList: a ranked top-N list whose rows open the decision feed filtered
  to that value (top lists act as feed filters). Bars are
  neutral: the count is not a verdict.
-->
<script lang="ts">
  import type { WAFEventTopRow } from '#lib/api.js';
  import { formatNumber } from '#lib/format.js';

  let {
    title,
    subtitle = undefined,
    rows,
    emptyText,
    mono = false,
    hrefFor = undefined,
    linkLabel = (label: string) => `Show decisions for ${label}`,
  }: {
    title: string;
    subtitle?: string;
    rows: WAFEventTopRow[];
    emptyText: string;
    mono?: boolean;
    /** Feed link for a row; rows without a link are plain text. */
    hrefFor?: (label: string) => string | null;
    linkLabel?: (label: string) => string;
  } = $props();

  const uid = $props.id();
  const max = $derived(Math.max(1, ...rows.map((r) => r.count)));
</script>

<section class="top" aria-labelledby={`${uid}-title`}>
  <header>
    <h3 id={`${uid}-title`}>{title}</h3>
    {#if subtitle}<p>{subtitle}</p>{/if}
  </header>
  {#if rows.length === 0}
    <p class="top-empty">{emptyText}</p>
  {:else}
    <ol class="top-list">
      {#each rows as row, i (row.label + i)}
        {@const href = row.label ? hrefFor?.(row.label) : null}
        <li style:--pct={`${(row.count / max) * 100}%`}>
          <span class="top-rank" aria-hidden="true">{i + 1}</span>
          {#if href}
            <a class="top-label" class:mono {href} title={row.label} aria-label={`${linkLabel(row.label)} (${formatNumber(row.count)})`}>{row.label}</a>
          {:else}
            <span class="top-label" class:mono title={row.label}>{row.label || 'n/a'}</span>
          {/if}
          <span class="top-count">{formatNumber(row.count, 'compact')}</span>
          <span class="top-bar" aria-hidden="true"></span>
        </li>
      {/each}
    </ol>
  {/if}
</section>

<style>
  .top { display: flex; flex-direction: column; gap: var(--sp-3); min-width: 0; }
  header h3 { margin: 0; font-size: var(--fs-base); color: var(--text-primary); }
  header p { margin: var(--sp-1) 0 0; font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.45; }
  .top-empty { margin: 0; font-size: var(--fs-sm); color: var(--text-muted); }
  .top-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-1); }
  .top-list li {
    position: relative;
    display: grid;
    grid-template-columns: 1.5rem minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--sp-2);
    padding: var(--sp-1) var(--sp-2);
    border-radius: var(--radius);
    font-size: var(--fs-sm);
  }
  .top-rank { color: var(--text-muted); font-size: var(--fs-xs); font-variant-numeric: tabular-nums; }
  .top-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-primary); position: relative; z-index: 1; }
  a.top-label { color: var(--accent); text-decoration: none; }
  a.top-label:hover { text-decoration: underline; }
  .mono { font-family: var(--font-mono); font-size: var(--fs-xs); }
  .top-count { color: var(--text-secondary); font-variant-numeric: tabular-nums; position: relative; z-index: 1; }
  .top-bar { position: absolute; inset: 0 auto 0 0; width: var(--pct); background: var(--bg-hover); border-radius: var(--radius); pointer-events: none; }
</style>
