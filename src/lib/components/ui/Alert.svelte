<!--
  Alert: inline banner for a section or page. Neutral surface, tone on the
  edge and icon, meaning always in text. Errors are role="alert"; warning and
  success are polite status messages; info is static text unless `role` says
  otherwise. Error alerts carry `data-form-error`: `focusFormError`
  ($lib/focus-error) gives them tabindex="-1" and focuses them after a
  failed submit.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from 'svelte-awesome/components/Icon.svelte';
  import exclamationTriangle from 'svelte-awesome/icons/exclamationTriangle';
  import exclamationCircle from 'svelte-awesome/icons/exclamationCircle';
  import infoCircle from 'svelte-awesome/icons/infoCircle';
  import checkCircle from 'svelte-awesome/icons/checkCircle';
  import type { AlertTone } from './types';

  let {
    tone = 'info',
    title = undefined,
    message = undefined,
    role = undefined,
    compact = false,
    ondismiss = undefined,
    dismissLabel = 'Dismiss',
    id = undefined,
    class: className = undefined,
    children = undefined,
    actions = undefined
  }: {
    tone?: AlertTone;
    title?: string;
    message?: string;
    /** Override the live-region role (default: error → alert, warning/success → status, info → none). */
    role?: 'alert' | 'status' | 'none';
    /** Single-line density for use inside forms and table cells. */
    compact?: boolean;
    /** Shows a dismiss button when set. */
    ondismiss?: () => void;
    dismissLabel?: string;
    id?: string;
    class?: string;
    children?: Snippet;
    /** Buttons or links shown after the text (e.g. Retry). */
    actions?: Snippet;
  } = $props();

  const icons = { error: exclamationCircle, warning: exclamationTriangle, info: infoCircle, success: checkCircle };
  const prefixes: Record<AlertTone, string> = { error: 'Error', warning: 'Warning', info: 'Note', success: 'Success' };

  const liveRole = $derived(role ?? (tone === 'error' ? 'alert' : tone === 'info' ? 'none' : 'status'));
</script>

<div
  {id}
  class={['ui-alert', `tone-${tone}`, compact && 'is-compact', className]}
  role={liveRole === 'none' ? undefined : liveRole}
  data-form-error={tone === 'error' ? '' : undefined}
>
  <span class="ui-alert-icon" aria-hidden="true"><Icon data={icons[tone]} scale={compact ? 0.8 : 0.95} /></span>
  <div class="ui-alert-text">
    {#if title}
      <p class="ui-alert-title">{title}</p>
    {:else}
      <span class="sr-only">{prefixes[tone]}: </span>
    {/if}
    {#if message}<p class="ui-alert-message">{message}</p>{/if}
    {#if children}<div class="ui-alert-message">{@render children()}</div>{/if}
  </div>
  {#if actions}<div class="ui-alert-actions">{@render actions()}</div>{/if}
  {#if ondismiss}
    <button type="button" class="ui-alert-dismiss" aria-label={dismissLabel} onclick={ondismiss}>
      <span aria-hidden="true">×</span>
    </button>
  {/if}
</div>

<style>
  .ui-alert {
    --alert-tone: var(--info);
    display: flex;
    align-items: flex-start;
    gap: var(--sp-3);
    padding: var(--sp-3) var(--sp-4);
    border: 1px solid var(--border);
    border-left: 3px solid var(--alert-tone);
    border-radius: var(--radius);
    background: color-mix(in srgb, var(--alert-tone) 7%, var(--bg-card));
    color: var(--text-primary);
    font-size: var(--fs-base);
    line-height: 1.5;
    min-width: 0;
  }
  .ui-alert:focus { outline: none; }
  .ui-alert:focus-visible { outline: var(--ring-width) solid var(--ring-color); outline-offset: 2px; }
  .tone-error { --alert-tone: var(--danger); }
  .tone-warning { --alert-tone: var(--warning); }
  .tone-info { --alert-tone: var(--info); }
  .tone-success { --alert-tone: var(--success); }

  .ui-alert-icon { display: inline-flex; color: var(--alert-tone); padding-top: 2px; flex-shrink: 0; }
  .ui-alert-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .ui-alert-title { margin: 0; font-weight: var(--fw-semibold); color: var(--text-primary); }
  .ui-alert-message { margin: 0; color: var(--text-secondary); }
  .ui-alert-title + .ui-alert-message { margin-top: var(--sp-1); }
  .ui-alert-message :global(p) { margin: 0; }
  .ui-alert-message :global(p + p) { margin-top: var(--sp-1); }
  .ui-alert-actions { display: flex; flex-wrap: wrap; gap: var(--sp-2); align-items: center; flex-shrink: 0; }
  .ui-alert-dismiss {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    margin: calc(-1 * var(--sp-1)) calc(-1 * var(--sp-2)) 0 0;
    border: 0;
    border-radius: var(--radius);
    background: transparent;
    color: var(--text-muted);
    font-size: var(--fs-lg);
    line-height: 1;
    cursor: pointer;
  }
  .ui-alert-dismiss:hover { background: var(--bg-hover); color: var(--text-primary); }
  .ui-alert-dismiss:focus-visible { outline: var(--ring-width) solid var(--ring-color); outline-offset: 1px; }

  .is-compact { padding: var(--sp-2) var(--sp-3); gap: var(--sp-2); font-size: var(--fs-sm); align-items: center; }
  .is-compact .ui-alert-icon { padding-top: 0; }

  @media (max-width: 560px) {
    .ui-alert { flex-wrap: wrap; }
    .ui-alert-actions { width: 100%; padding-left: calc(var(--sp-3) + 16px); }
  }
</style>
