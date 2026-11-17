<!--
  ByteSizeInput: a size in bytes typed with an optional binary unit
  ("64 MiB", "512 KB", "1048576"). Malformed text yields NaN so the form
  reports it; the exact byte count is shown under the field.
-->
<script lang="ts">
  import type { FieldControl } from '#lib/components/ui/index.js';
  import { formatNumber } from '#lib/format.js';
  import { bytesFromInput, bytesToInput } from './inputs';

  let {
    value = $bindable(0),
    control,
    disabled = false,
    placeholder = 'e.g. 64 MiB',
  }: {
    value?: number;
    control: FieldControl;
    disabled?: boolean;
    placeholder?: string;
  } = $props();

  let text = $state('');
  let emitted: number | undefined;

  $effect.pre(() => {
    const next = value;
    if (Object.is(next, emitted)) return;
    emitted = next;
    if (!Number.isNaN(next)) text = bytesToInput(next);
  });

  function onInput(next: string) {
    text = next;
    const bytes = bytesFromInput(next);
    emitted = bytes;
    value = bytes;
  }
</script>

<div class="bytes">
  <input
    {...control}
    type="text"
    autocomplete="off"
    spellcheck="false"
    value={text}
    {placeholder}
    {disabled}
    oninput={(event) => onInput(event.currentTarget.value)}
  />
  {#if Number.isFinite(value) && value > 0 && !/^\d+$/.test(text.trim())}
    <span class="bytes-exact">{formatNumber(value)} bytes</span>
  {/if}
</div>

<style>
  .bytes { display: flex; flex-direction: column; gap: var(--sp-1); min-width: 0; }
  .bytes-exact { font-size: var(--fs-xs); color: var(--text-muted); font-variant-numeric: tabular-nums; }
</style>
