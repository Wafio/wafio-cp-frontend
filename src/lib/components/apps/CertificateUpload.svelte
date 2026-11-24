<!--
  CertificateUpload: the dialog that uploads a certificate chain and its private key. The key lives in this component
  only until a send ends: sendCertificate drops it and its file however the request ends, and closing the dialog
  empties the chain as well. It never reaches storage, a URL, a toast or a log. Strings cannot be wiped, so this is
  best effort.
-->
<script lang="ts">
  import { uploadAppCertificate } from '#lib/api.js';
  import { focusFormError, submitScope } from '#lib/focus-error.js';
  import { Alert, Button, Field, Modal } from '#lib/components/ui/index.js';
  import { chosenFileText, clearCertificateForm, readPemFile, sendCertificate, uploadSourceText, type CertificateForm, type CertificatePlace, type CertificateRefusal } from './tls';

  let {
    open = false,
    projectId,
    appId,
    appName = '',
    agentName = '',
    replacing = false,
    becomesSource = false,
    gateway = false,
    onuploaded,
    onclose,
  }: {
    open?: boolean;
    projectId: string;
    appId: string;
    appName?: string;
    agentName?: string;
    /** The application already uses an uploaded certificate. */
    replacing?: boolean;
    /** The saved source is another one: this upload takes its place. */
    becomesSource?: boolean;
    /** The application is saved in Gateway. */
    gateway?: boolean;
    /** The control plane took the certificate. */
    onuploaded: () => void;
    onclose: () => void;
  } = $props();

  const uid = $props.id();
  const CHAIN_FILES = '.pem,.crt,.cer,.der,.p12,.pfx,.txt';
  const KEY_FILES = `${CHAIN_FILES},.key`;
  // Writing assistants read every textarea they find; a private key is not theirs to read.
  const NO_ASSISTANT = { 'data-gramm': 'false', 'data-gramm_editor': 'false', 'data-enable-grammarly': 'false' };

  const form = $state<CertificateForm>({ chain: '', key: '', keyFile: null });
  let errors = $state<Record<CertificatePlace, string>>({ chain: '', key: '', form: '' });
  /** A send ended without the certificate being taken: the key is gone and the person is told. */
  let keyCleared = $state(false);
  let sending = $state(false);
  let modal = $state<ReturnType<typeof Modal>>();
  let chainPicker = $state<HTMLInputElement>();
  let keyPicker = $state<HTMLInputElement>();

  const hasInput = $derived(form.chain !== '' || form.key !== '' || form.keyFile !== null);
  const ready = $derived(form.chain.trim() !== '' && (form.key.trim() !== '' || form.keyFile !== null));

  function close() {
    clearCertificateForm(form);
    errors = { chain: '', key: '', form: '' };
    keyCleared = false;
    onclose();
  }

  async function chooseChain(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    errors.chain = '';
    const read = await readPemFile(file, 'chain');
    if (read.message !== undefined) errors.chain = read.message;
    else form.chain = read.text;
  }

  function chooseKey(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    form.key = '';
    form.keyFile = file;
    errors.key = '';
    keyCleared = false;
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (sending || !ready) return;
    const scope = submitScope(event);
    sending = true;
    errors = { chain: '', key: '', form: '' };
    keyCleared = false;
    const outcome = await sendCertificate(form, (body) => uploadAppCertificate(projectId, appId, body), agentName);
    sending = false;
    if (outcome.ok) {
      form.chain = '';
      onuploaded();
      return;
    }
    // The union does not narrow on `ok` with strict off.
    const refused = outcome as CertificateRefusal;
    keyCleared = true;
    if (refused.aborted) return;
    errors[refused.place] = refused.message;
    void focusFormError(scope);
  }
</script>

<Modal
  bind:this={modal}
  {open}
  size="lg"
  title={replacing ? `Replace the certificate of ${appName || 'this application'}` : `Upload a certificate for ${appName || 'this application'}`}
  dirty={hasInput}
  dismissible={!sending}
  onclose={close}
>
  <form id="{uid}-form" class="upload" onsubmit={submit}>
    {#if becomesSource}<p class="upload-note">{uploadSourceText({ gateway, agent: agentName })}</p>{/if}
    {#if errors.form}<Alert tone="error" title="Not uploaded" message={errors.form} />{/if}

    <Field label="Certificate chain" required hint="The server certificate first, then each intermediate. Up to 10 certificates, 64 KiB." error={errors.chain}>
      {#snippet children(c)}
        <textarea
          {...c}
          {...NO_ASSISTANT}
          class="mono"
          rows="7"
          spellcheck="false"
          autocomplete="off"
          autocapitalize="off"
          placeholder={'-----BEGIN CERTIFICATE-----'}
          bind:value={form.chain}
        ></textarea>
      {/snippet}
    </Field>
    <div class="upload-pick">
      <Button variant="secondary" size="sm" class="upload-tap" aria-label="Choose file for the certificate chain" onclick={() => chainPicker?.click()}>Choose file</Button>
      <input bind:this={chainPicker} type="file" class="sr-only" tabindex="-1" aria-hidden="true" accept={CHAIN_FILES} onchange={chooseChain} />
    </div>

    <Field label="Private key" required hint="One key without a passphrase: RSA of 2048 to 4096 bits, or ECDSA P-256 or P-384, up to 16 KiB. Sent once, stored encrypted, never shown again." error={errors.key}>
      {#snippet children(c)}
        {#if form.keyFile}
          <output {...c} class="upload-file"><bdi>{chosenFileText(form.keyFile)}</bdi></output>
        {:else}
          <textarea
            {...c}
            {...NO_ASSISTANT}
            class="mono"
            rows="5"
            spellcheck="false"
            autocomplete="off"
            autocapitalize="off"
            placeholder={'-----BEGIN PRIVATE KEY-----'}
            bind:value={form.key}
          ></textarea>
        {/if}
      {/snippet}
    </Field>
    {#if keyCleared}<p class="upload-note">The key field was cleared. Paste or choose it again.</p>{/if}
    <div class="upload-pick">
      <Button variant="secondary" size="sm" class="upload-tap" aria-label="Choose file for the private key" onclick={() => keyPicker?.click()}>Choose file</Button>
      {#if form.keyFile}
        <Button variant="ghost" size="sm" class="upload-tap" onclick={() => (form.keyFile = null)}>Remove file</Button>
      {/if}
      <input bind:this={keyPicker} type="file" class="sr-only" tabindex="-1" aria-hidden="true" accept={KEY_FILES} onchange={chooseKey} />
    </div>
  </form>

  {#snippet footer()}
    <Button variant="secondary" class="upload-tap" disabled={sending} onclick={() => modal?.requestClose()}>Cancel</Button>
    <Button type="submit" form="{uid}-form" class="upload-tap" loading={sending} disabled={!ready}>{replacing ? 'Replace certificate' : 'Upload certificate'}</Button>
  {/snippet}
</Modal>

<style>
  .upload { display: flex; flex-direction: column; gap: var(--sp-3); min-width: 0; }
  .upload-note { margin: 0; font-size: var(--fs-sm); color: var(--text-secondary); line-height: 1.5; }
  .upload textarea { font-family: var(--font-mono); font-size: var(--fs-sm); line-height: 1.5; resize: vertical; }
  .upload-pick { display: flex; flex-wrap: wrap; gap: var(--sp-2); margin-top: calc(-1 * var(--sp-1)); }
  .upload-file { display: block; padding: var(--sp-2) var(--sp-3); border: 1px solid var(--border); border-radius: var(--radius); font-family: var(--font-mono); font-size: var(--fs-sm); overflow-wrap: anywhere; }

  @media (max-width: 760px) {
    :global(.upload-tap) { min-height: 44px; }
  }
</style>
