<!--
  ActionMenu: overflow ("…") menu for row and card actions: destructive
  actions leave the row and sit behind one more click; the dialog they open
  does the confirming. Disclosure pattern: a
  button with aria-expanded controls a list of buttons, Tab moves through
  them, Escape closes and returns focus to the trigger, and focus leaving the
  menu closes it.
-->
<script lang="ts" module>
  export interface ActionMenuItem {
    label: string;
    onselect: () => void;
    /** 'danger' colours the item text; the confirm dialog still carries the meaning. */
    tone?: 'default' | 'danger';
    disabled?: boolean;
    /** Why the item is disabled, or what it does. */
    hint?: string;
  }
</script>

<script lang="ts">
  let {
    label,
    items,
    align = 'end',
    class: className = undefined,
  }: {
    /** Accessible name of the trigger, e.g. "Actions for project Acme". */
    label: string;
    items: ActionMenuItem[];
    align?: 'start' | 'end';
    class?: string;
  } = $props();

  const uid = $props.id();
  const panelId = `${uid}-menu`;
  let open = $state(false);
  let root: HTMLElement | undefined = $state();
  let trigger: HTMLButtonElement | undefined = $state();

  function toggle() {
    open = !open;
    if (open) queueMicrotask(() => root?.querySelector<HTMLButtonElement>('.am-item:not(:disabled)')?.focus());
  }

  function choose(item: ActionMenuItem) {
    if (item.disabled) return;
    open = false;
    trigger?.focus();
    item.onselect();
  }

  function onkeydown(event: KeyboardEvent) {
    if (!open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      open = false;
      trigger?.focus();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const buttons = [...(root?.querySelectorAll<HTMLButtonElement>('.am-item:not(:disabled)') ?? [])];
      if (!buttons.length) return;
      event.preventDefault();
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'ArrowDown' ? (index + 1) % buttons.length : (index - 1 + buttons.length) % buttons.length;
      buttons[next].focus();
    }
  }

  function onfocusout(event: FocusEvent) {
    const next = event.relatedTarget as Node | null;
    if (open && (!next || !root?.contains(next))) open = false;
  }

  $effect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (root && !root.contains(event.target as Node)) open = false;
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  });
</script>

<div class={['am', className]} bind:this={root} {onfocusout}>
  <button
    type="button"
    class="am-trigger"
    bind:this={trigger}
    aria-label={label}
    aria-expanded={open}
    aria-controls={panelId}
    onclick={toggle}
    {onkeydown}
  ><span aria-hidden="true">⋯</span></button>
  {#if open}
    <ul class="am-panel" class:start={align === 'start'} id={panelId}>
      {#each items as item (item.label)}
        <li>
          <button
            type="button"
            class="am-item"
            class:danger={item.tone === 'danger'}
            disabled={item.disabled}
            title={item.hint}
            onclick={() => choose(item)}
            {onkeydown}
          >{item.label}</button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .am { position: relative; display: inline-flex; }
  .am-trigger {
    width: 32px;
    height: 32px;
    display: inline-grid;
    place-items: center;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    background: transparent;
    color: var(--text-secondary);
    font-size: var(--fs-md);
    line-height: 1;
    cursor: pointer;
  }
  .am-trigger:hover, .am-trigger[aria-expanded='true'] { background: var(--bg-hover); color: var(--text-primary); }
  .am-panel {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    z-index: 50;
    min-width: 11rem;
    margin: 0;
    padding: var(--sp-1) 0;
    list-style: none;
    background: var(--bg-elevated);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-lg);
  }
  .am-panel.start { right: auto; left: 0; }
  .am-item {
    display: block;
    width: 100%;
    padding: var(--sp-2) var(--sp-3);
    background: none;
    border: 0;
    text-align: left;
    color: var(--text-primary);
    font-size: var(--fs-sm);
    cursor: pointer;
    white-space: nowrap;
  }
  .am-item:hover:not(:disabled), .am-item:focus-visible { background: var(--bg-hover); }
  .am-item.danger { color: var(--danger); }
  .am-item:disabled { color: var(--text-muted); cursor: not-allowed; }
</style>
