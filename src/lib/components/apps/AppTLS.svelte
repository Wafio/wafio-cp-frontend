<!--
  AppTLS: the Gateway tab. The switch says whether the WAF agent serves this application straight to visitors with its
  own certificate (on, Gateway) or behind a web server, load balancer or CDN (off, Behind a proxy, the default, which
  shows one line and nothing else). Flipping it saves nothing: "Save changes" keeps the saved mode, and "Switch to ..."
  saves with the other one after one confirm, as does a change of certificate source in Gateway. The panel reads the
  settings when it opens (the page may hand over what it read), then follows the server on a timer and keeps what the
  person is editing. Only the answer of a save carries the DNS hints, so the panel keeps them until the next save. The
  card of the saved certificate source follows the agent's report and carries the request, upload, replace and delete
  of the certificate.
-->
<script lang="ts">
  import { onDestroy, onMount, tick, untrack } from 'svelte';
  import { deleteAppCertificate, getAppTLS, putAppTLS, requestAppACME, type ApiError, type AppTLSInput, type AppTLSState, type TLSSource } from '#lib/api.js';
  import { needsConfirmation } from '#lib/confirm-tiers.js';
  import { focusFormError } from '#lib/focus-error.js';
  import { createPoller } from '#lib/polling.svelte.js';
  import { toast } from '#lib/stores/toast.js';
  import { Alert, Badge, Button, ConfirmModal, DateTime, EmptyState, Field, InlineError, Select, Spinner, Switch } from '#lib/components/ui/index.js';
  import ChoiceGroup from '#lib/components/waf-policy/ChoiceGroup.svelte';
  import CertificateUpload from './CertificateUpload.svelte';
  import type { DeliveryFeed } from './delivery-feed.svelte.js';
  import PartStatus from './PartStatus.svelte';
  import { partLine, tooOld } from './speed';
  import { trustedProxyList, type ProxyForm, type RouteForm } from './route-model';
  import {
    CANONICAL_HOST_NOTE,
    CERTIFICATE_IN_USE_TEXT,
    MOVED_UPLOAD_TEXT,
    OWN_LISTENER,
    POLL_SLOW_MS,
    REQUEST_TEXT,
    actionErrorText,
    backToProxyText,
    behindCloudflareText,
    canonicalHostHint,
    certificateAlerts,
    certificateCard,
    chooseMode,
    classifyTLSRefusal,
    confirmFor,
    createEpoch,
    deleteCertificateText,
    dnsWarningText,
    expiryPhrase,
    formFromTLS,
    gatewayChecks,
    gatewaySteps,
    hostChoices,
    inputFromForm,
    mergeEdits,
    mergePoll,
    noticeText,
    normalizeFormats,
    pollIntervalMs,
    portsText,
    proxyModeText,
    requestAgainText,
    requestOpensAt,
    retryUntil,
    sameTLS,
    savedInGatewayText,
    setRedirect,
    sourceChangeText,
    sourceSwitchText,
    switchDisabled,
    tlsNotices,
    tlsProblem,
    unusedMainHostText,
    uploadsFirst,
    withoutMainHost,
    type CertificateFacts,
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
    delivery = undefined,
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
    /** What the agent reported about the main host name; without it the field shows no status. */
    delivery?: DeliveryFeed;
  } = $props();

  const uid = $props.id();
  const BLANK: AppTLSInput = { mode: 'proxy', hosts: [], listen: '', redirect_listen: '', source: '', canonical_host: '' };

  // ── Data ────────────────────────────────────────────────────────────────
  const seed = untrack(() => initial ?? null);
  let loaded = $state<AppTLSState | null>(seed);
  let loading = $state(!seed);
  let loadFailed = $state(false);
  let busy = $state(false);
  let form = $state<TLSForm>(formFromTLS(seed ?? BLANK));
  /** When the person last acted here (saved, requested, uploaded, deleted): the agent is then asked about faster. */
  let lastActionAt = $state<number | null>(null);
  /** Ticks, so the dates and waits of the card stay true between polls. */
  let now = $state(Date.now());
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

  onMount(() => {
    void refresh();
    const tick = setInterval(() => (now = Date.now()), 5000);
    return () => clearInterval(tick);
  });
  onDestroy(() => epoch.next());

  const poller = createPoller(() => refresh(), POLL_SLOW_MS, { immediate: false });
  $effect(() => {
    if (loaded) poller.setIntervalMs(pollIntervalMs(loaded, assigned, lastActionAt, Date.now()));
  });

  // ── Form state ──────────────────────────────────────────────────────────
  let attempted = $state(false);
  let touched = $state<Partial<Record<TLSField, boolean>>>({});
  let serverError = $state<{ field: 'hosts' | 'listen' | 'redirect_listen' | 'source' | 'canonical_host'; message: string; sent: string } | null>(null);
  let saveError = $state('');
  /** The refusal is about a Routing setting. */
  let routingError = $state(false);
  let savedInGateway = $state(false);
  let confirm = $state<TLSConfirm | null>(null);
  /** The form as it was before "Switch back" changed its mode: put back when the dialog is cancelled. */
  let beforeBack: TLSForm | null = null;
  let saving = $state(false);
  let root = $state<HTMLElement>();
  /** Epoch ms a refusal (409 ACME_REQUEST_TOO_SOON) said to wait until. */
  let retryAt = $state<number | null>(null);
  let requesting = $state(false);
  let requestError = $state('');
  let uploadOpen = $state(false);
  let deleteOpen = $state(false);
  let deleteError = $state('');

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
  const inGateway = $derived(loaded?.mode === 'gateway');
  const card = $derived(loaded ? certificateCard(loaded, { assigned, agent: agentName, now, lastActionAt }) : null);
  const alerts = $derived(loaded ? certificateAlerts(loaded, agentName, now) : []);
  const opensAt = $derived(requestOpensAt(loaded?.acme?.requested_at, retryAt, now));
  const requestWaits = $derived(opensAt > now);
  const uploadsInstead = $derived(loaded !== null && uploadsFirst(loaded, input, needed));
  // An agent that cannot serve certificates takes no request.
  const canRequest = $derived(assigned && loaded?.agent_supported !== false);

  // The main host name: its choices, and what the agent says about it. An agent that is too old for it takes none, but a saved one can be cleared.
  const savedMainHost = $derived(loaded?.canonical_host ?? '');
  const mainHostOld = $derived(tooOld(delivery?.state ?? null, 'redirects'));
  const mainHostLocked = $derived(mainHostOld && savedMainHost === '');
  const hostOptions = $derived.by(() => {
    const all = hostChoices(form.hosts.split('\n'), form.canonicalHost);
    return mainHostOld ? all.filter((option) => option.value === '' || option.value === savedMainHost) : all;
  });
  const mainHostLine = $derived(
    delivery
      ? partLine({ delivery: delivery.state, part: 'redirects', label: 'the main host name', inUse: inGateway && savedMainHost !== '', now: delivery.now, waitingSince: delivery.waitingSince, quiet: ['unassigned', 'offline'] })
      : null,
  );

  // A main host name saved in Gateway stays stored when the application goes back behind a proxy, where the form shows no field for it.
  const unusedMainHost = $derived(loaded && loaded.mode !== 'gateway' ? savedMainHost : '');

  $effect(() => {
    dirty = isDirty;
  });

  function shown(field: TLSField): string | undefined {
    // A clash with the Routing listener is a fact about two tabs, not about typing: it shows at once.
    if (problem?.field === field && (touched[field] || attempted || problem.message === OWN_LISTENER)) return problem.message;
    if (serverError?.field === field && serverError.sent === JSON.stringify(input[field])) return serverError.message;
    return undefined;
  }

  const shownErrors = $derived({ hosts: shown('hosts'), listen: shown('listen'), redirect_listen: shown('redirect_listen'), source: shown('source'), canonical_host: shown('canonical_host') });

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
    const hadMainHost = savedMainHost !== '';
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
    if (hadMainHost || (res.data.canonical_host ?? '') !== '') delivery?.acted();
    if (res.data.mode === 'gateway') savedInGateway = true;
    else {
      toast.success('Gateway settings saved.', 'Saved');
      // The bar goes away with the save, and the button that opened the dialog with it.
      void refocus('title');
    }
  }

  /** Saves the stored settings with no main host name, the way out when this mode shows no field for it. */
  async function clearMainHost() {
    if (!canConfigure || busy || !loaded) return;
    busy = true;
    saveError = '';
    routingError = false;
    const my = epoch.next();
    const res = await putAppTLS(projectId, appId, withoutMainHost(loaded));
    busy = false;
    if (!epoch.isCurrent(my) || res.error?.kind === 'aborted') return;
    if (res.error || !res.data) {
      saveError = classifyTLSRefusal(res.error, agentName).message;
      void focusFormError(root);
      return;
    }
    adopt(res.data, true);
    lastActionAt = Date.now();
    delivery?.acted();
    toast.success('Main host name cleared.', 'Saved');
    // The button went with the line it belonged to.
    void refocus('title');
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
    if (refusal.kind === 'unsupported' && loaded) {
      loaded = { ...loaded, agent_supported: false };
      onchange?.(loaded);
    }
    routingError = refusal.kind === 'routing';
    saveError = refusal.message;
    // An agent that is too old for the main host name has told the control plane so: read the flags again.
    if (refusal.kind === 'too-old') void delivery?.refresh();
    // An open dialog shows the text itself.
    if (confirm === null) void focusFormError(root);
  }

  // ── The certificate ─────────────────────────────────────────────────────
  async function requestCertificate() {
    if (!canConfigure || busy || !loaded) return;
    busy = true;
    requesting = true;
    requestError = '';
    const my = epoch.next();
    const res = await requestAppACME(projectId, appId);
    busy = false;
    requesting = false;
    if (!epoch.isCurrent(my) || res.error?.kind === 'aborted') return;
    if (res.error || !res.data) {
      retryAt = retryUntil(res.error, Date.now());
      // A wait the control plane named is shown at the button.
      requestError = retryAt === null ? actionErrorText(res.error, agentName, 'Could not request a certificate.') : '';
      return;
    }
    retryAt = null;
    lastActionAt = Date.now();
    follow(res.data);
  }

  async function uploaded() {
    uploadOpen = false;
    lastActionAt = Date.now();
    toast.success('The certificate was uploaded.', 'Uploaded');
    await refresh();
    await refocus('replace', 'certificate');
  }

  function askDelete() {
    if (!canConfigure || busy) return;
    deleteError = '';
    if (needsConfirmation('delete-certificate')) deleteOpen = true;
    else void deleteCertificate();
  }

  async function deleteCertificate() {
    if (!canConfigure || busy) return;
    busy = true;
    deleteError = '';
    const res = await deleteAppCertificate(projectId, appId);
    busy = false;
    if (res.error || !res.data) {
      deleteError = actionErrorText(res.error, agentName, 'Could not delete the certificate.');
      return;
    }
    deleteOpen = false;
    lastActionAt = Date.now();
    toast.success('The private key was deleted.', 'Deleted');
    await refresh();
    await refocus('upload', 'certificate');
  }

  function discard() {
    if (!loaded) return;
    form = formFromTLS(loaded);
    attempted = false;
    touched = {};
    serverError = null;
    saveError = '';
    void refocus('title');
  }

  /**
   * The control the person used can be gone or disabled once the page has changed (the first upload fills the empty
   * state, a delete removes its own button, a discard leaves nothing to discard). Focus then goes to the first of
   * these that exists, so the next Tab goes on from here and not from the top of the page.
   */
  async function refocus(...ids: string[]) {
    await tick();
    const active = document.activeElement;
    if (active && active !== document.body && !active.matches(':disabled')) return;
    for (const id of ids) {
      const target = document.getElementById(`${uid}-${id}`);
      if (target && !target.matches(':disabled')) {
        target.focus();
        return;
      }
    }
  }

  /** The DNS hint's way out: the form with the other mode, confirmed like any switch. Typed edits come back only if the dialog is cancelled. */
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

  const sourceOptions: { value: TLSSource; label: string; description: string }[] = [
    { value: 'acme', label: "Let's Encrypt", description: 'The agent requests a certificate for these host names and renews it.' },
    { value: 'uploaded', label: 'Uploaded certificate', description: 'A certificate you bought or issued with your own CA. Its key can be replaced, never read back.' },
  ];
  const footerNote = $derived(busy ? 'Saving…' : isDirty ? 'Unsaved changes' : '');
  const primaryLabel = $derived(
    uploadsInstead ? 'Upload certificate' : switching === 'gateway' ? 'Switch to Gateway' : switching === 'proxy' ? 'Switch to Behind a proxy' : 'Save changes',
  );
  const primaryLocked = $derived(uploadsInstead ? readonly || busy : locked);
</script>

{#snippet routingLink()}
  <Button variant="secondary" size="sm" class="tls-tap" href={routingHref}>Open the Routing tab</Button>
{/snippet}

{#snippet facts(f: CertificateFacts)}
  <dl class="tls-facts">
    <dt>Issuer</dt>
    <dd><bdi>{f.issuer}</bdi></dd>
    <dt>Names</dt>
    <dd><bdi>{f.names.join(', ')}</bdi></dd>
    {#if f.notBefore}
      <dt>Valid from</dt>
      <dd><DateTime value={f.notBefore} format="date" /></dd>
    {/if}
    {#if f.notAfter}
      <dt>Expires</dt>
      <dd><DateTime value={f.notAfter} format="date" /> ({expiryPhrase(f.notAfter, now)})</dd>
    {/if}
    {#if f.renewalAt !== null}
      <dt>Renewal starts</dt>
      <dd><DateTime value={new Date(f.renewalAt)} format="date" /></dd>
    {/if}
    {#if f.keyType}
      <dt>Key type</dt>
      <dd>{f.keyType}</dd>
    {/if}
    {#if f.uploadedAt}
      <dt>Uploaded</dt>
      <dd><DateTime value={f.uploadedAt} /></dd>
    {/if}
  </dl>
{/snippet}

<section class="tls" aria-labelledby="{uid}-title">
  <header class="tls-head">
    <h2 id="{uid}-title" tabindex="-1">Gateway</h2>
    <p>Choose how visitors reach this application and which certificate the WAF agent serves for HTTPS.</p>
  </header>

  {#if loading && !loaded}
    <Spinner layout="block" tone="accent" label="Loading the Gateway settings" />
  {:else if !loaded || loadFailed}
    <InlineError message="Could not load the Gateway settings." onretry={() => void refresh()} retrying={loading} />
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
        <Switch
          checked={form.mode === 'gateway'}
          onchange={(on) => (form = chooseMode(form, on ? 'gateway' : 'proxy', stored))}
          label="Gateway"
          hint="WAFio receives traffic straight from the internet and handles HTTPS."
          disabled={readonly}
        />

        {#if form.mode !== 'gateway'}
          <p class="tls-hint">{proxyModeText(agentName)}</p>
          {#if unusedMainHost !== ''}
            <div class="tls-unused">
              <p class="tls-hint">{unusedMainHostText(unusedMainHost)}</p>
              {#if canConfigure}
                <Button variant="secondary" size="sm" class="tls-tap" disabled={busy} onclick={() => void clearMainHost()}>Clear main host name</Button>
              {/if}
            </div>
          {/if}
        {:else}
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

            <div class="tls-field" onfocusout={() => touch('canonical_host')}>
              <Field label="Main host name" error={shownErrors.canonical_host} hint={canonicalHostHint(form.redirect, form.canonicalHost)}>
                {#snippet children(c)}
                  <Select {...c} options={hostOptions} bind:value={form.canonicalHost} disabled={readonly || mainHostLocked} />
                {/snippet}
              </Field>
              <p class="tls-hint">{CANONICAL_HOST_NOTE}</p>
              <PartStatus line={mainHostLine} />
            </div>

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
            <p class="tls-hint"><strong>Behind Cloudflare.</strong> {behindCloudflareText(form.source, form.redirect)}</p>
          </section>

          <section class="tls-block" aria-labelledby="{uid}-certificate">
            <h3 id="{uid}-certificate" tabindex="-1">Certificate</h3>
            <ChoiceGroup legend="Certificate source" name="{uid}-source" options={sourceOptions} bind:value={form.source} columns={2} disabled={readonly} error={shownErrors.source} />

            {#if card}
              <div class="tls-card" role="group" aria-label="Saved certificate">
                <div class="tls-card-head">
                  <h4>{card.source === 'acme' ? "Let's Encrypt" : 'Uploaded certificate'}</h4>
                  {#if card.inUse && inGateway}<Badge tone="success">In use</Badge>{/if}
                </div>
                {#each alerts as alert (alert.text)}
                  <Alert tone={alert.tone} message={alert.text} />
                {/each}
                {#if card.empty}
                  <EmptyState title="No certificate uploaded" message="Upload the certificate chain and its private key." level={5} compact>
                    {#snippet action()}
                      <Button id="{uid}-upload" class="tls-tap" disabled={readonly || busy} onclick={() => (uploadOpen = true)}>Upload certificate</Button>
                    {/snippet}
                  </EmptyState>
                {/if}
                {#if card.facts}{@render facts(card.facts)}{/if}
                {#if card.failure || card.lines.length > 0 || card.served}
                  <div class="tls-card-status" aria-live="polite">
                    {#if card.failure}
                      <p>
                        {card.failure.lead}
                        {#if card.failure.error}<bdi class="tls-error">{card.failure.error}</bdi>{/if}
                      </p>
                      {#if card.failure.next}<p>{card.failure.next}</p>{/if}
                    {/if}
                    {#each card.lines as line (line)}<p>{line}</p>{/each}
                    {#if card.served}
                      <p class="tls-sub">Served now</p>
                      {@render facts(card.served)}
                    {/if}
                  </div>
                {/if}

                {#if card.source === 'acme' && inGateway && canRequest}
                  <div class="tls-card-actions">
                    <Button variant="secondary" class="tls-tap" loading={requesting} disabled={readonly || busy || requestWaits} onclick={() => void requestCertificate()}>
                      {card.failure ? 'Try again now' : 'Request a new certificate'}
                    </Button>
                  </div>
                  {#if requestWaits}<p class="tls-hint">{requestAgainText(opensAt)}</p>{/if}
                  <p class="tls-hint">{REQUEST_TEXT}</p>
                  {#if requestError}<Alert tone="error" title="Not requested" message={requestError} />{/if}
                {/if}

                {#if card.source === 'uploaded' && loaded?.certificate}
                  <div class="tls-card-actions">
                    <Button id="{uid}-replace" variant="secondary" class="tls-tap" disabled={readonly || busy} onclick={() => (uploadOpen = true)}>Replace certificate</Button>
                    <Button variant="secondary" class="tls-tap" disabled={readonly || busy || inGateway} onclick={askDelete}>Delete certificate</Button>
                  </div>
                  {#if inGateway}<p class="tls-hint">{CERTIFICATE_IN_USE_TEXT}</p>{/if}
                  <p class="tls-hint">{MOVED_UPLOAD_TEXT}</p>
                {:else if card.source === 'acme' && loaded?.certificate}
                  <div class="tls-card-actions">
                    <p class="tls-hint">An uploaded certificate of this application is still stored with its key.</p>
                    <Button variant="secondary" class="tls-tap" disabled={readonly || busy} onclick={askDelete}>Delete certificate</Button>
                  </div>
                {/if}
              </div>
            {/if}
          </section>
        {/if}
      </fieldset>
    </div>

    {#if isDirty || form.mode === 'gateway'}
      <div class="tls-actions">
        <span class="tls-dirty" role="status">{footerNote}</span>
        <Button variant="secondary" class="tls-tap" disabled={!isDirty || busy || readonly} onclick={discard}>Discard changes</Button>
        <Button class="tls-tap" loading={saving} disabled={!isDirty || primaryLocked} onclick={uploadsInstead ? () => (uploadOpen = true) : requestSave}>{primaryLabel}</Button>
      </div>
    {/if}
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
    <!-- First, so that the agreement is in view before the long lists. -->
    {#if confirm === 'proxy' && loaded}
      <p class="tls-switch">{backToProxyText({ agent: agentName, own, ports: portsText(loaded.listen, loaded.redirect_listen) })}</p>
    {:else if input.source === 'acme' || input.source === 'uploaded'}
      <p class="tls-switch">{confirm === 'source' ? sourceChangeText(input.source, { agent: agentName, hasLeaf }) : sourceSwitchText(input.source, { agent: agentName, redirect: redirectOn })}</p>
    {/if}
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
    {#if saveError}
      <Alert tone="error" title="Not saved" message={saveError} actions={routingError ? routingLink : undefined} />
    {/if}
  {/if}
</ConfirmModal>

<ConfirmModal
  open={deleteOpen}
  title="Delete the uploaded certificate of {name}?"
  confirmLabel="Delete certificate"
  cancelLabel="Cancel"
  loading={busy}
  onconfirm={() => void deleteCertificate()}
  onclose={() => (deleteOpen = false)}
>
  <p>{deleteCertificateText(name)}</p>
  {#if deleteError}<Alert tone="error" title="Not deleted" message={deleteError} />{/if}
</ConfirmModal>

<CertificateUpload
  open={uploadOpen}
  {projectId}
  {appId}
  {appName}
  {agentName}
  replacing={loaded?.source === 'uploaded' && loaded.certificate !== null}
  becomesSource={loaded?.source !== 'uploaded'}
  gateway={inGateway}
  onuploaded={() => void uploaded()}
  onclose={() => (uploadOpen = false)}
/>

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
  .tls-field .tls-hint { margin-top: var(--sp-2); }
  .tls-unused { display: flex; flex-direction: column; align-items: flex-start; gap: var(--sp-2); }
  .tls-field :global(.part-status:not(:empty)) { margin-top: var(--sp-2); }
  .tls-form textarea, .tls-form input.mono { font-family: var(--font-mono); font-size: var(--fs-sm); }
  .tls-form textarea { resize: vertical; line-height: 1.5; }

  .tls-card { display: flex; flex-direction: column; gap: var(--sp-3); min-width: 0; padding: var(--sp-4); border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-card); }
  .tls-card-head { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
  .tls-card-head h4 { margin: 0; font-size: var(--fs-base); font-weight: var(--fw-semibold); color: var(--text-primary); }
  .tls-facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: var(--sp-1) var(--sp-4); margin: 0; font-size: var(--fs-sm); }
  .tls-facts dt { color: var(--text-muted); }
  .tls-facts dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
  .tls-card-status { display: flex; flex-direction: column; gap: var(--sp-2); font-size: var(--fs-sm); }
  .tls-card-status p, .tls-hint { margin: 0; line-height: 1.5; }
  .tls-sub { font-weight: var(--fw-medium); color: var(--text-primary); }
  .tls-error { white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--font-mono); }
  .tls-card-actions { display: flex; align-items: center; gap: var(--sp-3); flex-wrap: wrap; }
  .tls-hint { font-size: var(--fs-sm); color: var(--text-muted); max-width: 70ch; }

  .tls-switch { margin: 0 0 var(--sp-3); }
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
