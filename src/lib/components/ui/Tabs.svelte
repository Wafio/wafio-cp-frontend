<!--
  Tabs: WAI-ARIA tablist with roving tabindex: one tab stop, Left/Right
  (wrapping), Home/End, disabled tabs skipped. `activation="auto"` selects on
  arrow keys; "manual" moves focus and selects on Enter/Space.

  URL sync without navigation inside the component: the page passes
  `onchange` and calls goto()/replaceState() itself, e.g. with
  `tabSearch(page.url.searchParams, 'tab', id, defaultTab)` from
  '#lib/components/ui/tabs.js'. Read the tab back with `readTabParam`.

  Panels: pass a `children` snippet (receives the active id) and Tabs renders
  one labelled tabpanel. Pages that keep their own panels set `id` and give
  their panel `id={tabDomIds(id, tab).panel}`, `role="tabpanel"` and
  `aria-labelledby={tabDomIds(id, tab).tab}`, plus `panels="external"`.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { nextTabId, resolveTabId, tabDomIds } from './tabs';
  import type { TabItem } from './types';

  let {
    tabs,
    value = $bindable(),
    onchange = undefined,
    label = undefined,
    labelledby = undefined,
    activation = 'auto',
    id = undefined,
    panels = 'internal',
    size = 'md',
    class: className = undefined,
    children = undefined,
    end = undefined
  }: {
    tabs: TabItem[];
    /** Selected tab id (bindable). Invalid or disabled ids fall back to the first enabled tab. */
    value?: string;
    /** Called with the new id after a user selection. */
    onchange?: (id: string) => void;
    /** Accessible name of the tablist (required unless `labelledby`). */
    label?: string;
    labelledby?: string;
    activation?: 'auto' | 'manual';
    /** Base id for tab/panel ids (default generated). */
    id?: string;
    /** `external` when the page renders its own tabpanels with tabDomIds(). */
    panels?: 'internal' | 'external';
    size?: 'sm' | 'md';
    class?: string;
    /** Panel content for the active tab. */
    children?: Snippet<[string]>;
    /** Content at the end of the tab bar, outside the tablist (e.g. a link). */
    end?: Snippet;
  } = $props();

  const uid = $props.id();
  const baseId = $derived(id ?? `${uid}-tabs`);
  const selected = $derived(resolveTabId(tabs, value));
  let focusedId = $state<string | undefined>();
  const stopId = $derived(activation === 'manual' ? resolveTabId(tabs, focusedId, selected) : selected);
  const hasPanel = $derived(Boolean(children) || panels === 'external');

  let tablistEl = $state<HTMLElement>();

  function select(tabId: string) {
    const tab = tabs.find((item) => item.id === tabId);
    if (!tab || tab.disabled) return;
    focusedId = tabId;
    if (tabId === selected) return;
    value = tabId;
    onchange?.(tabId);
  }

  function focusTab(tabId: string) {
    focusedId = tabId;
    const el = tablistEl?.querySelector<HTMLButtonElement>(`#${CSS.escape(tabDomIds(baseId, tabId).tab)}`);
    el?.focus();
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function onKeydown(event: KeyboardEvent) {
    const current = (event.target as HTMLElement | null)?.dataset?.tabId ?? stopId;
    const target = nextTabId(tabs, current, event.key);
    if (!target) return;
    event.preventDefault();
    focusTab(target);
    if (activation === 'auto') select(target);
  }
</script>

<div class={['ui-tabs', `size-${size}`, className]}>
  <div class="ui-tabs-bar">
    <div
      bind:this={tablistEl}
      class="ui-tablist"
      role="tablist"
      aria-label={labelledby ? undefined : label}
      aria-labelledby={labelledby}
      aria-orientation="horizontal"
      tabindex="-1"
      onkeydown={onKeydown}
    >
      {#each tabs as tab (tab.id)}
        {@const ids = tabDomIds(baseId, tab.id)}
        {@const isSelected = tab.id === selected}
        <button
          type="button"
          role="tab"
          id={ids.tab}
          class="ui-tab"
          class:active={isSelected}
          aria-selected={isSelected}
          aria-controls={hasPanel && isSelected ? ids.panel : undefined}
          tabindex={tab.id === stopId ? 0 : -1}
          disabled={tab.disabled}
          title={tab.title}
          data-tab-id={tab.id}
          onclick={() => select(tab.id)}
          onfocus={() => (focusedId = tab.id)}
        >
          <span class="ui-tab-label">{tab.label}</span>
          {#if tab.count !== undefined && tab.count !== null && tab.count !== ''}
            <span class="ui-tab-count">{tab.count}</span>
          {/if}
        </button>
      {/each}
    </div>
    {#if end}<div class="ui-tabs-end">{@render end()}</div>{/if}
  </div>

  {#if children && selected}
    {@const ids = tabDomIds(baseId, selected)}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div class="ui-tabpanel" role="tabpanel" id={ids.panel} aria-labelledby={ids.tab} tabindex="0">
      {@render children(selected)}
    </div>
  {/if}
</div>

<style>
  /* The tab list is pulled left by one tab padding so the first label lines
     up with the content edge; the active underline spans the label only. */
  .ui-tabs { min-width: 0; --tab-pad-x: var(--sp-3); }
  .ui-tabs-bar {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    border-bottom: 1px solid var(--border);
    margin-bottom: var(--sp-5);
    min-width: 0;
  }
  .ui-tablist {
    display: flex;
    flex: 1 1 auto;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: none;
    gap: var(--sp-1);
    margin-left: calc(-1 * var(--tab-pad-x));
  }
  .ui-tablist::-webkit-scrollbar { display: none; }
  .ui-tablist:focus { outline: none; }
  .ui-tab {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-2);
    flex-shrink: 0;
    position: relative;
    padding: var(--sp-2) var(--tab-pad-x);
    margin-bottom: -1px;
    border: 0;
    border-bottom: 2px solid transparent;
    border-radius: var(--radius) var(--radius) 0 0;
    background: none;
    color: var(--text-secondary);
    font-size: var(--fs-base);
    font-weight: var(--fw-medium);
    white-space: nowrap;
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s, background 0.15s;
  }
  .ui-tab:hover:not(:disabled) { color: var(--text-primary); background: var(--bg-hover); }
  .ui-tab:focus-visible { outline: var(--ring-width) solid var(--ring-color); outline-offset: -2px; }
  .ui-tab.active { color: var(--text-primary); }
  .ui-tab.active::after {
    content: '';
    position: absolute;
    left: var(--tab-pad-x);
    right: var(--tab-pad-x);
    bottom: -2px;
    height: 2px;
    background: var(--accent);
  }
  .ui-tab:disabled { opacity: 0.5; cursor: not-allowed; }
  .ui-tab-count {
    font-size: var(--fs-xs);
    font-variant-numeric: tabular-nums;
    color: var(--text-secondary);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    padding: 0 var(--sp-1);
    line-height: 1.5;
  }
  .size-sm { --tab-pad-x: var(--sp-2); }
  .size-sm .ui-tab { padding-block: var(--sp-1); font-size: var(--fs-sm); }
  .size-sm .ui-tabs-bar { margin-bottom: var(--sp-4); }
  .ui-tabs-end { flex-shrink: 0; display: flex; align-items: center; gap: var(--sp-2); }
  .ui-tabpanel { min-width: 0; }
  .ui-tabpanel:focus-visible { outline: var(--ring-width) solid var(--ring-color); outline-offset: 4px; border-radius: var(--radius); }
</style>
