<!--
  Applications: every application of the project, assigned or not:
  its state (Block / Monitor mode, Unassigned, Draft),
  the WAF agent that serves it and its route. Each row opens the single
  application page. "New application" uses the shared AppRouteForm; with a
  WAF agent chosen it creates the route on that agent, without one it
  saves an unassigned application. Deleting lives on the application page
  (typed confirmation).
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { base } from '#lib/paths.js';
  import { createAgentRoute, createApp, listAgentRoutes, listApps, listFleetAgents, updateApp, type AgentRoute, type App, type FleetAgent } from '#lib/api.js';
  import { getProjectContext } from '#lib/project-context.svelte.js';
  import { formatNumber } from '#lib/format.js';
  import { toast } from '#lib/stores/toast.js';
  import { pageOffset, pageParamFor, querySearch, readPageParam } from '#lib/url-state.js';
  import ProxyWarningBadge from '#lib/components/apps/ProxyWarningBadge.svelte';
  import { Badge, Button, DataTable, DateTime, Drawer, Field, InlineError, PageHeader, StatusDot, type DataTableColumn } from '#lib/components/ui/index.js';
  import Select from '#lib/components/ui/Select.svelte';
  import AppRouteForm from '#lib/components/apps/AppRouteForm.svelte';
  import { appHref } from '#lib/components/apps/app-page.js';
  import { APP_STATE_TEXT, appState, bindingIndex, routeSummary, type AppBinding } from '#lib/components/apps/inventory.js';
  import {
    agentRouteBodyFrom,
    appCreateBodyFrom,
    appUpdateBodyFrom,
    emptyRouteForm,
    needsAppUpdateAfterCreate,
    type RouteForm,
  } from '#lib/components/apps/route-model.js';

  const ctx = getProjectContext();
  const projectId = $derived(page.params.id ?? '');
  const PAGE_SIZE = 25;

  let apps = $state<App[]>([]);
  let total = $state(0);
  // Page number in the URL (?page=N): reload, Back and shared links keep it.
  const offset = $derived(pageOffset(readPageParam(page.url.searchParams), PAGE_SIZE));
  let agents = $state<FleetAgent[]>([]);
  let bindings = $state<Map<string, AppBinding>>(new Map());
  let loading = $state(true);
  let error = $state('');
  let bindingsError = $state('');
  let epoch = 0;

  /** Every route of an agent (the list endpoint pages by 100). */
  async function allRoutes(project: string, agentId: string): Promise<AgentRoute[] | null> {
    const out: AgentRoute[] = [];
    for (let at = 0; at < 10_000; at += 100) {
      const res = await listAgentRoutes(project, agentId, { limit: 100, offset: at });
      if (res.error) return null;
      const batch = res.data?.routes ?? [];
      out.push(...batch);
      if (batch.length < 100 || out.length >= (res.data?.total ?? 0)) break;
    }
    return out;
  }

  async function load() {
    const my = ++epoch;
    const project = projectId;
    const at = offset;
    loading = true;
    const [appsRes, agentsRes] = await Promise.all([listApps(project, { limit: PAGE_SIZE, offset: at }), listFleetAgents({ projectId: project, kind: 'waf' })]);
    if (my !== epoch) return;
    if (appsRes.error) {
      error = appsRes.error.error || 'Could not load the applications.';
      loading = false;
      return;
    }
    error = '';
    apps = appsRes.data?.apps ?? [];
    total = appsRes.data?.total ?? apps.length;
    if (at > 0 && at >= total) {
      // Past the last page (fewer applications now, or an old link).
      changePage(Math.max(0, total - 1));
      return;
    }
    agents = agentsRes.data?.agents ?? [];
    const routeLists = await Promise.all(agents.map(async (agent) => ({ agent, routes: await allRoutes(project, agent.id) })));
    if (my !== epoch) return;
    bindingsError = agentsRes.error || routeLists.some((r) => r.routes === null) ? 'The WAF agent of some applications could not be loaded.' : '';
    bindings = bindingIndex(routeLists.map((r) => ({ agent: r.agent, routes: r.routes ?? [] })));
    loading = false;
  }

  $effect(() => {
    void projectId;
    untrack(() => {
      apps = [];
      bindings = new Map();
    });
    return () => {
      epoch++;
    };
  });

  $effect(() => {
    void projectId;
    void offset;
    untrack(() => void load());
  });

  function changePage(next: number) {
    const qs = querySearch(page.url.searchParams, { page: pageParamFor(next, PAGE_SIZE) });
    void goto(`${page.url.pathname}${qs}`, { replace: true, reset: false });
  }

  const columns: DataTableColumn<App>[] = [
    { key: 'name', label: 'Application', rowHeader: true },
    { key: 'state', label: 'State', nowrap: true },
    { key: 'agent', label: 'WAF agent', nowrap: true },
    { key: 'route', label: 'Route' },
    { key: 'updated', label: 'Updated', nowrap: true },
  ];

  // ── New application ─────────────────────────────────────────────────────
  let createOpen = $state(false);
  let createDirty = $state(false);
  let createInitial = $state<RouteForm>(emptyRouteForm());
  let createAgentId = $state('');
  let createDrawer = $state<ReturnType<typeof Drawer>>();

  function openCreate() {
    createInitial = emptyRouteForm();
    createAgentId = agents.length === 1 ? agents[0].id : '';
    createDirty = false;
    createOpen = true;
  }

  function closeCreate() {
    createOpen = false;
    createDirty = false;
  }

  async function create(form: RouteForm): Promise<string | null> {
    if (!ctx.canConfigure) return 'Creating applications needs member or owner access.';
    const agentId = createAgentId;
    let appId = '';
    if (agentId) {
      const res = await createAgentRoute(projectId, agentId, agentRouteBodyFrom(form));
      if (res.error || !res.data) {
        if (res.error?.code === 'CONFLICT') return 'An application with this name already exists in this project.';
        if (res.error?.code === 'LISTEN_HOST_TAKEN') return 'Another application already uses this listen address.';
        return res.error?.error || 'Could not create the application.';
      }
      appId = res.data.route.app_id;
    } else {
      const res = await createApp(projectId, appCreateBodyFrom(form));
      if (res.error || !res.data) {
        if (res.error?.status === 409) return 'An application with this name already exists in this project.';
        return res.error?.error || 'Could not create the application.';
      }
      appId = res.data.app.id;
      if (needsAppUpdateAfterCreate(form)) {
        // POST …/apps carries name, listen address and upstream only.
        const update = await updateApp(projectId, appId, appUpdateBodyFrom(form));
        if (update.error) {
          closeCreate();
          toast.warning(`The listen port and proxy settings were not saved: ${update.error.error}. Set them on the Routing tab.`, `${form.name.trim()} created`);
          await goto(appHref(base, projectId, appId, 'routing'));
          return null;
        }
      }
    }
    closeCreate();
    toast.success(agentId ? 'The agent starts serving it with its next configuration bundle.' : 'Assign a WAF agent on the Assignment tab to protect it.', `${form.name.trim()} created`);
    await goto(appHref(base, projectId, appId, agentId ? 'monitoring' : 'assignment'));
    return null;
  }
</script>

<div class="page">
  <PageHeader
    title="Applications"
    subtitle="Each application is a route through a WAF agent: the agent listens on the listen address and forwards allowed requests to the upstream."
    backHref={`${base}/projects/${projectId}`}
  >
    {#snippet actions()}
      {#if ctx.canConfigure}
        <Button variant="primary" onclick={openCreate}>New application</Button>
      {/if}
    {/snippet}
  </PageHeader>

  <details class="explain">
    <summary>How applications reach your WAF agents</summary>
    <p>
      An application has one active WAF agent at a time; an agent can serve many applications. Agents authenticate with the project's mTLS
      credentials and receive their configuration over gRPC, so a saved change is active once the agent has applied its next bundle.
      Moving an application to another agent keeps its configuration, history and decisions.
    </p>
  </details>

  {#if !ctx.canConfigure && ctx.project}
    <p class="note">Read-only: a project member or owner can create applications and change their routing.</p>
  {/if}
  {#if bindingsError}
    <InlineError message={bindingsError} onretry={() => void load()} />
  {/if}

  <DataTable
    rows={apps}
    {columns}
    rowKey={(a) => a.id}
    caption="Applications"
    {loading}
    error={error || null}
    onretry={() => void load()}
    emptyTitle="No applications yet"
    emptyMessage={ctx.canConfigure ? 'Create one with New application, or add it from a WAF agent.' : 'A project member or owner can create applications.'}
    onpage={changePage}
    {total}
    {offset}
    limit={PAGE_SIZE}
    itemLabel="applications"
  >
    {#snippet cell(a, column)}
      {@const binding = bindings.get(a.id)}
      {#if column.key === 'name'}
        <a class="app-link" href={appHref(base, projectId, a.id)}>{a.name}</a><ProxyWarningBadge warnings={a.proxy_warnings} />
      {:else if column.key === 'state'}
        {@const text = APP_STATE_TEXT[appState(a, binding)]}
        <Badge tone={text.tone} title={text.hint}>{text.label}</Badge>
      {:else if column.key === 'agent'}
        {#if binding}
          <span class="agent">
            <a href={`${base}/projects/${projectId}/waf/${binding.agentId}`}>{binding.agentName}</a>
            <StatusDot status={binding.online ? 'online' : 'offline'} hideLabel />
          </span>
        {:else}
          <span class="muted">None</span>
        {/if}
      {:else if column.key === 'route'}
        {@const text = routeSummary(a.listen_host ?? binding?.route.listen_host, a.listen_port ?? binding?.route.listen_port, a.upstream_url ?? binding?.route.upstream)}
        {#if text}<code class="route">{text}</code>{:else}<span class="muted">No routing yet</span>{/if}
      {:else if column.key === 'updated'}
        <DateTime value={a.updated_at} relative />
      {/if}
    {/snippet}
    {#snippet actions(a)}
      <Button variant="ghost" size="sm" href={appHref(base, projectId, a.id)} aria-label={`Open ${a.name}`}>Open</Button>
    {/snippet}
    {#snippet footer()}
      {#if !loading && total > 0}<span class="note">{formatNumber(bindings.size)} of the project's applications are served by a WAF agent.</span>{/if}
    {/snippet}
  </DataTable>
</div>

<Drawer bind:this={createDrawer} open={createOpen} title="New application" size="lg" dirty={createDirty} onclose={closeCreate} ondiscard={closeCreate}>
  {#if createOpen}
    <AppRouteForm
      initial={createInitial}
      submitLabel="Create application"
      savingLabel="Creating…"
      requireRouting={Boolean(createAgentId)}
      showMode={Boolean(createAgentId)}
      modeHint="Without a WAF agent the application is saved unassigned: its traffic is not inspected until you assign one. Upstream and port may then stay empty."
      creating
      bind:dirty={createDirty}
      onsubmit={create}
      oncancel={() => createDrawer?.requestClose('close-button')}
    >
      {#snippet before()}
        <Field label="WAF agent" optional hint={agents.length === 0 ? 'No WAF agents are registered yet; register one on WAF agents, or save the application unassigned.' : 'The agent that serves and protects the application. Offline agents apply it when they reconnect.'}>
          {#snippet children(c)}
            <Select
              {...c}
              options={[{ value: '', label: 'No agent yet (unassigned)' }, ...agents.map((agent) => ({ value: agent.id, label: `${agent.name}${agent.is_online ? '' : ' (offline)'}` }))]}
              bind:value={createAgentId}
            />
          {/snippet}
        </Field>
      {/snippet}
    </AppRouteForm>
  {/if}
</Drawer>

<style>
  .page { width: 100%; min-width: 0; box-sizing: border-box; padding: var(--page-top) var(--page-gutter) var(--sp-7); display: flex; flex-direction: column; gap: var(--sp-4); }
  .page :global(.page-header) { margin-bottom: 0; }
  .explain { font-size: var(--fs-sm); color: var(--text-secondary); max-width: 70ch; }
  .explain summary { cursor: pointer; color: var(--text-secondary); }
  .explain p { margin: var(--sp-2) 0 0; color: var(--text-muted); line-height: 1.5; }
  .note, .muted { margin: 0; color: var(--text-muted); font-size: var(--fs-sm); }
  .app-link, .agent a { color: var(--accent); text-decoration: none; font-weight: var(--fw-medium); }
  .app-link:hover, .agent a:hover { text-decoration: underline; }
  .agent { display: inline-flex; align-items: center; gap: var(--sp-2); }
  .route { font-family: var(--font-mono); font-size: var(--fs-xs); overflow-wrap: anywhere; color: var(--text-primary); }
</style>
