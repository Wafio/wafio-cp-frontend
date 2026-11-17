import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The Custom rules filter tabs asked "The custom rule has unsaved changes"
// after the rule modal had been opened once: its tracker baseline was not
// reset when the modal closed (see dirty.test.ts, modal tracker).
describe('CustomRuleModal dirty tracker', () => {
  const src = readFileSync(join(import.meta.dir, '../src/lib/components/CustomRuleModal.svelte'), 'utf8');

  test('tracks the form only while open', () => {
    expect(src).toContain('createDirtyTracker(() => (open ? snapshot() : null))');
  });

  test('resets the baseline when the modal closes', () => {
    expect(src).toMatch(/if \(!isOpen\) \{[\s\S]{0,400}?untrack\(\(\) => tracker\.reset\(\)\);\s*return;\s*\}/);
  });
});
