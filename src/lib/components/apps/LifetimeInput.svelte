<!--
  LifetimeInput: a time in seconds typed in seconds, minutes, hours or days (up to 365 days is typed in days).
  Empty means 0, "Not set". Text that is not a whole number of seconds yields NaN so the form reports it.
  Spread Field's control attributes on it via `control`.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import type { FieldControl } from '#lib/components/ui/index.js';
  import Select from '#lib/components/ui/Select.svelte';
  import { lifetimeFromParts, lifetimeParts, type LifetimeUnit } from './inputs';

  let {
    value = $bindable(0),
    control,
    disabled = false,
    placeholder = 'Not set',
    label,
  }: {
    value?: number;
    /** Attributes from Field (id, aria-describedby, aria-invalid, aria-required). */
    control: FieldControl;
    disabled?: boolean;
    placeholder?: string;
    /** Field label, used to name the unit select. */
    label: string;
  } = $props();

  const UNITS: { value: LifetimeUnit; label: string }[] = [
    { value: 's', label: 'seconds' },
    { value: 'min', label: 'minutes' },
    { value: 'h', label: 'hours' },
    { value: 'd', label: 'days' },
  ];

  const start = untrack(() => lifetimeParts(value));
  let amount = $state(start.amount);
  let unit = $state<LifetimeUnit>(start.unit);
  // Last value this component emitted: an external change (reset, reload) rewrites the text; the person's own typing is left alone.
  let emitted: number | undefined = untrack(() => value);

  $effect.pre(() => {
    const next = value;
    if (Object.is(next, emitted)) return;
    emitted = next;
    if (Number.isNaN(next)) return;
    const parts = lifetimeParts(next);
    amount = parts.amount;
    unit = parts.unit;
  });

  function emit(next: number) {
    emitted = next;
    value = next;
  }
</script>

<div class="lifetime">
  <input
    {...control}
    type="text"
    inputmode="decimal"
    autocomplete="off"
    value={amount}
    {placeholder}
    {disabled}
    oninput={(event) => {
      amount = event.currentTarget.value;
      emit(lifetimeFromParts(amount, unit));
    }}
  />
  <Select
    class="lifetime-unit"
    aria-label={`${label} unit`}
    options={UNITS}
    value={unit}
    {disabled}
    onchange={(next) => {
      unit = next;
      emit(lifetimeFromParts(amount, next));
    }}
  />
</div>

<style>
  .lifetime { display: flex; align-items: center; gap: var(--sp-2); min-width: 0; }
  .lifetime > input { flex: 1 1 6rem; min-width: 0; }
  .lifetime :global(.lifetime-unit) { flex: 0 0 auto; }
</style>
