<!--
  EngineTable: one row per detection engine with its name, what it finds and what it does (the choices come from
  engineOptions). The choice is the stored `semantic_policies.<key>.disabled` (Off) and `.action` (Log only). The
  thresholds are not here: they are under "Engine sensitivity".
-->
<script lang="ts">
  import Alert from '#lib/components/ui/Alert.svelte';
  import SegmentedRadio from '../rules/SegmentedRadio.svelte';
  import EngineSensitivity from './EngineSensitivity.svelte';
  import {
    SEMANTIC_ENGINES,
    engineActionOf,
    engineOffNote,
    engineOptions,
    ENGINE_LOG_ONLY_NOTE,
    enginesLogOnly,
    enginesLogOnlyLine,
    enginesOff,
    enginesOffLine,
    setEngineAction
  } from './model';
  import type { WafPolicyForm } from './waf-policy-form.svelte';

  let { form, readonly = false }: { form: WafPolicyForm; readonly?: boolean } = $props();

  const off = $derived(enginesOff(form.draft));
  const logOnly = $derived(enginesLogOnly(form.draft));
</script>

<div class="wp-block" id="wp-engines">
  <h4 class="wp-subhead">Detection engines</h4>
  {#if form.draft.engines.inspectionOff}<p class="wp-note wp-muted">Inspection is off, so these choices have no effect until it is on again.</p>{/if}
  {#if off.length > 0}
    <Alert tone="warning" compact>{enginesOffLine(off)}</Alert>
  {/if}
  {#if logOnly.length > 0}
    <Alert tone="info" compact>{enginesLogOnlyLine(logOnly)}</Alert>
  {/if}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div class="wp-table-wrap" role="region" aria-label="Detection engines" tabindex="0">
    <table class="wp-table wp-stack">
      <thead>
        <tr>
          <th scope="col">Engine</th>
          <th scope="col" class="wp-col-action">Action</th>
        </tr>
      </thead>
      <tbody>
        {#each SEMANTIC_ENGINES as meta (meta.key)}
          {@const s = form.draft.semantic[meta.key]}
          <tr class:is-off={!s.enabled}>
            <th scope="row" id="wp-engine-{meta.key}">
              <span class="wp-engine-name">{meta.label}</span>
              <span class="wp-engine-summary">{meta.summary}</span>
              {#if !s.enabled}<span class="wp-engine-off">{engineOffNote(meta)}</span>
              {:else if engineActionOf(meta.key, s) === 'log' && meta.key !== 'open_redirect'}<span class="wp-engine-summary">{ENGINE_LOG_ONLY_NOTE}</span>{/if}
            </th>
            <td class="wp-col-action">
              <SegmentedRadio
                size="lg"
                equal
                labelledby="wp-engine-{meta.key}"
                options={engineOptions(meta.key)}
                bind:value={() => engineActionOf(meta.key, s), (action) => setEngineAction(meta.key, s, action)}
                disabled={readonly}
              />
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  <p class="wp-note wp-muted">Request smuggling checks are always on. Invalid percent-encoding in a path is a route setting of the application.</p>
  <EngineSensitivity {form} {readonly} />
</div>

<style>
  .wp-block { display: flex; flex-direction: column; gap: var(--sp-3); min-width: 0; margin-top: var(--sp-4); }
  .wp-block :global(.wp-subhead) { margin: 0; padding: 0; border: 0; }
  .wp-col-action { width: 1%; white-space: nowrap; }
  .wp-engine-name { display: block; }
  .wp-engine-summary { display: block; margin-top: calc(var(--sp-1) / 2); font-size: var(--fs-xs); font-weight: 400; color: var(--text-muted); }
  .wp-engine-off { display: block; margin-top: calc(var(--sp-1) / 2); font-size: var(--fs-xs); font-weight: 400; color: var(--warning); }
</style>
