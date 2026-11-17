<!--
  SemanticEngineToggles: edits a skip_semantic list (custom tuning rules and
  path-rule tuning). Offers exactly the engine keys the server accepts; "All
  engines" (*) replaces the individual choices. Entries the server would
  reject (from older data) stay visible so they can be removed.
-->
<script lang="ts">
  import { SEMANTIC_ENGINES, semanticEngineError, semanticEngineLabel } from './registry';
  import { SKIP_ALL_ENGINES_TEXT } from '#lib/inspection.js';

  interface Props {
    value: string[];
    label?: string;
    disabled?: boolean;
  }

  let { value = $bindable(), label = 'Skip semantic engines', disabled = false }: Props = $props();

  const uid = $props.id();
  const all = $derived(value.includes('*'));
  const unknown = $derived(value.filter((v) => v !== '*' && semanticEngineError(v) !== null));

  function toggle(engine: string) {
    if (engine === '*') {
      value = all ? [] : ['*'];
      return;
    }
    const rest = value.filter((e) => e !== '*');
    value = rest.includes(engine) ? rest.filter((e) => e !== engine) : [...rest, engine];
  }

  function remove(entry: string) {
    value = value.filter((e) => e !== entry);
  }
</script>

<fieldset class="se" {disabled} aria-describedby="{uid}-hint">
  <legend class="se-label">{label}</legend>
  <p class="se-hint" id="{uid}-hint">
    {value.length === 0 ? 'Every semantic engine runs.' : all ? SKIP_ALL_ENGINES_TEXT : `${value.length} of ${SEMANTIC_ENGINES.length} engines skipped.`}
  </p>
  <div class="se-grid">
    <button type="button" class="se-toggle se-all" aria-pressed={all} onclick={() => toggle('*')}>All engines</button>
    {#each SEMANTIC_ENGINES as engine (engine)}
      <button
        type="button"
        class="se-toggle"
        aria-pressed={all || value.includes(engine)}
        disabled={all}
        title={engine}
        onclick={() => toggle(engine)}
      >
        {semanticEngineLabel(engine)}
      </button>
    {/each}
  </div>
  {#if unknown.length > 0}
    <ul class="se-unknown" aria-label="Entries the server does not accept">
      {#each unknown as entry (entry)}
        <li>
          <span>"{entry}" is not a skippable engine and blocks saving.</span>
          <button type="button" class="se-remove" onclick={() => remove(entry)}>Remove {entry}</button>
        </li>
      {/each}
    </ul>
  {/if}
</fieldset>

<style>
  .se { border: 0; margin: 0; padding: 0; min-width: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
  .se-label { padding: 0; font-size: var(--fs-sm); font-weight: var(--fw-semibold); color: var(--text-primary); }
  .se-hint { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.5; }
  .se-grid { display: flex; flex-wrap: wrap; gap: var(--sp-1); }
  .se-toggle {
    padding: var(--sp-1) var(--sp-2);
    background: var(--surface-input);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    color: var(--text-secondary);
    font-size: var(--fs-xs);
    cursor: pointer;
  }
  .se-toggle:hover:not(:disabled) { color: var(--text-primary); }
  .se-toggle[aria-pressed='true'] {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--text-primary);
    font-weight: var(--fw-medium);
  }
  .se-toggle:disabled { cursor: not-allowed; opacity: 0.7; }
  .se-all { font-weight: var(--fw-semibold); }
  .se-unknown { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-1); }
  .se-unknown li { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); font-size: var(--fs-xs); color: var(--danger); }
  .se-remove {
    padding: 2px var(--sp-2);
    background: none;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    color: var(--text-primary);
    font-size: var(--fs-xs);
    cursor: pointer;
  }
</style>
