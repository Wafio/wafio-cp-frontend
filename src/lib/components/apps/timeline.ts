/**
 * Geometry of the application traffic chart: requests as an area
 * on the left axis, block rate (blocks ÷ requests per bucket) as a line on a
 * 0–100 % right axis. Pure, so the SVG component only draws.
 */
import type { WAFEventTimelineBucket } from '../../api';
import { formatDate, formatDateTime } from '../../format';

export interface ChartBox {
  width: number;
  height: number;
  padLeft: number;
  padRight: number;
  padTop: number;
  padBottom: number;
}

export const DEFAULT_CHART_BOX: ChartBox = { width: 640, height: 200, padLeft: 44, padRight: 40, padTop: 12, padBottom: 22 };

export interface TimelineBucketView {
  start: string;
  requests: number;
  blocks: number;
  /** Blocks ÷ requests, 0–1; null when the bucket had no requests. */
  blockRate: number | null;
  x: number;
  requestY: number;
  rateY: number | null;
}

export interface TimelineGeometry {
  box: ChartBox;
  buckets: TimelineBucketView[];
  /** Area under the request series (closed path). */
  requestArea: string;
  requestLine: string;
  /** Block-rate line; gaps where a bucket had no requests. */
  rateLine: string;
  maxRequests: number;
  /** Left axis ticks (requests). */
  yTicks: { y: number; value: number }[];
  /** Right axis ticks (block rate, 0–1). */
  rateTicks: { y: number; value: number }[];
  totals: { requests: number; blocks: number; blockRate: number | null };
}

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(value)));
  const f = value / exp;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * exp;
}

function fmt(n: number): string {
  return n.toFixed(2).replace(/\.00$/, '');
}

export function buildTimeline(buckets: readonly WAFEventTimelineBucket[], box: ChartBox = DEFAULT_CHART_BOX): TimelineGeometry {
  const plotW = box.width - box.padLeft - box.padRight;
  const plotH = box.height - box.padTop - box.padBottom;
  const baseY = box.padTop + plotH;
  const rawMax = Math.max(0, ...buckets.map((b) => b.requests || 0));
  const maxRequests = niceMax(rawMax);
  const step = buckets.length > 1 ? plotW / (buckets.length - 1) : 0;
  const views: TimelineBucketView[] = buckets.map((b, i) => {
    const requests = Math.max(0, b.requests || 0);
    const blocks = Math.max(0, Math.min(requests || b.blocks || 0, b.blocks || 0));
    const blockRate = requests > 0 ? Math.min(1, blocks / requests) : null;
    const x = buckets.length > 1 ? box.padLeft + i * step : box.padLeft + plotW / 2;
    return {
      start: b.bucket_start,
      requests,
      blocks,
      blockRate,
      x,
      requestY: box.padTop + plotH - (requests / maxRequests) * plotH,
      rateY: blockRate === null ? null : box.padTop + plotH - blockRate * plotH,
    };
  });

  let requestLine = '';
  let requestArea = '';
  if (views.length > 0) {
    requestLine = views.map((v, i) => `${i === 0 ? 'M' : 'L'} ${fmt(v.x)} ${fmt(v.requestY)}`).join(' ');
    const first = views[0];
    const last = views[views.length - 1];
    requestArea = `${requestLine} L ${fmt(last.x)} ${fmt(baseY)} L ${fmt(first.x)} ${fmt(baseY)} Z`;
  }

  let rateLine = '';
  let penDown = false;
  for (const v of views) {
    if (v.rateY === null) {
      penDown = false;
      continue;
    }
    rateLine += `${rateLine ? ' ' : ''}${penDown ? 'L' : 'M'} ${fmt(v.x)} ${fmt(v.rateY)}`;
    penDown = true;
  }

  const fractions = [1, 0.5, 0];
  const yTicks = fractions.map((f) => ({ y: box.padTop + plotH * (1 - f), value: Math.round(maxRequests * f) }));
  const rateTicks = fractions.map((f) => ({ y: box.padTop + plotH * (1 - f), value: f }));
  const totalRequests = views.reduce((s, v) => s + v.requests, 0);
  const totalBlocks = views.reduce((s, v) => s + v.blocks, 0);
  return {
    box,
    buckets: views,
    requestArea,
    requestLine,
    rateLine,
    maxRequests,
    yTicks,
    rateTicks,
    totals: { requests: totalRequests, blocks: totalBlocks, blockRate: totalRequests > 0 ? totalBlocks / totalRequests : null },
  };
}

/** Index of the bucket nearest to an x position in chart units. */
export function nearestBucket(geometry: TimelineGeometry, x: number): number {
  let best = -1;
  let bestDistance = Infinity;
  geometry.buckets.forEach((b, i) => {
    const d = Math.abs(b.x - x);
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  });
  return best;
}

/**
 * Axis label in the browser's time zone: "21:49", or "27 Sep, 21:49" when the
 * chart spans more than one local day (locale-dependent order and clock).
 */
export function axisTimeLabel(iso: string, spansDays: boolean): string {
  return formatDateTime(iso, { format: spansDays ? 'datetime' : 'time', year: false, fallback: '' });
}

/** True when the first and last buckets fall on different local calendar days. */
export function spansMultipleDays(buckets: readonly { bucket_start: string }[]): boolean {
  if (buckets.length < 2) return false;
  const first = formatDate(buckets[0].bucket_start, { fallback: '' });
  const last = formatDate(buckets[buckets.length - 1].bucket_start, { fallback: '' });
  if (!first || !last) return false;
  return first !== last;
}

export interface PeriodDelta {
  /** Value in the window before the current one. */
  previous: number;
  /** Relative change, e.g. 0.25 = +25 %; null when the previous window was empty. */
  ratio: number | null;
}

/**
 * Change against the previous window of the same length, from a summary of
 * the current window and one of the doubled window (the API only offers
 * "last N minutes"). Null when the doubled window reaches past retention.
 */
export function periodDelta(current: number, doubleWindow: number | null | undefined): PeriodDelta | null {
  if (doubleWindow === null || doubleWindow === undefined || !Number.isFinite(doubleWindow)) return null;
  const previous = Math.max(0, doubleWindow - current);
  return { previous, ratio: previous > 0 ? (current - previous) / previous : null };
}

/** "+25% vs previous 1 hour", "no traffic in the previous 1 hour". */
export function deltaText(delta: PeriodDelta | null, periodLabel: string): string | undefined {
  if (!delta) return undefined;
  const period = periodLabel.replace(/^last /i, 'previous ');
  if (delta.ratio === null) return delta.previous === 0 ? `none in the ${period}` : undefined;
  const pct = Math.round(delta.ratio * 100);
  if (pct === 0) return `same as the ${period}`;
  return `${pct > 0 ? '+' : '−'}${Math.abs(pct)}% vs the ${period}`;
}
