<!--
  WAF agent, the applications this agent serves (each links to its single
  application page), "Add application" with the shared AppRouteForm,
  and the agent's inspection health, SIEM delivery and security data.
  Editing an application's routing, its WAF configuration and its block
  window live on the application page; the agent page lists and assigns.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { page } from '$app/state';
  import { base } from '#lib/paths.js';
  import {
    createAgentRoute,
    getAgent,
    getAgentSecurityData,
    listAgentRoutes,
    unassignAppWAFAgent,
    type AgentRoute,
    type AgentSecurityDataStatus,
    type ApiError,
    type FleetAgent,
  } from '#lib/api.js';
  import { getProjectContext } from '#lib/project-context.svelte.js';
  import { createPoller } from '#lib/polling.svelte.js';
  import { parseSIEMDelivery } from '#lib/siem-delivery.js';
  import { ANALYZE_P99_BUDGET_US, formatLatencyMs, healthPanicked, healthReported, latencyGapText, latencyOverBudget, rulesNotApplied, wafHealthItems } from '#lib/waf-health.js';
  import { modeTone } from '#lib/tone.js';
  import ProxyWarningBadge from '#lib/components/apps/ProxyWarningBadge.svelte';
  import { scriptRulesWarning } from '#lib/inspection.js';
  import { formatBytes, formatNumber } from '#lib/format.js';
  import { toast } from '#lib/stores/toast.js';
  import { usePageDetail } from '#lib/page-meta.svelte.js';
  import {
    Alert,
    Badge,
    Button,
    ConfirmModal,
    DataTable,
    DateTime,
    Drawer,
    EmptyState,
    InlineError,
    PageHeader,
    Spinner,
    StatusDot,
    type DataTableColumn,
  } from '#lib/components/ui/index.js';
  import AppRouteForm from '#lib/components/apps/AppRouteForm.svelte';
  import { appHref } from '#lib/components/apps/app-page.js';
  import { agentRouteBodyFrom, emptyRouteForm, listenLabel, parseUpstream, PROTECTION_MODE_TEXT, type RouteForm } from '#lib/components/apps/route-model.js';

  const ctx = getProjectContext();
  const projectId = $derived(page.params.id ?? '');
  const agentId = $derived(page.params.agentId ?? '');

  const PAGE_SIZE = 25;
  const REFRESH_MS = 15_000;

  let agent = $state<FleetAgent | null>(null);
  let routes = $state<AgentRoute[]>([]);
  let routesTotal = $state(0);
  let routesOffset = $state(0);
  let loading = $state(true);
  let loadError = $state<ApiError | null>(null);
  let routesError = $state('');
  let securityData = $state<AgentSecurityDataStatus | null>(null);
  let securityError = $state('');
  let securityLoading = $state(false);
  let epoch = 0;

  async function load() {
    const my = ++epoch;
    const project = projectId;
    const id = agentId;
    const offset = routesOffset;
    const [agentRes, routesRes] = await Promise.all([getAgent(id), listAgentRoutes(project, id, { limit: PAGE_SIZE, offset })]);
    if (my !== epoch) return;
    loading = false;
    if (agentRes.error || !agentRes.data) {
      loadError = agentRes.error ?? { error: 'Could not load the agent.' };
      return;
    }
    // /api/fleet/agents/:id answers for any project the user can see: an
    // agent of another project must not show under this project's breadcrumb.
    if (agentRes.data.project_id && agentRes.data.project_id !== project) {
      agent = null;
      routes = [];
      loadError = { error: 'WAF agent not found.', status: 404 };
      return;
    }
    loadError = null;
    agent = agentRes.data;
    if (routesRes.error) {
      routesError = routesRes.error.error || 'Could not load the applications.';
    } else {
      routesError = '';
      routes = routesRes.data?.routes ?? [];
      routesTotal = routesRes.data?.total ?? routes.length;
    }
  }

  async function loadSecurityData() {
    const project = projectId;
    const id = agentId;
    securityLoading = true;
    const res = await getAgentSecurityData(project, id);
    if (project !== projectId || id !== agentId) return;
    securityLoading = false;
    securityError = res.error?.error ?? '';
    securityData = res.data ?? null;
  }

  // Refreshes the heartbeat and the list every 15 s while the tab is visible.
  const poller = createPoller(() => load(), REFRESH_MS, { immediate: false });

  $effect(() => {
    void `${projectId}/${agentId}`;
    untrack(() => {
      epoch++;
      agent = null;
      routes = [];
      routesTotal = 0;
      routesOffset = 0;
      loading = true;
      loadError = null;
      routesError = '';
      securityData = null;
      securityError = '';
      addOpen = false;
      unassign = null;
      void poller.trigger();
      void loadSecurityData();
    });
  });

  function changePage(offset: number) {
    routesOffset = Math.max(0, offset);
    void poller.trigger();
  }

  const online = $derived(agent?.is_online ?? false);
  const scriptWarning = $derived(scriptRulesWarning(agent?.script_rules, 'agent'));
  const delivery = $derived(parseSIEMDelivery(agent?.host_info?.siem_delivery));
  const health = $derived(agent && healthReported(agent) ? wafHealthItems(agent) : null);
  const panicked = $derived(agent ? healthPanicked(agent) : false);
  const notApplied = $derived(agent ? rulesNotApplied(agent) : 0);
  const latency = $derived(
    agent
      ? [
          { label: 'p50', value: agent.analyze_latency_p50_us },
          { label: 'p95', value: agent.analyze_latency_p95_us },
          { label: 'p99', value: agent.analyze_latency_p99_us },
        ]
      : [],
  );
  const overBudget = $derived(latencyOverBudget(agent?.analyze_latency_p99_us));

  // ── Applications table ──────────────────────────────────────────────────
  const columns: DataTableColumn<AgentRoute>[] = [
    { key: 'name', label: 'Application', rowHeader: true },
    { key: 'mode', label: 'Protection mode', nowrap: true },
    { key: 'listen', label: 'Listen address', nowrap: true },
    { key: 'upstream', label: 'Upstream' },
  ];

  function upstreamText(r: AgentRoute): string {
    const parsed = parseUpstream(r.upstream);
    return parsed.type === 'fcgi' ? `FastCGI ${parsed.addr}` : parsed.addr;
  }

  // ── Add application ─────────────────────────────────────────────────────
  let addOpen = $state(false);
  let addDirty = $state(false);
  let addInitial = $state<RouteForm>(emptyRouteForm());
  let addDrawer = $state<ReturnType<typeof Drawer>>();

  function openAdd() {
    addInitial = emptyRouteForm();
    addDirty = false;
    addOpen = true;
  }

  function closeAdd() {
    addOpen = false;
    addDirty = false;
  }

  async function createRoute(form: RouteForm): Promise<string | null> {
    if (!ctx.canConfigure) return 'Adding applications needs member or owner access.';
    const res = await createAgentRoute(projectId, agentId, agentRouteBodyFrom(form));
    if (res.error) {
      if (res.error.code === 'CONFLICT') return 'An application with this name already exists in this project. Choose another name, or assign the existing application from its Assignment tab.';
      if (res.error.code === 'LISTEN_HOST_TAKEN') return 'Another application already uses this listen address.';
      return res.error.error || 'Could not add the application.';
    }
    closeAdd();
    toast.success(`${agent?.name ?? 'The agent'} starts serving it with its next configuration bundle.`, `${form.name.trim()} added`);
    const warnings = res.data?.route?.proxy_warnings ?? [];
    if (warnings.length) toast.warning(warnings.map((w) => w.message).join(' '), 'Review the proxy trust settings');
    await poller.trigger();
    return null;
  }

  // ── Unassign (simple confirmation) ─────────────────────────────────────
  let unassign = $state<AgentRoute | null>(null);
  let unassigning = $state(false);

  async function confirmUnassign() {
    const target = unassign;
    if (!target || !ctx.canConfigure || unassigning) return;
    unassigning = true;
    const res = await unassignAppWAFAgent(projectId, target.app_id);
    unassigning = false;
    if (res.error) {
      toast.error(res.error.error || 'Could not unassign the application.', 'Not unassigned');
      return;
    }
    unassign = null;
    toast.success('Its routing, configuration and history are kept; assign an agent again from the application page.', `${target.name} unassigned`);
    await poller.trigger();
  }

  usePageDetail(() => agent?.name);
</script>

<div class="page">
  <PageHeader
    title={agent?.name ?? 'WAF agent'}
    subtitle={agent ? `WAF agent · version ${agent.version || 'unknown'}` : 'Applications served by this WAF agent'}
    backHref={`${base}/projects/${projectId}/waf`}
    backLabel="WAF agents"
  >
    {#snippet children()}
      {#if agent}
        <div class="agent-status">
          <StatusDot status={online ? 'online' : 'offline'} pulse={online} />
          <span>Last heartbeat <DateTime value={agent.last_seen} relative fallback="never" /></span>
          <code class="agent-id" title="Agent ID">{agent.id}</code>
        </div>
      {/if}
    {/snippet}
    {#snippet actions()}
      {#if ctx.canConfigure && agent}
        <Button variant="primary" size="sm" onclick={openAdd}>Add application</Button>
      {/if}
    {/snippet}
  </PageHeader>

  {#if loading && !agent}
    <Spinner layout="block" tone="accent" label="Loading agent" />
  {:else if loadError && !agent}
    {#if loadError.status === 404}
      <EmptyState title="WAF agent not found" message="It may have been deleted, or it belongs to another project." level={2}>
        {#snippet action()}<Button variant="primary" href={`${base}/projects/${projectId}/waf`}>Open WAF agents</Button>{/snippet}
      </EmptyState>
    {:else}
      <InlineError message={loadError.error || 'Could not load the agent.'} onretry={() => void poller.trigger()} />
    {/if}
  {:else if agent}
    {#if !ctx.canConfigure}
      <Alert tone="info" message="Read-only: adding and unassigning applications needs member or owner access." />
    {/if}
    {#if agent.kind && agent.kind !== 'waf'}
      <Alert tone="warning" message="This is not a WAF agent; it cannot serve applications. Open it from Hosts." />
    {/if}

    {#if scriptWarning}
      <Alert tone="warning" title="Script rules do not run on this agent" message={scriptWarning} />
    {/if}

    <section class="section" aria-labelledby="apps-title">
      <header class="section-head">
        <div>
          <h2 id="apps-title">Applications <span class="count">{formatNumber(routesTotal)}</span></h2>
          <p>Each application has one WAF agent. Open an application for monitoring, decisions, WAF configuration, block window and routing.</p>
        </div>
      </header>
      <DataTable
        rows={routes}
        {columns}
        rowKey={(r) => r.app_id}
        caption={`Applications served by ${agent.name}`}
        loading={loading && routes.length === 0}
        error={routesError || null}
        onretry={() => void poller.trigger()}
        emptyTitle="No applications on this agent"
        emptyMessage={ctx.canConfigure ? 'Add an application, or assign an existing one from its Assignment tab.' : 'A project member or owner can add or assign applications.'}
        onpage={changePage}
        total={routesTotal}
        offset={routesOffset}
        limit={PAGE_SIZE}
        itemLabel="applications"
        actionsLabel="Actions"
      >
        {#snippet cell(r, column)}
          {#if column.key === 'name'}
            <a class="app-link" href={appHref(base, projectId, r.app_id)}>{r.name}</a><ProxyWarningBadge warnings={r.proxy_warnings} />
          {:else if column.key === 'mode'}
            <span class="mode">
              <Badge tone={modeTone(r.mode)}>{PROTECTION_MODE_TEXT[r.mode === 'monitor' ? 'monitor' : 'block'].label}</Badge>
              {#if r.maintenance_enabled}<Badge tone="warning" title="Maintenance mode is on: visitors see the maintenance page.">Maintenance</Badge>{/if}
            </span>
          {:else if column.key === 'listen'}
            <code>{listenLabel(r.listen_host, r.listen_port)}</code>
          {:else if column.key === 'upstream'}
            <code class="upstream" title={r.upstream}>{upstreamText(r)}</code>
          {/if}
        {/snippet}
        {#snippet actions(r)}
          <Button variant="ghost" size="sm" href={appHref(base, projectId, r.app_id, 'routing')} aria-label={`Edit routing of ${r.name}`}>Routing</Button>
          {#if ctx.canConfigure}
            <Button variant="ghost" size="sm" aria-label={`Unassign ${r.name} from ${agent?.name ?? 'this agent'}`} onclick={() => (unassign = r)}>Unassign</Button>
          {/if}
        {/snippet}
      </DataTable>
    </section>

    <section class="panel" aria-labelledby="health-title">
      <header class="panel-head">
        <div>
          <h2 id="health-title">Inspection health</h2>
          <p>Analysis counters from the latest heartbeat, cumulative since the agent process started.</p>
        </div>
        <Button variant="ghost" size="sm" onclick={() => void poller.trigger()}>Refresh heartbeat</Button>
      </header>
      {#if health}
        <div class="latency">
          <div class="latency-head">
            <h3 id="latency-title">Analyze latency</h3>
            <span class="muted">{latencyGapText(agent)} · budget p99 ≤ {formatLatencyMs(ANALYZE_P99_BUDGET_US)}</span>
            {#if overBudget}<Badge tone="warning">p99 over budget</Badge>{/if}
          </div>
          <dl class="metrics">
            {#each latency as item (item.label)}
              <div><dt>{item.label}</dt><dd>{formatLatencyMs(item.value)}</dd></div>
            {/each}
          </dl>
        </div>
        <dl class="metrics">
          {#each health as item (item.key)}
            <div class:alert={item.attention === 'alert'} class:warn={item.attention === 'warning'}><dt>{item.label}</dt><dd>{item.value}</dd></div>
          {/each}
        </dl>
        {#if panicked}
          <Alert tone="warning" message="Panics were recovered: affected requests were allowed without full inspection. Check the agent logs for the stack trace." />
        {/if}
        {#if notApplied > 0}
          <Alert tone="warning" message="Some custom rules were not applied by this agent (script rules rejected or regex rules dropped at bundle load). Custom rules marks rules with an invalid or too complex regex." />
        {/if}
      {:else}
        <p class="muted">Not reported: this agent version predates inspection-health counters.</p>
      {/if}
      <details class="explain">
        <summary>What these counters mean <span>Reported <DateTime value={agent.waf_health_updated_at} fallback="never" /></span></summary>
        <p>Counts reset when the agent restarts. Engine panics: a detection engine crashed on a request and was recovered. Analyze panics: the whole analysis failed and the request was allowed. Partial coverage: requests the scan could not fully cover, so part of the request was not inspected. Parse budget hit: scans that skipped relaxed-parse variants because their work budget ran out. Agent panics: other recovered panics in the agent. Script errors and script incomplete: script-rule runs that failed or ran out of budget (logged, the engines still ran). Script rules rejected and regex rules dropped: custom rules the agent refused to load. Script runs in flight: script-rule runs still executing now. Analyze latency covers the last 5 minutes; a dash means no requests were analysed or the agent version does not report it.</p>
      </details>
    </section>

    <section class="panel" aria-labelledby="siem-title">
      <header class="panel-head">
        <div>
          <h2 id="siem-title">SIEM delivery</h2>
          <p>Agent-wide delivery counters from the latest heartbeat.</p>
        </div>
        <Button variant="ghost" size="sm" onclick={() => void poller.trigger()}>Refresh heartbeat</Button>
      </header>
      {#if delivery}
        <dl class="metrics">
          {#each [['Queued total', delivery.accepted], ['HTTP accepted', delivery.delivered], ['Failed', delivery.failed], ['Dropped', delivery.dropped], ['Retries', delivery.retried], ['Queued now', delivery.queued], ['In flight', delivery.in_flight]] as [label, count] (label)}
            <div><dt>{label}</dt><dd>{formatNumber(Number(count))}</dd></div>
          {/each}
        </dl>
        {#if delivery.failed > 0 || delivery.dropped > 0}
          <Alert tone="warning" message="Delivery failures or loss recorded. Check the destination and the agent logs." />
        {/if}
      {:else}
        <p class="muted">Delivery telemetry unavailable; no delivery outcome can be inferred.</p>
      {/if}
      <details class="explain">
        <summary>Scope and delivery guarantees <span>Heartbeat <DateTime value={agent.last_seen} fallback="never" /></span></summary>
        <p>Counters cover all applications and webhook destinations on this agent and reset when its process restarts. Queued totals are accepted into memory, not delivered. HTTP acceptance does not confirm downstream processing.</p>
        <p>The queue is bounded and not durable. Queued now excludes in-flight requests. A stale heartbeat does not describe live queue state.</p>
      </details>
    </section>

    <section class="panel" aria-labelledby="secdata-title">
      <header class="panel-head">
        <div>
          <h2 id="secdata-title">Agent security data</h2>
          <p>{securityData?.online ? 'Component inventory reported by the connected agent.' : 'Agent offline or no report: the applied security data is unknown.'}</p>
        </div>
        <Button variant="ghost" size="sm" loading={securityLoading} onclick={() => void loadSecurityData()}>Refresh status</Button>
      </header>
      <InlineError message={securityError} onretry={() => void loadSecurityData()} />
      <div class="table-wrap" role="region" aria-label="Security data components" tabindex="-1">
        <table>
          <thead><tr><th scope="col">Component</th><th scope="col">Reported presence</th><th scope="col">Size</th><th scope="col">Last modified</th></tr></thead>
          <tbody>
            <!-- An agent of version 1 also reports a `crs` component. No agent has it now, so it is not listed. -->
            {#each Object.entries(securityData?.components ?? {}).filter(([name]) => name !== 'crs') as [name, component] (name)}
              <tr>
                <th scope="row">{name}</th>
                <td><Badge tone={component.exists ? 'neutral' : 'warning'}>{component.exists ? 'Present' : 'Missing'}</Badge></td>
                <td>{formatBytes(component.size_bytes)}</td>
                <td><DateTime value={component.modified_at} fallback="Not reported" /></td>
              </tr>
            {:else}
              <tr><td colspan="4" class="muted">No component inventory available. Refresh to request the latest status.</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
      <p class="muted small">Listen ports are set per application route; there is no agent-wide override.</p>
    </section>
  {/if}
</div>

<Drawer
  bind:this={addDrawer}
  open={addOpen}
  title={`Add application to ${agent?.name ?? 'agent'}`}
  size="lg"
  dirty={addDirty}
  onclose={closeAdd}
  ondiscard={closeAdd}
>
  {#if addOpen}
    <p class="drawer-intro">Creates the application and assigns it to this agent. The agent listens on the listen address and forwards allowed requests to the upstream.</p>
    <AppRouteForm
      initial={addInitial}
      submitLabel="Add application"
      savingLabel="Adding…"
      creating
      bind:dirty={addDirty}
      onsubmit={createRoute}
      oncancel={() => addDrawer?.requestClose('close-button')}
    />
  {/if}
</Drawer>

<ConfirmModal
  open={unassign !== null}
  tone="warning"
  title={`Unassign ${unassign?.name ?? 'application'}?`}
  confirmLabel="Unassign"
  loading={unassigning}
  onconfirm={() => void confirmUnassign()}
  onclose={() => (unassign = null)}
>
  <p class="confirm-text">{agent?.name ?? 'The agent'} stops serving <strong>{unassign?.name}</strong>: requests to <code>{unassign ? listenLabel(unassign.listen_host, unassign.listen_port) : ''}</code> are no longer proxied or inspected. The application keeps its routing, configuration and history; delete it from its application page.</p>
</ConfirmModal>

<style>
  .page { width: 100%; min-width: 0; box-sizing: border-box; padding: var(--page-top) var(--page-gutter) var(--sp-7); display: flex; flex-direction: column; gap: var(--sp-5); }
  .page :global(.page-header) { margin-bottom: 0; }
  .agent-status { display: flex; align-items: center; gap: var(--sp-3); flex-wrap: wrap; margin-top: var(--sp-2); font-size: var(--fs-sm); color: var(--text-secondary); }
  .agent-id { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--text-muted); }
  .section { display: flex; flex-direction: column; gap: var(--sp-3); min-width: 0; }
  .section-head h2, .panel-head h2 { margin: 0; font-size: var(--fs-md); color: var(--text-primary); }
  .section-head p, .panel-head p { margin: var(--sp-1) 0 0; font-size: var(--fs-sm); color: var(--text-muted); line-height: 1.5; }
  .count { font-size: var(--fs-xs); color: var(--text-muted); font-weight: var(--fw-medium); margin-left: var(--sp-1); }
  .app-link { color: var(--accent); text-decoration: none; font-weight: var(--fw-medium); }
  .mode { display: inline-flex; align-items: center; gap: var(--sp-1); }
  .app-link:hover { text-decoration: underline; }
  code, .upstream { font-family: var(--font-mono); font-size: var(--fs-xs); overflow-wrap: anywhere; }
  .panel { display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--sp-4) var(--sp-5); background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-lg); min-width: 0; }
  .panel-head { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--sp-4); flex-wrap: wrap; }
  .metrics { display: grid; grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr)); gap: var(--sp-3); margin: 0; }
  .metrics div { display: flex; flex-direction: column; gap: var(--sp-1); padding: var(--sp-3); border: 1px solid var(--border); border-radius: var(--radius); }
  .metrics dt { font-size: var(--fs-xs); color: var(--text-muted); }
  .metrics dd { margin: 0; font-size: var(--fs-md); font-variant-numeric: tabular-nums; color: var(--text-primary); }
  .metrics .alert dt, .metrics .alert dd { color: var(--danger); font-weight: var(--fw-semibold); }
  .metrics .warn dt, .metrics .warn dd { color: var(--warning); font-weight: var(--fw-semibold); }
  .latency { display: flex; flex-direction: column; gap: var(--sp-2); }
  .latency-head { display: flex; align-items: center; flex-wrap: wrap; gap: var(--sp-2) var(--sp-3); }
  .latency-head h3 { margin: 0; font-size: var(--fs-sm); color: var(--text-primary); }
  .explain summary { cursor: pointer; font-size: var(--fs-sm); color: var(--text-secondary); }
  .explain summary span { color: var(--text-muted); font-size: var(--fs-xs); margin-left: var(--sp-2); }
  .explain p { margin: var(--sp-2) 0 0; font-size: var(--fs-sm); color: var(--text-muted); line-height: 1.5; }
  .muted { margin: 0; color: var(--text-muted); font-size: var(--fs-sm); }
  .small { font-size: var(--fs-xs); }
  .table-wrap { overflow-x: auto; }
  .table-wrap table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
  .table-wrap th, .table-wrap td { text-align: left; padding: var(--sp-2) var(--sp-3); border-bottom: 1px solid var(--border); }
  .table-wrap thead th { font-size: var(--fs-xs); color: var(--text-muted); font-weight: var(--fw-medium); }
  .table-wrap tbody th { font-weight: var(--fw-medium); color: var(--text-primary); font-family: var(--font-mono); font-size: var(--fs-xs); }
  .drawer-intro { margin: 0 0 var(--sp-4); font-size: var(--fs-sm); color: var(--text-muted); line-height: 1.5; }
  .confirm-text { margin: 0; color: var(--text-secondary); line-height: 1.5; }
  .confirm-text code { font-family: var(--font-mono); color: var(--text-primary); }
</style>
