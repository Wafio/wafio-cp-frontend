import { describe, expect, test } from 'bun:test';
import type { FleetAgent, TraceStatus } from '../src/lib/api';
import {
  ANALYZE_P99_BUDGET_US,
  formatLatencyMs,
  healthNeedsAttention,
  healthPanicked,
  healthReported,
  latencyGap,
  latencyGapText,
  latencyOverBudget,
  rulesNotApplied,
  wafHealthItems,
} from '../src/lib/waf-health';
import { regexNotAppliedMessage, ruleRegexError } from '../src/lib/components/rules/regex-error';
import { killCandidatesLost, priorityRingState, priorityRingSummary, protectedSummary } from '../src/lib/trace-status';

const agent = (extra: Partial<FleetAgent> = {}) => ({ id: 'a1', name: 'waf', kind: 'waf', ...extra }) as FleetAgent;

describe('analyze latency', () => {
  test('formats microseconds as milliseconds', () => {
    expect(formatLatencyMs(420)).toBe('0.42 ms');
    expect(formatLatencyMs(3140)).toBe('3.1 ms');
    expect(formatLatencyMs(5000)).toBe('5 ms');
    expect(formatLatencyMs(123_456)).toBe('123 ms');
    expect(formatLatencyMs(0)).toBe('0 ms');
  });
  test('absent or invalid values render as a dash', () => {
    expect(formatLatencyMs(undefined)).toBe('n/a');
    expect(formatLatencyMs(null)).toBe('n/a');
    expect(formatLatencyMs(-1)).toBe('n/a');
    expect(formatLatencyMs(Number.NaN)).toBe('n/a');
  });
  test('budget is exceeded only strictly above 5 ms', () => {
    expect(ANALYZE_P99_BUDGET_US).toBe(5000);
    expect(latencyOverBudget(5000)).toBe(false);
    expect(latencyOverBudget(5001)).toBe(true);
    expect(latencyOverBudget(undefined)).toBe(false);
  });
  test('explains missing percentiles', () => {
    expect(latencyGap(agent({ analyze_panics_total: 0 }))).toBe('not-reported');
    expect(latencyGap(agent({ agent_panics_total: 0, analyze_latency_samples: 0 }))).toBe('no-samples');
    expect(latencyGap(agent({ analyze_latency_p99_us: 900 }))).toBeNull();
    expect(latencyGapText(agent({ analyze_latency_p99_us: 900, analyze_latency_samples: 1200 }))).toBe('Last 5 minutes · 1,200 analyses');
  });
});

describe('inspection health counters', () => {
  test('old agents report nothing', () => {
    expect(healthReported(agent())).toBe(false);
    expect(healthReported(agent({ regex_rules_dropped_total: 0 }))).toBe(true);
  });
  test('absent fields show a dash, present ones are formatted', () => {
    const items = wafHealthItems(agent({ engine_panics_total: 1234 }));
    expect(items.find((i) => i.key === 'engine_panics_total')?.value).toBe('1,234');
    expect(items.find((i) => i.key === 'script_errors_total')?.value).toBe('n/a');
  });
  test('attention only for non-zero flagged counters', () => {
    const a = agent({ engine_panics_total: 0, partial_coverage_total: 40, regex_rules_dropped_total: 2, agent_panics_total: 1 });
    const byKey = Object.fromEntries(wafHealthItems(a).map((i) => [i.key, i.attention]));
    expect(byKey.engine_panics_total).toBeNull();
    expect(byKey.partial_coverage_total).toBeNull();
    expect(byKey.regex_rules_dropped_total).toBe('warning');
    expect(byKey.agent_panics_total).toBe('alert');
    expect(healthPanicked(a)).toBe(true);
    expect(rulesNotApplied(agent({ script_rules_rejected_total: 1, regex_rules_dropped_total: 2 }))).toBe(3);
  });
  test('slow p99 alone needs attention', () => {
    const base = { engine_panics_total: 0, analyze_panics_total: 0 };
    expect(healthNeedsAttention(agent({ ...base, analyze_latency_p99_us: 4000 }))).toBe(false);
    expect(healthNeedsAttention(agent({ ...base, analyze_latency_p99_us: 6000 }))).toBe(true);
  });
});

describe('rule regex_error', () => {
  test('empty or absent means usable', () => {
    expect(ruleRegexError({ regex_error: '' })).toBe('');
    expect(ruleRegexError({})).toBe('');
    expect(regexNotAppliedMessage(null)).toBe('');
  });
  test('builds the not-applied notice', () => {
    expect(regexNotAppliedMessage({ regex_error: ' condition 2: regex too complex ' })).toBe('Not applied by agents: condition 2: regex too complex');
  });
});

describe('trace status fields', () => {
  const st = (extra: Partial<TraceStatus>) => ({ running: true, probes: 1, probe_names: [], events_total: 0, events_dropped: 0, uptime_ms: 0, ringbuf_size_mb: 8, enforcement: true, policies_total: 1, ...extra }) as TraceStatus;
  test('priority ring states', () => {
    expect(priorityRingState(st({}))).toBe('not-reported');
    expect(priorityRingState(st({ priority_ring: false }))).toBe('inactive');
    expect(priorityRingSummary(st({ priority_ring: true, priority_events_routed: 12, priority_events_full: 1, priority_events_lost: 0 }))).toBe('Active · 12 routed · 1 overflowed · 0 lost');
  });
  test('lost kill candidates', () => {
    expect(killCandidatesLost(st({}))).toBe(0);
    expect(killCandidatesLost(st({ priority_events_lost: 3 }))).toBe(3);
  });
  test('protected summary', () => {
    expect(protectedSummary(st({}))).toBe('Not reported');
    expect(protectedSummary(st({ protected_kernel_set: true, protected_tgids: 7 }))).toBe('Kernel set · 7 processes');
    expect(protectedSummary(st({ protected_kernel_set: true, protected_tgids: 7, protected_fork_refused: 2 }))).toBe('Kernel set · 7 processes · 2 forks not inserted');
  });
});
