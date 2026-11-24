<!--
  AppTLS: the HTTPS tab. The mode says whether the WAF agent serves this application behind a web server, load
  balancer or CDN (Behind a proxy) or straight to visitors with its own certificate (Gateway). Choosing a mode saves
  nothing: "Save changes" keeps the saved mode, and "Switch to ..." saves with the other one after one confirm, as does
  a change of certificate source in Gateway. The panel reads the settings when it opens (the page may hand over what it
  read), then follows the server on a timer and keeps what the person is editing. Only the answer of a save carries the
  DNS hints, so the panel keeps them until the next save.
-->
<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte';
  import { getAppTLS, putAppTLS, type ApiError, type AppTLSInput, type AppTLSState, type TLSSource } from '#lib/api.js';
  import { needsConfirmation } from '#lib/confirm-tiers.js';
  import { focusFormError } from '#lib/focus-error.js';
  import { createPoller } from '#lib/polling.svelte.js';
  import { toast } from '#lib/stores/toast.js';
  import { Alert, Badge, Button, ConfirmModal, Field, InlineError, Spinner, Switch } from '#lib/components/ui/index.js';
  import ChoiceGroup from '#lib/components/waf-policy/ChoiceGroup.svelte';
  import { trustedProxyList, type ProxyForm, type RouteForm } from './route-model';
  import {
    OWN_LISTENER,
    POLL_SLOW_MS,
    backToProxyText,
    chooseMode,
    classifyTLSRefusal,
    confirmFor,
    createEpoch,
    dnsWarningText,
    formFromTLS,
    gatewayChecks,
    gatewaySteps,
    inputFromForm,
    mergeEdits,
    mergePoll,
    noticeText,
    normalizeFormats,
    pollIntervalMs,
    portsText,
    sameTLS,
    savedInGatewayText,
    setRedirect,
    sourceChangeText,
    sourceSwitchText,
    switchDisabled,
    tlsNotices,
    tlsProblem,
    type CheckState,
    type TLSConfirm,
    type TLSField,
    type TLSForm,
  } from './tls';

  let {
    projectId,
    appId,
    appName = '',
    assigned = true,
    agentName = '',
    agentOnline = undefined,
    canConfigure = false,
    routing,
    routingHref = '',
    dirty = $bindable(false),
    onchange = undefined,
    initial = undefined,
  }: {
    projectId: string;
    appId: string;
    appName?: string;
    /** A WAF agent serves the application. */
    assigned?: boolean;
    /** The WAF agent that serves the application, for the messages. */
    agentName?: string;
    /** Whether that agent is connected (undefined: not known). */
    agentOnline?: boolean;
    canConfigure?: boolean;
    /** What the Routing tab saved: the application's own listener, and whether forwarded headers are trusted and from whom. */
    routing: Pick<RouteForm, 'listenHost' | 'listenPort'> & { proxy: Pick<ProxyForm, 'trustForwarded' | 'trustedProxies'> };
    /** Where the Routing tab is, for the links to it. */
    routingHref?: string;
    /** Unsaved edits; the page asks before leaving the tab. */
    dirty?: boolean;
    /** The state changed (read, polled or saved): the page keeps it. */
    onchange?: (state: AppTLSState) => void;
    /** Settings to start from, as the server answers them (the page's first read, or a test). The panel still reads them. */
    initial?: AppTLSState;
  } = $props();

  const uid = $props.id();
  const BLANK: AppTLSInput = { mode: 'proxy', hosts: [], listen: '', redirect_listen: '', source: '' };

  // ── Data ────────────────────────────────────────────────────────────────
  const seed = untrack(() => initial ?? null);
  let loaded = $state<AppTLSState | null>(seed);
  let loading = $state(!seed);
  let loadFailed = $state(false);
  let busy = $state(false);
  let form = $state<TLSForm>(formFromTLS(seed ?? BLANK));
  /** When the person last saved here: the agent is then asked about faster. */
  let lastActionAt = $state<number | null>(null);
  const epoch = createEpoch();

  const stored = $derived<AppTLSInput>(loaded ?? BLANK);

  /** Reads the settings; a read that is not the newest, or that meets a save, is dropped. */
  async function refresh() {
    if (busy) return;
    const my = epoch.next();
    const first = loaded === null;
    if (first) {
      loading = true;
      loadFailed = false;
    }
    const res = await getAppTLS(projectId, appId);
    if (!epoch.isCurrent(my) || busy) return;
    loading = false;
    if (res.error || !res.data) {
      loadFailed = first;
      return;
    }
    if (first) adopt(res.data, true);
    else follow(res.data);
  }

  /** Takes the answer of the server; `resetForm` also replaces the edited values by the saved ones. */
  function adopt(next: AppTLSState, resetForm: boolean) {
    loaded = next;
    if (resetForm) {
      form = formFromTLS(next);
      attempted = false;
      touched = {};
      serverError = null;
    }
    onchange?.(next);
  }

  /** A poll: the DNS hints of the last save stay, and a field the person changed stays as typed. */
  function follow(polled: AppTLSState) {
    if (!loaded) return;
    const merged = mergePoll(loaded, polled);
    form = mergeEdits(form, formFromTLS(loaded), formFromTLS(merged));
    loaded = merged;
    onchange?.(merged);
  }

  onMount(() => void refresh());
  onDestroy(() => epoch.next());

  const poller = createPoller(() => refresh(), POLL_SLOW_MS, { immediate: false });
  $effect(() => {
    if (loaded) poller.setIntervalMs(pollIntervalMs(loaded, assigned, lastActionAt, Date.now()));
  });

  // ── Form state ──────────────────────────────────────────────────────────
  let attempted = $state(false);
  let touched = $state<Partial<Record<TLSField, boolean>>>({});
  let serverError = $state<{ field: 'hosts' | 'listen' | 'redirect_listen' | 'source'; message: string; sent: string } | null>(null);
  let saveError = $state('');
  /** The refusal is about a Routing setting. */
  let routingError = $state(false);
  let savedInGateway = $state(false);
  let confirm = $state<TLSConfirm | null>(null);
  /** The form as it was before "Switch back" changed its mode: put back when the dialog is cancelled. */
  let beforeBack: TLSForm | null = null;
  let saving = $state(false);
  let root = $state<HTMLElement>();

  const readonly = $derived(!canConfigure);
  const input = $derived(inputFromForm(form));
  const needed = $derived(loaded ? confirmFor(loaded, input) : null);
  const switching = $derived(needed === 'gateway' || needed === 'proxy' ? needed : null);
  const own = $derived({ host: routing.listenHost, port: routing.listenPort });
  const trust = $derived({ forwarded: routing.proxy.trustForwarded, list: trustedProxyList(routing.proxy) });
  const problem = $derived(loaded ? tlsProblem(input, own, switching === 'gateway') : null);
  const isDirty = $derived(loaded !== null && !sameTLS(input, loaded));
  const hasLeaf = $derived(Boolean(loaded?.status?.leaf_sha256));
  const notices = $derived(tlsNotices({ assigned, mode: stored.mode, supported: loaded?.agent_supported ?? null, online: agentOnline, canConfigure }));
  const locked = $derived(switchDisabled({ canConfigure, busy, to: switching, supported: loaded?.agent_supported ?? null }));
  // The hint is about a switch to Gateway: it means nothing once the app is back behind a proxy.
  const dnsWarnings = $derived(loaded?.mode === 'gateway' ? loaded.warnings.filter((w) => w.code === 'dns_mismatch') : []);
  const canonical = $derived(normalizeFormats(input).settings);
  const redirectOn = $derived(Boolean(canonical?.redirect_listen));
  const name = $derived(appName || 'this application');

  $effect(() => {
    dirty = isDirty;
  });

  function shown(field: TLSField): string | undefined {
    // A clash with the Routing listener is a fact about two tabs, not about typing: it shows at once.
    if (problem?.field === field && (touched[field] || attempted || problem.message === OWN_LISTENER)) return problem.message;
    if (serverError?.field === field && serverError.sent === JSON.stringify(input[field])) return serverError.message;
    return undefined;
  }

  const shownErrors = $derived({ hosts: shown('hosts'), listen: shown('listen'), redirect_listen: shown('redirect_listen'), source: shown('source') });

  function touch(field: TLSField) {
    touched[field] = true;
  }

  // ── Dialogs ─────────────────────────────────────────────────────────────
  const checks = $derived(
    confirm === 'gateway' && loaded
      ? gatewayChecks({ input, certificate: loaded.certificate, supported: loaded.agent_supported, hostBound: loaded.agent_host_bound, assigned, trust, agent: agentName, now: Date.now() })
      : [],
  );
  const blocked = $derived(checks.some((check) => check.state === 'failed'));
  const ports = $derived(portsText(canonical?.listen ?? '', canonical?.redirect_listen ?? ''));
  const dialog = $derived.by(() => {
    if (confirm === 'gateway') return { title: `Switch ${name} to Gateway?`, label: 'Switch to Gateway' };
    if (confirm === 'proxy') return { title: `Switch ${name} back to Behind a proxy?`, label: 'Switch to Behind a proxy' };
    return input.source === 'uploaded'
      ? { title: `Use the uploaded certificate for ${name}?`, label: 'Use uploaded certificate' }
      : { title: `Use Let's Encrypt for ${name}?`, label: "Use Let's Encrypt" };
  });
  const CHECK_LABEL: Record<CheckState, string> = { passed: 'Passed', failed: 'Failed', warning: 'Warning', unknown: 'Not known' };
  const CHECK_TONE = { passed: 'success', failed: 'danger', warning: 'warning', unknown: 'neutral' } as const;

  // ── Saving ──────────────────────────────────────────────────────────────
  function requestSave() {
    if (!canConfigure || busy || !loaded) return;
    attempted = true;
    if (problem) {
      void focusFormError(root);
      return;
    }
    if (needed === null || !needsConfirmation('switch-https-mode')) {
      void save();
      return;
    }
    saveError = '';
    confirm = needed;
  }

  async function save() {
    if (!canConfigure || busy || !loaded) return;
    const sent = input;
    busy = true;
    saving = true;
    saveError = '';
    routingError = false;
    serverError = null;
    savedInGateway = false;
    const my = epoch.next();
    const res = await putAppTLS(projectId, appId, sent);
    busy = false;
    saving = false;
    if (!epoch.isCurrent(my) || res.error?.kind === 'aborted') return;
    if (res.error || !res.data) {
      refused(res.error, sent);
      return;
    }
    confirm = null;
    beforeBack = null;
    adopt(res.data, true);
    lastActionAt = Date.now();
    if (res.data.mode === 'gateway') savedInGateway = true;
    else toast.success('HTTPS settings saved.', 'Saved');
  }

  function refused(error: ApiError | undefined, sent: AppTLSInput) {
    const refusal = classifyTLSRefusal(error, agentName);
    if (refusal.kind === 'field') {
      serverError = { field: refusal.field, message: refusal.message, sent: JSON.stringify(sent[refusal.field]) };
      confirm = null;
      beforeBack = null;
      void focusFormError(root);
      return;
    }
    if (refusal.kind === 'unsupported' && loaded) loaded = { ...loaded, agent_supported: false };
    routingError = refusal.kind === 'routing';
    saveError = refusal.message;
    // An open dialog shows the text itself.
    if (confirm === null) void focusFormError(root);
  }

  function discard() {
    if (!loaded) return;
    form = formFromTLS(loaded);
    attempted = false;
    touched = {};
    serverError = null;
    saveError = '';
  }

  /** The DNS hint's way out: the form with the other mode, confirmed like any switch. What was typed stays. */
  function backToProxy() {
    if (!loaded) return;
    beforeBack = form;
    form = chooseMode(form, 'proxy', stored);
    requestSave();
    // No dialog opened (a field to fix, or no confirm asked): the form stays as it is.
    if (confirm === null) beforeBack = null;
  }

  function cancelConfirm() {
    confirm = null;
    if (beforeBack) form = beforeBack;
    beforeBack = null;
  }

  const modeOptions = [
    { value: 'gateway' as const, label: 'Gateway', description: 'WAFio receives traffic straight from the internet and handles HTTPS' },
    { value: 'proxy' as const, label: 'Behind a proxy', description: 'WAFio sits behind a web server, load balancer or CDN' },
  ];
  const sourceOptions: { value: TLSSource; label: string; description: string }[] = [
    { value: 'acme', label: "Let's Encrypt", description: 'The agent requests a certificate for these host names and renews it.' },
    { value: 'uploaded', label: 'Uploaded certificate', description: 'A certificate you bought or issued with your own CA. Its key can be replaced, never read back.' },
  ];
  const footerNote = $derived(busy ? 'Saving…' : isDirty ? 'Unsaved changes' : '');
  const primaryLabel = $derived(switching === 'gateway' ? 'Switch to Gateway' : switching === 'proxy' ? 'Switch to Behind a proxy' : 'Save changes');
</script>

{#snippet routingLink()}
  <Button variant="secondary" size="sm" class="tls-tap" href={routingHref}>Open the Routing tab</Button>
{/snippet}

<section class="tls" aria-labelledby="{uid}-title">
  <header class="tls-head">
    <h2 id="{uid}-title">HTTPS</h2>
    <p>Choose how visitors reach this application and which certificate the WAF agent serves for HTTPS.</p>
  </header>

  {#if loading && !loaded}
    <Spinner layout="block" tone="accent" label="Loading the HTTPS settings" />
  {:else if !loaded || loadFailed}
    <InlineError message="Could not load the HTTPS settings." onretry={() => void refresh()} retrying={loading} />
  {:else}
    {#if notices.length > 0}
      <div class="tls-notices">
        {#each notices as notice (notice)}
          <Alert tone={notice === 'unsupported-gateway' ? 'error' : notice === 'unsupported' ? 'warning' : 'info'} message={noticeText(notice, agentName)} />
        {/each}
      </div>
    {/if}

    {#if savedInGateway}
      <Alert tone="success" message={savedInGatewayText(agentName)} />
    {/if}
    {#snippet switchBack()}
      <Button variant="secondary" size="sm" class="tls-tap" onclick={backToProxy}>Switch back to Behind a proxy</Button>
    {/snippet}
    {#each dnsWarnings as warning (warning.host)}
      <Alert tone="warning" message={dnsWarningText(warning, agentName)} actions={canConfigure ? switchBack : undefined} />
    {/each}

    <div class="tls-form" bind:this={root}>
      {#if saveError && confirm === null}
        <Alert tone="error" title="Not saved" message={saveError} actions={routingError ? routingLink : undefined} />
      {/if}
      <fieldset class="tls-fieldset" disabled={readonly}>
        <ChoiceGroup
          legend="How traffic reaches WAFio"
          name="{uid}-mode"
          options={modeOptions}
          bind:value={form.mode}
          onchange={(next) => (form = chooseMode(form, next, stored))}
          columns={2}
          disabled={readonly}
        />

        <section class="tls-block" aria-labelledby="{uid}-addresses">
          <h3 id="{uid}-addresses">Addresses</h3>
          <div class="tls-field" onfocusout={() => touch('hosts')}>
            <Field
              label="Host names"
              error={shownErrors.hosts}
              hint="One per line, up to 100, such as shop.example.com. No wildcards, IP addresses or ports; international names in xn-- form."
            >
              {#snippet children(c)}
                <textarea
                  {...c}
                  class="mono"
                  rows="4"
                  spellcheck="false"
                  autocomplete="off"
                  autocapitalize="off"
                  placeholder={'shop.example.com\nwww.example.com'}
                  bind:value={form.hosts}
                ></textarea>
              {/snippet}
            </Field>
          </div>

          {#if form.mode === 'gateway'}
            <div class="tls-field" onfocusout={() => touch('listen')}>
              <Field label="HTTPS address" optional error={shownErrors.listen} hint="ip:port or [ipv6]:port. Empty means 0.0.0.0:443.">
                {#snippet children(c)}
                  <input {...c} class="mono" type="text" spellcheck="false" autocomplete="off" autocapitalize="off" placeholder="0.0.0.0:443" bind:value={form.listen} />
                {/snippet}
              </Field>
            </div>

            <Switch
              checked={form.redirect}
              onchange={(on) => {
                form = setRedirect(form, on);
                touch('redirect_listen');
              }}
              label="Redirect HTTP to HTTPS"
              hint="Sends HTTP visitors to HTTPS once a certificate is in use (503 before that) and answers Let's Encrypt's HTTP-01 check. Keep it on behind a CDN."
              disabled={readonly}
            />
            {#if form.redirect}
              <div class="tls-field" onfocusout={() => touch('redirect_listen')}>
                <Field label="Redirect address" error={shownErrors.redirect_listen} hint="ip:port or [ipv6]:port.">
                  {#snippet children(c)}
                    <input {...c} class="mono" type="text" spellcheck="false" autocomplete="off" autocapitalize="off" placeholder="0.0.0.0:80" bind:value={form.redirectListen} />
                  {/snippet}
                </Field>
              </div>
            {/if}
          {/if}
        </section>

        <section class="tls-block" aria-labelledby="{uid}-certificate">
          <h3 id="{uid}-certificate">Certificate</h3>
          <ChoiceGroup legend="Certificate source" name="{uid}-source" options={sourceOptions} bind:value={form.source} columns={2} disabled={readonly} error={shownErrors.source} />
        </section>
      </fieldset>
    </div>

    <div class="tls-actions">
      <span class="tls-dirty" role="status">{footerNote}</span>
      <Button variant="secondary" class="tls-tap" disabled={!isDirty || busy || readonly} onclick={discard}>Discard changes</Button>
      <Button class="tls-tap" loading={saving} disabled={!isDirty || locked} onclick={requestSave}>{primaryLabel}</Button>
    </div>
  {/if}
</section>

<ConfirmModal
  open={confirm !== null}
  tone="warning"
  size="lg"
  title={dialog.title}
  confirmLabel={dialog.label}
  cancelLabel="Cancel"
  confirmDisabled={blocked}
  loading={busy}
  onconfirm={() => void save()}
  onclose={cancelConfirm}
>
  {#if confirm}
    {#if confirm === 'gateway'}
      <ul class="tls-checks" aria-label="Checks before the switch">
        {#each checks as check (check.id)}
          <li>
            <Badge tone={CHECK_TONE[check.state]}>{CHECK_LABEL[check.state]}</Badge>
            <span>
              {check.text}
              {#if check.id === 'trust' && trust.forwarded}<a href={routingHref}>Open the Routing tab</a>{/if}
            </span>
          </li>
        {/each}
      </ul>
      <p class="tls-lead">Outside WAFio</p>
      <ol class="tls-steps">
        {#each gatewaySteps({ agent: agentName, ports, source: input.source }) as step (step)}<li>{step}</li>{/each}
      </ol>
    {/if}
    {#if confirm === 'proxy' && loaded}
      <p>{backToProxyText({ agent: agentName, own, ports: portsText(loaded.listen, loaded.redirect_listen) })}</p>
    {:else if input.source === 'acme' || input.source === 'uploaded'}
      <p>{confirm === 'source' ? sourceChangeText(input.source, { agent: agentName, hasLeaf }) : sourceSwitchText(input.source, { agent: agentName, redirect: redirectOn })}</p>
    {/if}
    {#if saveError}
      <Alert tone="error" title="Not saved" message={saveError} actions={routingError ? routingLink : undefined} />
    {/if}
  {/if}
</ConfirmModal>

<style>
  .tls { display: flex; flex-direction: column; gap: var(--sp-4); width: 100%; min-width: 0; container-type: inline-size; }
  .tls-head h2 { margin: 0; font-size: var(--fs-md); }
  .tls-head p { margin: var(--sp-1) 0 0; font-size: var(--fs-sm); color: var(--text-muted); max-width: 70ch; line-height: 1.5; }
  .tls-notices { display: flex; flex-direction: column; gap: var(--sp-2); }

  .tls-form { display: flex; flex-direction: column; gap: var(--sp-4); min-width: 0; max-width: 46rem; }
  .tls-fieldset { display: flex; flex-direction: column; gap: var(--sp-5); border: 0; padding: 0; margin: 0; min-width: 0; }
  .tls-block { display: flex; flex-direction: column; gap: var(--sp-4); min-width: 0; padding-top: var(--sp-5); border-top: 1px solid var(--border); }
  .tls-block h3 { margin: 0; font-size: var(--fs-base); font-weight: var(--fw-semibold); color: var(--text-primary); }
  .tls-field { min-width: 0; }
  .tls-form textarea, .tls-form input.mono { font-family: var(--font-mono); font-size: var(--fs-sm); }
  .tls-form textarea { resize: vertical; line-height: 1.5; }

  .tls-checks { display: flex; flex-direction: column; gap: var(--sp-2); margin: 0 0 var(--sp-3); padding: 0; list-style: none; font-size: var(--fs-sm); }
  .tls-checks li { display: flex; align-items: flex-start; gap: var(--sp-2); }
  .tls-checks li > :global(.badge) { flex: none; }
  .tls-checks a { margin-left: var(--sp-1); color: var(--accent); }
  .tls-lead { margin: 0 0 var(--sp-1); font-size: var(--fs-sm); font-weight: var(--fw-medium); color: var(--text-primary); }
  .tls-steps { display: flex; flex-direction: column; gap: var(--sp-1); margin: 0 0 var(--sp-3); padding-left: var(--sp-5); font-size: var(--fs-sm); }

  .tls-actions {
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
  .tls-dirty { margin-right: auto; font-size: var(--fs-sm); color: var(--text-muted); }

  @media (max-width: 760px) {
    .tls-actions { flex-direction: column-reverse; align-items: stretch; }
    .tls-dirty { margin-right: 0; text-align: center; }
    .tls :global(.tls-tap) { min-height: 44px; }
  }
</style>
