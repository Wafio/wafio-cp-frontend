// Vite plugin that writes NOTICES.txt into the client build: the licence texts of the npm
// packages whose code ended up in the bundle, followed by the credits in scripts/notices/credits.json.
//
// The list comes from the modules Rollup put into the chunks (a module that tree-shaking emptied does
// not count), so it is what the build contains and not what bun.lock names. The file lands in dist/ and
// is served at <mount path>/NOTICES.txt; the control plane release appends it to its own NOTICES.txt.
//
// The build fails when a bundled package has no licence file and credits.json gives no text for it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOTICE_DIR = path.join(HERE, 'notices');
export const HEADING = 'WAFio dashboard: notices of the bundled npm packages';

const LICENCE_NAME = /^(licen[cs]e|copying)([-_. ].*)?$/i;
const CODE_SUFFIX = /\.(m?js|cjs|ts|json|html)$/i;

/** The package directory a module id lives in, or null for modules outside node_modules. */
export function packageRoot(id) {
  // Plugins mark their wrapper modules with a leading NUL and a query (commonjs interop).
  const clean = id.replace(/^\0/, '').split('?')[0];
  const marker = '/node_modules/';
  const at = clean.lastIndexOf(marker);
  if (at < 0) return null;
  const rest = clean.slice(at + marker.length).split('/');
  const parts = rest[0].startsWith('@') ? rest.slice(0, 2) : rest.slice(0, 1);
  if (parts.length === 0 || parts.some((p) => !p)) return null;
  return clean.slice(0, at + marker.length) + parts.join('/');
}

/** Package directories that contribute code to a Rollup bundle (chunks with a rendered module). */
export function bundledPackageDirs(bundle) {
  const dirs = new Set();
  for (const item of Object.values(bundle)) {
    if (item.type !== 'chunk') continue;
    for (const [id, info] of Object.entries(item.modules ?? {})) {
      if (!(info.renderedLength > 0)) continue;
      const dir = packageRoot(id);
      if (dir) dirs.add(dir);
    }
  }
  return [...dirs].sort();
}

function repositoryOf(pkg) {
  const r = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  return r ? r.replace(/^git\+/, '').replace(/\.git$/, '').replace(/^git:\/\//, 'https://') : pkg.homepage || '';
}

/** Reads package.json and the licence file of one package directory. */
export function readPackage(dir, overrides = {}, noticeDir = NOTICE_DIR) {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const names = fs.readdirSync(dir).filter((n) => LICENCE_NAME.test(n) && !CODE_SUFFIX.test(n) && fs.statSync(path.join(dir, n)).isFile());
  names.sort((a, b) => a.localeCompare(b));
  let text = names.length ? fs.readFileSync(path.join(dir, names[0]), 'utf8') : '';
  if (!text.trim() && overrides[pkg.name]) {
    text = fs.readFileSync(path.join(noticeDir, 'texts', overrides[pkg.name]), 'utf8');
  }
  if (!text.trim()) {
    throw new Error(`${pkg.name} ${pkg.version} has no licence file: add its text to scripts/notices/texts and name it under missing_licence_files in scripts/notices/credits.json`);
  }
  const licence = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type || 'see the text';
  return { name: pkg.name, version: pkg.version, licence, repository: repositoryOf(pkg), text: text.replace(/\s+$/, '') + '\n' };
}

/** One entry per name and version: the same package installed in two places is listed once. */
export function uniquePackages(packages) {
  const seen = new Map(packages.map((p) => [`${p.name}@${p.version}`, p]));
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/** The whole file, from the packages and the credits data. */
export function renderNotices(packages, credits, readText) {
  const out = [
    HEADING,
    '='.repeat(HEADING.length),
    '',
    'The dashboard build contains code of the npm packages below. This file is generated when the',
    'dashboard is built, from the packages that end up in the bundle; do not edit it by hand.',
    ''
  ];
  for (const p of packages) {
    out.push('-'.repeat(79), `${p.name} ${p.version}`, ...(p.repository ? [p.repository] : []), `Licence: ${p.licence}`, '', p.text.replace(/\n$/, ''), '');
  }
  out.push('Icons, data and services shown by the dashboard', '-'.repeat(47), '');
  for (const c of credits) {
    out.push('-'.repeat(79), c.name, ...c.lines);
    if (c.licence_file) out.push('', readText(c.licence_file).replace(/\s+$/, ''));
    out.push('');
  }
  return out.join('\n');
}

export default function licenceNotices() {
  const data = JSON.parse(fs.readFileSync(path.join(NOTICE_DIR, 'credits.json'), 'utf8'));
  return {
    name: 'wafio-licence-notices',
    apply: 'build',
    applyToEnvironment: (environment) => environment.name === 'client',
    generateBundle(_options, bundle) {
      let packages;
      try {
        packages = uniquePackages(bundledPackageDirs(bundle).map((dir) => readPackage(dir, data.missing_licence_files)));
      } catch (e) {
        this.error(e.message);
      }
      const source = renderNotices(packages, data.credits, (name) => fs.readFileSync(path.join(NOTICE_DIR, 'texts', name), 'utf8'));
      this.emitFile({ type: 'asset', fileName: 'NOTICES.txt', source });
    }
  };
}
