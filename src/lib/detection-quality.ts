// Detection quality and decision-mix helpers for the project
// Overview and the app Monitoring tab. Pure functions: no API calls.

import type { FeedbackBreakdownRow, FeedbackCounters, FeedbackSummaryRange, WAFSummary } from './api';
import type { TimeRangeKey } from './components/ui/time-range';
import { formatPercent } from './format';
import { categoricalColor } from './tone';

/**
 * The feedback summary window for a page range. The endpoint knows 24h, 7d
 * and 30d only: shorter ranges widen to 24h and "all" narrows to 30d, and
 * `adjusted` tells the page to say so.
 */
export function feedbackRangeFor(key: TimeRangeKey): { range: FeedbackSummaryRange; adjusted: boolean } {
  if (key === '24h' || key === '7d' || key === '30d') return { range: key, adjusted: false };
  if (key === 'all') return { range: '30d', adjusted: true };
  return { range: '24h', adjusted: true };
}

export const FEEDBACK_RANGE_LABEL: Record<FeedbackSummaryRange, string> = {
  '24h': 'last 24 hours',
  '7d': 'last 7 days',
  '30d': 'last 30 days',
};

/** Ratio digits: two below 1 %, else one (0.4 % reads differently from 0 %). */
function ratioDigits(ratio: number): number {
  return ratio > 0 && ratio < 0.01 ? 2 : 1;
}

/**
 * False-positive share of reviewed blocks, e.g. "12.5%". "n/a" when no block was
 * reviewed (null rate): an unmeasured rate is never shown as 0 %.
 */
export function formatFpRate(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return 'n/a';
  return formatPercent(rate, { digits: ratioDigits(rate) });
}

/** Share of blocks that carry an assessment; null when there were no blocks. */
export function reviewedBlockShare(totals: Pick<FeedbackCounters, 'blocks' | 'reviewed_blocks'> | null | undefined): number | null {
  if (!totals || !(totals.blocks > 0)) return null;
  return Math.min(1, Math.max(0, totals.reviewed_blocks / totals.blocks));
}

export function formatShare(share: number | null): string {
  return share === null ? 'n/a' : formatPercent(share, { digits: ratioDigits(share) });
}

/** True when at least one decision in the window was assessed. */
export function hasReviews(totals: Pick<FeedbackCounters, 'reviewed'> | null | undefined): boolean {
  return Boolean(totals && totals.reviewed > 0);
}

/**
 * Breakdown rows with false positives, most first: by false-positive count,
 * then by false-positive block rate, then by label. Rows without a false
 * positive are left out.
 */
export function topFalsePositives(rows: readonly FeedbackBreakdownRow[] | null | undefined, limit = 5): FeedbackBreakdownRow[] {
  return (rows ?? [])
    .filter((row) => row.false_positive > 0)
    .sort(
      (a, b) =>
        b.false_positive - a.false_positive ||
        (b.fp_block_rate ?? -1) - (a.fp_block_rate ?? -1) ||
        (a.label || a.key).localeCompare(b.label || b.key),
    )
    .slice(0, Math.max(0, limit));
}

// ── Decision mix ──────────────────────────────────────────────────────

export interface ShareItem {
  label: string;
  value: number;
  /** value / total, 0 when the total is 0. */
  pct: number;
  /** Categorical series colour (`var(--cat-n)`), never a verdict colour. */
  color: string;
}

function withShares(items: { label: string; value: number }[]): { total: number; items: ShareItem[] } {
  const total = items.reduce((sum, item) => sum + item.value, 0);
  return {
    total,
    items: items.map((item, i) => ({ ...item, color: categoricalColor(i), pct: total > 0 ? item.value / total : 0 })),
  };
}

/**
 * How stored decisions were made (analysis method of the WAF summary):
 * semantic analysis, or a policy (rate limit, block list, custom rule …).
 * Decisions without a recorded method are not counted.
 */
export function decisionMethodSplit(
  summary: Pick<WAFSummary, 'semantic_triggers' | 'other_triggers'> | null | undefined,
): { total: number; items: ShareItem[] } {
  return withShares([
    { label: 'Semantic analysis', value: summary?.semantic_triggers ?? 0 },
    { label: 'Policy and other', value: summary?.other_triggers ?? 0 },
  ]);
}

/**
 * HTTP method split, largest first (ties by name). Methods past `limit - 1`
 * fold into one "Other" row so the list stays short.
 */
export function httpMethodSplit(buckets: readonly { key: string; count: number }[] | null | undefined, limit = 6): { total: number; items: ShareItem[] } {
  const merged = new Map<string, number>();
  for (const b of buckets ?? []) {
    if (!(b.count > 0)) continue;
    const key = (b.key || 'unknown').toUpperCase();
    merged.set(key, (merged.get(key) ?? 0) + b.count);
  }
  const sorted = [...merged].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
  if (limit > 1 && sorted.length > limit) {
    const head = sorted.slice(0, limit - 1);
    const rest = sorted.slice(limit - 1).reduce((sum, item) => sum + item.value, 0);
    return withShares([...head, { label: 'Other', value: rest }]);
  }
  return withShares(sorted);
}
