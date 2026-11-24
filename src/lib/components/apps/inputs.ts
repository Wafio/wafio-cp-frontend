/**
 * Conversions behind DurationInput and ByteSizeInput: a value in the base
 * unit (milliseconds, bytes) ⇄ what the operator reads and types.
 */
import { parseByteSize } from '../../validation';

export type DurationUnit = 'ms' | 's' | 'min';

export const DURATION_FACTORS: Record<DurationUnit, number> = { ms: 1, s: 1000, min: 60_000 };

/** Largest unit that shows `ms` as a whole number; 0 and sentinels give ''. */
export function durationParts(ms: number): { amount: string; unit: DurationUnit } {
  if (!Number.isFinite(ms) || ms <= 0) return { amount: '', unit: 's' };
  if (ms % 60_000 === 0 && ms >= 60_000) return { amount: String(ms / 60_000), unit: 'min' };
  if (ms % 1000 === 0) return { amount: String(ms / 1000), unit: 's' };
  return { amount: String(ms), unit: 'ms' };
}

/**
 * Milliseconds for a typed amount: '' → 0 (unset, the default applies);
 * anything that is not a non-negative number of whole milliseconds → NaN,
 * which the form reports as an error.
 */
export function durationFromParts(amount: string, unit: DurationUnit): number {
  const text = amount.trim();
  if (text === '') return 0;
  if (!/^\d+(\.\d+)?$/.test(text)) return Number.NaN;
  const ms = Number(text) * DURATION_FACTORS[unit];
  return Number.isFinite(ms) && Math.abs(ms - Math.round(ms)) < 1e-9 ? Math.round(ms) : Number.NaN;
}

const KIB = 1024;
const MIB = 1024 * 1024;
const GIB = 1024 * 1024 * 1024;

/** Bytes as the shortest exact text: "64 MiB", "16 KiB", "1500". */
export function bytesToInput(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes >= GIB && bytes % GIB === 0) return `${bytes / GIB} GiB`;
  if (bytes >= MIB && bytes % MIB === 0) return `${bytes / MIB} MiB`;
  if (bytes >= KIB && bytes % KIB === 0) return `${bytes / KIB} KiB`;
  return String(bytes);
}

/** Bytes for typed text ("10 MB", "512KiB", "1048576"); NaN when malformed. */
export function bytesFromInput(text: string): number {
  const bytes = parseByteSize(text.trim());
  return bytes === null ? Number.NaN : bytes;
}

export type LifetimeUnit = 's' | 'min' | 'h' | 'd';

export const LIFETIME_FACTORS: Record<LifetimeUnit, number> = { s: 1, min: 60, h: 3600, d: 86_400 };

/** Largest unit that shows `seconds` as a whole number; 0 gives '' (not set). */
export function lifetimeParts(seconds: number): { amount: string; unit: LifetimeUnit } {
  if (!Number.isFinite(seconds) || seconds <= 0) return { amount: '', unit: 'min' };
  for (const unit of ['d', 'h', 'min'] as const) {
    if (seconds % LIFETIME_FACTORS[unit] === 0) return { amount: String(seconds / LIFETIME_FACTORS[unit]), unit };
  }
  return { amount: String(seconds), unit: 's' };
}

/**
 * Seconds for a typed amount: '' is 0 (not set); anything that is not a non-negative number of whole seconds is
 * NaN, which the checks report.
 */
export function lifetimeFromParts(amount: string, unit: LifetimeUnit): number {
  const text = amount.trim();
  if (text === '') return 0;
  if (!/^\d+(\.\d+)?$/.test(text)) return Number.NaN;
  const seconds = Number(text) * LIFETIME_FACTORS[unit];
  return Number.isFinite(seconds) && Math.abs(seconds - Math.round(seconds)) < 1e-9 ? Math.round(seconds) : Number.NaN;
}
