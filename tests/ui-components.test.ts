import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compile } from 'svelte/compiler';

const uiDir = fileURLToPath(new URL('../src/lib/components/ui/', import.meta.url));
const components = readdirSync(uiDir).filter((name) => name.endsWith('.svelte'));

function source(name: string): string {
  return readFileSync(`${uiDir}${name}`, 'utf8');
}

function compileWarnings(name: string) {
  const filename = `${uiDir}${name}`;
  const { warnings } = compile(source(name), { filename, generate: 'client' });
  return warnings.map((warning) => `${warning.code}:${warning.start?.line ?? '?'}`);
}

describe('UI primitives compile cleanly', () => {
  for (const name of components) {
    test(`${name} has no compiler or a11y warnings`, () => {
      expect(compileWarnings(name)).toEqual([]);
    });
  }
});

describe('UI primitives use runes only', () => {
  for (const name of components) {
    // ToastContainer predates this pass but already uses $props/$state.
    test(`${name} has no legacy reactivity`, () => {
      const script = source(name).split('</script>')[0];
      expect(script).not.toMatch(/export let /);
      expect(script).not.toMatch(/^\s*\$:/m);
      expect(script).not.toMatch(/createEventDispatcher/);
    });
  }
});

describe('dialogs are native', () => {
  test('ConfirmModal is built on Modal, not a hand-made overlay', () => {
    const text = source('ConfirmModal.svelte');
    expect(text).toContain("import Modal from './Modal.svelte'");
    expect(text).not.toContain('svelte:window');
    expect(text).not.toContain('cf-overlay');
  });

  test('Modal and Drawer open a <dialog> with showModal', () => {
    const modal = source('Modal.svelte');
    expect(modal).toContain('<dialog');
    expect(modal).toContain('showModal()');
    expect(modal).toContain('aria-labelledby');
    expect(source('Drawer.svelte')).toContain("import Modal from './Modal.svelte'");
  });
});

describe('design tokens', () => {
  const newPrimitives = [
    'Alert.svelte',
    'ConfirmModal.svelte',
    'DataTable.svelte',
    'Drawer.svelte',
    'Field.svelte',
    'InlineError.svelte',
    'KpiStrip.svelte',
    'Modal.svelte',
    'Pagination.svelte',
    'Spinner.svelte',
    'StatusDot.svelte',
    'Tabs.svelte',
    'TimeRangePicker.svelte',
    'Button.svelte',
    'Table.svelte',
    'EmptyState.svelte',
    'PageHeader.svelte'
  ];
  for (const name of newPrimitives) {
    test(`${name} has no literal hex or rgba colours`, () => {
      const style = source(name).split('<style>')[1] ?? '';
      expect(style).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(style).not.toMatch(/rgba?\(/);
    });
  }

  test('StatusDot never uses the WAF verdict aliases', () => {
    expect(source('StatusDot.svelte')).not.toMatch(/var\(--(allow|log|block)\)/);
  });

  test('one spinner keyframe set', () => {
    const withSpin = components.filter((name) => /@keyframes\s+[\w-]*spin/.test(source(name)));
    expect(withSpin).toEqual(['Spinner.svelte']);
  });
});
