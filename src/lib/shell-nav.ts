/**
 * Shell navigation model.
 *
 * One description of the project sidebar that the project layout (sidebar,
 * breadcrumbs), the root layout (document title) and GlobalSearch (page
 * results) all read, so a label, icon or path is changed in one place.
 *
 * Paths here are app paths: without the SvelteKit `base` prefix. Callers
 * strip `base` with `appPath()` before matching and add it back to hrefs.
 */

/** Icon ids the project layout maps to svelte-awesome icons. */
import type { ReadonlyURLSearchParams } from '$app/state';

export type NavIconId =
  | 'overview'
  | 'applications'
  | 'waf'
  | 'rules'
  | 'hosts'
  | 'firewall'
  | 'runtime'
  | 'settings'
  | 'credentials'
  | 'members'
  | 'audit';

export interface ProjectNavItem {
  id: string;
  /** Canonical sidebar label; the page's h1 uses the same text. */
  label: string;
  /** Path under /projects/<id> ('' = the project root). */
  path: string;
  icon: NavIconId;
  /** Paths under /projects/<id> that make this item active (prefix match; '' = root only). */
  match: readonly string[];
  /** One line for GlobalSearch. */
  description: string;
  /** Extra search words. */
  keywords: readonly string[];
  /** A per-host page: the sidebar link carries the current route's `?host=` (host-nav.ts). */
  hostScoped?: boolean;
  children?: readonly ProjectNavItem[];
}

export interface ProjectNavSection {
  /** Group heading ('' = none). Sentence case. */
  title: string;
  items: readonly ProjectNavItem[];
}

const FIREWALL: ProjectNavItem = {
  id: 'firewall',
  label: 'Firewall',
  path: '/host/firewall',
  icon: 'firewall',
  match: ['/host/firewall', '/firewall', '/hosts/*/firewall'],
  description: 'Kernel L3/L4 packet filtering: block and allow lists, geo blocking, port policy',
  keywords: ['ebpf', 'xdp', 'tc', 'packet', 'network', 'ip', 'port', 'blocklist', 'allowlist', 'geo'],
  hostScoped: true,
};

const RUNTIME: ProjectNavItem = {
  id: 'runtime',
  label: 'Runtime security',
  path: '/host/trace',
  icon: 'runtime',
  match: ['/host/trace', '/runtime', '/hosts/*/security'],
  description: 'Syscall tracing, incidents, detection rules and enforcement policies',
  keywords: ['trace', 'syscall', 'kernel', 'incident', 'mitre', 'process', 'policy', 'kill', 'detection'],
  hostScoped: true,
};

/** The project sidebar, top to bottom. */
export const PROJECT_NAV: readonly ProjectNavSection[] = [
  {
    title: '',
    items: [
      {
        id: 'overview',
        label: 'Overview',
        path: '',
        icon: 'overview',
        match: [''],
        description: 'Recorded activity, items that need attention and setup progress',
        keywords: ['dashboard', 'summary', 'attention', 'get started', 'setup', 'checklist', 'integration'],
      },
    ],
  },
  {
    title: 'Application security',
    items: [
      {
        id: 'applications',
        label: 'Applications',
        path: '/apps',
        icon: 'applications',
        match: ['/apps'],
        description: 'Protected applications, their WAF agent assignment and monitoring',
        keywords: ['app', 'apps', 'application', 'upstream', 'route', 'site', 'service'],
      },
      {
        id: 'waf',
        label: 'WAF agents',
        path: '/waf',
        icon: 'waf',
        match: ['/waf'],
        description: 'HTTP inspection agents, their applications and inspection health',
        keywords: ['waf', 'agent', 'web application firewall', 'sidecar', 'proxy', 'heartbeat'],
      },
      {
        id: 'rules',
        label: 'Custom rules',
        path: '/rules',
        icon: 'rules',
        match: ['/rules'],
        description: 'Per-application custom WAF rules, scripts and tuning rules',
        keywords: ['rule', 'rules', 'script', 'tuning', 'false positive', 'exception'],
      },
    ],
  },
  {
    title: 'Host security',
    items: [
      {
        id: 'hosts',
        label: 'Hosts',
        path: '/hosts',
        icon: 'hosts',
        match: ['/hosts'],
        description: 'Servers running the host agent, host keys and host details',
        keywords: ['host', 'server', 'machine', 'linux', 'host key', 'infrastructure'],
        children: [FIREWALL, RUNTIME],
      },
    ],
  },
  {
    title: 'Management',
    items: [
      {
        id: 'settings',
        label: 'Project settings',
        path: '/settings/general',
        icon: 'settings',
        match: ['/settings/general'],
        description: 'Project name, description and the project default WAF policy',
        keywords: ['settings', 'project', 'rename', 'default policy', 'configuration'],
      },
      {
        id: 'credentials',
        label: 'Credentials',
        path: '/settings/credentials',
        icon: 'credentials',
        match: ['/settings/credentials', '/mtls-agent'],
        description: 'mTLS agent credentials: provision, download, expiry and revoke',
        keywords: ['credential', 'certificate', 'mtls', 'tls', 'key', 'bundle', 'install'],
      },
      {
        id: 'members',
        label: 'Members',
        path: '/settings/members',
        icon: 'members',
        match: ['/settings/members'],
        description: 'Project members, roles and invitations',
        keywords: ['team', 'member', 'role', 'user', 'invite', 'permission', 'owner', 'viewer'],
      },
      {
        id: 'audit',
        label: 'Audit log',
        path: '/audit-log',
        icon: 'audit',
        match: ['/audit-log'],
        description: 'Who changed what in this project, and when',
        keywords: ['audit', 'log', 'history', 'activity', 'changes'],
      },
    ],
  },
];

/** Every sidebar item, parents before their children, in sidebar order. */
export function flatNavItems(sections: readonly ProjectNavSection[] = PROJECT_NAV): ProjectNavItem[] {
  return sections.flatMap((section) => section.items.flatMap((item) => [item, ...(item.children ?? [])]));
}

// ── Paths ─────────────────────────────────────────────────────────────────

/** `pathname` without the SvelteKit base and without a trailing slash ('/' stays). */
export function appPath(pathname: string, base = ''): string {
  let path = pathname;
  const prefix = base.replace(/\/+$/, '');
  if (prefix && (path === prefix || path.startsWith(`${prefix}/`))) path = path.slice(prefix.length) || '/';
  if (path.length > 1) path = path.replace(/\/+$/, '');
  return path || '/';
}

/** `{ projectId, rel }` for /projects/<id>[/rel]; rel is '' at the project root. */
export function parseProjectPath(path: string): { projectId: string; rel: string } | null {
  const match = /^\/projects\/([^/]+)(\/.*)?$/.exec(path);
  if (!match) return null;
  const rel = (match[2] ?? '').replace(/\/+$/, '');
  return { projectId: decodeURIComponent(match[1]), rel };
}

function matchesPattern(rel: string, pattern: string): boolean {
  if (pattern === '') return rel === '';
  const parts = pattern.split('/');
  const segments = rel.split('/');
  if (segments.length < parts.length) return false;
  return parts.every((part, i) => part === '*' ? segments[i] !== '' : part === segments[i]);
}

/** True when `item` is the active entry for `rel` (children checked by the caller). */
export function navItemMatches(item: ProjectNavItem, rel: string): boolean {
  return item.match.some((pattern) => matchesPattern(rel, pattern));
}

/**
 * The most specific sidebar item for `rel` and its parent: a child
 * (Firewall under Hosts) wins over its parent.
 */
export function activeNavItem(rel: string, sections: readonly ProjectNavSection[] = PROJECT_NAV): { item: ProjectNavItem; parent: ProjectNavItem | null } | null {
  for (const section of sections) {
    for (const item of section.items) {
      const child = item.children?.find((c) => navItemMatches(c, rel));
      if (child) return { item: child, parent: item };
    }
  }
  for (const section of sections) {
    for (const item of section.items) {
      if (navItemMatches(item, rel)) return { item, parent: null };
    }
  }
  return null;
}

// ── Detail levels ─────────────────────────────────────────────────────────

export interface DetailCrumb {
  /** Generic label until the page names the entity ("Host", "Application"). */
  kind: string;
  /** App path of the detail page (without base). */
  path: string;
}

/**
 * Detail levels below a sidebar section, e.g. /waf/<agent>/<app> →
 * [WAF agent, Application]. Pages replace the generic labels with entity
 * names through `usePageDetail()` ($lib/page-meta.svelte).
 */
export function detailCrumbs(projectId: string, rel: string): DetailCrumb[] {
  const root = `/projects/${projectId}`;
  const seg = rel.split('/').filter(Boolean);
  if (seg[0] === 'apps' && seg[1]) return [{ kind: 'Application', path: `${root}/apps/${seg[1]}` }];
  if (seg[0] === 'waf' && seg[1]) {
    const crumbs: DetailCrumb[] = [{ kind: 'WAF agent', path: `${root}/waf/${seg[1]}` }];
    if (seg[2]) crumbs.push({ kind: 'Application', path: `${root}/waf/${seg[1]}/${seg[2]}` });
    return crumbs;
  }
  if (seg[0] === 'hosts' && seg[1] && !seg[2]) return [{ kind: 'Host', path: `${root}/hosts/${seg[1]}` }];
  return [];
}

export interface Crumb {
  label: string;
  /** Link target including base; absent for the current page. */
  href?: string;
}

/**
 * Projects / <project> / <section> [/ <detail>…]. The last crumb is the
 * current page and has no href. `details` are page-provided entity names
 * aligned with `detailCrumbs()`; missing ones fall back to the generic kind.
 */
export function projectBreadcrumbs(opts: {
  base: string;
  projectId: string;
  rel: string;
  projectName: string | null;
  details?: readonly (string | null | undefined)[];
}): Crumb[] {
  const { base, projectId, rel } = opts;
  const root = `${base}/projects/${projectId}`;
  const crumbs: Crumb[] = [
    { label: 'Projects', href: `${base}/projects` },
    { label: opts.projectName || 'Project', href: root },
  ];
  const active = activeNavItem(rel);
  const details = detailCrumbs(projectId, rel);
  if (active && active.item.id !== 'overview') {
    if (active.parent) crumbs.push({ label: active.parent.label, href: `${root}${active.parent.path}` });
    crumbs.push({ label: active.item.label, href: `${root}${active.item.path}` });
  } else if (!active) {
    crumbs.push({ label: 'Page not found' });
  } else {
    crumbs.push({ label: 'Overview', href: root });
  }
  details.forEach((detail, i) => {
    crumbs.push({ label: opts.details?.[i]?.trim() || detail.kind, href: `${base}${detail.path}` });
  });
  // The current page is the last crumb: plain text, no link.
  const last = crumbs[crumbs.length - 1];
  crumbs[crumbs.length - 1] = { label: last.label };
  return crumbs;
}

// ── Document titles ───────────────────────────────────────────────────────

export const APP_NAME = 'WAFio';
const SEP = ' | ';

/** Titles of the pages outside a project, by app path prefix (longest first). */
const GLOBAL_TITLES: ReadonlyArray<[string, string]> = [
  ['/admin/audit-log', `Global audit log${SEP}Administration`],
  ['/admin/invites', `Invitations${SEP}Administration`],
  ['/admin/users', `Users${SEP}Administration`],
  ['/admin/security-data', `Security data${SEP}Administration`],
  ['/admin/email', `Email (SMTP)${SEP}Administration`],
  ['/admin/retention', `Data retention${SEP}Administration`],
  ['/admin', 'Administration'],
  ['/projects', 'Projects'],
  ['/account', 'Account'],
  ['/dashboard', 'Account'],
  ['/login', 'Sign in'],
  ['/forgot-password', 'Forgot password'],
  ['/reset-password', 'Reset password'],
  ['/register', 'Create account'],
  ['/invite', 'Invitation'],
];

/**
 * "<page> | <project> | WAFio". Detail pages lead with the
 * entity: "web-01 | Hosts | Acme | WAFio". `override` replaces the page part
 * (error pages, pages that need a custom name).
 */
export function documentTitle(opts: {
  path: string;
  projectName?: string | null;
  details?: readonly (string | null | undefined)[];
  override?: string | null;
}): string {
  const project = parseProjectPath(opts.path);
  const tail = project && opts.projectName ? [opts.projectName, APP_NAME] : [APP_NAME];
  if (opts.override) return [opts.override, ...tail].join(SEP);
  if (project) {
    const active = activeNavItem(project.rel);
    if (!active) return ['Page not found', ...tail].join(SEP);
    const crumbs = detailCrumbs(project.projectId, project.rel);
    const parts: string[] = [];
    if (crumbs.length) {
      const i = crumbs.length - 1;
      parts.push(opts.details?.[i]?.trim() || crumbs[i].kind);
    }
    parts.push(active.item.label);
    return [...parts, ...tail].join(SEP);
  }
  const path = opts.path;
  if (path === '/' || path === '') return APP_NAME;
  const hit = GLOBAL_TITLES.find(([prefix]) => path === prefix || path.startsWith(`${prefix}/`));
  return hit ? [hit[1], APP_NAME].join(SEP) : ['Page not found', APP_NAME].join(SEP);
}

// ── Access gating ─────────────────────────────────────────────────────────

/** App paths reachable without a session. Everything else sends a signed-out visitor to /login?next=. */
const PUBLIC_PREFIXES = ['/login', '/forgot-password', '/reset-password', '/register', '/invite'];

export function isPublicPath(path: string): boolean {
  if (path === '/' || path === '') return true;
  return PUBLIC_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

// ── Moved routes ──────────────────────────────────────────────────

/**
 * Target of a moved route with the query string kept, e.g.
 * movedTo('', '/projects/p/settings/credentials', '?credential=c').
 * Used by the redirect-only `+page.ts` files left at every old path.
 */
export function movedTo(base: string, target: string, search = ''): string {
  const query = search && search !== '?' ? (search.startsWith('?') ? search : `?${search}`) : '';
  return `${base}${target}${query}`;
}

/** Old /projects/<id>/agents → the page that manages that agent kind now. */
export function legacyAgentsTarget(projectId: string, search: ReadonlyURLSearchParams): string {
  const kind = search.get('kind');
  return kind === 'waf' ? `/projects/${projectId}/waf` : `/projects/${projectId}/hosts`;
}

/** Redirect table for the docs and tests: old path pattern → new path pattern. */
export const MOVED_ROUTES: ReadonlyArray<{ from: string; to: string; note: string }> = [
  { from: '/projects/[id]/mtls-agent', to: '/projects/[id]/settings/credentials', note: 'query kept' },
  { from: '/projects/[id]/integration', to: '/projects/[id]?setup=1', note: 'guide folded into the Overview Get started checklist' },
  { from: '/projects/[id]/agents', to: '/projects/[id]/hosts (or /waf with ?kind=waf)', note: 'orphan fleet page removed' },
  { from: '/projects/[id]/firewall', to: '/projects/[id]/host/firewall', note: 'short alias; query kept' },
  { from: '/projects/[id]/runtime', to: '/projects/[id]/host/trace', note: 'short alias; query kept' },
  { from: '/dashboard/profile', to: '/account', note: 'profile moved to the account page' },
  { from: '/dashboard', to: '/projects', note: 'empty section' },
];
