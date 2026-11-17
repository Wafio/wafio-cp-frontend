<!--
  SecretInput: a masked text field for keys and secrets (AES-256 keys,
  challenge secrets) with Show/Hide, Copy and an optional Generate button.
  The value is masked by default and never shown in the review drawer.
  `hidden`: the server redacted a configured value for this reader;
  the field shows "Configured (hidden)" read-only instead of an empty input.
-->
<script lang="ts">
  import { toast } from '#lib/stores/toast.js';
  import { HIDDEN_SECRET_TEXT } from '#lib/secret-redaction.js';

  let {
    value = $bindable(''),
    id,
    placeholder = undefined,
    disabled = false,
    maxlength = undefined,
    /** Show a Generate button that fills 32 random bytes as 64 hex characters. */
    generate = false,
    label = 'secret',
    hidden = false,
    'aria-describedby': describedby = undefined,
    'aria-invalid': invalid = undefined,
    'aria-required': required = undefined
  }: {
    value?: string;
    id: string;
    placeholder?: string;
    disabled?: boolean;
    maxlength?: number;
    generate?: boolean;
    /** Used in button names, e.g. "Show AES key". */
    label?: string;
    /** Configured but redacted by the server: show a read-only placeholder. */
    hidden?: boolean;
    'aria-describedby'?: string;
    'aria-invalid'?: 'true' | undefined;
    'aria-required'?: 'true' | undefined;
  } = $props();

  let revealed = $state(false);

  function randomHex(bytes = 32): string {
    const buffer = new Uint8Array(bytes);
    crypto.getRandomValues(buffer);
    return Array.from(buffer, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function copy() {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`Copied ${label} to the clipboard.`);
    } catch {
      toast.error('Copy failed. Show the value and copy it manually.');
    }
  }
</script>

{#if hidden}
<div class="wp-secret">
  <input {id} type="text" value={HIDDEN_SECRET_TEXT} readonly disabled aria-describedby={describedby} />
</div>
{:else}
<div class="wp-secret">
  <input
    {id}
    type={revealed ? 'text' : 'password'}
    bind:value
    {placeholder}
    {disabled}
    {maxlength}
    autocomplete="off"
    spellcheck="false"
    autocapitalize="off"
    aria-describedby={describedby}
    aria-invalid={invalid}
    aria-required={required}
  />
  <div class="wp-secret-actions">
    <button type="button" class="wp-secret-btn" aria-pressed={revealed} aria-controls={id} onclick={() => (revealed = !revealed)} {disabled}>
      {revealed ? 'Hide' : 'Show'}<span class="sr-only"> {label}</span>
    </button>
    <button type="button" class="wp-secret-btn" onclick={copy} disabled={disabled || !value}>
      Copy<span class="sr-only"> {label}</span>
    </button>
    {#if generate}
      <button type="button" class="wp-secret-btn" onclick={() => (value = randomHex())} {disabled}>
        Generate<span class="sr-only"> {label}</span>
      </button>
    {/if}
  </div>
</div>
{/if}

<style>
  .wp-secret { display: flex; flex-wrap: wrap; gap: var(--sp-2); min-width: 0; }
  .wp-secret input { flex: 1 1 16rem; min-width: 0; font-family: var(--font-mono); font-size: var(--fs-sm); }
  .wp-secret input[readonly] { font-family: inherit; color: var(--text-muted); }
  .wp-secret-actions { display: flex; gap: var(--sp-1); flex-shrink: 0; }
  .wp-secret-btn {
    padding: var(--sp-1) var(--sp-3);
    min-height: 2.25rem;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    background: var(--bg-secondary);
    color: var(--text-primary);
    font-size: var(--fs-sm);
    cursor: pointer;
  }
  .wp-secret-btn:hover:not(:disabled) { background: var(--bg-hover); }
  .wp-secret-btn:focus-visible { outline: var(--ring-width) solid var(--ring-color); outline-offset: 2px; }
  .wp-secret-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .wp-secret-btn[aria-pressed='true'] { border-color: var(--accent); }
</style>
