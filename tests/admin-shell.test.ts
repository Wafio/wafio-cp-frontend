import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = fileURLToPath(new URL('../src/', import.meta.url));

function svelteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...svelteFiles(path));
    else if (name.endsWith('.svelte')) out.push(path);
  }
  return out;
}

// app.css styles a bare `.nav` (header nav: fixed height, active underline,
// a hidden full-screen overlay at <= 768px). Any other element carrying the
// class inherits all of it, the admin sidebar's active item dropped ~4px
// and the whole menu vanished on phones.
describe('global .nav collision', () => {
  test('no component uses the bare `nav` class', () => {
    const bareNav = /class="(?:[^"]*\s)?nav(?:\s[^"]*)?"|class:nav[\s=}]/;
    const offenders = svelteFiles(srcDir).filter((file) => bareNav.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });

  test('admin sidebar uses its own class', () => {
    const layout = readFileSync(join(srcDir, 'routes/admin/+layout.svelte'), 'utf8');
    expect(layout).toContain('<nav class="admin-nav"');
    expect(layout).not.toMatch(/^\s*\.nav[\s{]/m);
  });
});

describe('admin users table', () => {
  test('"(you)" is spaced by CSS, not a whitespace Svelte trims', () => {
    const page = readFileSync(join(srcDir, 'routes/admin/users/+page.svelte'), 'utf8');
    expect(page).toContain('{#if isSelf(u)}<span class="you">(you)</span>{/if}');
    expect(page).toMatch(/\.you\s*\{[^}]*margin-left/);
  });
});
