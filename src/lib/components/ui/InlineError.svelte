<!--
  InlineError: one-line error next to the thing that failed (a field, a
  section that did not load). Renders nothing without a message. role="alert"
  so the error is announced when it appears; tabindex="-1" so `focusFormError`
  ($lib/focus-error) can move focus here after a failed submit. `onretry` adds a Retry button.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from 'svelte-awesome/components/Icon.svelte';
  import exclamationCircle from 'svelte-awesome/icons/exclamationCircle';

  let {
    message = undefined,
    id = undefined,
    onretry = undefined,
    retryLabel = 'Retry',
    retrying = false,
    class: className = undefined,
    children = undefined
  }: {
    message?: string | null;
    /** Id for aria-describedby on the control this error belongs to. */
    id?: string;
    onretry?: () => void;
    retryLabel?: string;
    retrying?: boolean;
    class?: string;
    /** Rich message; overrides `message`. */
    children?: Snippet;
  } = $props();
</script>

{#if message || children}
  <p {id} class={['ui-inline-error', className]} role="alert" tabindex="-1" data-form-error="">
    <span class="ui-inline-error-icon" aria-hidden="true"><Icon data={exclamationCircle} scale={0.75} /></span>
    <span class="ui-inline-error-text">
      <span class="sr-only">Error: </span>
      {#if children}{@render children()}{:else}{message}{/if}
    </span>
    {#if onretry}
      <button type="button" class="ui-inline-error-retry" onclick={onretry} disabled={retrying} aria-busy={retrying || undefined}>
        {retryLabel}
      </button>
    {/if}
  </p>
{/if}

<style>
  .ui-inline-error {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: var(--sp-1) var(--sp-2);
    margin: var(--sp-1) 0 0;
    font-size: var(--fs-sm);
    line-height: 1.45;
    color: var(--text-primary);
  }
  .ui-inline-error:focus { outline: none; }
  .ui-inline-error:focus-visible { outline: var(--ring-width) solid var(--ring-color); outline-offset: 2px; border-radius: 2px; }
  .ui-inline-error-icon { color: var(--danger); display: inline-flex; align-self: center; }
  .ui-inline-error-text { min-width: 0; overflow-wrap: anywhere; }
  .ui-inline-error-retry {
    border: 0;
    background: none;
    padding: 0;
    color: var(--accent);
    font: inherit;
    font-weight: var(--fw-medium);
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
  }
  .ui-inline-error-retry:disabled { opacity: 0.55; cursor: not-allowed; }
  .ui-inline-error-retry:focus-visible { outline: var(--ring-width) solid var(--ring-color); outline-offset: 2px; border-radius: 2px; }
</style>
