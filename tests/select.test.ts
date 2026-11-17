// Select: the dropdown that replaces the native <select>. The list logic is tested on plain data; the closed
// control is rendered on the server to check its roles and names.
import { describe, expect, test } from 'bun:test';
import { renderComponent } from './support/ssr';
import { filterOptions, moveActive, orderByGroup, typeAhead, SEARCH_THRESHOLD, type SelectOption } from '../src/lib/components/ui/select';

const { default: Select } = await import('../src/lib/components/ui/Select.svelte');

const opts: SelectOption<string>[] = [
  { value: 'sql', label: 'SQL injection' },
  { value: 'xss', label: 'Cross-site scripting', description: 'Script in pages' },
  { value: 'off', label: 'Switched off', disabled: true },
  { value: 'ssrf', label: 'Server-side request forgery' },
  { value: 'sstí', label: 'Šablona injection' }
];

describe('select list logic', () => {
  test('search keeps options that contain every word, ignoring case and accents, in label, description or value', () => {
    expect(filterOptions(opts, '').map((o) => o.value)).toEqual(['sql', 'xss', 'off', 'ssrf', 'sstí']);
    expect(filterOptions(opts, 'INJ').map((o) => o.value)).toEqual(['sql', 'sstí']);
    expect(filterOptions(opts, 'sablona').map((o) => o.value)).toEqual(['sstí']);
    expect(filterOptions(opts, 'script pages').map((o) => o.value)).toEqual(['xss']);
    expect(filterOptions(opts, 'ssrf').map((o) => o.value)).toEqual(['ssrf']);
    expect(filterOptions(opts, 'nothing')).toEqual([]);
  });

  test('grouped options follow the first option of their group; ungrouped ones keep their place', () => {
    const grouped: SelectOption<string>[] = [
      { value: 'a', label: 'A', group: 'G1' },
      { value: 'x', label: 'X' },
      { value: 'b', label: 'B', group: 'G2' },
      { value: 'c', label: 'C', group: 'G1' }
    ];
    expect(orderByGroup(grouped).map((o) => o.value)).toEqual(['a', 'c', 'x', 'b']);
  });

  test('the active option skips disabled ones and stops at the ends', () => {
    expect(moveActive(opts, -1, 1)).toBe(0);
    expect(moveActive(opts, 1, 1)).toBe(3);
    expect(moveActive(opts, 3, -1)).toBe(1);
    expect(moveActive(opts, 4, 1)).toBe(4);
    expect(moveActive(opts, opts.length, -1)).toBe(4);
    expect(moveActive([{ value: 'x', label: 'X', disabled: true }], -1, 1)).toBe(-1);
  });

  test('type-ahead finds the next enabled option by label prefix and wraps; a repeated letter cycles', () => {
    expect(typeAhead(opts, -1, 's')).toBe(0);
    expect(typeAhead(opts, 0, 's')).toBe(3);
    expect(typeAhead(opts, 3, 's')).toBe(4);
    expect(typeAhead(opts, 4, 's')).toBe(0);
    expect(typeAhead(opts, 0, 'se')).toBe(3);
    expect(typeAhead(opts, 0, 'sw')).toBe(-1);
    expect(typeAhead(opts, 0, '')).toBe(-1);
  });
});

describe('Select, closed', () => {
  test('is a combobox button that shows the label of the value and names its list', async () => {
    const html = await renderComponent(Select, { options: opts, value: 'xss', id: 'pick', 'aria-label': 'Engine' });
    expect(html).toMatch(/<button[^>]*id="pick"[^>]*>/);
    const button = html.slice(html.indexOf('<button'), html.indexOf('>', html.indexOf('<button')));
    expect(button).toContain('role="combobox"');
    expect(button).toContain('aria-haspopup="listbox"');
    expect(button).toContain('aria-expanded="false"');
    expect(button).toContain('aria-label="Engine"');
    expect(button).toContain('type="button"');
    expect(html).toContain('Cross-site scripting');
    expect(html).toContain('popover="manual"');
    expect(html).not.toContain('role="option"');
  });

  test('shows the placeholder when the value matches no option, and passes disabled and aria-invalid on', async () => {
    const html = await renderComponent(Select, { options: opts, value: 'nope', placeholder: 'Choose an engine', disabled: true, 'aria-invalid': 'true' });
    expect(html).toContain('Choose an engine');
    expect(html).toMatch(/<button[^>]*disabled/);
    expect(html).toMatch(/<button[^>]*aria-invalid="true"/);
  });

  test('a search box is offered above the threshold only', () => {
    expect(SEARCH_THRESHOLD).toBe(8);
  });
});
