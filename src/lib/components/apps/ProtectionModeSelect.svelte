<!--
  ProtectionModeSelect: Block or Monitor for an application route, each
  with its consequence spelled out. The mode badge colours come from
  modeTone() (Block is never the ALLOW green). Lowering protection
  (Block → Monitor) is flagged here; the caller confirms it on save
  (tierForProtectionMode).
-->
<script lang="ts">
  import { Badge } from '#lib/components/ui/index.js';
  import { modeTone } from '#lib/tone.js';
  import { PROTECTION_MODE_TEXT, type ProtectionMode } from './route-model';

  let {
    value = $bindable<ProtectionMode>('block'),
    previous = undefined,
    disabled = false,
    legend = 'Protection mode',
    hint = undefined,
  }: {
    value?: ProtectionMode;
    /** Saved mode, to flag a change that lowers protection. */
    previous?: ProtectionMode;
    disabled?: boolean;
    legend?: string;
    hint?: string;
  } = $props();

  const uid = $props.id();
  const lowering = $derived(previous === 'block' && value === 'monitor');
  const modes: ProtectionMode[] = ['block', 'monitor'];
</script>

<fieldset class="mode-select" {disabled}>
  <legend>{legend}</legend>
  {#if hint}<p class="mode-hint">{hint}</p>{/if}
  <div class="mode-options">
    {#each modes as mode (mode)}
      <label class="mode-option" class:selected={value === mode}>
        <input type="radio" name={`${uid}-mode`} value={mode} bind:group={value} aria-describedby={`${uid}-${mode}-text`} />
        <span class="mode-body">
          <span class="mode-title"><Badge tone={modeTone(mode)}>{PROTECTION_MODE_TEXT[mode].label}</Badge>{#if previous === mode}<span class="mode-current">current</span>{/if}</span>
          <span class="mode-text" id={`${uid}-${mode}-text`}>{PROTECTION_MODE_TEXT[mode].consequence}</span>
        </span>
      </label>
    {/each}
  </div>
  {#if lowering}
    <p class="mode-lowering" role="note">Switching to Monitor lowers protection: attacks reach the application until you switch back. You will be asked to confirm.</p>
  {/if}
</fieldset>

<style>
  .mode-select { border: 0; padding: 0; margin: 0; min-width: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
  legend { padding: 0; font-size: var(--fs-sm); font-weight: var(--fw-medium); color: var(--text-secondary); }
  .mode-hint { margin: 0; font-size: var(--fs-sm); color: var(--text-muted); }
  .mode-options { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--sp-2); }
  .mode-option {
    display: flex;
    gap: var(--sp-2);
    align-items: flex-start;
    padding: var(--sp-3);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface-input);
    cursor: pointer;
  }
  .mode-option.selected { border-color: var(--accent); background: var(--accent-soft); }
  .mode-option input { margin-top: 3px; }
  .mode-select:disabled .mode-option { cursor: not-allowed; opacity: 0.7; }
  .mode-body { display: flex; flex-direction: column; gap: var(--sp-1); min-width: 0; }
  .mode-title { display: inline-flex; align-items: center; gap: var(--sp-2); }
  .mode-current { font-size: var(--fs-xs); color: var(--text-muted); }
  .mode-text { font-size: var(--fs-sm); color: var(--text-secondary); line-height: 1.45; }
  .mode-lowering { margin: 0; font-size: var(--fs-sm); color: var(--warning); line-height: 1.45; }
  @media (max-width: 640px) { .mode-options { grid-template-columns: minmax(0, 1fr); } }
</style>
