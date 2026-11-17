<!--
  Spinner: the one loading indicator (single @keyframes for the app).
  Without `label` it is decorative (aria-hidden); the caller conveys state
  (e.g. Button sets aria-busy). With `label` it is a polite status region.
-->
<script lang="ts">
  let {
    size = 'md',
    label = undefined,
    hideLabel = false,
    tone = 'current',
    layout = 'inline',
    class: className = undefined
  }: {
    size?: 'xs' | 'sm' | 'md' | 'lg';
    /** Announced text, e.g. "Loading hosts…". */
    label?: string;
    /** Keep `label` for assistive technology only. */
    hideLabel?: boolean;
    /** `current` inherits the text colour (inside buttons); `accent` for standalone use. */
    tone?: 'current' | 'accent';
    /** `block` centres the spinner and label in a padded row (section loading). */
    layout?: 'inline' | 'block';
    class?: string;
  } = $props();
</script>

{#if label}
  <span class={['ui-spinner-wrap', `layout-${layout}`, className]} role="status">
    <span class={['ui-spinner', `size-${size}`, `tone-${tone}`]} aria-hidden="true"></span>
    <span class={hideLabel ? 'sr-only' : 'ui-spinner-label'}>{label}</span>
  </span>
{:else}
  <span class={['ui-spinner', `size-${size}`, `tone-${tone}`, layout === 'block' && 'is-block', className]} aria-hidden="true"></span>
{/if}

<style>
  .ui-spinner {
    display: inline-block;
    flex-shrink: 0;
    border-radius: 50%;
    border: 2px solid currentColor;
    border-top-color: transparent;
    animation: ui-spin 0.7s linear infinite;
    vertical-align: middle;
  }
  .ui-spinner.tone-accent { color: var(--accent); }
  .size-xs { width: 12px; height: 12px; }
  .size-sm { width: 14px; height: 14px; }
  .size-md { width: 18px; height: 18px; }
  .size-lg { width: 28px; height: 28px; border-width: 3px; }
  .ui-spinner.is-block { display: block; margin: var(--sp-6) auto; }

  .ui-spinner-wrap { display: inline-flex; align-items: center; gap: var(--sp-2); color: var(--text-muted); font-size: var(--fs-base); }
  .ui-spinner-wrap.layout-block { display: flex; flex-direction: column; justify-content: center; gap: var(--sp-3); padding: var(--sp-6) var(--sp-4); width: 100%; }
  .ui-spinner-label { color: var(--text-secondary); }

  @keyframes ui-spin {
    to { transform: rotate(360deg); }
  }
</style>
