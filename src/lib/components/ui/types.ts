// Public types of the UI primitives (import from '#lib/components/ui/index.js').

import type { SortDir } from './table-sort';

/** Alert / InlineError tone. Severity colour always comes with text. */
export type AlertTone = 'error' | 'warning' | 'info' | 'success';

/** Connection / lifecycle state shown by StatusDot. */
export type StatusKind = 'online' | 'pending' | 'degraded' | 'offline' | 'unknown' | 'disabled';

/** KPI tone. `allow`/`log`/`block` are for WAF decision counts only. */
export type KpiTone = 'default' | 'allow' | 'log' | 'block' | 'danger' | 'warning' | 'success' | 'info';

export interface TabItem {
  id: string;
  label: string;
  /** Count shown after the label, e.g. open incidents. */
  count?: number | string;
  disabled?: boolean;
  /** Tooltip, e.g. why the tab is disabled. */
  title?: string;
}

export interface KpiItem {
  label: string;
  value: string | number;
  /** Quiet suffix after the value, e.g. "/ 6". */
  unit?: string;
  /** Small line under the value. */
  detail?: string;
  tone?: KpiTone;
  /** Text that carries the tone (e.g. "1 high"); when absent the value is tinted. */
  toneText?: string;
  href?: string;
  onclick?: () => void;
  /** Tooltip. */
  hint?: string;
}

/** Attributes Field hands to its control; spread them onto the input. */
export interface FieldControl {
  id: string;
  'aria-describedby': string | undefined;
  'aria-invalid': 'true' | undefined;
  'aria-required': 'true' | undefined;
}

export interface DataTableColumn<T> {
  /** Stable key; also the default property read from the row. */
  key: string;
  /** Header text. Always required so the column is labelled. */
  label: string;
  /** Keep the header text for assistive technology only. */
  hideLabel?: boolean;
  sortable?: boolean;
  /** Direction of the first click on this header (default 'asc'). */
  firstSortDir?: SortDir;
  /** Display value (default: `row[key]`); also the sort value unless `sortValue` is set. */
  value?: (row: T) => unknown;
  /** Value used for client-side sorting. */
  sortValue?: (row: T) => unknown;
  align?: 'left' | 'center' | 'right';
  /** CSS width of the column, e.g. '8rem'. */
  width?: string;
  nowrap?: boolean;
  /** Render this column's cells as row headers (`<th scope="row">`). */
  rowHeader?: boolean;
  /** Extra class on the header and body cells (style it with :global from the page). */
  class?: string;
}
