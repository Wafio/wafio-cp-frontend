/**
 * Page metadata for the shell.
 *
 * The root layout owns the only `<title>`: "<page>, <project>, WAFio",
 * computed from the route ($lib/shell-nav). Pages do not write `<title>`;
 * they name the entity they show so the title and breadcrumbs carry it:
 *
 *   // routes/projects/[id]/hosts/[hostId]/+page.svelte
 *   import { usePageDetail } from '#lib/page-meta.svelte.js';
 *   usePageDetail(() => host?.name);                 // "web-01, Hosts, Acme, WAFio"
 *
 *   // waf/[agentId]/[appId]: one label per detail level
 *   usePageDetail(() => [agent?.name, route?.name]);
 *
 *   // a page that needs its own page part (error pages)
 *   usePageTitle(() => 'Page not found');
 *
 * Both helpers must be called during component initialisation; the value
 * follows the getter and is cleared when the component is destroyed.
 */
import { getContext, hasContext, setContext } from 'svelte';

const PAGE_META = Symbol('wafio.page-meta');

type Label = string | null | undefined;

export class PageMeta {
  /** Name of the project being shown; set by the project layout. */
  projectName = $state<string | null>(null);
  /** Entity names for the detail levels of the current route. */
  details = $state<(string | null)[]>([]);
  /** Replacement for the page part of the title. */
  title = $state<string | null>(null);

  #detailOwner: symbol | null = null;
  #titleOwner: symbol | null = null;

  setDetails(owner: symbol, labels: Label[]): void {
    this.#detailOwner = owner;
    this.details = labels.map((label) => (typeof label === 'string' && label.trim() ? label.trim() : null));
  }

  clearDetails(owner: symbol): void {
    // A page that mounted after this one already owns the value; keep it.
    if (this.#detailOwner !== owner) return;
    this.#detailOwner = null;
    this.details = [];
  }

  setTitle(owner: symbol, title: Label): void {
    this.#titleOwner = owner;
    this.title = typeof title === 'string' && title.trim() ? title.trim() : null;
  }

  clearTitle(owner: symbol): void {
    if (this.#titleOwner !== owner) return;
    this.#titleOwner = null;
    this.title = null;
  }
}

/** Creates the metadata store and provides it to the calling component's children (root layout). */
export function createPageMeta(): PageMeta {
  const meta = new PageMeta();
  setContext(PAGE_META, meta);
  return meta;
}

/** The metadata store of the root layout, or undefined outside it (tests, isolated components). */
export function tryGetPageMeta(): PageMeta | undefined {
  return hasContext(PAGE_META) ? getContext<PageMeta>(PAGE_META) : undefined;
}

/** Names the entity (or entities, one per detail level) the current page shows. */
export function usePageDetail(get: () => Label | Label[]): void {
  const meta = tryGetPageMeta();
  if (!meta) return;
  const owner = Symbol('page-detail');
  $effect(() => {
    const value = get();
    meta.setDetails(owner, Array.isArray(value) ? value : [value]);
  });
  $effect(() => () => meta.clearDetails(owner));
}

/** Replaces the page part of the document title while the calling component is mounted. */
export function usePageTitle(get: () => Label): void {
  const meta = tryGetPageMeta();
  if (!meta) return;
  const owner = Symbol('page-title');
  $effect(() => {
    meta.setTitle(owner, get());
  });
  $effect(() => () => meta.clearTitle(owner));
}
