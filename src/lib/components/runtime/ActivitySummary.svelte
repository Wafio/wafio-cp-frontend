<!--
  ActivitySummary: what the host did in the page time range, below the
  incident queue (queue before charts; observed counts only,
  no synthetic score). Each figure opens Explore with the matching filter.
-->
<script lang="ts">
  import type { EnforcementLogEntry, TraceStats } from '#lib/api.js';
  import { formatNumber } from '#lib/format.js';
  import { SEVERITIES, enforcementTone, severityColor } from '#lib/tone.js';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import { isTimeRangeKey, timeRangeLabel, type TimeRangeKey } from '#lib/components/ui/time-range.js';
  import { tacticBreakdown } from './mitre';
  import type { TraceFacet, FacetFilters } from './explore';

  type Stats = Partial<TraceStats> & { severity_window_range?: string };

  let {
    stats,
    range,
    enforcement,
    enforcementLoading = false,
    enforcementError = null,
    onexplore,
  }: {
    stats: Stats | null;
    range: TimeRangeKey;
    /** Enforcement records in the range (newest first, at most the server window). */
    enforcement: EnforcementLogEntry[];
    enforcementLoading?: boolean;
    enforcementError?: string | null;
    onexplore: (next: { source?: 'events' | 'enforcement'; minSeverity?: string; traceFilters?: FacetFilters<TraceFacet> }) => void;
  } = $props();

  const bySeverity = $derived(stats?.by_severity ?? {});
  const severityTotal = $derived(SEVERITIES.reduce((sum, sev) => sum + (Number(bySeverity[sev]) || 0), 0));
  const windowed = $derived(Boolean(stats?.severity_window_range));
  const tactics = $derived(tacticBreakdown(stats?.event_counts));
  const tacticLogMax = $derived(tactics.length ? Math.log10(tactics[0][1] + 1) : 1);
  // The window the server actually counted (it may answer a narrower or
  // wider one than the page asked for); the page range only as a fallback.
  const countedRange = $derived.by((): TimeRangeKey | string => {
    const w = stats?.severity_window_range;
    return w ? w : range;
  });
  const rangeText = $derived(range === 'all' ? 'all time' : timeRangeLabel(range).toLowerCase());
  const severityRangeText = $derived(
    countedRange === 'all'
      ? 'all time'
      : isTimeRangeKey(countedRange, true)
        ? timeRangeLabel(countedRange).toLowerCase()
        : `window ${countedRange}`,
  );

  const outcome = $derived.by(() => {
    const counts = { enforcing: 0, alert: 0, simulate: 0, failed: 0 };
    const policies = new Map<string, { name: string; action: string; count: number }>();
    for (const entry of enforcement) {
      if (entry.action === 'kill' || entry.action === 'block') counts.enforcing += 1;
      else if (entry.action === 'alert') counts.alert += 1;
      else if (entry.action === 'simulate') counts.simulate += 1;
      if (!entry.success) counts.failed += 1;
      const key = `${entry.policy_id}`;
      const item = policies.get(key) ?? { name: entry.policy_name || `Policy #${entry.policy_id}`, action: entry.action, count: 0 };
      item.count += 1;
      policies.set(key, item);
    }
    const top = [...policies.values()].sort((a, b) => b.count - a.count).slice(0, 3);
    return { ...counts, total: enforcement.length, top };
  });

  function barWidth(count: number): number {
    if (count <= 0 || tacticLogMax <= 0) return 0;
    return Math.max(4, Math.min(100, (Math.log10(count + 1) / tacticLogMax) * 100));
  }
</script>

<section class="activity" aria-labelledby="activity-title">
  <h2 id="activity-title" class="section-title">Activity</h2>
  <div class="grid">
    <div class="panel">
      <h3>Events by severity</h3>
      <p class="caption">
        {#if windowed}
          {formatNumber(severityTotal)} stored runtime events, {severityRangeText}.
        {:else if stats}
          {formatNumber(severityTotal)} events counted by the agent since it started; the live stream supplies range-adjusted counts.
        {:else}
          No statistics reported yet.
        {/if}
      </p>
      {#if severityTotal > 0}
        <div class="sev-bar" aria-hidden="true">
          {#each SEVERITIES as sev (sev)}
            {@const count = Number(bySeverity[sev]) || 0}
            {#if count > 0}<span style:width="{(count / severityTotal) * 100}%" style:background={severityColor(sev)}></span>{/if}
          {/each}
        </div>
        <ul class="legend">
          {#each SEVERITIES as sev (sev)}
            {@const count = Number(bySeverity[sev]) || 0}
            <li>
              <button type="button" class="legend-item" onclick={() => onexplore({ traceFilters: { severity: sev } })} title={`Open ${sev} events in Explore`}>
                <span class="dot" style:background={severityColor(sev)} aria-hidden="true"></span>
                <span class="legend-label">{sev}</span>
                <span class="legend-count">{formatNumber(count, 'compact')}</span>
              </button>
            </li>
          {/each}
        </ul>
      {:else if stats}
        <p class="empty">No events counted.</p>
      {/if}
      <Button variant="ghost" size="sm" onclick={() => onexplore({ minSeverity: 'high' })}>Open high and critical events</Button>
    </div>

    <div class="panel">
      <h3>ATT&amp;CK tactic relevance</h3>
      <p class="caption">Heuristic mapping from event names; counts are observations, not confirmed attacks. Log scale.</p>
      {#if tactics.length}
        <ul class="tactics">
          {#each tactics as [tactic, count] (tactic)}
            <li>
              <button type="button" class="tactic" onclick={() => onexplore({ traceFilters: { tactic } })} title={`Open ${tactic} events in Explore (${formatNumber(count)})`}>
                <span class="tactic-name">{tactic}</span>
                <span class="tactic-bar" aria-hidden="true"><span style:width="{barWidth(count)}%"></span></span>
                <span class="tactic-count">{formatNumber(count, 'compact')}</span>
              </button>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="empty">No mapped events reported.</p>
      {/if}
    </div>

    <div class="panel">
      <h3>Enforcement outcomes</h3>
      <p class="caption">Policy actions recorded in {rangeText}{outcome.total >= 1000 ? ' (newest 1,000)' : ''}.</p>
      {#if enforcementError}
        <p class="empty">{enforcementError}</p>
      {:else if enforcementLoading && outcome.total === 0}
        <p class="empty">Loading…</p>
      {:else if outcome.total === 0}
        <p class="empty">No policy acted in this range. Policies live under the Policies tab.</p>
      {:else}
        <dl class="outcome">
          <div><dt>Kill or block requests</dt><dd>{formatNumber(outcome.enforcing)}</dd></div>
          <div><dt>Alerts</dt><dd>{formatNumber(outcome.alert)}</dd></div>
          <div><dt>Simulated</dt><dd>{formatNumber(outcome.simulate)}</dd></div>
          <div><dt>Not accepted</dt><dd>{formatNumber(outcome.failed)}</dd></div>
        </dl>
        {#if outcome.top.length}
          <h4 class="sub">Most active policies</h4>
          <ul class="top-policies">
            {#each outcome.top as policy (policy.name)}
              <li><span class="clip">{policy.name}</span> <Badge tone={enforcementTone(policy.action)}>{policy.action}</Badge> <span class="count">{formatNumber(policy.count)}×</span></li>
            {/each}
          </ul>
        {/if}
      {/if}
      <Button variant="ghost" size="sm" onclick={() => onexplore({ source: 'enforcement' })}>Open enforcement actions</Button>
    </div>
  </div>
</section>

<style>
  .activity { display: grid; gap: var(--sp-3); min-width: 0; }
  .section-title { margin: 0; font-size: var(--fs-md); font-weight: var(--fw-semibold); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 18rem), 1fr)); gap: var(--sp-3); }
  .panel { display: grid; align-content: start; gap: var(--sp-2); min-width: 0; padding: var(--sp-4); border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-card); }
  h3 { margin: 0; font-size: var(--fs-base); font-weight: var(--fw-semibold); }
  .sub { margin: var(--sp-2) 0 0; font-size: var(--fs-xs); color: var(--text-muted); font-weight: var(--fw-semibold); }
  .caption, .empty { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.5; }
  .sev-bar { display: flex; height: 8px; border-radius: var(--radius); overflow: hidden; background: var(--bg-tertiary); }
  .sev-bar span { display: block; height: 100%; }
  .legend, .tactics, .top-policies { list-style: none; margin: 0; padding: 0; display: grid; gap: calc(var(--sp-1) / 2); }
  .legend-item, .tactic { width: 100%; display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-1) var(--sp-2); border: 0; border-radius: var(--radius); background: none; color: var(--text-secondary); font-size: var(--fs-sm); cursor: pointer; text-align: left; }
  .legend-item:hover, .tactic:hover { background: var(--bg-hover); color: var(--text-primary); }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .legend-label { text-transform: capitalize; }
  .legend-count, .tactic-count, .count { margin-left: auto; color: var(--text-muted); font-size: var(--fs-xs); font-variant-numeric: tabular-nums; }
  .tactic-name { flex: 0 0 10rem; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tactic-bar { flex: 1; height: 6px; border-radius: var(--radius); background: var(--bg-tertiary); overflow: hidden; }
  .tactic-bar span { display: block; height: 100%; background: var(--chart-neutral); }
  .tactic-count { margin-left: 0; min-width: 3rem; text-align: right; }
  .outcome { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--sp-2); margin: 0; }
  .outcome div { min-width: 0; }
  .outcome dt { font-size: var(--fs-xs); color: var(--text-muted); }
  .outcome dd { margin: 0; font-size: var(--fs-lg); font-weight: var(--fw-semibold); font-variant-numeric: tabular-nums; }
  .top-policies li { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm); min-width: 0; }
  .clip { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  @media (max-width: 480px) { .tactic-name { flex-basis: 7rem; } }
</style>
