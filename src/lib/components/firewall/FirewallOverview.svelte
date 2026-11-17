<!--
  FirewallOverview: the Firewall "Overview" tab. One time range
  for every range-bound figure; live counters are labelled as cumulative since
  the agent started and are never added to range totals. Drop reasons
  are categories (fixed --cat-* order), not verdicts.
-->
<script lang="ts">
  import './controls.css';
  import Icon from 'svelte-awesome/components/Icon.svelte';
  import refresh from 'svelte-awesome/icons/refresh';
  import KpiStrip from '#lib/components/ui/KpiStrip.svelte';
  import DataTable from '#lib/components/ui/DataTable.svelte';
  import TimeRangePicker from '#lib/components/ui/TimeRangePicker.svelte';
  import Alert from '#lib/components/ui/Alert.svelte';
  import InlineError from '#lib/components/ui/InlineError.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import StatusDot from '#lib/components/ui/StatusDot.svelte';
  import DateTime from '#lib/components/ui/DateTime.svelte';
  import Spinner from '#lib/components/ui/Spinner.svelte';
  import HostConfigEvidence from '#lib/components/HostConfigEvidence.svelte';
  import type { KpiItem, DataTableColumn } from '#lib/components/ui/types.js';
  import type { TimeRangeKey } from '#lib/components/ui/time-range.js';
  import type { EBPFMetrics, EBPFStatus, FirewallAnalytics, FirewallDropsSummary, FirewallTopIPRow } from '#lib/api.js';
  import { categoricalColor } from '#lib/tone.js';
  import { formatBitRate, formatBytes, formatCount, formatNumber, formatPercent, formatRelative, utcHourBucketsToLocal } from '#lib/format.js';
  import { countryFlag, formatCountryName } from '#lib/geo.js';

  let {
    range,
    onrangechange,
    rangeNotice = null,
    analytics = null,
    analyticsLoading = false,
    analyticsError = null,
    onretryanalytics,
    dropsSummary = null,
    dropsError = null,
    topIPs = [],
    topIPsLoading = false,
    topIPsError = null,
    onreloadtopips,
    metrics = null,
    metricsHistory = [],
    status,
    portAllowHits = 0,
    canConfigure = false,
    onblockip,
  }: {
    range: TimeRangeKey;
    onrangechange: (range: TimeRangeKey) => void;
    /** Shown when the control plane answered for a different window. */
    rangeNotice?: string | null;
    analytics?: FirewallAnalytics | null;
    analyticsLoading?: boolean;
    analyticsError?: string | null;
    onretryanalytics: () => void;
    dropsSummary?: FirewallDropsSummary | null;
    /** The drop summary request failed; never shown as "no drops". */
    dropsError?: string | null;
    topIPs?: readonly FirewallTopIPRow[];
    topIPsLoading?: boolean;
    /** The top-sources request failed; never shown as "no dropped traffic". */
    topIPsError?: string | null;
    onreloadtopips: () => void;
    metrics?: EBPFMetrics | null;
    metricsHistory?: readonly EBPFMetrics[];
    status: EBPFStatus;
    portAllowHits?: number;
    canConfigure?: boolean;
    /** Opens Add rules with the address prefilled in the blocklist. */
    onblockip: (ip: string) => void;
  } = $props();

  const REASONS = [
    { key: 'blocklist', label: 'Blocklist' },
    { key: 'syn_flood', label: 'SYN flood' },
    { key: 'rate_limit', label: 'Rate limit' },
    { key: 'geo_block', label: 'Geo-blocking' },
    { key: 'port_scan', label: 'Port scan' },
    { key: 'port_policy', label: 'Port rules' },
    { key: 'egress', label: 'Egress blocklist' },
  ] as const;
  type ReasonKey = (typeof REASONS)[number]['key'];

  // A failed drops request falls back to the analytics figures, never to "no drops".
  const drops = $derived<FirewallDropsSummary | null>(dropsSummary ?? analytics?.drops_current ?? null);
  const dropsTotal = $derived(drops ? REASONS.reduce((sum, reason) => sum + (drops[reason.key] ?? 0), 0) : 0);

  const rangeItems = $derived.by((): KpiItem[] => {
    if (!analytics) return [];
    const delta = analytics.total_current - analytics.total_previous;
    const previous = range === 'all' ? undefined
      : analytics.total_previous > 0 ? `${delta >= 0 ? '+' : '−'}${formatNumber(Math.abs(delta))} vs previous period`
      : 'no drops in the previous period';
    return [
      { label: 'Drops', value: formatNumber(analytics.total_current), detail: previous },
      { label: 'Blocked sources', value: formatNumber(analytics.unique_ips), detail: 'unique source addresses' },
      { label: 'Countries', value: formatNumber(analytics.countries_count), detail: 'origins of dropped traffic' },
      { label: 'Active rules', value: formatNumber(analytics.active_rules), detail: 'on this host' },
    ];
  });

  const liveItems = $derived.by((): KpiItem[] => {
    if (!metrics) return [];
    const rate = metrics.drop_rate_pct;
    const items: KpiItem[] = [
      { label: 'Packets per second', value: formatNumber(metrics.pps, 'compact') },
      { label: 'Throughput', value: formatBitRate(metrics.bps * 8) },
      { label: 'Drop rate', value: formatPercent(rate, { input: 'percent', digits: 2 }), tone: rate > 5 ? 'danger' : rate > 1 ? 'warning' : 'default', toneText: rate > 5 ? 'high' : rate > 1 ? 'elevated' : undefined },
      { label: 'Flows tracked', value: formatNumber(metrics.conntrack_entries), detail: 'since the agent started' },
    ];
    if (typeof metrics.would_drop_packets === 'number') {
      items.push({ label: 'Would-drop packets', value: formatNumber(metrics.would_drop_packets), detail: 'counted in monitor-only mode' });
    }
    return items;
  });

  const ppsMax = $derived(Math.max(1, ...metricsHistory.map((m) => m.pps)));
  const bpsMax = $derived(Math.max(1, ...metricsHistory.map((m) => m.bps)));

  type RankedRow = FirewallTopIPRow & { rank: number };
  const rankedIPs = $derived<RankedRow[]>(topIPs.map((row, index) => ({ ...row, rank: index + 1 })));
  const ipColumns: DataTableColumn<RankedRow>[] = [
    { key: 'rank', label: 'Rank', align: 'right', width: '4rem', sortable: true },
    { key: 'src_ip', label: 'Source address', rowHeader: true, sortable: true },
    { key: 'country', label: 'Country', sortable: true, value: (row) => formatCountryName(row.country_name, row.country_code) },
    { key: 'reasons', label: 'Drop reasons' },
    { key: 'total', label: 'Drops', align: 'right', sortable: true, firstSortDir: 'desc' },
  ];

  function reasonsOf(row: FirewallTopIPRow): string {
    const parts: string[] = [];
    for (const reason of REASONS) {
      const n = (row as unknown as Record<string, number>)[reason.key] ?? 0;
      if (n > 0) parts.push(`${reason.label} ${formatNumber(n, 'compact')}`);
    }
    return parts.join(' · ') || 'Other';
  }

  // peak_hours is indexed by UTC hour; show it by the viewer's local hour.
  // A zone with a fractional offset keeps UTC buckets and says so.
  const peak = $derived.by(() => {
    const utc = analytics?.peak_hours ?? [];
    if (!utc.some((n) => n > 0)) return null;
    const local = utcHourBucketsToLocal(utc);
    const hours = local ?? utc;
    const max = Math.max(...hours);
    return { hours, max, hour: hours.indexOf(max), zone: local ? '' : ' UTC' };
  });
  const pad = (n: number) => String(n).padStart(2, '0');
</script>

<div class="ov">
  <div class="ov-range">
    <TimeRangePicker value={range} includeAll label="Time range for drops and top sources" onchange={onrangechange} />
    {#if analyticsLoading}<Spinner size="sm" label="Updating" />{/if}
    {#if analytics?.since && range !== 'all'}
      <span class="fw-muted ov-since">Since <DateTime value={analytics.since} /></span>
    {:else if range === 'all'}
      <span class="fw-muted ov-since">All retained events</span>
    {/if}
  </div>
  {#if rangeNotice}<Alert tone="info" compact message={rangeNotice} />{/if}
  {#if analyticsError}<InlineError message={analyticsError} onretry={onretryanalytics} />{/if}

  {#if rangeItems.length}
    <KpiStrip label="Selected time range" items={rangeItems} />
  {/if}

  {#if liveItems.length}
    <section class="fw-panel" aria-labelledby="fw-live-title">
      <div class="fw-panel-head">
        <h2 id="fw-live-title">Live counters</h2>
        <p class="fw-panel-sub">Current rates and totals since the agent started; not limited to the time range.</p>
      </div>
      <KpiStrip label="Live counters" items={liveItems} />
      {#if metricsHistory.length > 1}
        <div class="ov-sparks">
          <figure class="spark">
            <figcaption>Packets per second, last {metricsHistory.length} samples</figcaption>
            <div class="spark-bars" aria-hidden="true">
              {#each metricsHistory as sample, index (index)}<span style:height={`${Math.max((sample.pps / ppsMax) * 100, 2)}%`}></span>{/each}
            </div>
          </figure>
          <figure class="spark">
            <figcaption>Throughput, last {metricsHistory.length} samples</figcaption>
            <div class="spark-bars is-alt" aria-hidden="true">
              {#each metricsHistory as sample, index (index)}<span style:height={`${Math.max((sample.bps / bpsMax) * 100, 2)}%`}></span>{/each}
            </div>
          </figure>
        </div>
      {/if}
    </section>
  {:else if !status.running}
    <Alert tone="info" compact message="The firewall is not running on this host, so there are no live counters." />
  {/if}

  <div class="ov-grid">
    <section class="fw-panel" aria-labelledby="fw-drops-title">
      <div class="fw-panel-head">
        <h2 id="fw-drops-title">Drops by reason</h2>
        {#if drops}<span class="fw-muted">{formatCount(dropsTotal, 'drop')}</span>{/if}
      </div>
      {#if dropsError}<InlineError message={dropsError} onretry={onretryanalytics} />{/if}
      {#if drops}
        <ul class="bars">
          {#each REASONS as reason, index (reason.key)}
            {@const value = drops[reason.key as ReasonKey] ?? 0}
            <li class="bar-row">
              <span class="bar-label"><span class="bar-dot" style:background={categoricalColor(index)} aria-hidden="true"></span>{reason.label}</span>
              <span class="bar-track" aria-hidden="true"><span class="bar-fill" style:width={`${dropsTotal > 0 && value > 0 ? Math.max((value / dropsTotal) * 100, 2) : 0}%`} style:background={categoricalColor(index)}></span></span>
              <span class="bar-value">{formatNumber(value, 'compact')}</span>
            </li>
          {/each}
        </ul>
        <p class="fw-panel-sub">{range === 'all' ? 'All retained drop events for this host.' : 'Drop events recorded in the selected time range.'} Drops show matched rules, not confirmed attacks.</p>
      {:else if !dropsError}
        <p class="fw-panel-sub">No drop summary yet.</p>
      {/if}
    </section>

    <section class="fw-panel" aria-labelledby="fw-traffic-title">
      <div class="fw-panel-head">
        <h2 id="fw-traffic-title">Traffic since agent start</h2>
      </div>
      {#if metrics}
        <dl class="facts">
          <div><dt>Received packets</dt><dd>{formatNumber(metrics.rx_packets)}</dd></div>
          <div><dt>Received bytes</dt><dd>{formatBytes(metrics.rx_bytes)}</dd></div>
          <div><dt>Sent packets</dt><dd>{formatNumber(metrics.tx_packets)}</dd></div>
          <div><dt>Dropped packets</dt><dd>{formatNumber(metrics.dropped_packets)}</dd></div>
          <div><dt>Allowlist passes</dt><dd>{formatNumber(metrics.allowlist_passes)}</dd></div>
          <div><dt>Port ALLOW rule hits</dt><dd>{formatNumber(portAllowHits)}</dd></div>
          <div><dt>Port rule drops</dt><dd>{formatNumber(metrics.port_policy_drops ?? 0)}</dd></div>
          <div><dt>Egress blocklist drops</dt><dd>{formatNumber(metrics.egress_ip_drops ?? 0)}</dd></div>
        </dl>
      {:else}
        <p class="fw-panel-sub">No counters reported yet.</p>
      {/if}
    </section>
  </div>

  <section class="fw-panel" aria-labelledby="fw-top-title">
    <div class="fw-panel-head">
      <h2 id="fw-top-title">Top sources of dropped traffic</h2>
      <Button variant="ghost" size="sm" onclick={onreloadtopips} disabled={topIPsLoading} aria-label="Reload top sources"><Icon data={refresh} scale={0.8} /> Reload</Button>
    </div>
    <DataTable
      rows={rankedIPs}
      columns={ipColumns}
      rowKey={(row) => row.src_ip}
      caption="Top sources of dropped traffic"
      itemLabel="sources"
      pageSize={10}
      density="compact"
      loading={topIPsLoading && topIPs.length === 0}
      error={topIPsError}
      onretry={onreloadtopips}
      emptyTitle="No dropped traffic in this time range"
      emptyMessage="Sources appear here once the firewall drops packets from them."
      actionsLabel="Block"
    >
      {#snippet cell(row, column)}
        {#if column.key === 'src_ip'}
          <code class="fw-mono">{row.src_ip}</code>
        {:else if column.key === 'country'}
          <span aria-hidden="true">{countryFlag(row.country_code)}</span> {formatCountryName(row.country_name, row.country_code)}
        {:else if column.key === 'reasons'}
          <span class="fw-muted">{reasonsOf(row)}</span>
        {:else if column.key === 'total'}
          <strong>{formatNumber(row.total)}</strong>
        {:else}
          {row.rank}
        {/if}
      {/snippet}
      {#snippet actions(row)}
        <Button variant="ghost" size="sm" disabled={!canConfigure} aria-label={`Block ${row.src_ip}`} onclick={() => onblockip(row.src_ip)}>Block…</Button>
      {/snippet}
    </DataTable>
  </section>

  <div class="ov-grid">
    {#if analytics?.attack_origins?.length}
      <section class="fw-panel" aria-labelledby="fw-origins-title">
        <div class="fw-panel-head">
          <h2 id="fw-origins-title">Origins of dropped traffic</h2>
          <span class="fw-muted">{formatCount(analytics.countries_count, 'country', 'countries')}</span>
        </div>
        <ul class="bars">
          {#each analytics.attack_origins.slice(0, 10) as origin (origin.code)}
            <li class="bar-row">
              <span class="bar-label">{formatCountryName(origin.name, origin.code)}</span>
              <span class="bar-track" aria-hidden="true"><span class="bar-fill is-neutral" style:width={`${Math.max(origin.pct, 2)}%`}></span></span>
              <span class="bar-value">{formatNumber(origin.count, 'compact')} <span class="fw-muted">({formatPercent(origin.pct, { input: 'percent' })})</span></span>
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    {#if peak}
      <section class="fw-panel" aria-labelledby="fw-peak-title">
        <div class="fw-panel-head">
          <h2 id="fw-peak-title">Drops by hour of day{peak.zone ? ' (UTC)' : ''}</h2>
        </div>
        <div class="peak" aria-hidden="true">
          {#each peak.hours as count, hour (hour)}
            <span class="peak-bar" class:is-peak={hour === peak.hour} style:height={`${count > 0 ? Math.max((count / peak.max) * 100, 3) : 0}%`} title={`${pad(hour)}:00${peak.zone}: ${formatNumber(count)} drops`}></span>
          {/each}
        </div>
        <div class="peak-axis" aria-hidden="true"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>23:00</span></div>
        <p class="fw-panel-sub">Most drops between <strong>{pad(peak.hour)}:00 and {pad((peak.hour + 1) % 24)}:00{peak.zone}</strong> ({formatNumber(peak.max)} drops).</p>
      </section>
    {/if}
  </div>

  {#if analytics?.agents?.length}
    <section class="fw-panel" aria-labelledby="fw-agents-title">
      <div class="fw-panel-head"><h2 id="fw-agents-title">Reporting agents</h2></div>
      <ul class="agents">
        {#each analytics.agents.slice(0, 5) as agent (agent.id)}
          <li>
            <StatusDot status={agent.online ? 'online' : 'offline'} />
            <span class="agent-name">{agent.name}</span>
            <span class="fw-muted">{agent.last_seen ? `last seen ${formatRelative(agent.last_seen)}` : 'never seen'} · registered <DateTime value={agent.registered_at} /></span>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  <details class="quality">
    <summary>
      <h2 class="quality-title">Data quality and delivery</h2>
      <span class="fw-muted quality-signals">
        {#if status.coverage_warnings?.length}{formatCount(status.coverage_warnings.length, 'coverage note')} · {/if}
        {#if status.telemetry_delivery}{formatNumber(status.telemetry_delivery.pending_batches)} pending · {formatNumber(status.telemetry_delivery.dropped_events)} discarded · {/if}
        would-drop {metrics?.would_drop_packets !== undefined ? formatNumber(metrics.would_drop_packets) : 'unknown'}
      </span>
    </summary>
    <div class="quality-body">
      {#if status.coverage_warnings?.length}
        <Alert tone="warning" compact title="Coverage notes" message={status.coverage_warnings.join('; ')} />
      {/if}
      {#if status.telemetry_delivery}
        <p>Agent memory queue: {formatNumber(status.telemetry_delivery.pending_batches)} batches ({formatBytes(status.telemetry_delivery.pending_bytes)}) pending; {formatNumber(status.telemetry_delivery.process_accepted_batches)} batches accepted by the control-plane process; {formatNumber(status.telemetry_delivery.dropped_batches)} batches ({formatNumber(status.telemetry_delivery.dropped_events)} unconfirmed events) discarded. Send failures: {status.telemetry_send_failures !== undefined ? formatNumber(status.telemetry_send_failures) : 'unknown'}. Acceptance is not durable storage; a restart or queue expiry can lose data.</p>
      {/if}
      {#if status.ingestion}
        <p>Control-plane ingestion for this agent since the control plane started: {formatNumber(status.ingestion.accepted_events)} events queued, {formatNumber(status.ingestion.rejected_events)} queue rejections, {formatNumber(status.ingestion.db_write_failures)} database write failures.</p>
      {/if}
      <p>Monitor-only would-drop packets: {metrics?.would_drop_packets !== undefined ? formatNumber(metrics.would_drop_packets) : 'unknown'} (not blocked). Egress IPv6: {status.egress_ipv6_supported === undefined ? 'unknown' : status.egress_ipv6_supported ? 'supported' : 'not supported'}.</p>
      <HostConfigEvidence bundles={status.bundle_status} headingLevel={3} />
    </div>
  </details>
</div>


<style>
  .ov { display: grid; gap: var(--sp-4); min-width: 0; }
  .ov-range { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-3); }
  .ov-since { font-size: var(--fs-xs); }
  .ov-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr)); gap: var(--sp-4); }
  .ov-sparks { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr)); gap: var(--sp-4); margin-top: var(--sp-4); }
  .spark { margin: 0; }
  .spark figcaption { font-size: var(--fs-xs); color: var(--text-muted); margin-bottom: var(--sp-2); }
  .spark-bars { display: flex; align-items: flex-end; gap: calc(var(--sp-1) / 2); height: 56px; border-bottom: 1px solid var(--chart-grid); }
  .spark-bars span { flex: 1; min-width: 2px; background: var(--accent); border-radius: 1px 1px 0 0; }
  .spark-bars.is-alt span { background: var(--info); }
  .bars { display: grid; gap: var(--sp-2); margin: 0 0 var(--sp-3); padding: 0; list-style: none; }
  .bar-row { display: grid; grid-template-columns: minmax(120px, 1.2fr) minmax(60px, 2fr) auto; align-items: center; gap: var(--sp-3); font-size: var(--fs-xs); }
  .bar-label { display: inline-flex; align-items: center; gap: var(--sp-2); color: var(--text-secondary); min-width: 0; overflow-wrap: anywhere; }
  .bar-dot { width: 8px; height: 8px; border-radius: 2px; flex-shrink: 0; }
  .bar-track { height: 6px; border-radius: 3px; background: var(--chart-grid); overflow: hidden; }
  .bar-fill { display: block; height: 100%; border-radius: 3px; }
  .bar-fill.is-neutral { background: var(--chart-neutral); }
  .bar-value { text-align: right; font-variant-numeric: tabular-nums; color: var(--text-primary); white-space: nowrap; }
  .facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 200px), 1fr)); gap: var(--sp-2) var(--sp-5); margin: 0; }
  .facts div { display: flex; justify-content: space-between; gap: var(--sp-3); padding: var(--sp-1) 0; border-bottom: 1px solid var(--border); font-size: var(--fs-xs); }
  .facts dt { color: var(--text-muted); }
  .facts dd { margin: 0; color: var(--text-primary); font-variant-numeric: tabular-nums; }
  .peak { display: flex; align-items: flex-end; gap: calc(var(--sp-1) / 2); height: 80px; border-bottom: 1px solid var(--chart-grid); }
  .peak-bar { flex: 1; background: var(--chart-neutral); border-radius: 1px 1px 0 0; }
  .peak-bar.is-peak { background: var(--accent); }
  .peak-axis { display: flex; justify-content: space-between; margin: var(--sp-1) 0 var(--sp-2); font-size: var(--fs-xs); color: var(--text-muted); }
  .agents { display: grid; gap: var(--sp-2); margin: 0; padding: 0; list-style: none; }
  .agents li { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2) var(--sp-3); font-size: var(--fs-xs); }
  .agent-name { color: var(--text-primary); font-weight: var(--fw-medium); }
  .quality { border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-card); }
  .quality summary { display: flex; flex-wrap: wrap; justify-content: space-between; gap: var(--sp-2); padding: var(--sp-3) var(--sp-4); cursor: pointer; }
  .quality-title { margin: 0; font-size: var(--fs-sm); font-weight: var(--fw-semibold); color: var(--text-primary); }
  .quality-signals { font-size: var(--fs-xs); }
  .quality-body { display: grid; gap: var(--sp-3); padding: 0 var(--sp-4) var(--sp-4); }
  .quality-body p { margin: 0; font-size: var(--fs-xs); color: var(--text-secondary); line-height: 1.6; }
</style>
