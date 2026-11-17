<!--
  FirewallStatusBanner: what the host's kernel firewall is doing right now:
  agent reachability, whether XDP/TC are attached, and enforce vs
  monitor-only. Status uses the --status-* family and the mode
  uses --mode-*, never the verdict colours; every state is in words.
  With `onenforce` the monitor-only row offers the guarded switch; with
  `enforceHref` instead (host detail summary) it links to the Firewall page,
  which owns the lockout check.
-->
<script lang="ts">
  import Badge from '#lib/components/ui/Badge.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import DateTime from '#lib/components/ui/DateTime.svelte';
  import StatusDot from '#lib/components/ui/StatusDot.svelte';
  import Alert from '#lib/components/ui/Alert.svelte';
  import type { StatusKind } from '#lib/components/ui/types.js';
  import type { EBPFMetrics, EBPFStatus } from '#lib/api.js';
  import { formatDuration, formatNumber } from '#lib/format.js';
  import { bundleStateNotes } from './guard-codes';

  let {
    status,
    metrics = null,
    setupHref,
    canConfigure = false,
    busy = false,
    onenforce = undefined,
    enforceHref = undefined,
    setupLabel = 'Check the agent on the host page',
  }: {
    status: EBPFStatus;
    metrics?: EBPFMetrics | null;
    /** Agent setup / host page. */
    setupHref: string;
    canConfigure?: boolean;
    busy?: boolean;
    /** Starts the guarded monitor-only → enforce switch. */
    onenforce?: () => void;
    /** Link to the page that runs the switch (used when `onenforce` is absent). */
    enforceHref?: string;
    /** Text of the agent setup link. */
    setupLabel?: string;
  } = $props();

  const online = $derived(status.agent_online === true);
  const neverReported = $derived(status.never_reported === true);
  const view = $derived.by((): { dot: StatusKind; label: string; detail: string } => {
    if (status.running && online) return { dot: 'online', label: 'Firewall active', detail: 'XDP and TC programs are attached and reporting.' };
    if (status.running) return { dot: 'offline', label: 'Agent offline, last known state: active', detail: 'Rules stay loaded in the kernel, but this page cannot see current traffic.' };
    if (online && neverReported) return { dot: 'degraded', label: 'Agent online, kernel firewall not enabled', detail: 'The agent is connected but does not push firewall status. Restart it with --ebpf to attach XDP/TC.' };
    if (neverReported) return { dot: 'offline', label: status.agent_last_seen ? 'Agent offline' : 'Agent has never connected', detail: 'Install or restart the host agent to manage its firewall.' };
    return { dot: 'disabled', label: 'Firewall stopped', detail: 'The agent reports that XDP/TC programs are not attached.' };
  });
  const monitorOnly = $derived(status.config?.global?.monitor_only);
  // Firewall policy delivery: refused by the agent's guard, saved policy, DNS relaxed.
  const policyNotes = $derived(bundleStateNotes(status.bundle_status?.ebpf_state));
  const coverageFailures = $derived((metrics?.state_table_full ?? 0) > 0 || (metrics?.packet_parse_failures ?? 0) > 0);
</script>

<section class="banner" aria-label="Firewall status">
  <div class="banner-main">
    <StatusDot status={view.dot} label={view.label} pulse={view.dot === 'online'} />
    <p class="banner-detail">{view.detail}</p>
    <dl class="banner-meta">
      {#if status.agent_name}<div><dt>Agent</dt><dd><code>{status.agent_name}</code></dd></div>{/if}
      {#if status.interface}<div><dt>Interface</dt><dd><code>{status.interface}</code></dd></div>{/if}
      {#if status.xdp_mode}<div><dt>XDP mode</dt><dd>{status.xdp_mode}</dd></div>{/if}
      {#if status.running && status.uptime_seconds !== undefined}<div><dt>Uptime</dt><dd>{formatDuration(status.uptime_seconds, 's')}</dd></div>{/if}
      {#if status.kernel_version}<div><dt>Kernel</dt><dd>{status.kernel_version}</dd></div>{/if}
      {#if !online}
        <div><dt>Last seen</dt><dd><DateTime value={status.agent_last_seen} relative fallback="never" /></dd></div>
      {/if}
    </dl>
    {#if !online || (online && neverReported)}
      <a class="banner-link" href={setupHref}>{setupLabel}</a>
    {/if}
  </div>

  {#if status.running && monitorOnly !== undefined}
    <div class="banner-mode" class:is-monitor={monitorOnly}>
      {#if monitorOnly}
        <Badge tone="mode-monitor">Monitor-only</Badge>
        <p>Rules are evaluated and logged; <strong>no packet is dropped</strong>.</p>
        {#if onenforce}
          <Button variant="warning" size="sm" disabled={!canConfigure || busy} loading={busy} onclick={onenforce} title={canConfigure ? undefined : 'Your role cannot change the firewall mode'}>Switch to enforce mode…</Button>
        {:else if enforceHref}
          <a class="banner-link" href={enforceHref}>Review the lockout check in Firewall to switch to Enforce</a>
        {/if}
      {:else}
        <Badge tone="mode-block">Enforcing</Badge>
        <p>Matching packets are dropped. Switch to monitor-only in {enforceHref ? 'the Firewall settings' : 'Settings'}.</p>
      {/if}
    </div>
  {/if}

  {#each policyNotes as note (note.title)}
    <Alert tone={note.tone} compact title={note.title} message={note.message} />
  {/each}

  {#if coverageFailures}
    <Alert tone="warning" compact title="Coverage gap" message={`Since the agent started: ${formatNumber(metrics?.state_table_full ?? 0)} state-table capacity failures and ${formatNumber(metrics?.packet_parse_failures ?? 0)} packet parse failures. Affected packets were not fully inspected.`} />
  {/if}
</section>

<style>
  .banner { display: grid; gap: var(--sp-3); padding: var(--sp-4); border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-card); }
  .banner-main { display: grid; gap: var(--sp-2); min-width: 0; }
  .banner-main :global(.ui-status) { font-size: var(--fs-base); font-weight: var(--fw-semibold); }
  .banner-detail { margin: 0; font-size: var(--fs-sm); color: var(--text-secondary); }
  .banner-meta { display: flex; flex-wrap: wrap; gap: var(--sp-2) var(--sp-5); margin: 0; }
  .banner-meta div { display: flex; gap: var(--sp-2); font-size: var(--fs-xs); }
  .banner-meta dt { color: var(--text-muted); }
  .banner-meta dd { margin: 0; color: var(--text-primary); }
  .banner-meta code { font-family: var(--font-mono); }
  .banner-link { font-size: var(--fs-xs); color: var(--accent); }
  .banner-mode { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2) var(--sp-3); padding-top: var(--sp-3); border-top: 1px solid var(--border); }
  .banner-mode p { margin: 0; flex: 1 1 240px; font-size: var(--fs-sm); color: var(--text-secondary); }
  .banner-mode strong { color: var(--text-primary); font-weight: var(--fw-medium); }
</style>
