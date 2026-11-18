// The notices the dashboard build writes: which package a module id belongs to, what a package with
// no licence file does, and what the file holds.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error plain JavaScript module of the build
import { HEADING, bundledPackageDirs, packageRoot, readPackage, renderNotices, uniquePackages } from '../scripts/licence-notices.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function pkg(root: string, name: string, files: Record<string, string>, extra: object = {}) {
  const dir = join(root, 'node_modules', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.2.3', license: 'MIT', ...extra }));
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
  return dir;
}

function temp() {
  const root = mkdtempSync(join(tmpdir(), 'notices-'));
  dirs.push(root);
  return root;
}

describe('packageRoot', () => {
  test('plain, scoped and nested packages', () => {
    expect(packageRoot('/app/node_modules/clsx/dist/clsx.mjs')).toBe('/app/node_modules/clsx');
    expect(packageRoot('/app/node_modules/@codemirror/view/dist/index.js')).toBe('/app/node_modules/@codemirror/view');
    expect(packageRoot('/app/node_modules/a/node_modules/b/index.js?v=1')).toBe('/app/node_modules/a/node_modules/b');
  });
  test('wrapper modules of the commonjs plugin belong to their package', () => {
    expect(packageRoot('\0/app/node_modules/leaflet/dist/leaflet-src.js?commonjs-module')).toBe('/app/node_modules/leaflet');
  });
  test('modules outside node_modules and virtual modules are not packages', () => {
    expect(packageRoot('/app/src/routes/+page.svelte')).toBeNull();
    expect(packageRoot('\0virtual:foo')).toBeNull();
  });
});

describe('bundledPackageDirs', () => {
  test('counts only modules that rendered code', () => {
    const bundle = {
      'a.js': { type: 'chunk', modules: { '/app/node_modules/kept/i.js': { renderedLength: 10 }, '/app/node_modules/shaken/i.js': { renderedLength: 0 }, '/app/src/x.ts': { renderedLength: 5 } } },
      'b.css': { type: 'asset' },
    };
    expect(bundledPackageDirs(bundle)).toEqual(['/app/node_modules/kept']);
  });
});

describe('readPackage', () => {
  test('reads the licence file next to package.json', () => {
    const root = temp();
    const dir = pkg(root, 'clsx', { 'LICENSE.md': 'MIT text\n\n' });
    const p = readPackage(dir);
    expect(p).toMatchObject({ name: 'clsx', version: '1.2.3', licence: 'MIT', text: 'MIT text\n' });
  });
  test('a package without a licence file fails the build unless credits.json names a text', () => {
    const root = temp();
    const dir = pkg(root, 'bare', {});
    expect(() => readPackage(dir)).toThrow(/bare 1\.2\.3 has no licence file/);
    const notices = join(root, 'notices');
    mkdirSync(join(notices, 'texts'), { recursive: true });
    writeFileSync(join(notices, 'texts', 'bare.txt'), 'text from the repository');
    expect(readPackage(dir, { bare: 'bare.txt' }, notices).text).toBe('text from the repository\n');
  });
  test('a code file named like a licence is not taken for one', () => {
    const root = temp();
    const dir = pkg(root, 'tricky', { 'license.js': 'module.exports = 1' });
    expect(() => readPackage(dir)).toThrow(/no licence file/);
  });
});

describe('uniquePackages', () => {
  test('the same name and version is listed once, others stay, sorted by name', () => {
    const p = (name: string, version: string) => ({ name, version });
    expect(uniquePackages([p('b', '1.0.0'), p('a', '2.0.0'), p('a', '1.0.0'), p('b', '1.0.0')])).toEqual([p('a', '1.0.0'), p('a', '2.0.0'), p('b', '1.0.0')]);
  });
});

describe('renderNotices', () => {
  test('starts with the heading the release checks for and lists packages and credits', () => {
    const text = renderNotices(
      [{ name: 'clsx', version: '2.0.0', licence: 'MIT', repository: 'https://github.com/lukeed/clsx', text: 'MIT text\n' }],
      [{ name: 'Map tiles', lines: ['Esri, HERE, Garmin'] }, { name: 'Icon', lines: ['x'], licence_file: 'icon.txt' }],
      () => 'icon licence\n',
    );
    expect(text.startsWith(HEADING)).toBe(true);
    expect(text).toContain('clsx 2.0.0\nhttps://github.com/lukeed/clsx\nLicence: MIT\n\nMIT text');
    expect(text).toContain('Map tiles\nEsri, HERE, Garmin');
    expect(text).toContain('icon licence');
  });
});

describe('credits.json', () => {
  const credits = JSON.parse(readFileSync(new URL('../scripts/notices/credits.json', import.meta.url), 'utf8')).credits as {
    name: string;
    licence_file?: string;
  }[];
  const text = (file: string) => readFileSync(new URL(`../scripts/notices/texts/${file}`, import.meta.url), 'utf8');

  test('every licence file a credit names exists and has a text in it', () => {
    for (const c of credits) if (c.licence_file) expect(text(c.licence_file).length).toBeGreaterThan(200);
  });

  test('the Font Awesome credit carries the copyright line of the font and the OFL 1.1 text', () => {
    const file = credits.find((c) => c.name === 'Icons from svelte-awesome')?.licence_file;
    expect(file).toBeDefined();
    expect(text(file!)).toContain('Copyright Dave Gandy 2016. All rights reserved.');
    expect(text(file!)).toContain('SIL OPEN FONT LICENSE Version 1.1');
  });
});
