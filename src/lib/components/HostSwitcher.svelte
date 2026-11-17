<!--
  HostSwitcher: the host control of a host-scoped page (Firewall, Runtime
  Security). A button shows the current host and its status; it opens a
  popover with a filter input (role="combobox") over a listbox of every host
  in the project (same loader and search as HostPicker).

  Keyboard: Enter / Space / ArrowDown on the button opens it with the current
  host active; in the input ArrowUp/ArrowDown/Home/End move the active
  option, Enter switches, Escape closes and returns focus to the button, Tab
  closes. Revoked hosts are listed but disabled and skipped.

  Switching replaces only `?host` (tab, range and filters stay; `?pick` and
  the page's host-specific `drop` keys go). "All hosts" opens the picker
  table (`?pick=1`).
-->
<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import Icon from 'svelte-awesome/components/Icon.svelte';
  import chevronDown from 'svelte-awesome/icons/chevronDown';
  import StatusDot from '#lib/components/ui/StatusDot.svelte';
  import Spinner from '#lib/components/ui/Spinner.svelte';
  import { listHosts, type Host } from '#lib/api.js';
  import { HOST_STATUS, fetchAllHosts, filterHosts, isPickable, sortHosts, switchHostSearch } from '#lib/host-nav.js';

  interface Props {
    projectId: string;
    hostId: string;
    /** Name shown until the host list has loaded. */
    hostName?: string;
    /** Query keys that belong to the old host and are dropped on a switch (e.g. `incident`). */
    drop?: readonly string[];
  }

  let { projectId, hostId, hostName = '', drop = [] }: Props = $props();

  const uid = `hs-${Math.random().toString(36).slice(2, 9)}`;
  const listboxId = `${uid}-list`;
  const inputId = `${uid}-input`;

  let hosts: Host[] = $state([]);
  let loading = $state(false);
  let loadedAt = 0;
  let error = $state('');
  let open = $state(false);
  let query = $state('');
  let activeIndex = $state(-1);
  let root: HTMLDivElement | undefined = $state();
  let button: HTMLButtonElement | undefined = $state();
  let input: HTMLInputElement | undefined = $state();

  const options = $derived(filterHosts(sortHosts(hosts), query));
  const current = $derived(hosts.find((h) => h.id === hostId) ?? null);
  const currentName = $derived(current?.name || hostName || (hostId ? `Host ${hostId.slice(0, 8)}` : 'Choose a host'));
  const currentStatus = $derived(current ? HOST_STATUS[current.status] : null);
  const optionId = (i: number) => `${uid}-opt-${i}`;

  async function load() {
    const id = projectId;
    loading = true;
    error = '';
    const res = await fetchAllHosts((p) => listHosts(id, p), () => id !== projectId);
    if (id !== projectId) return;
    loading = false;
    if (res.error) { error = res.error; return; }
    hosts = res.hosts ?? [];
    loadedAt = Date.now();
  }

  onMount(() => { void load(); });
  $effect(() => { projectId; untrack(() => { if (loadedAt) { hosts = []; loadedAt = 0; void load(); } }); });

  function firstPickable(from: number, step: 1 | -1): number {
    for (let i = from; i >= 0 && i < options.length; i += step) if (isPickable(options[i])) return i;
    return -1;
  }

  async function openList() {
    if (open) return;
    query = '';
    open = true;
    if (!loading && (!loadedAt || Date.now() - loadedAt > 60_000)) void load();
    const idx = options.findIndex((h) => h.id === hostId);
    activeIndex = idx >= 0 ? idx : firstPickable(0, 1);
    await tick();
    input?.focus();
    scrollActive();
  }

  function close(focusButton: boolean) {
    open = false;
    activeIndex = -1;
    if (focusButton) button?.focus();
  }

  function scrollActive() {
    if (activeIndex < 0) return;
    document.getElementById(optionId(activeIndex))?.scrollIntoView({ block: 'nearest' });
  }

  function move(next: number) {
    if (next < 0) return;
    activeIndex = next;
    void tick().then(scrollActive);
  }

  function choose(h: Host | undefined) {
    if (!h || !isPickable(h)) return;
    close(true);
    if (h.id === hostId) return;
    void goto(`${page.url.pathname}${switchHostSearch(page.url.searchParams, h.id, drop)}`, { reset: false });
  }

  function showAll() {
    const params = new URLSearchParams(page.url.search);
    params.delete('host');
    for (const key of drop) params.delete(key);
    params.set('pick', '1');
    close(false);
    void goto(`${page.url.pathname}?${params}`, { reset: false });
  }

  function onButtonKey(event: KeyboardEvent) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      void openList();
    }
  }

  function onInputKey(event: KeyboardEvent) {
    switch (event.key) {
      case 'ArrowDown': {
        event.preventDefault();
        const next = firstPickable(activeIndex + 1, 1);
        move(next >= 0 ? next : firstPickable(0, 1));
        break;
      }
      case 'ArrowUp': {
        event.preventDefault();
        const prev = activeIndex > 0 ? firstPickable(activeIndex - 1, -1) : -1;
        move(prev >= 0 ? prev : firstPickable(options.length - 1, -1));
        break;
      }
      case 'Home':
        if (event.ctrlKey || event.metaKey) { event.preventDefault(); move(firstPickable(0, 1)); }
        break;
      case 'End':
        if (event.ctrlKey || event.metaKey) { event.preventDefault(); move(firstPickable(options.length - 1, -1)); }
        break;
      case 'Enter':
        event.preventDefault();
        choose(options[activeIndex]);
        break;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        close(true);
        break;
      case 'Tab':
        close(false);
        break;
    }
  }

  function onQueryInput(event: Event & { currentTarget: HTMLInputElement }) {
    // Keep the active option on the first match while typing.
    query = event.currentTarget.value;
    activeIndex = firstPickable(0, 1);
  }

  // Close on a click or focus outside the switcher.
  $effect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (root && !root.contains(event.target as Node)) close(false);
    };
    const onFocus = (event: FocusEvent) => {
      if (root && event.target instanceof Node && !root.contains(event.target)) close(false);
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('focusin', onFocus);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('focusin', onFocus);
    };
  });
</script>

<div class="switcher" bind:this={root}>
  <button
    bind:this={button}
    type="button"
    class="trigger"
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-controls={open ? listboxId : undefined}
    aria-label={`Host: ${currentName}${currentStatus ? `, ${currentStatus.label}` : ''}. Switch host`}
    onclick={() => (open ? close(true) : void openList())}
    onkeydown={onButtonKey}
  >
    {#if currentStatus}<StatusDot status={currentStatus.dot} label={currentStatus.label} hideLabel />{/if}
    <span class="trigger-name">{currentName}</span>
    <span class="chev" aria-hidden="true"><Icon data={chevronDown} scale={0.7} /></span>
  </button>

  {#if open}
    <div class="popover">
      <label class="sr-only" for={inputId}>Find a host</label>
      <input
        bind:this={input}
        value={query}
        id={inputId}
        class="filter"
        type="text"
        role="combobox"
        placeholder="Find a host (name, status, OS, label)"
        autocomplete="off"
        spellcheck="false"
        aria-autocomplete="list"
        aria-expanded="true"
        aria-controls={listboxId}
        aria-activedescendant={activeIndex >= 0 && options[activeIndex] ? optionId(activeIndex) : undefined}
        oninput={onQueryInput}
        onkeydown={onInputKey}
      />
      <ul id={listboxId} class="options" role="listbox" aria-label="Hosts">
        {#each options as h, i (h.id)}
          {@const st = HOST_STATUS[h.status]}
          {@const disabled = !isPickable(h)}
          <!-- Options are chosen with the pointer here; the keyboard path is the combobox input (aria-activedescendant). -->
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <li
            id={optionId(i)}
            role="option"
            class="option"
            class:active={i === activeIndex}
            class:current={h.id === hostId}
            aria-selected={h.id === hostId}
            aria-disabled={disabled || undefined}
            onclick={() => choose(h)}
            onpointermove={() => { if (!disabled && activeIndex !== i) activeIndex = i; }}
          >
            <StatusDot status={st?.dot ?? 'unknown'} label={st?.label ?? h.status} hideLabel />
            <span class="opt-name">{h.name}</span>
            <span class="opt-meta">{disabled ? 'Revoked' : st?.label ?? h.status}</span>
          </li>
        {/each}
      </ul>
      <div class="pop-foot">
        {#if loading && !hosts.length}
          <Spinner size="sm" label="Loading hosts…" />
        {:else if error}
          <span class="pop-error" role="alert">Hosts did not load: {error} <button type="button" class="link" onclick={() => void load()}>Retry</button></span>
        {:else if !options.length}
          <span class="muted" role="status">No host matches “{query}”.</span>
        {:else}
          <span class="muted" role="status">{options.length} of {hosts.length} hosts</span>
        {/if}
        <button type="button" class="link" onclick={showAll}>All hosts</button>
      </div>
    </div>
  {/if}
</div>

<style>
  .switcher { position: relative; display: inline-block; min-width: 0; max-width: 100%; }
  .trigger {
    display: inline-flex; align-items: center; gap: var(--sp-2);
    max-width: 100%; min-height: 32px; padding: var(--sp-1) var(--sp-3);
    font: inherit; font-size: var(--fs-sm); font-weight: var(--fw-semibold); color: var(--text-primary);
    background: var(--bg-primary); border: 1px solid var(--border-strong); border-radius: var(--radius);
    cursor: pointer;
  }
  .trigger:hover { background: var(--bg-hover); }
  .trigger:focus-visible { outline: var(--ring-width) solid var(--ring-color); outline-offset: 2px; }
  .trigger-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chev { display: inline-flex; color: var(--text-muted); }
  .popover {
    position: absolute; z-index: 40; top: calc(100% + var(--sp-1)); left: 0;
    display: grid; gap: var(--sp-2);
    width: min(360px, calc(100vw - 2 * var(--sp-4)));
    padding: var(--sp-2);
    background: var(--bg-elevated); border: 1px solid var(--border-strong); border-radius: var(--radius-lg);
    box-shadow: var(--shadow-md);
  }
  .filter {
    width: 100%; box-sizing: border-box; padding: var(--sp-2) var(--sp-3);
    font: inherit; font-size: var(--fs-sm); color: var(--text-primary);
    background: var(--bg-primary); border: 1px solid var(--border-strong); border-radius: var(--radius);
  }
  .filter:focus-visible { outline: var(--ring-width) solid var(--ring-color); outline-offset: 1px; }
  .options { max-height: min(320px, 50vh); overflow-y: auto; margin: 0; padding: 0; list-style: none; }
  .option {
    display: flex; align-items: center; gap: var(--sp-2);
    padding: var(--sp-2); border-radius: var(--radius);
    font-size: var(--fs-sm); color: var(--text-primary); cursor: pointer;
  }
  .option.current .opt-name { font-weight: var(--fw-semibold); }
  .option.active { background: var(--accent-soft); outline: 1px solid var(--accent); outline-offset: -1px; }
  .option[aria-disabled='true'] { color: var(--text-muted); cursor: not-allowed; }
  .opt-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .opt-meta { flex: none; font-size: var(--fs-xs); color: var(--text-muted); }
  .pop-foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--sp-2); padding: var(--sp-1) var(--sp-1) 0; border-top: 1px solid var(--border); font-size: var(--fs-xs); }
  .muted { color: var(--text-muted); }
  .pop-error { color: var(--text-secondary); }
  .link { padding: 0; border: 0; background: none; font: inherit; color: var(--accent); cursor: pointer; }
  .link:hover { text-decoration: underline; }
  .link:focus-visible { outline: var(--ring-width) solid var(--ring-color); outline-offset: 2px; }
</style>
