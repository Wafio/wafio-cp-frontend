// WAF agent inspection health: the heartbeat counters and analyze latency that
// GET /api/fleet/agents reports per WAF agent (heartbeat fields 5-8, 11-20).
// Shared by the WAF agents list and the agent detail page.
import type { FleetAgent } from './api';
import { EMPTY, formatNumber } from './format';

/** WAF inline budget: analysis p99 must stay under 5 ms. */
export const ANALYZE_P99_BUDGET_US = 5000;

export type HealthAttention = 'alert' | 'warning' | null;

export interface HealthItem {
  key: string;
  label: string;
  /** Formatted value; "n/a" when the agent does not report the field. */
  value: string;
  /** alert = requests went uninspected; warning = rules not applied; null = informational. */
  attention: HealthAttention;
}

type Counter = { key: keyof FleetAgent; label: string; level: Exclude<HealthAttention, null> | null };

const COUNTERS: Counter[] = [
  { key: 'engine_panics_total', label: 'Engine panics', level: 'alert' },
  { key: 'analyze_panics_total', label: 'Analyze panics', level: 'alert' },
  { key: 'agent_panics_total', label: 'Agent panics', level: 'alert' },
  { key: 'partial_coverage_total', label: 'Partial coverage', level: null },
  { key: 'parse_budget_exhausted_total', label: 'Parse budget hit', level: null },
  { key: 'script_errors_total', label: 'Script errors', level: 'warning' },
  { key: 'script_incomplete_total', label: 'Script incomplete', level: 'warning' },
  { key: 'script_rules_rejected_total', label: 'Script rules rejected', level: 'warning' },
  { key: 'regex_rules_dropped_total', label: 'Regex rules dropped', level: 'warning' },
  { key: 'script_runs_in_flight', label: 'Script runs in flight', level: null },
];

const REPORTED_KEYS: (keyof FleetAgent)[] = [
  ...COUNTERS.map((c) => c.key),
  'analyze_latency_p50_us',
  'analyze_latency_p95_us',
  'analyze_latency_p99_us',
  'analyze_latency_samples',
];

function num(a: FleetAgent, key: keyof FleetAgent): number | undefined {
  const v = a[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Microseconds → "0.42 ms" / "3.1 ms" / "120 ms"; "n/a" when absent or invalid. */
export function formatLatencyMs(us: number | null | undefined): string {
  if (us === null || us === undefined || !Number.isFinite(us) || us < 0) return EMPTY;
  const ms = us / 1000;
  const digits = ms < 1 ? 2 : ms < 100 ? 1 : 0;
  return `${Number(ms.toFixed(digits))} ms`;
}

/** True only when a p99 is reported and exceeds the 5 ms budget. */
export function latencyOverBudget(p99Us: number | null | undefined, budgetUs = ANALYZE_P99_BUDGET_US): boolean {
  return typeof p99Us === 'number' && Number.isFinite(p99Us) && p99Us > budgetUs;
}

/**
 * Why no latency is shown: `not-reported` = agent predates latency reporting
 * (fields 11-19 absent), `no-samples` = no analyses in the last 5 minutes,
 * null = percentiles present.
 */
export function latencyGap(a: FleetAgent): 'not-reported' | 'no-samples' | null {
  if (num(a, 'analyze_latency_p99_us') !== undefined) return null;
  return num(a, 'agent_panics_total') === undefined && num(a, 'analyze_latency_samples') === undefined ? 'not-reported' : 'no-samples';
}

export function latencyGapText(a: FleetAgent): string {
  const gap = latencyGap(a);
  if (gap === 'not-reported') return 'This agent version does not report analyze latency';
  if (gap === 'no-samples') return 'No requests analysed in the last 5 minutes';
  const n = num(a, 'analyze_latency_samples');
  return n === undefined ? 'Last 5 minutes' : `Last 5 minutes · ${formatNumber(n)} ${n === 1 ? 'analysis' : 'analyses'}`;
}

/** Any inspection-health field reported (old agents report none). */
export function healthReported(a: FleetAgent): boolean {
  return REPORTED_KEYS.some((k) => num(a, k) !== undefined);
}

/** Counter rows in display order; attention set only for non-zero counters of a flagged kind. */
export function wafHealthItems(a: FleetAgent): HealthItem[] {
  return COUNTERS.map(({ key, label, level }) => {
    const v = num(a, key);
    return { key: String(key), label, value: v === undefined ? EMPTY : formatNumber(v), attention: level && (v ?? 0) > 0 ? level : null };
  });
}

/** Healthy = reported, no flagged counter and p99 within budget. */
export function healthNeedsAttention(a: FleetAgent): boolean {
  return wafHealthItems(a).some((i) => i.attention !== null) || latencyOverBudget(num(a, 'analyze_latency_p99_us'));
}

/** Recovered panics mean affected requests were allowed without full inspection. */
export function healthPanicked(a: FleetAgent): boolean {
  return wafHealthItems(a).some((i) => i.attention === 'alert');
}

/** Custom rules the agent did not apply (script rejections, dropped regex rules). */
export function rulesNotApplied(a: FleetAgent): number {
  return (num(a, 'script_rules_rejected_total') ?? 0) + (num(a, 'regex_rules_dropped_total') ?? 0);
}
