<!--
  TtlPicker: expiry chips for firewall rules: 15m / 1h / 24h /
  Permanent, plus Custom with an amount and unit so any expiry the API
  accepts stays reachable. A native radio group; the error is announced.
-->
<script lang="ts">
  import './controls.css';
  import Select from '#lib/components/ui/Select.svelte';
  import { TTL_OPTIONS, resolveTtl, type TtlKey, type TtlUnit } from './rules';

  let {
    value = $bindable<TtlKey>('permanent'),
    amount = $bindable<number | ''>(''),
    unit = $bindable<TtlUnit>('hours'),
    label = 'Expiry',
    disabled = false,
  }: {
    value?: TtlKey;
    amount?: number | '';
    unit?: TtlUnit;
    label?: string;
    disabled?: boolean;
  } = $props();

  const uid = $props.id();
  const UNIT_OPTIONS: { value: TtlUnit; label: string }[] = [
    { value: 'minutes', label: 'minutes' },
    { value: 'hours', label: 'hours' },
    { value: 'days', label: 'days' },
  ];
  const error = $derived(value === 'custom' ? resolveTtl('custom', { amount, unit }).error : null);
</script>

<fieldset class="ttl" {disabled}>
  <legend class="ttl-legend">{label}</legend>
  <div class="fw-row">
    <div class="fw-segmented">
      {#each TTL_OPTIONS as option (option.key)}
        <label title={option.longLabel}>
          <input type="radio" name={`${uid}-ttl`} value={option.key} bind:group={value} />
          <span aria-hidden="true">{option.label}</span>
          <span class="sr-only">{option.longLabel}</span>
        </label>
      {/each}
    </div>
    {#if value === 'custom'}
      <span class="fw-row ttl-custom">
        <label class="sr-only" for={`${uid}-amount`}>Expiry amount</label>
        <input
          id={`${uid}-amount`}
          class="fw-input ttl-amount"
          type="number"
          min="1"
          step="1"
          inputmode="numeric"
          bind:value={amount}
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={error ? `${uid}-error` : undefined}
        />
        <label class="sr-only" for={`${uid}-unit`}>Expiry unit</label>
        <Select id={`${uid}-unit`} class="ttl-unit" options={UNIT_OPTIONS} bind:value={unit} />
      </span>
    {/if}
  </div>
  {#if error}<p id={`${uid}-error`} class="ttl-error" role="alert">{error}</p>{/if}
</fieldset>

<style>
  .ttl { border: 0; margin: 0; padding: 0; min-width: 0; }
  .ttl-legend { padding: 0; margin-bottom: var(--sp-1); font-size: var(--fs-xs); font-weight: var(--fw-medium); color: var(--text-secondary); }
  .ttl-amount { width: 7rem; }
  .ttl-custom :global(.ttl-unit) { min-width: 7rem; }
  .ttl-error { margin: var(--sp-1) 0 0; font-size: var(--fs-xs); color: var(--danger); }
</style>
