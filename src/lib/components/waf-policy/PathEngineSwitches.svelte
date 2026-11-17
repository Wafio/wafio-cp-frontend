<!--
  PathEngineSwitches: what one rule path does with each engine: follow the policy (Inherit), Block, Log only (Log for an
  engine that never blocks), or Off. The choices come from pathEngineOptions. Off is the path's stored
  `semantic_override.<key>.disabled: true`; Block and Log only are the same entry with `disabled: false` and `action`, which
  also starts an engine the policy has off. A skip in the path's detection tuning turns an engine off too, and wins.
-->
<script lang="ts">
  import Alert from '#lib/components/ui/Alert.svelte';
  import SegmentedRadio from '../rules/SegmentedRadio.svelte';
  import {
    ENGINE_LOG_ONLY_NOTE,
    LOG_ONLY_ENGINES,
    SEMANTIC_ENGINES,
    engineActionLabel,
    engineActionOf,
    engineStateOf,
    enginesLogOnlyLine,
    enginesOffLine,
    pathEnginesLogOnly,
    pathEnginesOff,
    pathEngineOptions,
    setEngineState,
    type EngineState,
    type PathRuleDraft,
    type PolicyDraft,
    type SemanticKey
  } from './model';

  let { rule, policy, readonly = false }: { rule: PathRuleDraft; policy: PolicyDraft; readonly?: boolean } = $props();

  const off = $derived(pathEnginesOff(rule));
  const offEngines = $derived(SEMANTIC_ENGINES.filter((meta) => off.includes(meta.key)));
  const logOnly = $derived(SEMANTIC_ENGINES.filter((meta) => pathEnginesLogOnly(rule).includes(meta.key)));
  const skipped = $derived(new Set(rule.tuning.effect.skip_semantic));

  function options(key: SemanticKey, state: EngineState) {
    // The choice that the policy already makes only means something against a policy that has the engine off: against
    // one that has it on, Inherit does the same, and values for the path are set on the Engine sensitivity tab.
    const same = engineActionOf(key, policy.semantic[key]);
    return pathEngineOptions(key).map((option) =>
      option.value === same && option.value !== 'off' && state !== option.value
        ? { ...option, disabled: true, title: `The policy already has this engine on: ${engineActionLabel(key, policy.semantic[key])}. Inherit does the same.` }
        : option
    );
  }
</script>

<div class="pe">
  <h4 class="wp-subhead">Detection engines on this path</h4>
  <p class="wp-note">Inherit follows the policy. Off stops an engine on this path only. Block and Log only set what an engine does on this path, and start an engine that the policy has off.</p>
  {#if offEngines.length > 0}
    <Alert tone="warning" compact>{enginesOffLine(offEngines, ' on this path')}</Alert>
  {/if}
  {#if logOnly.length > 0}
    <Alert tone="info" compact>{enginesLogOnlyLine(logOnly, ' on this path')}</Alert>
  {/if}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div class="wp-table-wrap" role="region" aria-label="Detection engines on this path" tabindex="0">
    <table class="wp-table wp-stack">
      <thead>
        <tr><th scope="col">Engine</th><th scope="col">In the policy</th><th scope="col" class="pe-col-action">On this path</th></tr>
      </thead>
      <tbody>
        {#each SEMANTIC_ENGINES as meta (meta.key)}
          {@const state = engineStateOf(rule, meta.key, policy)}
          <tr class:is-off={off.includes(meta.key)}>
            <th scope="row" id="pe-{meta.key}">
              <span class="pe-name">{meta.label}</span>
              <span class="pe-summary">{meta.summary}</span>
              {#if state === 'log' && !LOG_ONLY_ENGINES.includes(meta.key)}<span class="pe-summary">{ENGINE_LOG_ONLY_NOTE}</span>{/if}
              {#if skipped.has(meta.key)}<span class="pe-note">Also skipped under Detection tuning.</span>{/if}
            </th>
            <td data-label="In the policy">{engineActionLabel(meta.key, policy.semantic[meta.key])}</td>
            <td class="pe-col-action">
              <SegmentedRadio
                size="lg"
                equal
                labelledby="pe-{meta.key}"
                options={options(meta.key, state)}
                bind:value={() => engineStateOf(rule, meta.key, policy), (next) => setEngineState(rule, policy, meta.key, next)}
                disabled={readonly || rule.inspectionOff}
              />
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</div>

<style>
  .pe { display: flex; flex-direction: column; gap: var(--sp-3); min-width: 0; }
  .pe :global(.wp-subhead) { margin: 0; padding: 0; border: 0; }
  .pe-col-action { width: 1%; white-space: nowrap; }
  .pe-name { display: block; }
  .pe-summary { display: block; margin-top: calc(var(--sp-1) / 2); font-size: var(--fs-xs); font-weight: 400; color: var(--text-muted); }
  .pe-note { display: block; margin-top: calc(var(--sp-1) / 2); font-size: var(--fs-xs); font-weight: 400; color: var(--warning); }
</style>
