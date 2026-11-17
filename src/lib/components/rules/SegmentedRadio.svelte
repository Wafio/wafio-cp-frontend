<!--
  SegmentedRadio: a native radio group drawn as a segmented control (rule
  type, condition logic, what an engine does). Native radios give one tab stop,
  arrow-key selection and the radio role without extra script. The chosen option
  is bold and ringed as well as tinted, so the state does not rest on colour.
-->
<script lang="ts" generics="T extends string">
  interface Option {
    value: T;
    label: string;
    /** Unavailable option (e.g. script mode for non-owners). */
    disabled?: boolean;
    /** Tooltip, e.g. why the option is unavailable. */
    title?: string;
  }

  interface Props {
    options: Option[];
    value: T;
    /** Accessible name of the group (or `labelledby`). */
    label?: string;
    labelledby?: string;
    describedby?: string;
    size?: 'sm' | 'md' | 'lg';
    /** Stretch the options over the full width. */
    fill?: boolean;
    /** Give every option the width of the widest, and the same minimum in every control, so rows of a table line up. */
    equal?: boolean;
    disabled?: boolean;
  }

  let { options, value = $bindable(), label, labelledby, describedby, size = 'md', fill = false, equal = false, disabled = false }: Props = $props();

  const name = $props.id();
</script>

<div
  class="seg seg-{size}"
  class:fill
  class:equal
  role="radiogroup"
  aria-label={labelledby ? undefined : label}
  aria-labelledby={labelledby}
  aria-describedby={describedby}
>
  {#each options as opt (opt.value)}
    <label class="seg-opt" title={opt.title}>
      <input type="radio" {name} value={opt.value} bind:group={value} disabled={disabled || opt.disabled} />
      <span>{opt.label}</span>
    </label>
  {/each}
</div>

<style>
  .seg {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 2px;
    padding: 2px;
    background: var(--surface-input);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    min-width: 0;
  }
  .seg.fill { display: flex; }
  .seg.fill .seg-opt { flex: 1; }
  .seg.equal { display: inline-grid; grid-auto-flow: column; grid-auto-columns: 1fr; }
  .seg.equal .seg-opt { min-width: 5.25rem; }
  .seg-opt {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 30px;
    padding: 0 var(--sp-2);
    border-radius: calc(var(--radius) - 1px);
    color: var(--text-secondary);
    font-size: var(--fs-sm);
    white-space: nowrap;
    cursor: pointer;
  }
  .seg-sm .seg-opt { min-height: 26px; font-size: var(--fs-xs); }
  /* lg: a 44 px target, for choices in a table row. */
  .seg-lg { flex-wrap: nowrap; }
  .seg-lg .seg-opt { min-height: 44px; padding: 0 var(--sp-4); }
  /* Narrow screens: the control takes the width of its cell and the options share it. */
  @media (max-width: 640px) {
    .seg.equal { display: grid; grid-auto-columns: minmax(0, 1fr); width: 100%; }
    .seg.equal .seg-opt { min-width: 0; padding: 0 var(--sp-1); }
  }
  .seg-opt input {
    position: absolute;
    inset: 0;
    margin: 0;
    opacity: 0;
    appearance: none;
    cursor: inherit;
  }
  .seg-opt:hover { color: var(--text-primary); }
  .seg-opt:has(input:checked) {
    background: var(--accent-soft);
    color: var(--text-primary);
    font-weight: var(--fw-semibold);
    box-shadow: inset 0 0 0 1px var(--accent);
  }
  .seg-opt:has(input:focus-visible) { outline: var(--ring-width) solid var(--ring-color); outline-offset: 1px; }
  .seg-opt:has(input:disabled) { opacity: 0.55; cursor: not-allowed; }
</style>
