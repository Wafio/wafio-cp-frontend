/**
 * Application page (/projects/:id/apps/:appId) tabs and URLs. The tab and its
 * filters live in the query string so alerts
 * and other pages can deep-link, and Back restores the previous tab.
 */
import type { TabItem } from '../ui/types';
import { parseTimeRange, type TimeRangeKey } from '../ui/time-range';
import type { ReadonlyURLSearchParams } from '$app/state';

export type AppTab = 'monitoring' | 'decisions' | 'config' | 'blockwindow' | 'maintenance' | 'gateway' | 'routing' | 'assignment';

export const APP_TAB_PARAM = 'tab';
export const DEFAULT_APP_TAB: AppTab = 'monitoring';

const TAB_LABELS: Record<AppTab, string> = {
  monitoring: 'Monitoring',
  decisions: 'Decisions',
  config: 'Config',
  blockwindow: 'Block window',
  maintenance: 'Maintenance',
  gateway: 'Gateway',
  routing: 'Routing',
  assignment: 'Assignment',
};

export const APP_TAB_ORDER: readonly AppTab[] = ['monitoring', 'decisions', 'config', 'blockwindow', 'maintenance', 'gateway', 'routing', 'assignment'];

/** Old tab ids (the former /waf/:agentId/:appId and /apps/:appId pages, and the links of mails that said https). */
const TAB_ALIASES: Record<string, AppTab> = {
  overview: 'monitoring',
  monitor: 'monitoring',
  'config-waf': 'config',
  waf: 'config',
  'block-window': 'blockwindow',
  block_window: 'blockwindow',
  events: 'decisions',
  https: 'gateway',
};

export function isAppTab(value: unknown): value is AppTab {
  return typeof value === 'string' && (APP_TAB_ORDER as readonly string[]).includes(value);
}

/** Tab id from a query value, accepting old ids; unknown → null. */
export function normalizeAppTab(value: string | null | undefined): AppTab | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (isAppTab(v)) return v;
  return TAB_ALIASES[v] ?? null;
}

/**
 * Tabs for the page. Config, Block window and Maintenance work through the
 * assigned WAF agent, so they are disabled (with the reason as tooltip) while
 * the application is unassigned. `maintenance` keeps the Maintenance tab open
 * without an agent: maintenance mode is on (it must stay reachable to turn it
 * off before an agent is assigned again), or was on during this visit. Gateway
 * is never disabled: the settings are stored with the application.
 */
export function appTabs(opts: { assigned: boolean; maintenance?: boolean }): TabItem[] {
  return APP_TAB_ORDER.map((id) => {
    const needsAgent = id === 'config' || id === 'blockwindow' || (id === 'maintenance' && !opts.maintenance);
    const disabled = needsAgent && !opts.assigned;
    return {
      id,
      label: TAB_LABELS[id],
      disabled,
      title: disabled ? 'Assign a WAF agent to this application first (Assignment tab).' : undefined,
    };
  });
}

/** Active tab from the query string; a disabled or unknown tab falls back to Monitoring. */
export function readAppTab(search: ReadonlyURLSearchParams | string, opts: { assigned: boolean; maintenance?: boolean }): AppTab {
  const params = new URLSearchParams(typeof search === 'string' ? search : search.toString());
  const tab = normalizeAppTab(params.get(APP_TAB_PARAM));
  if (!tab) return DEFAULT_APP_TAB;
  const item = appTabs(opts).find((t) => t.id === tab);
  return item && !item.disabled ? tab : DEFAULT_APP_TAB;
}

/** Query parameters that belong to one tab only; dropped when leaving it. */
const TAB_PARAMS: Partial<Record<AppTab, readonly string[]>> = {
  decisions: ['action', 'source', 'q', 'method', 'category', 'offset'],
};

/**
 * Query string selecting `tab`: keeps shared parameters (range, live) and
 * drops parameters owned by other tabs. Monitoring, the default, is not
 * written.
 */
export function appTabSearch(search: ReadonlyURLSearchParams | string, tab: AppTab): string {
  const params = new URLSearchParams(typeof search === 'string' ? search : search.toString());
  for (const [owner, keys] of Object.entries(TAB_PARAMS) as [AppTab, readonly string[]][]) {
    if (owner !== tab) for (const key of keys) params.delete(key);
  }
  if (tab === DEFAULT_APP_TAB) params.delete(APP_TAB_PARAM);
  else params.set(APP_TAB_PARAM, tab);
  const text = params.toString();
  return text ? `?${text}` : '';
}

export function appPath(base: string, projectId: string, appId: string): string {
  return `${base}/projects/${encodeURIComponent(projectId)}/apps/${encodeURIComponent(appId)}`;
}

export function appHref(base: string, projectId: string, appId: string, tab: AppTab = DEFAULT_APP_TAB, extra?: Record<string, string>): string {
  const params = new URLSearchParams(extra ?? {});
  const search = appTabSearch(params, tab);
  return `${appPath(base, projectId, appId)}${search}`;
}

/** Monitoring range from `?range=`; default 1h. "all" is not offered (retention is 30 days). */
export function readAppRange(search: ReadonlyURLSearchParams | string): TimeRangeKey {
  const params = new URLSearchParams(typeof search === 'string' ? search : search.toString());
  return parseTimeRange(params.get('range'), { includeAll: false });
}

/** Query string with the range written (1h, the default, is omitted). */
export function writeAppRange(search: ReadonlyURLSearchParams | string, range: TimeRangeKey): string {
  const params = new URLSearchParams(typeof search === 'string' ? search : search.toString());
  if (range === '1h') params.delete('range');
  else params.set('range', range);
  const text = params.toString();
  return text ? `?${text}` : '';
}
