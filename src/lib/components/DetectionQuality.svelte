<!--
  DetectionQuality: false-positive rate of reviewed WAF decisions.

  Reads GET …/waf/feedback/summary (24h / 7d / 30d; other page ranges are
  mapped by feedbackRangeFor and the panel says so). Shows the false-positive
  share of reviewed blocks, how many blocks were reviewed, and where false
  positives cluster (apps, categories, HTTP methods). Assessments are made in
  an application's Decisions tab (decision detail › Assessment); with none in
  the window the panel explains that instead of showing rates. A failed load
  shows an InlineError and no figures (never a 0 that reads as "no false
  positives").

  `compact` is the app Monitoring tab version: figures plus top categories
  and methods, no per-app list.
-->
<script lang="ts" module>
  export interface ReviewTarget {
    appId?: string;
    category?: string;
  }
</script>

<script lang="ts">
  import { untrack } from 'svelte';
  import { getFeedbackSummary, type FeedbackBreakdownRow, type FeedbackSummary } from '#lib/api.js';
  import { EmptyState, InlineError, KpiStrip, Spinner, type KpiItem } from '#lib/components/ui/index.js';
  import type { TimeRangeKey } from '#lib/components/ui/time-range.js';
  import { timeRangeLabel } from '#lib/components/ui/time-range.js';
  import { formatNumber } from '#lib/format.js';
  import { analyzeMethodLabel } from '#lib/components/apps/decision-format.js';
  import {
    FEEDBACK_RANGE_LABEL,
    feedbackRangeFor,
    formatFpRate,
    formatShare,
    hasReviews,
    reviewedBlockShare,
    topFalsePositives,
  } from '#lib/detection-quality.js';

  let {
    projectId,
    range,
    appId = undefined,
    compact = false,
    headingLevel = 2,
    reloadToken = 0,
    scopeNote = '',
    reviewHref,
  }: {
    projectId: string;
    /** The page's range; mapped to the nearest window the endpoint knows. */
    range: TimeRangeKey;
    /** Narrows the summary to one application. */
    appId?: string;
    compact?: boolean;
    headingLevel?: 2 | 3;
    /** Bump to reload (the page's Refresh or poll). */
    reloadToken?: number;
    /** Extra scope sentence, e.g. that a host filter does not apply. */
    scopeNote?: string;
    /** Link to decisions to review for a target; null when there is none. */
    reviewHref: (target: ReviewTarget) => string | null;
  } = $props();

  const window_ = $derived(feedbackRangeFor(range));
  const windowLabel = $derived(FEEDBACK_RANGE_LABEL[window_.range]);
  const uid = $props.id();

  let summary = $state<FeedbackSummary | null>(null);
  let loading = $state(false);
  let error = $state('');
  let epoch = 0;
  let controller: AbortController | null = null;

  async function load() {
    const my = ++epoch;
    controller?.abort();
    const ctl = new AbortController();
    controller = ctl;
    loading = true;
    error = '';
    const res = await getFeedbackSummary(projectId, window_.range, { appId, signal: ctl.signal });
    if (my !== epoch || ctl.signal.aborted) return;
    loading = false;
    if (res.error || !res.data) {
      summary = null;
      error =
        res.error?.status === 404
          ? 'The false-positive summary is not available from this control plane (404). Upgrade the control plane to see it.'
          : res.error?.error || 'The false-positive summary could not be loaded.';
      return;
    }
    summary = res.data;
  }

  let lastKey = '';
  $effect(() => {
    const key = `${projectId}|${appId ?? ''}|${window_.range}`;
    void reloadToken;
    untrack(() => {
      // A new scope or window: old figures must not stay under the new label.
      if (key !== lastKey) {
        lastKey = key;
        summary = null;
      }
      void load();
    });
  });
  $effect(() => () => {
    epoch++;
    controller?.abort();
  });

  const totals = $derived(summary?.totals ?? null);
  const reviewed = $derived(hasReviews(totals));
  const share = $derived(reviewedBlockShare(totals));

  const kpis: KpiItem[] = $derived.by(() => {
    const t = totals;
    if (!t) return [];
    return [
      {
        label: 'False-positive block rate',
        value: formatFpRate(t.fp_block_rate),
        detail:
          t.reviewed_blocks > 0
            ? `${formatNumber(t.false_positive_blocks)} of ${formatNumber(t.reviewed_blocks)} reviewed blocks`
            : 'No blocked decision reviewed yet',
        hint: 'Reviewed blocked decisions assessed as false positive',
      },
      {
        label: 'Blocks reviewed',
        value: formatShare(share),
        detail: t.blocks > 0 ? `${formatNumber(t.reviewed_blocks)} of ${formatNumber(t.blocks)} blocks` : 'No blocked decisions in this window',
        hint: 'Share of blocked decisions that carry an assessment',
      },
      {
        label: 'Assessed decisions',
        value: formatNumber(t.reviewed),
        detail: `${formatNumber(t.true_positive)} true · ${formatNumber(t.false_positive)} false · ${formatNumber(t.unsure)} unsure`,
        hint: 'Blocked and logged decisions with at least one assessment',
      },
    ];
  });

  const limit = $derived(compact ? 3 : 5);
  const lists = $derived.by(() => {
    const s = summary;
    if (!s) return [];
    // target null = no link: traffic no app claims (key "") has no Decisions
    // tab, and the decision feed has no detection-method filter.
    const all: { id: string; title: string; rows: FeedbackBreakdownRow[]; target: (row: FeedbackBreakdownRow) => ReviewTarget | null; label?: (row: FeedbackBreakdownRow) => string; mono?: boolean }[] = [];
    if (!compact) all.push({ id: 'apps', title: 'Applications', rows: topFalsePositives(s.by_app, limit), target: (row) => (row.key ? { appId: row.key } : null) });
    all.push({ id: 'categories', title: 'Categories', rows: topFalsePositives(s.by_category, limit), target: (row) => ({ category: row.key }) });
    all.push({ id: 'methods', title: 'Detection methods', rows: topFalsePositives(s.by_method, limit), target: () => null, label: (row) => analyzeMethodLabel(row.key) });
    return all;
  });

  /** Where to start reviewing when nothing is assessed yet. */
  const startHref = $derived.by(() => {
    if (compact || appId) return reviewHref({});
    const busiest = [...(summary?.by_app ?? [])].filter((a) => a.key).sort((a, b) => b.blocks - a.blocks)[0];
    return busiest && busiest.blocks > 0 ? reviewHref({ appId: busiest.key }) : reviewHref({});
  });
  const startLabel = $derived.by(() => {
    if (compact || appId) return 'Review blocked decisions';
    const busiest = [...(summary?.by_app ?? [])].filter((a) => a.key).sort((a, b) => b.blocks - a.blocks)[0];
    return busiest && busiest.blocks > 0 ? `Review blocked decisions of ${busiest.label || busiest.key}` : 'Open applications';
  });
</script>

<section class="dq" class:compact aria-labelledby="{uid}-title">
  <header class="dq-head">
    <div>
      <svelte:element this={`h${headingLevel}`} id="{uid}-title" class="dq-title">Detection quality</svelte:element>
      <p class="dq-sub">
        Human assessments of stored decisions, {windowLabel}.{#if window_.adjusted}
          {' '}The page shows {timeRangeLabel(range).toLowerCase()}; assessments are summarised over the {windowLabel}.{/if}{#if scopeNote}
          {' '}{scopeNote}{/if}
      </p>
    </div>
  </header>

  {#if error}
    <InlineError message={error} onretry={() => void load()} retrying={loading} />
  {:else if loading && !summary}
    <Spinner layout="block" tone="accent" label="Loading the false-positive summary" />
  {:else if summary && !reviewed}
    <EmptyState
      level={headingLevel === 2 ? 3 : 4}
      compact
      title="No decisions reviewed yet"
      message={`No blocked or logged decision was assessed in the ${windowLabel}. Open a decision in an application's Decisions tab and record an assessment (true positive, false positive or unsure) under Assessment. The false-positive rate appears here once blocks are reviewed.`}
    >
      {#snippet action()}
        {#if startHref}<a class="dq-link" href={startHref}>{startLabel}</a>{/if}
      {/snippet}
    </EmptyState>
  {:else if summary}
    <KpiStrip items={kpis} label={`Detection quality, ${windowLabel}`} minItemWidth="170px" />
    <div class="dq-lists" class:three={lists.length === 3}>
      {#each lists as list (list.id)}
        <div class="dq-list">
          <svelte:element this={`h${headingLevel + 1}`} class="dq-list-title">{list.title} by false positives</svelte:element>
          {#if list.rows.length === 0}
            <p class="dq-empty">No false positives reported.</p>
          {:else}
            <ol>
              {#each list.rows as row (row.key)}
                {@const target = list.target(row)}
                {@const href = target ? reviewHref(target) : null}
                {@const name = list.label ? list.label(row) : row.label || row.key}
                <li>
                  {#if href}
                    <a class="dq-name" class:mono={list.mono} {href} title={`Review blocked decisions: ${name}`}>{name}</a>
                  {:else}
                    <span class="dq-name" class:mono={list.mono}>{name}</span>
                  {/if}
                  <span class="dq-count">{formatNumber(row.false_positive)} <span class="dq-muted">false</span></span>
                  <span class="dq-rate" title="False-positive share of reviewed blocks">{formatFpRate(row.fp_block_rate)}</span>
                </li>
              {/each}
            </ol>
          {/if}
        </div>
      {/each}
    </div>
    {#if startHref}
      <p class="dq-foot">Assess more decisions to sharpen the rate: <a class="dq-link" href={startHref}>{compact || appId ? 'review blocked decisions' : 'open an application\'s Decisions tab'}</a>.</p>
    {/if}
  {/if}
</section>

<style>
  .dq { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: var(--sp-4) var(--sp-5); min-width: 0; display: flex; flex-direction: column; gap: var(--sp-3); }
  .dq.compact { padding: var(--sp-4); }
  .dq-head { display: flex; justify-content: space-between; gap: var(--sp-3); flex-wrap: wrap; }
  .dq-title { margin: 0; font-size: var(--fs-base); font-weight: var(--fw-semibold); }
  .dq-sub { margin: var(--sp-1) 0 0; font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.45; }
  .dq-lists { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--sp-4); }
  .dq-lists.three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .dq-list { min-width: 0; }
  .dq-list-title { margin: 0 0 var(--sp-2); font-size: var(--fs-sm); font-weight: var(--fw-medium); color: var(--text-secondary); }
  .dq-list ol { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-1); }
  .dq-list li { display: grid; grid-template-columns: minmax(0, 1fr) auto 4.5rem; gap: var(--sp-2); align-items: center; font-size: var(--fs-sm); padding: var(--sp-1) 0; border-bottom: 1px solid var(--border); }
  .dq-list li:last-child { border-bottom: 0; }
  .dq-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-primary); }
  a.dq-name { color: var(--accent-dim); }
  .mono { font-family: var(--font-mono); font-size: var(--fs-xs); }
  .dq-count, .dq-rate { font-variant-numeric: tabular-nums; text-align: right; color: var(--text-primary); }
  .dq-muted { color: var(--text-muted); }
  .dq-empty { margin: 0; font-size: var(--fs-sm); color: var(--text-muted); }
  .dq-foot { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
  .dq-link { color: var(--accent-dim); font-size: var(--fs-sm); }
  .dq-foot .dq-link { font-size: inherit; }
  @media (max-width: 900px) {
    .dq-lists, .dq-lists.three { grid-template-columns: minmax(0, 1fr); }
  }
</style>
