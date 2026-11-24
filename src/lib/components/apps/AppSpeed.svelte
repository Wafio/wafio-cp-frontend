<!--
  AppSpeed: the Speed tab. Parts that make an application faster for visitors and work in both modes: compression
  and files from a folder (the cache comes next). Each part has its heading, a sentence for visitors, a switch, its
  main fields, its limits folded under "Advanced limits", one status line and its own Save. The defaults are filled
  in, so switching on and saving is enough. A switch saves nothing by itself. The settings and what the agent
  reported come from the page's feed; this panel keeps what the person is typing when a read arrives, and says in
  one line per part whether the agent applies it: waiting, in use, refused with the reason, or too old.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { putAppCompression, putAppStaticFiles, type ApiError, type AppCompression, type AppStaticFiles, type StaticMissing } from '#lib/api.js';
  import { needsConfirmation } from '#lib/confirm-tiers.js';
  import { focusFormError } from '#lib/focus-error.js';
  import { toast } from '#lib/stores/toast.js';
  import { Alert, Button, ConfirmModal, Field, InlineError, Spinner, Switch } from '#lib/components/ui/index.js';
  import ChoiceGroup from '#lib/components/waf-policy/ChoiceGroup.svelte';
  import LifetimeInput from './LifetimeInput.svelte';
  import PartStatus from './PartStatus.svelte';
  import type { DeliveryFeed } from './delivery-feed.svelte.js';
  import { mergeEdits } from './tls';
  import {
    COMPRESSION_FIXED,
    COMPRESSION_LIMITS_FIXED,
    FILES_FIXED,
    LOADING_TEXT,
    SPEED_INTRO,
    UNASSIGNED_TEXT,
    VIEWER_TEXT,
    classifySpeedRefusal,
    compressionForm,
    compressionInput,
    compressionNumbers,
    loadErrorText,
    normalizeCompression,
    normalizeStaticFiles,
    partLine,
    sameCompression,
    sameStaticFiles,
    staticFilesForm,
    staticFilesInput,
    staticRootConfirmText,
    staticRootConfirmTitle,
    staticRootNeedsConfirm,
    tooOld,
    type CompressionField,
    type CompressionForm,
    type StaticFilesField,
    type StaticFilesForm,
  } from './speed';

  let {
    projectId,
    appId,
    feed,
    canConfigure = false,
    dirty = $bindable(false),
  }: {
    projectId: string;
    appId: string;
    /** The settings and the agent's report, kept current by the page. */
    feed: DeliveryFeed;
    canConfigure?: boolean;
    /** Unsaved edits; the page asks before leaving the tab. */
    dirty?: boolean;
  } = $props();

  const uid = $props.id();
  const DEFAULT_COMPRESSION: AppCompression = { enabled: false, min_bytes: 1024 };
  const DEFAULT_FILES: AppStaticFiles = { enabled: false, root: '', missing: 'app', max_age_s: 0 };

  // ── Data ────────────────────────────────────────────────────────────────
  const delivery = $derived(feed.state);
  const agent = $derived(delivery?.agent ?? null);
  const agentName = $derived(agent?.name ?? '');
  const readonly = $derived(!canConfigure);
  const storedCompression = $derived(delivery?.compression ?? DEFAULT_COMPRESSION);
  const storedFiles = $derived(delivery?.static_files ?? DEFAULT_FILES);

  let compression = $state<CompressionForm>(untrack(() => compressionForm(feed.state?.compression ?? DEFAULT_COMPRESSION)));
  let files = $state<StaticFilesForm>(untrack(() => staticFilesForm(feed.state?.static_files ?? DEFAULT_FILES)));
  let compressionBase = untrack(() => compressionForm(feed.state?.compression ?? DEFAULT_COMPRESSION));
  let filesBase = untrack(() => staticFilesForm(feed.state?.static_files ?? DEFAULT_FILES));

  // A read replaces what the person has not changed and keeps what they typed.
  $effect(() => {
    const stored = feed.state?.compression;
    if (!stored) return;
    const next = compressionForm(stored);
    untrack(() => {
      if (JSON.stringify(next) === JSON.stringify(compressionBase)) return;
      compression = mergeEdits(compression, compressionBase, next);
      compressionBase = next;
    });
  });
  $effect(() => {
    const stored = feed.state?.static_files;
    if (!stored) return;
    const next = staticFilesForm(stored);
    untrack(() => {
      if (JSON.stringify(next) === JSON.stringify(filesBase)) return;
      files = mergeEdits(files, filesBase, next);
      filesBase = next;
    });
  });

  // ── Checks and what the form shows ──────────────────────────────────────
  let busy = $state<'compression' | 'files' | null>(null);
  let attempted = $state<{ compression: boolean; files: boolean }>({ compression: false, files: false });
  let touched = $state<Partial<Record<CompressionField | StaticFilesField, boolean>>>({});
  let serverError = $state<{ field: CompressionField | StaticFilesField; message: string; sent: string } | null>(null);
  let saveError = $state<{ part: 'compression' | 'files'; message: string } | null>(null);
  let compressionAdvanced = $state(false);
  let filesAdvanced = $state(false);
  let confirmOpen = $state(false);
  let compressionEl = $state<HTMLElement>();
  let filesEl = $state<HTMLElement>();

  const compressionCheck = $derived(normalizeCompression(compressionInput(compression)));
  const filesCheck = $derived(normalizeStaticFiles(staticFilesInput(files)));
  const compressionDirty = $derived(!sameCompression(compression, storedCompression));
  const filesDirty = $derived(!sameStaticFiles(files, storedFiles));

  $effect(() => {
    dirty = compressionDirty || filesDirty;
  });

  const fieldValue = (field: CompressionField | StaticFilesField) =>
    field === 'min_bytes' ? compression.minBytes : field === 'root' ? files.root : field === 'missing' ? files.missing : files.maxAge;

  /** The text under a field: after the person left it or tried to save, and a refusal of the server while the field still holds what was sent. */
  function shown(field: CompressionField | StaticFilesField, part: 'compression' | 'files'): string | undefined {
    const check = part === 'compression' ? compressionCheck : filesCheck;
    if (check.error?.field === field && (touched[field] || attempted[part])) return check.error.message;
    if (serverError?.field === field && serverError.sent === JSON.stringify(fieldValue(field))) return serverError.message;
    return undefined;
  }

  const minBytesError = $derived(shown('min_bytes', 'compression'));
  const rootError = $derived(shown('root', 'files'));
  const missingError = $derived(shown('missing', 'files'));
  const maxAgeError = $derived(shown('max_age_s', 'files'));

  // ── The line under each part ────────────────────────────────────────────
  const view = $derived({ delivery, now: feed.now, waitingSince: feed.waitingSince, quiet: ['unassigned'] as const });
  const compressionLine = $derived(partLine({ ...view, part: 'compression', inUse: storedCompression.enabled }));
  const filesLine = $derived(partLine({ ...view, part: 'static_files', inUse: storedFiles.enabled, folder: storedFiles.root }));
  // An agent that is too old cannot be switched on and its settings cannot change, but a part that is on can be turned off.
  const compressionOld = $derived(tooOld(delivery, 'compression'));
  const filesOld = $derived(tooOld(delivery, 'static_files'));
  const compressionLocked = $derived(compressionOld && !storedCompression.enabled);
  const filesLocked = $derived(filesOld && !storedFiles.enabled);
  const numbers = $derived(storedCompression.enabled ? compressionNumbers(delivery?.compression_stats ?? null) : []);
  const noNumbers = $derived(storedCompression.enabled && numbers.length === 0 && compressionLine?.tone === 'success');
  const whoseHost = $derived(agentName ? `${agentName}'s host` : "the WAF agent's host");

  // ── Saving ──────────────────────────────────────────────────────────────
  function touch(field: CompressionField | StaticFilesField) {
    touched[field] = true;
  }

  function refused<F extends CompressionField | StaticFilesField>(error: ApiError | undefined, fields: readonly F[], part: 'compression' | 'files', fallback: string) {
    const refusal = classifySpeedRefusal(error, fields, part === 'compression' ? 'compression' : 'static_files', fallback);
    const root = part === 'compression' ? compressionEl : filesEl;
    if (refusal.kind === 'field') {
      serverError = { field: refusal.field, message: refusal.message, sent: JSON.stringify(fieldValue(refusal.field)) };
      if (part === 'compression') compressionAdvanced = true;
      else if (refusal.field === 'max_age_s') filesAdvanced = true;
    } else {
      saveError = { part, message: refusal.message };
      // An agent that is too old for it has told the control plane so: read the flags again.
      if (refusal.kind === 'too-old') void feed.refresh();
    }
    void focusFormError(root);
  }

  const savedText = $derived(delivery?.agent ? `${agentName || 'The WAF agent'} applies it with its next configuration bundle.` : UNASSIGNED_TEXT);

  async function saveCompression() {
    if (!canConfigure || busy || !delivery) return;
    attempted.compression = true;
    const check = compressionCheck;
    if (check.error) {
      compressionAdvanced = true;
      void focusFormError(compressionEl);
      return;
    }
    busy = 'compression';
    saveError = null;
    serverError = null;
    const res = await putAppCompression(projectId, appId, check.settings);
    busy = null;
    if (res.error || !res.data) {
      refused(res.error, ['min_bytes'] as const, 'compression', 'Could not save compression.');
      return;
    }
    const next = compressionForm(res.data.compression);
    compression = next;
    compressionBase = next;
    attempted.compression = false;
    touched.min_bytes = false;
    feed.saved({ compression: res.data.compression }, res.data.generation);
    toast.success(savedText, 'Compression saved');
  }

  function askSaveFiles() {
    if (!canConfigure || busy || !delivery) return;
    attempted.files = true;
    saveError = null;
    const check = filesCheck;
    if (check.error) {
      if (check.error.field === 'max_age_s') filesAdvanced = true;
      void focusFormError(filesEl);
      return;
    }
    if (staticRootNeedsConfirm(storedFiles, check.settings) && needsConfirmation('change-static-root')) {
      confirmOpen = true;
      return;
    }
    void saveFiles();
  }

  async function saveFiles() {
    const check = filesCheck;
    if (!canConfigure || busy || !delivery || check.error) return;
    busy = 'files';
    saveError = null;
    serverError = null;
    const res = await putAppStaticFiles(projectId, appId, check.settings);
    busy = null;
    confirmOpen = false;
    if (res.error || !res.data) {
      refused(res.error, ['root', 'missing', 'max_age_s'] as const, 'files', 'Could not save the files settings.');
      return;
    }
    const next = staticFilesForm(res.data.static_files);
    files = next;
    filesBase = next;
    attempted.files = false;
    touched.root = false;
    touched.max_age_s = false;
    feed.saved({ static_files: res.data.static_files }, res.data.generation);
    toast.success(savedText, 'Files settings saved');
  }

  const missingOptions: { value: StaticMissing; label: string; description: string }[] = [
    {
      value: 'app',
      label: 'Ask the application (recommended)',
      description: 'Files in the folder come from it; everything else goes to your application as before. For a PHP site, choose its public folder.',
    },
    { value: 'not_found', label: 'Answer Not found', description: 'The folder is the whole site; your application gets no requests.' },
  ];

  const compressionNote = $derived(busy === 'compression' ? 'Saving…' : compressionDirty ? 'Unsaved changes' : '');
  const filesNote = $derived(busy === 'files' ? 'Saving…' : filesDirty ? 'Unsaved changes' : '');
</script>

<section class="sp" aria-labelledby="{uid}-title">
  <header class="sp-head">
    <h2 id="{uid}-title">Speed</h2>
    <p>{SPEED_INTRO}</p>
  </header>

  <!-- Before the first read has started the feed is neither loading nor failed: that is still the wait. -->
  {#if !delivery && !feed.failed}
    <Spinner layout="block" tone="accent" label={LOADING_TEXT} />
  {:else if !delivery}
    <InlineError message={loadErrorText(feed.failed?.error ?? 'Try again in a moment.')} onretry={() => void feed.refresh()} retryLabel="Try again" retrying={feed.loading} />
  {:else}
    {#if readonly}
      <Alert tone="info" message={VIEWER_TEXT} />
    {/if}
    {#if !agent}
      <Alert tone="info" message={UNASSIGNED_TEXT} />
    {/if}

    <section class="sp-part" aria-labelledby="{uid}-compression" bind:this={compressionEl}>
      <h3 id="{uid}-compression">Compression</h3>
      <p class="sp-lead">Pages, styles and scripts are sent compressed, so visitors download less and pages load sooner on slow connections.</p>
      <Switch
        bind:checked={compression.enabled}
        label="Compress answers"
        hint="WAFio uses brotli or gzip, whichever the visitor's browser accepts. Images, video and answers your application already compressed are sent as they are."
        disabled={readonly || busy !== null || compressionLocked}
      >
        <p class="sp-fixed">{COMPRESSION_FIXED}</p>
      </Switch>
      <PartStatus line={compressionLine} />
      <fieldset class="sp-fieldset" disabled={readonly || compressionOld}>
        <details class="sp-advanced" bind:open={compressionAdvanced}>
          <summary>Advanced limits</summary>
          <div class="sp-advanced-body">
            <div onfocusout={() => touch('min_bytes')}>
              <Field label="Smallest answer to compress" error={minBytesError} hint="Smaller answers go as they are: compressing them saves little.">
                {#snippet children(c)}
                  <input {...c} class="sp-short" type="text" inputmode="text" autocomplete="off" spellcheck="false" placeholder="1 KiB" bind:value={compression.minBytes} />
                {/snippet}
              </Field>
            </div>
            <p class="sp-fixed">{COMPRESSION_LIMITS_FIXED}</p>
          </div>
        </details>
      </fieldset>
      {#if numbers.length > 0}
        <div class="sp-numbers" aria-live="polite">
          {#each numbers as text (text)}<p>{text}</p>{/each}
        </div>
      {:else if noNumbers}
        <p class="sp-numbers">No numbers from {agentName} yet.</p>
      {/if}
      {#if saveError?.part === 'compression'}
        <Alert tone="error" title="Not saved" message={saveError.message} />
      {/if}
      <div class="sp-actions">
        <span class="sp-dirty" role="status">{compressionNote}</span>
        <Button class="sp-tap" loading={busy === 'compression'} disabled={readonly || busy !== null || !compressionDirty} onclick={() => void saveCompression()}>Save compression</Button>
      </div>
    </section>

    <section class="sp-part" aria-labelledby="{uid}-files" bind:this={filesEl}>
      <h3 id="{uid}-files">Files from a folder</h3>
      <p class="sp-lead">Images, styles, scripts and other files come straight from a folder on the server, without waiting for your application.</p>
      <Switch bind:checked={files.enabled} label="Serve files from a folder" disabled={readonly || busy !== null || filesLocked} />
      <PartStatus line={filesLine} />
      <fieldset class="sp-fieldset" disabled={readonly || filesOld}>
        <div onfocusout={() => touch('root')}>
          <Field
            label="Folder"
            error={rootError}
            hint={`The full path on ${whoseHost}. The user wafio must be able to read it; folders under /home are hidden from the agent.`}
          >
            {#snippet children(c)}
              <input {...c} class="mono" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="/var/www/shop/public" bind:value={files.root} />
            {/snippet}
          </Field>
        </div>
        <ChoiceGroup legend="When a file is not in the folder" name="{uid}-missing" options={missingOptions} bind:value={files.missing} columns={2} disabled={readonly || filesOld} error={missingError} />
        <p class="sp-fixed">{FILES_FIXED}</p>
        <details class="sp-advanced" bind:open={filesAdvanced}>
          <summary>Advanced limits</summary>
          <div class="sp-advanced-body">
            <div onfocusout={() => touch('max_age_s')}>
              <Field
                label="Browser cache time"
                error={maxAgeError}
                hint="How long visitors' browsers may reuse a file before they ask again. Not set lets the browser decide."
              >
                {#snippet children(c)}
                  <LifetimeInput control={c} label="Browser cache time" bind:value={files.maxAge} disabled={readonly || filesOld} />
                {/snippet}
              </Field>
            </div>
          </div>
        </details>
      </fieldset>
      {#if saveError?.part === 'files'}
        <Alert tone="error" title="Not saved" message={saveError.message} />
      {/if}
      <div class="sp-actions">
        <span class="sp-dirty" role="status">{filesNote}</span>
        <Button class="sp-tap" loading={busy === 'files'} disabled={readonly || busy !== null || !filesDirty} onclick={askSaveFiles}>Save files</Button>
      </div>
    </section>
  {/if}
</section>

<ConfirmModal
  open={confirmOpen}
  tone="warning"
  title={staticRootConfirmTitle(filesCheck.settings?.root ?? files.root)}
  confirmLabel="Serve this folder"
  cancelLabel="Cancel"
  loading={busy === 'files'}
  onconfirm={() => void saveFiles()}
  onclose={() => (confirmOpen = false)}
>
  <p class="sp-confirm">{staticRootConfirmText(files.missing)}</p>
</ConfirmModal>

<style>
  .sp { display: flex; flex-direction: column; gap: var(--sp-4); width: 100%; min-width: 0; max-width: 46rem; }
  .sp-head h2 { margin: 0; font-size: var(--fs-md); }
  .sp-head p { margin: var(--sp-1) 0 0; font-size: var(--fs-sm); color: var(--text-muted); max-width: 70ch; line-height: 1.5; }

  .sp-part { display: flex; flex-direction: column; gap: var(--sp-3); min-width: 0; padding-top: var(--sp-5); border-top: 1px solid var(--border); }
  .sp-part h3 { margin: 0; font-size: var(--fs-base); font-weight: var(--fw-semibold); color: var(--text-primary); }
  .sp-lead { margin: calc(var(--sp-1) * -1) 0 0; font-size: var(--fs-sm); color: var(--text-secondary); line-height: 1.5; max-width: 70ch; }
  .sp-fixed { margin: var(--sp-1) 0 0; font-size: var(--fs-sm); color: var(--text-muted); line-height: 1.5; max-width: 70ch; }
  .sp-fieldset { display: flex; flex-direction: column; gap: var(--sp-4); border: 0; padding: 0; margin: 0; min-width: 0; }
  .sp-fieldset input.mono { font-family: var(--font-mono); font-size: var(--fs-sm); }
  .sp-short { max-width: 14rem; }

  .sp-advanced { border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-secondary); }
  .sp-advanced > summary { cursor: pointer; padding: var(--sp-3) var(--sp-4); font-size: var(--fs-sm); font-weight: var(--fw-semibold); color: var(--text-primary); }
  .sp-advanced-body { display: flex; flex-direction: column; gap: var(--sp-3); padding: 0 var(--sp-4) var(--sp-4); }

  /* The region of an empty line stays in the page for screen readers and takes no room. */
  .sp-part :global(.part-status:empty) { margin-top: calc(var(--sp-3) * -1); }
  .sp-numbers { display: flex; flex-direction: column; gap: var(--sp-1); margin: 0; font-size: var(--fs-sm); color: var(--text-secondary); line-height: 1.5; }
  .sp-numbers p { margin: 0; }
  .sp-confirm { margin: 0; color: var(--text-secondary); line-height: 1.5; }

  .sp-actions { display: flex; align-items: center; justify-content: flex-end; gap: var(--sp-2); flex-wrap: wrap; }
  .sp-dirty { margin-right: auto; font-size: var(--fs-sm); color: var(--text-muted); }

  @media (max-width: 760px) {
    .sp-actions { flex-direction: column-reverse; align-items: stretch; }
    .sp-dirty { margin-right: 0; text-align: center; }
    .sp :global(.sp-tap), .sp :global(input[type='text']), .sp :global(.lifetime-unit button) { min-height: 44px; }
    .sp-short { max-width: none; }
    /* The two answers for a missing file stack: side by side they leave room for four words a line. */
    .sp :global(.wp-choice-options) { grid-template-columns: minmax(0, 1fr); }
    .sp-advanced > summary { min-height: 44px; display: flex; align-items: center; }
  }
</style>
