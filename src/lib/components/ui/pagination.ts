// Offset/limit pagination math shared by Pagination and DataTable
// (offset/limit, default 20, max 100, `total`).

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export interface PageInput {
  offset: number;
  limit: number;
  /** Total row count when the server reports it; null/undefined = unknown. */
  total?: number | null;
  /** Rows on the current page (used when total is unknown). */
  count?: number;
  /** More rows exist after this page (used when total is unknown). */
  hasMore?: boolean;
}

export interface PageInfo {
  offset: number;
  limit: number;
  total: number | null;
  /** 1-based index of the first row shown, 0 when nothing is shown. */
  from: number;
  /** 1-based index of the last row shown, 0 when nothing is shown. */
  to: number;
  /** 1-based page number. */
  page: number;
  pageCount: number | null;
  hasPrev: boolean;
  hasNext: boolean;
  prevOffset: number;
  nextOffset: number;
  lastOffset: number | null;
}

function whole(value: number | null | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
}

export function pageInfo(input: PageInput): PageInfo {
  const limit = Math.max(1, whole(input.limit, DEFAULT_PAGE_SIZE));
  const total = input.total == null ? null : Math.max(0, whole(input.total, 0));
  let offset = Math.max(0, whole(input.offset, 0));
  if (total !== null && total > 0 && offset >= total) offset = Math.floor((total - 1) / limit) * limit;
  if (total === 0) offset = 0;

  const shown =
    total !== null
      ? Math.max(0, Math.min(limit, total - offset))
      : Math.max(0, Math.min(limit, whole(input.count, limit)));
  const from = shown > 0 ? offset + 1 : 0;
  const to = shown > 0 ? offset + shown : 0;
  const hasNext = total !== null ? offset + limit < total : Boolean(input.hasMore);
  const lastOffset = total !== null ? (total > 0 ? Math.floor((total - 1) / limit) * limit : 0) : null;

  return {
    offset,
    limit,
    total,
    from,
    to,
    page: Math.floor(offset / limit) + 1,
    pageCount: total !== null ? Math.max(1, Math.ceil(total / limit)) : null,
    hasPrev: offset > 0,
    hasNext,
    prevOffset: Math.max(0, offset - limit),
    nextOffset: offset + limit,
    lastOffset,
  };
}

/** "1–20 of 134", "21–40", or "No results". */
export function formatPageRange(info: PageInfo, locale?: string): string {
  const n = (value: number) => value.toLocaleString(locale);
  if (info.to === 0) return 'No results';
  const range = info.from === info.to ? n(info.from) : `${n(info.from)}–${n(info.to)}`;
  return info.total !== null ? `${range} of ${n(info.total)}` : range;
}

/** "users" for one row reads "user"; "entries" reads "entry". */
export function singularLabel(label: string): string {
  if (label.endsWith('ies')) return `${label.slice(0, -3)}y`;
  return label.endsWith('s') ? label.slice(0, -1) : label;
}

/** Rows of one client-side page. */
export function slicePage<T>(rows: readonly T[], offset: number, limit: number): T[] {
  const info = pageInfo({ offset, limit, total: rows.length });
  return rows.slice(info.offset, info.offset + info.limit);
}
