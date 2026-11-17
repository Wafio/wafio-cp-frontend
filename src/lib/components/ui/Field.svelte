<!--
  Field: label, control, hint and error wired together. The children
  snippet receives the attributes for the control (id, aria-describedby,
  aria-invalid, aria-required); spread them onto it:

    <Field label="Name" hint="Shown in the sidebar" error={nameError} required>
      {#snippet children(control)}
        <input {...control} bind:value={name} />
      {/snippet}
    </Field>

  With `group` it renders a fieldset/legend for radio and checkbox groups.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import InlineError from './InlineError.svelte';
  import type { FieldControl } from './types';

  let {
    label,
    hint = undefined,
    error = undefined,
    required = false,
    optional = false,
    id = undefined,
    hideLabel = false,
    group = false,
    layout = 'stacked',
    class: className = undefined,
    labelExtra = undefined,
    children
  }: {
    label: string;
    hint?: string;
    /** Error text; sets aria-invalid on the control and is announced. */
    error?: string | null;
    /** Marks the label and sets aria-required (validation stays with the page). */
    required?: boolean;
    /** Shows "(optional)" after the label. */
    optional?: boolean;
    /** Id of the control (default generated). */
    id?: string;
    /** Keep the label for assistive technology only. */
    hideLabel?: boolean;
    /** Render as fieldset + legend (radio/checkbox groups). */
    group?: boolean;
    /** `inline` puts label and control on one row (toggles, checkboxes). */
    layout?: 'stacked' | 'inline';
    class?: string;
    /** Extra content at the end of the label row (e.g. a "Learn more" link). */
    labelExtra?: Snippet;
    children: Snippet<[FieldControl]>;
  } = $props();

  const uid = $props.id();
  const controlId = $derived(id ?? `${uid}-control`);
  const hintId = $derived(`${controlId}-hint`);
  const errorId = $derived(`${controlId}-error`);
  const describedby = $derived([hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined);

  const control = $derived<FieldControl>({
    id: controlId,
    'aria-describedby': describedby,
    'aria-invalid': error ? 'true' : undefined,
    'aria-required': required ? 'true' : undefined
  });
</script>

{#snippet labelText()}
  {label}
  {#if required}<span class="field-required" aria-hidden="true">*</span>{/if}
  {#if optional}<span class="field-optional">(optional)</span>{/if}
{/snippet}

{#snippet messages()}
  {#if hint}<p class="field-hint" id={hintId}>{hint}</p>{/if}
  <InlineError id={errorId} message={error} />
{/snippet}

{#if group}
  <fieldset class={['ui-field', 'is-group', `layout-${layout}`, className]} aria-describedby={describedby}>
    <legend class={hideLabel ? 'sr-only' : 'field-label'}>{@render labelText()}</legend>
    {#if labelExtra}<div class="field-extra">{@render labelExtra()}</div>{/if}
    <div class="field-control">{@render children(control)}</div>
    {@render messages()}
  </fieldset>
{:else}
  <div class={['ui-field', `layout-${layout}`, className]}>
    <div class={['field-label-row', hideLabel && 'sr-only']}>
      <label class="field-label" for={controlId}>{@render labelText()}</label>
      {#if labelExtra}<div class="field-extra">{@render labelExtra()}</div>{/if}
    </div>
    <div class="field-control">{@render children(control)}</div>
    {@render messages()}
  </div>
{/if}

<style>
  .ui-field { display: flex; flex-direction: column; gap: var(--sp-1); min-width: 0; margin: 0; }
  fieldset.ui-field { border: 0; padding: 0; min-width: 0; }
  .field-label-row { display: flex; align-items: baseline; justify-content: space-between; gap: var(--sp-2); }
  .field-label { font-size: var(--fs-sm); font-weight: var(--fw-medium); color: var(--text-secondary); padding: 0; }
  .field-required { color: var(--danger); margin-left: 2px; }
  .field-optional { color: var(--text-muted); font-weight: 400; margin-left: var(--sp-1); }
  .field-extra { font-size: var(--fs-sm); }
  .field-control { min-width: 0; }
  .field-hint { margin: 0; font-size: var(--fs-sm); color: var(--text-muted); line-height: 1.45; }

  /* Controls get the shared input look unless the page styles them itself. */
  .field-control :global(:where(input:not([type='checkbox']):not([type='radio']), select, textarea)) {
    width: 100%;
    padding: var(--sp-2) var(--sp-3);
    background: var(--surface-input);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    color: var(--text-primary);
    font-size: var(--fs-base);
  }
  .field-control :global(:where(input, select, textarea):focus) { outline: none; border-color: var(--accent); box-shadow: var(--ring); }
  .field-control :global(:where(input, select, textarea):focus-visible) { outline: var(--ring-width) solid var(--ring-color); outline-offset: 1px; }
  .field-control :global(:where([aria-invalid='true'])) { border-color: var(--danger); }

  .layout-inline { flex-direction: row; flex-wrap: wrap; align-items: center; gap: var(--sp-2) var(--sp-3); }
  .layout-inline .field-control { order: -1; flex: 0 0 auto; }
  .layout-inline .field-hint,
  .layout-inline :global(.ui-inline-error) { flex-basis: 100%; }
</style>
