/**
 * Geographic display utilities for countries.
 */

/**
 * Formats a country name, ensuring unknown or private codes (like XX / ZZ)
 * display as 'Unknown / Private' instead of broken or raw codes.
 */
export function formatCountryName(name?: string | null, code?: string | null): string {
  const c = (code || '').trim().toUpperCase();
  const n = (name || '').trim();
  if (c === 'XX' || c === 'ZZ' || c === '' || c === '—') {
    return n && n !== 'XX' && n !== 'ZZ' && n !== '—' ? n : 'Unknown / Private';
  }
  return n && n !== 'XX' && n !== 'ZZ' ? n : c || 'Unknown';
}

/**
 * The flag of a two-letter country code, as the pair of regional indicator characters, or '' for an
 * unknown or private code. A system without flag glyphs shows the two letters, so the code or the
 * country name always stands beside it.
 */
export function countryFlag(code?: string | null): string {
  const c = (code || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c) || c === 'XX' || c === 'ZZ') return '';
  return String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 65, 0x1f1e6 + c.charCodeAt(1) - 65);
}
