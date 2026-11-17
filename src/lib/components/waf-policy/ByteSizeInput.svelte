<!--
  ByteSizeInput: one control for every byte size in the policy (request body
  limit, upload scan budget, WebSocket message limits, per-path body limit).
  `value` is in bytes (null = empty). The amount and unit are shown in the
  largest unit that divides the value exactly; binary units (1 KiB = 1024 B)
  match the agents.

    <Field label="Request body limit" ...>
      {#snippet children(c)}<ByteSizeInput {...c} bind:value={form.draft.bodyLimit} />{/snippet}
    </Field>
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { formatBytes, formatNumber } from '#lib/format.js';
  import Select from '#lib/components/ui/Select.svelte';
  import { BYTE_UNITS, amountFromBytes, bestByteUnit, bytesFromAmount, type ByteUnit } from './byte-size';

  let {
    value = $bindable(null),
    id,
    placeholder = undefined,
    disabled = false,
    /** Text shown under the control for an empty or zero value, e.g. "No limit". */
    emptyLabel = undefined,
    'aria-describedby': describedby = undefined,
    'aria-invalid': invalid = undefined,
    'aria-required': required = undefined
  }: {
    value?: number | null;
    id: string;
    placeholder?: string;
    disabled?: boolean;
    emptyLabel?: string;
    'aria-describedby'?: string;
    'aria-invalid'?: 'true' | undefined;
    'aria-required'?: 'true' | undefined;
  } = $props();

  const UNIT_OPTIONS = BYTE_UNITS.map((u) => ({ value: u, label: u }));

  let unit = $state<ByteUnit>(untrack(() => bestByteUnit(value)));
  let amount = $state<number | null>(untrack(() => amountFromBytes(value, bestByteUnit(value))));

  // Follow outside changes (Discard, reset to default) without fighting the user's own unit choice.
  $effect.pre(() => {
    const bytes = value;
    untrack(() => {
      if (bytes === bytesFromAmount(amount, unit)) return;
      unit = bestByteUnit(bytes, unit);
      amount = amountFromBytes(bytes, unit);
    });
  });

  function onAmountInput(event: Event) {
    const raw = (event.currentTarget as HTMLInputElement).value;
    amount = raw.trim() === '' ? null : Number(raw);
    value = bytesFromAmount(amount, unit);
  }

  function onUnitChange(next: ByteUnit) {
    unit = next;
    value = bytesFromAmount(amount, unit);
  }

  const readout = $derived(
    typeof value === 'number' && value > 0 ? `${formatBytes(value)} (${formatNumber(value)} bytes)` : (emptyLabel ?? '')
  );
</script>

<div class="wp-bytes">
  <input
    {id}
    type="number"
    min="0"
    step="any"
    inputmode="decimal"
    value={amount ?? ''}
    oninput={onAmountInput}
    {placeholder}
    {disabled}
    aria-describedby={describedby}
    aria-invalid={invalid}
    aria-required={required}
  />
  <Select class="wp-bytes-unit" aria-label="Unit" options={UNIT_OPTIONS} value={unit} onchange={onUnitChange} {disabled} />
</div>
{#if readout}<p class="wp-bytes-readout">{readout}</p>{/if}

<style>
  .wp-bytes { display: flex; gap: var(--sp-2); min-width: 0; max-width: 22rem; }
  .wp-bytes input { flex: 1 1 auto; min-width: 0; }
  .wp-bytes :global(.wp-bytes-unit) { flex: 0 0 5.5rem; width: 5.5rem; }
  .wp-bytes-readout { margin: var(--sp-1) 0 0; font-size: var(--fs-xs); color: var(--text-muted); }
</style>
