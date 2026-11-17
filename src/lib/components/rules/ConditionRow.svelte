<!--
  ConditionRow: one editable condition (field, operator, value, NOT, case,
  transforms) for Match & act rules and tuning scopes. Parents render rows in
  a keyed #each on `cond.id` so removing a row never shifts another row's
  state.
-->
<script lang="ts">
  import Icon from 'svelte-awesome/components/Icon.svelte';
  import trash from 'svelte-awesome/icons/trash';
  import Select from '#lib/components/ui/Select.svelte';
  import {
    ALL_FIELDS,
    FIELD_GROUPS,
    OPERATORS,
    TRANSFORM_GROUPS,
    isKnownOperator,
    type ConditionRowModel,
  } from './registry';

  interface Props {
    cond: ConditionRowModel;
    onremove: () => void;
    /** Human position of the row ("1", "2", …) for accessible names. */
    rowId: string;
  }

  let { cond = $bindable(), onremove, rowId }: Props = $props();

  const uid = $props.id();
  let fxOpen = $state(false);
  let rowEl: HTMLElement | null = $state(null);

  const fieldDef = $derived(ALL_FIELDS[cond.fieldType]);
  const knownOperator = $derived(isKnownOperator(cond.operator));

  const BODY_SCOPES = [
    { value: 'all', label: 'Keys and values' },
    { value: 'key', label: 'Keys' },
    { value: 'value', label: 'Values' },
  ];
  // A stored field or operator this editor does not know stays selectable under "Other fields" so saving keeps it.
  const fieldOptions = $derived([
    ...FIELD_GROUPS.flatMap((g) => g.fields.map((f) => ({ value: f.value, label: f.label, group: g.label }))),
    ...(fieldDef ? [] : [{ value: cond.fieldType, label: cond.fieldType, group: 'Other fields' }]),
  ]);
  const operatorOptions = $derived([
    ...OPERATORS.map((op) => ({ value: op.value, label: op.label })),
    ...(knownOperator ? [] : [{ value: cond.operator, label: cond.operator, group: 'Other fields' }]),
  ]);

  function toggleTransform(t: string) {
    cond.transforms = cond.transforms.includes(t) ? cond.transforms.filter((x) => x !== t) : [...cond.transforms, t];
  }

  function onWindowClick(e: MouseEvent) {
    if (fxOpen && rowEl && !rowEl.contains(e.target as Node)) fxOpen = false;
  }
</script>

<svelte:window onclick={onWindowClick} />

<!-- Grid columns MUST stay in sync with .cr-cond-head in CustomRuleModal.svelte -->
<div class="crow" bind:this={rowEl} role="group" aria-label={`Condition ${rowId}`}>
  <div class="crow-cell">
    <Select class="crow-select" size="sm" options={fieldOptions} bind:value={cond.fieldType} aria-label={`Condition ${rowId} field`} />
    {#if fieldDef?.needsName}
      <div class="crow-nested" class:with-scope={fieldDef.jsonScope}>
        <input
          type="text"
          class="crow-input crow-small"
          placeholder={fieldDef.placeholder ?? ''}
          bind:value={cond.name}
          aria-label={`Condition ${rowId} ${fieldDef.label.toLowerCase()} name`}
        />
        {#if fieldDef.jsonScope}
          <Select
            class="crow-select"
            size="sm"
            options={BODY_SCOPES}
            bind:value={cond.bodyScope}
            aria-label={`Condition ${rowId} JSON match scope`}
            title="Which part of the JSON node to match"
          />
        {/if}
      </div>
    {/if}
  </div>

  <div class="crow-oprow">
    <Select class="crow-opselect" size="sm" options={operatorOptions} bind:value={cond.operator} aria-label={`Condition ${rowId} operator`} />
    <button
      type="button"
      class="crow-tgl"
      class:is-negated={cond.negate}
      onclick={() => (cond.negate = !cond.negate)}
      aria-pressed={cond.negate}
      aria-label={`Condition ${rowId}: negate (NOT)`}
      title={cond.negate ? 'NOT: the condition matches when the test is false' : 'Negate this condition (NOT)'}
    >
      NOT
    </button>
    <button
      type="button"
      class="crow-tgl"
      onclick={() => (cond.caseSensitive = !cond.caseSensitive)}
      aria-pressed={cond.caseSensitive}
      aria-label={`Condition ${rowId}: case-sensitive`}
      title={cond.caseSensitive ? 'Case-sensitive comparison' : 'Case-insensitive comparison (default)'}
    >
      Aa
    </button>
    <button
      type="button"
      class="crow-tgl"
      class:has-value={cond.transforms.length > 0}
      onclick={() => (fxOpen = !fxOpen)}
      aria-expanded={fxOpen}
      aria-controls="{uid}-fx"
      aria-label={`Condition ${rowId}: transforms${cond.transforms.length ? ` (${cond.transforms.length})` : ''}`}
      title="Text transforms applied before matching"
    >
      ƒx{cond.transforms.length > 0 ? ` ${cond.transforms.length}` : ''}
    </button>
  </div>

  <div class="crow-cell">
    <input
      type="text"
      class="crow-input"
      placeholder={cond.operator === 'exists' ? 'Not used by "exists"' : 'Value to match'}
      bind:value={cond.value}
      aria-label={`Condition ${rowId} value`}
    />
    {#if cond.transforms.length > 0}
      <ol class="crow-chips" aria-label={`Condition ${rowId} transforms, applied in order`}>
        {#each cond.transforms as t (t)}
          <li class="crow-chip">
            {t}
            <button type="button" class="crow-chip-x" aria-label={`Remove transform ${t}`} onclick={() => toggleTransform(t)}>×</button>
          </li>
        {/each}
      </ol>
    {/if}
  </div>

  <button type="button" class="crow-del" title="Remove condition" aria-label={`Remove condition ${rowId}`} onclick={onremove}>
    <Icon data={trash} scale={0.85} aria-hidden="true" />
  </button>

  {#if fxOpen}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      id="{uid}-fx"
      class="crow-fx-pop"
      role="group"
      aria-label={`Condition ${rowId} transforms`}
      onkeydown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          fxOpen = false;
        }
      }}
    >
      <div class="crow-fx-head">
        <strong>Transforms</strong>
        <span>applied in the order you tick them</span>
      </div>
      {#each TRANSFORM_GROUPS as g (g.label)}
        <fieldset class="crow-fx-group">
          <legend>{g.label}</legend>
          <div class="crow-fx-items">
            {#each g.transforms as t (t.value)}
              <label class="crow-fx-item">
                <input type="checkbox" checked={cond.transforms.includes(t.value)} onchange={() => toggleTransform(t.value)} />
                <span>{t.label}</span>
              </label>
            {/each}
          </div>
        </fieldset>
      {/each}
    </div>
  {/if}
</div>

<style>
  .crow {
    position: relative;
    display: grid;
    grid-template-columns: minmax(0, 1.2fr) minmax(0, 1.5fr) minmax(0, 1.75fr) 34px;
    gap: var(--sp-2);
    align-items: start;
    padding: var(--sp-2) var(--sp-3);
    background: var(--surface-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
  }
  .crow:focus-within { border-color: var(--border-strong); }

  .crow-cell { display: flex; flex-direction: column; gap: var(--sp-1); min-width: 0; }

  .crow-input {
    width: 100%;
    box-sizing: border-box;
    height: 34px;
    padding: 0 var(--sp-2);
    background: var(--bg-card);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    color: var(--text-primary);
    font-size: var(--fs-base);
  }
  .crow-cell :global(.crow-select) { width: 100%; }
  .crow-small { height: 30px; font-size: var(--fs-sm); }
  .crow-nested { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--sp-1); }
  .crow-nested.with-scope { grid-template-columns: minmax(0, 1fr) minmax(0, 0.9fr); }

  .crow-oprow { display: flex; align-items: center; gap: var(--sp-1); min-width: 0; }
  .crow-oprow :global(.crow-opselect) { flex: 1; min-width: 0; }

  .crow-tgl {
    height: 34px;
    min-width: 34px;
    padding: 0 var(--sp-1);
    flex-shrink: 0;
    background: var(--bg-card);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    color: var(--text-secondary);
    font-size: var(--fs-xs);
    font-weight: var(--fw-semibold);
    cursor: pointer;
    white-space: nowrap;
  }
  .crow-tgl:hover { color: var(--text-primary); }
  .crow-tgl[aria-pressed='true'],
  .crow-tgl.has-value,
  .crow-tgl[aria-expanded='true'] { background: var(--accent-soft); border-color: var(--accent); color: var(--text-primary); }
  .crow-tgl.is-negated { background: var(--warning-tint); border-color: var(--warning); }

  .crow-fx-pop {
    position: absolute;
    top: calc(100% + var(--sp-1));
    right: var(--sp-3);
    width: min(380px, calc(100% - 2 * var(--sp-3)));
    max-height: 300px;
    overflow-y: auto;
    z-index: 40;
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    padding: var(--sp-3);
    background: var(--bg-elevated);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-lg);
  }
  .crow-fx-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--sp-2); padding-bottom: var(--sp-2); border-bottom: 1px solid var(--border); }
  .crow-fx-head strong { font-size: var(--fs-sm); color: var(--text-primary); }
  .crow-fx-head span { font-size: var(--fs-xs); color: var(--text-muted); }
  .crow-fx-group { border: 0; margin: 0; padding: 0; min-width: 0; }
  .crow-fx-group legend { padding: 0 0 var(--sp-1); font-size: var(--fs-sm); font-weight: var(--fw-semibold); color: var(--text-muted); }
  .crow-fx-items { display: grid; grid-template-columns: 1fr 1fr; gap: 2px var(--sp-2); }
  .crow-fx-item { display: flex; align-items: center; gap: var(--sp-1); padding: 2px var(--sp-1); font-size: var(--fs-xs); color: var(--text-secondary); cursor: pointer; border-radius: var(--radius); }
  .crow-fx-item:hover { background: var(--bg-hover); color: var(--text-primary); }
  .crow-fx-item input { accent-color: var(--accent); margin: 0; }

  .crow-chips { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: var(--sp-1); counter-reset: fx; }
  .crow-chip {
    counter-increment: fx;
    display: inline-flex;
    align-items: center;
    gap: var(--sp-1);
    padding-left: var(--sp-2);
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    color: var(--text-primary);
  }
  .crow-chip::before { content: counter(fx) '.'; color: var(--text-muted); }
  .crow-chip-x { width: 22px; height: 22px; padding: 0; background: none; border: 0; color: var(--text-secondary); cursor: pointer; font-size: var(--fs-md); line-height: 1; border-radius: var(--radius); }
  .crow-chip-x:hover { color: var(--danger); }

  .crow-del {
    width: 34px;
    height: 34px;
    display: grid;
    place-items: center;
    background: var(--bg-card);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    color: var(--text-secondary);
    cursor: pointer;
  }
  .crow-del:hover { color: var(--danger); border-color: var(--danger); }

  @media (max-width: 860px) {
    .crow { grid-template-columns: 1fr; }
    .crow-del { width: 100%; }
    .crow-fx-pop { width: calc(100% - 2 * var(--sp-3)); }
  }
</style>
