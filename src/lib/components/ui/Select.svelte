<!--
  Select: the dropdown of the dashboard, in place of a native <select>. A button opens a list of options; a list longer
  than eight options gets a search box. The list opens in the top layer (popover), so a table, a scroll box or a modal
  dialog does not clip it, and it is placed under the button, or above it when there is no room below.

    <Select options={[{ value: 'a', label: 'A' }]} bind:value={choice} aria-label="Choice" />

    <Field label="Role">
      {#snippet children(control)}<Select {...control} options={roles} bind:value={role} />{/snippet}
    </Field>

  Keyboard, as the WAI-ARIA select-only combobox: Enter, Space or Arrow Down open the list; arrows, Home, End and
  Page Up/Down move; Enter picks; Escape and Tab close; typing a letter jumps to an option (or searches, when the
  list has a search box). `onchange` runs only when the user picks a different value.
-->
<script lang="ts" generics="T extends string | number">
  import { tick } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';
  import { SEARCH_THRESHOLD, filterOptions, moveActive, orderByGroup, typeAhead, type SelectOption } from './select';

  type Props = Omit<HTMLButtonAttributes, 'value' | 'onchange' | 'class' | 'type' | 'role'> & {
    options: readonly SelectOption<T>[];
    value: T;
    /** Shown when the value matches no option. */
    placeholder?: string;
    /** true or false forces the search box; 'auto' shows it for more than eight options. */
    searchable?: boolean | 'auto';
    /** Classes on the outer element, for width and placement. */
    class?: string;
    size?: 'sm' | 'md';
    disabled?: boolean;
    onchange?: (value: T) => void;
  };

  let {
    options,
    value = $bindable(),
    placeholder = 'Select…',
    searchable = 'auto',
    class: className = '',
    size = 'md',
    disabled = false,
    onchange,
    id,
    ...rest
  }: Props = $props();

  const uid = $props.id();
  const triggerId = $derived(id ?? `${uid}-select`);
  const listId = `${uid}-list`;
  const optionId = (i: number) => `${uid}-opt-${i}`;

  let open = $state(false);
  let query = $state('');
  let active = $state(-1);
  let trigger: HTMLButtonElement | undefined = $state();
  let popup: HTMLDivElement | undefined = $state();
  let listEl: HTMLUListElement | undefined = $state();
  let searchEl: HTMLInputElement | undefined = $state();
  let place = $state({ top: 0, left: 0, width: 0, maxHeight: 320, above: false });
  let typed = '';
  let typedAt = 0;

  const ordered = $derived(orderByGroup(options));
  const withSearch = $derived(searchable === 'auto' ? options.length > SEARCH_THRESHOLD : searchable);
  const shown = $derived(withSearch ? filterOptions(ordered, query) : ordered);
  const selected = $derived(options.find((o) => o.value === value));
  const selectedIndex = $derived(shown.findIndex((o) => o.value === value));

  function position() {
    if (!trigger) return;
    const r = trigger.getBoundingClientRect();
    const gap = 4;
    const below = window.innerHeight - r.bottom - gap - 8;
    const aboveRoom = r.top - gap - 8;
    const wanted = 320;
    const above = below < Math.min(wanted, 200) && aboveRoom > below;
    const maxHeight = Math.max(120, Math.min(wanted, above ? aboveRoom : below));
    const width = Math.max(r.width, 160);
    const left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - width - 8));
    place = { top: above ? r.top - gap : r.bottom + gap, left, width, maxHeight, above };
  }

  async function show() {
    if (disabled || open) return;
    query = '';
    position();
    open = true;
    active = selectedIndex >= 0 ? selectedIndex : moveActive(shown, -1, 1);
    await tick();
    try {
      popup?.showPopover?.();
    } catch {
      // Without popover support the list is a fixed element with a high z-index; see the styles.
    }
    (withSearch ? searchEl : listEl)?.focus();
    scrollActive();
  }

  function hide(focusTrigger = true) {
    if (!open) return;
    open = false;
    try {
      popup?.hidePopover?.();
    } catch {
      // The popover was already closed.
    }
    if (focusTrigger) trigger?.focus();
  }

  function pick(i: number) {
    const o = shown[i];
    if (!o || o.disabled) return;
    const changed = o.value !== value;
    value = o.value;
    hide();
    if (changed) onchange?.(o.value);
  }

  function scrollActive() {
    if (active < 0) return;
    tick().then(() => document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' }));
  }

  function step(to: number) {
    if (to < 0) return;
    active = to;
    scrollActive();
  }

  function jump(key: string): number {
    const now = Date.now();
    typed = now - typedAt > 700 ? key : typed + key;
    typedAt = now;
    return typeAhead(shown, active, typed);
  }

  function onTriggerKey(e: KeyboardEvent) {
    if (disabled) return;
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
      e.preventDefault();
      show();
      return;
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (withSearch) {
        e.preventDefault();
        show().then(() => {
          query = e.key;
          active = moveActive(shown, -1, 1);
        });
        return;
      }
      // Closed and without a search box: a letter picks the next option that starts with it, as a native select does.
      const i = typeAhead(ordered, ordered.findIndex((o) => o.value === value), e.key);
      if (i >= 0 && ordered[i].value !== value) {
        value = ordered[i].value;
        onchange?.(ordered[i].value);
      }
    }
  }

  function onListKey(e: KeyboardEvent) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        step(moveActive(shown, active, 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        step(moveActive(shown, active, -1));
        break;
      case 'Home':
        if (e.currentTarget === searchEl) break;
        e.preventDefault();
        step(moveActive(shown, -1, 1));
        break;
      case 'End':
        if (e.currentTarget === searchEl) break;
        e.preventDefault();
        step(moveActive(shown, shown.length, -1));
        break;
      case 'PageDown':
        e.preventDefault();
        step(pageFrom(active, 1));
        break;
      case 'PageUp':
        e.preventDefault();
        step(pageFrom(active, -1));
        break;
      case 'Enter':
        e.preventDefault();
        pick(active);
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation(); // a modal dialog behind must not close as well
        hide();
        break;
      case 'Tab':
        hide(false);
        break;
      default:
        if (!withSearch && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const i = jump(e.key);
          if (i >= 0) step(i);
        }
    }
  }

  function pageFrom(from: number, dir: 1 | -1): number {
    let i = from;
    for (let k = 0; k < 8; k++) {
      const next = moveActive(shown, i, dir);
      if (next === i) break;
      i = next;
    }
    return i;
  }

  function onSearchInput() {
    active = moveActive(shown, -1, 1);
    scrollActive();
  }

  function onWindowPointer(e: PointerEvent) {
    if (!open) return;
    const t = e.target as Node;
    if (trigger?.contains(t) || popup?.contains(t)) return;
    hide(false);
  }

  function onReflow() {
    if (open) position();
  }

  // Indices of the first option of each group, for the group headings.
  const groupStarts = $derived(
    new Set(shown.map((o, i) => (o.group !== undefined && (i === 0 || shown[i - 1].group !== o.group) ? i : -1)).filter((i) => i >= 0))
  );
</script>

<svelte:window onpointerdown={onWindowPointer} onresize={onReflow} onscrollcapture={onReflow} />

<div class="sel sel-{size} {className}" class:is-open={open} class:is-disabled={disabled}>
  <button
    {...rest}
    bind:this={trigger}
    id={triggerId}
    type="button"
    role="combobox"
    class="sel-trigger"
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-controls={listId}
    {disabled}
    onclick={() => (open ? hide() : show())}
    onkeydown={onTriggerKey}
  >
    <span class="sel-value" class:sel-placeholder={!selected}>{selected ? selected.label : placeholder}</span>
    <svg class="sel-caret" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3.5 6l4.5 4.5L12.5 6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>
  </button>

  <div
    bind:this={popup}
    class="sel-popup"
    class:above={place.above}
    class:shown={open}
    popover="manual"
    style:top="{place.above ? 'auto' : `${place.top}px`}"
    style:bottom="{place.above ? `calc(100vh - ${place.top}px)` : 'auto'}"
    style:left="{place.left}px"
    style:min-width="{place.width}px"
    style:max-height="{place.maxHeight}px"
  >
    {#if open}
      {#if withSearch}
        <div class="sel-search">
          <input
            bind:this={searchEl}
            bind:value={query}
            type="text"
            role="combobox"
            aria-label="Search options"
            aria-controls={listId}
            aria-expanded="true"
            aria-autocomplete="list"
            aria-activedescendant={active >= 0 ? optionId(active) : undefined}
            autocomplete="off"
            spellcheck="false"
            placeholder="Search"
            oninput={onSearchInput}
            onkeydown={onListKey}
          />
        </div>
      {/if}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <ul
        bind:this={listEl}
        id={listId}
        role="listbox"
        tabindex={withSearch ? undefined : -1}
        aria-labelledby={triggerId}
        aria-activedescendant={!withSearch && active >= 0 ? optionId(active) : undefined}
        onkeydown={withSearch ? undefined : onListKey}
      >
        {#each shown as o, i (`${o.group ?? ''}\u0000${o.value}`)}
          {#if groupStarts.has(i)}<li class="sel-group" role="presentation">{o.group}</li>{/if}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <li
            id={optionId(i)}
            role="option"
            class="sel-option"
            class:active={i === active}
            class:in-group={o.group !== undefined}
            aria-selected={o.value === value}
            aria-disabled={o.disabled || undefined}
            onpointermove={() => !o.disabled && active !== i && (active = i)}
            onclick={(e) => {
              // A <label> around the Select must not turn this click into a click on the trigger, which would reopen the list.
              e.preventDefault();
              pick(i);
            }}
          >
            <span class="sel-option-text">
              <span>{o.label}</span>
              {#if o.description}<span class="sel-option-desc">{o.description}</span>{/if}
            </span>
            {#if o.value === value}<svg class="sel-check" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>{/if}
          </li>
        {:else}
          <li class="sel-empty" role="presentation">No match</li>
        {/each}
      </ul>
    {/if}
  </div>
</div>

<style>
  .sel { position: relative; display: inline-flex; min-width: 0; max-width: 100%; vertical-align: middle; }
  .sel-trigger {
    display: inline-flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-2);
    width: 100%;
    min-width: 0;
    min-height: 2.25rem;
    padding: 0 var(--sp-3);
    background: var(--surface-input);
    color: var(--text-primary);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    font: inherit;
    font-size: var(--fs-sm);
    text-align: left;
    cursor: pointer;
    transition: border-color 0.15s;
  }
  .sel-sm .sel-trigger { min-height: 1.875rem; padding: 0 var(--sp-2); font-size: var(--fs-xs); }
  .sel-trigger:hover:not(:disabled) { border-color: var(--text-muted); }
  .is-open .sel-trigger { border-color: var(--accent); }
  .sel-trigger:disabled { cursor: not-allowed; color: var(--text-muted); background: var(--bg-tertiary); border-color: var(--border); }
  .sel-trigger[aria-invalid='true'] { border-color: var(--danger); }
  .sel-value { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sel-placeholder { color: var(--text-muted); }
  .sel-caret { flex: none; color: var(--text-muted); transition: transform 0.15s; }
  .is-open .sel-caret { transform: rotate(180deg); }

  .sel-popup {
    position: fixed;
    inset: auto;
    margin: 0;
    padding: 0;
    box-sizing: border-box;
    max-width: min(28rem, calc(100vw - 16px));
    display: none;
    flex-direction: column;
    overflow: hidden;
    background: var(--bg-card, var(--bg-secondary));
    color: var(--text-primary);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    box-shadow: var(--shadow-md);
    z-index: 1000;
  }
  .sel-popup.shown { display: flex; }
  .sel-search { padding: var(--sp-2); border-bottom: 1px solid var(--border); }
  .sel-search input {
    width: 100%;
    box-sizing: border-box;
    padding: var(--sp-1) var(--sp-2);
    background: var(--surface-input);
    color: var(--text-primary);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    font: inherit;
    font-size: var(--fs-sm);
  }
  .sel-search input:focus-visible { outline: 2px solid var(--accent); outline-offset: 0; }
  ul { list-style: none; margin: 0; padding: var(--sp-1); overflow-y: auto; outline: none; }
  .sel-group { padding: var(--sp-2) var(--sp-2) var(--sp-1); font-size: var(--fs-xs); font-weight: var(--fw-semibold); color: var(--text-muted); }
  .sel-option {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-3);
    padding: var(--sp-2);
    border-radius: calc(var(--radius) - 1px);
    font-size: var(--fs-sm);
    cursor: pointer;
  }
  .sel-option.in-group { padding-left: var(--sp-3); }
  .sel-option.active { background: var(--bg-hover); }
  .sel-option[aria-selected='true'] { font-weight: var(--fw-semibold); }
  .sel-option[aria-disabled='true'] { color: var(--text-muted); cursor: not-allowed; }
  .sel-option-text { display: flex; flex-direction: column; min-width: 0; overflow-wrap: anywhere; }
  .sel-option-desc { font-size: var(--fs-xs); font-weight: 400; color: var(--text-muted); }
  .sel-check { flex: none; color: var(--accent); }
  .sel-empty { padding: var(--sp-2); font-size: var(--fs-sm); color: var(--text-muted); }
  @media (forced-colors: active) {
    .sel-option.active { outline: 2px solid Highlight; }
  }
</style>
