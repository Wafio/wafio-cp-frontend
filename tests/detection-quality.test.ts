import { describe, expect, test } from 'bun:test';
import type { FeedbackBreakdownRow } from '../src/lib/api';
import {
  decisionMethodSplit,
  feedbackRangeFor,
  formatFpRate,
  formatShare,
  hasReviews,
  httpMethodSplit,
  reviewedBlockShare,
  topFalsePositives,
} from '../src/lib/detection-quality';

function row(key: string, false_positive: number, fp_block_rate: number | null, label = key): FeedbackBreakdownRow {
  return {
    key,
    label,
    blocks: 10,
    logs: 0,
    reviewed: false_positive,
    true_positive: 0,
    false_positive,
    unsure: 0,
    reviewed_blocks: false_positive,
    false_positive_blocks: false_positive,
    fp_block_rate,
  };
}

describe('feedbackRangeFor', () => {
  test('known windows pass through, others are mapped and flagged', () => {
    expect(feedbackRangeFor('24h')).toEqual({ range: '24h', adjusted: false });
    expect(feedbackRangeFor('7d')).toEqual({ range: '7d', adjusted: false });
    expect(feedbackRangeFor('30d')).toEqual({ range: '30d', adjusted: false });
    expect(feedbackRangeFor('5m')).toEqual({ range: '24h', adjusted: true });
    expect(feedbackRangeFor('1h')).toEqual({ range: '24h', adjusted: true });
    expect(feedbackRangeFor('all')).toEqual({ range: '30d', adjusted: true });
  });
});

describe('formatFpRate', () => {
  test('null or invalid is a dash, never 0 %', () => {
    expect(formatFpRate(null)).toBe('n/a');
    expect(formatFpRate(undefined)).toBe('n/a');
    expect(formatFpRate(Number.NaN)).toBe('n/a');
  });
  test('ratio to percent, two digits below 1 %', () => {
    expect(formatFpRate(0)).toBe('0%');
    expect(formatFpRate(0.125)).toBe('12.5%');
    expect(formatFpRate(1)).toBe('100%');
    expect(formatFpRate(0.0042)).toBe('0.42%');
  });
});

describe('reviewedBlockShare', () => {
  test('null without blocks, clamped ratio otherwise', () => {
    expect(reviewedBlockShare(null)).toBeNull();
    expect(reviewedBlockShare({ blocks: 0, reviewed_blocks: 0 })).toBeNull();
    expect(reviewedBlockShare({ blocks: 4, reviewed_blocks: 1 })).toBe(0.25);
    expect(reviewedBlockShare({ blocks: 2, reviewed_blocks: 5 })).toBe(1);
    expect(formatShare(null)).toBe('n/a');
    expect(formatShare(0.25)).toBe('25%');
  });
  test('hasReviews', () => {
    expect(hasReviews(null)).toBe(false);
    expect(hasReviews({ reviewed: 0 })).toBe(false);
    expect(hasReviews({ reviewed: 3 })).toBe(true);
  });
});

describe('topFalsePositives', () => {
  test('drops rows without false positives and sorts by count, rate, label', () => {
    const rows = [row('a', 2, 0.1), row('b', 5, 0.2), row('c', 0, null), row('d', 2, 0.5), row('e', 2, 0.1, 'Alpha')];
    expect(topFalsePositives(rows).map((r) => r.key)).toEqual(['b', 'd', 'a', 'e']);
    expect(topFalsePositives(rows, 2).map((r) => r.key)).toEqual(['b', 'd']);
    expect(topFalsePositives(null)).toEqual([]);
  });
  test('a null rate sorts after a measured one', () => {
    expect(topFalsePositives([row('x', 1, null), row('y', 1, 0)]).map((r) => r.key)).toEqual(['y', 'x']);
  });
  test('does not mutate the input', () => {
    const rows = [row('a', 1, 0.1), row('b', 3, 0.1)];
    topFalsePositives(rows);
    expect(rows.map((r) => r.key)).toEqual(['a', 'b']);
  });
});

describe('decisionMethodSplit', () => {
  test('semantic analysis and policy are the two parts', () => {
    const split = decisionMethodSplit({ semantic_triggers: 8, other_triggers: 2 });
    expect(split.total).toBe(10);
    expect(split.items.map((i) => [i.label, i.pct])).toEqual([
      ['Semantic analysis', 0.8],
      ['Policy and other', 0.2],
    ]);
    for (const item of split.items) expect(item.color).toMatch(/^var\(--cat-\d\)$/);
  });
  test('a payload of an older control plane with the two removed counts is accepted and they are not counted', () => {
    const old = { semantic_triggers: 6, rule_based_triggers: 2, hybrid_triggers: 2, other_triggers: 0 };
    const split = decisionMethodSplit(old);
    expect(split.total).toBe(6);
    expect(split.items.map((i) => i.label)).toEqual(['Semantic analysis', 'Policy and other']);
  });
  test('no summary gives zero shares', () => {
    const split = decisionMethodSplit(null);
    expect(split.total).toBe(0);
    expect(split.items.every((i) => i.pct === 0)).toBe(true);
  });
});

describe('httpMethodSplit', () => {
  test('sorted by count then name, case merged, zero rows dropped', () => {
    const split = httpMethodSplit([
      { key: 'post', count: 3 },
      { key: 'GET', count: 5 },
      { key: 'POST', count: 2 },
      { key: 'PUT', count: 0 },
      { key: 'DELETE', count: 5 },
    ]);
    expect(split.items.map((i) => [i.label, i.value])).toEqual([
      ['DELETE', 5],
      ['GET', 5],
      ['POST', 5],
    ]);
    expect(split.total).toBe(15);
  });
  test('tail folds into Other', () => {
    const buckets = ['A', 'B', 'C', 'D'].map((key, i) => ({ key, count: 10 - i }));
    const split = httpMethodSplit(buckets, 3);
    expect(split.items.map((i) => [i.label, i.value])).toEqual([
      ['A', 10],
      ['B', 9],
      ['Other', 15],
    ]);
  });
  test('null input', () => {
    expect(httpMethodSplit(null)).toEqual({ total: 0, items: [] });
  });
});
