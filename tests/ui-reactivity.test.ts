import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compile } from 'svelte/compiler';

for (const relativePath of [
  '../src/routes/projects/[id]/apps/[appId]/+page.svelte',
  '../src/routes/projects/[id]/settings/credentials/+page.svelte',
]) {
  test(`${relativePath} keeps mutable UI state reactive`, () => {
    const filename = fileURLToPath(new URL(relativePath, import.meta.url));
    const { warnings } = compile(readFileSync(filename, 'utf8'), { filename, generate: 'client' });
    const nonReactive = warnings.filter((warning) => warning.code === 'non_reactive_update');
    expect(nonReactive.map((warning) => warning.start?.line)).toEqual([]);
  });
}

test('application sections expose valid controls to assistive technology', () => {
  const filename = fileURLToPath(new URL('../src/routes/projects/[id]/apps/[appId]/+page.svelte', import.meta.url));
  const { warnings } = compile(readFileSync(filename, 'utf8'), { filename, generate: 'client' });
  expect(warnings.filter((warning) => warning.code === 'a11y_no_noninteractive_element_to_interactive_role')).toEqual([]);
});
