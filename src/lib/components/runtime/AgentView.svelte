<!--
  AgentView: the host agent behind Runtime security: connection and tracing
  status, capture health (probes, loss, buffers, delivery) and the trace
  configuration. Saving a configuration that captures less asks first;
  disabling tracing while kill policies are enabled needs the typed
  confirmation (it removes their enforcement).
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { killCandidatesLost, priorityRingSummary, protectedSummary, traceLossBreakdown, traceLossNotice } from '#lib/trace-status.js';
  import { telemetryRows, telemetrySummary } from '#lib/telemetry-status.js';
  import { getTraceConfig, listPolicies, updateTraceConfig, type TraceConfig, type TraceEventTypeInfo, type TraceStats, type TraceStatus } from '#lib/api.js';
  import { createDirtyTracker } from '#lib/dirty.svelte.js';
  import { formatBytes, formatDuration, formatNumber, formatPercent } from '#lib/format.js';
  import { createLifecycle, type HostScope } from '#lib/host-scope.svelte.js';
  import { toast } from '#lib/stores/toast.js';
  import HostConfigEvidence from '#lib/components/HostConfigEvidence.svelte';
  import MapCapacity from '#lib/components/firewall/MapCapacity.svelte';
  import Alert from '#lib/components/ui/Alert.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import ConfirmModal from '#lib/components/ui/ConfirmModal.svelte';
  import DateTime from '#lib/components/ui/DateTime.svelte';
  import Select from '#lib/components/ui/Select.svelte';
  import Spinner from '#lib/components/ui/Spinner.svelte';
  import StatusDot from '#lib/components/ui/StatusDot.svelte';
  import Switch from '#lib/components/ui/Switch.svelte';
  import { MIN_SEVERITY_CHOICES, hasEnforcingPolicies, traceConfigLosses, traceConfigSaveTier } from './policy';

  let {
    projectId,
    scope,
    hostLabel,
    status,
    stats,
    eventTypes,
    canConfigure = false,
    onsaved,
  }: {
    projectId: string;
    scope: HostScope;
    hostLabel: string;
    status: TraceStatus | null;
    stats: Partial<TraceStats> | null;
    eventTypes: TraceEventTypeInfo[];
    canConfigure?: boolean;
    /** The configuration was saved (the page refreshes the status). */
    onsaved: () => void;
  } = $props();

  const life = createLifecycle();
  // The view is keyed per host: it lives within one scope epoch.
  const hostEpoch = untrack(() => scope.epoch);
  const noPermission = 'Requires the member or owner role';

  const emptyConfig = (): TraceConfig => ({ enabled: true, event_types: [], min_severity: 'info', filter_self: true, filtered_pids: [] });

  let config = $state<TraceConfig>(emptyConfig());
  let loaded = $state(false);
  let loadError = $state<string | null>(null);
  let saving = $state(false);
  let saveError = $state<string | null>(null);
  let enforcing = $state(false);
  let confirm = $state<'typed' | 'simple' | null>(null);

  const dirty = createDirtyTracker(() => config);
  dirty.guardNavigation();

  function stale(): boolean {
    return life.destroyed || scope.isStale(hostEpoch);
  }

  async function load() {
    loadError = null;
    const [cfg, policies] = await Promise.all([getTraceConfig(projectId, scope.agentId, scope.hostId), listPolicies(projectId, scope.agentId, scope.hostId)]);
    if (stale()) return;
    if (cfg.error || !cfg.data) {
      loadError = cfg.error?.error ?? 'The trace configuration could not be loaded.';
      return;
    }
    config = { ...emptyConfig(), ...cfg.data, event_types: [...(cfg.data.event_types ?? [])] };
    dirty.reset();
    loaded = true;
    enforcing = hasEnforcingPolicies(policies.data ?? []);
  }

  $effect(() => {
    untrack(() => void load());
  });

  const allTypes = $derived(eventTypes.map((t) => t.name));
  const baseline = $derived(dirty.baseline);
  const tier = $derived(loaded ? traceConfigSaveTier(baseline, config, allTypes, enforcing) : 'none');
  const losses = $derived(loaded ? traceConfigLosses(baseline, config, allTypes) : []);
  const allSelected = $derived(!config.event_types?.length);

  interface TypeGroup {
    category: string;
    types: TraceEventTypeInfo[];
  }
  const typeGroups = $derived.by<TypeGroup[]>(() => {
    const groups = new Map<string, TraceEventTypeInfo[]>();
    for (const type of eventTypes) {
      const category = (type.category || 'other').split(',')[0].trim() || 'other';
      groups.set(category, [...(groups.get(category) ?? []), type]);
    }
    return [...groups.entries()].map(([category, types]) => ({ category, types }));
  });

  function captured(name: string): boolean {
    return allSelected || config.event_types.includes(name);
  }

  function toggleType(name: string, on: boolean) {
    const current = allSelected ? [...allTypes] : [...config.event_types];
    const next = on ? [...new Set([...current, name])] : current.filter((t) => t !== name);
    // Every type selected is stored as "all" (an empty list), as before.
    config.event_types = next.length === allTypes.length && allTypes.every((t) => next.includes(t)) ? [] : next;
  }

  function requestSave() {
    if (!canConfigure || saving || !dirty.isDirty) return;
    saveError = null;
    if (tier === 'none') void save();
    else confirm = tier;
  }

  async function save() {
    if (!canConfigure) return;
    saving = true;
    const res = await updateTraceConfig(projectId, $state.snapshot(config), scope.agentId, scope.hostId);
    if (stale()) return;
    saving = false;
    confirm = null;
    if (res.error || !res.data) {
      saveError = res.error?.error ?? 'The configuration could not be saved.';
      return;
    }
    config = { ...emptyConfig(), ...res.data, event_types: [...(res.data.event_types ?? [])] };
    dirty.reset();
    toast.success('The agent applies it with the next configuration bundle.', 'Trace configuration saved');
    onsaved();
  }

  function discard() {
    config = $state.snapshot(dirty.baseline) as TraceConfig;
    saveError = null;
  }

  const agentOnline = $derived(status?.agent_online === true);
  /** GET /trace/status answers {running:false, agent_online, never_reported:true} before the first report. */
  const neverReported = $derived(Boolean((status as (TraceStatus & { never_reported?: boolean }) | null)?.never_reported));
  const lossNotice = $derived(traceLossNotice(status));
  const lossBreakdown = $derived(traceLossBreakdown(status));
  const reportsRecentLoss = $derived(typeof status?.loss_window_sec === 'number');
  const telemetryFacts = $derived(telemetryRows(status));
  const telemetryBrief = $derived(telemetrySummary(status));
  const missingProbes = $derived(Object.entries(status?.missing_probes ?? {}));
  const bufferRatio = $derived(stats?.buffer_total ? (stats.buffer_used ?? 0) / stats.buffer_total : null);
  const typedPhrase = $derived(hostLabel.trim() || 'disable tracing');
</script>

<div class="agent">
  <section class="panel" aria-labelledby="agent-status-title">
    <h2 id="agent-status-title" class="section-title">Agent status</h2>
    {#if !status}
      <p class="muted">No status has been reported by this host's agent yet.</p>
    {:else if neverReported}
      <dl class="facts">
        <div><dt>Connection</dt><dd><StatusDot status={agentOnline ? 'online' : 'offline'} label={agentOnline ? 'Online' : 'Offline'} /></dd></div>
        <div><dt>Last seen</dt><dd><DateTime value={status.agent_last_seen} relative fallback="Unknown" /></dd></div>
        <div><dt>Agent ID</dt><dd><code>{scope.agentId ?? 'n/a'}</code></dd></div>
      </dl>
      <Alert tone="info" compact message="The agent has not reported runtime tracing yet. It reports once tracing starts (host agent with --trace, and Tracing enabled below)." />
    {:else}
      <dl class="facts">
        <div><dt>Connection</dt><dd><StatusDot status={agentOnline ? 'online' : 'offline'} label={agentOnline ? 'Online' : 'Offline'} /></dd></div>
        <div><dt>Last seen</dt><dd><DateTime value={status.agent_last_seen} relative fallback="Unknown" /></dd></div>
        <div><dt>Runtime tracing</dt><dd>{status.running ? (agentOnline ? 'Running' : 'Last reported running') : 'Stopped'}</dd></div>
        <div><dt>Policy engine</dt><dd>{status.enforcement ? `Enforcing · ${formatNumber(status.policies_total)} policies loaded` : 'Detection only'}</dd></div>
        <div><dt>Uptime</dt><dd>{formatDuration(status.uptime_ms, 'ms')}</dd></div>
        <div><dt>Userspace process kill</dt><dd>{status.userspace_kill_supported === false ? 'Unavailable (no stable process identity)' : status.userspace_kill_supported ? 'Supported' : 'Unknown'}</dd></div>
        <div><dt>Protected processes</dt><dd>{protectedSummary(status)}</dd></div>
        <div><dt>Agent ID</dt><dd><code>{scope.agentId ?? 'n/a'}</code></dd></div>
      </dl>
      {#if !status.running}
        <Alert tone="warning" compact message="Tracing is not running on this host. Enable it below, or start the agent with runtime tracing (--trace)." />
      {/if}
    {/if}
  </section>

  <section class="panel" aria-labelledby="capture-title">
    <h2 id="capture-title" class="section-title">Capture health</h2>
    {#if status && !neverReported}
      {#if lossNotice}
        <Alert tone={lossNotice.tone} title={lossNotice.title} message={lossNotice.detail} />
      {/if}
      {#if (status.kernel_events_shed ?? 0) > 0}
        <Alert tone="info" title="Low-severity events shed" message={`${formatNumber(status.kernel_events_shed ?? 0)} events below MEDIUM were not exported since the agent started because the kernel ring was nearly full; MEDIUM and higher events and kill candidates were kept.`} />
      {/if}
      {#if killCandidatesLost(status) > 0}
        <Alert tone="warning" title="Kill-candidate events lost" message={`${formatNumber(killCandidatesLost(status))} events that a userspace Kill policy evaluates were lost with both ring buffers full since tracing started, so that policy may not have fired. The host also records a trace_events_lost event.`} />
      {/if}
      {#if missingProbes.length}
        <Alert tone="warning" title={`Partial capture: ${missingProbes.length} probe${missingProbes.length === 1 ? '' : 's'} unavailable`}>
          <ul class="plain">{#each missingProbes as [probe, reason] (probe)}<li><code>{probe}</code>: {reason}</li>{/each}</ul>
        </Alert>
      {/if}
      <dl class="facts">
        <div><dt>Probes loaded</dt><dd>{formatNumber(status.probes)} <span class="muted">of {status.expected_probes ?? 'unknown'}</span></dd></div>
        <div><dt>Events captured</dt><dd>{formatNumber(status.events_total)}</dd></div>
        <div><dt>Events dropped</dt><dd>{formatNumber(status.events_dropped)}</dd></div>
        <div><dt>Telemetry loss since start</dt><dd>{lossBreakdown ?? 'Unknown'}</dd></div>
        {#if reportsRecentLoss}
          <div><dt>Last loss</dt><dd>{#if status.last_loss_at}<DateTime value={status.last_loss_at} relative />{:else}None since the agent started{/if}</dd></div>
        {/if}
        <div><dt>Queue depth</dt><dd>{status.queue_depth ?? 'Unknown'}</dd></div>
        <div><dt>Enforcement log loss</dt><dd>{status.enforcement_dropped ?? 'Unknown'}</dd></div>
        <div><dt>Ring buffer</dt><dd>{formatBytes((status.ringbuf_size_mb ?? 0) * 1024 * 1024)}</dd></div>
        <div><dt>Buffer used</dt><dd>{bufferRatio === null ? 'Unknown' : formatPercent(bufferRatio)}</dd></div>
        <div><dt>Kill-candidate ring</dt><dd>{priorityRingSummary(status)}</dd></div>
      </dl>
      <MapCapacity sizing={status.map_sizing} />
      {#if status.probe_names?.length}
        <details class="more">
          <summary>Loaded probes ({formatNumber(status.probe_names.length)})</summary>
          <ul class="probes">{#each status.probe_names as probe (probe)}<li><code>{probe}</code></li>{/each}</ul>
        </details>
      {/if}
      <details class="more">
        <summary>Telemetry {#if telemetryBrief}<span class="muted">· {telemetryBrief}</span>{/if}</summary>
        <div class="transport">
          <dl class="facts telemetry">
            {#each telemetryFacts as row (row.label)}<div><dt>{row.label}</dt><dd>{row.value}</dd></div>{/each}
          </dl>
          {#if status.telemetry_delivery}
            <p>
              Agent memory queue: {formatNumber(status.telemetry_delivery.pending_batches)} batches ({formatBytes(status.telemetry_delivery.pending_bytes)}) pending;
              {formatNumber(status.telemetry_delivery.process_accepted_batches)} batches accepted by the control plane process;
              {formatNumber(status.telemetry_delivery.dropped_batches)} batches ({formatNumber(status.telemetry_delivery.dropped_events)} events) discarded unconfirmed.
              Send failures: {status.telemetry_send_failures ?? 'unknown'}.
            </p>
          {:else}
            <p>The agent did not report its telemetry queue.</p>
          {/if}
          {#if status.ingestion}
            <p>Control plane: {formatNumber(status.ingestion.rejected_events)} events rejected by the ingest queue; {formatNumber(status.ingestion.db_write_failures)} database write failures.</p>
          {/if}
          <p class="muted">Acceptance by the control plane process does not confirm durable storage; a restart or queue expiry can lose data.</p>
        </div>
      </details>
      <HostConfigEvidence bundles={status.bundle_status} headingLevel={3} />
    {:else}
      <p class="muted">No capture statistics reported yet.</p>
    {/if}
  </section>

  <section class="panel" aria-labelledby="config-title">
    <div class="config-head">
      <div>
        <h2 id="config-title" class="section-title">Trace configuration</h2>
        <p class="muted">Desired configuration for {hostLabel || 'this host'}. Saving does not prove the agent applied it{status && !neverReported ? '; Capture health above shows what the agent reported' : ''}.</p>
      </div>
      {#if dirty.isDirty}<span class="unsaved" role="status">Unsaved changes</span>{/if}
    </div>
    {#if loadError}
      <Alert tone="error" message={loadError}>
        {#snippet actions()}<Button variant="secondary" size="sm" onclick={load}>Retry</Button>{/snippet}
      </Alert>
    {:else if !loaded}
      <Spinner label="Loading configuration" layout="block" />
    {:else}
      {#if !canConfigure}<Alert tone="info" compact message="Read-only access: your role can view the configuration but not change it." />{/if}
      <form
        class="config"
        onsubmit={(e) => {
          e.preventDefault();
          requestSave();
        }}
      >
        <fieldset class="plain-fieldset" disabled={!canConfigure || saving}>
          <legend class="sr-only">General</legend>
          <Switch bind:checked={config.enabled} label="Tracing enabled" />
          <Switch bind:checked={config.filter_self} label="Ignore the agent's own activity" />
          <div class="field">
            <label class="label" for="trace-min-severity">Minimum severity to capture</label>
            <Select id="trace-min-severity" class="min-severity" options={MIN_SEVERITY_CHOICES} bind:value={config.min_severity} />
          </div>
        </fieldset>

        <fieldset class="types-fieldset" disabled={!canConfigure || saving || !config.enabled}>
          <legend class="label">Event types <span class="muted">({allSelected ? 'all captured' : `${formatNumber(config.event_types.length)} of ${formatNumber(allTypes.length)} captured`})</span></legend>
          <p class="muted">Turning off noisy, low-value events reduces load; anything not captured cannot raise incidents or trigger policies.</p>
          <div class="types">
            {#each typeGroups as group (group.category)}
              <div class="type-group">
                <h3>{group.category}</h3>
                {#each group.types as type (type.name)}
                  <label class="type" title={type.description}>
                    <input type="checkbox" checked={captured(type.name)} onchange={(e) => toggleType(type.name, e.currentTarget.checked)} />
                    <code>{type.name}</code>
                    <span class="muted clip">{type.description}</span>
                  </label>
                {/each}
              </div>
            {:else}
              <p class="muted">The agent has not reported its event types.</p>
            {/each}
          </div>
        </fieldset>

        {#if saveError}<Alert tone="error" message={saveError} />{/if}
        <div class="form-actions">
          <Button variant="ghost" disabled={!dirty.isDirty || saving} onclick={discard}>Discard changes</Button>
          <Button variant={tier === 'typed' ? 'danger' : 'primary'} type="submit" loading={saving} disabled={!canConfigure || saving || !dirty.isDirty} title={canConfigure ? undefined : noPermission}>
            Save configuration{tier !== 'none' ? '…' : ''}
          </Button>
        </div>
      </form>
    {/if}
  </section>
</div>

<ConfirmModal
  open={confirm !== null}
  title={!config.enabled ? `Disable runtime tracing on ${hostLabel || 'this host'}?` : 'Capture less on this host?'}
  confirmLabel={!config.enabled ? 'Disable tracing' : 'Save configuration'}
  tone={confirm === 'typed' ? 'danger' : 'warning'}
  requireText={confirm === 'typed' ? typedPhrase : ''}
  requireTextLabel={confirm === 'typed' ? `Type ${typedPhrase} to confirm` : undefined}
  loading={saving}
  onconfirm={save}
  onclose={() => (confirm = null)}
>
  <div class="confirm-body">
    <p>This configuration stops capturing {losses.join('; ') || 'some activity'}.</p>
    {#if !config.enabled && enforcing}<p>Kill policies are enabled on this host; they stop enforcing while tracing is off.</p>{/if}
    <p>Activity that is not captured cannot raise incidents, trigger policies or appear in Explore.</p>
  </div>
</ConfirmModal>

<style>
  .agent { display: grid; gap: var(--sp-4); min-width: 0; }
  .panel { display: grid; gap: var(--sp-3); min-width: 0; padding: var(--sp-4); border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-card); }
  .section-title { margin: 0; font-size: var(--fs-md); font-weight: var(--fw-semibold); }
  .facts { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 14rem), 1fr)); gap: var(--sp-3) var(--sp-5); margin: 0; }
  .facts dt { font-size: var(--fs-xs); color: var(--text-muted); }
  .facts dd { margin: var(--sp-1) 0 0; font-size: var(--fs-sm); color: var(--text-primary); font-variant-numeric: tabular-nums; }
  .muted { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
  .plain { margin: 0; padding-left: var(--sp-5); }
  .more summary { cursor: pointer; font-size: var(--fs-sm); color: var(--text-secondary); }
  .probes { list-style: none; margin: var(--sp-2) 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: var(--sp-1) var(--sp-2); }
  .transport { display: grid; gap: var(--sp-2); margin-top: var(--sp-2); font-size: var(--fs-sm); color: var(--text-secondary); }
  .transport p { margin: 0; }
  .transport .telemetry { margin-bottom: var(--sp-2); }
  .config-head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: var(--sp-3); }
  .unsaved { font-size: var(--fs-xs); color: var(--warning); font-weight: var(--fw-semibold); }
  .config { display: grid; gap: var(--sp-4); }
  .plain-fieldset { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--sp-4); margin: 0; padding: 0; border: 0; }
  .types-fieldset { display: grid; gap: var(--sp-2); margin: 0; padding: var(--sp-3); border: 1px solid var(--border); border-radius: var(--radius-lg); }
  .field { display: grid; gap: var(--sp-1); }
  .label { font-size: var(--fs-sm); font-weight: var(--fw-medium); color: var(--text-secondary); }
  .field :global(.min-severity) { min-width: 11rem; }
  .types { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr)); gap: var(--sp-3); }
  .type-group h3 { margin: 0 0 var(--sp-1); font-size: var(--fs-sm); color: var(--text-muted); }
  .type { display: grid; grid-template-columns: auto auto minmax(0, 1fr); gap: var(--sp-2); align-items: baseline; padding: calc(var(--sp-1) / 2) 0; font-size: var(--fs-sm); cursor: pointer; }
  .clip { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  code { font-size: var(--fs-xs); }
  .form-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--sp-2); }
  .confirm-body { display: grid; gap: var(--sp-2); font-size: var(--fs-sm); }
  .confirm-body p { margin: 0; }
</style>
