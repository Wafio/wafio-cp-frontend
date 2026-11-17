<!--
  KeyRevealModal: one-shot display of a freshly minted secret (Host key
  `wafh_…`, WAF key `wafw_…`). The control plane keeps only the hash, so the
  dialog cannot be dismissed (Escape, ×, backdrop, Done) until the operator
  confirms the value is stored. Without a secret (a run command only) it closes
  freely.

  Usage:
    {#if key}
      <KeyRevealModal title="Host key created" value={key} snippet={cmd} onclose={() => (key = null)} />
    {/if}
-->
<script lang="ts">
  import Icon from 'svelte-awesome/components/Icon.svelte';
  import lock from 'svelte-awesome/icons/lock';
  import Modal from '#lib/components/ui/Modal.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Alert from '#lib/components/ui/Alert.svelte';

  interface Props {
    title: string;
    description?: string;
    /** The secret; empty when only a snippet is shown. */
    value?: string;
    label?: string;
    /** Example snippet shown under the key, e.g. a run command or config block. */
    snippet?: string;
    snippetLabel?: string;
    onclose?: () => void;
  }

  let { title, description = '', value = '', label = 'Secret', snippet = '', snippetLabel = 'Example config', onclose = undefined }: Props = $props();

  const uid = $props.id();

  let copied = $state<'value' | 'snippet' | null>(null);
  let copyError = $state<string | null>(null);
  let stored = $state(false);
  // Without a one-time secret there is nothing to acknowledge.
  const acknowledged = $derived(!value || stored);

  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => () => clearTimeout(copyTimer));

  async function copy(which: 'value' | 'snippet') {
    copyError = null;
    try {
      await navigator.clipboard.writeText(which === 'value' ? value : snippet);
      copied = which;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => (copied = null), 1500);
    } catch {
      copied = null;
      copyError = 'The browser did not allow copying. Select the text and copy it manually.';
    }
  }

  function close() {
    if (!acknowledged) return;
    onclose?.();
  }
</script>

<Modal open={true} labelledby={`${uid}-title`} describedby={description ? `${uid}-desc` : undefined} dismissible={acknowledged} onclose={close}>
  <header class="krm-head">
    <span class="krm-icon" aria-hidden="true"><Icon data={lock} scale={1.1} /></span>
    <div>
      <h2 id={`${uid}-title`} class="krm-title">{title}</h2>
      {#if description}<p id={`${uid}-desc`} class="krm-desc">{description}</p>{/if}
    </div>
  </header>

  <div class="krm-body">
    {#if value}
      <Alert tone="warning" compact title="Copy it now" message="This value is stored only as a hash; it cannot be shown again." />
      <div class="krm-field">
        <label class="krm-label" for={`${uid}-value`}>{label}</label>
        <div class="krm-row">
          <input id={`${uid}-value`} class="krm-input" readonly {value} onfocus={(e) => e.currentTarget.select()} />
          <Button variant="outline" size="sm" onclick={() => copy('value')} aria-label={`Copy ${label}`}>{copied === 'value' ? 'Copied' : 'Copy'}</Button>
        </div>
      </div>
    {/if}

    {#if snippet}
      <div class="krm-field">
        <span class="krm-label" id={`${uid}-snippet-label`}>{snippetLabel}</span>
        <div class="krm-snippet-wrap">
          <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
          <pre class="krm-snippet" tabindex="0" aria-labelledby={`${uid}-snippet-label`}>{snippet}</pre>
          <div class="krm-snippet-copy">
            <Button variant="outline" size="sm" onclick={() => copy('snippet')} aria-label={`Copy ${snippetLabel}`}>{copied === 'snippet' ? 'Copied' : 'Copy'}</Button>
          </div>
        </div>
      </div>
    {/if}

    <p class="krm-status" role="status">{copied ? 'Copied to the clipboard.' : ''}</p>
    {#if copyError}<Alert tone="error" compact message={copyError} />{/if}

    {#if value}
      <label class="krm-ack">
        <input type="checkbox" bind:checked={stored} />
        <span>I have stored this value in a secure place (password manager, secret store).</span>
      </label>
    {/if}
  </div>

  {#snippet footer()}
    <Button variant="primary" disabled={!acknowledged} onclick={close}>Done</Button>
  {/snippet}
</Modal>

<style>
  .krm-head { display: flex; gap: var(--sp-3); align-items: flex-start; margin-bottom: var(--sp-4); }
  .krm-title { margin: 0; font-size: var(--fs-md); font-weight: var(--fw-semibold); color: var(--text-primary); }
  .krm-desc { margin: var(--sp-1) 0 0; color: var(--text-secondary); font-size: var(--fs-sm); line-height: 1.5; }
  .krm-icon { flex: none; display: grid; place-items: center; width: 36px; height: 36px; border-radius: var(--radius-lg); background: var(--accent-soft); color: var(--accent); }
  .krm-body { display: grid; gap: var(--sp-4); }
  .krm-field { display: grid; gap: var(--sp-1); }
  .krm-label { font-size: var(--fs-xs); font-weight: var(--fw-semibold); color: var(--text-secondary); }
  .krm-row { display: flex; gap: var(--sp-2); min-width: 0; }
  .krm-input {
    flex: 1;
    min-width: 0;
    padding: var(--sp-2) var(--sp-3);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    background: var(--surface-input);
    color: var(--text-primary);
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
  }
  .krm-input:focus-visible, .krm-snippet:focus-visible { outline: var(--ring-width) solid var(--ring-color); outline-offset: 1px; }
  .krm-snippet-wrap { position: relative; min-width: 0; }
  .krm-snippet {
    margin: 0;
    padding: var(--sp-3);
    padding-right: calc(var(--sp-8) + var(--sp-4));
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg-code);
    color: var(--text-primary);
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    line-height: 1.5;
    white-space: pre;
    overflow-x: auto;
  }
  .krm-snippet-copy { position: absolute; top: var(--sp-1); right: var(--sp-1); }
  .krm-status { margin: 0; min-height: 0; font-size: var(--fs-xs); color: var(--text-muted); }
  .krm-status:empty { display: none; }
  .krm-ack { display: flex; align-items: flex-start; gap: var(--sp-2); padding: var(--sp-3) 0; border-top: 1px solid var(--border); font-size: var(--fs-sm); color: var(--text-secondary); cursor: pointer; }
  .krm-ack input { margin-top: calc(var(--sp-1) / 2); }
</style>
