// Cursor paging, time window and error texts of the app decision feed
// (GET …/apps/:appId/waf/decisions).

import type { ApiError, AppWAFDecisionsPage, WAFDecisionRow } from '#lib/api.js';
import { formatNumber } from '#lib/format.js';
import { timeRangeLabel, timeRangeWindow, type TimeRangeKey } from '#lib/components/ui/time-range.js';

/**
 * Keyset pages visited so far: `cursors[i]` opens page i (page 0 has none).
 * Moving back reuses a stored cursor, so "Newer" never needs an offset.
 */
export interface CursorPages {
  cursors: (string | null)[];
  index: number;
}

export function firstCursorPage(): CursorPages {
  return { cursors: [null], index: 0 };
}

/** Cursor to request for the current page (undefined on page 0). */
export function currentCursor(pages: CursorPages): string | undefined {
  return pages.cursors[pages.index] ?? undefined;
}

/** Moves to the next (older) page with the `next_cursor` of the current one; unchanged without one. */
export function nextCursorPage(pages: CursorPages, nextCursor: string | null | undefined): CursorPages {
  if (!nextCursor) return pages;
  const cursors = pages.cursors.slice(0, pages.index + 1);
  cursors.push(nextCursor);
  return { cursors, index: pages.index + 1 };
}

/** Moves to the previous (newer) page; unchanged on page 0. */
export function prevCursorPage(pages: CursorPages): CursorPages {
  if (pages.index === 0) return pages;
  return { cursors: pages.cursors, index: pages.index - 1 };
}

/** RFC 3339 window of a time-range key ending at `now` (the feed has no "all"). */
export function decisionsWindow(range: TimeRangeKey, now: Date = new Date()): { from_ts?: string; to_ts: string } {
  const { from, to } = timeRangeWindow(range, now);
  return { from_ts: from ? from.toISOString() : undefined, to_ts: to.toISOString() };
}

// ── Live updates: rows newer than page 1 ─────────────────────────────────

/** Consecutive newer-row reads overlap by this much (rows committed late). */
export const NEWER_OVERLAP_MS = 5_000;
/** A newest row older than this does not start a read; the server default window does. */
export const NEWER_ANCHOR_MAX_AGE_MS = 60 * 60_000;

type FeedRow = Pick<WAFDecisionRow, 'id' | 'recorded_at'>;

/** The window the server reads when a request names no from_ts (AppDecisionsDefaultWindow). */
export const SERVER_DEFAULT_WINDOW_MS = 24 * 60 * 60_000;

/** Identity of a stored decision (waf_decisions primary key). */
export function decisionKey(row: FeedRow): string {
  return `${row.id}:${row.recorded_at}`;
}

/** Feed order: recorded_at, then id, newest first (the server's keyset order). */
export function newerDecision(a: FeedRow, b: FeedRow): boolean {
  const ta = Date.parse(a.recorded_at);
  const tb = Date.parse(b.recorded_at);
  return ta !== tb ? ta > tb : a.id > b.id;
}

/**
 * from_ts of a read for rows newer than page 1. After a newer-row read: that
 * read's to_ts (the server's clock) less the overlap. After a full load: the
 * newest row less the overlap, when that row is recent. Otherwise undefined,
 * so the server's default window (the last 24 h on its clock) applies, which
 * stays inside its 30-day cap. The read sends no to_ts, so every window ends
 * at the server's now and the next one starts there.
 */
export function newerReadFrom(seenTo: number, newest: FeedRow | undefined, now: number = Date.now()): string | undefined {
  if (seenTo > 0) return new Date(seenTo - NEWER_OVERLAP_MS).toISOString();
  const t = newest ? Date.parse(newest.recorded_at) : NaN;
  if (Number.isFinite(t) && now - t < NEWER_ANCHOR_MAX_AGE_MS) return new Date(t - NEWER_OVERLAP_MS).toISOString();
  return undefined;
}

export type NewerMerge<T> =
  /** Nothing new for page 1. */
  | { kind: 'none' }
  /** Page 1 would grow past the cap: reload it. */
  | { kind: 'reload' }
  /** New rows merged ahead of the page's cursor. */
  | { kind: 'merge'; rows: T[]; added: T[] }
  /**
   * More new rows than one read returns: the read is the newest page and its
   * cursor continues into older rows. totalDelta is approximate until the
   * next full load.
   */
  | { kind: 'replace'; rows: T[]; added: T[]; nextCursor: string | null; totalDelta: number };

/**
 * Applies a newer-row read to page 1 (`rows`, newest first, `nextCursor` of
 * its page). Rows before `rangeFromMs` (the page's time range) are left out;
 * a row behind the page's cursor belongs to page 2 and is left out too, so
 * keyset paging neither skips nor repeats a row.
 */
export function mergeNewer<T extends FeedRow>(
  rows: readonly T[],
  nextCursor: string | null,
  read: Pick<AppWAFDecisionsPage, 'next_cursor' | 'total' | 'from_ts'> & { decisions: T[] },
  opts: { rangeFromMs?: number; maxRows: number },
): NewerMerge<T> {
  const inRange = (row: T) => !opts.rangeFromMs || Date.parse(row.recorded_at) >= opts.rangeFromMs;
  const known = new Set(rows.map(decisionKey));
  if (read.next_cursor !== null) {
    const fresh = read.decisions.filter(inRange);
    const fromMs = Date.parse(read.from_ts);
    const shownInWindow = Number.isFinite(fromMs) ? rows.filter((row) => Date.parse(row.recorded_at) >= fromMs).length : rows.length;
    return {
      kind: 'replace',
      rows: fresh,
      added: fresh.filter((row) => !known.has(decisionKey(row))),
      // A row cut by the range means every older one is outside it as well.
      nextCursor: fresh.length < read.decisions.length ? null : read.next_cursor,
      totalDelta: Math.max(0, read.total - shownInWindow),
    };
  }
  const last = rows[rows.length - 1];
  const added = read.decisions.filter(
    (row) => inRange(row) && !known.has(decisionKey(row)) && (nextCursor === null || !last || newerDecision(row, last)),
  );
  if (!added.length) return { kind: 'none' };
  if (rows.length + added.length > opts.maxRows) return { kind: 'reload' };
  const merged = [...added, ...rows].sort((a, b) => (newerDecision(a, b) ? -1 : newerDecision(b, a) ? 1 : 0));
  return { kind: 'merge', rows: merged, added };
}

/**
 * from_ts of a newer-row read, never earlier than the start of the page's time range. A read without one covers the
 * server's last 24 hours, which is wider than a range of an hour: it would count rows the page does not show and the
 * total would stay at that count while the table is empty.
 */
export function newerReadWindow(readFrom: string | undefined, rangeFrom: string | undefined, now: number = Date.now()): string | undefined {
  const rangeMs = rangeFrom ? Date.parse(rangeFrom) : NaN;
  if (!rangeFrom || !Number.isFinite(rangeMs)) return readFrom;
  if (readFrom === undefined) return now - rangeMs < SERVER_DEFAULT_WINDOW_MS ? rangeFrom : undefined;
  return Date.parse(readFrom) < rangeMs ? rangeFrom : readFrom;
}

/**
 * Title and message of the table when it has no rows. "No decisions recorded yet" only when the application has none in
 * the longest range the feed can read; a range or a filter that shows nothing says that instead.
 */
export function emptyDecisionsText(range: TimeRangeKey, state: { filtered: boolean; anyStored: boolean | null }): { title: string; message: string } {
  if (state.filtered) return { title: 'No decisions match these filters', message: 'Reset the filters or widen the search.' };
  if (state.anyStored === false) {
    return { title: 'No decisions recorded yet', message: 'Decisions appear once traffic reaches this application through its WAF agent.' };
  }
  return {
    title: 'No decisions in this range',
    message: `Nothing was recorded in the ${timeRangeLabel(range).toLowerCase()}. Choose a longer range to see older decisions.`
  };
}

/** "134" or "10,000+" when the server capped the count. */
export function formatDecisionTotal(total: number, capped: boolean): string {
  return capped ? `${formatNumber(total)}+` : formatNumber(total);
}

/** Message for a 400 of the feed; other errors keep the server text. */
export function decisionsErrorMessage(err: ApiError | undefined): string {
  switch (err?.code) {
    case 'WAF_DECISIONS_BAD_RANGE':
      return 'The time range is not valid: it must not be empty and may span at most 30 days.';
    case 'WAF_DECISIONS_BAD_IP':
      return 'Enter a single IPv4 or IPv6 address (no CIDR range).';
    case 'WAF_DECISIONS_BAD_CURSOR':
      return 'The page position is no longer valid. Showing the newest decisions again.';
    case 'WAF_DECISIONS_BAD_OFFSET':
      return 'That page is too far back. Narrow the time range or the filters.';
    case 'WAF_DECISIONS_BAD_SOURCE':
      return 'Unknown source filter.';
    case 'WAF_DECISIONS_BAD_METHOD':
      return 'Unknown HTTP method filter.';
    default:
      return err?.error || 'Could not load decisions.';
  }
}
