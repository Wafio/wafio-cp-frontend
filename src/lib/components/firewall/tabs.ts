/**
 * Firewall page URL state: four URL tabs.
 *
 *   ?host=<id>&tab=overview|rules|live|settings&range=24h&type=port&view=events
 *
 * The page before the redesign had ten tabs that were not in the URL; their
 * names still resolve (tab=blocklist → Access rules filtered to the
 * blocklist, tab=config → Settings, tab=events → Live packet events) so old
 * bookmarks and links land on the same content.
 */
import { isAccessRuleFilter, type AccessRuleFilter } from './rules';
import type { ReadonlyURLSearchParams } from '$app/state';

export type FirewallTab = 'overview' | 'rules' | 'live' | 'settings';
export type LiveView = 'events' | 'connections' | 'bandwidth';

export const FIREWALL_TABS: ReadonlyArray<{ id: FirewallTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'rules', label: 'Access rules' },
  { id: 'live', label: 'Live' },
  { id: 'settings', label: 'Settings' },
];

export const DEFAULT_FIREWALL_TAB: FirewallTab = 'overview';

const LEGACY_TABS: Record<string, { tab: FirewallTab; type?: AccessRuleFilter; view?: LiveView }> = {
  config: { tab: 'settings' },
  configuration: { tab: 'settings' },
  blocklist: { tab: 'rules', type: 'block' },
  allowlist: { tab: 'rules', type: 'allow' },
  geo: { tab: 'rules', type: 'geo' },
  portpolicy: { tab: 'rules', type: 'port' },
  egress: { tab: 'rules', type: 'egress' },
  events: { tab: 'live', view: 'events' },
  connections: { tab: 'live', view: 'connections' },
  bandwidth: { tab: 'live', view: 'bandwidth' },
};

export interface FirewallUrlState {
  tab: FirewallTab;
  type: AccessRuleFilter;
  view: LiveView;
}

function isTab(value: string | null): value is FirewallTab {
  return FIREWALL_TABS.some((tab) => tab.id === value);
}

function isLiveView(value: string | null): value is LiveView {
  return value === 'events' || value === 'connections' || value === 'bandwidth';
}

/** Tab, rule-type filter and live view named by the query string. */
export function readFirewallUrl(search: ReadonlyURLSearchParams | string): FirewallUrlState {
  const params = new URLSearchParams(typeof search === 'string' ? search : search.toString());
  const rawTab = params.get('tab');
  const legacy = rawTab ? LEGACY_TABS[rawTab] : undefined;
  const tab: FirewallTab = legacy?.tab ?? (isTab(rawTab) ? rawTab : DEFAULT_FIREWALL_TAB);
  const rawType = params.get('type');
  const type: AccessRuleFilter = isAccessRuleFilter(rawType) ? rawType : legacy?.type ?? 'all';
  const rawView = params.get('view');
  const view: LiveView = isLiveView(rawView) ? rawView : legacy?.view ?? 'events';
  return { tab, type, view };
}

/**
 * Query string ('?…' or '') for a new state, keeping unrelated parameters
 * (host, range). Defaults are left out so the plain page keeps a clean URL.
 */
export function firewallSearch(search: ReadonlyURLSearchParams | string, next: Partial<FirewallUrlState>): string {
  const params = new URLSearchParams(typeof search === 'string' ? search : search.toString());
  const current = readFirewallUrl(params);
  const state = { ...current, ...next };
  if (state.tab === DEFAULT_FIREWALL_TAB) params.delete('tab');
  else params.set('tab', state.tab);
  if (state.type === 'all') params.delete('type');
  else params.set('type', state.type);
  if (state.view === 'events') params.delete('view');
  else params.set('view', state.view);
  const text = params.toString();
  return text ? `?${text}` : '';
}
