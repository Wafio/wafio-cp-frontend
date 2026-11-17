<!--
  ChoiceGroup: a native radio group (fieldset + legend) rendered as option
  cards. Arrow keys move between options as in any radio group. Use for
  modes with a short explanation per option (bot mode, challenge type).
-->
<script lang="ts" generics="T extends string | number | boolean">
  import type { Snippet } from 'svelte';

  interface Option {
    value: T;
    label: string;
    description?: string;
    disabled?: boolean;
  }

  let {
    value = $bindable(),
    options,
    legend,
    name,
    hint = undefined,
    error = undefined,
    disabled = false,
    columns = undefined,
    compact = false,
    onchange = undefined,
    legendExtra = undefined
  }: {
    value?: T;
    options: Option[];
    legend: string;
    name: string;
    hint?: string;
    error?: string;
    disabled?: boolean;
    /** Fixed column count on wide screens (default: auto-fit). */
    columns?: number;
    /** Label-only segments without descriptions. */
    compact?: boolean;
    onchange?: (value: T) => void;
    legendExtra?: Snippet;
  } = $props();

  const uid = $props.id();
  const hintId = `${uid}-hint`;
  const errorId = `${uid}-error`;
  const describedby = $derived([hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined);
</script>

<fieldset class="wp-choice" class:is-compact={compact} aria-describedby={describedby} {disabled}>
  <legend class="wp-choice-legend">{legend}{#if legendExtra} {@render legendExtra()}{/if}</legend>
  {#if hint}<p class="wp-choice-hint" id={hintId}>{hint}</p>{/if}
  <div class="wp-choice-options" style:--wp-choice-columns={columns}>
    {#each options as option (String(option.value))}
      <label class="wp-choice-option" class:is-checked={value === option.value} class:is-disabled={option.disabled}>
        <input
          type="radio"
          {name}
          value={option.value}
          checked={value === option.value}
          disabled={option.disabled}
          onchange={() => { value = option.value; onchange?.(option.value); }}
        />
        <span class="wp-choice-title">{option.label}</span>
        {#if option.description && !compact}<span class="wp-choice-desc">{option.description}</span>{/if}
      </label>
    {/each}
  </div>
  {#if error}<p class="wp-choice-error" id={errorId} role="alert">{error}</p>{/if}
</fieldset>

<style>
  .wp-choice { margin: 0; padding: 0; border: 0; min-width: 0; }
  .wp-choice-legend { padding: 0; margin-bottom: var(--sp-2); font-size: var(--fs-sm); font-weight: var(--fw-medium); color: var(--text-secondary); }
  .wp-choice-hint { margin: 0 0 var(--sp-2); font-size: var(--fs-sm); color: var(--text-muted); line-height: 1.5; }
  /* At most `columns` per row on wide screens; options wrap below 10rem each, so phones get one column. */
  .wp-choice-options {
    --wp-choice-gap: var(--sp-2);
    display: grid;
    grid-template-columns: repeat(
      auto-fit,
      minmax(max(min(10rem, 100%), calc((100% - (var(--wp-choice-columns, 6) - 1) * var(--wp-choice-gap)) / var(--wp-choice-columns, 6))), 1fr)
    );
    gap: var(--wp-choice-gap);
  }
  .is-compact .wp-choice-options { display: inline-flex; flex-wrap: wrap; gap: 0; border: 1px solid var(--border-strong); border-radius: var(--radius); overflow: hidden; }
  .wp-choice-option {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: var(--sp-1);
    padding: var(--sp-3);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    background: var(--bg-secondary);
    cursor: pointer;
    min-width: 0;
  }
  .is-compact .wp-choice-option { flex-direction: row; align-items: center; padding: var(--sp-2) var(--sp-3); border: 0; border-radius: 0; border-right: 1px solid var(--border-strong); }
  .is-compact .wp-choice-option:last-child { border-right: 0; }
  .wp-choice-option:hover { background: var(--bg-hover); }
  .wp-choice-option.is-checked { border-color: var(--accent); background: var(--accent-soft); box-shadow: inset 0 0 0 1px var(--accent); }
  .is-compact .wp-choice-option.is-checked { box-shadow: none; }
  .wp-choice-option.is-disabled { opacity: 0.55; cursor: not-allowed; }
  .wp-choice-option input { position: absolute; opacity: 0; width: 1px; height: 1px; margin: 0; }
  .wp-choice-option:has(input:focus-visible) { outline: var(--ring-width) solid var(--ring-color); outline-offset: 2px; z-index: 1; }
  .wp-choice-title { font-size: var(--fs-base); font-weight: var(--fw-semibold); color: var(--text-primary); }
  .wp-choice-title::before {
    content: '';
    display: inline-block;
    width: 0.7rem;
    height: 0.7rem;
    margin-right: var(--sp-2);
    border: 2px solid var(--border-strong);
    border-radius: 50%;
    vertical-align: -1px;
  }
  .is-checked .wp-choice-title::before { border-color: var(--accent); background: var(--accent); box-shadow: inset 0 0 0 2px var(--bg-secondary); }
  .wp-choice-desc { font-size: var(--fs-sm); color: var(--text-muted); line-height: 1.45; }
  .wp-choice-error { margin: var(--sp-2) 0 0; font-size: var(--fs-sm); color: var(--danger); }
  fieldset:disabled .wp-choice-option { cursor: not-allowed; opacity: 0.6; }
  fieldset:disabled .wp-choice-option.is-checked { opacity: 1; }
</style>
