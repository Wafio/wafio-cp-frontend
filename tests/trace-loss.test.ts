import { describe, expect, test } from 'bun:test';
import type { TraceStatus } from '../src/lib/api';
import { traceLossBreakdown, traceLossNotice } from '../src/lib/trace-status';

const base: TraceStatus = {
  running: true,
  probes: 40,
  probe_names: [],
  events_total: 1000,
  events_dropped: 0,
  uptime_ms: 1,
  ringbuf_size_mb: 16,
  enforcement: true,
  policies_total: 1,
  kernel_events_dropped: 0,
  queue_dropped: 4594,
};

const current: TraceStatus = {
  ...base,
  queue_dropped_noise: 4594,
  queue_dropped_watched: 0,
  queue_dropped_significant: 0,
  delivery_lost_noise: 0,
  delivery_lost_watched: 0,
  delivery_lost_significant: 0,
  loss_window_sec: 3600,
  recent_lost_noise: 0,
  recent_lost_watched: 0,
  recent_lost_significant: 0,
  last_loss_at: '2026-10-16T09:18:00Z',
};

// The banner reports the last hour, by class.
describe('traceLossNotice', () => {
  test('no notice once the window is clean, whatever the totals', () => {
    expect(traceLossNotice(current)).toBeNull();
  });

  test('noise only: a note, not a warning', () => {
    const n = traceLossNotice({ ...current, recent_lost_noise: 1203 });
    expect(n?.tone).toBe('info');
    expect(n?.detail).toContain('1,203 file or network events below medium were dropped in the last hour');
    expect(n?.detail).toContain('were kept');
  });

  test('significant loss: a warning with both counts', () => {
    const n = traceLossNotice({ ...current, recent_lost_noise: 100, recent_lost_significant: 3 });
    expect(n?.tone).toBe('warning');
    expect(n?.title).toBe('Incomplete runtime visibility');
    expect(n?.detail).toBe('103 events lost in the last hour, including 3 process, security, medium or higher, or enforced. Missing activity is not shown.');
  });

  test('sensitive-file accesses lost: a warning naming them', () => {
    const n = traceLossNotice({ ...current, recent_lost_noise: 10, recent_lost_watched: 998 });
    expect(n?.tone).toBe('warning');
    expect(n?.detail).toBe('1,008 events lost in the last hour, including 998 accesses of sensitive files below medium. Missing activity is not shown.');
    const both = traceLossNotice({ ...current, recent_lost_watched: 2, recent_lost_significant: 1 });
    expect(both?.detail).toContain('including 1 process, security, medium or higher, or enforced and 2 accesses of sensitive files below medium');
  });

  test('other windows are named', () => {
    expect(traceLossNotice({ ...current, loss_window_sec: 7200, recent_lost_significant: 1 })?.detail).toContain('in the last 2 hours');
    expect(traceLossNotice({ ...current, loss_window_sec: 1800, recent_lost_significant: 1 })?.detail).toContain('in the last 30 minutes');
  });

  test('older agents: every loss since start, as before', () => {
    const n = traceLossNotice(base);
    expect(n?.tone).toBe('warning');
    expect(n?.detail).toBe('4,594 events lost since the agent started. Missing activity is not shown.');
    expect(traceLossNotice({ ...base, queue_dropped: 0 })).toBeNull();
    expect(traceLossNotice({ ...base, queue_dropped: undefined })).toBeNull();
    expect(traceLossNotice(null)).toBeNull();
  });
});

describe('traceLossBreakdown', () => {
  test('by place and class', () => {
    expect(traceLossBreakdown({ ...current, delivery_lost_noise: 10, delivery_lost_watched: 3, delivery_lost_significant: 2, queue_dropped_significant: 1, queue_dropped_watched: 7 })).toBe(
      'kernel 0 · send queue 4,594 (1 significant, 7 sensitive-file) · unconfirmed batches 15 (2 significant, 3 sensitive-file)',
    );
  });

  test('older agents: the total', () => {
    expect(traceLossBreakdown(base)).toBe('4,594');
    expect(traceLossBreakdown({ ...base, kernel_events_dropped: undefined })).toBeNull();
  });
});
