<!--
  Switch: a plain on/off setting. A button with role="switch", so Space and Enter work and the state is announced.
  The track shows the state by position, and the words On and Off beside it say it without colour. The label and
  the hint name the setting; the whole row is at least 44 px high. Use it for one setting that is either on or off.
  For a choice between more than two actions use a segmented control.

    <Switch bind:checked={form.draft.engines.scanAllHeaders} label="Scan all request headers" hint="On by default." />
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    checked = $bindable(false),
    label,
    hint = undefined,
    id = undefined,
    disabled = false,
    hideLabel = false,
    onchange = undefined,
    children = undefined
  }: {
    checked?: boolean;
    label: string;
    hint?: string;
    id?: string;
    disabled?: boolean;
    /** The label is read by assistive technology only (a switch in a table row whose row header names it). */
    hideLabel?: boolean;
    /** Called after the user flips the switch, with the new value. */
    onchange?: (checked: boolean) => void;
    /** Extra content after the hint (links, warnings). */
    children?: Snippet;
  } = $props();

  const uid = $props.id();
  const controlId = $derived(id ?? `${uid}-switch`);
  const hintId = $derived(`${controlId}-hint`);

  function flip() {
    if (disabled) return;
    checked = !checked;
    onchange?.(checked);
  }
</script>

<div class="sw" class:is-disabled={disabled}>
  {#if hideLabel}
    <label class="sr-only" for={controlId}>{label}</label>
  {:else}
    <div class="sw-text">
      <label for={controlId}>{label}</label>
      {#if hint}<p id={hintId}>{hint}</p>{/if}
      {@render children?.()}
    </div>
  {/if}
  <button
    type="button"
    role="switch"
    id={controlId}
    class="sw-control"
    aria-checked={checked}
    aria-describedby={hint && !hideLabel ? hintId : undefined}
    {disabled}
    onclick={flip}
  >
    <span class="sw-track" aria-hidden="true"><span class="sw-thumb"></span></span>
    <span class="sw-state">{checked ? 'On' : 'Off'}</span>
  </button>
</div>

<style>
  .sw { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--sp-4); min-width: 0; }
  .sw-text { min-width: 0; padding-top: var(--sp-3); }
  label { font-size: var(--fs-base); font-weight: var(--fw-medium); color: var(--text-primary); cursor: pointer; }
  p { margin: var(--sp-1) 0 0; font-size: var(--fs-sm); line-height: 1.5; color: var(--text-muted); }
  .sw-control {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: var(--sp-2);
    min-height: 44px;
    min-width: 44px;
    padding: 0 var(--sp-1);
    border: 0;
    border-radius: var(--radius);
    background: none;
    color: var(--text-secondary);
    font: inherit;
    font-size: var(--fs-sm);
    font-weight: var(--fw-medium);
    cursor: pointer;
  }
  .sw-control:focus-visible { outline: var(--ring-width) solid var(--ring-color); outline-offset: 2px; }
  .sw-track {
    position: relative;
    flex-shrink: 0;
    width: 36px;
    height: 20px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    background: var(--bg-tertiary);
  }
  .sw-thumb {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 14px;
    height: 14px;
    border-radius: calc(var(--radius) - 2px);
    background: var(--text-secondary);
  }
  .sw-state { min-width: 1.75rem; text-align: left; }
  [aria-checked='true'] .sw-track { border-color: var(--accent); background: var(--accent); }
  [aria-checked='true'] .sw-thumb { left: 18px; background: var(--text-on-accent); }
  .sw-control:disabled { cursor: not-allowed; opacity: 0.55; }
  .is-disabled label { cursor: not-allowed; color: var(--text-muted); }
  @media (prefers-reduced-motion: no-preference) {
    .sw-thumb { transition: left 0.12s; }
  }
</style>
