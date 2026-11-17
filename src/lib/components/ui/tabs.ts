// Pure helpers for the Tabs primitive: roving focus and URL sync.
// The component never navigates; pages call goto()/replaceState() with the
// query string these helpers build.

import type { ReadonlyURLSearchParams } from '$app/state';

export interface TabLike {
  id: string;
  disabled?: boolean;
}

function enabled<T extends TabLike>(tabs: readonly T[]): T[] {
  return tabs.filter((tab) => !tab.disabled);
}

/**
 * The tab that should be selected: `value` when it names an enabled tab,
 * otherwise `fallback` when valid, otherwise the first enabled tab.
 */
export function resolveTabId(
  tabs: readonly TabLike[],
  value: string | null | undefined,
  fallback?: string,
): string | undefined {
  const usable = enabled(tabs);
  if (value && usable.some((tab) => tab.id === value)) return value;
  if (fallback && usable.some((tab) => tab.id === fallback)) return fallback;
  return usable[0]?.id;
}

/**
 * Target of a keyboard move in a horizontal tablist. ArrowRight/ArrowDown go
 * forward, ArrowLeft/ArrowUp go back (both wrap), Home/End jump to the ends.
 * Disabled tabs are skipped. Returns undefined for any other key.
 */
export function nextTabId(tabs: readonly TabLike[], currentId: string | undefined, key: string): string | undefined {
  const usable = enabled(tabs);
  if (usable.length === 0) return undefined;
  if (key === 'Home') return usable[0].id;
  if (key === 'End') return usable[usable.length - 1].id;
  const forward = key === 'ArrowRight' || key === 'ArrowDown';
  const backward = key === 'ArrowLeft' || key === 'ArrowUp';
  if (!forward && !backward) return undefined;
  const index = usable.findIndex((tab) => tab.id === currentId);
  if (index === -1) return forward ? usable[0].id : usable[usable.length - 1].id;
  const step = forward ? 1 : -1;
  return usable[(index + step + usable.length) % usable.length].id;
}

/** DOM ids for a tab and its panel under a common base id. */
export function tabDomIds(base: string, id: string): { tab: string; panel: string } {
  const safe = id.replace(/[^A-Za-z0-9_-]/g, '_');
  return { tab: `${base}-tab-${safe}`, panel: `${base}-panel-${safe}` };
}

function toParams(search: ReadonlyURLSearchParams | string): URLSearchParams {
  return new URLSearchParams(typeof search === 'string' ? search : search.toString());
}

/** Tab named by the `param` query parameter, validated against `tabs`. */
export function readTabParam(
  search: ReadonlyURLSearchParams | string,
  param: string,
  tabs: readonly TabLike[],
  fallback?: string,
): string | undefined {
  return resolveTabId(tabs, toParams(search).get(param), fallback);
}

/**
 * Query string (with leading `?`, or '' when empty) that selects `id` through
 * `param`, keeping every other parameter. The parameter is dropped when `id`
 * equals `defaultId`, so the default tab keeps a clean URL.
 */
export function tabSearch(
  search: ReadonlyURLSearchParams | string,
  param: string,
  id: string,
  defaultId?: string,
): string {
  const params = toParams(search);
  if (defaultId !== undefined && id === defaultId) params.delete(param);
  else params.set(param, id);
  const text = params.toString();
  return text ? `?${text}` : '';
}
