/**
 * Shared display formatters.
 *
 * Dates: the backend stores and sends every timestamp in UTC (RFC 3339 ending
 * in "Z"); the frontend shows them in the browser's own time zone and locale,
 * compactly, "27 Sep 2026, 21:49" (en-GB) or "Sep 27, 2026, 9:49 PM" (en-US)
 *, with an optional relative hint ("5 min ago"). The exact UTC instant stays
 * available through toISO() for `<time datetime>` and tooltips; the
 * DateTime component (`#lib/components/ui/DateTime.svelte`) renders all three.
 * Machine formats (API query parameters, file names, exports) keep using
 * toISOString() and never go through these helpers.
 *
 * Numbers use a fixed en-US grouping so every page renders the same digits
 * regardless of the browser locale. Durations always take an explicit unit -
 * never guess whether a field is seconds or milliseconds at the call site.
 *
 * Every formatter returns EMPTY ("n/a") for null, undefined, NaN and unparsable
 * input instead of throwing, so a partial API response never breaks a page.
 */

export const EMPTY = 'n/a';

export type TimestampInput = string | number | Date | null | undefined;

export interface ParseTimestampOptions {
  /**
   * Unit of a numeric input. 'auto' (default) treats values below 1e11 as
   * seconds (1e11 s is the year 5138) and larger values as milliseconds.
   */
  epochUnit?: 'auto' | 's' | 'ms';
}

// Go's zero time.Time, emitted by handlers for "never".
const GO_ZERO_TIME = /^0001-01-01T00:00:00(?:\.0+)?(?:Z|[+-]00:?00)?$/;

/**
 * Parses an API timestamp into a Date, or null when the value is empty,
 * Go's zero time, or not a valid time. Accepts RFC 3339 with any number of
 * fractional digits (Go emits microseconds/nanoseconds), Postgres-style
 * "2026-09-27 09:54:16.123456+00", epoch seconds or milliseconds and Dates.
 * A date-time without an offset is UTC, the API never sends local times.
 */
export function parseTimestamp(value: TimestampInput, opts: ParseTimestampOptions = {}): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? new Date(value.getTime()) : null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    const unit = opts.epochUnit ?? 'auto';
    const ms = unit === 's' || (unit === 'auto' && Math.abs(value) < 1e11) ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  const raw = String(value).trim();
  if (!raw || GO_ZERO_TIME.test(raw)) return null;
  if (/^\d+(\.\d+)?$/.test(raw)) return parseTimestamp(Number(raw), opts);
  let text = raw.replace(/^(\d{4}-\d{2}-\d{2}) (\d)/, '$1T$2');
  // Trim fractional seconds to milliseconds; some engines reject 6-9 digits.
  text = text.replace(/(T\d{2}:\d{2}:\d{2})\.(\d{1,9})/, (_, head: string, frac: string) => `${head}.${frac.slice(0, 3).padEnd(3, '0')}`);
  // "+00" / "+0530" → "+00:00" / "+05:30".
  text = text.replace(/([+-])(\d{2})(?::?(\d{2}))?$/, (match, sign: string, hh: string, mm: string | undefined, offset: number) =>
    offset > 10 ? `${sign}${hh}:${mm ?? '00'}` : match);
  // No zone designator: Date.parse would read it as browser-local time.
  if (/T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(text)) text += 'Z';
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/** What formatDateTime renders: the date, the time of day, or both. */
export type DateTimeFormat = 'date' | 'datetime' | 'time';

export interface FormatDateTimeOptions extends ParseTimestampOptions {
  /** 'datetime' (default) "27 Sep 2026, 21:49", 'date' "27 Sep 2026", 'time' "21:49". */
  format?: DateTimeFormat;
  /** Append a relative hint: "27 Sep 2026, 21:49 (5 min ago)". */
  relative?: boolean;
  /** Include seconds: "27 Sep 2026, 21:49:16". */
  seconds?: boolean;
  /** Include the year in the date part (default true); chart axes drop it. */
  year?: boolean;
  /** Reference time for the relative hint (tests, server snapshot time). */
  now?: TimestampInput;
  /** Text for empty/invalid input. Defaults to EMPTY. */
  fallback?: string;
}

// Building an Intl.DateTimeFormat costs ~40 µs, formatting with one ~1 µs; a
// 500-row table would otherwise pay the construction 1,000 times per render.
// No formatter sets timeZone or locale: each uses the browser's own.
const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();

function localFormatter(key: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  let formatter = dateTimeFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(undefined, options);
    dateTimeFormatters.set(key, formatter);
  }
  return formatter;
}

/**
 * Drops the cached formatters so the next call reads the time zone and locale
 * again (tests that switch process.env.TZ; a tab that outlives a zone change).
 */
export function resetDateTimeFormatCache(): void {
  dateTimeFormatters.clear();
}

/**
 * Local date and time in the browser's time zone and locale, e.g.
 * "27 Sep 2026, 21:49" (en-GB) or "Sep 27, 2026, 9:49 PM" (en-US).
 */
export function formatDateTime(value: TimestampInput, opts: FormatDateTimeOptions = {}): string {
  const date = parseTimestamp(value, opts);
  if (!date) return opts.fallback ?? EMPTY;
  const format = opts.format ?? 'datetime';
  const withYear = opts.year ?? true;
  const datePart = localFormatter(withYear ? 'date' : 'date-no-year', withYear ? { dateStyle: 'medium' } : { month: 'short', day: 'numeric' }).format(date);
  const timePart = localFormatter(opts.seconds ? 'time-s' : 'time', { timeStyle: opts.seconds ? 'medium' : 'short' }).format(date);
  const absolute = format === 'date' ? datePart : format === 'time' ? timePart : `${datePart}, ${timePart}`;
  if (!opts.relative) return absolute;
  return `${absolute} (${formatRelative(date, opts.now)})`;
}

/** Calendar date in the browser's time zone: "27 Sep 2026". */
export function formatDate(value: TimestampInput, opts: Pick<FormatDateTimeOptions, 'epochUnit' | 'fallback'> = {}): string {
  return formatDateTime(value, { ...opts, format: 'date' });
}

/**
 * Re-indexes a 24-slot histogram keyed by UTC hour of day so slot i is local
 * hour i. `offsetMinutes` is the local offset east of UTC (default: the
 * browser's current one). Returns null for a zone whose offset is not a whole
 * hour (UTC+5:30): those buckets cannot be shifted exactly, so callers keep
 * showing UTC hours and say so.
 */
export function utcHourBucketsToLocal(utc: readonly number[], offsetMinutes: number = -new Date().getTimezoneOffset()): number[] | null {
  if (offsetMinutes % 60 !== 0) return null;
  const shift = offsetMinutes / 60;
  return Array.from({ length: 24 }, (_, local) => utc[(((local - shift) % 24) + 24) % 24] ?? 0);
}

/**
 * Exact UTC instant as ISO 8601 ("2026-09-27T14:49:16.000Z") for
 * `<time datetime>` and `title` attributes, or '' when the value is empty or
 * invalid.
 */
export function toISO(value: TimestampInput, opts: ParseTimestampOptions = {}): string {
  return parseTimestamp(value, opts)?.toISOString() ?? '';
}

/**
 * Compact relative time: "just now", "45 s ago", "5 min ago", "3 h ago",
 * "2 d ago", "4 mo ago", "1 y ago", and "in 5 min" for future values.
 */
export function formatRelative(value: TimestampInput, now: TimestampInput = Date.now(), opts: ParseTimestampOptions & { fallback?: string } = {}): string {
  const date = parseTimestamp(value, opts);
  const reference = parseTimestamp(now ?? Date.now(), opts) ?? new Date();
  if (!date) return opts.fallback ?? EMPTY;
  const diffSeconds = Math.round((reference.getTime() - date.getTime()) / 1000);
  const abs = Math.abs(diffSeconds);
  if (abs < 10) return 'just now';
  let amount: number;
  let unit: string;
  if (abs < 60) { amount = abs; unit = 's'; }
  else if (abs < 3600) { amount = Math.floor(abs / 60); unit = 'min'; }
  else if (abs < 86_400) { amount = Math.floor(abs / 3600); unit = 'h'; }
  else if (abs < 30 * 86_400) { amount = Math.floor(abs / 86_400); unit = 'd'; }
  else if (abs < 365 * 86_400) { amount = Math.floor(abs / (30 * 86_400)); unit = 'mo'; }
  else { amount = Math.floor(abs / (365 * 86_400)); unit = 'y'; }
  return diffSeconds >= 0 ? `${amount} ${unit} ago` : `in ${amount} ${unit}`;
}

// ── Numbers ────────────────────────────────────────────────────────────────

const FULL = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const COMPACT_UNITS: Array<[number, string]> = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];

function toFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Trims "1.0" → "1" and "12.50" → "12.5". */
function trimFixed(n: number, digits: number): string {
  return n.toFixed(digits).replace(/\.0+$|(\.\d*?)0+$/, '$1');
}

export type NumberStyle = 'full' | 'compact';

/**
 * "full" (default): grouped digits, up to two decimals, "1,234,567".
 * "compact": one decimal with K/M/B/T, "1.2K", "3.4M"; values below 1,000
 * stay exact. Non-numeric input returns EMPTY.
 */
export function formatNumber(value: number | string | null | undefined, style: NumberStyle = 'full'): string {
  const n = toFiniteNumber(value);
  if (n === null) return EMPTY;
  if (style === 'compact') {
    const abs = Math.abs(n);
    let i = COMPACT_UNITS.findIndex(([size]) => abs >= size);
    if (i >= 0) {
      const digits = (scaled: number) => (Math.abs(scaled) >= 100 ? 0 : 1);
      let scaled = n / COMPACT_UNITS[i][0];
      // 999,950 rounds to "1000K"; promote it to "1M" instead.
      if (i > 0 && Math.abs(Number(scaled.toFixed(digits(scaled)))) >= 1000) {
        i -= 1;
        scaled = n / COMPACT_UNITS[i][0];
      }
      return `${trimFixed(scaled, digits(scaled))}${COMPACT_UNITS[i][1]}`;
    }
  }
  return FULL.format(n);
}

/** "1 unique IP", "2 unique IPs", "1,204 events". */
export function formatCount(value: number | null | undefined, singular: string, plural = `${singular}s`, style: NumberStyle = 'full'): string {
  const n = toFiniteNumber(value);
  if (n === null) return EMPTY;
  return `${formatNumber(n, style)} ${n === 1 ? singular : plural}`;
}

/**
 * Percentage with a fixed number of decimals. `input: 'ratio'` (default)
 * treats 0.125 as 12.5 %; `input: 'percent'` treats 12.5 as 12.5 %.
 */
export function formatPercent(value: number | null | undefined, opts: { input?: 'ratio' | 'percent'; digits?: number } = {}): string {
  const n = toFiniteNumber(value);
  if (n === null) return EMPTY;
  const pct = (opts.input ?? 'ratio') === 'ratio' ? n * 100 : n;
  return `${trimFixed(pct, opts.digits ?? 1)}%`;
}

// ── Bytes and rates ────────────────────────────────────────────────────────

const IEC_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
const SI_UNITS = ['B', 'kB', 'MB', 'GB', 'TB', 'PB'];

/**
 * Byte size. Binary (IEC, 1024) units by default, "1.5 KiB", "12 MiB";
 * `{ si: true }` uses 1000-based units ("1.5 kB"). One decimal below 100 in
 * the chosen unit, none above.
 */
export function formatBytes(value: number | string | null | undefined, opts: { si?: boolean } = {}): string {
  const n = toFiniteNumber(value);
  if (n === null || n < 0) return EMPTY;
  const base = opts.si ? 1000 : 1024;
  const units = opts.si ? SI_UNITS : IEC_UNITS;
  let v = n;
  let i = 0;
  while (v >= base && i < units.length - 1) { v /= base; i++; }
  if (i === 0) return `${Math.round(v)} B`;
  // 1023.96 KiB would print as "1024 KiB"; show the next unit instead.
  if (Number(v.toFixed(v >= 100 ? 0 : 1)) >= base && i < units.length - 1) { v /= base; i++; }
  return `${trimFixed(v, v >= 100 ? 0 : 1)} ${units[i]}`;
}

/**
 * Agent or server version with one leading "v": "1.9.0" and "v1.9.0" both give
 * "v1.9.0". Agents report either spelling, so a caller never adds its own "v".
 */
export function formatVersion(value: string | null | undefined): string {
  const version = (value ?? '').trim().replace(/^v+/i, '');
  return version === '' ? EMPTY : `v${version}`;
}

/** Bits per second, 1000-based: "850 bps", "12.3 Mbps". */
export function formatBitRate(bitsPerSecond: number | null | undefined): string {
  const n = toFiniteNumber(bitsPerSecond);
  if (n === null || n < 0) return EMPTY;
  const units = ['bps', 'kbps', 'Mbps', 'Gbps', 'Tbps'];
  let v = n;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  return `${trimFixed(v, i === 0 || v >= 100 ? 0 : 1)} ${units[i]}`;
}

// ── Durations ──────────────────────────────────────────────────────────────

export type DurationUnit = 'ns' | 'us' | 'ms' | 's';

const TO_MS: Record<DurationUnit, number> = { ns: 1e-6, us: 1e-3, ms: 1, s: 1000 };

/**
 * Duration with an explicit input unit. Sub-second values keep precision
 * ("850 µs", "12 ms", "4.2 s"); longer ones use two components
 * ("5m 12s", "3h 5m", "2d 3h"). Negative or invalid input returns EMPTY.
 *
 *   formatDuration(status.uptime_seconds, 's')
 *   formatDuration(stats.uptime_ms, 'ms')
 *   formatDuration(decision.latency_us, 'us')
 *   formatDuration(rule.max_span, 'ns')   // Go time.Duration
 */
export function formatDuration(value: number | string | null | undefined, unit: DurationUnit): string {
  const n = toFiniteNumber(value);
  if (n === null || n < 0) return EMPTY;
  const ms = n * TO_MS[unit];
  if (ms === 0) return unit === 's' ? '0 s' : '0 ms';
  if (ms < 0.9995) {
    const us = ms * 1000;
    return us < 0.9995 ? `${trimFixed(ms * 1e6, 0)} ns` : `${trimFixed(us, us >= 100 ? 0 : 1)} µs`;
  }
  if (ms < 999.5) return `${trimFixed(ms, ms >= 100 ? 0 : 1)} ms`;
  const totalSeconds = ms / 1000;
  if (totalSeconds < 59.5) return `${trimFixed(totalSeconds, totalSeconds >= 10 ? 0 : 1)} s`;
  const s = Math.round(totalSeconds);
  const days = Math.floor(s / 86_400);
  const hours = Math.floor((s % 86_400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  if (days > 0) return hours ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}
