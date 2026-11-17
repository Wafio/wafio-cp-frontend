<!--
  PathTuningSection: "Detection tuning" of a path rule in the WAF config
  (ConfigWafForm). Edits the per-path `tuning` object with the same shared
  controls as the custom Engine tuning editor (TuningTab): skip semantic
  engines, or log only. The effect always applies to the whole
  request. Path tuning has no scan mode: the path's inspection switch owns it.
-->
<script lang="ts">
  import SemanticEngineToggles from './SemanticEngineToggles.svelte';
  import Switch from '#lib/components/ui/Switch.svelte';
  import type { PathTuningForm } from '#lib/waf-config.js';
  import { LOG_ONLY_HINT, LOG_ONLY_LABEL } from './registry';

  interface Props {
    tuning: PathTuningForm;
    disabled?: boolean; // inspection is off for the path: tuning has no effect
  }

  let { tuning = $bindable(), disabled = false }: Props = $props();
</script>

<div class="pt">
  <div class="pt-body" class:is-off={disabled} inert={disabled || undefined}>
    <section class="pt-card">
      <SemanticEngineToggles bind:value={tuning.effect.skip_semantic} {disabled} />
    </section>

    <Switch bind:checked={tuning.effect.logOnly} {disabled} label={LOG_ONLY_LABEL} hint={LOG_ONLY_HINT} />
  </div>
</div>

<style>
  .pt { display: flex; flex-direction: column; gap: var(--sp-3); min-width: 0; }
  .pt-body { display: flex; flex-direction: column; gap: var(--sp-3); min-width: 0; }
  .is-off { opacity: 0.5; }
  .pt-card {
    padding: var(--sp-3) var(--sp-4);
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    min-width: 0;
  }
</style>
