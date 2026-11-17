<!--
  DurationInput: a timeout in milliseconds typed in ms / s / min, with an
  optional "Unlimited" switch. Value tri-state (domain/proxyconfig.go):
  0 = unset (the default applies; the input is empty), -1 = unlimited,
  >0 = milliseconds. Malformed input yields NaN so the form reports it.
  Spread Field's control attributes on it via `control`.
-->
<script lang="ts">
  import type { FieldControl } from '#lib/components/ui/index.js';
  import { formatDuration } from '#lib/format.js';
  import Select from '#lib/components/ui/Select.svelte';
  import { durationFromParts, durationParts, type DurationUnit } from './inputs';
  import { TIMEOUT_UNLIMITED } from './route-model';

  let {
    value = $bindable(0),
    control,
    defaultMs = undefined,
    allowUnlimited = false,
    unlimitedWarning = undefined,
    disabled = false,
    label,
  }: {
    value?: number;
    /** Attributes from Field (id, aria-describedby, aria-invalid, aria-required). */
    control: FieldControl;
    /** Default the agent applies when unset; shown as the placeholder. */
    defaultMs?: number;
    allowUnlimited?: boolean;
    /** Shown while Unlimited is on. */
    unlimitedWarning?: string;
    disabled?: boolean;
    /** Field label, used to name the unit select and the Unlimited checkbox. */
    label: string;
  } = $props();

  const UNITS: { value: DurationUnit; label: string }[] = [
    { value: 'ms', label: 'ms' },
    { value: 's', label: 's' },
    { value: 'min', label: 'min' },
  ];

  let amount = $state('');
  let unit = $state<DurationUnit>('s');
  // Last value this component emitted: an external change (reset, reload)
  // rewrites the text; the operator's own typing is left alone.
  let emitted: number | undefined;

  $effect.pre(() => {
    const next = value;
    if (Object.is(next, emitted)) return;
    emitted = next;
    if (next === TIMEOUT_UNLIMITED) return; // keep the last amount for when Unlimited is switched off
    if (Number.isNaN(next)) return;
    const parts = durationParts(next);
    amount = parts.amount;
    unit = parts.unit;
  });

  const unlimited = $derived(value === TIMEOUT_UNLIMITED);

  function emit(next: number) {
    emitted = next;
    value = next;
  }

  function onAmount(text: string) {
    amount = text;
    emit(durationFromParts(text, unit));
  }

  function onUnit(next: DurationUnit) {
    unit = next;
    if (!unlimited) emit(durationFromParts(amount, next));
  }

  function onUnlimited(on: boolean) {
    emit(on ? TIMEOUT_UNLIMITED : durationFromParts(amount, unit));
  }

  const placeholder = $derived(defaultMs ? `Default (${formatDuration(defaultMs, 'ms')})` : 'Default');
</script>

<div class="duration">
  <div class="duration-row">
    <input
      {...control}
      type="text"
      inputmode="decimal"
      autocomplete="off"
      value={amount}
      placeholder={placeholder}
      disabled={disabled || unlimited}
      oninput={(event) => onAmount(event.currentTarget.value)}
    />
    <Select
      class="duration-unit"
      aria-label={`${label} unit`}
      options={UNITS}
      value={unit}
      disabled={disabled || unlimited}
      onchange={onUnit}
    />
    {#if allowUnlimited}
      <label class="duration-unlimited">
        <input type="checkbox" checked={unlimited} {disabled} onchange={(event) => onUnlimited(event.currentTarget.checked)} />
        <span>Unlimited</span>
      </label>
    {/if}
  </div>
  {#if unlimited && unlimitedWarning}
    <p class="duration-warning" role="note">{unlimitedWarning}</p>
  {/if}
</div>

<style>
  .duration { display: flex; flex-direction: column; gap: var(--sp-1); min-width: 0; }
  .duration-row { display: flex; align-items: center; gap: var(--sp-2); min-width: 0; }
  .duration-row > input { flex: 1 1 6rem; min-width: 0; }
  .duration-row > input:disabled { opacity: 0.55; }
  .duration-row :global(.duration-unit) { flex: 0 0 auto; }
  .duration-unlimited {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-1);
    white-space: nowrap;
    font-size: var(--fs-sm);
    color: var(--text-secondary);
    cursor: pointer;
  }
  .duration-warning { margin: 0; font-size: var(--fs-xs); line-height: 1.45; color: var(--warning); }
</style>
