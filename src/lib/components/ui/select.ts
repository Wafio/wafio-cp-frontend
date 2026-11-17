// The pure parts of Select: which options a search keeps, where the active option moves, and type-ahead.
// Select.svelte holds the DOM and the events; these functions take plain data so they are tested on their own.

export type SelectValue = string | number;

export interface SelectOption<T extends SelectValue = SelectValue> {
  value: T;
  label: string;
  /** A second, quieter line under the label. */
  description?: string;
  disabled?: boolean;
  /** Options with the same group are listed together under this heading, in the order of their first option. */
  group?: string;
}

/** A search box appears when a list is longer than this, unless the caller decides. */
export const SEARCH_THRESHOLD = 8;

/** Options whose label, description or value contain every word of the query, case and accents ignored. */
export function filterOptions<T extends SelectValue>(options: readonly SelectOption<T>[], query: string): SelectOption<T>[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...options];
  return options.filter((o) => {
    const text = fold(`${o.label} ${o.description ?? ''} ${o.value} ${o.group ?? ''}`);
    return words.every((w) => text.includes(w));
  });
}

/** Options in display order: grouped options follow their group's first appearance, ungrouped ones keep their place. */
export function orderByGroup<T extends SelectValue>(options: readonly SelectOption<T>[]): SelectOption<T>[] {
  const seen = new Map<string, SelectOption<T>[]>();
  const out: (SelectOption<T> | SelectOption<T>[])[] = [];
  for (const o of options) {
    if (o.group === undefined) {
      out.push(o);
      continue;
    }
    let list = seen.get(o.group);
    if (!list) {
      list = [];
      seen.set(o.group, list);
      out.push(list);
    }
    list.push(o);
  }
  return out.flat();
}

/**
 * The next enabled index from `from` in direction `step` (1 or -1), or `from` when there is none.
 * `from` of -1 with step 1 finds the first enabled option; `from` of options.length with step -1 the last.
 */
export function moveActive(options: readonly SelectOption[], from: number, step: 1 | -1): number {
  for (let i = from + step; i >= 0 && i < options.length; i += step) {
    if (!options[i].disabled) return i;
  }
  return from >= 0 && from < options.length ? from : -1;
}

/** The first enabled option after `from` (wrapping) whose label starts with `prefix`, or -1. */
export function typeAhead(options: readonly SelectOption[], from: number, prefix: string): number {
  const p = fold(prefix);
  if (!p) return -1;
  const n = options.length;
  // A repeated single letter cycles through the options with that letter; a longer prefix stays on the current one if it still matches.
  const start = p.length > 1 ? Math.max(from, 0) : from + 1;
  for (let k = 0; k < n; k++) {
    const i = (((start + k) % n) + n) % n;
    if (!options[i].disabled && fold(options[i].label).startsWith(p)) return i;
  }
  return -1;
}

function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}
