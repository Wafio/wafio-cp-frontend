<!--
  TimeRangePicker: the one range set (5m / 1h / 24h / 7d / 30d, plus "All"
  with `includeAll`), default 1h. A native radio group styled as a segmented
  control: arrow keys move the selection, each option is announced by its
  long label ("Last 24 hours"). Helpers for URL parsing and windows live in
  '#lib/components/ui/time-range.js'.
-->
<script lang="ts">
  import { DEFAULT_TIME_RANGE, parseTimeRange, timeRangeOptions, type TimeRangeKey } from './time-range';

  let {
    value = $bindable(DEFAULT_TIME_RANGE),
    onchange = undefined,
    includeAll = false,
    label = 'Time range',
    showLabel = false,
    disabled = false,
    name = undefined,
    class: className = undefined
  }: {
    /** Selected range (bindable). */
    value?: TimeRangeKey;
    onchange?: (range: TimeRangeKey) => void;
    /** Offer "All" (only where the data source is bounded by retention). */
    includeAll?: boolean;
    /** Group label, visually hidden unless `showLabel`. */
    label?: string;
    showLabel?: boolean;
    disabled?: boolean;
    /** Radio group name (default generated). */
    name?: string;
    class?: string;
  } = $props();

  const uid = $props.id();
  const groupName = $derived(name ?? `${uid}-range`);
  const options = $derived(timeRangeOptions(includeAll));
  const current = $derived(parseTimeRange(value, { includeAll }));

  function choose(key: TimeRangeKey) {
    if (key === current) return;
    value = key;
    onchange?.(key);
  }
</script>

<fieldset class={['ui-trp', className]} {disabled}>
  <legend class={showLabel ? 'ui-trp-legend' : 'sr-only'}>{label}</legend>
  <div class="ui-trp-options">
    {#each options as option (option.key)}
      <label class="ui-trp-option" class:active={option.key === current} title={option.longLabel}>
        <input
          class="ui-trp-input"
          type="radio"
          name={groupName}
          value={option.key}
          checked={option.key === current}
          onchange={() => choose(option.key)}
        />
        <span aria-hidden="true">{option.label}</span>
        <span class="sr-only">{option.longLabel}</span>
      </label>
    {/each}
  </div>
</fieldset>

<style>
  .ui-trp { border: 0; margin: 0; padding: 0; min-width: 0; display: inline-flex; align-items: center; gap: var(--sp-2); }
  .ui-trp-legend { float: left; margin-right: var(--sp-2); padding: 0; font-size: var(--fs-sm); color: var(--text-secondary); }
  .ui-trp-options {
    display: inline-flex;
    flex-wrap: wrap;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    overflow: hidden;
    background: var(--bg-card);
  }
  .ui-trp-option {
    position: relative;
    display: inline-flex;
    align-items: center;
    padding: var(--sp-1) var(--sp-3);
    font-size: var(--fs-sm);
    font-weight: var(--fw-medium);
    font-variant-numeric: tabular-nums;
    color: var(--text-secondary);
    cursor: pointer;
    border-left: 1px solid var(--border);
    transition: background 0.15s, color 0.15s;
  }
  .ui-trp-option:first-child { border-left: 0; }
  .ui-trp-option:hover { color: var(--text-primary); background: var(--bg-hover); }
  .ui-trp-option.active { color: var(--text-primary); background: var(--accent-soft); box-shadow: inset 0 -2px 0 var(--accent); }
  .ui-trp-option:has(.ui-trp-input:focus-visible) { outline: var(--ring-width) solid var(--ring-color); outline-offset: -2px; z-index: 1; }
  .ui-trp-input { position: absolute; opacity: 0; width: 1px; height: 1px; margin: 0; pointer-events: none; }
  .ui-trp:disabled .ui-trp-option { opacity: 0.55; cursor: not-allowed; }
</style>
