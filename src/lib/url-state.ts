// List state kept in the page URL (page number, search, filters, sort), so a
// reload, a shared link or Back returns to the same view. Pure helpers; pages
// navigate with `goto(pathname + querySearch(...), { replace: true,
// reset: false })` like tab changes (`tabs.ts`).

import type { ReadonlyURLSearchParams } from '$app/state';

type SearchLike = ReadonlyURLSearchParams | string;

function toParams(search: SearchLike): URLSearchParams {
  return new URLSearchParams(typeof search === 'string' ? search : search.toString());
}

/**
 * Query string (with leading `?`, or '' when empty) with `changes` applied to
 * `search`: null, undefined and '' remove the parameter, anything else sets it.
 * Every other parameter is kept.
 */
export function querySearch(search: SearchLike, changes: Record<string, string | number | boolean | null | undefined>): string {
  const params = toParams(search);
  for (const [key, value] of Object.entries(changes)) {
    if (value === null || value === undefined || value === '') params.delete(key);
    else params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

/** 1-based page number from `key` (default `page`); missing or invalid → 1. */
export function readPageParam(search: SearchLike, key = 'page'): number {
  const raw = toParams(search).get(key);
  if (!raw || !/^\d{1,6}$/.test(raw)) return 1;
  const n = Number(raw);
  return n >= 1 ? n : 1;
}

/** Offset of a 1-based page. */
export function pageOffset(page: number, limit: number): number {
  return Math.max(0, (Math.max(1, Math.floor(page)) - 1) * Math.max(1, limit));
}

/** URL value of the page that holds `offset`: null for the first page (clean URL). */
export function pageParamFor(offset: number, limit: number): string | null {
  const page = Math.floor(Math.max(0, offset) / Math.max(1, limit)) + 1;
  return page > 1 ? String(page) : null;
}

/** Value of `key` when it is one of `allowed`, else `fallback`. */
export function readChoiceParam<T extends string>(search: SearchLike, key: string, allowed: readonly T[], fallback: T): T {
  const raw = toParams(search).get(key);
  return raw !== null && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

/** Free text of `key` (search box), cut to `max` characters; missing → ''. */
export function readTextParam(search: SearchLike, key: string, max = 200): string {
  return (toParams(search).get(key) ?? '').slice(0, max);
}
