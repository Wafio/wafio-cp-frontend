<!--
  Application page, the single page of an application. Tabs live in the URL
  (?tab=monitoring|decisions|config|
  blockwindow|maintenance|https|routing|assignment), so alerts and other pages can
  deep-link and Back restores the previous tab.

  Unsaved edits in Config (ConfigWafForm), Maintenance, HTTPS and Routing
  (AppRouteForm) are guarded on tab switch and on navigation away.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { base } from '#lib/paths.js';
  import {
    deleteApp,
    getApp,
    getAppTLS,
    getAppWAFAgent,
    listAgentRoutes,
    listFleetAgents,
    updateAgentRoute,
    updateApp,
    type AgentRoute,
    type ApiError,
    type App,
    type AppTLSState,
    type AppWAFAssignment,
    type FleetAgent,
  } from '#lib/api.js';
  import { getProjectContext } from '#lib/project-context.svelte.js';
  import { createDirtyTracker } from '#lib/dirty.svelte.js';
  import { hasRedactedSecrets } from '#lib/secret-redaction.js';
  import { appWriteErrorMessage } from '#lib/components/apps/route-errors.js';
  import { toast } from '#lib/stores/toast.js';
  import { tabDomIds } from '#lib/components/ui/tabs.js';
  import { Alert, Badge, Button, ConfirmModal, EmptyState, InlineError, PageHeader, Spinner, StatusDot, Tabs } from '#lib/components/ui/index.js';
  import type { TimeRangeKey } from '#lib/components/ui/time-range.js';
  import AppOverview from '#lib/components/AppOverview.svelte';
  import AppAssignment from '#lib/components/AppAssignment.svelte';
  import AppBlockWindow from '#lib/components/apps/AppBlockWindow.svelte';
  import AppConfigPanel from '#lib/components/apps/AppConfigPanel.svelte';
  import AppMaintenance from '#lib/components/apps/AppMaintenance.svelte';
  import AppRouteForm from '#lib/components/apps/AppRouteForm.svelte';
  import AppTLS from '#lib/components/apps/AppTLS.svelte';
  import DecisionFeed from '#lib/components/apps/DecisionFeed.svelte';
  import {
    appHref,
    appTabSearch,
    appTabs,
    normalizeAppTab,
    readAppRange,
    readAppTab,
    writeAppRange,
  } from '#lib/components/apps/app-page.js';
  import { APP_STATE_TEXT, appState, routeSummary } from '#lib/components/apps/inventory.js';
  import { expiryBadge, withoutDnsHints } from '#lib/components/apps/tls.js';
  import { usePageDetail } from '#lib/page-meta.svelte.js';
  import {
    agentRouteBodyFrom,
    appUpdateBodyFrom,
    emptyRouteForm,
    routeFormFromApp,
    type RouteForm,
  } from '#lib/components/apps/route-model.js';
  import { EMPTY_FEED_FILTER, readFeedFilter, writeFeedFilter, type FeedFilter } from '#lib/waf-live.js';

  const ctx = getProjectContext();
  const projectId = $derived(page.params.id ?? '');
  const appId = $derived(page.params.appId ?? '');

  // ── Data ────────────────────────────────────────────────────────────────
  let app = $state<App | null>(null);
  let assignment = $state<AppWAFAssignment | null>(null);
  let agents = $state<FleetAgent[]>([]);
  let route = $state<AgentRoute | null>(null);
  // The HTTPS tab owns its state once it is open; this is what the first render of the tab starts from. It holds no
  // DNS hints: they last until the next save or until the person leaves the tab.
  let tls = $state<AppTLSState | null>(null);
  const certificateBadge = $derived(tls ? expiryBadge(tls, Date.now()) : null);
  let loading = $state(true);
  let loadError = $state<ApiError | null>(null);
  let bindingError = $state('');
  let epoch = 0;

  /** The route of this application on its agent (routes are paged by 100). */
  async function findRoute(project: string, agentId: string, id: string): Promise<AgentRoute | null> {
    for (let offset = 0; offset < 10_000; offset += 100) {
      const res = await listAgentRoutes(project, agentId, { limit: 100, offset });
      const routes = res.data?.routes ?? [];
      const hit = routes.find((r) => r.app_id === id);
      if (hit) return hit;
      if (res.error || routes.length < 100 || offset + routes.length >= (res.data?.total ?? 0)) return null;
    }
    return null;
  }

  async function load(opts: { silent?: boolean } = {}) {
    const my = ++epoch;
    const project = projectId;
    const id = appId;
    if (!opts.silent) loading = true;
    const [appRes, bindRes, agentsRes, tlsRes] = await Promise.all([
      getApp(project, id),
      getAppWAFAgent(project, id),
      listFleetAgents({ projectId: project, kind: 'waf' }),
      getAppTLS(project, id),
    ]);
    if (my !== epoch) return;
    if (appRes.error || !appRes.data) {
      loadError = appRes.error ?? { error: 'Could not load the application.' };
      loading = false;
      return;
    }
    const binding = bindRes.data ?? null;
    const nextRoute = binding ? await findRoute(project, binding.agent_id, id) : null;
    if (my !== epoch) return;
    app = appRes.data.app;
    assignment = binding;
    route = nextRoute;
    tls = tlsRes.data ?? null;
    agents = agentsRes.data?.agents ?? [];
    // 404 WAF_AGENT_NOT_ASSIGNED is the unassigned state, not a failure.
    bindingError = bindRes.error && bindRes.error.code !== 'WAF_AGENT_NOT_ASSIGNED' ? bindRes.error.error || 'Could not load the assignment.' : '';
    loadError = null;
    loading = false;
  }

  $effect(() => {
    void `${projectId}/${appId}`;
    untrack(() => {
      app = null;
      assignment = null;
      route = null;
      tls = null;
      agents = [];
      loadError = null;
      bindingError = '';
      void load();
    });
    return () => {
      epoch++;
    };
  });

  const assigned = $derived(Boolean(assignment));
  const agent = $derived(assignment ? agents.find((a) => a.id === assignment?.agent_id) : undefined);
  const stateKey = $derived(app ? appState(app, assignment) : 'draft');
  const stateText = $derived(APP_STATE_TEXT[stateKey]);
  const summary = $derived(
    app ? routeSummary(route?.listen_host ?? app.listen_host, route?.listen_port ?? app.listen_port, route?.upstream ?? app.upstream_url) : null,
  );

  // ── Tabs (URL) ──────────────────────────────────────────────────────────
  // Maintenance mode is on, or was on during this visit (set by setMaintenance), so its tab
  // stays open without an agent and turning it off does not move the page to another tab.
  let maintenanceSeenFor = $state('');
  const maintenanceOpen = $derived(Boolean(app?.maintenance_enabled) || (app !== null && maintenanceSeenFor === app.id));
  const tabs = $derived(appTabs({ assigned, maintenance: maintenanceOpen }));
  const tab = $derived(readAppTab(page.url.searchParams, { assigned, maintenance: maintenanceOpen }));
  const requestedTab = $derived(normalizeAppTab(page.url.searchParams.get('tab')));
  const tabUnavailable = $derived(Boolean(app) && !loading && requestedTab !== null && requestedTab !== tab);
  const TABS_ID = 'app-tabs';
  let tabValue = $state<string>('monitoring');
  $effect.pre(() => {
    tabValue = tab;
  });

  // ── Unsaved changes ──────────────────────────────────────────────
  let configDirty = $state(false);
  let maintenanceDirty = $state(false);
  let tlsDirty = $state(false);
  let routingDirty = $state(false);
  let discardPrompt = $state<{ resolve: (ok: boolean) => void } | null>(null);

  function askDiscard(): Promise<boolean> {
    discardPrompt?.resolve(false);
    return new Promise((resolve) => {
      discardPrompt = { resolve };
    });
  }

  function answerDiscard(ok: boolean) {
    const prompt = discardPrompt;
    discardPrompt = null;
    prompt?.resolve(ok);
  }

  const unsaved = createDirtyTracker(() => configDirty || maintenanceDirty || tlsDirty || routingDirty, { confirm: () => askDiscard() });
  unsaved.guardNavigation();

  // A panel that is no longer shown cannot hold unsaved edits (Back/Forward
  // switch tabs without going through selectTab).
  $effect(() => {
    if (tab !== 'config') configDirty = false;
    if (tab !== 'maintenance') maintenanceDirty = false;
    if (tab !== 'https') tlsDirty = false;
    if (tab !== 'routing') routingDirty = false;
  });

  function navigate(search: string, opts: { replace?: boolean } = {}) {
    return goto(`${page.url.pathname}${search}`, { replace: opts.replace ?? false, reset: false });
  }

  async function selectTab(next: string) {
    const target = normalizeAppTab(next);
    if (!target || target === tab) return;
    if (!(await unsaved.confirmDiscard())) {
      tabValue = tab;
      return;
    }
    // Agreed to discard: the navigation below must not ask again.
    configDirty = false;
    maintenanceDirty = false;
    tlsDirty = false;
    routingDirty = false;
    await navigate(appTabSearch(page.url.searchParams, target));
  }

  // ── Monitoring range and decision filter (URL) ─────────────────────────
  const range = $derived(readAppRange(page.url.searchParams));
  const feedFilter = $derived(readFeedFilter(page.url.searchParams));

  function setRange(next: TimeRangeKey) {
    void navigate(writeAppRange(page.url.searchParams, next), { replace: true });
  }

  function setFeedFilter(next: FeedFilter) {
    void navigate(writeFeedFilter(page.url.searchParams, next), { replace: true });
  }

  function feedHref(filter: Partial<FeedFilter>): string {
    const search = writeFeedFilter(page.url.searchParams, { ...EMPTY_FEED_FILTER, ...filter });
    return `${page.url.pathname}${appTabSearch(search, 'decisions')}`;
  }

  // ── Routing ─────────────────────────────────────────────────────────────
  // A stable object per load: AppRouteForm resets itself when it changes.
  // Derived by the server from proxy_config; the agent route carries them too.
  const proxyWarnings = $derived(app?.proxy_warnings?.length ? app.proxy_warnings : (route?.proxy_warnings ?? []));
  const routingRedacted = $derived(hasRedactedSecrets(app, route));
  const routeInitial: RouteForm = $derived(app ? routeFormFromApp(app, route) : emptyRouteForm());

  async function saveRouting(form: RouteForm): Promise<string | null> {
    const current = app;
    if (!current) return 'The application is not loaded.';
    if (!ctx.canConfigure) return 'Changing the routing needs member or owner access.';
    // Redacted header values arrive blank; saving them would erase the real ones.
    if (hasRedactedSecrets(current, route)) return 'Header values are hidden at your access level, so the routing cannot be saved. Reload the page.';
    const my = epoch;
    if (assignment) {
      // The protection mode is part of the assignment (Assignment tab); an
      // empty mode leaves it unchanged.
      const { mode: _mode, ...body } = agentRouteBodyFrom(form);
      const res = await updateAgentRoute(projectId, assignment.agent_id, current.id, body);
      if (res.error) return appWriteErrorMessage(res.error, 'Could not save the routing.');
    } else {
      const res = await updateApp(projectId, current.id, appUpdateBodyFrom(form));
      if (res.error) return appWriteErrorMessage(res.error, 'Could not save the routing.');
    }
    if (my !== epoch) return null;
    routingDirty = false;
    toast.success(assignment ? 'The agent applies it with its next configuration bundle.' : 'Assign a WAF agent to serve the application.', 'Routing saved');
    await load({ silent: true });
    return null;
  }

  // ── Maintenance ─────────────────────────────────────────────────────────
  // The Maintenance tab owns the switch; the badge and the banner follow it.
  function setMaintenance(enabled: boolean) {
    if (!app) return;
    if (enabled) maintenanceSeenFor = app.id;
    if (Boolean(app.maintenance_enabled) !== enabled) app = { ...app, maintenance_enabled: enabled };
  }

  // ── Delete (typed confirmation, owner) ─────────────────────────────────
  let deleteOpen = $state(false);
  let deleting = $state(false);

  async function removeApp() {
    const current = app;
    if (!current || !ctx.canManage || deleting) return;
    deleting = true;
    const res = await deleteApp(projectId, current.id);
    deleting = false;
    if (res.error) {
      toast.error(res.error.error || 'Could not delete the application.', 'Application not deleted');
      return;
    }
    deleteOpen = false;
    configDirty = false;
    maintenanceDirty = false;
    tlsDirty = false;
    routingDirty = false;
    toast.success('Its routing, configuration history and custom rules were removed.', `${current.name} deleted`);
    await goto(`${base}/projects/${projectId}/apps`);
  }

  usePageDetail(() => app?.name);
</script>

<div class="page">
  {#if loading && !app}
    <PageHeader title="Application" backHref={`${base}/projects/${projectId}/apps`} backLabel="Applications" />
    <Spinner layout="block" tone="accent" label="Loading application" />
  {:else if loadError || !app}
    <PageHeader title="Application" backHref={`${base}/projects/${projectId}/apps`} backLabel="Applications" />
    {#if loadError?.status === 404}
      <EmptyState title="Application not found" message="It may have been deleted, or it belongs to another project." level={2}>
        {#snippet action()}<Button variant="primary" href={`${base}/projects/${projectId}/apps`}>Open applications</Button>{/snippet}
      </EmptyState>
    {:else}
      <InlineError message={loadError?.error || 'Could not load the application.'} onretry={() => void load()} />
    {/if}
  {:else}
    <PageHeader
      title={app.name}
      subtitle={summary ?? 'No routing yet: set the upstream and listen port on the Routing tab.'}
      backHref={`${base}/projects/${projectId}/apps`}
      backLabel="Applications"
    >
      {#snippet children()}
        <div class="app-status">
          <Badge tone={stateText.tone} title={stateText.hint}>{stateText.label}</Badge>
          {#if app.maintenance_enabled}
            <Badge tone="warning" title="Maintenance mode is on: visitors see the maintenance page.">Maintenance</Badge>
          {/if}
          {#if certificateBadge}
            <Badge tone={certificateBadge.tone} title={certificateBadge.title}>{certificateBadge.label}</Badge>
          {/if}
          {#if assignment}
            <span class="app-agent">
              Served by
              <a href={`${base}/projects/${projectId}/waf/${assignment.agent_id}`}>{agent?.name ?? 'WAF agent'}</a>
              {#if agent}<StatusDot status={agent.is_online ? 'online' : 'offline'} />{/if}
            </span>
          {:else}
            <span class="app-agent">No WAF agent serves this application.</span>
          {/if}
        </div>
      {/snippet}
      {#snippet actions()}
        {#if ctx.canManage}
          <Button variant="secondary" size="sm" onclick={() => (deleteOpen = true)}>Delete application</Button>
        {/if}
      {/snippet}
    </PageHeader>

    {#if bindingError}
      <Alert tone="warning" message={`The assignment could not be loaded: ${bindingError}`} ondismiss={() => (bindingError = '')} />
    {/if}

    <Tabs {tabs} bind:value={tabValue} onchange={(id) => void selectTab(id)} label="Application sections" id={TABS_ID} panels="external" />

    <div class="tab-panel" role="tabpanel" id={tabDomIds(TABS_ID, tab).panel} aria-labelledby={tabDomIds(TABS_ID, tab).tab}>
      {#if tabUnavailable}
        <Alert tone="info" message="That section needs a WAF agent. Assign one on the Assignment tab; showing Monitoring instead." />
      {:else if !assignment && (tab === 'monitoring' || tab === 'decisions')}
        <Alert tone="info" message="No WAF agent serves this application, so no new decisions are recorded. Assign one on the Assignment tab." />
      {/if}

      {#if app.maintenance_enabled && tab !== 'maintenance'}
        <Alert tone="warning">
          <p>
            {#if !assignment}
              Maintenance mode is on: visitors get the maintenance page as soon as a WAF agent is assigned.
            {:else}
              Maintenance mode is on: visitors see the maintenance page instead of the site.{#if tab === 'monitoring' || tab === 'decisions'}
                Requests answered with the maintenance page are not recorded as decisions.{/if}
            {/if}
          </p>
          {#snippet actions()}
            <Button variant="secondary" size="sm" href={appHref(base, projectId, app.id, 'maintenance')}>Open the Maintenance tab</Button>
          {/snippet}
        </Alert>
      {/if}

      {#if tab === 'monitoring'}
        <AppOverview {projectId} appId={app.id} {range} onrangechange={setRange} {feedHref} />
      {:else if tab === 'decisions'}
        <DecisionFeed {projectId} appId={app.id} filter={feedFilter} onfilterchange={setFeedFilter} {range} onrangechange={setRange} canConfigure={ctx.canConfigure} />
      {:else if tab === 'config' && assignment}
        <AppConfigPanel {projectId} agentId={assignment.agent_id} appId={app.id} appName={app.name} canConfigure={ctx.canConfigure} enforcementMode={route?.mode ?? null} bind:dirty={configDirty} />
      {:else if tab === 'blockwindow' && assignment}
        <AppBlockWindow {projectId} agentId={assignment.agent_id} agentName={agent?.name ?? ''} canConfigure={ctx.canConfigure} />
      {:else if tab === 'maintenance'}
        <AppMaintenance
          {projectId}
          appId={app.id}
          appName={app.name}
          assigned={Boolean(assignment)}
          agentName={agent?.name ?? ''}
          agentOnline={agent?.is_online}
          canConfigure={ctx.canConfigure}
          bind:dirty={maintenanceDirty}
          onchange={setMaintenance}
        />
      {:else if tab === 'https'}
        <AppTLS
          {projectId}
          appId={app.id}
          appName={app.name}
          assigned={Boolean(assignment)}
          agentName={agent?.name ?? ''}
          agentOnline={agent?.is_online}
          canConfigure={ctx.canConfigure}
          routing={routeInitial}
          routingHref={appHref(base, projectId, app.id, 'routing')}
          initial={tls ?? undefined}
          bind:dirty={tlsDirty}
          onchange={(next) => (tls = withoutDnsHints(next))}
        />
      {:else if tab === 'routing'}
        <section class="routing" aria-labelledby="routing-title">
          <header>
            <h2 id="routing-title">Routing</h2>
            <p>
              {#if assignment}
                The WAF agent listens on the listen address and forwards allowed requests to the upstream.
              {:else}
                Stored with the application. It takes effect once a WAF agent is assigned on the Assignment tab.
              {/if}
            </p>
          </header>
          {#if !ctx.canConfigure}
            <Alert tone="info" message="Read-only: changing the routing needs member or owner access." />
          {/if}
          {#if proxyWarnings.length}
            <Alert tone="warning" title="Review the client-IP trust settings">
              <ul class="proxy-warnings">
                {#each proxyWarnings as warning (warning.code)}<li>{warning.message}</li>{/each}
              </ul>
            </Alert>
          {/if}
          <AppRouteForm
            initial={routeInitial}
            submitLabel="Save routing"
            showMode={false}
            modeHint={assignment ? 'The protection mode is part of the assignment: change it on the Assignment tab.' : undefined}
            requireRouting={assigned}
            disabled={!ctx.canConfigure || routingRedacted}
            hiddenHeaderValues={routingRedacted && Boolean(app.proxy_header_values_set || route?.proxy_header_values_set)}
            bind:dirty={routingDirty}
            onsubmit={saveRouting}
          />
        </section>
      {:else if tab === 'assignment'}
        <AppAssignment
          {projectId}
          appId={app.id}
          appName={app.name}
          {agents}
          {assignment}
          canConfigure={ctx.canConfigure}
          maintenance={Boolean(app.maintenance_enabled)}
          onchanged={() => load({ silent: true })}
        />
      {/if}
    </div>
  {/if}
</div>

<ConfirmModal
  open={discardPrompt !== null}
  tone="warning"
  title="Discard unsaved changes?"
  message="Your edits in this section have not been saved. Leaving discards them."
  confirmLabel="Discard changes"
  cancelLabel="Keep editing"
  onconfirm={() => answerDiscard(true)}
  onclose={() => answerDiscard(false)}
/>

<ConfirmModal
  open={deleteOpen}
  tone="danger"
  title={`Delete ${app?.name ?? 'application'}?`}
  confirmLabel="Delete application"
  requireText={app?.name ?? ''}
  loading={deleting}
  onconfirm={() => void removeApp()}
  onclose={() => (deleteOpen = false)}
>
  <p class="confirm-text">
    Deletes the application with its routing, configuration history and custom rules.
    {#if agent}{agent.name} stops serving it: requests to its listen address are no longer proxied or inspected.{/if}
    Stored decisions stay until retention removes them. This cannot be undone.
  </p>
</ConfirmModal>

<style>
  .proxy-warnings { margin: var(--sp-1) 0 0; padding-left: var(--sp-5); font-size: var(--fs-sm); }
  .page { width: 100%; min-width: 0; box-sizing: border-box; padding: var(--page-top) var(--page-gutter) var(--sp-7); display: flex; flex-direction: column; gap: var(--sp-4); }
  .page :global(.page-header) { margin-bottom: 0; }
  .app-status { display: flex; align-items: center; gap: var(--sp-3); flex-wrap: wrap; margin-top: var(--sp-2); font-size: var(--fs-sm); color: var(--text-secondary); }
  .app-agent { display: inline-flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
  .app-agent a { color: var(--accent); text-decoration: none; font-weight: var(--fw-medium); }
  .app-agent a:hover { text-decoration: underline; }
  .tab-panel { display: flex; flex-direction: column; gap: var(--sp-4); min-width: 0; }
  .routing { display: flex; flex-direction: column; gap: var(--sp-4); width: 100%; min-width: 0; }
  .routing header h2 { margin: 0; font-size: var(--fs-md); }
  .routing header p { margin: var(--sp-1) 0 0; font-size: var(--fs-sm); color: var(--text-muted); line-height: 1.5; }
  .confirm-text { margin: 0; color: var(--text-secondary); line-height: 1.5; }
</style>
