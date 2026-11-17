import { describe, expect, test } from 'bun:test';
import type { TraceStatus } from '../src/lib/api';
import {
  NOT_REPORTED,
  compressionLabel,
  forwardFilterInfo,
  forwardFilterText,
  forwardFilteredText,
  telemetryRows,
  telemetrySummary,
} from '../src/lib/telemetry-status';

const delivery = {
  pending_batches: 0,
  pending_bytes: 0,
  process_accepted_batches: 3,
  dropped_batches: 0,
  dropped_events: 0,
  persisted_acknowledgements: false as const,
};
const st = (extra: Partial<TraceStatus>): TraceStatus => ({ running: true, ...extra }) as TraceStatus;

describe('telemetry status', () => {
  test('compression', () => {
    expect(compressionLabel(st({ telemetry_delivery: { ...delivery, compression: 'gzip' } }))).toBe('Compressed (gzip)');
    expect(compressionLabel(st({ telemetry_delivery: { ...delivery, compression: 'none' } }))).toBe('Not compressed');
    expect(compressionLabel(st({ telemetry_delivery: delivery }))).toBe(NOT_REPORTED);
    expect(compressionLabel(null)).toBe(NOT_REPORTED);
  });

  test('forwarding filter states', () => {
    expect(forwardFilterText(st({ forward_filter: 'active' }))).toBe('Active: events the control plane would discard stay on the host');
    expect(forwardFilterText(st({ forward_filter: 'off' }))).toBe('Not active: every event is sent');
    expect(forwardFilterInfo(st({ forward_filter: 'too_large' }))?.label).toBe('Too large');
    expect(forwardFilterInfo(st({ forward_filter: 'too_large' }))?.filtering).toBe(false);
    expect(forwardFilterInfo(st({ forward_filter: 'revision_mismatch' }))?.meaning).toContain('every event is sent');
    expect(forwardFilterInfo(st({ forward_filter: 'invalid' }))?.label).toBe('Unreadable');
    expect(forwardFilterInfo(st({ forward_filter: 'later' }))?.label).toBe('Unknown (later)');
    expect(forwardFilterInfo(st({}))).toBeNull();
    expect(forwardFilterText(undefined)).toBe(NOT_REPORTED);
  });

  test('held-back events', () => {
    expect(forwardFilteredText(st({}))).toBeNull();
    expect(forwardFilteredText(st({ forward_filtered_suppressed: 0, forward_filtered_unstored: 0 }))).toBe('None');
    expect(forwardFilteredText(st({ forward_filtered_suppressed: 1000, forward_filtered_unstored: 234 }))).toBe(
      '1,234 (1,000 suppressed by a rule · 234 not stored)'
    );
    expect(forwardFilteredText(st({ forward_filtered_suppressed: Number.NaN }))).toBeNull();
  });

  test('rows: an older agent shows only "Not reported"', () => {
    expect(telemetryRows(st({ telemetry_delivery: delivery }))).toEqual([
      { label: 'Compression', value: NOT_REPORTED },
      { label: 'Forwarding filter', value: NOT_REPORTED },
    ]);
    expect(telemetrySummary(st({}))).toBe('');
  });

  test('rows: padded and resent batches only above 0', () => {
    const s = st({
      telemetry_delivery: { ...delivery, compression: 'gzip', padded_batches: 2, resent_batches: 0 },
      forward_filter: 'active',
      forward_filtered_suppressed: 5,
      forward_filtered_unstored: 7,
    });
    expect(telemetryRows(s).map((r) => r.label)).toEqual(['Compression', 'Forwarding filter', 'Held back by the filter', 'Padded batches']);
    expect(telemetrySummary(s)).toBe('gzip · filter active');
    expect(
      telemetrySummary(st({ telemetry_delivery: { ...delivery, compression: 'none', resent_batches: 3 }, forward_filter: 'off' }))
    ).toBe('uncompressed · filter off');
    expect(telemetryRows(st({ telemetry_delivery: { ...delivery, resent_batches: 3 } })).at(-1)).toEqual({ label: 'Resent batches', value: '3' });
  });
});
