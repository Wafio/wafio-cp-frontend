// One time-range set for every screen (TimeRangePicker):
// 5m / 1h / 24h / 7d / 30d, plus "all" where a screen needs it; default 1h.

export type RelativeTimeRange = '5m' | '1h' | '24h' | '7d' | '30d';
export type TimeRangeKey = RelativeTimeRange | 'all';

export interface TimeRangeOption {
  key: TimeRangeKey;
  /** Compact label for the segmented control. */
  label: string;
  /** Full label for assistive technology and headings. */
  longLabel: string;
  /** Window length in minutes; null for "all". */
  minutes: number | null;
}

export const TIME_RANGES: readonly TimeRangeOption[] = [
  { key: '5m', label: '5m', longLabel: 'Last 5 minutes', minutes: 5 },
  { key: '1h', label: '1h', longLabel: 'Last hour', minutes: 60 },
  { key: '24h', label: '24h', longLabel: 'Last 24 hours', minutes: 60 * 24 },
  { key: '7d', label: '7d', longLabel: 'Last 7 days', minutes: 60 * 24 * 7 },
  { key: '30d', label: '30d', longLabel: 'Last 30 days', minutes: 60 * 24 * 30 },
];

export const ALL_TIME: TimeRangeOption = { key: 'all', label: 'All', longLabel: 'All time', minutes: null };

export const DEFAULT_TIME_RANGE: TimeRangeKey = '1h';

export function timeRangeOptions(includeAll = false): TimeRangeOption[] {
  return includeAll ? [...TIME_RANGES, ALL_TIME] : [...TIME_RANGES];
}

export function isTimeRangeKey(value: unknown, includeAll = false): value is TimeRangeKey {
  return typeof value === 'string' && timeRangeOptions(includeAll).some((option) => option.key === value);
}

/** Validates a key from a URL or storage; unknown values give `fallback`. */
export function parseTimeRange(
  value: string | null | undefined,
  options: { includeAll?: boolean; fallback?: TimeRangeKey } = {},
): TimeRangeKey {
  const includeAll = options.includeAll ?? false;
  const fallback = options.fallback ?? DEFAULT_TIME_RANGE;
  return isTimeRangeKey(value, includeAll) ? value : fallback;
}

function option(key: TimeRangeKey): TimeRangeOption {
  return key === 'all' ? ALL_TIME : (TIME_RANGES.find((item) => item.key === key) ?? TIME_RANGES[1]);
}

export function timeRangeMinutes(key: TimeRangeKey): number | null {
  return option(key).minutes;
}

export function timeRangeLabel(key: TimeRangeKey): string {
  return option(key).longLabel;
}

/** "in the last hour", "in all time": a range label after a count or in a sentence. */
export function inRangeText(label: string): string {
  const lower = label.toLowerCase();
  return lower.startsWith('last ') ? `in the ${lower}` : `in ${lower}`;
}

/** Absolute window ending at `now`; `from` is null for "all". */
export function timeRangeWindow(key: TimeRangeKey, now: Date = new Date()): { from: Date | null; to: Date } {
  const minutes = timeRangeMinutes(key);
  return { from: minutes === null ? null : new Date(now.getTime() - minutes * 60_000), to: now };
}
