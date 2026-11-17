import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HOST_PAGE_SIZE,
  fetchAllHosts,
  filterHosts,
  hostFromRoute,
  lastHostKey,
  legacyHostTabAnchor,
  readLastHost,
  resolveInitialHost,
  sortHosts,
  switchHostSearch,
  withHost,
  writeLastHost,
  type HostLike,
} from '../src/lib/host-nav';
import { flatNavItems } from '../src/lib/shell-nav';

const h = (id: string, name: string, status: HostLike['status'] = 'online', extra: Partial<HostLike> = {}): HostLike => ({ id, name, status, ...extra });

const HOSTS: HostLike[] = [
  h('a', 'web-01', 'online', { labels: { env: 'prod', role: 'web' }, host_os: 'Ubuntu', host_os_version: '24.04' }),
  h('b', 'db-01', 'offline', { labels: { env: 'prod' }, host_os: 'Debian', host_os_version: '12' }),
  h('c', 'web-02', 'pending', { labels: { env: 'staging' } }),
  h('d', 'old-box', 'revoked'),
];

describe('filterHosts', () => {
  test('empty query keeps every host', () => {
    expect(filterHosts(HOSTS, '  ').map((x) => x.id)).toEqual(['a', 'b', 'c', 'd']);
  });
  test('matches name, status and OS case-insensitively', () => {
    expect(filterHosts(HOSTS, 'WEB').map((x) => x.id)).toEqual(['a', 'c']);
    expect(filterHosts(HOSTS, 'offline').map((x) => x.id)).toEqual(['b']);
    expect(filterHosts(HOSTS, 'ubuntu').map((x) => x.id)).toEqual(['a']);
    expect(filterHosts(HOSTS, 'debian 12').map((x) => x.id)).toEqual(['b']);
  });
  test('labels as key=value; every term must match', () => {
    expect(filterHosts(HOSTS, 'env=prod').map((x) => x.id)).toEqual(['a', 'b']);
    expect(filterHosts(HOSTS, 'env=prod web').map((x) => x.id)).toEqual(['a']);
    expect(filterHosts(HOSTS, 'staging').map((x) => x.id)).toEqual(['c']);
    expect(filterHosts(HOSTS, 'nothing-like-this')).toEqual([]);
  });
});

test('sortHosts: online, pending, offline, revoked; by name within a status', () => {
  const sorted = sortHosts([h('1', 'web-10', 'online'), h('2', 'web-9', 'online'), h('3', 'a', 'revoked'), h('4', 'z', 'pending'), h('5', 'b', 'offline')]);
  expect(sorted.map((x) => x.id)).toEqual(['2', '1', '4', '5', '3']);
});

describe('fetchAllHosts', () => {
  test('follows offset paging until total', async () => {
    const all = Array.from({ length: 230 }, (_, i) => h(`h${i}`, `host-${i}`));
    const calls: Array<{ limit: number; offset: number }> = [];
    const res = await fetchAllHosts(async (p) => {
      calls.push(p);
      return { data: { hosts: all.slice(p.offset, p.offset + p.limit), total: all.length } };
    });
    expect(res.error).toBeNull();
    expect(res.hosts?.length).toBe(230);
    expect(calls).toEqual([
      { limit: HOST_PAGE_SIZE, offset: 0 },
      { limit: HOST_PAGE_SIZE, offset: 100 },
      { limit: HOST_PAGE_SIZE, offset: 200 },
    ]);
  });
  test('stops on an empty page and reports the first error', async () => {
    const empty = await fetchAllHosts(async () => ({ data: { hosts: [], total: 50 } }));
    expect(empty.hosts).toEqual([]);
    const failed = await fetchAllHosts(async () => ({ error: { error: 'boom' } }));
    expect(failed).toEqual({ hosts: null, error: 'boom' });
  });
  test('a stale caller gets nothing', async () => {
    const res = await fetchAllHosts(async () => ({ data: { hosts: [h('a', 'a')], total: 1 } }), () => true);
    expect(res).toEqual({ hosts: null, error: null });
  });
});

describe('remembered host', () => {
  function memStorage() {
    const map = new Map<string, string>();
    return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), map };
  }
  test('per-project key, round trip', () => {
    const storage = memStorage();
    expect(lastHostKey('p1')).toBe('wafio.lastHost.p1');
    writeLastHost('p1', 'h9', storage);
    expect(storage.map.get('wafio.lastHost.p1')).toBe('h9');
    expect(readLastHost('p1', storage)).toBe('h9');
    expect(readLastHost('p2', storage)).toBe('');
  });
  test('throwing or missing storage is ignored', () => {
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('quota'); } };
    expect(() => writeLastHost('p1', 'h1', broken)).not.toThrow();
    expect(readLastHost('p1', broken)).toBe('');
    expect(readLastHost('p1', null)).toBe('');
  });
  test('resolveInitialHost: remembered, else the only usable host, ?pick=1 wins', () => {
    expect(resolveInitialHost({ hosts: HOSTS, remembered: 'b', pickRequested: false })?.id).toBe('b');
    expect(resolveInitialHost({ hosts: HOSTS, remembered: 'b', pickRequested: true })).toBeNull();
    // revoked or gone → picker (several usable hosts)
    expect(resolveInitialHost({ hosts: HOSTS, remembered: 'd', pickRequested: false })).toBeNull();
    expect(resolveInitialHost({ hosts: HOSTS, remembered: 'zzz', pickRequested: false })).toBeNull();
    const one = [h('x', 'x'), h('y', 'y', 'revoked')];
    expect(resolveInitialHost({ hosts: one, remembered: 'y', pickRequested: false })?.id).toBe('x');
    expect(resolveInitialHost({ hosts: one, remembered: '', pickRequested: false, autoSelect: false })).toBeNull();
  });
});

describe('URLs', () => {
  test('hostFromRoute reads ?host= or /hosts/<id>', () => {
    expect(hostFromRoute('/host/firewall', new URLSearchParams('host=h1&tab=rules'))).toBe('h1');
    expect(hostFromRoute('/hosts/h2', new URLSearchParams())).toBe('h2');
    expect(hostFromRoute('/hosts/h%203/firewall', new URLSearchParams())).toBe('h 3');
    expect(hostFromRoute('/hosts', new URLSearchParams())).toBe('');
    expect(hostFromRoute('/apps', new URLSearchParams())).toBe('');
  });
  test('withHost adds ?host only when known', () => {
    expect(withHost('/p/host/trace', '')).toBe('/p/host/trace');
    expect(withHost('/p/host/trace', 'h 1')).toBe('/p/host/trace?host=h%201');
    expect(withHost('/p/x?a=1', 'h')).toBe('/p/x?a=1&host=h');
  });
  test('switchHostSearch replaces host, drops pick and host-specific keys, keeps the rest', () => {
    const next = new URLSearchParams(switchHostSearch(new URLSearchParams('host=a&tab=rules&type=geo&pick=1&incident=i1'), 'b', ['incident']).slice(1));
    expect(next.get('host')).toBe('b');
    expect(next.get('tab')).toBe('rules');
    expect(next.get('type')).toBe('geo');
    expect(next.has('pick')).toBe(false);
    expect(next.has('incident')).toBe(false);
    expect(switchHostSearch(new URLSearchParams(), 'b')).toBe('?host=b');
  });
  test('legacy host-detail tabs map to Overview cards', () => {
    expect(legacyHostTabAnchor('firewall')).toBe('host-firewall');
    expect(legacyHostTabAnchor('security')).toBe('host-runtime');
    expect(legacyHostTabAnchor('runtime')).toBe('host-runtime');
    expect(legacyHostTabAnchor('agents')).toBeNull();
    expect(legacyHostTabAnchor(null)).toBeNull();
  });
});

describe('wiring', () => {
  const src = (rel: string) => readFileSync(join(import.meta.dir, '../src', rel), 'utf8');

  test('only Firewall and Runtime security are host-scoped in the sidebar', () => {
    expect(flatNavItems().filter((item) => item.hostScoped).map((item) => item.id)).toEqual(['firewall', 'runtime']);
    expect(src('routes/projects/[id]/+layout.svelte')).toMatch(/withHost\(`\$\{root\}\$\{child\.path\}`, child\.hostScoped \? routeHost : ''\)/);
  });

  test('host detail: Overview | Agents, summaries are Overview cards, no header shortcuts', () => {
    const page = src('routes/projects/[id]/hosts/[hostId]/+page.svelte');
    expect(page).not.toMatch(/id: 'firewall', label/);
    expect(page).not.toMatch(/id: 'runtime', label/);
    expect(page).toContain('id="host-firewall"');
    expect(page).toContain('id="host-runtime"');
    expect(page).toContain('>Manage firewall</Button>');
    expect(page).toContain('>Manage runtime security</Button>');
    expect(page).not.toMatch(/>Firewall<\/Button>|>Runtime security<\/Button>/);
    expect(page).toContain('writeLastHost(pid, hid)');
  });

  test('Firewall and Runtime use the HostSwitcher and remember the host', () => {
    for (const rel of ['routes/projects/[id]/host/firewall/+page.svelte', 'routes/projects/[id]/host/trace/+page.svelte']) {
      const page = src(rel);
      expect(page).toContain('<HostSwitcher');
      expect(page).toContain('writeLastHost(');
      expect(page).not.toContain('>Change host</a>');
      expect(page).not.toContain('← All hosts');
    }
  });

  test('HostSwitcher is an ARIA combobox over a listbox', () => {
    const sw = src('lib/components/HostSwitcher.svelte');
    expect(sw).toContain('role="combobox"');
    expect(sw).toContain('role="listbox"');
    expect(sw).toContain('role="option"');
    expect(sw).toContain('aria-activedescendant=');
    expect(sw).toContain('aria-haspopup="listbox"');
  });
});
