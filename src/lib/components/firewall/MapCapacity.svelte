<!--
  MapCapacity: how full the BPF maps are that the host agent sizes from the
  host memory (map_sizing of the firewall or trace status). The state is
  written in words; the bar colour only repeats it. An agent that sends no
  map_sizing shows "Not reported".
-->
<script lang="ts">
  import Alert from '#lib/components/ui/Alert.svelte';
  import Badge from '#lib/components/ui/Badge.svelte';
  import DateTime from '#lib/components/ui/DateTime.svelte';
  import type { MapSizing } from '#lib/api.js';
  import { mapCapacityView } from '#lib/firewall/map-capacity.js';
  import { NOT_REPORTED } from '#lib/telemetry-status.js';

  let { sizing }: { sizing?: MapSizing | null } = $props();

  // Date.now() is read inside the derived value, so a new status re-evaluates the 10 minute window.
  const view = $derived(mapCapacityView(sizing, Date.now()));
</script>

<div class="mc">
  <h3 class="mc-title">Map capacity</h3>
  {#if view}
    <p class="mc-head">{view.header}</p>
    {#if view.advice}<Alert tone="warning" compact message={view.advice} />{/if}
    <ul class="mc-rows">
      {#each view.rows as row (row.name)}
        <li class="mc-row">
          <span class="mc-label">{row.label}</span>
          <span class="mc-use">
            <span class="mc-num">{row.usage}</span>
            {#if row.percent !== null}
              <span class="mc-track" aria-hidden="true"><span class="mc-fill is-{row.state}" style:width={`${row.percent}%`}></span></span>
              <span class="mc-num">{row.percentText}</span>
            {/if}
            {#if row.reducedFrom}<span class="mc-muted">reduced from {row.reducedFrom}</span>{/if}
          </span>
          <span class="mc-state">
            {#if row.state === 'full'}
              <Badge tone="danger">Full</Badge> <span class="mc-muted">at <DateTime value={row.lastFullAt} /></span>
            {:else if row.state === 'was_full'}
              <Badge tone="warning">Was full</Badge> <span class="mc-muted">at <DateTime value={row.lastFullAt} /></span>
            {:else}
              <Badge tone="success">OK</Badge>
            {/if}
          </span>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="mc-muted">{NOT_REPORTED}</p>
  {/if}
</div>

<style>
  .mc { display: grid; gap: var(--sp-3); min-width: 0; }
  .mc-title { margin: 0; font-size: var(--fs-sm); font-weight: var(--fw-semibold); color: var(--text-primary); }
  .mc-head, .mc-muted { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
  .mc-rows { display: grid; margin: 0; padding: 0; list-style: none; }
  .mc-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 13rem), 1fr)); align-items: center; gap: var(--sp-1) var(--sp-3); padding: var(--sp-2) 0; border-bottom: 1px solid var(--border); font-size: var(--fs-xs); }
  .mc-label { color: var(--text-primary); font-weight: var(--fw-medium); overflow-wrap: anywhere; }
  .mc-use, .mc-state { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-1) var(--sp-2); min-width: 0; }
  .mc-track { flex: 1 1 4rem; min-width: 4rem; height: 6px; border-radius: 3px; background: var(--chart-grid); overflow: hidden; }
  .mc-fill { display: block; height: 100%; border-radius: 3px; background: var(--accent); }
  .mc-fill.is-full { background: var(--danger); }
  .mc-fill.is-was_full { background: var(--warning); }
  .mc-num { color: var(--text-primary); font-variant-numeric: tabular-nums; white-space: nowrap; }
</style>
