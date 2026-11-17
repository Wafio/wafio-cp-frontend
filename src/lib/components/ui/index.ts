// UI primitives. Import components and helpers from '#lib/components/ui/index.js'.
// Component APIs are documented in each file's header comment.

export { default as Alert } from './Alert.svelte';
export { default as Badge } from './Badge.svelte';
export { default as Button } from './Button.svelte';
export { default as Card } from './Card.svelte';
export { default as ConfirmModal } from './ConfirmModal.svelte';
export { default as DataTable } from './DataTable.svelte';
export { default as DateTime } from './DateTime.svelte';
export { default as Drawer } from './Drawer.svelte';
export { default as EmptyState } from './EmptyState.svelte';
export { default as Field } from './Field.svelte';
export { default as InlineError } from './InlineError.svelte';
export { default as KpiStrip } from './KpiStrip.svelte';
export { default as Modal } from './Modal.svelte';
export { default as PageHeader } from './PageHeader.svelte';
export { default as Pagination } from './Pagination.svelte';
export { default as Select } from './Select.svelte';
export { default as Spinner } from './Spinner.svelte';
export { default as StatCard } from './StatCard.svelte';
export { default as StatusDot } from './StatusDot.svelte';
export { default as Switch } from './Switch.svelte';
export { default as Table } from './Table.svelte';
export { default as Tabs } from './Tabs.svelte';
export { default as TimeRangePicker } from './TimeRangePicker.svelte';
export { default as ToastContainer } from './ToastContainer.svelte';

export * from './types';
export { decideClose, type CloseDecision, type CloseSource, type ClosePolicy } from './dialog';
export { nextTabId, readTabParam, resolveTabId, tabDomIds, tabSearch, type TabLike } from './tabs';
export {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  formatPageRange,
  pageInfo,
  slicePage,
  type PageInfo,
  type PageInput
} from './pagination';
export { toneApplies } from './kpi-tone';
export { SEARCH_THRESHOLD, filterOptions, moveActive, orderByGroup, typeAhead, type SelectOption, type SelectValue } from './select';
export { ariaSort, compareValues, nextSort, sortRows, type SortDir, type SortState } from './table-sort';
export {
  ALL_TIME,
  DEFAULT_TIME_RANGE,
  TIME_RANGES,
  isTimeRangeKey,
  parseTimeRange,
  timeRangeLabel,
  timeRangeMinutes,
  timeRangeOptions,
  timeRangeWindow,
  type RelativeTimeRange,
  type TimeRangeKey,
  type TimeRangeOption
} from './time-range';
export { backLabelText, defaultBackLabel } from './page-header';
