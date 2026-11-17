import { describe, expect, test } from 'bun:test';
import {
  MOVED_ROUTES,
  PROJECT_NAV,
  activeNavItem,
  appPath,
  detailCrumbs,
  documentTitle,
  flatNavItems,
  isPublicPath,
  legacyAgentsTarget,
  movedTo,
  parseProjectPath,
  projectBreadcrumbs,
} from '../src/lib/shell-nav';

describe('sidebar model', () => {
  test('canonical labels in sidebar order, Applications included', () => {
    expect(flatNavItems().map((item) => item.label)).toEqual([
      'Overview',
      'Applications',
      'WAF agents',
      'Custom rules',
      'Hosts',
      'Firewall',
      'Runtime security',
      'Project settings',
      'Credentials',
      'Members',
      'Audit log',
    ]);
  });

  test('group titles are sentence case', () => {
    for (const section of PROJECT_NAV) {
      if (!section.title) continue;
      expect(section.title.slice(1)).toBe(section.title.slice(1).toLowerCase());
    }
  });

  test('every item has its own icon and a description for search', () => {
    const items = flatNavItems();
    expect(new Set(items.map((item) => item.icon)).size).toBe(items.length);
    for (const item of items) expect(item.description.length).toBeGreaterThan(10);
  });

  test('Credentials lives under settings', () => {
    expect(flatNavItems().find((item) => item.id === 'credentials')?.path).toBe('/settings/credentials');
  });
});

describe('paths', () => {
  test('appPath strips the base path and trailing slash', () => {
    expect(appPath('/wafio/projects/p1/', '/wafio')).toBe('/projects/p1');
    expect(appPath('/wafio', '/wafio')).toBe('/');
    expect(appPath('/projects', '')).toBe('/projects');
    expect(appPath('/wafiox/projects', '/wafio')).toBe('/wafiox/projects');
  });

  test('parseProjectPath splits project id and rest', () => {
    expect(parseProjectPath('/projects/p1')).toEqual({ projectId: 'p1', rel: '' });
    expect(parseProjectPath('/projects/p1/waf/a1/app1')).toEqual({ projectId: 'p1', rel: '/waf/a1/app1' });
    expect(parseProjectPath('/projects')).toBeNull();
  });
});

describe('active item', () => {
  test('children win over their parent', () => {
    expect(activeNavItem('/host/firewall')?.item.id).toBe('firewall');
    expect(activeNavItem('/host/firewall')?.parent?.id).toBe('hosts');
    expect(activeNavItem('/hosts/h1/security')?.item.id).toBe('runtime');
    expect(activeNavItem('/hosts/h1')?.item.id).toBe('hosts');
  });

  test('old and new credential paths both select Credentials', () => {
    expect(activeNavItem('/mtls-agent')?.item.id).toBe('credentials');
    expect(activeNavItem('/settings/credentials')?.item.id).toBe('credentials');
    expect(activeNavItem('/settings/general')?.item.id).toBe('settings');
  });

  test('root is Overview; unknown paths match nothing', () => {
    expect(activeNavItem('')?.item.id).toBe('overview');
    expect(activeNavItem('/nope')).toBeNull();
    expect(activeNavItem('/apps/a1')?.item.id).toBe('applications');
  });
});

describe('breadcrumbs', () => {
  test('section page: last crumb is the page, without a link', () => {
    const crumbs = projectBreadcrumbs({ base: '/b', projectId: 'p1', rel: '/rules', projectName: 'Acme' });
    expect(crumbs).toEqual([
      { label: 'Projects', href: '/b/projects' },
      { label: 'Acme', href: '/b/projects/p1' },
      { label: 'Custom rules' },
    ]);
  });

  test('detail pages add the detail level with page-provided names', () => {
    const crumbs = projectBreadcrumbs({ base: '', projectId: 'p1', rel: '/waf/a1/app1', projectName: 'Acme', details: ['edge-1', null] });
    expect(crumbs.map((c) => c.label)).toEqual(['Projects', 'Acme', 'WAF agents', 'edge-1', 'Application']);
    expect(crumbs[3].href).toBe('/projects/p1/waf/a1');
    expect(crumbs[4].href).toBeUndefined();
  });

  test('child pages show their parent', () => {
    const crumbs = projectBreadcrumbs({ base: '', projectId: 'p1', rel: '/host/trace', projectName: 'Acme' });
    expect(crumbs.map((c) => c.label)).toEqual(['Projects', 'Acme', 'Hosts', 'Runtime security']);
  });

  test('detailCrumbs knows hosts, apps and WAF routes only', () => {
    expect(detailCrumbs('p', '/hosts/h1').map((c) => c.kind)).toEqual(['Host']);
    expect(detailCrumbs('p', '/hosts/h1/firewall')).toEqual([]);
    expect(detailCrumbs('p', '/apps/a1').map((c) => c.kind)).toEqual(['Application']);
    expect(detailCrumbs('p', '/audit-log')).toEqual([]);
  });
});

describe('document title', () => {
  test('"<page> | <project> | WAFio"', () => {
    expect(documentTitle({ path: '/projects/p1/audit-log', projectName: 'Acme' })).toBe('Audit log | Acme | WAFio');
    expect(documentTitle({ path: '/projects/p1', projectName: 'Acme' })).toBe('Overview | Acme | WAFio');
  });

  test('detail pages lead with the entity', () => {
    expect(documentTitle({ path: '/projects/p1/hosts/h1', projectName: 'Acme', details: ['web-01'] })).toBe('web-01 | Hosts | Acme | WAFio');
    expect(documentTitle({ path: '/projects/p1/hosts/h1', projectName: 'Acme' })).toBe('Host | Hosts | Acme | WAFio');
  });

  test('project name omitted while it loads; overrides win', () => {
    expect(documentTitle({ path: '/projects/p1/waf', projectName: null })).toBe('WAF agents | WAFio');
    expect(documentTitle({ path: '/projects/p1/waf', projectName: 'Acme', override: 'Page not found' })).toBe('Page not found | Acme | WAFio');
  });

  test('pages outside a project', () => {
    expect(documentTitle({ path: '/projects' })).toBe('Projects | WAFio');
    expect(documentTitle({ path: '/account' })).toBe('Account | WAFio');
    expect(documentTitle({ path: '/admin/users' })).toBe('Users | Administration | WAFio');
    expect(documentTitle({ path: '/login' })).toBe('Sign in | WAFio');
    expect(documentTitle({ path: '/nowhere' })).toBe('Page not found | WAFio');
    expect(documentTitle({ path: '/projects/p1/nope', projectName: 'Acme' })).toBe('Page not found | Acme | WAFio');
  });

  test('every sidebar page has a distinct title', () => {
    const titles = flatNavItems().map((item) => documentTitle({ path: `/projects/p1${item.path}`, projectName: 'Acme' }));
    expect(new Set(titles).size).toBe(titles.length);
  });
});

describe('access and redirects', () => {
  test('only sign-in, registration and invitation are public', () => {
    for (const path of ['/', '/login', '/register', '/invite/abc']) expect(isPublicPath(path)).toBe(true);
    for (const path of ['/projects', '/projects/p1', '/account', '/admin/users', '/dashboard/profile', '/loginx']) expect(isPublicPath(path)).toBe(false);
  });

  test('movedTo keeps the query and the base', () => {
    expect(movedTo('/b', '/projects/p/settings/credentials', '?credential=c1')).toBe('/b/projects/p/settings/credentials?credential=c1');
    expect(movedTo('', '/account', '')).toBe('/account');
    expect(movedTo('', '/account', '?')).toBe('/account');
  });

  test('the old fleet page sends each agent kind to its page', () => {
    expect(legacyAgentsTarget('p', new URLSearchParams('kind=waf'))).toBe('/projects/p/waf');
    expect(legacyAgentsTarget('p', new URLSearchParams(''))).toBe('/projects/p/hosts');
  });

  test('the redirect table covers every moved route', () => {
    const from = MOVED_ROUTES.map((r) => r.from);
    for (const path of ['/projects/[id]/mtls-agent', '/projects/[id]/integration', '/projects/[id]/agents', '/dashboard/profile']) expect(from).toContain(path);
  });
});
