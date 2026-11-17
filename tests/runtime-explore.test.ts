import { describe, expect, test } from 'bun:test';
import type { EnforcementLogEntry, TraceEvent } from '../src/lib/api';
import {
  computeFacets,
  dedupeByKey,
  enforcementEntryKey,
  enforcementFacetValues,
  filterEnforcement,
  filterTraceEvents,
  meetsMinSeverity,
  mergeNewest,
  nextWindow,
  sortNewestFirst,
  traceEventKey,
  traceFacetValues,
  traceMatchesSearch,
  uidLabel,
  windowCanGrow,
  WINDOW_CAP,
  type TraceFacet,
} from '../src/lib/components/runtime/explore';
import { exploreSearch, readRuntimeUrl, runtimeSearch } from '../src/lib/components/runtime/url';

let seq = 0;
function event(over: Partial<TraceEvent> = {}): TraceEvent {
  seq += 1;
  return {
    timestamp: `2026-09-27T09:00:${String(seq % 60).padStart(2, '0')}Z`,
    timestamp_ns: 0,
    cgroup_id: 0,
    pid: 100 + seq,
    tid: 100 + seq,
    ppid: 1,
    uid: 1000,
    gid: 1000,
    event_type: 1,
    event_name: 'connect',
    category: 'network',
    severity: 3,
    severity_name: 'high',
    comm: 'sshd',
    action: 0,
    action_name: '',
    ...over,
  } as TraceEvent;
}

describe('keys (rows keyed, never by index)', () => {
  test('event_id identifies an event; an outcome update gets its own key', () => {
    const base = event({ event_id: 'e1' });
    const update = { ...base, outcome_update: true } as TraceEvent;
    expect(traceEventKey(base)).not.toBe(traceEventKey(update));
    expect(traceEventKey(base)).toBe(traceEventKey({ ...base }));
  });

  test('without event_id the key uses time, process, thread and event type', () => {
    const a = event({ timestamp: '2026-09-27T09:00:00Z', pid: 1, tid: 1 });
    const b = { ...a, tid: 2 };
    expect(traceEventKey(a)).not.toBe(traceEventKey(b));
  });

  test('dedupeByKey keeps the first row; mergeNewest puts incoming first and caps', () => {
    const a = event({ event_id: 'a' });
    const b = event({ event_id: 'b' });
    const c = event({ event_id: 'c' });
    expect(dedupeByKey([a, b, a], traceEventKey)).toEqual([a, b]);
    expect(mergeNewest([c, a], [a, b], traceEventKey, 2)).toEqual([c, a]);
  });

  test('sortNewestFirst orders by timestamp and keeps ties stable', () => {
    const old = event({ timestamp: '2026-09-27T08:00:00Z' });
    const mid1 = event({ timestamp: '2026-09-27T09:00:00Z' });
    const mid2 = event({ timestamp: '2026-09-27T09:00:00Z' });
    const recent = event({ timestamp: '2026-09-27T10:00:00.123456789Z' });
    expect(sortNewestFirst([old, mid1, recent, mid2], (e) => e.timestamp)).toEqual([recent, mid1, mid2, old]);
  });

  test('enforcement keys include the policy and the event', () => {
    const entry = (policy: number): EnforcementLogEntry => ({ timestamp: 't', recorded_at: 't', policy_id: policy, policy_name: 'p', action: 'kill', success: true, event: event({ event_id: 'x' }) });
    expect(enforcementEntryKey(entry(1))).not.toBe(enforcementEntryKey(entry(2)));
  });
});

describe('server window paging', () => {
  test('the window grows in steps up to the server cap', () => {
    expect(nextWindow(200, 400)).toBe(400);
    expect(nextWindow(200, 250)).toBe(400);
    expect(nextWindow(800, 5000)).toBe(WINDOW_CAP);
    expect(windowCanGrow(200, 200)).toBe(true);
    expect(windowCanGrow(150, 200)).toBe(false);
    expect(windowCanGrow(1000, 1000)).toBe(false);
  });
});

describe('filters, search and facets', () => {
  const rows = [
    event({ comm: 'sshd', event_name: 'connect', category: 'network', severity_name: 'critical' }),
    event({ comm: 'cron', event_name: 'execve', category: 'process', severity_name: 'high' }),
    event({ comm: 'nginx', event_name: 'openat', category: 'file,security', severity_name: 'medium', filename: '/etc/shadow' }),
    event({ comm: 'sshd', event_name: 'accept', category: 'network', severity_name: 'low', action: 1, action_name: 'alert', is_container: true }),
  ];

  test('facet values: multi-valued category, heuristic tactic, "monitor" when no action', () => {
    expect(traceFacetValues(rows[2], 'category')).toEqual(['file', 'security']);
    expect(traceFacetValues(rows[0], 'tactic')).toEqual(['Command and Control']);
    expect(traceFacetValues(event({ event_name: 'exit' }), 'tactic')).toEqual(['Unmapped']);
    expect(traceFacetValues(rows[0], 'action')).toEqual(['monitor']);
    expect(traceFacetValues(rows[3], 'container')).toEqual(['Container']);
    expect(traceFacetValues(rows[0], 'severity')).toEqual(['critical']);
  });

  test('the tactic filter matches the events of that tactic (no filter on a missing field)', () => {
    const filtered = filterTraceEvents(rows, { tactic: 'Command and Control' }, '');
    expect(filtered.map((e) => e.event_name)).toEqual(['connect', 'accept']);
  });

  test('filters combine with AND and with the search', () => {
    expect(filterTraceEvents(rows, { process: 'sshd', category: 'network' }, '').length).toBe(2);
    expect(filterTraceEvents(rows, { process: 'sshd' }, 'accept').length).toBe(1);
    expect(filterTraceEvents(rows, {}, 'SHADOW').map((e) => e.comm)).toEqual(['nginx']);
  });

  test('numeric search matches pid, ppid and uid exactly; uid names are not invented', () => {
    const e = event({ pid: 4242, uid: 33 });
    expect(traceMatchesSearch(e, '4242')).toBe(true);
    expect(traceMatchesSearch(e, '33')).toBe(true);
    expect(traceMatchesSearch(e, 'www-data')).toBe(false);
    expect(uidLabel(0)).toBe('0 (root)');
    expect(uidLabel(33)).toBe('33');
    expect(uidLabel(undefined)).toBe('n/a');
  });

  test('a facet never filters its own counts and keeps the active value', () => {
    const facets: TraceFacet[] = ['process', 'category'];
    const counts = computeFacets(rows, facets, { process: 'sshd' }, traceFacetValues, () => true);
    expect(counts.process).toEqual([
      { value: 'sshd', count: 2 },
      { value: 'cron', count: 1 },
      { value: 'nginx', count: 1 },
    ]);
    expect(counts.category).toEqual([{ value: 'network', count: 2 }]);
    const top1 = computeFacets(rows, ['process'], { process: 'nginx' }, traceFacetValues, () => true, 1);
    expect(top1.process.map((f) => f.value)).toEqual(['sshd', 'nginx']);
  });

  test('minimum severity guards live rows the same way as the server filter', () => {
    expect(meetsMinSeverity(rows[0], 'high')).toBe(true);
    expect(meetsMinSeverity(rows[2], 'high')).toBe(false);
    expect(meetsMinSeverity(rows[3], '')).toBe(true);
  });

  test('enforcement facets and search', () => {
    const entry: EnforcementLogEntry = { timestamp: 't', recorded_at: 't', policy_id: 7, policy_name: 'Kill miners', action: 'kill', success: false, failure_reason: 'process gone', mode: 'deferred_outcome', event: event({ comm: 'xmrig' }) };
    expect(enforcementFacetValues(entry, 'mode')).toEqual(['Deferred request']);
    expect(enforcementFacetValues(entry, 'result')).toEqual(['Failed']);
    expect(filterEnforcement([entry], { policy: 'Kill miners' }, 'xmrig')).toHaveLength(1);
    expect(filterEnforcement([entry], {}, 'gone')).toHaveLength(1);
  });
});

describe('URL state', () => {
  test('reads tab, section, range, source and filters with defaults', () => {
    const state = readRuntimeUrl('host=h1&tab=explore&range=24h&sev=high&process=sshd&tactic=Execution&incident=i9');
    expect(state.tab).toBe('explore');
    expect(state.section).toBe('enforcement');
    expect(state.range).toBe('24h');
    expect(state.source).toBe('events');
    expect(state.minSeverity).toBe('high');
    expect(state.traceFilters).toEqual({ process: 'sshd', tactic: 'Execution' });
    expect(state.incident).toBe('i9');
    const fallback = readRuntimeUrl('tab=bogus&range=15m&sev=nope');
    expect(fallback.tab).toBe('triage');
    expect(fallback.range).toBe('1h');
    expect(fallback.minSeverity).toBe('');
  });

  test('runtimeSearch keeps other parameters and drops defaults', () => {
    expect(runtimeSearch('host=h1&embed=1', { tab: 'policies', section: 'detection' })).toBe('?host=h1&embed=1&tab=policies&section=detection');
    expect(runtimeSearch('host=h1&tab=agent', { tab: 'triage' })).toBe('?host=h1');
    expect(runtimeSearch('host=h1&process=sshd', { traceFilters: { process: undefined, event: 'connect' } })).toBe('?host=h1&event=connect');
  });

  test('exploreSearch replaces every Explore parameter; the shared action parameter follows the source', () => {
    const search = exploreSearch('host=h1&tab=triage&process=cron&sev=low', { traceFilters: { process: 'sshd', action: 'alert' } });
    expect(search).toBe('?host=h1&tab=explore&process=sshd&action=alert');
    const enf = exploreSearch('host=h1&action=alert', { source: 'enforcement', enforcementFilters: { action: 'kill' } });
    expect(readRuntimeUrl(enf).source).toBe('enforcement');
    expect(readRuntimeUrl(enf).enforcementFilters).toEqual({ action: 'kill' });
  });
});
