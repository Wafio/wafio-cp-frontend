<!--
  WAF agents, the project's layer-7 inspection agents. Online status and last
  heartbeat come live from /waf/stream
  (ticket-authenticated, every WAF agent of the project, 90 s liveness);
  the inventory reloads when the stream reports agents that were added or
  removed elsewhere. Any project member or owner may register or delete an
  agent; deleting a running agent is refused (409 AGENT_ONLINE) and can be
  forced after a second confirmation that shows the server's hint.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { page } from '$app/state';
  import { base } from '#lib/paths.js';
  import { deleteProjectAgent, listAgentRoutes, listFleetAgents, registerFleetAgent, type FleetAgent } from '#lib/api.js';
  import { createProjectEventStream, type SSEConnectionState } from '#lib/sse.js';
  import { getProjectContext } from '#lib/project-context.svelte.js';
  import { formatDateTime, formatNumber, formatVersion } from '#lib/format.js';
  import { toast } from '#lib/stores/toast.js';
  import { mergeAgentStatus, parseAgentStatusList } from '#lib/waf-live.js';
  import { formatLatencyMs, healthNeedsAttention, healthReported, latencyGapText, latencyOverBudget, wafHealthItems } from '#lib/waf-health.js';
  import {
    Alert,
    Badge,
    Button,
    ConfirmModal,
    DataTable,
    DateTime,
    Field,
    InlineError,
    KpiStrip,
    Modal,
    PageHeader,
    StatusDot,
    type DataTableColumn,
    type KpiItem,
    type StatusKind,
  } from '#lib/components/ui/index.js';
  import { agentDeleteError, isAgentOnlineRefusal, validateAgentName, wafAgentInstall } from '#lib/components/apps/inventory.js';

  const ctx = getProjectContext();
  const projectId = $derived(page.params.id ?? '');

  let agents = $state<FleetAgent[]>([]);
  let total = $state(0);
  let appCounts = $state<Record<string, number | null>>({});
  let loading = $state(true);
  let error = $state('');
  let epoch = 0;

  async function load() {
    const my = ++epoch;
    const project = projectId;
    const res = await listFleetAgents({ projectId: project, kind: 'waf' });
    if (my !== epoch) return;
    if (res.error) {
      error = res.error.error || 'Could not load the WAF agents.';
      loading = false;
      return;
    }
    error = '';
    agents = res.data?.agents ?? [];
    total = res.data?.total ?? agents.length;
    loading = false;
    // Application count per agent: `total` of a one-row page.
    const counts = await Promise.all(
      agents.map(async (a) => {
        const r = await listAgentRoutes(project, a.id, { limit: 1 });
        return [a.id, r.error ? null : (r.data?.total ?? r.data?.routes.length ?? 0)] as const;
      }),
    );
    if (my !== epoch) return;
    appCounts = Object.fromEntries(counts);
  }

  // ── Live status (/waf/stream, ticket per connect) ───────────────
  let streamState = $state<SSEConnectionState>('connecting');
  let streamError = $state('');

  $effect(() => {
    const project = projectId;
    untrack(() => {
      agents = [];
      appCounts = {};
      total = 0;
      loading = true;
      error = '';
      streamError = '';
      void load();
    });
    // Only projectId drives this effect; the stream itself must not subscribe it.
    const conn = untrack(() => createProjectEventStream({
      projectId: project,
      stream: 'waf',
      events: {
        agents: (data) => {
          const statuses = parseAgentStatusList(data);
          if (!statuses || loading) return;
          const merged = mergeAgentStatus(agents, statuses);
          if (merged.agents !== agents && merged.agents.some((a, i) => a !== agents[i])) agents = merged.agents;
          // Registered or deleted elsewhere: the inventory itself changed.
          if (merged.added.length > 0 || merged.removed.length > 0) void load();
        },
      },
      onStateChange: (state) => (streamState = state),
      onFatal: (fatal) => (streamError = fatal.error),
    }));
    return () => {
      epoch++;
      conn.close();
    };
  });

  const onlineCount = $derived(agents.filter((a) => a.is_online).length);
  const appTotal = $derived.by(() => {
    const values = agents.map((a) => appCounts[a.id]);
    if (values.length === 0) return 0;
    return values.some((v) => v === null || v === undefined) ? null : values.reduce<number>((sum, v) => sum + (v ?? 0), 0);
  });
  const kpis: KpiItem[] = $derived([
    { label: 'Agents', value: loading ? 'n/a' : formatNumber(total) },
    { label: 'Online', value: loading ? 'n/a' : formatNumber(onlineCount), detail: loading ? undefined : `${formatNumber(agents.length - onlineCount)} offline` },
    { label: 'Applications served', value: appTotal === null ? 'n/a' : formatNumber(appTotal) },
  ]);

  const liveStatus: StatusKind = $derived(streamState === 'open' ? 'online' : streamState === 'failed' ? 'offline' : streamState === 'closed' ? 'disabled' : 'pending');
  const liveLabel = $derived(
    streamState === 'open' ? 'Live status' : streamState === 'failed' ? 'Live status unavailable' : streamState === 'reconnecting' ? 'Reconnecting…' : 'Connecting…',
  );

  // ── Table ───────────────────────────────────────────────────────────────
  const columns: DataTableColumn<FleetAgent>[] = [
    { key: 'name', label: 'Agent', rowHeader: true, class: 'waf-col-agent' },
    { key: 'host', label: 'Host', width: '10rem', value: (a) => (a.host_id ? a.hostname || 'Host' : 'Not linked') },
    { key: 'status', label: 'Connection', nowrap: true, width: '8rem' },
    { key: 'apps', label: 'Applications', align: 'right', nowrap: true, width: '7rem' },
    { key: 'health', label: 'Inspection health', width: '17rem', class: 'waf-col-health' },
    { key: 'last_seen', label: 'Last heartbeat', nowrap: true, width: '10rem' },
  ];

  function healthTitle(a: FleetAgent): string {
    return a.waf_health_updated_at ? `Reported ${formatDateTime(a.waf_health_updated_at)} · counts since agent start` : 'Counts since agent start';
  }

  // ── Register ────────────────────────────────────────────────────────────
  let newName = $state('');
  let nameTouched = $state(false);
  let registering = $state(false);
  let registerError = $state('');
  let registered = $state<{ name: string; command: string } | null>(null);
  const nameError = $derived(nameTouched ? validateAgentName(newName) : null);

  async function register(event: SubmitEvent) {
    event.preventDefault();
    nameTouched = true;
    if (!ctx.canConfigure || registering || validateAgentName(newName)) return;
    registering = true;
    registerError = '';
    const name = newName.trim();
    const res = await registerFleetAgent(projectId, name, 'waf');
    registering = false;
    if (res.error || !res.data) {
      registerError = res.error?.code === 'CONFLICT' ? `An agent named "${name}" already exists in this project.` : res.error?.error || 'Could not register the agent.';
      return;
    }
    registered = { name: res.data.agent.name, command: wafAgentInstall(res.data.agent.name, window.location.hostname) };
    newName = '';
    nameTouched = false;
    toast.success('Run the command on the agent host to connect it.', `${res.data.agent.name} registered`);
    await load();
  }

  async function copyCommand() {
    if (!registered) return;
    try {
      await navigator.clipboard.writeText(registered.command);
      toast.success('Paste it into a shell on the agent host.', 'Command copied');
    } catch {
      toast.info('Select the command and copy it manually.', 'Clipboard unavailable');
    }
  }

  // ── Delete (typed confirmation; forced retry for an online agent) ──────
  let removing = $state<FleetAgent | null>(null);
  let forcing = $state<{ agent: FleetAgent; message: string; hint: string } | null>(null);
  let deleting = $state(false);

  async function remove(force: boolean) {
    const target = force ? forcing?.agent : removing;
    if (!target || !ctx.canConfigure || deleting) return;
    deleting = true;
    const res = await deleteProjectAgent(projectId, target.id, { force });
    deleting = false;
    if (res.error) {
      if (!force && isAgentOnlineRefusal(res.error)) {
        removing = null;
        forcing = { agent: target, message: res.error.error, hint: res.error.hint ?? '' };
        return;
      }
      toast.error(agentDeleteError(res.error), 'Agent not deleted');
      return;
    }
    removing = null;
    forcing = null;
    toast.success('Its applications are now unassigned; their configuration is kept and its decision history stays until data retention removes it.', `${target.name} deleted`);
    await load();
  }
</script>

<div class="page">
  <PageHeader title="WAF agents" subtitle="Layer-7 HTTP inspection agents. Each agent serves and protects the applications assigned to it." backHref={`${base}/projects/${projectId}`}>
    {#snippet actions()}
      <StatusDot status={liveStatus} label={liveLabel} pulse={streamState === 'open'} title="Online status and heartbeats update every 5 seconds" />
    {/snippet}
  </PageHeader>

  {#if streamError}
    <InlineError message={`Live status stopped: ${streamError}`} />
  {/if}

  <KpiStrip items={kpis} label="WAF agent summary" />

  {#if ctx.canConfigure}
    <form class="register" onsubmit={register} novalidate>
      <Field label="Register a WAF agent" hint="A name for the agent; you pass it to the agent with --agent-name. The agent authenticates with the project's mTLS credentials." error={nameError ?? undefined}>
        {#snippet children(c)}
          <div class="register-row">
            <input {...c} type="text" maxlength="64" autocomplete="off" spellcheck="false" placeholder="waf-edge-1" bind:value={newName} onblur={() => (nameTouched = newName.trim() !== '' || nameTouched)} />
            <Button type="submit" variant="primary" loading={registering}>Register agent</Button>
          </div>
        {/snippet}
      </Field>
      {#if registerError}<InlineError message={registerError} />{/if}
    </form>
  {:else if ctx.project}
    <Alert tone="info" message="Read-only: a project member or owner can register and delete WAF agents." />
  {/if}

  {#if error && agents.length > 0}
    <InlineError message={error} onretry={() => void load()} />
  {/if}

  <DataTable
    rows={agents}
    {columns}
    rowKey={(a) => a.id}
    caption="WAF agents"
    {loading}
    error={agents.length === 0 ? error || null : null}
    onretry={() => void load()}
    emptyTitle="No WAF agents registered yet"
    emptyMessage={ctx.canConfigure ? 'Register an agent above, run it on the host in front of your application, then add applications to it.' : 'A project member or owner can register an agent.'}
    itemLabel="agents"
  >
    {#snippet cell(a, column)}
      {#if column.key === 'name'}
        <a class="agent-link" href={`${base}/projects/${projectId}/waf/${a.id}`}>{a.name}</a>
        <small class="agent-id">{a.version ? `${formatVersion(a.version)} · ` : ''}{a.id}</small>
      {:else if column.key === 'host'}
        {#if a.host_id}
          <a class="agent-link" href={`${base}/projects/${projectId}/hosts/${a.host_id}`}>{a.hostname || 'Open host'}</a>
        {:else}
          <span class="host-unlinked" title="This agent runs on no registered host (started without a host key).">Not linked</span>
        {/if}
      {:else if column.key === 'status'}
        <StatusDot status={a.is_online ? 'online' : 'offline'} />
      {:else if column.key === 'apps'}
        {@const n = appCounts[a.id]}
        {n === undefined ? '…' : n === null ? 'Unavailable' : formatNumber(n)}
      {:else if column.key === 'health'}
        {#if !healthReported(a)}
          <span class="muted" title="This agent version does not report inspection-health counters">Not reported</span>
        {:else}
          {@const items = wafHealthItems(a)}
          {@const flagged = items.filter((i) => i.attention !== null)}
          {@const attention = healthNeedsAttention(a)}
          <div class="health-cell">
            <span class="p99" title={latencyGapText(a)}>
              <span class="p99-label">Analyze p99</span>
              <span class="p99-value">{formatLatencyMs(a.analyze_latency_p99_us)}</span>
              {#if latencyOverBudget(a.analyze_latency_p99_us)}<Badge tone="warning" title="p99 budget is 5 ms">Over 5 ms</Badge>{/if}
            </span>
            {#if flagged.length}
              <dl class="health">
                {#each flagged as item (item.key)}<dt>{item.label}</dt><dd class:alert={item.attention === 'alert'} class:warn={item.attention === 'warning'}>{item.value}</dd>{/each}
              </dl>
            {/if}
            <details class="health-ok">
              <summary title={healthTitle(a)}>{attention ? 'All counters' : 'Healthy'}</summary>
              <dl class="health">
                <dt>p50 · p95</dt><dd>{formatLatencyMs(a.analyze_latency_p50_us)} · {formatLatencyMs(a.analyze_latency_p95_us)}</dd>
                {#each items as item (item.key)}<dt>{item.label}</dt><dd>{item.value}</dd>{/each}
              </dl>
            </details>
          </div>
        {/if}
      {:else if column.key === 'last_seen'}
        <span class="muted"><DateTime value={a.last_seen} relative fallback="Never" /></span>
      {/if}
    {/snippet}
    {#snippet actions(a)}
      <Button variant="ghost" size="sm" href={`${base}/projects/${projectId}/waf/${a.id}`} aria-label={`Open ${a.name}`}>Open</Button>
      {#if ctx.canConfigure}
        <Button variant="ghost" size="sm" aria-label={`Delete ${a.name}`} onclick={() => (removing = a)}>Delete</Button>
      {/if}
    {/snippet}
    {#snippet footer()}
      <span class="note">Health counters are cumulative since each agent started. Connection and heartbeat update live.</span>
    {/snippet}
  </DataTable>
</div>

<Modal open={registered !== null} title={`WAF agent "${registered?.name ?? ''}" registered`} size="lg" onclose={() => (registered = null)}>
  <div class="reg">
    <p>Install the agent on the host that fronts your application, with the installer from the WAF agent release. Issue a credential on <a href={`${base}/projects/${projectId}/settings/credentials`}>Credentials</a> first and copy its client certificate, key and CA file to <code>/etc/wafio/certs/waf/</code>; the WAF agent runs as the user <code>wafio</code> and must be able to read the key. The installer writes the systemd unit and the agent's environment file, and fetches the security data.</p>
    <pre class="reg-command">{registered?.command}</pre>
    <p>Set <code>WAFIO_HOST_KEY</code> in <code>/etc/wafio/waf-agent.env</code> when the agent runs on a registered host, then restart it.</p>
  </div>
  {#snippet footer()}
    <Button variant="secondary" onclick={() => void copyCommand()}>Copy command</Button>
    <Button variant="primary" onclick={() => (registered = null)}>Done</Button>
  {/snippet}
</Modal>

<ConfirmModal
  open={removing !== null}
  tone="danger"
  title={`Delete ${removing?.name ?? 'agent'}?`}
  confirmLabel="Delete agent"
  requireText={removing?.name ?? ''}
  loading={deleting}
  onconfirm={() => void remove(false)}
  onclose={() => (removing = null)}
>
  <p class="confirm-text">Removes the agent from this project; it no longer appears in the agent list. Its decision history stays available until it ages out under data retention (30 days). The applications it serves become unassigned and are no longer proxied or inspected until you assign them to another agent; their configuration and history are kept. A running agent must be stopped on its host first.</p>
</ConfirmModal>

<ConfirmModal
  open={forcing !== null}
  tone="danger"
  title={`${forcing?.agent.name ?? 'The agent'} is online`}
  confirmLabel="Delete anyway"
  loading={deleting}
  onconfirm={() => void remove(true)}
  onclose={() => (forcing = null)}
>
  <div class="confirm-text">
    <p>{forcing?.message}</p>
    {#if forcing?.hint}<p class="hint">{forcing.hint}</p>{/if}
    <p>Deleting it anyway stops protection for its applications now; a running agent may register again when it reconnects.</p>
  </div>
</ConfirmModal>

<style>
  .page { width: 100%; min-width: 0; box-sizing: border-box; padding: var(--page-top) var(--page-gutter) var(--sp-7); display: flex; flex-direction: column; gap: var(--sp-4); }
  .page :global(.page-header) { margin-bottom: 0; }
  .register { display: flex; flex-direction: column; gap: var(--sp-2); max-width: 40rem; }
  .register-row { display: flex; gap: var(--sp-2); align-items: center; }
  .register-row input { flex: 1 1 14rem; min-width: 0; }
  /* Keep the name and its version/id line readable: the table scrolls horizontally (DataTable region) instead of squeezing these columns. */
  :global(.waf-col-agent) { min-width: 14rem; }
  :global(.waf-col-health) { min-width: 13rem; }
  .agent-link { color: var(--accent); text-decoration: none; font-weight: var(--fw-medium); }
  .agent-link:hover { text-decoration: underline; }
  .host-unlinked { font-size: var(--fs-xs); color: var(--text-muted); }
  .agent-id { display: block; margin-top: var(--sp-1); font-size: var(--fs-xs); color: var(--text-muted); font-family: var(--font-mono); overflow-wrap: anywhere; font-weight: 400; }
  .health {
    display: grid;
    grid-template-columns: minmax(0, 1fr) max-content;
    column-gap: var(--sp-4);
    row-gap: var(--sp-1);
    align-items: baseline;
    margin: 0;
  }
  .health dt { color: var(--text-muted); font-size: var(--fs-xs); overflow-wrap: anywhere; }
  .health dd { margin: 0; color: var(--text-secondary); font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
  .health dd.alert { color: var(--danger); font-weight: var(--fw-semibold); }
  .health dd.warn { color: var(--warning); font-weight: var(--fw-semibold); }
  .health-cell { display: flex; flex-direction: column; gap: var(--sp-2); min-width: 0; }
  .p99 { display: flex; align-items: center; flex-wrap: wrap; gap: var(--sp-2); font-size: var(--fs-sm); }
  .p99-label { color: var(--text-muted); font-size: var(--fs-xs); }
  .p99-value { color: var(--text-secondary); font-variant-numeric: tabular-nums; }
  .health-ok summary { cursor: pointer; font-size: var(--fs-sm); color: var(--text-secondary); }
  .health-ok summary::marker { color: var(--text-muted); }
  .health-ok[open] summary { margin-bottom: var(--sp-2); }
  .muted, .note { color: var(--text-muted); font-size: var(--fs-xs); }
  .reg { display: flex; flex-direction: column; gap: var(--sp-3); }
  .reg p { margin: 0; font-size: var(--fs-sm); color: var(--text-secondary); line-height: 1.5; }
  .reg a { color: var(--accent); }
  .reg code { font-family: var(--font-mono); }
  .reg-command { margin: 0; padding: var(--sp-3); background: var(--bg-code); border: 1px solid var(--border); border-radius: var(--radius); font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--text-primary); overflow-x: auto; white-space: pre; }
  .confirm-text { margin: 0; color: var(--text-secondary); line-height: 1.5; display: flex; flex-direction: column; gap: var(--sp-2); }
  .confirm-text p { margin: 0; }
  .hint { color: var(--text-muted); font-size: var(--fs-sm); }
  @media (max-width: 640px) { .register-row { flex-wrap: wrap; } }
</style>
