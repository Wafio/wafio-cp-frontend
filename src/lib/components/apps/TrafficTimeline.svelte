<!--
  TrafficTimeline: requests per bucket (area, left axis) and block rate
  (line, right axis 0–100 %) for the selected range. Hover or focus
  shows the bucket values; the same numbers are available as a table.
  Requests use a categorical series colour; the block rate uses the BLOCK
  verdict colour.
-->
<script lang="ts">
  import type { WAFEventTimelineBucket } from '#lib/api.js';
  import { formatNumber, formatPercent } from '#lib/format.js';
  import { inRangeText } from '#lib/components/ui/time-range.js';
  import { DateTime } from '#lib/components/ui/index.js';
  import { axisTimeLabel, buildTimeline, nearestBucket, spansMultipleDays, type ChartBox } from './timeline';

  let { buckets, rangeLabel }: { buckets: WAFEventTimelineBucket[]; rangeLabel: string } = $props();

  const uid = $props.id();
  // Axis labels sit in the CSS padding around the SVG, so the plot needs little inner padding.
  const BOX: ChartBox = { width: 640, height: 200, padLeft: 4, padRight: 4, padTop: 8, padBottom: 2 };
  const g = $derived(buildTimeline(buckets, BOX));
  const multiDay = $derived(spansMultipleDays(buckets));
  const xLabels = $derived.by(() => {
    const n = g.buckets.length;
    if (n === 0) return [];
    const idx = n >= 3 ? [0, Math.floor((n - 1) / 2), n - 1] : n === 2 ? [0, 1] : [0];
    return idx.map((i, k) => ({ x: g.buckets[i].x, label: axisTimeLabel(g.buckets[i].start, multiDay), anchor: idx.length === 1 ? 'middle' : k === 0 ? 'start' : k === idx.length - 1 ? 'end' : 'middle' }));
  });

  let hover = $state<number | null>(null);
  const hovered = $derived(hover !== null ? g.buckets[hover] : null);

  function onMove(event: MouseEvent) {
    const svg = event.currentTarget as SVGSVGElement;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0) return;
    const x = ((event.clientX - rect.left) / rect.width) * g.box.width;
    const i = nearestBucket(g, x);
    hover = i >= 0 ? i : null;
  }

  // Arrow keys step through buckets; the same data is in the table below.
  function onKey(event: KeyboardEvent) {
    const n = g.buckets.length;
    if (n === 0) return;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      const step = event.key === 'ArrowRight' ? 1 : -1;
      hover = hover === null ? (step > 0 ? 0 : n - 1) : Math.max(0, Math.min(n - 1, hover + step));
    } else if (event.key === 'Escape') {
      hover = null;
    }
  }

  const summary = $derived(
    `${formatNumber(g.totals.requests)} requests and ${formatNumber(g.totals.blocks)} blocked (${g.totals.blockRate === null ? 'no traffic' : formatPercent(g.totals.blockRate, { digits: 1 })} block rate) over ${rangeLabel.toLowerCase()}.`,
  );
</script>

<figure class="tl" aria-labelledby={`${uid}-caption`}>
  <figcaption id={`${uid}-caption`} class="tl-head">
    <span class="tl-legend">
      <span class="tl-key"><span class="tl-swatch req" aria-hidden="true"></span>Requests <strong>{formatNumber(g.totals.requests)}</strong></span>
      <span class="tl-key"><span class="tl-swatch rate" aria-hidden="true"></span>Block rate <strong>{g.totals.blockRate === null ? 'n/a' : formatPercent(g.totals.blockRate, { digits: 1 })}</strong></span>
    </span>
    <span class="sr-only">{summary}</span>
  </figcaption>

  {#if g.buckets.length === 0}
    <p class="tl-empty">No traffic recorded {inRangeText(rangeLabel)}.</p>
  {:else}
    <div class="tl-plot">
      <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
      <svg
        viewBox={`0 0 ${g.box.width} ${g.box.height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={summary}
        tabindex="0"
        onmousemove={onMove}
        onmouseleave={() => (hover = null)}
        onkeydown={onKey}
        onblur={() => (hover = null)}
      >
        {#each g.yTicks as tick (tick.y)}
          <line class="tl-grid" x1={g.box.padLeft} x2={g.box.width - g.box.padRight} y1={tick.y} y2={tick.y} />
        {/each}
        <path class="tl-area" d={g.requestArea} />
        <path class="tl-line req" d={g.requestLine} />
        <path class="tl-line rate" d={g.rateLine} />
        {#if hovered}
          <line class="tl-cross" x1={hovered.x} x2={hovered.x} y1={g.box.padTop} y2={g.box.height - g.box.padBottom} />
        {/if}
      </svg>
      {#if hovered}
        <!-- Points are HTML so they stay round while the SVG stretches. -->
        <div class="tl-overlay" aria-hidden="true">
          <span class="tl-pt req" style:left={`${(hovered.x / g.box.width) * 100}%`} style:top={`${(hovered.requestY / g.box.height) * 100}%`}></span>
          {#if hovered.rateY !== null}<span class="tl-pt rate" style:left={`${(hovered.x / g.box.width) * 100}%`} style:top={`${(hovered.rateY / g.box.height) * 100}%`}></span>{/if}
        </div>
      {/if}
      <div class="tl-axis-y left" aria-hidden="true">
        {#each g.yTicks as tick (tick.y)}<span style:top={`${(tick.y / g.box.height) * 100}%`}>{formatNumber(tick.value, 'compact')}</span>{/each}
      </div>
      <div class="tl-axis-y right" aria-hidden="true">
        {#each g.rateTicks as tick (tick.y)}<span style:top={`${(tick.y / g.box.height) * 100}%`}>{formatPercent(tick.value, { digits: 0 })}</span>{/each}
      </div>
      <div class="tl-axis-x" aria-hidden="true">
        {#each xLabels as label (label.x)}<span class={`anchor-${label.anchor}`} style:left={`${(label.x / g.box.width) * 100}%`}>{label.label}</span>{/each}
      </div>
      {#if hovered}
        <div class="tl-tip" style:left={`calc(var(--sp-6) + (100% - 2 * var(--sp-6)) * ${Math.max(0.12, Math.min(0.88, hovered.x / g.box.width))})`}>
          <span class="tl-tip-time"><DateTime value={hovered.start} /></span>
          <span>Requests <strong>{formatNumber(hovered.requests)}</strong></span>
          <span>Blocked <strong>{formatNumber(hovered.blocks)}</strong></span>
          <span>Block rate <strong>{hovered.blockRate === null ? 'n/a' : formatPercent(hovered.blockRate, { digits: 1 })}</strong></span>
        </div>
      {/if}
    </div>
    <details class="tl-data">
      <summary>Show chart data</summary>
      <div class="tl-table-wrap" role="region" aria-label="Traffic by time bucket" tabindex="-1">
        <table>
          <thead><tr><th scope="col">Bucket start</th><th scope="col">Requests</th><th scope="col">Blocked</th><th scope="col">Block rate</th></tr></thead>
          <tbody>
            {#each g.buckets as b (b.start)}
              <tr><th scope="row"><DateTime value={b.start} /></th><td>{formatNumber(b.requests)}</td><td>{formatNumber(b.blocks)}</td><td>{b.blockRate === null ? 'n/a' : formatPercent(b.blockRate, { digits: 1 })}</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
    </details>
  {/if}
</figure>

<style>
  .tl { margin: 0; display: flex; flex-direction: column; gap: var(--sp-2); min-width: 0; }
  .tl-head { display: flex; justify-content: space-between; gap: var(--sp-3); flex-wrap: wrap; }
  .tl-legend { display: inline-flex; gap: var(--sp-4); flex-wrap: wrap; font-size: var(--fs-sm); color: var(--text-secondary); }
  .tl-key { display: inline-flex; align-items: center; gap: var(--sp-2); }
  .tl-key strong { color: var(--text-primary); font-variant-numeric: tabular-nums; }
  .tl-swatch { width: 12px; height: 3px; border-radius: 2px; display: inline-block; }
  .tl-swatch.req { background: var(--cat-1); height: 8px; }
  .tl-swatch.rate { background: var(--block); }
  .tl-empty { margin: 0; padding: var(--sp-6) 0; text-align: center; color: var(--text-muted); font-size: var(--fs-sm); }

  .tl-plot { position: relative; height: 220px; padding: 0 var(--sp-6) var(--sp-5) var(--sp-6); }
  svg { width: 100%; height: 100%; display: block; overflow: visible; }
  svg:focus-visible { outline: var(--ring-width) solid var(--ring-color); outline-offset: 2px; }
  .tl-grid { stroke: var(--chart-grid); stroke-width: 1; vector-effect: non-scaling-stroke; }
  .tl-area { fill: color-mix(in srgb, var(--cat-1) 18%, transparent); }
  .tl-line { fill: none; stroke-width: 2; vector-effect: non-scaling-stroke; stroke-linejoin: round; }
  .tl-line.req { stroke: var(--cat-1); }
  .tl-line.rate { stroke: var(--block); stroke-dasharray: 5 3; }
  .tl-cross { stroke: var(--border-strong); stroke-width: 1; vector-effect: non-scaling-stroke; }
  .tl-overlay { position: absolute; top: 0; left: var(--sp-6); right: var(--sp-6); bottom: var(--sp-5); pointer-events: none; }
  .tl-pt { position: absolute; width: 8px; height: 8px; border-radius: 50%; transform: translate(-50%, -50%); border: 1.5px solid var(--bg-card); }
  .tl-pt.req { background: var(--cat-1); }
  .tl-pt.rate { background: var(--block); }

  .tl-axis-y { position: absolute; top: 0; bottom: var(--sp-5); width: var(--sp-6); pointer-events: none; }
  .tl-axis-y.left { left: 0; text-align: right; }
  .tl-axis-y.right { right: 0; text-align: left; }
  .tl-axis-y span { position: absolute; transform: translateY(-50%); font-size: var(--fs-xs); color: var(--text-muted); font-variant-numeric: tabular-nums; }
  .tl-axis-y.left span { right: var(--sp-1); }
  .tl-axis-y.right span { left: var(--sp-1); }
  .tl-axis-x { position: absolute; left: var(--sp-6); right: var(--sp-6); bottom: 0; height: var(--sp-5); pointer-events: none; }
  .tl-axis-x span { position: absolute; bottom: 0; font-size: var(--fs-xs); color: var(--text-muted); white-space: nowrap; }
  .tl-axis-x .anchor-middle { transform: translateX(-50%); }
  .tl-axis-x .anchor-end { transform: translateX(-100%); }

  .tl-tip {
    position: absolute;
    top: var(--sp-2);
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--sp-2) var(--sp-3);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow-md);
    font-size: var(--fs-xs);
    color: var(--text-secondary);
    pointer-events: none;
    white-space: nowrap;
  }
  .tl-tip strong { color: var(--text-primary); font-variant-numeric: tabular-nums; }
  .tl-tip-time { color: var(--text-muted); }

  .tl-data > summary { cursor: pointer; font-size: var(--fs-xs); color: var(--text-muted); width: fit-content; }
  .tl-table-wrap { max-height: 16rem; overflow: auto; margin-top: var(--sp-2); }
  .tl-data table { width: 100%; border-collapse: collapse; font-size: var(--fs-xs); font-variant-numeric: tabular-nums; }
  .tl-data th, .tl-data td { text-align: left; padding: var(--sp-1) var(--sp-2); border-bottom: 1px solid var(--border); }
  .tl-data thead th { color: var(--text-muted); font-weight: var(--fw-medium); }
  .tl-data tbody th { font-weight: 400; color: var(--text-secondary); }
</style>
