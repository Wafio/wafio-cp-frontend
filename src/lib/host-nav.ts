/**
 * Host navigation helpers shared by HostPicker, HostSwitcher, the project
 * sidebar and the host-scoped pages (Firewall, Runtime security, host
 * detail). Pure functions: no Svelte, no API client, the list loader takes
 * the page fetcher as an argument so tests can drive it.
 */

import type { StatusKind } from './components/ui/types';
import type { ReadonlyURLSearchParams } from '$app/state';

/** Status dot, label and sort order of each host status. */
export const HOST_STATUS: Record<string, { dot: StatusKind; label: string; order: number }> = {
  online: { dot: 'online', label: 'Online', order: 0 },
  pending: { dot: 'pending', label: 'Pending', order: 1 },
  offline: { dot: 'offline', label: 'Offline', order: 2 },
  revoked: { dot: 'disabled', label: 'Revoked', order: 3 },
};

/** The fields of an API `Host` these helpers read. */
export interface HostLike {
  id: string;
  name: string;
  status: 'pending' | 'online' | 'offline' | 'revoked' | string;
  labels?: Record<string, string> | null;
  host_os?: string;
  host_os_version?: string;
  host_kernel?: string;
  host_arch?: string;
  host_key_prefix?: string;
}

// ── Loading every host ────────────────────────────────────────────────────

export const HOST_PAGE_SIZE = 100;
/** Safety stop: 50 pages × 100 = 5,000 hosts. */
const MAX_PAGES = 50;

export type HostPageFetcher<H> = (page: { limit: number; offset: number }) => Promise<{
  data?: { hosts?: H[] | null; total?: number } | null;
  error?: { error: string } | null;
}>;

/**
 * Follows offset paging until every host is loaded (or a page is empty).
 * Returns `{ error }` on the first failed page; `isStale()` aborts quietly
 * (`{ hosts: null }`) when the caller's context changed meanwhile.
 */
export async function fetchAllHosts<H>(
  fetchPage: HostPageFetcher<H>,
  isStale: () => boolean = () => false,
): Promise<{ hosts: H[] | null; error: string | null }> {
  const all: H[] = [];
  for (let i = 0; i < MAX_PAGES; i++) {
    const res = await fetchPage({ limit: HOST_PAGE_SIZE, offset: all.length });
    if (isStale()) return { hosts: null, error: null };
    if (res.error) return { hosts: null, error: res.error.error };
    const batch = res.data?.hosts ?? [];
    all.push(...batch);
    if (!batch.length || all.length >= (res.data?.total ?? all.length)) break;
  }
  return { hosts: all, error: null };
}

// ── Search ────────────────────────────────────────────────────────────────

export function isPickable(host: HostLike): boolean {
  return host.status !== 'revoked';
}

function haystack(host: HostLike): string[] {
  const labels = Object.entries(host.labels ?? {}).map(([k, v]) => `${k}=${v}`);
  return [
    host.name,
    host.status,
    host.host_os ?? '',
    host.host_os_version ?? '',
    host.host_os && host.host_os_version ? `${host.host_os} ${host.host_os_version}` : '',
    host.host_kernel ?? '',
    host.host_arch ?? '',
    ...labels,
  ]
    .filter(Boolean)
    .map((s) => s.toLowerCase());
}

/**
 * Hosts matching every whitespace-separated term of `query`, case
 * insensitive. A term matches a substring of the name, status, OS, kernel,
 * arch or a label written `key=value` (so `env=prod`, `env=` and `prod`
 * all work). An empty query returns the list unchanged.
 */
export function filterHosts<H extends HostLike>(hosts: readonly H[], query: string): H[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [...hosts];
  return hosts.filter((host) => {
    const fields = haystack(host);
    return terms.every((term) => fields.some((field) => field.includes(term)));
  });
}

/** Pickable hosts first (online, pending, offline), revoked last; by name within a status. */
export function sortHosts<H extends HostLike>(hosts: readonly H[]): H[] {
  return [...hosts].sort(
    (a, b) =>
      (HOST_STATUS[a.status]?.order ?? 2) - (HOST_STATUS[b.status]?.order ?? 2) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }),
  );
}

// ── Remembered host (per project, per browser) ────────────────────────────

export function lastHostKey(projectId: string): string {
  return `wafio.lastHost.${projectId}`;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** The host last opened in this project, or '' (storage blocked, empty, never set). */
export function readLastHost(projectId: string, storage: StorageLike | null = defaultStorage()): string {
  if (!projectId || !storage) return '';
  try {
    return storage.getItem(lastHostKey(projectId)) ?? '';
  } catch {
    return '';
  }
}

/** Remembers `hostId` for the project; failures are ignored (the value is never required). */
export function writeLastHost(projectId: string, hostId: string, storage: StorageLike | null = defaultStorage()): void {
  if (!projectId || !hostId || !storage) return;
  try {
    storage.setItem(lastHostKey(projectId), hostId);
  } catch {
    /* private mode, quota, blocked site data: nothing to remember */
  }
}

/**
 * What a host-scoped page without `?host` opens: the remembered host when it
 * still exists and is not revoked, else the only pickable host when
 * `autoSelect` is on and the list is complete, else nothing (show the picker).
 * `?pick=1` (`pickRequested`) always shows the picker.
 */
export function resolveInitialHost<H extends HostLike>(opts: {
  hosts: readonly H[];
  remembered: string;
  pickRequested: boolean;
  autoSelect?: boolean;
}): H | null {
  if (opts.pickRequested) return null;
  if (opts.remembered) {
    const hit = opts.hosts.find((h) => h.id === opts.remembered);
    if (hit && isPickable(hit)) return hit;
  }
  if (opts.autoSelect ?? true) {
    const usable = opts.hosts.filter(isPickable);
    if (usable.length === 1) return usable[0];
  }
  return null;
}

// ── URLs ──────────────────────────────────────────────────────────────────

/**
 * The host the current project route is about: `?host=<id>` or the
 * `/hosts/<id>[/…]` detail path. `rel` is the path under /projects/<id>.
 */
export function hostFromRoute(rel: string, search: ReadonlyURLSearchParams): string {
  const fromQuery = search.get('host');
  if (fromQuery) return fromQuery;
  const match = /^\/hosts\/([^/]+)(?:\/|$)/.exec(rel);
  return match ? decodeURIComponent(match[1]) : '';
}

/** `href` with `?host=<id>` when a host is known, unchanged otherwise. */
export function withHost(href: string, hostId: string): string {
  if (!hostId) return href;
  return `${href}${href.includes('?') ? '&' : '?'}host=${encodeURIComponent(hostId)}`;
}

/**
 * The query string after switching to `hostId`: replaces `host`, drops
 * `pick` and any host-specific `drop` keys, keeps everything else (tab,
 * range, filters). Returns '' or a string starting with '?'.
 */
export function switchHostSearch(search: ReadonlyURLSearchParams, hostId: string, drop: readonly string[] = []): string {
  const next = new URLSearchParams(search.toString());
  next.set('host', hostId);
  next.delete('pick');
  for (const key of drop) next.delete(key);
  const s = next.toString();
  return s ? `?${s}` : '';
}

/** Old host-detail tabs that became Overview cards → the id of the card to scroll to. */
export function legacyHostTabAnchor(tab: string | null): 'host-firewall' | 'host-runtime' | null {
  if (tab === 'firewall') return 'host-firewall';
  if (tab === 'runtime' || tab === 'security') return 'host-runtime';
  return null;
}
