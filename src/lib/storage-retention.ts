/**
 * Model of Administration › Data retention (GET/PUT /api/admin/storage) and
 * of the database disk-pressure alert shown on Administration pages and in
 * the header. Pure functions; the page and the shared alert state call them.
 *
 * Sizes use decimal units (GB = 10^9 bytes) because the budget is entered
 * in GB.
 */
import type { RetentionTable, RetentionUpdate, StorageAlert, StorageDatabase, StorageLevel, StorageStatus, StorageTable } from './api';
import { EMPTY, formatBytes, formatNumber, formatPercent } from './format';

export const GB = 1_000_000_000;
export const BUDGET_MIN_GB = 0.1;
export const BUDGET_MAX_GB = 1_000_000;

/** Decimal byte size, the unit family the budget is entered in. */
export const formatSize = (bytes: number | null | undefined): string => formatBytes(bytes, { si: true });

/**
 * Keeps a value with its unit or a range on one line ("50 GB", "2–3650",
 * "12 days"): spaces become no-break spaces and an en dash is joined to its
 * neighbours (U+2060), so a wrapping sentence breaks only between values.
 */
export const noBreak = (text: string): string => text.replace(/ /g, '\u00a0').replace(/–/g, '\u2060–\u2060');

// ── Alert (banner + header indicator) ──────────────────────────────────────

/** warning or critical: something to show. ok / none: nothing. */
export function alertVisible(alert: Pick<StorageAlert, 'level'> | null | undefined): boolean {
  return alert?.level === 'warning' || alert?.level === 'critical';
}

/** Alert tone of a level (critical → error/danger, warning → warning). */
export function alertTone(level: StorageLevel): 'error' | 'warning' {
  return level === 'critical' ? 'error' : 'warning';
}

/** "1 day", "12 days", "less than a day". */
export function daysText(days: number): string {
  if (!Number.isFinite(days) || days < 1) return 'less than a day';
  const n = Math.floor(days);
  return `${formatNumber(n)} ${n === 1 ? 'day' : 'days'}`;
}

/** The ratio the alert is about: the budget, else the filesystem. */
export function alertRatio(alert: StorageAlert): number | null {
  return alert.level_reason === 'filesystem' ? alert.filesystem_used_ratio : alert.used_ratio;
}

const pct = (ratio: number | null) => formatPercent(ratio, { digits: 0 });

/**
 * "Database size is at 83% of its 50 GB budget (projected full in 12 days)."
 * or "The disk holding the database is 91% full."
 */
export function alertMessage(alert: StorageAlert): string {
  const days = alert.days_until_full;
  const projection = days !== null && Number.isFinite(days) ? ` (projected full in ${noBreak(daysText(days))})` : '';
  if (alert.level_reason === 'filesystem') {
    return `The disk holding the database is ${pct(alert.filesystem_used_ratio)} full${projection}.`;
  }
  const budget = alert.budget_bytes !== null ? ` of its ${noBreak(formatSize(alert.budget_bytes))} budget` : ' of its budget';
  return `Database size is at ${pct(alert.used_ratio)}${budget}${projection}.`;
}

/** Compact header label, e.g. "DB 83%" or "Disk 91%". */
export function indicatorLabel(alert: StorageAlert): string {
  const prefix = alert.level_reason === 'filesystem' ? 'Disk' : 'DB';
  const ratio = alertRatio(alert);
  return ratio === null ? prefix : `${prefix} ${pct(ratio)}`;
}

/** The alert the status page implies (to update the shell without a second request). */
export function alertFromDatabase(db: StorageDatabase): StorageAlert {
  return {
    level: db.level,
    level_reason: db.level_reason,
    size_bytes: db.size_bytes,
    budget_bytes: db.budget_bytes,
    used_ratio: db.used_ratio,
    filesystem_used_ratio: db.filesystem?.used_ratio ?? null,
    days_until_full: db.days_until_full,
    checked_at: db.checked_at,
  };
}

// ── Database section ───────────────────────────────────────────────────────

export function growthSourceNote(source: StorageDatabase['growth_source'] | string): string {
  if (source === 'chunks') return 'estimated from recent chunks';
  if (source === 'observed') return 'observed since the control plane started';
  return 'unknown';
}

export function projectionText(db: Pick<StorageDatabase, 'projection' | 'days_until_full'>): string {
  if (db.projection === 'fills') {
    return db.days_until_full !== null ? `Projected full in ${noBreak(daysText(db.days_until_full))}` : 'Projected to fill';
  }
  if (db.projection === 'stable') return 'Not projected to fill at current retention';
  return 'Unknown';
}

/** Meter level of a used ratio against the thresholds. */
export function meterLevel(ratio: number | null, warning: number, critical: number): 'ok' | 'warning' | 'critical' | 'none' {
  if (ratio === null || !Number.isFinite(ratio)) return 'none';
  if (ratio >= critical) return 'critical';
  if (ratio >= warning) return 'warning';
  return 'ok';
}

/** Width of a meter fill, 0–100. */
export const meterPercent = (ratio: number | null): number =>
  ratio === null || !Number.isFinite(ratio) ? 0 : Math.max(0, Math.min(100, ratio * 100));

/** Budget input value from bytes: "50", "0.5" (empty without a budget). */
export function budgetInput(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes <= 0) return '';
  return String(Number((bytes / GB).toFixed(3)));
}

/** Parses the budget input: null for empty, a number, or an error text. */
export function parseBudget(value: string): { value: number | null; error?: string } {
  const text = value.trim();
  if (text === '') return { value: null };
  const n = Number(text);
  if (!Number.isFinite(n)) return { value: null, error: 'Enter a number of GB.' };
  if (n < BUDGET_MIN_GB || n > BUDGET_MAX_GB) {
    return { value: null, error: `Enter between ${BUDGET_MIN_GB} and ${formatNumber(BUDGET_MAX_GB)} GB, or leave it empty for no budget.` };
  }
  return { value: n };
}

// ── Retention table ────────────────────────────────────────────────────────

export const MODE_LABELS: Record<string, string> = {
  policy: 'TimescaleDB policy',
  drop_chunks: 'Control plane (drop_chunks)',
  delete: 'Control plane (batched delete)',
  none: 'Not active',
};

export const modeLabel = (mode: string): string => MODE_LABELS[mode] ?? mode;

/** "6.1×" or "n/a". */
export function compressionRatio(table: Pick<StorageTable, 'compression'>): string {
  const ratio = table.compression?.ratio;
  if (!table.compression?.enabled || ratio === null || ratio === undefined || !Number.isFinite(ratio)) return EMPTY;
  return `${Number(ratio.toFixed(1))}×`;
}

/** Form value per table: days as text; empty = the default (reset when saved). */
export type RetentionForm = Record<string, string>;
export type RetentionErrors = Record<string, string>;

export function retentionForm(status: Pick<StorageStatus, 'tables'>): RetentionForm {
  const form: RetentionForm = {};
  for (const t of status.tables) form[t.table] = t.saved ? String(t.retention_days) : '';
  return form;
}

/** Validates every changed row against its bounds. */
export function validateRetention(form: RetentionForm, tables: StorageTable[]): RetentionErrors {
  const errors: RetentionErrors = {};
  for (const t of tables) {
    const text = (form[t.table] ?? '').trim();
    if (text === '') continue;
    const n = Number(text);
    if (!Number.isInteger(n)) errors[t.table] = 'Enter a whole number of days.';
    else if (n < t.min_days || n > t.max_days) errors[t.table] = `Enter between ${t.min_days} and ${t.max_days} days.`;
  }
  return errors;
}

/**
 * Only the changed rows: a number, or null for a saved row emptied
 * ("Reset to default"). An empty row that was never saved sends nothing.
 */
export function buildRetentionUpdate(form: RetentionForm, baseline: RetentionForm, tables: StorageTable[]): RetentionUpdate {
  const out: RetentionUpdate['tables'] = {};
  for (const t of tables) {
    const now = (form[t.table] ?? '').trim();
    const before = (baseline[t.table] ?? '').trim();
    if (now === before) continue;
    if (now === '') {
      if (t.saved) out[t.table as RetentionTable] = null;
      continue;
    }
    // Typing the value already in force still saves it explicitly.
    out[t.table as RetentionTable] = Number(now);
  }
  return { tables: out };
}

/** "tables.waf_decisions" → "waf_decisions"; anything else → null. */
export function retentionErrorTable(field: string | undefined): string | null {
  if (!field || !field.startsWith('tables.')) return null;
  const table = field.slice('tables.'.length);
  return table === '' ? null : table;
}
