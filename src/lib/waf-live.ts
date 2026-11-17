/**
 * Live WAF data helpers shared by the application monitoring view, the
 * decision feed and the WAF agents inventory.
 *
 * Everything here is pure so it can be unit-tested under bun:
 * - the decision-feed filter and its URL form (the server applies it);
 * - the `/waf/stream` "agents" payload merged into the inventory.
 */

// ── Decision-feed filter ────────────────────────────────────────────────────

import type { ReadonlyURLSearchParams } from '$app/state';

export type FeedAction = '' | 'block' | 'log' | 'monitor' | 'allow';
export type FeedSource = '' | 'http' | 'ws';

export interface FeedFilter {
  action: FeedAction;
  source: FeedSource;
  /** Free-text search over IP, URI, host, user agent and match detail. */
  q: string;
  method: string;
  category: string;
  /** Exact client address (server `ip=`); '' = any. */
  ip: string;
}

export const EMPTY_FEED_FILTER: Readonly<FeedFilter> = Object.freeze({ action: '', source: '', q: '', method: '', category: '', ip: '' });

/** Longest `ip` value kept from a URL (the server caps it at 64). */
const MAX_IP = 64;

export const FEED_ACTIONS: readonly { value: FeedAction; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'block', label: 'Blocked' },
  { value: 'log', label: 'Logged' },
  { value: 'monitor', label: 'Monitor' },
  { value: 'allow', label: 'Allowed' },
];

export const FEED_SOURCES: readonly { value: FeedSource; label: string }[] = [
  { value: '', label: 'All sources' },
  { value: 'http', label: 'HTTP' },
  { value: 'ws', label: 'WebSocket' },
];

/** Handler limits (handlers/waf_agent.go AppDecisions). */
const MAX_Q = 256;
const MAX_CATEGORY = 64;
const METHOD_RE = /^[A-Z][A-Z0-9-]{0,15}$/;

function params(search: ReadonlyURLSearchParams | string): URLSearchParams {
  return new URLSearchParams(typeof search === 'string' ? search : search.toString());
}

/** Normalises a filter so the server accepts every field. */
export function normalizeFeedFilter(input: Partial<FeedFilter>): FeedFilter {
  const action = FEED_ACTIONS.some((a) => a.value === input.action) ? (input.action as FeedAction) : '';
  const source = FEED_SOURCES.some((s) => s.value === input.source) ? (input.source as FeedSource) : '';
  const q = (input.q ?? '').trim().slice(0, MAX_Q);
  const method = (input.method ?? '').trim().toUpperCase();
  const category = (input.category ?? '').trim().slice(0, MAX_CATEGORY);
  // The address is kept as typed (trimmed) so an invalid one is shown and
  // explained next to the field instead of silently dropped.
  const ip = (input.ip ?? '').trim().slice(0, MAX_IP);
  return { action, source, q, method: METHOD_RE.test(method) ? method : '', category, ip };
}

/** Filter from the page URL (`?action=&source=&q=&method=&category=&ip=`). */
export function readFeedFilter(search: ReadonlyURLSearchParams | string): FeedFilter {
  const p = params(search);
  return normalizeFeedFilter({
    action: (p.get('action') ?? '') as FeedAction,
    source: (p.get('source') ?? '') as FeedSource,
    q: p.get('q') ?? '',
    method: p.get('method') ?? '',
    category: p.get('category') ?? '',
    ip: p.get('ip') ?? '',
  });
}

/** Query string (leading `?`, or '') with the filter written over `search`. */
export function writeFeedFilter(search: ReadonlyURLSearchParams | string, filter: FeedFilter): string {
  const p = params(search);
  const f = normalizeFeedFilter(filter);
  for (const key of ['action', 'source', 'q', 'method', 'category', 'ip'] as const) {
    if (f[key]) p.set(key, f[key]);
    else p.delete(key);
  }
  const text = p.toString();
  return text ? `?${text}` : '';
}

export function feedFilterActive(f: FeedFilter): boolean {
  return Boolean(f.action || f.source || f.q || f.method || f.category || f.ip);
}

export function sameFeedFilter(a: FeedFilter, b: FeedFilter): boolean {
  return a.action === b.action && a.source === b.source && a.q === b.q && a.method === b.method && a.category === b.category && (a.ip ?? '') === (b.ip ?? '');
}

/**
 * A decision row belongs to the WebSocket relay when it carries the
 * WEBSOCKET method or a ws:* match source (the server's `source=ws` rule).
 */
export function isWSDecision(d: { method?: string; match_source?: string }): boolean {
  return d.method === 'WEBSOCKET' || (d.match_source ?? '').startsWith('ws:');
}

// ── WAF agent inventory stream (/waf/stream "agents") ─────────────────────

export interface WAFAgentStatus {
  id: string;
  name: string;
  last_seen: string | null;
  is_online: boolean;
}

/** Parses the "agents" event; null when the payload is not a list of agents. */
export function parseAgentStatusList(value: unknown): WAFAgentStatus[] | null {
  if (!Array.isArray(value)) return null;
  const out: WAFAgentStatus[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return null;
    const v = item as Record<string, unknown>;
    if (typeof v.id !== 'string') return null;
    out.push({
      id: v.id,
      name: typeof v.name === 'string' ? v.name : '',
      last_seen: typeof v.last_seen === 'string' ? v.last_seen : null,
      is_online: v.is_online === true,
    });
  }
  return out;
}

export interface AgentStatusMerge<T> {
  agents: T[];
  /** Agents the stream reports that the inventory does not have (reload). */
  added: string[];
  /** Inventory agents the stream no longer reports (deleted elsewhere). */
  removed: string[];
}

/**
 * Applies live `is_online`/`last_seen` to the inventory. The stream covers
 * every WAF agent of the project, so ids that appear or disappear mean the
 * inventory itself changed and should be reloaded.
 */
export function mergeAgentStatus<T extends { id: string; is_online: boolean; last_seen?: string | null }>(
  agents: readonly T[],
  statuses: readonly WAFAgentStatus[],
): AgentStatusMerge<T> {
  const byId = new Map(statuses.map((s) => [s.id, s]));
  const known = new Set(agents.map((a) => a.id));
  const merged = agents.map((agent) => {
    const live = byId.get(agent.id);
    if (!live) return agent;
    if (live.is_online === agent.is_online && (live.last_seen ?? null) === (agent.last_seen ?? null)) return agent;
    return { ...agent, is_online: live.is_online, last_seen: live.last_seen ?? undefined };
  });
  return {
    agents: merged,
    added: statuses.filter((s) => !known.has(s.id)).map((s) => s.id),
    removed: agents.filter((a) => !byId.has(a.id)).map((a) => a.id),
  };
}
