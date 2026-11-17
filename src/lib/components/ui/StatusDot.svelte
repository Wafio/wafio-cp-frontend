<!--
  StatusDot: connection/lifecycle state as a dot plus text. Colour is never
  the only signal: the text is visible, or (hideLabel) the dot becomes an
  image with the text as its accessible name. Status colours come from the
  --status-* tokens in app.css; never from the WAF verdict aliases.
-->
<script lang="ts">
  import type { StatusKind } from './types';

  let {
    status,
    label = undefined,
    hideLabel = false,
    pulse = false,
    title = undefined,
    class: className = undefined
  }: {
    status: StatusKind;
    /** Text shown with the dot (default: the status name, e.g. "Online"). */
    label?: string;
    /** Show only the dot; the label becomes its aria-label. */
    hideLabel?: boolean;
    /** Gentle pulse for a live connection (disabled under reduced motion). */
    pulse?: boolean;
    title?: string;
    class?: string;
  } = $props();

  const names: Record<StatusKind, string> = {
    online: 'Online',
    pending: 'Pending',
    degraded: 'Degraded',
    offline: 'Offline',
    unknown: 'Unknown',
    disabled: 'Disabled'
  };

  const text = $derived(label ?? names[status]);
</script>

{#if hideLabel}
  <span class={['ui-status', `status-${status}`, className]} role="img" aria-label={text} title={title ?? text}>
    <span class="dot" class:pulse></span>
  </span>
{:else}
  <span class={['ui-status', `status-${status}`, className]} {title}>
    <span class="dot" class:pulse aria-hidden="true"></span>
    <span class="text">{text}</span>
  </span>
{/if}

<style>
  .ui-status {
    --status-color: var(--text-muted);
    display: inline-flex;
    align-items: center;
    gap: var(--sp-2);
    font-size: var(--fs-sm);
    color: var(--text-secondary);
    line-height: 1.4;
    white-space: nowrap;
  }
  .status-online { --status-color: var(--status-online); }
  .status-pending { --status-color: var(--status-pending); }
  .status-degraded { --status-color: var(--status-degraded); }
  .status-offline { --status-color: var(--status-offline); }
  .status-unknown { --status-color: var(--status-unknown); }
  .status-disabled { --status-color: var(--status-disabled); }

  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--status-color); flex-shrink: 0; }
  /* Shape as a second cue: pending/degraded are rings, unknown/disabled hollow. */
  .status-pending .dot,
  .status-degraded .dot { background: transparent; border: 2px solid var(--status-color); }
  .status-unknown .dot,
  .status-disabled .dot { background: transparent; border: 1.5px dashed var(--status-color); }
  .dot.pulse { animation: ui-status-pulse 2s ease-in-out infinite; }

  @keyframes ui-status-pulse {
    0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--status-color) 45%, transparent); }
    50% { box-shadow: 0 0 0 4px color-mix(in srgb, var(--status-color) 0%, transparent); }
  }
</style>
