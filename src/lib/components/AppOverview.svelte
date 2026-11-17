<!--
  AppOverview: the Monitoring tab of an application.

  One time range in the header drives every widget (KPIs, traffic chart,
  top lists, geography). KPIs show the change against the previous window.
  The traffic chart plots requests and the block rate. Top IPs, categories,
  URIs and user agents link to the Decisions tab filtered to that value; the
  decision feed with its live tail, column chooser and detail drawer lives
  there. The map appears only when there are points to show; popups are
  escaped.

  Requests: one batch per range change or refresh (8 in parallel), refreshed
  every 30 s while the tab is visible.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import {
    getAppWAFGeo,
    getAppWAFSummary,
    getAppWAFTimeline,
    getAppWAFTop,
    type GeoLocation,
    type WAFEventTimelineBucket,
    type WAFEventTopRow,
    type WAFSummary,
  } from '#lib/api.js';
  import { createPoller } from '#lib/polling.svelte.js';
  import { Button, DateTime, InlineError, KpiStrip, Spinner, TimeRangePicker, type KpiItem } from '#lib/components/ui/index.js';
  import { inRangeText, timeRangeLabel, timeRangeMinutes, timeRangeWindow, type TimeRangeKey } from '#lib/components/ui/time-range.js';
  import { formatCount, formatDuration, formatNumber, formatPercent } from '#lib/format.js';
  import { decisionMethodSplit } from '#lib/detection-quality.js';
  import type { FeedFilter } from '#lib/waf-live.js';
  import DetectionQuality, { type ReviewTarget } from './DetectionQuality.svelte';
  import ShareBars from './ShareBars.svelte';
  import TrafficTimeline from './apps/TrafficTimeline.svelte';
  import TopList from './apps/TopList.svelte';
  import AppGeoMap from './apps/AppGeoMap.svelte';
  import { mappableLocations, topCountries } from './apps/geo';
  import { countryFlag } from '#lib/geo.js';
  import { deltaText, periodDelta } from './apps/timeline';

  let {
    projectId,
    appId,
    range = '1h',
    onrangechange,
    feedHref,
  }: {
    projectId: string;
    appId: string;
    range?: TimeRangeKey;
    onrangechange: (range: TimeRangeKey) => void;
    /** Link to the Decisions tab with a filter applied. */
    feedHref: (filter: Partial<FeedFilter>) => string;
  } = $props();

  const REFRESH_MS = 30_000;
  const MAX_MINUTES = 30 * 24 * 60; // retention: a doubled 30-day window has no previous data

  let summary = $state<WAFSummary | null>(null);
  let doubled = $state<WAFSummary | null>(null);
  let timeline = $state<WAFEventTimelineBucket[]>([]);
  let topIPs = $state<WAFEventTopRow[]>([]);
  let topURIs = $state<WAFEventTopRow[]>([]);
  let topCategories = $state<WAFEventTopRow[]>([]);
  let topAgents = $state<WAFEventTopRow[]>([]);
  let geo = $state<GeoLocation[]>([]);
  let loading = $state(true);
  let error = $state('');
  let geoError = $state('');
  let loadedAt = $state<number | null>(null);
  let epoch = 0;
  /** Bumped with every load so the Detection quality panel refreshes with the tab. */
  let fpToken = $state(0);

  const minutes = $derived(timeRangeMinutes(range) ?? 60);
  const rangeLabel = $derived(timeRangeLabel(range));

  async function load() {
    const my = ++epoch;
    fpToken++;
    const project = projectId;
    const app = appId;
    const mins = minutes;
    const key = range;
    loading = true;
    const { from, to } = timeRangeWindow(key);
    const fromTs = from ? Math.floor(from.getTime() / 1000) : undefined;
    const toTs = Math.floor(to.getTime() / 1000);
    const [s, s2, tl, ips, uris, cats, uas, g] = await Promise.all([
      getAppWAFSummary(project, app, mins),
      mins * 2 <= MAX_MINUTES ? getAppWAFSummary(project, app, mins * 2) : Promise.resolve({ data: undefined, error: undefined }),
      getAppWAFTimeline(project, app, { minutes: mins }),
      getAppWAFTop(project, app, 'ips', { minutes: mins, limit: 10 }),
      getAppWAFTop(project, app, 'uris', { minutes: mins, limit: 10 }),
      getAppWAFTop(project, app, 'categories', { minutes: mins, limit: 10 }),
      getAppWAFTop(project, app, 'user_agents', { minutes: mins, limit: 8 }),
      getAppWAFGeo(project, app, { from_ts: fromTs, to_ts: toTs, limit: 500 }),
    ]);
    if (my !== epoch) return;
    loading = false;
    const failed = s.error ?? tl.error ?? ips.error ?? uris.error ?? cats.error ?? uas.error;
    error = failed ? failed.error || 'Could not load monitoring data.' : '';
    if (s.data) summary = s.data;
    doubled = s2.data ?? null;
    if (tl.data) timeline = tl.data.buckets ?? [];
    if (ips.data) topIPs = ips.data.rows ?? [];
    if (uris.data) topURIs = uris.data.rows ?? [];
    if (cats.data) topCategories = cats.data.rows ?? [];
    if (uas.data) topAgents = uas.data.rows ?? [];
    // Keep the last map of this range on a transient geo failure, but say so.
    geoError = g.error ? g.error.error || 'Could not load request origins.' : '';
    if (g.data) geo = g.data.locations ?? [];
    if (!failed) loadedAt = Date.now();
  }

  const poller = createPoller(() => load(), REFRESH_MS, { immediate: false });

  let lastKey = '';
  $effect(() => {
    const key = `${projectId}|${appId}|${range}`;
    untrack(() => {
      // A new app or a new range: figures of the old window must not stay
      // under the new range label while (or if) the new batch loads.
      if (key !== lastKey) {
        lastKey = key;
        error = '';
        geoError = '';
        summary = null;
        doubled = null;
        timeline = [];
        topIPs = [];
        topURIs = [];
        topCategories = [];
        topAgents = [];
        geo = [];
        loadedAt = null;
      }
      epoch++; // a response for the previous range must not land
      void poller.trigger();
    });
  });

  // ── KPIs ────────────────────────────────────────────────────────────────
  // No summary (still loading, or the request failed): "n/a", never a 0 that
  // reads as "no traffic".
  const count = (value: number | undefined): string => (summary ? formatNumber(value ?? 0, 'compact') : 'n/a');

  const kpis: KpiItem[] = $derived.by(() => {
    const s = summary;
    const d2 = doubled;
    const requests = s?.requests ?? 0;
    const blocks = s?.blocks ?? 0;
    return [
      {
        label: 'Requests',
        value: count(s?.requests),
        detail: s ? deltaText(periodDelta(requests, d2?.requests), rangeLabel) : undefined,
        hint: s ? `${formatNumber(requests)} requests ${inRangeText(rangeLabel)}` : undefined,
      },
      {
        label: 'Blocked',
        value: count(s?.blocks),
        tone: 'block',
        detail: s ? deltaText(periodDelta(blocks, d2?.blocks), rangeLabel) : undefined,
        href: feedHref({ action: 'block' }),
      },
      {
        label: 'Block rate',
        value: s && s.requests > 0 ? formatPercent(s.block_rate, { digits: s.block_rate < 0.1 ? 2 : 1 }) : 'n/a',
      },
      {
        label: 'Logged',
        value: s ? formatNumber(s.logs + s.monitors, 'compact') : 'n/a',
        tone: 'log',
        detail: s ? `${formatNumber(s.logs)} log · ${formatNumber(s.monitors)} monitor` : undefined,
        href: feedHref({ action: 'log' }),
      },
      {
        label: 'Unique client IPs',
        value: count(s?.unique_ips),
      },
      {
        label: 'Average latency',
        value: s ? formatDuration(s.avg_latency_us, 'us') : 'n/a',
        hint: 'Time the agent spent on inspection and proxying, averaged over the range',
      },
    ];
  });

  const secondary: KpiItem[] = $derived([
    { label: 'Allowed', value: count(summary?.allows), tone: 'allow', href: feedHref({ action: 'allow' }) },
    { label: 'Challenged', value: count(summary?.challenges), tone: 'log', hint: 'Requests answered with a bot challenge instead of the application' },
    { label: 'Upstream errors', value: count(summary?.errors), tone: (summary?.errors ?? 0) > 0 ? 'warning' : 'default', hint: 'Requests that failed to reach the upstream application' },
    { label: 'WebSocket blocked', value: count(summary?.ws_messages_blocked), tone: 'block', href: feedHref({ source: 'ws', action: 'block' }) },
    { label: 'WebSocket logged', value: count(summary?.ws_messages_logged), tone: 'log', href: feedHref({ source: 'ws', action: 'log' }) },
    { label: 'WebSocket handshakes rejected', value: count(summary?.ws_handshake_rejected) },
  ]);

  // ── Decision methods ────────────────────────────────────────────────────
  const methods = $derived(decisionMethodSplit(summary));

  /** Decisions to review for the Detection quality panel (blocked first). */
  function reviewHref(target: ReviewTarget): string {
    return feedHref({ action: 'block', category: target.category ?? '' });
  }

  // ── Geography ───────────────────────────────────────────────────────────
  const points = $derived(mappableLocations(geo));
  const countries = $derived(topCountries(geo, 8));

  function uriPath(label: string): string {
    return label.split('?')[0] || label;
  }
</script>

<section class="ov" aria-labelledby="app-monitoring-title">
  <header class="ov-head">
    <div>
      <h2 id="app-monitoring-title">Monitoring</h2>
      <p class="ov-sub">{rangeLabel} · every widget uses this range.</p>
    </div>
    <div class="ov-tools">
      <TimeRangePicker value={range} onchange={(key) => onrangechange(key)} label="Monitoring time range" />
      <Button variant="secondary" size="sm" loading={loading && loadedAt !== null} onclick={() => void poller.trigger()}>Refresh</Button>
      <Button variant="ghost" size="sm" href={feedHref({})}>Live tail and decisions</Button>
    </div>
  </header>

  <InlineError message={error} onretry={() => void poller.trigger()} />

  {#if loading && !summary}
    <Spinner layout="block" tone="accent" label="Loading monitoring data" />
  {:else}
    <KpiStrip items={kpis} label={`Key figures, ${rangeLabel.toLowerCase()}`} />
    <KpiStrip items={secondary} label={`More counters, ${rangeLabel.toLowerCase()}`} minItemWidth="150px" class="ov-secondary" />

    <div class="ov-grid">
      <section class="panel panel-wide" aria-labelledby="app-traffic-title">
        <header class="panel-head">
          <h3 id="app-traffic-title">Traffic and block rate</h3>
        </header>
        <TrafficTimeline buckets={timeline} {rangeLabel} />
      </section>

      <section class="panel" aria-labelledby="app-methods-title">
        <header class="panel-head">
          <h3 id="app-methods-title">Decision methods</h3>
          <p>Stored decisions by analysis method, including allowed traffic. A match does not confirm an attack.</p>
        </header>
        {#if methods.total === 0}
          <p class="panel-empty">No analysis results {inRangeText(rangeLabel)}.</p>
        {:else}
          <ShareBars items={methods.items} label="Decisions by analysis method" />
        {/if}
      </section>
    </div>

    <DetectionQuality {projectId} {appId} {range} compact headingLevel={3} reloadToken={fpToken} {reviewHref} />

    <div class="ov-tops">
      <section class="panel">
        <TopList
          title="Client IPs with blocked or logged decisions"
          subtitle="Select an address to open its decisions."
          rows={topIPs}
          emptyText="No blocked or logged clients in this range."
          mono
          hrefFor={(ip) => feedHref({ q: ip })}
          linkLabel={(ip) => `Show decisions from ${ip}`}
        />
      </section>
      <section class="panel">
        <TopList
          title="Matched categories"
          subtitle="Categories attached to decisions; a match does not confirm an attack."
          rows={topCategories}
          emptyText="No categories matched in this range."
          hrefFor={(category) => feedHref({ category })}
          linkLabel={(category) => `Show decisions in category ${category}`}
        />
      </section>
      <section class="panel">
        <TopList
          title="Most requested URIs"
          subtitle="Includes allowed traffic."
          rows={topURIs}
          emptyText="No requests in this range."
          mono
          hrefFor={(uri) => feedHref({ q: uriPath(uri) })}
          linkLabel={(uri) => `Show decisions for ${uriPath(uri)}`}
        />
      </section>
      <section class="panel">
        <TopList
          title="Top user agents"
          subtitle="Useful for spotting scanners and bots."
          rows={topAgents}
          emptyText="No user agents recorded in this range."
          mono
          hrefFor={(ua) => feedHref({ q: ua.slice(0, 256) })}
          linkLabel={(ua) => `Show decisions from user agent ${ua}`}
        />
      </section>
    </div>

    {#if geoError && geo.length === 0}
      <section class="panel" aria-labelledby="app-geo-title">
        <header class="panel-head"><h3 id="app-geo-title">Request origins</h3></header>
        <InlineError message={geoError} onretry={() => void poller.trigger()} />
      </section>
    {:else if geo.length > 0}
      <section class="panel" aria-labelledby="app-geo-title">
        <header class="panel-head">
          <h3 id="app-geo-title">Request origins</h3>
          <p>{formatCount(geo.length, 'client IP')} {inRangeText(rangeLabel)}. Marker colour is the strictest decision for that IP; size grows with requests.</p>
        </header>
        <InlineError message={geoError ? `${geoError} Showing the last loaded origins.` : ''} onretry={() => void poller.trigger()} />
        <div class="geo" class:with-map={points.length > 0}>
          {#if points.length > 0}
            <AppGeoMap locations={geo} label={`Map of ${formatCount(points.length, 'client IP')} with a known location`} />
          {/if}
          <div class="countries">
            <h4>Top countries</h4>
            <ol>
              {#each countries as c (c.code)}
                <li style:--pct={`${c.pct}%`}>
                  <span class="country-flag" aria-hidden="true">{countryFlag(c.code)}</span>
                  <span class="country-name" title={c.name}>{c.name}</span>
                  <span class="country-count">{formatNumber(c.count, 'compact')}{#if c.block > 0}<span class="country-block">{` · ${formatNumber(c.block, 'compact')} blocked`}</span>{/if}</span>
                  <span class="country-bar" aria-hidden="true"></span>
                </li>
              {/each}
            </ol>
            {#if points.length === 0}<p class="panel-empty">No coordinates were recorded for these clients, so there is no map.</p>{/if}
          </div>
        </div>
      </section>
    {/if}

    {#if loadedAt}
      <p class="ov-updated">Updated <DateTime value={loadedAt} seconds /> · refreshes every 30 s while this tab is visible.</p>
    {/if}
  {/if}
</section>

<style>
  .ov { display: flex; flex-direction: column; gap: var(--sp-4); min-width: 0; }
  .ov-head { display: flex; justify-content: space-between; align-items: flex-end; gap: var(--sp-4); flex-wrap: wrap; }
  .ov-head h2 { margin: 0; font-size: var(--fs-md); }
  .ov-sub { margin: var(--sp-1) 0 0; font-size: var(--fs-sm); color: var(--text-muted); }
  .ov-tools { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
  .ov :global(.ov-secondary) { font-size: var(--fs-sm); }

  .ov-grid { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); gap: var(--sp-4); }
  .ov-tops { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--sp-4); }
  .panel { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: var(--sp-4); min-width: 0; display: flex; flex-direction: column; gap: var(--sp-3); }
  .panel-head h3 { margin: 0; font-size: var(--fs-base); }
  .panel-head p { margin: var(--sp-1) 0 0; font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.45; }
  .panel-empty { margin: 0; font-size: var(--fs-sm); color: var(--text-muted); }


  .geo { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--sp-4); }
  .geo.with-map { grid-template-columns: minmax(0, 2fr) minmax(14rem, 1fr); }
  .countries h4 { margin: 0 0 var(--sp-2); font-size: var(--fs-sm); color: var(--text-secondary); }
  .countries ol { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-1); }
  .countries li { position: relative; display: grid; grid-template-columns: 1.5rem minmax(0, 1fr) auto; min-height: 2rem; gap: var(--sp-2); align-items: center; padding: var(--sp-1) var(--sp-2); font-size: var(--fs-sm); }
  .country-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-secondary); position: relative; z-index: 1; }
  .country-flag { position: relative; z-index: 1; line-height: 1; }
  .country-count { color: var(--text-primary); font-variant-numeric: tabular-nums; position: relative; z-index: 1; }
  .country-block { color: var(--block); }
  .country-bar { position: absolute; inset: 0 auto 0 0; width: var(--pct); background: var(--bg-hover); border-radius: var(--radius); }

  .ov-updated { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }

  @media (max-width: 1100px) {
    .ov-grid { grid-template-columns: minmax(0, 1fr); }
    .geo.with-map { grid-template-columns: minmax(0, 1fr); }
  }
  @media (max-width: 760px) { .ov-tops { grid-template-columns: minmax(0, 1fr); } }
</style>
