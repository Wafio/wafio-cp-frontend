/**
 * Amount + unit ⇄ bytes for ByteSizeInput. Binary units (1 KiB = 1024 B)
 * match the agents; the display unit is the largest one that divides the
 * value exactly, so a saved "5M" shows as 5 MiB and 1500 bytes as 1500 B.
 */
export type ByteUnit = 'B' | 'KiB' | 'MiB' | 'GiB';

export const BYTE_UNITS: readonly ByteUnit[] = ['B', 'KiB', 'MiB', 'GiB'];

export const BYTE_UNIT_SIZE: Readonly<Record<ByteUnit, number>> = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 };

/** Unit to show a value in; `fallback` for an empty or zero value. */
export function bestByteUnit(bytes: number | null | undefined, fallback: ByteUnit = 'MiB'): ByteUnit {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return fallback;
  for (const unit of ['GiB', 'MiB', 'KiB'] as const) {
    if (bytes >= BYTE_UNIT_SIZE[unit] && bytes % BYTE_UNIT_SIZE[unit] === 0) return unit;
  }
  return 'B';
}

/** Bytes for an amount in a unit (rounded to whole bytes), or null for an empty amount. */
export function bytesFromAmount(amount: number | null | undefined, unit: ByteUnit): number | null {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return null;
  return Math.round(amount * BYTE_UNIT_SIZE[unit]);
}

/** Amount to show for `bytes` in `unit`, or null for an empty value. */
export function amountFromBytes(bytes: number | null | undefined, unit: ByteUnit): number | null {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return null;
  return bytes / BYTE_UNIT_SIZE[unit];
}
