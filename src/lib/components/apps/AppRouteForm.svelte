<!--
  AppRouteForm: the one routing form for an application:
  "Add application" on a WAF agent, "New application" on Applications and
  the Routing tab of the application page.

  Typed model (route-model.ts), per-field validation with an error summary,
  DurationInput (with Unlimited) for timeouts, ByteSizeInput for sizes, a
  header rules editor, and ProtectionModeSelect. Lowering protection
  (Block → Monitor) asks for confirmation before `onsubmit` runs.

  `dirty` (bindable) reports unsaved edits; the parent guards navigation.
  When `initial` changes (after a save or reload) the form resets to it.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { untrack } from 'svelte';
  import { Alert, Button, ConfirmModal, Field, Switch } from '#lib/components/ui/index.js';
  import { createDirtyTracker } from '#lib/dirty.svelte.js';
  import { tierForProtectionMode } from '#lib/confirm-tiers.js';
  import { focusFormError } from '#lib/focus-error.js';
  import DurationInput from './DurationInput.svelte';
  import ByteSizeInput from './ByteSizeInput.svelte';
  import HeaderRulesEditor from './HeaderRulesEditor.svelte';
  import PartStatus from './PartStatus.svelte';
  import ProtectionModeSelect from './ProtectionModeSelect.svelte';
  import type { PartLine } from './speed';
  import Select from '#lib/components/ui/Select.svelte';
  import {
    CLOUDFLARE_CONFIRM_TEXT,
    DEFAULT_FCGI_INDEX,
    PROXY_DEFAULTS,
    PROXY_LIMITS,
    cloneRouteForm,
    cloudflareHint,
    hasProxyErrors,
    listenLabel,
    proxyErrorField,
    replacesTrust,
    routeErrorList,
    validateRouteForm,
    withCloudflare,
    type HostHeaderMode,
    type RouteErrors,
    type RouteField,
    type RouteForm,
  } from './route-model';

  let {
    initial,
    submitLabel = 'Save',
    savingLabel = 'Saving…',
    showMode = true,
    modeHint = undefined,
    requireRouting = true,
    creating = false,
    disabled = false,
    hiddenHeaderValues = false,
    prefixLine = null,
    prefixLocked = false,
    dirty = $bindable(false),
    onsubmit,
    oncancel = undefined,
    cancelLabel = 'Cancel',
    before = undefined,
  }: {
    initial: RouteForm;
    submitLabel?: string;
    savingLabel?: string;
    /** The protection mode is editable (the app is, or will be, bound to an agent). */
    showMode?: boolean;
    /** Shown instead of the mode choice when `showMode` is false. */
    modeHint?: string;
    /** Upstream and port are required (a served route); false allows drafts. */
    requireRouting?: boolean;
    /** A new application: there is no saved mode, so choosing Monitor lowers nothing. */
    creating?: boolean;
    /** Read-only access: the form is shown but cannot be changed or saved. */
    disabled?: boolean;
    /** Viewer read: header values were blanked by the server; show them as hidden. */
    hiddenHeaderValues?: boolean;
    /** What the agent says about the path prefix (the Routing tab of an assigned application). */
    prefixLine?: PartLine | null;
    /** The agent is too old for a path prefix and none is saved: the field cannot be filled in. */
    prefixLocked?: boolean;
    dirty?: boolean;
    /** Saves the form; resolves to an error message, or nothing on success. */
    onsubmit: (form: RouteForm) => Promise<string | null | void>;
    oncancel?: () => void;
    cancelLabel?: string;
    /** Extra fields before the routing fields (e.g. the agent picker on create). */
    before?: Snippet;
  } = $props();

  const uid = $props.id();
  const fid = (field: RouteField) => `${uid}-${field.replace('.', '-')}`;

  let form = $state<RouteForm>(cloneRouteForm(untrack(() => initial)));
  const tracker = createDirtyTracker(() => form);

  let submitted = $state(false);
  let saving = $state(false);
  let submitError = $state('');
  // The path prefix sits in the folded proxy settings: a saved one, or one its agent could not take (the line can
  // arrive after the first read), opens them. Once open they stay as the person leaves them.
  let advancedOpen = $state(untrack(() => initial.proxy.stripPathPrefix !== '' || prefixLine?.tone === 'warning'));
  const prefixWarns = $derived(prefixLine?.tone === 'warning');
  $effect(() => {
    if (prefixWarns) advancedOpen = true;
  });
  let confirmLowerOpen = $state(false);
  let confirmCloudflareOpen = $state(false);
  /** Field errors from a 400 INVALID_PROXY_CONFIG; cleared when the field changes. */
  let serverErrors = $state<RouteErrors>({});
  let serverErrorsFor = '';

  // A new `initial` (saved or reloaded) replaces the form and the baseline.
  // Callers pass a stable object (state set on load/save), never a literal.
  $effect.pre(() => {
    const next = initial;
    untrack(() => {
      form = cloneRouteForm(next);
      tracker.reset();
      submitted = false;
      submitError = '';
      serverErrors = {};
    });
  });

  $effect(() => {
    const text = form.proxy.trustedProxies;
    untrack(() => {
      if (serverErrors['proxy.trustedProxies'] && text !== serverErrorsFor) serverErrors = {};
    });
  });

  $effect(() => {
    dirty = tracker.isDirty;
  });

  const errors: RouteErrors = $derived(validateRouteForm(form, { requireRouting }));
  const shown: RouteErrors = $derived(submitted ? errors : {});
  const errorList = $derived(routeErrorList(shown));
  const lowering = $derived(showMode && !creating && tierForProtectionMode(initial.mode, form.mode) !== 'none');

  function setUpstreamType(type: RouteForm['upstreamType']) {
    if (form.upstreamType === type) return;
    form.upstreamType = type;
    if (type === 'fcgi' && !form.fcgiIndex) form.fcgiIndex = DEFAULT_FCGI_INDEX;
  }

  function askCloudflare() {
    if (replacesTrust(form.proxy)) confirmCloudflareOpen = true;
    else useCloudflare();
  }

  /** Replaces the list with Cloudflare's addresses and loopback and trusts forwarded headers; saved with the form like any edit. */
  function useCloudflare() {
    form.proxy = withCloudflare(form.proxy);
    confirmCloudflareOpen = false;
  }

  function parseWhole(text: string): number | null {
    const t = text.trim();
    if (t === '') return null;
    return /^\d+$/.test(t) ? Number(t) : Number.NaN;
  }

  function focusField(field: RouteField) {
    if (field.startsWith('proxy.')) advancedOpen = true;
    queueMicrotask(() => {
      const el = document.getElementById(fid(field)) ?? document.querySelector<HTMLElement>(`[data-field="${field}"] input, [data-field="${field}"] [role="combobox"]`);
      el?.focus();
    });
  }

  const HOST_MODES: { value: HostHeaderMode; label: string }[] = [
    { value: 'preserve', label: 'Preserve the incoming Host' },
    { value: 'upstream', label: 'Use the upstream host' },
    { value: 'custom', label: 'Custom value' },
  ];

  async function submit(event?: SubmitEvent) {
    event?.preventDefault();
    if (disabled || saving) return;
    submitted = true;
    submitError = '';
    const list = routeErrorList(errors);
    if (list.length > 0) {
      if (hasProxyErrors(errors)) advancedOpen = true;
      focusField(list[0].field);
      return;
    }
    if (lowering) {
      confirmLowerOpen = true;
      return;
    }
    await save();
  }

  let formEl = $state<HTMLFormElement>();

  async function save() {
    saving = true;
    let failed = false;
    try {
      const problem = await onsubmit(cloneRouteForm(form));
      const field = proxyErrorField(problem || null);
      if (problem && field) {
        // 400 INVALID_PROXY_CONFIG naming a field: show it on the field.
        serverErrors = { [field]: problem };
        serverErrorsFor = form.proxy.trustedProxies;
        focusField(field);
      } else if (problem) {
        submitError = problem;
        failed = true;
      }
    } finally {
      saving = false;
      confirmLowerOpen = false;
    }
    // After the fieldset is enabled again: focus the error, not the button.
    if (failed) void focusFormError(formEl);
  }
</script>

<form class="route-form" novalidate onsubmit={submit} bind:this={formEl}>
  <fieldset class="route-fieldset" disabled={disabled || saving}>
    {#if errorList.length > 0}
      <Alert tone="error" title={`Fix ${errorList.length === 1 ? 'this field' : `these ${errorList.length} fields`} before saving`}>
        <ul class="route-error-list">
          {#each errorList as item (item.field)}
            <li><a href={`#${fid(item.field)}`} onclick={(event) => { event.preventDefault(); focusField(item.field); }}>{item.label}</a>: {item.message}</li>
          {/each}
        </ul>
      </Alert>
    {/if}

    {@render before?.()}

    <div class="route-sections">
      <section class="route-section" aria-labelledby={`${uid}-sec-app`}>
        <h3 id={`${uid}-sec-app`}>Application</h3>
        <div class="route-grid">
          <div class="span-full">
            <Field label="Name" id={fid('name')} required error={shown.name} hint="Shown in the application list and in audit entries.">
              {#snippet children(c)}<input {...c} type="text" maxlength="64" autocomplete="off" placeholder="checkout-api" bind:value={form.name} />{/snippet}
            </Field>
          </div>
        </div>
      </section>

      <section class="route-section" aria-labelledby={`${uid}-sec-upstream`}>
        <h3 id={`${uid}-sec-upstream`}>Upstream</h3>
        <div class="route-grid">
          <fieldset class="span-full upstream-type">
            <legend>Upstream type</legend>
            <div class="segmented">
              <label class:active={form.upstreamType === 'http'}>
                <input type="radio" name={`${uid}-upstream-type`} value="http" checked={form.upstreamType === 'http'} onchange={() => setUpstreamType('http')} />
                HTTP or unix socket
              </label>
              <label class:active={form.upstreamType === 'fcgi'}>
                <input type="radio" name={`${uid}-upstream-type`} value="fcgi" checked={form.upstreamType === 'fcgi'} onchange={() => setUpstreamType('fcgi')} />
                FastCGI (PHP-FPM)
              </label>
            </div>
          </fieldset>

          <div class="span-full">
            <Field
              label={form.upstreamType === 'fcgi' ? 'FastCGI address' : 'Upstream URL'}
              id={fid('upstreamAddr')}
              required={requireRouting}
              optional={!requireRouting}
              error={shown.upstreamAddr}
              hint={form.upstreamType === 'fcgi'
                ? 'unix:/run/php/php-fpm.sock or 127.0.0.1:9000. Allowed requests are passed to PHP-FPM.'
                : 'http:// or https:// URL, or unix:/run/app.sock. Allowed requests are forwarded here.'}
            >
              {#snippet children(c)}
                <input
                  {...c}
                  type="text"
                  autocomplete="off"
                  spellcheck="false"
                  class="mono"
                  placeholder={form.upstreamType === 'fcgi' ? '127.0.0.1:9000' : 'http://127.0.0.1:3000'}
                  bind:value={form.upstreamAddr}
                />
              {/snippet}
            </Field>
          </div>

          {#if form.upstreamType === 'fcgi'}
            <Field label="Document root" id={fid('fcgiDocRoot')} required error={shown.fcgiDocRoot} hint="Base path of SCRIPT_FILENAME.">
              {#snippet children(c)}<input {...c} type="text" class="mono" autocomplete="off" placeholder="/var/www/html" bind:value={form.fcgiDocRoot} />{/snippet}
            </Field>
            <Field label="Index file" id={fid('fcgiIndex')} error={shown.fcgiIndex} hint={`Default: ${DEFAULT_FCGI_INDEX}.`}>
              {#snippet children(c)}<input {...c} type="text" class="mono" autocomplete="off" placeholder={DEFAULT_FCGI_INDEX} bind:value={form.fcgiIndex} />{/snippet}
            </Field>
            <div class="span-full">
              <Switch
                bind:checked={form.fcgiKeepConn}
                label="Keep FastCGI connections open between requests"
                hint="Same as nginx fastcgi_keep_conn. Off, the agent opens a new connection to PHP-FPM for each request. Turn it on only if PHP is at least 8.2.36, 8.3.37, 8.4.28 or 8.5.13 for its 8.2, 8.3, 8.4 or 8.5 series; 8.1 and older are not fixed. Unfixed PHP-FPM can run part of a request body as a second request (CVE-2026-129289). Agents released before this option ignore it and keep connections open."
              />
            </div>
          {/if}
        </div>
      </section>

      <section class="route-section" aria-labelledby={`${uid}-sec-listener`}>
        <h3 id={`${uid}-sec-listener`}>Listener</h3>
        <div class="route-grid">
          <Field label="Listen address" id={fid('listenHost')} optional error={shown.listenHost} hint="IP the agent binds to. Empty listens on all interfaces (0.0.0.0).">
            {#snippet children(c)}<input {...c} type="text" class="mono" autocomplete="off" placeholder="0.0.0.0" bind:value={form.listenHost} />{/snippet}
          </Field>
          <Field label="Listen port" id={fid('listenPort')} required={requireRouting} optional={!requireRouting} error={shown.listenPort} hint={form.listenPort ? `Agent listens on ${listenLabel(form.listenHost, form.listenPort)}.` : 'Port 1–65535.'}>
            {#snippet children(c)}
              <input
                {...c}
                type="text"
                inputmode="numeric"
                autocomplete="off"
                placeholder="8080"
                value={form.listenPort === null || Number.isNaN(form.listenPort) ? '' : String(form.listenPort)}
                oninput={(event) => (form.listenPort = parseWhole(event.currentTarget.value))}
              />
            {/snippet}
          </Field>
        </div>
      </section>
    </div>

    {#if showMode}
      <section class="route-section">
        <ProtectionModeSelect bind:value={form.mode} previous={creating ? undefined : initial.mode} disabled={disabled || saving} />
      </section>
    {:else if modeHint}
      <p class="route-note">{modeHint}</p>
    {/if}

    <details class="advanced" bind:open={advancedOpen}>
      <summary>
        Proxy settings
        <span class="advanced-summary">Timeouts, size limits, Host header, path prefix, forwarded headers, header rules, path encoding</span>
      </summary>
      <div class="advanced-body">
        <section class="advanced-group" aria-labelledby={`${uid}-timeouts`}>
          <h4 id={`${uid}-timeouts`}>Timeouts</h4>
          <p class="group-hint">Empty uses the agent default. Unlimited removes the deadline.</p>
          <div class="route-grid">
            <Field label="Upstream timeout" id={fid('proxy.upstreamMs')} error={shown['proxy.upstreamMs']} hint="Whole upstream exchange (HTTP and FastCGI).">
              {#snippet children(c)}
                <DurationInput
                  control={c}
                  label="Upstream timeout"
                  bind:value={form.proxy.upstreamMs}
                  defaultMs={PROXY_DEFAULTS.upstreamMs}
                  allowUnlimited
                  unlimitedWarning="No deadline: a hung backend holds this connection (and a PHP-FPM worker) until it responds or the client disconnects."
                />
              {/snippet}
            </Field>
            <Field label="Connect timeout" id={fid('proxy.connectMs')} error={shown['proxy.connectMs']} hint="Establishing the upstream connection.">
              {#snippet children(c)}<DurationInput control={c} label="Connect timeout" bind:value={form.proxy.connectMs} allowUnlimited />{/snippet}
            </Field>
            <Field label="Read timeout" id={fid('proxy.readMs')} error={shown['proxy.readMs']} hint="Reading the client request.">
              {#snippet children(c)}<DurationInput control={c} label="Read timeout" bind:value={form.proxy.readMs} defaultMs={PROXY_DEFAULTS.readMs} allowUnlimited />{/snippet}
            </Field>
            <Field label="Write timeout" id={fid('proxy.writeMs')} error={shown['proxy.writeMs']} hint="Writing the response to the client.">
              {#snippet children(c)}<DurationInput control={c} label="Write timeout" bind:value={form.proxy.writeMs} defaultMs={PROXY_DEFAULTS.writeMs} allowUnlimited />{/snippet}
            </Field>
          </div>
        </section>

        <section class="advanced-group" aria-labelledby={`${uid}-limits`}>
          <h4 id={`${uid}-limits`}>Limits and connection pool</h4>
          <div class="route-grid">
            <Field label="Max body size" id={fid('proxy.maxBodyBytes')} error={shown['proxy.maxBodyBytes']} hint="Larger request bodies are rejected. 1 KiB – 1 GiB.">
              {#snippet children(c)}<ByteSizeInput control={c} bind:value={form.proxy.maxBodyBytes} />{/snippet}
            </Field>
            <Field label="Max upstream connections" id={fid('proxy.maxConns')} error={shown['proxy.maxConns']} hint={`1 – ${PROXY_LIMITS.connsMax}. Default ${PROXY_DEFAULTS.maxConns}.`}>
              {#snippet children(c)}
                <input
                  {...c}
                  type="text"
                  inputmode="numeric"
                  autocomplete="off"
                  value={Number.isNaN(form.proxy.maxConns) ? '' : String(form.proxy.maxConns)}
                  oninput={(event) => (form.proxy.maxConns = parseWhole(event.currentTarget.value) ?? Number.NaN)}
                />
              {/snippet}
            </Field>
            <Field label="Connection wait timeout" id={fid('proxy.connWaitMs')} error={shown['proxy.connWaitMs']} hint="Waiting for a free upstream connection.">
              {#snippet children(c)}<DurationInput control={c} label="Connection wait timeout" bind:value={form.proxy.connWaitMs} defaultMs={PROXY_DEFAULTS.connWaitMs} />{/snippet}
            </Field>
            <Field label="Idle connection timeout" id={fid('proxy.idleConnMs')} error={shown['proxy.idleConnMs']} hint="Idle upstream connections are closed after this.">
              {#snippet children(c)}<DurationInput control={c} label="Idle connection timeout" bind:value={form.proxy.idleConnMs} defaultMs={PROXY_DEFAULTS.idleConnMs} />{/snippet}
            </Field>
            <Field label="Read buffer" id={fid('proxy.readBuf')} error={shown['proxy.readBuf']} hint="1 KiB – 1 MiB. Default 16 KiB.">
              {#snippet children(c)}<ByteSizeInput control={c} bind:value={form.proxy.readBuf} placeholder="16 KiB" />{/snippet}
            </Field>
            <Field label="Write buffer" id={fid('proxy.writeBuf')} error={shown['proxy.writeBuf']} hint="1 KiB – 1 MiB. Default 16 KiB.">
              {#snippet children(c)}<ByteSizeInput control={c} bind:value={form.proxy.writeBuf} placeholder="16 KiB" />{/snippet}
            </Field>
          </div>
        </section>

        <section class="advanced-group" aria-labelledby={`${uid}-headers`}>
          <h4 id={`${uid}-headers`}>Headers</h4>
          <div class="route-grid">
            <Field label="Host header sent upstream">
              {#snippet children(c)}
                <Select {...c} options={HOST_MODES} bind:value={form.proxy.hostMode} />
              {/snippet}
            </Field>
            {#if form.proxy.hostMode === 'custom'}
              <Field label="Custom Host value" id={fid('proxy.hostValue')} required error={shown['proxy.hostValue']}>
                {#snippet children(c)}<input {...c} type="text" class="mono" autocomplete="off" placeholder="api.example.com" bind:value={form.proxy.hostValue} />{/snippet}
              </Field>
            {/if}
            <div class="span-full">
              <Field
                label="Remove path prefix"
                id={fid('proxy.stripPathPrefix')}
                error={shown['proxy.stripPathPrefix']}
                hint="For an application that lives under a path. With /shop, a visit to /shop/cart reaches the application as /cart, and any other path, such as /admin, gets Not found. WAFio still checks and logs the full path. Links the application writes must include /shop."
              >
                {#snippet children(c)}
                  <input {...c} type="text" class="mono" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="/shop" disabled={prefixLocked} bind:value={form.proxy.stripPathPrefix} />
                {/snippet}
              </Field>
              <PartStatus line={prefixLine} />
            </div>
            <div class="span-full">
              <Switch bind:checked={form.proxy.trustForwarded} label="Trust X-Forwarded-For and X-Real-IP" hint="Turn on only when a load balancer or proxy sits in front of the agent. Off, the client IP comes from the TCP connection, so a client cannot spoof its address for IP rules, bans and rate limits." />
            </div>
            <div class="span-full">
              <Field
                label="Trusted proxies"
                id={fid('proxy.trustedProxies')}
                error={shown['proxy.trustedProxies'] ?? serverErrors['proxy.trustedProxies']}
                hint={form.proxy.trustForwarded
                  ? `IP addresses or CIDR ranges of your proxies, one per line (at most ${PROXY_LIMITS.maxTrustedProxies}). Forwarded headers are read only from these peers. Empty = loopback and private ranges (10/8, 172.16/12, 192.168/16, fc00::/7), which also covers Docker and Kubernetes NAT addresses: any container on those networks could then set the client IP, so list your proxies.`
                  : 'Used only while forwarded headers are trusted.'}
              >
                {#snippet children(c)}
                  <textarea
                    {...c}
                    class="mono proxies"
                    rows="3"
                    spellcheck="false"
                    autocomplete="off"
                    placeholder={'10.0.0.5\n192.0.2.0/24'}
                    disabled={!form.proxy.trustForwarded}
                    bind:value={form.proxy.trustedProxies}
                  ></textarea>
                {/snippet}
              </Field>
              <div class="cloudflare">
                <Button variant="secondary" onclick={askCloudflare}>Use Cloudflare's addresses</Button>
                <p class="route-note">{cloudflareHint()}</p>
              </div>
            </div>
            <div class="span-full" data-field="proxy.reqHeaders" id={fid('proxy.reqHeaders')}>
              <HeaderRulesEditor bind:rules={form.proxy.reqHeaders} legend="Request headers" hint="Changes applied to requests before they reach the upstream." error={shown['proxy.reqHeaders']} hiddenValues={hiddenHeaderValues} />
            </div>
            <div class="span-full" data-field="proxy.respHeaders" id={fid('proxy.respHeaders')}>
              <HeaderRulesEditor bind:rules={form.proxy.respHeaders} legend="Response headers" hint="Changes applied to responses before they reach the client." error={shown['proxy.respHeaders']} hiddenValues={hiddenHeaderValues} />
            </div>
          </div>
        </section>

        <section class="advanced-group" aria-labelledby={`${uid}-paths`}>
          <h4 id={`${uid}-paths`}>Request paths</h4>
          <Switch bind:checked={form.proxy.rejectInvalidPathEncoding} label="Reject invalid percent-encoding in paths (recommended)" hint="Answers 400 to a path with a broken escape such as %zz or a truncated %4. Leave it on: the WAF and the upstream could otherwise read such a path differently. Turn it off only for a client that sends malformed paths." />
        </section>
      </div>
    </details>

    {#if submitError}
      <Alert tone="error" message={submitError} />
    {/if}
  </fieldset>

  <div class="route-actions">
    <span class="route-dirty" role="status">{tracker.isDirty && !saving ? 'Unsaved changes' : ''}</span>
    {#if oncancel}
      <Button variant="ghost" disabled={saving} onclick={oncancel}>{cancelLabel}</Button>
    {/if}
    <Button type="submit" variant="primary" loading={saving} disabled={disabled || saving}>{saving ? savingLabel : submitLabel}</Button>
  </div>
</form>

<ConfirmModal
  open={confirmLowerOpen}
  tone="warning"
  title="Switch to monitor mode?"
  confirmLabel="Switch to monitor mode"
  loading={saving}
  onconfirm={() => void save()}
  onclose={() => (confirmLowerOpen = false)}
>
  <p class="confirm-text">In Monitor mode every request is forwarded to the application. Attacks are logged but not blocked until you switch back to Block.</p>
</ConfirmModal>

<ConfirmModal
  open={confirmCloudflareOpen}
  tone="warning"
  title="Replace the trusted proxies?"
  confirmLabel="Replace with Cloudflare's addresses"
  onconfirm={useCloudflare}
  onclose={() => (confirmCloudflareOpen = false)}
>
  <p class="confirm-text">{CLOUDFLARE_CONFIRM_TEXT}</p>
</ConfirmModal>

<style>
  .route-form { display: flex; flex-direction: column; gap: var(--sp-5); min-width: 0; width: 100%; max-width: 60rem; container-type: inline-size; }
  .route-fieldset { border: 0; padding: 0; margin: 0; min-width: 0; display: flex; flex-direction: column; gap: var(--sp-5); }
  .route-sections { display: flex; flex-direction: column; gap: var(--sp-5); min-width: 0; }
  .route-section { display: flex; flex-direction: column; gap: var(--sp-3); min-width: 0; padding-top: var(--sp-5); border-top: 1px solid var(--border); }
  .route-section:first-child { padding-top: 0; border-top: 0; }
  .route-section h3 { margin: 0; font-size: var(--fs-sm); font-weight: var(--fw-semibold); color: var(--text-primary); }
  .route-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--sp-4); }
  .span-full { grid-column: 1 / -1; min-width: 0; }
  /* A wide enough panel (full-width Routing tab, not the narrower create drawer)
     gets a third column for short fields (address, port, timeouts, limits). */
  @container (min-width: 46rem) {
    .route-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  }
  .mono, .route-form :global(input.mono) { font-family: var(--font-mono); }
  .proxies {
    width: 100%;
    padding: var(--sp-2) var(--sp-3);
    background: var(--surface-input);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    color: var(--text-primary);
    font-size: var(--fs-sm);
    resize: vertical;
  }
  .proxies:disabled { background: var(--bg-tertiary); color: var(--text-muted); }
  .cloudflare { display: flex; flex-direction: column; align-items: flex-start; gap: var(--sp-2); margin-top: var(--sp-3); }
  .route-error-list { margin: var(--sp-1) 0 0; padding-left: var(--sp-5); font-size: var(--fs-sm); }
  .route-error-list a { color: inherit; text-decoration: underline; }

  .upstream-type { border: 0; padding: 0; margin: 0; min-width: 0; display: flex; flex-direction: column; gap: var(--sp-1); }
  .upstream-type legend { padding: 0; font-size: var(--fs-sm); font-weight: var(--fw-medium); color: var(--text-secondary); margin-bottom: var(--sp-1); }
  .segmented { display: inline-flex; flex-wrap: wrap; border: 1px solid var(--border-strong); border-radius: var(--radius); overflow: hidden; width: fit-content; max-width: 100%; }
  .segmented label { display: inline-flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-4); font-size: var(--fs-sm); color: var(--text-secondary); cursor: pointer; }
  .segmented label + label { border-left: 1px solid var(--border-strong); }
  .segmented label.active { background: var(--accent-soft); color: var(--text-primary); }
  .segmented label:has(input:focus-visible) { outline: var(--ring-width) solid var(--ring-color); outline-offset: -2px; }
  .segmented input { position: absolute; opacity: 0; pointer-events: none; }

  .route-form :global(.part-status:not(:empty)) { margin-top: var(--sp-2); }
  .route-note { margin: 0; font-size: var(--fs-sm); color: var(--text-muted); line-height: 1.5; }

  .advanced { border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-secondary); }
  .advanced > summary { cursor: pointer; padding: var(--sp-3) var(--sp-4); font-size: var(--fs-sm); font-weight: var(--fw-semibold); color: var(--text-primary); }
  .advanced-summary { display: block; font-weight: 400; color: var(--text-muted); font-size: var(--fs-xs); margin-top: var(--sp-1); }
  .advanced-body { padding: 0 var(--sp-4) var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-5); }
  .advanced-group { display: flex; flex-direction: column; gap: var(--sp-3); }
  .advanced-group h4 { margin: 0; font-size: var(--fs-sm); color: var(--text-primary); }
  .group-hint { margin: calc(var(--sp-2) * -1) 0 0; font-size: var(--fs-xs); color: var(--text-muted); }

  .route-actions {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    flex-wrap: wrap;
    justify-content: flex-end;
    padding: var(--sp-3) var(--sp-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--bg-elevated);
    box-shadow: var(--shadow-md);
  }
  .route-dirty { font-size: var(--fs-sm); color: var(--text-muted); margin-right: auto; }
  .confirm-text { margin: 0; color: var(--text-secondary); line-height: 1.5; }

  @media (max-width: 760px) {
    .route-grid { grid-template-columns: minmax(0, 1fr); }
    .cloudflare :global(.btn) { min-height: 44px; }
    .route-actions { flex-direction: column-reverse; align-items: stretch; }
    .route-dirty { margin-right: 0; text-align: center; }
  }
</style>
