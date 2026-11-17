import { EMPTY } from '#lib/format.js';

/**
 * Whether a state colour may tint a figure. A colour says "this is a real state", so it applies only to a value above
 * zero: a zero ("0", "0.0%", 0) and a missing value stay in the normal text colour. Words ("On", "Off") keep their tone.
 */
export function toneApplies(value: string | number): boolean {
  if (typeof value === 'number') return value !== 0;
  const text = value.trim();
  if (text === EMPTY) return false;
  return !(/\d/.test(text) && !/[1-9]/.test(text));
}
