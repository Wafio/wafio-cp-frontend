<!--
  EngineSensitivity: one level per engine that weighs evidence (Relaxed, Balanced, Strict), closed by default. A level
  is a pair of evidence values (block and soft); the pairs stay editable as numbers in a second disclosure, and a pair
  that is none of the three levels shows as Custom. An empty number field is the default, shown as its placeholder.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import Icon from 'svelte-awesome/components/Icon.svelte';
  import chevronRight from 'svelte-awesome/icons/chevronRight';
  import Button from '#lib/components/ui/Button.svelte';
  import SegmentedRadio from '../rules/SegmentedRadio.svelte';
  import DecimalInput from './DecimalInput.svelte';
  import { SENSITIVITY_ENGINES, SENSITIVITY_LEVELS, customSensitivityCount, resetSensitivity, sensitivityLevelOf, sensitivityValues, type SemanticEngineMeta, type SensitivityLevel } from './model';
  import { fieldId } from './validate';
  import type { WafPolicyForm } from './waf-policy-form.svelte';

  let { form, readonly = false }: { form: WafPolicyForm; readonly?: boolean } = $props();

  let open = $state(false);
  let valuesOpen = $state(false);
  // The error summary asks to show a field inside this section; the fields are the numbers.
  $effect(() => {
    const reveal = form.reveal;
    if (reveal?.section === 'protection' && reveal.group === 'sensitivity') untrack(() => ((open = true), (valuesOpen = true)));
  });

  // 'custom' is a state, not a choice: no option carries it, so none is checked.
  const LEVEL_OPTIONS: { value: SensitivityLevel | 'custom'; label: string }[] = SENSITIVITY_LEVELS.map((l) => ({ value: l.value, label: l.label }));

  function setLevel(meta: SemanticEngineMeta, level: string) {
    if (level === 'custom') return;
    const values = sensitivityValues(meta, level as SensitivityLevel);
    form.draft.semantic[meta.key].block = values.block;
    form.draft.semantic[meta.key].soft = values.soft;
  }

  const custom = $derived(customSensitivityCount(form.draft));
  const problems = $derived(form.visibleIssues.filter((issue) => issue.section === 'protection' && issue.group === 'sensitivity').length);
  const describe = (path: string) => (form.error(path) ? `${fieldId(path)}-error` : undefined);
</script>

<button type="button" class="wp-disclosure" aria-expanded={open} aria-controls="wp-engine-sensitivity" onclick={() => (open = !open)}>
  <span class="wp-chevron" aria-hidden="true"><Icon data={chevronRight} scale={0.75} /></span>
  Engine sensitivity
  <span class="wp-disclosure-meta">
    {#if problems > 0}{problems} {problems === 1 ? 'problem' : 'problems'}, {/if}{custom === 0 ? 'all Balanced' : `${custom} ${custom === 1 ? 'engine' : 'engines'} changed`}
  </span>
</button>
<div id="wp-engine-sensitivity" class="wp-disclosure-body wp-sensitivity" hidden={!open}>
  <p class="wp-note">
    Twelve engines weigh evidence before they report an attack. Strict reports on less evidence and raises false alarms (about three times as many in our tests); Relaxed asks for more and misses some attacks.
    Balanced is the default. The other eight engines have no level: they take Block, Log only or Off in the table above.
  </p>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div class="wp-table-wrap" role="region" aria-label="Engine sensitivity" tabindex="0">
    <table class="wp-table">
      <thead>
        <tr>
          <th scope="col">Engine</th>
          <th scope="col">Sensitivity</th>
        </tr>
      </thead>
      <tbody>
        {#each SENSITIVITY_ENGINES as meta (meta.key)}
          {@const s = form.draft.semantic[meta.key]}
          {@const level = sensitivityLevelOf(meta, s.block, s.soft)}
          <tr>
            <th scope="row">{meta.label}</th>
            <td>
              <SegmentedRadio
                equal
                label="{meta.label} sensitivity"
                options={LEVEL_OPTIONS}
                bind:value={() => level, (chosen) => setLevel(meta, chosen)}
                disabled={readonly}
              />
              {#if level === 'custom'}<span class="wp-custom" id="wp-sensitivity-{meta.key}-custom">Custom: block {s.block ?? meta.defaultBlock}, soft {s.soft ?? meta.defaultSoft}</span>{/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  <button type="button" class="wp-disclosure" aria-expanded={valuesOpen} aria-controls="wp-engine-evidence" onclick={() => (valuesOpen = !valuesOpen)}>
    <span class="wp-chevron" aria-hidden="true"><Icon data={chevronRight} scale={0.75} /></span>
    Evidence values (advanced)
  </button>
  <div id="wp-engine-evidence" class="wp-disclosure-body wp-sensitivity" hidden={!valuesOpen}>
    <p class="wp-note">
      The numbers behind a level: the evidence an engine's parser needs for a blocking detection (block) and for a weak one (soft).
      A lower value reports more from the parsed text and can raise false alarms; a higher value reports less and can miss attacks.
      The fast pattern checks run first and ignore them. A pair that is none of the three levels shows as Custom.
    </p>
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div class="wp-table-wrap" role="region" aria-label="Evidence values" tabindex="0">
      <table class="wp-table">
        <thead>
          <tr>
            <th scope="col">Engine</th>
            <th scope="col">Evidence to block</th>
            <th scope="col">Evidence to log</th>
          </tr>
        </thead>
        <tbody>
          {#each SENSITIVITY_ENGINES as meta (meta.key)}
            {@const s = form.draft.semantic[meta.key]}
            <tr>
              <th scope="row">{meta.label}</th>
              {#each ['block', 'soft'] as const as prop (prop)}
                {@const path = `semantic.${meta.key}.${prop}`}
                <td>
                  <DecimalInput
                    id={fieldId(path)}
                    bind:value={s[prop]}
                    disabled={readonly}
                    placeholder={String(prop === 'block' ? meta.defaultBlock : meta.defaultSoft)}
                    aria-label="{meta.label} {prop} value"
                    aria-invalid={form.error(path) ? 'true' : undefined}
                    aria-describedby={describe(path)}
                  />
                  {#if form.error(path)}<span class="wp-cell-error" id="{fieldId(path)}-error">{form.error(path)}</span>{/if}
                </td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </div>
  <div class="wp-row">
    <Button variant="secondary" size="sm" disabled={readonly || custom === 0} onclick={() => resetSensitivity(form.draft)}>Reset all to Balanced</Button>
  </div>
</div>

<style>
  .wp-sensitivity { display: flex; flex-direction: column; gap: var(--sp-3); }
  .wp-sensitivity[hidden] { display: none; }
  .wp-custom { display: block; margin-top: var(--sp-1); font-size: var(--fs-xs); color: var(--text-muted); }
</style>
