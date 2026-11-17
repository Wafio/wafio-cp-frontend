/** Reads what a person typed as a decimal number: null for empty text, undefined when it is not a number. */
export function parseDecimal(text: string): number | null | undefined {
  const typed = text.trim();
  if (typed === '') return null;
  // A comma keyboard types "2,5": one comma between digits is a decimal point.
  const normalized = /^\d*,\d+$/.test(typed) ? typed.replace(',', '.') : typed;
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(normalized)) return undefined;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : undefined;
}

/** The text of a number with a decimal point, whatever the language of the browser. */
export function formatDecimal(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}
