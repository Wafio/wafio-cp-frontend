// Telemetry fields of the host agent's trace status (v1.9.0): stream
// compression (telemetry_delivery.compression / padded_batches /
// resent_batches) and the trace forwarding filter
// (forward_filter / forward_filtered_*). Older agents omit them; every helper
// then answers "Not reported" or nothing, never throws.
import type { TraceStatus } from './api';
import { formatNumber } from './format';

export const NOT_REPORTED = 'Not reported';

function count(n: unknown): number | null {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
}

/** "Compressed (gzip)", "Not compressed", or "Not reported". */
export function compressionLabel(s: TraceStatus | null | undefined): string {
  const c = s?.telemetry_delivery?.compression;
  if (c === 'gzip') return 'Compressed (gzip)';
  if (c === 'none') return 'Not compressed';
  return typeof c === 'string' && c !== '' ? c : NOT_REPORTED;
}

export interface ForwardFilterInfo {
  /** Short state, e.g. "Active". */
  label: string;
  /** Plain-language consequence. */
  meaning: string;
  /** True only while events are kept back on the host. */
  filtering: boolean;
}

const FILTER_STATES: Record<string, ForwardFilterInfo> = {
  active: { label: 'Active', meaning: 'events the control plane would discard stay on the host', filtering: true },
  off: { label: 'Not active', meaning: 'every event is sent', filtering: false },
  too_large: { label: 'Too large', meaning: 'the filter for this host is over 1 MiB, so every event is sent', filtering: false },
  revision_mismatch: {
    label: 'Version mismatch',
    meaning: 'the agent and the control plane disagree on the filter version, so every event is sent',
    filtering: false,
  },
  invalid: { label: 'Unreadable', meaning: 'the agent could not read the filter, so every event is sent', filtering: false },
};

/** Forwarding filter state; null when the agent does not report it. */
export function forwardFilterInfo(s: TraceStatus | null | undefined): ForwardFilterInfo | null {
  const state = s?.forward_filter;
  if (typeof state !== 'string' || state === '') return null;
  return FILTER_STATES[state] ?? { label: `Unknown (${state})`, meaning: 'every event is assumed to be sent', filtering: false };
}

/** "Active: events the control plane would discard stay on the host", or "Not reported". */
export function forwardFilterText(s: TraceStatus | null | undefined): string {
  const info = forwardFilterInfo(s);
  return info ? `${info.label}: ${info.meaning}` : NOT_REPORTED;
}

/**
 * Events the filter kept on the host since the agent started:
 * "1,234 (1,000 suppressed by a rule · 234 not stored)", "None", or null when
 * the agent does not report the counters.
 */
export function forwardFilteredText(s: TraceStatus | null | undefined): string | null {
  const suppressed = count(s?.forward_filtered_suppressed);
  const unstored = count(s?.forward_filtered_unstored);
  if (suppressed === null && unstored === null) return null;
  const total = (suppressed ?? 0) + (unstored ?? 0);
  if (total === 0) return 'None';
  return `${formatNumber(total)} (${formatNumber(suppressed ?? 0)} suppressed by a rule · ${formatNumber(unstored ?? 0)} not stored)`;
}

/** Short summary for a collapsed section: "gzip · filter active". Empty when nothing is reported. */
export function telemetrySummary(s: TraceStatus | null | undefined): string {
  const parts: string[] = [];
  const c = s?.telemetry_delivery?.compression;
  if (c === 'gzip') parts.push('gzip');
  else if (c === 'none') parts.push('uncompressed');
  const info = forwardFilterInfo(s);
  if (info) parts.push(info.filtering ? 'filter active' : 'filter off');
  return parts.join(' · ');
}

export interface TelemetryRow {
  label: string;
  value: string;
}

/**
 * Read-only rows for the agent view: compression and the forwarding filter
 * always (or "Not reported"), kept-back events when reported, padded and
 * resent batches only when above 0.
 */
export function telemetryRows(s: TraceStatus | null | undefined): TelemetryRow[] {
  const rows: TelemetryRow[] = [
    { label: 'Compression', value: compressionLabel(s) },
    { label: 'Forwarding filter', value: forwardFilterText(s) },
  ];
  const kept = forwardFilteredText(s);
  if (kept !== null) rows.push({ label: 'Held back by the filter', value: kept });
  const padded = count(s?.telemetry_delivery?.padded_batches);
  if (padded) rows.push({ label: 'Padded batches', value: formatNumber(padded) });
  const resent = count(s?.telemetry_delivery?.resent_batches);
  if (resent) rows.push({ label: 'Resent batches', value: formatNumber(resent) });
  return rows;
}
