/**
 * Follows a paged list endpoint (limit/offset + total) until every
 * row is loaded or `cap` rows are reached. Used for the rule lists, which the
 * server orders (detection rules by priority) and which the page shows whole
 * with per-action counts.
 */
export interface PageResult<T> {
  rows: T[];
  total: number;
}

export interface LoadAllResult<T> {
  rows: T[];
  /** Total reported by the server (may exceed rows.length when capped). */
  total: number;
  /** Stopped at `cap` before reaching `total`. */
  capped: boolean;
  error?: string;
}

export async function loadAllPages<T>(
  fetchPage: (limit: number, offset: number) => Promise<{ data?: PageResult<T> | null; error?: string | null }>,
  opts: { pageSize?: number; cap?: number; isStale?: () => boolean } = {},
): Promise<LoadAllResult<T> | null> {
  const pageSize = Math.max(1, opts.pageSize ?? 100);
  const cap = Math.max(pageSize, opts.cap ?? 1000);
  const rows: T[] = [];
  let total = 0;
  for (let offset = 0; offset < cap; offset += pageSize) {
    const res = await fetchPage(pageSize, offset);
    if (opts.isStale?.()) return null;
    if (res.error || !res.data) return { rows, total, capped: false, error: res.error || 'The list could not be loaded.' };
    total = Number.isFinite(res.data.total) ? res.data.total : rows.length + res.data.rows.length;
    rows.push(...res.data.rows);
    if (res.data.rows.length < pageSize || rows.length >= total) break;
  }
  return { rows, total, capped: rows.length < total };
}
