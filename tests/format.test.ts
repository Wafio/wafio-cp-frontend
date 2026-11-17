import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  EMPTY,
  formatBitRate,
  formatBytes,
  formatCount,
  formatDate,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatPercent,
  formatRelative,
  formatVersion,
  parseTimestamp,
  resetDateTimeFormatCache,
  toISO,
  utcHourBucketsToLocal,
} from '../src/lib/format';

const NOW = Date.UTC(2026, 8, 27, 10, 0, 0); // 2026-09-27 10:00:00 UTC

describe('parseTimestamp', () => {
  test('accepts Go RFC 3339 with microseconds and nanoseconds', () => {
    expect(parseTimestamp('2026-09-27T09:54:16.123456Z')?.toISOString()).toBe('2026-09-27T09:54:16.123Z');
    expect(parseTimestamp('2026-09-27T09:54:16.123456789+07:00')?.toISOString()).toBe('2026-09-27T02:54:16.123Z');
  });

  test('accepts Postgres-style text with a short offset', () => {
    expect(parseTimestamp('2026-09-27 09:54:16.5+00')?.toISOString()).toBe('2026-09-27T09:54:16.500Z');
    expect(parseTimestamp('2026-09-27 09:54:16+0530')?.toISOString()).toBe('2026-09-27T04:24:16.000Z');
  });

  test('a date-time without an offset is UTC, never browser-local', () => {
    expect(parseTimestamp('2026-09-27T09:54:16')?.toISOString()).toBe('2026-09-27T09:54:16.000Z');
    expect(parseTimestamp('2026-09-27 09:54:16.123456')?.toISOString()).toBe('2026-09-27T09:54:16.123Z');
    expect(parseTimestamp('2026-09-27')?.toISOString()).toBe('2026-09-27T00:00:00.000Z');
  });

  test('epoch seconds and milliseconds', () => {
    expect(parseTimestamp(1790503200)?.toISOString()).toBe('2026-09-27T10:00:00.000Z');
    expect(parseTimestamp(1790503200000)?.toISOString()).toBe('2026-09-27T10:00:00.000Z');
    expect(parseTimestamp(1790503200, { epochUnit: 'ms' })?.toISOString()).toBe('1970-01-21T17:21:43.200Z');
    expect(parseTimestamp('1790503200')?.toISOString()).toBe('2026-09-27T10:00:00.000Z');
  });

  test('empty, zero and invalid values are null', () => {
    for (const value of [null, undefined, '', '   ', 'not a date', 0, -5, Number.NaN, '0001-01-01T00:00:00Z', new Date('x')]) {
      expect(parseTimestamp(value as never)).toBeNull();
    }
  });
});

describe('formatDateTime (browser-local time zone)', () => {
  // Pin the process to UTC+7 so a UTC rendering cannot pass by accident.
  const ZONE = 'Asia/Jakarta';
  const previousTZ = process.env.TZ;
  // What the browser's own Intl output is for that zone and the default locale.
  const intl = (value: string, options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(undefined, { ...options, timeZone: ZONE }).format(new Date(value));
  const hour24 = (value: string) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: ZONE }).format(new Date(value));

  beforeAll(() => {
    process.env.TZ = ZONE;
    resetDateTimeFormatCache();
  });
  afterAll(() => {
    process.env.TZ = previousTZ ?? 'Etc/UTC';
    resetDateTimeFormatCache();
  });

  test('renders the local zone and locale, compact, without "UTC"', () => {
    const value = '2026-09-27T14:49:16.123456Z';
    expect(hour24(value)).toBe('21');
    expect(formatDateTime(value)).toBe(`${intl(value, { dateStyle: 'medium' })}, ${intl(value, { timeStyle: 'short' })}`);
    expect(formatDateTime('2026-09-27T21:49:16+07:00')).toBe(formatDateTime(value));
    expect(formatDateTime(value, { seconds: true })).toBe(`${intl(value, { dateStyle: 'medium' })}, ${intl(value, { timeStyle: 'medium' })}`);
    expect(formatDateTime(value, { format: 'time' })).toBe(intl(value, { timeStyle: 'short' }));
    expect(formatDateTime(value, { format: 'date' })).toBe(intl(value, { dateStyle: 'medium' }));
    expect(formatDateTime(value, { year: false })).toBe(`${intl(value, { month: 'short', day: 'numeric' })}, ${intl(value, { timeStyle: 'short' })}`);
    expect(formatDateTime(value)).not.toContain('UTC');
    // Same instant rendered in UTC would differ: the zone is really applied.
    expect(formatDateTime(value)).not.toBe(
      `${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(value))}, ${new Intl.DateTimeFormat(undefined, { timeStyle: 'short', timeZone: 'UTC' }).format(new Date(value))}`
    );
  });

  test('the local calendar day, not the UTC one', () => {
    // 20:00 UTC on the 27th is 03:00 on the 28th in UTC+7.
    expect(formatDate('2026-09-27T20:00:00Z')).toBe(intl('2026-09-28T05:00:00Z', { dateStyle: 'medium' }));
    expect(formatDate('2026-09-27T20:00:00Z')).not.toBe(formatDate('2026-09-27T12:00:00Z'));
  });

  test('optional relative hint', () => {
    const value = '2026-09-27T09:55:00Z';
    expect(formatDateTime(value, { relative: true, now: NOW })).toBe(`${formatDateTime(value)} (5 min ago)`);
  });

  test('fallback for missing values', () => {
    expect(formatDateTime(null)).toBe(EMPTY);
    expect(formatDateTime('0001-01-01T00:00:00Z', { fallback: 'never' })).toBe('never');
    expect(formatDate(undefined, { fallback: 'none' })).toBe('none');
  });

  test('toISO keeps the exact UTC instant for <time datetime> and tooltips', () => {
    expect(toISO('2026-09-27 09:54:16+00')).toBe('2026-09-27T09:54:16.000Z');
    expect(toISO('2026-09-27T16:54:16+07:00')).toBe('2026-09-27T09:54:16.000Z');
    expect(toISO('garbage')).toBe('');
  });
});

describe('utcHourBucketsToLocal', () => {
  const utc = Array.from({ length: 24 }, (_, h) => h * 10); // value = UTC hour × 10

  test('shifts whole-hour offsets both ways', () => {
    const jakarta = utcHourBucketsToLocal(utc, 7 * 60);
    expect(jakarta?.[0]).toBe(170); // local 00:00 = 17:00 UTC
    expect(jakarta?.[7]).toBe(0);
    const newYork = utcHourBucketsToLocal(utc, -4 * 60);
    expect(newYork?.[0]).toBe(40);
    expect(newYork?.[20]).toBe(0);
    expect(utcHourBucketsToLocal(utc, 0)).toEqual(utc);
  });

  test('fractional offsets cannot be shifted exactly', () => {
    expect(utcHourBucketsToLocal(utc, 330)).toBeNull();
  });
});

describe('formatRelative', () => {
  const ago = (seconds: number) => new Date(NOW - seconds * 1000);
  test('past values', () => {
    expect(formatRelative(ago(3), NOW)).toBe('just now');
    expect(formatRelative(ago(45), NOW)).toBe('45 s ago');
    expect(formatRelative(ago(5 * 60 + 30), NOW)).toBe('5 min ago');
    expect(formatRelative(ago(3 * 3600), NOW)).toBe('3 h ago');
    expect(formatRelative(ago(2 * 86_400), NOW)).toBe('2 d ago');
    expect(formatRelative(ago(65 * 86_400), NOW)).toBe('2 mo ago');
    expect(formatRelative(ago(400 * 86_400), NOW)).toBe('1 y ago');
  });

  test('future values and fallback', () => {
    expect(formatRelative(new Date(NOW + 5 * 60_000), NOW)).toBe('in 5 min');
    expect(formatRelative(undefined, NOW)).toBe(EMPTY);
  });
});

describe('numbers', () => {
  test('full style groups digits in every locale', () => {
    expect(formatNumber(1234567)).toBe('1,234,567');
    expect(formatNumber(0.5)).toBe('0.5');
    expect(formatNumber('42')).toBe('42');
    expect(formatNumber(-1500.256)).toBe('-1,500.26');
  });

  test('compact style', () => {
    expect(formatNumber(999, 'compact')).toBe('999');
    expect(formatNumber(1234, 'compact')).toBe('1.2K');
    expect(formatNumber(1000, 'compact')).toBe('1K');
    expect(formatNumber(123_456, 'compact')).toBe('123K');
    expect(formatNumber(999_950, 'compact')).toBe('1M');
    expect(formatNumber(3_400_000, 'compact')).toBe('3.4M');
    expect(formatNumber(2_500_000_000, 'compact')).toBe('2.5B');
    expect(formatNumber(-1500, 'compact')).toBe('-1.5K');
  });

  test('non-numbers', () => {
    for (const value of [null, undefined, '', 'abc', Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(formatNumber(value as never)).toBe(EMPTY);
    }
  });

  test('counts pluralise', () => {
    expect(formatCount(1, 'unique IP')).toBe('1 unique IP');
    expect(formatCount(2, 'unique IP')).toBe('2 unique IPs');
    expect(formatCount(0, 'policy', 'policies')).toBe('0 policies');
    expect(formatCount(12_500, 'event', undefined, 'compact')).toBe('12.5K events');
  });

  test('percentages', () => {
    expect(formatPercent(0.125)).toBe('12.5%');
    expect(formatPercent(12.5, { input: 'percent' })).toBe('12.5%');
    expect(formatPercent(1)).toBe('100%');
    expect(formatPercent(0.33333, { digits: 2 })).toBe('33.33%');
    expect(formatPercent(null)).toBe(EMPTY);
  });
});

describe('bytes and rates', () => {
  test('binary units by default', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KiB');
    expect(formatBytes(1048576)).toBe('1 MiB');
    expect(formatBytes(10 * 1024 ** 3)).toBe('10 GiB');
    expect(formatBytes(150 * 1024 ** 2)).toBe('150 MiB');
    expect(formatBytes(1024 * 1024 - 1)).toBe('1 MiB');
  });

  test('SI units on request', () => {
    expect(formatBytes(1500, { si: true })).toBe('1.5 kB');
    expect(formatBytes(2_000_000, { si: true })).toBe('2 MB');
  });

  test('invalid sizes', () => {
    expect(formatBytes(-1)).toBe(EMPTY);
    expect(formatBytes(undefined)).toBe(EMPTY);
  });

  test('bit rates', () => {
    expect(formatBitRate(850)).toBe('850 bps');
    expect(formatBitRate(12_300_000)).toBe('12.3 Mbps');
    expect(formatBitRate(null)).toBe(EMPTY);
  });
});

describe('formatDuration', () => {
  test('explicit units never guess', () => {
    expect(formatDuration(90, 's')).toBe('1m 30s');
    expect(formatDuration(90, 'ms')).toBe('90 ms');
    expect(formatDuration(90_000, 'ms')).toBe('1m 30s');
    expect(formatDuration(1_500_000_000, 'ns')).toBe('1.5 s');
  });

  test('uptime reported in ms is not shown 1000x', () => {
    expect(formatDuration(3_600_000, 'ms')).toBe('1h');
    expect(formatDuration(3_600, 's')).toBe('1h');
  });

  test('sub-second precision', () => {
    expect(formatDuration(850, 'us')).toBe('850 µs');
    expect(formatDuration(12.34, 'ms')).toBe('12.3 ms');
    expect(formatDuration(250, 'ns')).toBe('250 ns');
    expect(formatDuration(4.2, 's')).toBe('4.2 s');
    expect(formatDuration(999.7, 'ms')).toBe('1 s');
  });

  test('long durations use two components', () => {
    expect(formatDuration(2 * 86_400 + 3 * 3600 + 59, 's')).toBe('2d 3h');
    expect(formatDuration(86_400, 's')).toBe('1d');
    expect(formatDuration(3 * 3600 + 5 * 60, 's')).toBe('3h 5m');
    expect(formatDuration(59.7, 's')).toBe('1m');
  });

  test('zero, negative and invalid', () => {
    expect(formatDuration(0, 's')).toBe('0 s');
    expect(formatDuration(0, 'ms')).toBe('0 ms');
    expect(formatDuration(-1, 's')).toBe(EMPTY);
    expect(formatDuration(undefined, 'ms')).toBe(EMPTY);
  });
});

describe('formatVersion', () => {
  test('adds one v to a bare version and keeps an existing one', () => {
    expect(formatVersion('1.9.0')).toBe('v1.9.0');
    expect(formatVersion('v1.9.0')).toBe('v1.9.0');
    expect(formatVersion('v1.11.0-dev.49-rust')).toBe('v1.11.0-dev.49-rust');
    expect(formatVersion('1.11.0-dev.49-rust')).toBe('v1.11.0-dev.49-rust');
    expect(formatVersion('vv1.0.0')).toBe('v1.0.0');
    expect(formatVersion('V2.0.0')).toBe('v2.0.0');
  });

  test('empty and missing versions are EMPTY', () => {
    for (const value of [undefined, null, '', '  ', 'v']) expect(formatVersion(value)).toBe(EMPTY);
  });
});
