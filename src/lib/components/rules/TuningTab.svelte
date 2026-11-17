<!--
  TuningTab: the Engine tuning editor of a custom rule: "Apply when" scope
  conditions and the effect. The skip list and the log-only choice are the same
  controls the path-rule tuning uses, so both editors mean the same thing.
-->
<script lang="ts">
  import Icon from 'svelte-awesome/components/Icon.svelte';
  import plus from 'svelte-awesome/icons/plus';
  import Button from '#lib/components/ui/Button.svelte';
  import ConditionRow from './ConditionRow.svelte';
  import SemanticEngineToggles from './SemanticEngineToggles.svelte';
  import Switch from '#lib/components/ui/Switch.svelte';
  import SegmentedRadio from './SegmentedRadio.svelte';
  import Alert from '#lib/components/ui/Alert.svelte';
  import Select from '#lib/components/ui/Select.svelte';
  import { emptyConditionRow, LOG_ONLY_HINT, LOG_ONLY_LABEL, type TuningFormState } from './registry';
  import { tuningTurnsInspectionOff } from './rule-risk';
  import { TUNING_INSPECTION_OFF_TEXT } from '#lib/inspection.js';

  interface Props {
    tuning: TuningFormState;
  }

  let { tuning = $bindable() }: Props = $props();

  const uid = $props.id();

  const LOGIC: { value: 'and' | 'or'; label: string }[] = [
    { value: 'and', label: 'All match (AND)' },
    { value: 'or', label: 'Any matches (OR)' },
  ];

  const SCAN_MODES: { value: TuningFormState['scanMode']; label: string }[] = [
    { value: 'default', label: 'Default (no change)' },
    { value: 'both', label: 'Inspect fully (clear skips)' },
    { value: 'disabled', label: 'Inspection off for matched requests' },
  ];

  // The effect leaves the matching requests without inspection: it skips every engine, or the scan mode is disabled.
  const inspectionOff = $derived(
    tuningTurnsInspectionOff({
      scope: { logic: 'and', conditions: [] },
      target: { components: [], match: 'exact' },
      effect: { skip_semantic: tuning.skipSemantic, scan_mode: tuning.scanMode },
    }),
  );

  function addScopeCondition() {
    tuning.scopeConditions = [...tuning.scopeConditions, emptyConditionRow()];
  }

  function removeScopeCondition(id: string) {
    tuning.scopeConditions = tuning.scopeConditions.filter((c) => c.id !== id);
  }
</script>

<div class="tt">
  <section class="tt-card" aria-labelledby="{uid}-scope">
    <header class="tt-head">
      <h3 class="tt-title" id="{uid}-scope">Apply when</h3>
      <SegmentedRadio options={LOGIC} bind:value={tuning.scopeLogic} label="Scope condition logic" size="sm" />
      <Button variant="secondary" size="sm" onclick={addScopeCondition}>
        <Icon data={plus} scale={0.75} aria-hidden="true" /> Add condition
      </Button>
    </header>
    {#if tuning.scopeConditions.length === 0}
      <p class="tt-empty">Add at least one condition: tuning only applies to the requests it describes.</p>
    {:else}
      <div class="tt-rows">
        {#each tuning.scopeConditions as cond, i (cond.id)}
          <ConditionRow bind:cond={tuning.scopeConditions[i]} rowId={`${i + 1}`} onremove={() => removeScopeCondition(cond.id)} />
        {/each}
      </div>
    {/if}
  </section>

  <section class="tt-card" aria-labelledby="{uid}-effect">
    <header class="tt-head">
      <h3 class="tt-title" id="{uid}-effect">Effect</h3>
      <span class="tt-note">At least one effect is required.</span>
    </header>
    {#if inspectionOff}<Alert tone="warning" compact message={TUNING_INSPECTION_OFF_TEXT} />{/if}
    <SemanticEngineToggles bind:value={tuning.skipSemantic} />
    <div class="tt-field">
      <label for="{uid}-scan">Scan mode</label>
      <Select id="{uid}-scan" options={SCAN_MODES} bind:value={tuning.scanMode} aria-describedby="{uid}-scan-hint" />
      <span class="tt-note" id="{uid}-scan-hint">When several tuning rules match, the first one with a scan mode (by priority) sets it.</span>
    </div>
    <Switch bind:checked={tuning.logOnly} label={LOG_ONLY_LABEL} hint={LOG_ONLY_HINT} />
  </section>
</div>

<style>
  .tt { display: flex; flex-direction: column; gap: var(--sp-3); min-width: 0; }
  .tt-card {
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
    padding: var(--sp-3) var(--sp-4) var(--sp-4);
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    min-width: 0;
  }
  .tt-head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2) var(--sp-3); }
  .tt-head :global(.btn) { margin-left: auto; }
  .tt-title { margin: 0; font-size: var(--fs-sm); font-weight: var(--fw-semibold); color: var(--text-primary); }
  .tt-note, .tt-empty { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.5; }
  .tt-empty { padding: var(--sp-3); border: 1px dashed var(--border-strong); border-radius: var(--radius); }
  .tt-rows { display: flex; flex-direction: column; gap: var(--sp-2); }
  .tt-field { display: flex; flex-direction: column; gap: var(--sp-1); max-width: 340px; }
  .tt-field label { font-size: var(--fs-sm); font-weight: var(--fw-semibold); color: var(--text-primary); }
  @media (max-width: 760px) {
    .tt-field { max-width: none; }
  }
</style>
