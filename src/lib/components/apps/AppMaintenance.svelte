<!--
  AppMaintenance: the Maintenance tab. While the switch is on, the WAF agent
  answers every request of this application with a 503 maintenance page,
  except requests from allowed IP addresses and to allowed paths. The page is
  the standard one (message and expected end) or the owner's own HTML. The
  switch has its own flow: turning it on validates the form, asks once and
  saves the form too; turning it off saves nothing else. "Save changes" keeps
  the switch where it is. Maintenance never ends by itself.
-->
<script lang="ts">
  import { onDestroy, tick, untrack } from 'svelte';
  import { getAppMaintenance, putAppMaintenance, type ApiError, type Maintenance, type MaintenanceState } from '#lib/api.js';
  import { needsConfirmation } from '#lib/confirm-tiers.js';
  import { focusFormError } from '#lib/focus-error.js';
  import { toast } from '#lib/stores/toast.js';
  import { Alert, Button, ConfirmModal, DateTime, Field, InlineError, Spinner, Switch } from '#lib/components/ui/index.js';
  import ChoiceGroup from '#lib/components/waf-policy/ChoiceGroup.svelte';
  import CodeEditor from '#lib/components/waf-policy/CodeEditor.svelte';
  import { PreviewScheduler } from '#lib/components/waf-policy/responses.js';
  import {
    MAINTENANCE_LIMITS,
    enableConfirmMessage,
    formatKiB,
    formFromMaintenance,
    fromLocalInput,
    isMaintenanceField,
    localInputBounds,
    maintenanceBody,
    maintenanceFromForm,
    maintenanceNotices,
    normalizeMaintenanceState,
    parseLines,
    previewDocument,
    sameSettings,
    savedMessage,
    stripFieldPrefix,
    switchDisabled,
    utf8Bytes,
    validateMaintenance,
    type MaintenanceField,
    type MaintenanceForm,
  } from './maintenance';

  let {
    projectId,
    appId,
    appName = '',
    assigned = true,
    agentName = '',
    agentOnline = undefined,
    canConfigure = false,
    dirty = $bindable(false),
    onchange = undefined,
  }: {
    projectId: string;
    appId: string;
    appName?: string;
    /** A WAF agent serves the application (the tab stays open without one while maintenance is on). */
    assigned?: boolean;
    /** The WAF agent that serves the application, for the messages. */
    agentName?: string;
    /** Whether that agent is connected (undefined: not known). */
    agentOnline?: boolean;
    canConfigure?: boolean;
    /** Unsaved edits; the page asks before leaving the tab. */
    dirty?: boolean;
    /** The switch changed (or was read): the page updates its badge. */
    onchange?: (enabled: boolean) => void;
  } = $props();

  const uid = $props.id();
  const PREVIEW_DELAY_MS = 300;
  const DEVICES = {
    desktop: { width: 1024, height: 640 },
    phone: { width: 390, height: 720 },
  } as const;
  const zone = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch {
      return '';
    }
  })();

  // ── Data ────────────────────────────────────────────────────────────────
  let loaded = $state<MaintenanceState | null>(null);
  let loading = $state(true);
  let loadFailed = $state(false);
  let busy = $state(false);
  let saving = $state(false);
  let epoch = 0;
  let form = $state<MaintenanceForm>(formFromMaintenance(normalizeMaintenanceState(null).maintenance));
  let now = $state(Date.now());

  const stored = $derived(loaded?.maintenance ?? normalizeMaintenanceState(null).maintenance);
  const enabled = $derived(stored.enabled);
  const agent = $derived(agentName || 'The WAF agent');

  async function load() {
    const my = ++epoch;
    const project = projectId;
    const app = appId;
    loading = true;
    loadFailed = false;
    const res = await getAppMaintenance(project, app);
    if (my !== epoch) return;
    loading = false;
    if (res.error || !res.data) {
      loadFailed = true;
      return;
    }
    adopt(normalizeMaintenanceState(res.data), true);
  }

  /** Takes the answer of the server; `resetForm` also replaces the edited values by the stored ones. */
  function adopt(next: MaintenanceState, resetForm: boolean) {
    loaded = next;
    if (resetForm) {
      form = formFromMaintenance(next.maintenance);
      attempted = false;
      enableTried = false;
      touched = {};
      serverError = null;
    }
    onchange?.(next.maintenance.enabled);
  }

  $effect(() => {
    void `${projectId}/${appId}`;
    untrack(() => {
      loaded = null;
      saveError = '';
      confirmOpen = false;
      void load();
    });
    return () => {
      epoch++;
    };
  });

  // Keeps "the end time passed" and the bounds of the end time input current.
  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(timer);
  });

  // ── Form state ──────────────────────────────────────────────────────────
  let attempted = $state(false);
  // Turning on was tried: the checks of a switch that goes on (a stored end time in the past) are shown too.
  let enableTried = $state(false);
  let touched = $state<Partial<Record<MaintenanceField, boolean>>>({});
  let serverError = $state<{ field: MaintenanceField; message: string; sent: string } | null>(null);
  let saveError = $state('');
  let confirmOpen = $state(false);
  let root = $state<HTMLElement>();
  let editor = $state<HTMLElement>();

  const readonly = $derived(!canConfigure);
  const current = $derived(maintenanceFromForm(form, enabled, stored.started_at));
  const errors = $derived(loaded ? validateMaintenance(current, stored, now) : {});
  const enableErrors = $derived(loaded && enableTried && !enabled ? validateMaintenance({ ...current, enabled: true }, stored, now) : {});
  const isDirty = $derived(loaded !== null && !sameSettings(current, stored));
  const invalid = $derived(Object.keys(errors).length > 0);
  const bounds = $derived(localInputBounds(now));
  const notices = $derived(maintenanceNotices({ assigned, enabled, supported: loaded?.agent_supported ?? null, online: agentOnline, canConfigure, endTime: stored.end_time, now }));
  const lockedSwitch = $derived(switchDisabled({ canConfigure, busy, enabled, supported: loaded?.agent_supported ?? null }));
  const clientIp = $derived(loaded?.client_ip ?? '');
  const showMyIp = $derived(Boolean(clientIp) && !parseLines(form.ips).includes(clientIp));
  const kib = $derived(utf8Bytes(form.customHtml.trim() ? form.customHtml : ''));
  const messageChars = $derived([...form.message.trim()].length);

  $effect(() => {
    dirty = isDirty;
  });

  function shown(field: MaintenanceField): string | undefined {
    const own = touched[field] || attempted ? (errors[field] ?? enableErrors[field]) : undefined;
    if (own) return own;
    if (serverError?.field === field && serverError.sent === JSON.stringify(current[field])) return serverError.message;
    return undefined;
  }

  const shownErrors = $derived({
    message: shown('message'),
    end_time: shown('end_time'),
    custom_html: shown('custom_html'),
    allow_ips: shown('allow_ips'),
    allow_paths: shown('allow_paths'),
  });

  function touch(field: MaintenanceField) {
    touched[field] = true;
  }

  async function focusEditor() {
    await tick();
    editor?.querySelector<HTMLElement>('[contenteditable="true"], textarea')?.focus();
  }

  function startFromStandard() {
    form.customHtml = loaded?.stock_html ?? '';
    void focusEditor();
  }

  function addMyIp() {
    const lines = parseLines(form.ips);
    form.ips = [...lines, clientIp].join('\n');
    touch('allow_ips');
  }

  // ── Saving ──────────────────────────────────────────────────────────────
  /** Sends `next`; returns the answer, or null after showing why it failed. */
  async function send(next: Maintenance, owner: 'form' | 'stored'): Promise<MaintenanceState | null> {
    busy = true;
    saveError = '';
    serverError = null;
    const project = projectId;
    const app = appId;
    const my = epoch;
    const res = await putAppMaintenance(project, app, maintenanceBody(next));
    busy = false;
    if (my !== epoch) return null;
    if (res.error || !res.data) {
      refused(res.error, next, owner);
      return null;
    }
    return normalizeMaintenanceState(res.data);
  }

  function refused(error: ApiError | undefined, sent: Maintenance, owner: 'form' | 'stored') {
    const field = error?.field;
    if (error?.code === 'INVALID_MAINTENANCE' && isMaintenanceField(field) && owner === 'form') {
      serverError = { field, message: stripFieldPrefix(error.error, field), sent: JSON.stringify(sent[field]) };
      return;
    }
    if (error?.code === 'MAINTENANCE_UNSUPPORTED' && loaded) loaded = { ...loaded, agent_supported: false };
    saveError = error?.error || 'Could not save the maintenance settings.';
  }

  async function save() {
    if (!canConfigure || busy || !loaded) return;
    attempted = true;
    if (invalid) {
      void focusFormError(root);
      return;
    }
    saving = true;
    const next = await send(current, 'form');
    saving = false;
    if (!next) {
      if (serverError) void focusFormError(root);
      return;
    }
    adopt(next, true);
    toast.success(savedMessage(next.maintenance.enabled), 'Saved');
  }

  function requestToggle(next: boolean) {
    if (lockedSwitch || !loaded) return;
    if (next) void askEnable();
    else void disable();
  }

  async function askEnable() {
    attempted = true;
    enableTried = true;
    saveError = '';
    // The form is checked for a switch that goes on: a stored end time that has passed is refused too.
    const problems = validateMaintenance(maintenanceFromForm(form, true, stored.started_at), stored, Date.now());
    if (Object.keys(problems).length > 0) {
      await focusFormError(root);
      return;
    }
    if (needsConfirmation('enable-maintenance')) confirmOpen = true;
    else void enable();
  }

  async function enable() {
    if (busy || !loaded) return;
    const next = await send(maintenanceFromForm(form, true, stored.started_at), 'form');
    confirmOpen = false;
    if (!next) {
      if (serverError) void focusFormError(root);
      return;
    }
    adopt(next, true);
    toast.success('Maintenance mode is on. Visitors now see the maintenance page.', 'Maintenance on');
  }

  /** Off saves the stored settings, not the form: edits stay unsaved, and an invalid form cannot keep the site down. */
  async function disable() {
    if (busy || !loaded) return;
    const keepEdits = isDirty;
    const next = await send({ ...stored, enabled: false }, 'stored');
    if (!next) return;
    adopt(next, !keepEdits);
    toast.success('Maintenance mode is off. Visitors see the site again.', 'Maintenance off');
  }

  function discard() {
    if (!loaded) return;
    adopt(loaded, true);
    saveError = '';
  }

  // ── Preview ─────────────────────────────────────────────────────────────
  // A phone-sized screen starts with the phone preview: the desktop page would be shrunk to a third there.
  let device = $state<'desktop' | 'phone'>(typeof window !== 'undefined' && window.innerWidth <= 760 ? 'phone' : 'desktop');
  let previewSrc = $state('');
  let stageWidth = $state(0);
  const scheduler = new PreviewScheduler(PREVIEW_DELAY_MS);
  onDestroy(() => scheduler.dispose());

  $effect(() => {
    const state = loaded;
    if (!state) return;
    const source = { message: form.message, end_time: fromLocalInput(form.endLocal), custom_html: form.page === 'custom' ? form.customHtml : '' };
    scheduler.schedule(form.page, () =>
      untrack(() => {
        previewSrc = previewDocument(source, state, Date.now());
      }),
    );
  });

  const frame = $derived(DEVICES[device]);
  // The page is drawn at the width of the device and shrunk to the room there is (the frame has a 1px border).
  const scale = $derived(stageWidth > 2 ? Math.min(1, (stageWidth - 2) / frame.width) : 1);

  const pageOptions = [
    { value: 'standard' as const, label: 'Standard page', description: 'Shows your message and the expected end time.' },
    { value: 'custom' as const, label: 'Custom HTML', description: 'Your own page, served as written.' },
  ];
  const deviceOptions = [
    { value: 'desktop' as const, label: 'Desktop' },
    { value: 'phone' as const, label: 'Phone' },
  ];
  const endHint = $derived(
    `${zone ? `In your time zone (${zone}).` : 'In your time zone.'} Visitors see it in theirs, and browsers and search engines get it as Retry-After. Maintenance does not end by itself: turn it off when you are done.`,
  );
  const confirmText = $derived(enableConfirmMessage({ noAllowedIps: parseLines(form.ips).length === 0, unsaved: isDirty }));
  const footerNote = $derived(busy ? 'Saving…' : isDirty && invalid ? 'Fix the marked fields to save.' : isDirty ? 'Unsaved changes' : '');
</script>

<section class="mt" aria-labelledby="{uid}-title">
  <header class="mt-head">
    <h2 id="{uid}-title">Maintenance mode</h2>
    <p>Show visitors a maintenance page instead of the site while you work on it. The WAF agent answers every request itself, so nothing reaches your upstream.</p>
  </header>

  {#if loading && !loaded}
    <Spinner layout="block" tone="accent" label="Loading the maintenance settings" />
  {:else if !loaded || loadFailed}
    <InlineError message="Could not load the maintenance settings." onretry={() => void load()} retrying={loading} />
  {:else}
    {#if notices.length > 0}
      <div class="mt-notices">
        {#each notices as notice (notice)}
          {#if notice === 'unassigned'}
            <Alert tone="info" message="No WAF agent serves this application. These settings take effect once one is assigned on the Assignment tab." />
          {:else if notice === 'unsupported-off'}
            <Alert tone="warning" message={`${agent} does not support maintenance mode. Upgrade the WAF agent to the latest release, then turn it on here.`} />
          {:else if notice === 'unsupported-on'}
            <Alert tone="error" message={`Maintenance mode is on, but ${agentName || 'the WAF agent'} does not support it, so visitors still see the site. Upgrade the WAF agent or turn maintenance mode off.`} />
          {:else if notice === 'offline'}
            <Alert tone="info" message={`${agent} is offline. The change takes effect when it reconnects.`} />
          {:else if notice === 'end-passed'}
            <Alert tone="warning">
              <p>The expected end time passed <DateTime value={stored.end_time} />. Visitors still see the maintenance page until you turn maintenance mode off.</p>
            </Alert>
          {:else if notice === 'readonly'}
            <Alert tone="info" message="Read-only: changing maintenance mode needs member or owner access." />
          {/if}
        {/each}
      </div>
    {/if}

    <div class="mt-status" class:is-on={enabled}>
      <Switch
        bind:checked={() => enabled, requestToggle}
        label="Maintenance mode"
        hint={enabled ? undefined : 'Off. Visitors see the site as usual. The standard page works without any changes below.'}
        disabled={lockedSwitch}
      >
        {#if enabled}
          <p class="mt-on">
            On since <DateTime value={stored.started_at} />. Visitors see the maintenance page.
            {#if stored.end_time}Expected back <DateTime value={stored.end_time} />.{/if}
          </p>
        {/if}
      </Switch>
      {#if enableTried && !enabled && !confirmOpen && (invalid || Object.keys(enableErrors).length > 0)}
        <InlineError message="Maintenance mode is still off. Fix the marked fields first." />
      {/if}
    </div>

    <div class="mt-columns">
      <div class="mt-form" bind:this={root}>
        <fieldset class="mt-fieldset" disabled={readonly}>
          <section class="mt-block" aria-labelledby="{uid}-page">
            <h3 id="{uid}-page">Visitor page</h3>
            <ChoiceGroup legend="Page" name="{uid}-page" options={pageOptions} bind:value={form.page} columns={2} disabled={readonly} />
            {#if form.page === 'standard' && stored.custom_html.trim()}
              <p class="mt-note">Saving with the standard page removes your custom HTML.</p>
            {/if}

            <div class="mt-field" onfocusout={() => touch('message')}>
              <Field label="Message" optional error={shownErrors.message} hint="Plain text. Leave empty to use the text shown.">
                {#snippet labelExtra()}
                  <span class="mt-count" class:is-over={messageChars > MAINTENANCE_LIMITS.messageChars}>{messageChars} / {MAINTENANCE_LIMITS.messageChars}</span>
                {/snippet}
                {#snippet children(c)}
                  <textarea {...c} rows="3" placeholder={loaded?.default_message} bind:value={form.message}></textarea>
                {/snippet}
              </Field>
            </div>

            <div class="mt-field" onfocusout={() => touch('end_time')}>
              <Field label="Expected end" optional error={shownErrors.end_time} hint={endHint}>
                {#snippet children(c)}
                  <div class="mt-end">
                    <input {...c} type="datetime-local" min={bounds.min} max={bounds.max} bind:value={form.endLocal} />
                    <Button variant="secondary" class="mt-tap" disabled={readonly || !form.endLocal} onclick={() => (form.endLocal = '')}>Clear<span class="sr-only"> expected end</span></Button>
                  </div>
                {/snippet}
              </Field>
            </div>

            {#if form.page === 'custom'}
              <div class="mt-field" onfocusout={() => touch('custom_html')} bind:this={editor}>
                <Field
                  group
                  label="Custom HTML"
                  error={shownErrors.custom_html}
                  hint="Up to 64 KiB. Images, styles and scripts loaded from this application's own address get the maintenance page too: inline them or load them from another host."
                >
                  {#snippet children()}
                    <div class="mt-editor-tools">
                      {#if !form.customHtml.trim() && !readonly}
                        <Button variant="ghost" size="sm" class="mt-tap" onclick={startFromStandard}>Start from the standard page</Button>
                      {/if}
                      <span class="mt-count" class:is-over={kib > MAINTENANCE_LIMITS.customHtmlBytes}>{formatKiB(kib)} KiB of 64 KiB</span>
                    </div>
                    <div class="mt-editor">
                      <CodeEditor
                        language="html"
                        label="Custom HTML"
                        {readonly}
                        placeholder="Empty: the standard maintenance page is used."
                        bind:value={form.customHtml}
                      />
                    </div>
                  {/snippet}
                </Field>
                <div class="mt-tokens">
                  <p class="mt-tokens-title">Placeholders</p>
                  <dl>
                    <div><dt><code>{'{{WAFIO_MESSAGE}}'}</code></dt><dd>your message</dd></div>
                    <div><dt><code>{'{{WAFIO_END_TIME}}'}</code></dt><dd>expected end in UTC, empty when not set</dd></div>
                  </dl>
                </div>
              </div>
            {/if}
            <p class="mt-note">API clients that ask for JSON or XML get a 503 response in that format with the same message and end time.</p>
          </section>

          <section class="mt-block" aria-labelledby="{uid}-through">
            <h3 id="{uid}-through">Who still gets through</h3>

            <div class="mt-field" onfocusout={() => touch('allow_ips')}>
              <Field
                label="Allowed IP addresses"
                optional
                error={shownErrors.allow_ips}
                hint={`One IP address or CIDR range per line, up to ${MAINTENANCE_LIMITS.allowIps}. These visitors see the real site, still protected by the WAF.`}
              >
                {#snippet children(c)}
                  <textarea {...c} class="mono" rows="3" spellcheck="false" autocomplete="off" placeholder={'203.0.113.7\n10.0.0.0/8'} bind:value={form.ips}></textarea>
                {/snippet}
              </Field>
            </div>
            {#if showMyIp && !readonly}
              <div class="mt-myip">
                <Button variant="ghost" class="mt-tap mt-link" onclick={addMyIp}>Add my IP address ({clientIp})</Button>
                <p class="mt-note">Your address as the control plane sees it. If you reach the site through a VPN or another network, add that address instead.</p>
              </div>
            {/if}

            <div class="mt-field" onfocusout={() => touch('allow_paths')}>
              <Field
                label="Allowed paths"
                optional
                error={shownErrors.allow_paths}
                hint={`One path per line, up to ${MAINTENANCE_LIMITS.allowPaths}. Requests to these paths and anything below them reach the site as usual, for example health checks and payment webhooks.`}
              >
                {#snippet children(c)}
                  <textarea {...c} class="mono" rows="3" spellcheck="false" autocomplete="off" placeholder={'/healthz\n/api/payments/webhook'} bind:value={form.paths}></textarea>
                {/snippet}
              </Field>
            </div>
          </section>
        </fieldset>
      </div>

      <section class="mt-preview" aria-labelledby="{uid}-preview">
        <div class="mt-preview-head">
          <h3 id="{uid}-preview">Preview</h3>
          <div class="mt-sizes">
            <ChoiceGroup legend="Preview size" name="{uid}-device" options={deviceOptions} bind:value={device} compact />
          </div>
        </div>
        <div class="mt-stage" bind:clientWidth={stageWidth}>
          <div class="mt-device" style:width="{frame.width * scale}px" style:height="{frame.height * scale}px">
            <iframe
              class="mt-frame"
              title="Maintenance page preview"
              srcdoc={previewSrc}
              sandbox="allow-scripts"
              style:width="{frame.width}px"
              style:height="{frame.height}px"
              style:transform="scale({scale})"
            ></iframe>
          </div>
        </div>
        <p class="mt-caption">What visitors see, with HTTP status 503. Never cached.</p>
      </section>
    </div>

    {#if saveError}
      <Alert tone="error" title="Not saved" message={saveError} />
    {/if}

    <div class="mt-actions">
      <span class="mt-dirty" role="status">{footerNote}</span>
      <Button variant="secondary" class="mt-tap" disabled={!isDirty || busy || readonly} onclick={discard}>Discard changes</Button>
      <Button class="mt-tap" loading={saving} disabled={!isDirty || invalid || busy || readonly} onclick={() => void save()}>Save changes</Button>
    </div>
  {/if}
</section>

<ConfirmModal
  open={confirmOpen}
  tone="warning"
  title={`Turn on maintenance mode for ${appName || 'this application'}?`}
  message={confirmText}
  confirmLabel="Turn on maintenance"
  cancelLabel="Cancel"
  loading={busy}
  onconfirm={() => void enable()}
  onclose={() => (confirmOpen = false)}
/>

<style>
  .mt { display: flex; flex-direction: column; gap: var(--sp-4); width: 100%; min-width: 0; container-type: inline-size; }
  .mt-head h2 { margin: 0; font-size: var(--fs-md); }
  .mt-head p { margin: var(--sp-1) 0 0; font-size: var(--fs-sm); color: var(--text-muted); max-width: 70ch; line-height: 1.5; }
  .mt-notices { display: flex; flex-direction: column; gap: var(--sp-2); }

  .mt-status {
    padding: var(--sp-1) var(--sp-4) var(--sp-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--bg-card);
  }
  .mt-status.is-on { border-color: var(--warning); background: color-mix(in srgb, var(--warning) 7%, var(--bg-card)); }
  .mt-on { margin: var(--sp-1) 0 0; font-size: var(--fs-sm); line-height: 1.5; color: var(--text-secondary); }

  /* The form and the preview side by side once the panel is 900px wide; the sidebar takes part of the window. */
  .mt-columns { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--sp-5); align-items: start; }
  @container (min-width: 900px) {
    .mt-columns { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
    .mt-preview { position: sticky; top: calc(var(--header-height) + var(--sp-4)); }
  }
  .mt-form { min-width: 0; }
  .mt-fieldset { display: flex; flex-direction: column; gap: var(--sp-5); border: 0; padding: 0; margin: 0; min-width: 0; }
  .mt-block { display: flex; flex-direction: column; gap: var(--sp-4); min-width: 0; padding-top: var(--sp-5); border-top: 1px solid var(--border); }
  .mt-block:first-child { padding-top: 0; border-top: 0; }
  .mt-block h3, .mt-preview h3 { margin: 0; font-size: var(--fs-base); font-weight: var(--fw-semibold); color: var(--text-primary); }
  .mt-field { min-width: 0; }
  .mt-note { margin: 0; font-size: var(--fs-sm); color: var(--text-muted); line-height: 1.5; }
  .mt-count { font-size: var(--fs-xs); color: var(--text-muted); font-variant-numeric: tabular-nums; }
  .mt-count.is-over { color: var(--danger); font-weight: var(--fw-medium); }

  .mt-form textarea { resize: vertical; line-height: 1.5; font-family: inherit; }
  .mt-form textarea.mono { font-family: var(--font-mono); font-size: var(--fs-sm); }
  .mt-end { display: flex; gap: var(--sp-2); align-items: center; flex-wrap: wrap; }
  .mt-end input { flex: 1 1 14rem; max-width: 20rem; width: auto; }

  .mt-editor-tools { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); min-height: 2rem; margin-bottom: var(--sp-1); }
  .mt-editor-tools .mt-count { margin-left: auto; }
  .mt-editor { height: 22rem; min-width: 0; }
  .mt-tokens { margin-top: var(--sp-3); font-size: var(--fs-sm); color: var(--text-muted); }
  .mt-tokens-title { margin: 0 0 var(--sp-1); font-weight: var(--fw-medium); color: var(--text-secondary); }
  .mt-tokens dl { margin: 0; display: flex; flex-direction: column; gap: var(--sp-1); }
  .mt-tokens dl > div { display: flex; flex-wrap: wrap; gap: var(--sp-1) var(--sp-3); align-items: baseline; }
  .mt-tokens dt { margin: 0; }
  .mt-tokens dd { margin: 0; }
  .mt-tokens code { font-family: var(--font-mono); font-size: var(--fs-xs); padding: 0 var(--sp-1); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text-primary); background: var(--bg-secondary); overflow-wrap: anywhere; }
  .mt :global(.mt-link) { padding-inline: 0; color: var(--accent); }
  .mt :global(.mt-link:hover:not(:disabled)) { background: transparent; color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
  .mt-myip { display: flex; flex-direction: column; align-items: flex-start; gap: var(--sp-1); margin-top: calc(var(--sp-2) * -1); }

  .mt-preview { display: flex; flex-direction: column; gap: var(--sp-3); min-width: 0; }
  .mt-preview-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--sp-2) var(--sp-4); }
  /* The legend is for assistive technology; the two options say what they are. */
  .mt-sizes :global(.wp-choice-legend) { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
  .mt-stage { min-width: 0; }
  .mt-device { position: relative; max-width: 100%; margin-inline: auto; overflow: hidden; border: 1px solid var(--border-strong); border-radius: var(--radius-lg); background: var(--bg-primary); box-sizing: content-box; }
  .mt-frame { position: absolute; top: 0; left: 0; border: 0; transform-origin: top left; background: var(--bg-primary); }
  .mt-caption { margin: 0; font-size: var(--fs-sm); color: var(--text-muted); }

  .mt-actions {
    position: sticky;
    bottom: 0;
    z-index: 5;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--sp-2);
    flex-wrap: wrap;
    padding: var(--sp-3) var(--sp-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--bg-elevated);
    box-shadow: var(--shadow-md);
  }
  .mt-dirty { margin-right: auto; font-size: var(--fs-sm); color: var(--text-muted); }

  @media (max-width: 760px) {
    .mt-actions { flex-direction: column-reverse; align-items: stretch; }
    .mt-dirty { margin-right: 0; text-align: center; }
    .mt :global(.mt-tap) { min-height: 44px; }
    .mt-end input { max-width: none; }
  }
</style>
