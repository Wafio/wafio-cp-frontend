<!--
  ProtectionSection (shown as "Detection"): enforcement first (Monitor / Block, which lives on the application
  route), then the detection engines and their sensitivity, whether weak detections are recorded, and the inspection
  options.
-->
<script lang="ts">
  import Icon from 'svelte-awesome/components/Icon.svelte';
  import chevronRight from 'svelte-awesome/icons/chevronRight';
  import Alert from '#lib/components/ui/Alert.svelte';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Switch from '#lib/components/ui/Switch.svelte';
  import { modeTone } from '#lib/tone.js';
  import PolicySection from './PolicySection.svelte';
  import InspectionOptions from './InspectionOptions.svelte';
  import EngineTable from './EngineTable.svelte';
  import { policyInspectionOffAlert } from '#lib/inspection.js';
  import { fieldId } from './validate';
  import type { WafPolicyForm } from './waf-policy-form.svelte';

  type EnforcementMode = 'block' | 'monitor';

  let {
    form,
    readonly = false,
    enforcementMode = null,
    onEnforcementChange = undefined,
    enforcementBusy = false
  }: {
    form: WafPolicyForm;
    readonly?: boolean;
    /** Mode of the application route (null on the project defaults page). */
    enforcementMode?: EnforcementMode | null;
    /** Page handler that confirms and saves a mode change; omit for read-only display. */
    onEnforcementChange?: (mode: EnforcementMode) => void;
    enforcementBusy?: boolean;
  } = $props();

  let inspectionOpen = $state(false);

  const d = $derived(form.draft);

  const MODES: { value: EnforcementMode; label: string; description: string }[] = [
    { value: 'monitor', label: 'Monitor', description: 'Requests an engine would block are logged and forwarded. Use while tuning.' },
    { value: 'block', label: 'Block', description: 'Requests an engine blocks are rejected with 403.' }
  ];
</script>

<PolicySection id="protection" title="Detection" description="What the engines look for, and whether the application blocks or only logs what they find." {form}>
  <div class="wp-preset">
    <div class="wp-enforcement" role="group" aria-labelledby="wp-enforcement-label">
      <span class="wp-enforcement-label" id="wp-enforcement-label">Enforcement</span>
      {#if enforcementMode && onEnforcementChange}
        <div class="wp-mode-buttons">
          {#each MODES as mode (mode.value)}
            <button
              type="button"
              class="wp-mode"
              class:is-active={enforcementMode === mode.value}
              aria-pressed={enforcementMode === mode.value}
              disabled={readonly || enforcementBusy}
              onclick={() => { if (enforcementMode !== mode.value) onEnforcementChange?.(mode.value); }}
            >
              <span class="wp-mode-title">{mode.label}</span>
              <span class="wp-mode-desc">{mode.description}</span>
            </button>
          {/each}
        </div>
        <p class="wp-note wp-muted">Changing the mode applies immediately to this application's route; it is not part of the policy draft.</p>
      {:else if enforcementMode}
        <p class="wp-note"><Badge tone={modeTone(enforcementMode)}>{enforcementMode === 'block' ? 'Block' : 'Monitor'}</Badge> mode of this application; change it on the application's Assignment tab.</p>
      {:else}
        <p class="wp-note">Monitor or Block is chosen per application when it is routed through a WAF agent. These defaults are what every application inherits.</p>
      {/if}
    </div>
  </div>

  {#if d.engines.inspectionOff}
    <Alert tone="warning" compact>
      {policyInspectionOffAlert(form.engineScope)} Change this under Inspection below.
    </Alert>
  {/if}

  <EngineTable {form} {readonly} />

  <div class="wp-weak">
    <Switch
      id={fieldId('engines.recordWeakDetections')}
      label="Record weak detections"
      hint="Requests with a weaker sign of an attack are let through and recorded as LOG. Off: they are let through and recorded as a plain allowed request, without the detection."
      disabled={readonly}
      bind:checked={d.engines.recordWeakDetections}
    />
  </div>

  <button
    type="button"
    class="wp-disclosure wp-inspection-toggle"
    aria-expanded={inspectionOpen}
    aria-controls="wp-inspection-options"
    onclick={() => (inspectionOpen = !inspectionOpen)}
  >
    <span class="wp-chevron" aria-hidden="true"><Icon data={chevronRight} scale={0.75} /></span>
    Inspection
    <span class="wp-disclosure-meta">{d.engines.inspectionOff ? 'inspection is off' : 'inspection is on'}</span>
  </button>
  <div id="wp-inspection-options" class="wp-disclosure-body" hidden={!inspectionOpen}>
    {#if inspectionOpen}<InspectionOptions {form} {readonly} />{/if}
  </div>
</PolicySection>

<style>
  .wp-preset { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--sp-5); align-items: start; }
  .wp-enforcement { display: flex; flex-direction: column; gap: var(--sp-2); min-width: 0; }
  .wp-enforcement-label { font-size: var(--fs-sm); font-weight: var(--fw-medium); color: var(--text-secondary); }
  .wp-mode-buttons { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--sp-2); }
  .wp-mode {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--sp-1);
    padding: var(--sp-3);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    background: var(--bg-secondary);
    color: var(--text-primary);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .wp-mode:hover:not(:disabled) { background: var(--bg-hover); }
  .wp-mode:focus-visible { outline: var(--ring-width) solid var(--ring-color); outline-offset: 2px; }
  .wp-mode:disabled { cursor: not-allowed; opacity: 0.6; }
  .wp-mode.is-active { border-color: var(--accent); background: var(--accent-soft); box-shadow: inset 0 0 0 1px var(--accent); }
  .wp-mode-title { font-weight: var(--fw-semibold); font-size: var(--fs-base); }
  .wp-mode-desc { font-size: var(--fs-sm); color: var(--text-muted); line-height: 1.45; }
  .wp-weak { margin-top: var(--sp-4); }
  .wp-inspection-toggle { margin-top: var(--sp-4); }
</style>
