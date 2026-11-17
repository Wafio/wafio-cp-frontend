import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { jobStateTone, pressureTone } from '../src/lib/tone';
import type { StorageAlert, StorageDatabase, StorageTable } from '../src/lib/api';
import {
  alertFromDatabase,
  alertMessage,
  alertTone,
  alertVisible,
  noBreak,
  budgetInput,
  buildRetentionUpdate,
  compressionRatio,
  daysText,
  growthSourceNote,
  indicatorLabel,
  meterLevel,
  meterPercent,
  modeLabel,
  parseBudget,
  projectionText,
  retentionErrorTable,
  retentionForm,
  validateRetention,
} from '../src/lib/storage-retention';
import { documentTitle } from '../src/lib/shell-nav';

function alert(over: Partial<StorageAlert> = {}): StorageAlert {
  return { level: 'warning', level_reason: 'budget', size_bytes: 41.5e9, budget_bytes: 50e9, used_ratio: 0.83, filesystem_used_ratio: 0.4, days_until_full: 12, checked_at: '2026-10-17T10:00:00Z', ...over };
}

function table(over: Partial<StorageTable> = {}): StorageTable {
  return {
    table: 'waf_decisions', label: 'WAF decisions', time_column: 'recorded_at',
    retention_days: 30, default_days: 30, min_days: 1, max_days: 3650, saved: false, live_days: 30,
    mode: 'policy', active: true, inactive_reason: '', last_run_at: null, last_run_deleted: null,
    hypertable: true, total_bytes: 1e9, compression: null, chunk_count: 30, oldest_at: null, oldest_kind: '',
    ingest_bytes_per_day: 1e8, ...over,
  };
}

describe('storage alert', () => {
  test('only warning and critical are shown', () => {
    expect(alertVisible(alert({ level: 'warning' }))).toBe(true);
    expect(alertVisible(alert({ level: 'critical' }))).toBe(true);
    expect(alertVisible(alert({ level: 'ok' }))).toBe(false);
    expect(alertVisible(alert({ level: 'none' }))).toBe(false);
    expect(alertVisible(null)).toBe(false);
  });

  test('tones: critical is the error (danger) tone', () => {
    expect(alertTone('critical')).toBe('error');
    expect(alertTone('warning')).toBe('warning');
  });

  test('budget message names the budget and the projection', () => {
    expect(alertMessage(alert())).toBe('Database size is at 83% of its 50\u00a0GB budget (projected full in 12\u00a0days).');
    expect(alertMessage(alert({ days_until_full: null }))).toBe('Database size is at 83% of its 50\u00a0GB budget.');
  });

  test('pressure and job tones come from the tone module, never the verdict green', () => {
    expect(pressureTone('critical')).toBe('danger');
    expect(pressureTone('warning')).toBe('warning');
    expect(pressureTone('ok')).toBe('neutral');
    expect(jobStateTone(true)).toBe('info');
    expect(jobStateTone(false)).toBe('warning');
    const page = readFileSync(new URL('../src/routes/admin/retention/+page.svelte', import.meta.url), 'utf8');
    expect(page).not.toMatch(/<Badge tone="/);
  });

  test('values and ranges never break inside', () => {
    expect(noBreak('default 7 days')).toBe('default\u00a07\u00a0days');
    expect(noBreak('2–3650')).toBe('2\u2060–\u20603650');
    expect(noBreak('60 MB')).not.toContain(' ');
    expect(alertMessage(alert({ days_until_full: 0.4 }))).toContain('projected full in less\u00a0than\u00a0a\u00a0day');
  });

  test('filesystem message names the disk', () => {
    const a = alert({ level: 'critical', level_reason: 'filesystem', filesystem_used_ratio: 0.96, days_until_full: null });
    expect(alertMessage(a)).toBe('The disk holding the database is 96% full.');
    expect(indicatorLabel(a)).toBe('Disk 96%');
    expect(indicatorLabel(alert())).toBe('DB 83%');
  });

  test('alert from the status database block', () => {
    const db = {
      size_bytes: 1, budget_bytes: 2, used_ratio: 0.5, level: 'ok', level_reason: 'budget', warning_ratio: 0.8, critical_ratio: 0.95,
      ingest_bytes_per_day: null, growth_bytes_per_day: null, growth_source: 'unknown', projected_size_bytes: null,
      days_until_full: null, projection: 'unknown',
      filesystem: { known: true, free_bytes: 1, total_bytes: 2, used_ratio: 0.5, reason: '' }, checked_at: null,
    } satisfies StorageDatabase;
    expect(alertFromDatabase(db)).toEqual({ level: 'ok', level_reason: 'budget', size_bytes: 1, budget_bytes: 2, used_ratio: 0.5, filesystem_used_ratio: 0.5, days_until_full: null, checked_at: null });
  });

  test('days', () => {
    expect(daysText(1)).toBe('1 day');
    expect(daysText(12.7)).toBe('12 days');
  });
});

describe('database section', () => {
  test('growth source and projection texts', () => {
    expect(growthSourceNote('chunks')).toBe('estimated from recent chunks');
    expect(growthSourceNote('observed')).toBe('observed since the control plane started');
    expect(growthSourceNote('unknown')).toBe('unknown');
    expect(projectionText({ projection: 'fills', days_until_full: 3 })).toBe('Projected full in 3\u00a0days');
    expect(projectionText({ projection: 'stable', days_until_full: null })).toBe('Not projected to fill at current retention');
    expect(projectionText({ projection: 'unknown', days_until_full: null })).toBe('Unknown');
  });

  test('meter levels and width', () => {
    expect(meterLevel(0.5, 0.8, 0.95)).toBe('ok');
    expect(meterLevel(0.8, 0.8, 0.95)).toBe('warning');
    expect(meterLevel(0.97, 0.8, 0.95)).toBe('critical');
    expect(meterLevel(null, 0.8, 0.95)).toBe('none');
    expect(meterPercent(1.4)).toBe(100);
    expect(meterPercent(null)).toBe(0);
  });

  test('budget input round trip and bounds', () => {
    expect(budgetInput(null)).toBe('');
    expect(budgetInput(50e9)).toBe('50');
    expect(budgetInput(0.5e9)).toBe('0.5');
    expect(parseBudget('')).toEqual({ value: null });
    expect(parseBudget(' 50 ')).toEqual({ value: 50 });
    expect(parseBudget('0.05').error).toBeDefined();
    expect(parseBudget('1000001').error).toBeDefined();
    expect(parseBudget('abc').error).toBeDefined();
    expect(parseBudget('1000000')).toEqual({ value: 1000000 });
  });
});

describe('retention table', () => {
  const tables = [
    table(),
    table({ table: 'host_security_events', label: 'Host security events', retention_days: 14, default_days: 7, saved: true, min_days: 1, max_days: 365 }),
  ];

  test('form: saved rows carry their days, others are empty (default)', () => {
    expect(retentionForm({ tables })).toEqual({ waf_decisions: '', host_security_events: '14' });
  });

  test('only changed rows are sent; an emptied saved row resets to default', () => {
    const base = retentionForm({ tables });
    expect(buildRetentionUpdate(base, base, tables)).toEqual({ tables: {} });
    expect(buildRetentionUpdate({ ...base, waf_decisions: '60' }, base, tables)).toEqual({ tables: { waf_decisions: 60 } });
    expect(buildRetentionUpdate({ ...base, host_security_events: '' }, base, tables)).toEqual({ tables: { host_security_events: null } });
    expect(buildRetentionUpdate({ ...base, host_security_events: ' 14 ' }, base, tables)).toEqual({ tables: {} });
  });

  test('validation uses the row bounds', () => {
    expect(validateRetention({ waf_decisions: '0', host_security_events: '366' }, tables)).toEqual({
      waf_decisions: 'Enter between 1 and 3650 days.',
      host_security_events: 'Enter between 1 and 365 days.',
    });
    expect(validateRetention({ waf_decisions: '1.5' }, tables).waf_decisions).toBe('Enter a whole number of days.');
    expect(validateRetention({ waf_decisions: '', host_security_events: '30' }, tables)).toEqual({});
  });

  test('API field names map to rows', () => {
    expect(retentionErrorTable('tables.waf_decisions')).toBe('waf_decisions');
    expect(retentionErrorTable('budget_gb')).toBeNull();
    expect(retentionErrorTable(undefined)).toBeNull();
  });

  test('mode labels and compression ratio', () => {
    expect(modeLabel('policy')).toBe('TimescaleDB policy');
    expect(modeLabel('drop_chunks')).toBe('Control plane (drop_chunks)');
    expect(modeLabel('delete')).toBe('Control plane (batched delete)');
    expect(modeLabel('none')).toBe('Not active');
    expect(compressionRatio(table())).toBe('n/a');
    expect(compressionRatio(table({ compression: { enabled: true, compress_after_days: 1, compressed_chunks: 5, total_chunks: 6, before_bytes: 61e8, after_bytes: 1e9, ratio: 6.123 } }))).toBe('6.1×');
  });
});

describe('Data retention shell', () => {
  test('page title matches the sidebar label', () => {
    expect(documentTitle({ path: '/admin/retention' })).toBe('Data retention | Administration | WAFio');
    const layout = readFileSync(new URL('../src/routes/admin/+layout.svelte', import.meta.url), 'utf8');
    expect(layout).toContain("{ title: 'Data retention', path: '/admin/retention'");
    const page = readFileSync(new URL('../src/routes/admin/retention/+page.svelte', import.meta.url), 'utf8');
    expect(page).toContain('<PageHeader title="Data retention"');
  });

  test('every text input on the page takes the shared Field control look', () => {
    const page = readFileSync(new URL('../src/routes/admin/retention/+page.svelte', import.meta.url), 'utf8');
    const inputs = page.match(/<input\b[^>]*>/g) ?? [];
    expect(inputs.length).toBeGreaterThanOrEqual(2);
    for (const input of inputs) expect(input).toContain('{...control}');
  });
});
