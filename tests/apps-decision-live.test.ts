// decision-paging.ts live updates: the newer-row read window and how a read
// is applied to page 1 of the app decision feed.
import { describe, expect, test } from 'bun:test';
import {
  NEWER_ANCHOR_MAX_AGE_MS,
  NEWER_OVERLAP_MS,
  decisionKey,
  emptyDecisionsText,
  mergeNewer,
  newerDecision,
  newerReadFrom,
  newerReadWindow,
} from '../src/lib/components/apps/decision-paging';

const T0 = Date.parse('2026-10-15T14:00:00.000Z');

function row(id: number, offsetMs: number) {
  return { id, recorded_at: new Date(T0 + offsetMs).toISOString() };
}

function read(decisions: ReturnType<typeof row>[], over: { next_cursor?: string | null; total?: number; from_ts?: string } = {}) {
  return { decisions, next_cursor: null, total: decisions.length, from_ts: new Date(T0 - 60_000).toISOString(), ...over };
}

describe('newer-row read window', () => {
  test('after a newer read it starts at that read’s server to_ts less the overlap', () => {
    expect(newerReadFrom(T0, row(1, -10 * 86_400_000), T0)).toBe(new Date(T0 - NEWER_OVERLAP_MS).toISOString());
  });

  test('after a full load it starts at a recent newest row, else the server default window', () => {
    expect(newerReadFrom(0, row(1, -30_000), T0)).toBe(new Date(T0 - 30_000 - NEWER_OVERLAP_MS).toISOString());
    // An old newest row (rare filter) or an empty page must not widen the
    // window toward the range start: 30 days would exceed the server cap.
    expect(newerReadFrom(0, row(1, -NEWER_ANCHOR_MAX_AGE_MS - 1), T0)).toBeUndefined();
    expect(newerReadFrom(0, undefined, T0)).toBeUndefined();
    expect(newerReadFrom(0, { id: 1, recorded_at: 'garbage' }, T0)).toBeUndefined();
  });
});

describe('applying a newer read to page 1', () => {
  const page = [row(5, -1_000), row(4, -2_000), row(3, -3_000)];

  test('new rows go on top in keyset order; known rows are not repeated', () => {
    const m = mergeNewer(page, null, read([row(7, 0), row(6, -500), row(5, -1_000)]), { maxRows: 100 });
    expect(m.kind).toBe('merge');
    if (m.kind !== 'merge') return;
    expect(m.rows.map((r) => r.id)).toEqual([7, 6, 5, 4, 3]);
    expect(m.added.map((r) => r.id)).toEqual([7, 6]);
  });

  test('a late commit inside the overlap is placed by recorded_at, ties by id', () => {
    const m = mergeNewer(page, null, read([row(9, -2_000)]), { maxRows: 100 });
    expect(m.kind === 'merge' && m.rows.map((r) => r.id)).toEqual([5, 9, 4, 3]);
    expect(newerDecision(row(9, -2_000), row(4, -2_000))).toBe(true);
  });

  test('nothing new is a no-op', () => {
    expect(mergeNewer(page, null, read([row(5, -1_000)]), { maxRows: 100 }).kind).toBe('none');
  });

  test('a row behind the page cursor belongs to page 2 and is left out', () => {
    const m = mergeNewer(page, 'cursor-of-row-3', read([row(8, 0), row(2, -4_000)]), { maxRows: 100 });
    expect(m.kind === 'merge' && m.added.map((r) => r.id)).toEqual([8]);
    // Without a next page every row of the range is on page 1.
    const all = mergeNewer(page, null, read([row(2, -4_000)]), { maxRows: 100 });
    expect(all.kind === 'merge' && all.rows.map((r) => r.id)).toEqual([5, 4, 3, 2]);
  });

  test('rows before the time range are left out', () => {
    const m = mergeNewer(page, null, read([row(8, 0), row(2, -600_000)]), { rangeFromMs: T0 - 300_000, maxRows: 100 });
    expect(m.kind === 'merge' && m.added.map((r) => r.id)).toEqual([8]);
  });

  test('page 1 past the cap is reloaded instead of growing', () => {
    expect(mergeNewer(page, null, read([row(8, 0), row(7, -100)]), { maxRows: 4 }).kind).toBe('reload');
  });

  test('a read with a next page replaces page 1 and takes its cursor', () => {
    const fresh = [row(30, 0), row(29, -10), row(28, -20)];
    const m = mergeNewer(page, 'old', read(fresh, { next_cursor: 'c28', total: 40, from_ts: new Date(T0 - 1_500).toISOString() }), { maxRows: 100 });
    expect(m.kind).toBe('replace');
    if (m.kind !== 'replace') return;
    expect(m.rows.map((r) => r.id)).toEqual([30, 29, 28]);
    expect(m.nextCursor).toBe('c28');
    expect(m.added.map(decisionKey)).toEqual(fresh.map(decisionKey));
    // 40 in the read window, of which row 5 was already counted.
    expect(m.totalDelta).toBe(39);
  });

  test('a replacing read cut by the range has no older page', () => {
    const m = mergeNewer(page, 'old', read([row(30, 0), row(1, -600_000)], { next_cursor: 'c1', total: 50 }), {
      rangeFromMs: T0 - 300_000,
      maxRows: 100,
    });
    expect(m.kind === 'replace' && m.nextCursor).toBeNull();
    expect(m.kind === 'replace' && m.rows.map((r) => r.id)).toEqual([30]);
  });
});

// A range of an hour with no rows used to show the count of the day: a newer-row read without from_ts covers the
// server's last 24 hours, and the rows it found outside the range still counted.
describe('the newer-row read stays inside the range', () => {
  const now = T0;
  const hourAgo = new Date(now - 60 * 60_000).toISOString();
  const weekAgo = new Date(now - 7 * 86_400_000).toISOString();

  test('with no from_ts a range shorter than the server window gives its own start', () => {
    expect(newerReadWindow(undefined, hourAgo, now)).toBe(hourAgo);
  });

  test('a range longer than the server window keeps the server default, and no range changes nothing', () => {
    expect(newerReadWindow(undefined, weekAgo, now)).toBeUndefined();
    expect(newerReadWindow(undefined, undefined, now)).toBeUndefined();
    expect(newerReadWindow('2026-10-15T13:59:00.000Z', undefined, now)).toBe('2026-10-15T13:59:00.000Z');
  });

  test('a from_ts before the range start is moved to it, one inside the range is kept', () => {
    expect(newerReadWindow(new Date(now - 3 * 3_600_000).toISOString(), hourAgo, now)).toBe(hourAgo);
    const inside = new Date(now - 30 * 60_000).toISOString();
    expect(newerReadWindow(inside, hourAgo, now)).toBe(inside);
  });
});

describe('the table with no rows', () => {
  test('a range or a filter that shows nothing says so; "recorded yet" only when the application has none at all', () => {
    expect(emptyDecisionsText('1h', { filtered: false, anyStored: true })).toEqual({
      title: 'No decisions in this range',
      message: 'Nothing was recorded in the last hour. Choose a longer range to see older decisions.'
    });
    expect(emptyDecisionsText('24h', { filtered: false, anyStored: null }).title).toBe('No decisions in this range');
    expect(emptyDecisionsText('24h', { filtered: false, anyStored: null }).message).toContain('last 24 hours');
    expect(emptyDecisionsText('30d', { filtered: false, anyStored: false }).title).toBe('No decisions recorded yet');
    expect(emptyDecisionsText('1h', { filtered: true, anyStored: false }).title).toBe('No decisions match these filters');
  });
});
