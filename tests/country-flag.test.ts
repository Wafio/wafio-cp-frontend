import { describe, expect, test } from 'bun:test';
import { countryFlag } from '../src/lib/geo';

describe('country flag', () => {
  test('a two-letter code gives its flag, in any case', () => {
    expect(countryFlag('ID')).toBe('\u{1F1EE}\u{1F1E9}');
    expect(countryFlag(' us ')).toBe('\u{1F1FA}\u{1F1F8}');
  });
  test('unknown, private and malformed codes give no flag', () => {
    for (const code of ['', 'XX', 'ZZ', 'n/a', 'USA', '1D', null, undefined]) expect(countryFlag(code)).toBe('');
  });
});
