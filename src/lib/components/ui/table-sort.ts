// Sorting helpers for DataTable. Stable, empty values always last.

export type SortDir = 'asc' | 'desc';

export interface SortState {
  key: string;
  dir: SortDir;
}

/** Clicking a header: same column toggles, another column starts at `firstDir`. */
export function nextSort(current: SortState | null | undefined, key: string, firstDir: SortDir = 'asc'): SortState {
  if (current && current.key === key) return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: firstDir };
}

/** Value for the `aria-sort` attribute of a sortable column header. */
export function ariaSort(sort: SortState | null | undefined, key: string): 'ascending' | 'descending' | 'none' {
  if (!sort || sort.key !== key) return 'none';
  return sort.dir === 'asc' ? 'ascending' : 'descending';
}

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === '' || (typeof value === 'number' && Number.isNaN(value));
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Ascending comparison of two non-empty cell values. */
export function compareValues(a: unknown, b: unknown): number {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'bigint' && typeof b === 'bigint') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return collator.compare(String(a), String(b));
}

/**
 * Sorted copy of `rows`. Rows whose value is empty (null, undefined, '' or
 * NaN) stay at the end in both directions; ties keep their input order.
 */
export function sortRows<T>(
  rows: readonly T[],
  sort: SortState | null | undefined,
  getValue: (row: T, key: string) => unknown,
): T[] {
  if (!sort) return rows.slice();
  const factor = sort.dir === 'asc' ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index, value: getValue(row, sort.key) }))
    .sort((x, y) => {
      const xe = isEmpty(x.value);
      const ye = isEmpty(y.value);
      if (xe || ye) return xe === ye ? x.index - y.index : xe ? 1 : -1;
      return compareValues(x.value, y.value) * factor || x.index - y.index;
    })
    .map((entry) => entry.row);
}
