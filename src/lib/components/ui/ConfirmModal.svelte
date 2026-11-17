<!--
  ConfirmModal: confirmation dialog on the native Modal (alertdialog).
  Focus starts on Cancel (the least destructive action) or on the typed
  confirmation input; Escape and Cancel close it unless `loading`; focus
  returns to the trigger. `requireText` is the typed-confirmation tier for
  fatal actions: Confirm stays disabled until the exact text is typed, and
  Enter in the input confirms. The backdrop never closes it once text has
  been typed or when `dirty` is set.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from 'svelte-awesome/components/Icon.svelte';
  import exclamationTriangle from 'svelte-awesome/icons/exclamationTriangle';
  import exclamationCircle from 'svelte-awesome/icons/exclamationCircle';
  import infoCircle from 'svelte-awesome/icons/infoCircle';
  import Modal from './Modal.svelte';
  import Button from './Button.svelte';

  interface Props {
    open?: boolean;
    title?: string;
    message?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    loading?: boolean;
    /** danger (default) = destructive, warning = risky/impactful but recoverable, primary = neutral confirm */
    tone?: 'danger' | 'warning' | 'primary';
    /** When set, the user must type this exact text before Confirm enables
     *  (for fatal actions: delete project, delete host, delete user, revoke credential). */
    requireText?: string;
    /** Label above the typed-confirmation input (default "Type <text> to confirm"). */
    requireTextLabel?: string;
    /** Extra condition that keeps Confirm disabled (e.g. a required checkbox in `children`). */
    confirmDisabled?: boolean;
    /** The body holds input that a stray backdrop click must not discard. */
    dirty?: boolean;
    /** Width preset; default is a 480px confirmation card. */
    size?: 'sm' | 'md' | 'lg';
    onconfirm: () => void;
    onclose: () => void;
    /** Optional rich body, overrides `message` when provided. */
    children?: Snippet;
  }

  let {
    open = false,
    title = 'Are you sure?',
    message = '',
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    loading = false,
    tone = 'danger',
    requireText = '',
    requireTextLabel = undefined,
    confirmDisabled = false,
    dirty = false,
    size = undefined,
    onconfirm,
    onclose,
    children
  }: Props = $props();

  const uid = $props.id();
  const titleId = `${uid}-title`;
  const bodyId = `${uid}-body`;
  const inputId = `${uid}-require`;

  let typed = $state('');
  $effect.pre(() => {
    if (open) typed = '';
  });

  const canConfirm = $derived((!requireText || typed.trim() === requireText) && !confirmDisabled);
  const hasBody = $derived(Boolean(children || message));
  const confirmVariant = $derived(tone === 'danger' ? 'danger' : tone === 'warning' ? 'warning' : 'primary');

  function cancel() {
    if (!loading) onclose();
  }

  function confirm() {
    if (loading || !canConfirm) return;
    onconfirm();
  }

  function onRequireKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      confirm();
    }
  }
</script>

<Modal
  {open}
  size={size ?? 'md'}
  maxWidth={size ? undefined : '480px'}
  role="alertdialog"
  class="ui-confirm"
  labelledby={titleId}
  describedby={hasBody ? bodyId : undefined}
  dismissible={!loading}
  dirty={dirty || typed.length > 0}
  guardDirty={false}
  divided={false}
  onclose={cancel}
>
  <div class="cf-head">
    <div class="cf-icon" data-tone={tone} aria-hidden="true">
      {#if tone === 'warning'}
        <Icon data={exclamationCircle} scale={1.1} />
      {:else if tone === 'primary'}
        <Icon data={infoCircle} scale={1.1} />
      {:else}
        <Icon data={exclamationTriangle} scale={1.1} />
      {/if}
    </div>
    <div class="cf-text">
      <h2 id={titleId} class="cf-title">{title}</h2>
      {#if hasBody}
        <div class="cf-body" id={bodyId}>
          {#if children}
            {@render children()}
          {:else}
            <p class="cf-message">{message}</p>
          {/if}
        </div>
      {/if}
    </div>
  </div>

  {#if requireText}
    <div class="cf-require">
      <label class="cf-require-label" for={inputId}>
        {#if requireTextLabel}{requireTextLabel}{:else}Type <code>{requireText}</code> to confirm{/if}
      </label>
      <input
        id={inputId}
        type="text"
        class="cf-require-input"
        spellcheck="false"
        autocomplete="off"
        autocapitalize="off"
        data-autofocus=""
        bind:value={typed}
        disabled={loading}
        onkeydown={onRequireKeydown}
      />
    </div>
  {/if}

  {#snippet footer()}
    <Button variant="secondary" onclick={cancel} disabled={loading} data-autofocus={requireText ? undefined : ''}>
      {cancelLabel}
    </Button>
    <Button variant={confirmVariant} onclick={confirm} {loading} disabled={!canConfirm}>
      {loading ? 'Working…' : confirmLabel}
    </Button>
  {/snippet}
</Modal>

<style>
  .cf-head { display: flex; gap: var(--sp-3); align-items: flex-start; }
  .cf-text { min-width: 0; flex: 1; }

  .cf-icon {
    width: 36px;
    height: 36px;
    flex-shrink: 0;
    border-radius: var(--radius-lg);
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--cf-tone);
    background: color-mix(in srgb, var(--cf-tone) 12%, transparent);
    color: var(--cf-tone);
  }
  .cf-icon[data-tone='danger'] { --cf-tone: var(--danger); }
  .cf-icon[data-tone='warning'] { --cf-tone: var(--warning); }
  .cf-icon[data-tone='primary'] { --cf-tone: var(--accent); }

  .cf-title {
    margin: var(--sp-1) 0 var(--sp-1);
    font-size: var(--fs-md);
    font-weight: var(--fw-semibold);
    color: var(--text-primary);
    line-height: 1.35;
    overflow-wrap: anywhere;
  }
  .cf-body { min-width: 0; color: var(--text-secondary); font-size: var(--fs-base); line-height: 1.55; overflow-wrap: anywhere; }
  .cf-message { margin: 0; }

  .cf-require { margin-top: var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-2); }
  .cf-require-label { font-size: var(--fs-sm); font-weight: var(--fw-medium); color: var(--text-secondary); }
  .cf-require-label code {
    font-family: var(--font-mono);
    color: var(--text-primary);
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0 var(--sp-1);
    overflow-wrap: anywhere;
  }
  .cf-require-input {
    width: 100%;
    height: 38px;
    background: var(--surface-input);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    padding: 0 var(--sp-3);
    color: var(--text-primary);
    font-size: var(--fs-base);
    font-family: var(--font-mono);
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  .cf-require-input:focus { outline: none; border-color: var(--accent); box-shadow: var(--ring); }
  .cf-require-input:focus-visible { outline: var(--ring-width) solid var(--ring-color); outline-offset: 1px; }
</style>
