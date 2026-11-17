<!--
  Hosts: the project's host fleet.

  One table of every host with what protects it (firewall, runtime security,
  open incidents, agent versions) from GET /hosts/fleet, every page followed
  so filters, KPI counts and "select all" cover the whole fleet. Filters live
  in the URL (?status, fw, rt, attention=1, label=k=v, q). Refreshed every
  30 s while the browser tab is visible, paused while a dialog or flow is
  open. Members select hosts for bulk actions: edit labels, add or remove a
  firewall rule, copy runtime policies or detection rules (no bulk rotate,
  revoke or delete). Registering a host shows its one-time host key inside
  the "Connect this host" guide. Rotating the key, revoking and deleting stay
  on the host's detail page, each a typed confirmation.
-->
<script lang="ts">
  import { page } from '$app/state';
  import { base } from '#lib/paths.js';
  import { goto } from '$app/navigation';
  import Icon from 'svelte-awesome/components/Icon.svelte';
  import plus from 'svelte-awesome/icons/plus';
  import exclamationTriangle from 'svelte-awesome/icons/exclamationTriangle';
  import PageHeader from '#lib/components/ui/PageHeader.svelte';
  import DataTable from '#lib/components/ui/DataTable.svelte';
  import KpiStrip from '#lib/components/ui/KpiStrip.svelte';
  import Modal from '#lib/components/ui/Modal.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Alert from '#lib/components/ui/Alert.svelte';
  import EmptyState from '#lib/components/ui/EmptyState.svelte';
  import Field from '#lib/components/ui/Field.svelte';
  import InlineError from '#lib/components/ui/InlineError.svelte';
  import Spinner from '#lib/components/ui/Spinner.svelte';
  import type { DataTableColumn, KpiItem } from '#lib/components/ui/types.js';
  import FleetFilters from '#lib/components/hosts/FleetFilters.svelte';
  import BulkActionBar from '#lib/components/hosts/BulkActionBar.svelte';
  import HostLabelsModal from '#lib/components/hosts/HostLabelsModal.svelte';
  import ApplyToHostsFlow from '#lib/components/hosts/ApplyToHostsFlow.svelte';
  import CopyRuntimeFlow from '#lib/components/hosts/CopyRuntimeFlow.svelte';
  import HostConnectGuide from '#lib/components/hosts/HostConnectGuide.svelte';
  import { loadFleet } from '#lib/components/hosts/fleet-loader.js';
  import { createHost, type FleetHost, type Host } from '#lib/api.js';
  import { getProjectContext } from '#lib/project-context.svelte.js';
  import { createPoller } from '#lib/polling.svelte.js';
  import { firewallStateTone, runtimeStateTone, severityTone, statusTone } from '#lib/tone.js';
  import { formatDateTime, formatRelative, toISO } from '#lib/format.js';
  import { toast } from '#lib/stores/toast.js';
  import { focusFormError } from '#lib/focus-error.js';
  import {
    FIREWALL_STATE_TEXT,
    RUNTIME_STATE_TEXT,
    applyFleetFilters,
    attentionText,
    degradedReasonText,
    fleetCounts,
    fleetFilterSearch,
    labelFacets,
    pruneSelection,
    readFleetFilters,
    type FleetFilterState,
  } from '#lib/host-fleet.js';
  import { hostNameError, parseLabels } from './host-info';

  const project = getProjectContext();
  const projectId = $derived(page.params.id ?? '');
  const canConfigure = $derived(project.canConfigure);

  // ── Fleet ──────────────────────────────────────────────────────────────
  let hosts = $state.raw<FleetHost[]>([]);
  let loaded = $state(false);
  let error = $state<string | null>(null);
  let controlPlaneVersion = $state('');
  let unlinked = $state(0);
  let selected = $state<string[]>([]);
  let loadedFor = '';

  async function loadAll(signal?: AbortSignal) {
    const id = projectId;
    const res = await loadFleet(id, () => id !== projectId || Boolean(signal?.aborted));
    if (id !== projectId || signal?.aborted) return;
    loaded = true;
    if (res.error || !res.hosts) {
      error = res.error ?? 'The host list did not load.';
      return;
    }
    hosts = res.hosts;
    controlPlaneVersion = res.controlPlaneVersion;
    unlinked = res.unlinkedHostAgents;
    error = null;
    loadedFor = id;
    selected = pruneSelection(selected, res.hosts);
  }

  // ── Dialogs and flows (pause the refresh while one is open) ───────────
  let createOpen = $state(false);
  let connect = $state<{ id: string; name: string; key: string; enrollExpiresAt?: string | null } | null>(null);
  let labelsOpen = $state(false);
  let applyMode = $state<'add' | 'remove' | null>(null);
  let copyKind = $state<'policies' | 'rules' | null>(null);
  const flowOpen = $derived(createOpen || connect !== null || labelsOpen || applyMode !== null || copyKind !== null);

  $effect(() => {
    const id = projectId;
    if (!id) return;
    if (loadedFor !== id) {
      hosts = [];
      loaded = false;
      error = null;
      selected = [];
    }
    if (!flowOpen) createPoller((signal) => loadAll(signal), 30_000);
  });

  // ── Filters (URL) ──────────────────────────────────────────────────────
  const filters = $derived(readFleetFilters(page.url.searchParams));
  const visible = $derived(applyFleetFilters(hosts, filters));
  const facets = $derived(labelFacets(hosts));
  const counts = $derived(fleetCounts(hosts));

  function setFilters(next: FleetFilterState) {
    void goto(`${page.url.pathname}${fleetFilterSearch(page.url.searchParams, next)}`, { replace: true, reset: false });
  }

  const kpis = $derived<KpiItem[]>([
    { label: 'Hosts', value: counts.hosts },
    { label: 'Online', value: counts.online, unit: `/ ${counts.hosts}`, onclick: () => setFilters({ ...filters, status: filters.status === 'online' ? '' : 'online' }), hint: 'Show online hosts' },
    { label: 'Firewall enforcing', value: counts.firewallEnforcing, onclick: () => setFilters({ ...filters, fw: filters.fw === 'enforce' ? '' : 'enforce' }), hint: 'Show hosts whose firewall enforces' },
    { label: 'Runtime on', value: counts.runtimeOn, onclick: () => setFilters({ ...filters, rt: filters.rt === 'on' ? '' : 'on' }), hint: 'Show hosts with runtime security on' },
    {
      label: 'Need attention',
      value: counts.attention,
      tone: counts.attention ? 'warning' : 'default',
      toneText: counts.attention ? `${counts.attention} to review` : undefined,
      onclick: () => setFilters({ ...filters, attention: !filters.attention }),
      hint: 'Show hosts that need attention',
    },
    { label: 'Outdated agents', value: counts.outdated, detail: controlPlaneVersion ? `control plane ${controlPlaneVersion}` : undefined, hint: 'Hosts with an agent older than the control plane' },
  ]);

  // ── Selection ──────────────────────────────────────────────────────────
  const selectedHosts = $derived(hosts.filter((h) => selected.includes(h.id)));

  // ── Table ──────────────────────────────────────────────────────────────
  const STATUS_TEXT: Record<Host['status'], string> = { online: 'Online', pending: 'Pending', offline: 'Offline', revoked: 'Revoked' };

  const columns: DataTableColumn<FleetHost>[] = [
    { key: 'name', label: 'Host', sortable: true, rowHeader: true },
    { key: 'status', label: 'Status', sortable: true, nowrap: true },
    { key: 'firewall', label: 'Firewall', sortable: true, nowrap: true, value: (h) => FIREWALL_STATE_TEXT[h.protection.firewall.state] },
    { key: 'runtime', label: 'Runtime', sortable: true, nowrap: true, value: (h) => RUNTIME_STATE_TEXT[h.protection.runtime.state] },
    { key: 'incidents', label: 'Incidents', sortable: true, firstSortDir: 'desc', nowrap: true, sortValue: (h) => h.protection.incidents.open_critical * 1000 + h.protection.incidents.open_high },
    { key: 'agents', label: 'Agents', value: (h) => h.protection.agents.host?.version ?? '' },
    { key: 'labels', label: 'Labels', value: (h) => Object.entries(h.labels ?? {}).map(([k, v]) => `${k}=${v}`).join(' ') },
    { key: 'last_seen', label: 'Last seen', sortable: true, firstSortDir: 'desc', sortValue: (h) => (h.last_seen ? Date.parse(h.last_seen) : 0), nowrap: true },
  ];

  const hostHref = (id: string) => `${base}/projects/${projectId}/hosts/${id}`;
  const triageHref = (id: string) => `${base}/projects/${projectId}/host/trace?host=${encodeURIComponent(id)}&tab=triage`;
  const wafHref = (agentId: string) => `${base}/projects/${projectId}/waf/${agentId}`;

  // ── Register a host ────────────────────────────────────────────────────
  let newName = $state('');
  let newLabels = $state('');
  let createBusy = $state(false);
  let createError = $state<string | null>(null);
  let createTried = $state(false);
  let createModal = $state<ReturnType<typeof Modal>>();

  const nameError = $derived(hostNameError(newName));
  const labelResult = $derived(parseLabels(newLabels));
  const createDirty = $derived(Boolean(newName.trim() || newLabels.trim()));

  function openCreate() {
    newName = '';
    newLabels = '';
    createError = null;
    createTried = false;
    createOpen = true;
  }

  async function submitCreate(event?: Event) {
    event?.preventDefault();
    if (!canConfigure || createBusy) return;
    createTried = true;
    const form = event?.currentTarget instanceof HTMLFormElement ? event.currentTarget : document.getElementById('create-host-form');
    if (nameError || labelResult.error) {
      void focusFormError(form);
      return;
    }
    createBusy = true;
    createError = null;
    const id = projectId;
    const res = await createHost(id, { name: newName.trim(), labels: labelResult.labels });
    createBusy = false;
    if (id !== projectId) return;
    if (res.error || !res.data) {
      createError = res.error?.error ?? 'The host was not created.';
      void focusFormError(form);
      return;
    }
    createOpen = false;
    connect = { id: res.data.host.id, name: res.data.host.name, key: res.data.host_key, enrollExpiresAt: res.data.enroll_expires_at !== undefined ? res.data.enroll_expires_at : res.data.host.enroll_expires_at };
    toast.success(`${res.data.host.name} registered. Copy its host key now.`, 'Host created');
  }

  function closeConnect() {
    connect = null;
    void loadAll();
  }
</script>

<div class="page">
  <PageHeader
    title="Hosts"
    subtitle="Every machine of this project and what protects it: firewall, runtime security, open incidents and agent versions. Select hosts to change many at once."
    backHref={`${base}/projects/${projectId}`}
  >
    {#snippet actions()}
      <Button variant="primary" disabled={!canConfigure} title={canConfigure ? undefined : 'Your role cannot register hosts'} onclick={openCreate}>
        <Icon data={plus} scale={0.85} /> Register host
      </Button>
    {/snippet}
  </PageHeader>

  {#if project.project && !canConfigure}
    <Alert tone="info" compact message="Read-only access: your role can view hosts but not register or change them." />
  {/if}

  {#if !loaded}
    <Spinner label="Loading hosts…" layout="block" />
  {:else if error && !hosts.length}
    <InlineError message={error} onretry={() => void loadAll()} />
  {:else if !hosts.length}
    <EmptyState title="No hosts yet" message="Register a host to get its host key, then install the host agent (firewall and runtime security) or the WAF agent on that machine." level={2}>
      {#snippet action()}
        <Button variant="primary" disabled={!canConfigure} onclick={openCreate}>Register your first host</Button>
      {/snippet}
    </EmptyState>
  {:else}
    <KpiStrip items={kpis} label="Host fleet" />

    {#if unlinked > 0}
      <Alert
        tone="warning"
        compact
        title={`${unlinked} host ${unlinked === 1 ? 'agent is' : 'agents are'} not linked to a host`}
        message="They run without a host key (WAFIO_HOST_KEY), so they appear on no host here and their firewall and runtime state is missing from this table. Restart each with the key of its host."
      />
    {/if}

    <section class="inventory" aria-labelledby="hosts-inventory-title">
      <h2 id="hosts-inventory-title" class="sr-only">Host fleet</h2>
      <FleetFilters {filters} {facets} shown={visible.length} total={hosts.length} onchange={setFilters} />
      {#if error}<InlineError message={`Refresh failed: ${error}`} onretry={() => void loadAll()} />{/if}

      {#if canConfigure && selected.length}
        <BulkActionBar
          count={selected.length}
          onlabels={() => (labelsOpen = true)}
          onaddrule={() => (applyMode = 'add')}
          onremoverule={() => (applyMode = 'remove')}
          oncopypolicies={() => (copyKind = 'policies')}
          oncopyrules={() => (copyKind = 'rules')}
          onclear={() => (selected = [])}
        />
      {/if}

      <DataTable
        rows={visible}
        {columns}
        rowKey={(row) => row.id}
        caption="Hosts in this project"
        itemLabel="hosts"
        pageSize={25}
        emptyTitle="No host matches the filters"
        emptyMessage="Clear the filters to see every host."
        actionsLabel="Open"
        selectedKeys={selected}
        onselectionchange={canConfigure ? (keys) => (selected = keys.map(String)) : undefined}
        selectionLabel={(row) => `Select ${row.name}`}
      >
        {#snippet cell(row, column)}
          {@const p = row.protection}
          {#if column.key === 'name'}
            <a class="host-link" href={hostHref(row.id)}>{row.name}</a>
            <span class="sub">key <code class="mono">{row.host_key_prefix}…</code>{row.host_os_version || row.host_os ? ` · ${row.host_os_version || row.host_os}` : ''}</span>
          {:else if column.key === 'status'}
            <Badge tone={statusTone(row.status)}>{STATUS_TEXT[row.status] ?? row.status}</Badge>
            {#if p.attention.length}
              <span class="attn" title={p.attention.map(attentionText).join('\n')}>
                <Icon data={exclamationTriangle} scale={0.7} />
                <span>{p.attention.length === 1 ? attentionText(p.attention[0]) : `${p.attention.length} issues`}</span>
                <span class="sr-only">: {p.attention.map(attentionText).join(', ')}</span>
              </span>
            {/if}
          {:else if column.key === 'firewall'}
            <Badge tone={firewallStateTone(p.firewall.state)}>{FIREWALL_STATE_TEXT[p.firewall.state]}</Badge>
            {#if p.firewall.degraded}
              <span class="attn" title={p.firewall.degraded_reasons.map(degradedReasonText).join('\n')}>
                <Icon data={exclamationTriangle} scale={0.7} />
                <span>Degraded</span>
                <span class="sr-only">: {p.firewall.degraded_reasons.map(degradedReasonText).join(', ')}</span>
              </span>
            {/if}
          {:else if column.key === 'runtime'}
            <Badge tone={runtimeStateTone(p.runtime.state)}>{RUNTIME_STATE_TEXT[p.runtime.state]}</Badge>
            {#if p.runtime.state !== 'no_agent'}<span class="sub">{p.runtime.enforcing_policies} enforcing · {p.runtime.enabled_policies} enabled</span>{/if}
            {#if p.runtime.missing_probes}<span class="sub">{p.runtime.missing_probes} probes missing</span>{/if}
          {:else if column.key === 'incidents'}
            {#if p.incidents.open_critical || p.incidents.open_high}
              <a class="inc" href={triageHref(row.id)} aria-label={`${p.incidents.open_critical} critical and ${p.incidents.open_high} high open incidents on ${row.name}`}>
                {#if p.incidents.open_critical}<Badge tone={severityTone('critical')}>{p.incidents.open_critical} critical</Badge>{/if}
                {#if p.incidents.open_high}<Badge tone={severityTone('high')}>{p.incidents.open_high} high</Badge>{/if}
              </a>
            {:else}<span class="muted">None open</span>{/if}
            {#if p.incidents.acknowledged}<span class="sub">{p.incidents.acknowledged} acknowledged</span>{/if}
          {:else if column.key === 'agents'}
            <span class="agents">
              {#if p.agents.host}
                <span>Host {p.agents.host.version ?? 'n/a'}{#if !p.agents.host.online}<span class="muted"> (offline)</span>{/if}</span>
                {#if p.agents.host.outdated}<Badge tone={statusTone('pending')} title={controlPlaneVersion ? `Control plane ${controlPlaneVersion}` : undefined}>Outdated</Badge>{/if}
              {:else}<span class="muted">No host agent</span>{/if}
            </span>
            {#if p.agents.waf.count}
              <span class="agents">
                <span>WAF {p.agents.waf.online}/{p.agents.waf.count} online</span>
                {#if p.agents.waf.outdated}<Badge tone={statusTone('pending')} title={p.agents.waf.oldest_version ? `Oldest ${p.agents.waf.oldest_version}` : undefined}>Outdated</Badge>{/if}
              </span>
              <span class="waf-links">
                {#each p.agents.waf.agents as agent (agent.id)}<a href={wafHref(agent.id)}>{agent.name}</a>{/each}
              </span>
            {/if}
          {:else if column.key === 'labels'}
            {#if Object.keys(row.labels ?? {}).length}
              <span class="labels">{#each Object.entries(row.labels ?? {}) as [k, v] (k)}<span class="label">{k}={v}</span>{/each}</span>
            {:else}<span class="muted">n/a</span>{/if}
          {:else if column.key === 'last_seen'}
            {#if row.last_seen}
              <time datetime={toISO(row.last_seen)} title={formatDateTime(row.last_seen, { seconds: true })}>{formatRelative(row.last_seen)}</time>
            {:else}<span class="muted">Never</span>{/if}
          {/if}
        {/snippet}
        {#snippet actions(row)}
          <a class="open-link" href={hostHref(row.id)} aria-label={`Open ${row.name}`}>Open</a>
        {/snippet}
      </DataTable>
      <p class="inventory-note">
        {canConfigure ? 'Select hosts for bulk changes. ' : ''}Rotate a host key, revoke or delete a host from its detail page.
      </p>
    </section>
  {/if}
</div>

<Modal
  bind:this={createModal}
  open={createOpen}
  title="Register a host"
  dirty={createDirty && !createBusy}
  dismissible={!createBusy}
  onclose={() => (createOpen = false)}
>
  <form id="create-host-form" class="create" onsubmit={submitCreate} novalidate>
    <p class="create-lead">You receive a one-time <strong>host key</strong> and the steps to connect the host. Store the key securely; WAFio keeps only its hash.</p>
    <Field label="Name" required hint="2–64 characters, e.g. edge-eu-1." error={createTried ? nameError : null}>
      {#snippet children(c)}
        <input {...c} class="input" type="text" bind:value={newName} maxlength="64" autocomplete="off" disabled={createBusy} data-autofocus />
      {/snippet}
    </Field>
    <Field label="Labels" optional hint="key=value pairs separated by commas, e.g. env=prod, region=eu-west-1." error={newLabels.trim() ? labelResult.error : null}>
      {#snippet children(c)}
        <input {...c} class="input" type="text" bind:value={newLabels} autocomplete="off" disabled={createBusy} />
      {/snippet}
    </Field>
    {#if createError}<Alert tone="error" compact title="Host not created" message={createError} />{/if}
  </form>
  {#snippet footer()}
    <Button variant="ghost" disabled={createBusy} onclick={() => createModal?.requestClose()}>Cancel</Button>
    <Button variant="primary" type="submit" form="create-host-form" loading={createBusy} disabled={!canConfigure}>Create host</Button>
  {/snippet}
</Modal>

{#if connect}
  <Modal
    open={true}
    title={`Connect ${connect.name}`}
    size="xl"
    dirty={true}
    discardTitle="Close the connect guide?"
    discardMessage="The host key (and a credential's private key, if you created one) is not shown again. Close only after you stored them."
    discardLabel="Close"
    keepLabel="Keep open"
    onclose={closeConnect}
  >
    <HostConnectGuide {projectId} hostId={connect.id} hostName={connect.name} hostKey={connect.key} enrollExpiresAt={connect.enrollExpiresAt} {canConfigure} />
  </Modal>
{/if}

<HostLabelsModal open={labelsOpen} {projectId} hosts={selectedHosts} onclose={() => (labelsOpen = false)} onsaved={() => void loadAll()} />

<ApplyToHostsFlow
  open={applyMode !== null}
  {projectId}
  mode={applyMode ?? 'add'}
  {hosts}
  initialHostIds={selected}
  onclose={() => { applyMode = null; void loadAll(); }}
/>

<CopyRuntimeFlow
  open={copyKind !== null}
  {projectId}
  kind={copyKind ?? 'policies'}
  {hosts}
  initialHostIds={selected}
  onclose={() => { copyKind = null; void loadAll(); }}
/>

<style>
  .page { display: grid; gap: var(--sp-4); width: 100%; min-width: 0; box-sizing: border-box; padding: var(--page-top) var(--page-gutter) var(--sp-7); align-content: start; }
  .inventory { display: grid; gap: var(--sp-3); min-width: 0; }
  .inventory-note { margin: var(--sp-1) 0 0; font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.5; }
  .input {
    box-sizing: border-box;
    width: 100%;
    min-height: 36px;
    padding: var(--sp-2) var(--sp-3);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    background: var(--surface-input);
    color: var(--text-primary);
    font: inherit;
    font-size: var(--fs-sm);
  }
  .input:focus-visible { outline: var(--ring-width) solid var(--ring-color); outline-offset: 1px; }
  .host-link { color: var(--text-primary); font-weight: var(--fw-semibold); overflow-wrap: anywhere; }
  .sub { display: block; margin-top: calc(var(--sp-1) / 2); font-size: var(--fs-xs); color: var(--text-muted); font-weight: normal; }
  .mono { font-family: var(--font-mono); font-size: var(--fs-xs); }
  .muted { color: var(--text-muted); font-size: var(--fs-xs); }
  .attn { display: flex; align-items: center; gap: var(--sp-1); margin-top: var(--sp-1); font-size: var(--fs-xs); color: var(--text-secondary); }
  .attn :global(svg) { color: var(--warning); }
  .inc { display: inline-flex; flex-wrap: wrap; gap: var(--sp-1); text-decoration: none; }
  .inc:focus-visible { outline: var(--ring-width) solid var(--ring-color); outline-offset: 2px; border-radius: var(--radius); }
  .agents { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-1) var(--sp-2); font-size: var(--fs-sm); white-space: nowrap; }
  .agents + .agents { margin-top: var(--sp-1); }
  .waf-links { display: flex; flex-wrap: wrap; gap: var(--sp-1) var(--sp-2); font-size: var(--fs-xs); }
  .waf-links a { color: var(--accent); }
  .labels { display: flex; flex-wrap: wrap; gap: var(--sp-1); }
  .label { padding: 0 var(--sp-2); border: 1px solid var(--border); border-radius: var(--radius); font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--text-secondary); }
  .open-link { color: var(--accent); font-size: var(--fs-sm); }
  .create { display: grid; gap: var(--sp-4); }
  .create-lead { margin: 0; font-size: var(--fs-sm); color: var(--text-secondary); line-height: 1.5; }
</style>
