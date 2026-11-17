<!--
  HostConnectGuide: "Connect this host".

  - Host key (shown once, when given).
  - Install with one command (HostEnrollInstall): host-key enrollment of the
    host agent, optionally the WAF agent; needs the agent CA (`ca_sha256`).
  - Waits for the host agent (polls the fleet row every 5 s) and shows the
    firewall and runtime state once it is online.
  - Manual install (fallback) disclosure (HostManualInstall): a project-wide
    credential, the interactive installer's answers, the gRPC server name,
    env file and systemd unit. Open by default when enrollment is unavailable.
-->
<script lang="ts">
  import Alert from '#lib/components/ui/Alert.svelte';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Spinner from '#lib/components/ui/Spinner.svelte';
  import StatusDot from '#lib/components/ui/StatusDot.svelte';
  import { getAgentConnectInfo, listHostFleet, type AgentConnectInfo, type FleetHost } from '#lib/api.js';
  import { FIREWALL_STATE_TEXT, RUNTIME_STATE_TEXT } from '#lib/host-fleet.js';
  import { createPoller } from '#lib/polling.svelte.js';
  import { modeTone } from '#lib/tone.js';
  import HostEnrollInstall from './HostEnrollInstall.svelte';
  import HostManualInstall from './HostManualInstall.svelte';
  import { copyWithToast as copy } from './copy';

  let {
    projectId,
    hostId,
    hostName,
    hostKey = null,
    enrollExpiresAt = undefined,
    canConfigure = false,
    onconnected = undefined,
    oncredential = undefined,
  }: {
    projectId: string;
    hostId: string;
    hostName: string;
    /** The one-time host key (register or rotate flow); absent on the host page. */
    hostKey?: string | null;
    /** End of the host key's enrollment window; null = closed, undefined = not known. */
    enrollExpiresAt?: string | null;
    canConfigure?: boolean;
    /** The host agent came online. */
    onconnected?: (row: FleetHost) => void;
    /** A credential with a private key is on screen (the parent guards closing). */
    oncredential?: (shown: boolean) => void;
  } = $props();

  const uid = $props.id();

  let info = $state<AgentConnectInfo | null>(null);
  let infoError = $state<string | null>(null);
  let row = $state<FleetHost | null>(null);
  let notified = false;

  async function loadInfo() {
    infoError = null;
    const res = await getAgentConnectInfo(projectId);
    if (res.error || !res.data) {
      infoError = res.error?.error ?? 'Connection details did not load.';
      return;
    }
    info = res.data;
  }

  $effect(() => {
    void projectId;
    void loadInfo();
  });

  const online = $derived(row?.protection.agents.host?.online === true);

  async function check(signal: AbortSignal) {
    const res = await listHostFleet(projectId, { limit: 1 }, hostId);
    if (signal.aborted || res.error) return;
    const next = res.data?.hosts?.find((h) => h.id === hostId) ?? null;
    row = next;
    if (next?.protection.agents.host?.online && !notified) {
      notified = true;
      onconnected?.(next);
    }
  }

  $effect(() => {
    if (!online && hostId) createPoller(check, 5_000);
  });

  const enrollInfo = $derived(info?.ca_sha256 ? (info as AgentConnectInfo & { ca_sha256: string }) : null);
  /** Manual opens by itself when one-command enrollment cannot work. */
  const manualFirst = $derived(Boolean(infoError) || (info !== null && !info.ca_sha256));
</script>

<div class="hcg">
  {#if hostKey}
    <section class="hcg-step" aria-labelledby={`${uid}-key-title`}>
      <h3 id={`${uid}-key-title`}>Host key</h3>
      <Alert tone="warning" compact title="Copy the host key now" message="It is stored only as a hash and cannot be shown again; rotate the key on the host page if it is lost." />
      <div class="hcg-row">
        <label class="hcg-label" for={`${uid}-key`}>Host key</label>
        <input id={`${uid}-key`} class="hcg-input mono" readonly value={hostKey} onfocus={(e) => e.currentTarget.select()} />
        <Button variant="outline" size="sm" onclick={() => copy(hostKey ?? '', 'Host key')}>Copy</Button>
      </div>
    </section>
  {/if}

  <section class="hcg-step" aria-labelledby={`${uid}-s1`}>
    <h3 id={`${uid}-s1`}>1. Install with one command</h3>
    {#if infoError}
      <Alert tone="warning" compact title="Connection details did not load" message={`${infoError} The one-command install needs them; retry, or use the manual install below.`}>
        {#snippet actions()}<Button variant="secondary" size="sm" onclick={() => void loadInfo()}>Retry</Button>{/snippet}
      </Alert>
    {:else if !info}
      <Spinner size="sm" label="Loading connection details" />
    {:else if !enrollInfo}
      <Alert
        tone="info"
        compact
        title="One-command install is not available"
        message="The control plane has no agent CA yet (its agent gRPC listener is not set up), so the installer has no CA to verify. An administrator can enable the agent gRPC listener; until then, use the manual install below."
      />
    {:else}
      <HostEnrollInstall {hostName} {hostKey} info={enrollInfo} {enrollExpiresAt} />
    {/if}
    {#if info && !info.grpc_domain_configured}
      <Alert tone="warning" compact title="No gRPC domain on the control plane" message="server.grpc_domain is not set, so the certificate names localhost: agents on other machines cannot verify the control plane until an administrator sets server.grpc_domain and restarts it." />
    {/if}
  </section>

  <section class="hcg-step" aria-labelledby={`${uid}-s2`}>
    <h3 id={`${uid}-s2`}>2. Wait for the host agent</h3>
    {#if online && row}
      <p class="hcg-status"><StatusDot status="online" label="Host agent online" /> {row.protection.agents.host?.version ? `version ${row.protection.agents.host.version}` : ''}</p>
      <dl class="hcg-facts">
        <div><dt>Firewall</dt><dd><Badge tone={modeTone(row.protection.firewall.state)}>{FIREWALL_STATE_TEXT[row.protection.firewall.state]}</Badge></dd></div>
        <div><dt>Runtime security</dt><dd><Badge tone={row.protection.runtime.state === 'on' ? 'info' : 'neutral'}>{RUNTIME_STATE_TEXT[row.protection.runtime.state]}</Badge></dd></div>
      </dl>
    {:else}
      <p class="hcg-status" aria-live="polite"><Spinner size="sm" label="Waiting for the host agent" /> Checking every 5 seconds…</p>
    {/if}
  </section>

  <details class="hcg-manual" open={manualFirst}>
    <summary>Manual install (fallback): project credential, interactive installer, env file and systemd unit</summary>
    <div class="hcg-manual-body">
      <HostManualInstall {projectId} {hostName} {hostKey} {info} {canConfigure} {oncredential} />
    </div>
  </details>
</div>

<style>
  .hcg { display: grid; gap: var(--sp-5); min-width: 0; }
  .hcg-step { display: grid; gap: var(--sp-3); min-width: 0; }
  .hcg-step h3 { margin: 0; font-size: var(--fs-base); font-weight: var(--fw-semibold); color: var(--text-primary); }
  .hcg-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); }
  .hcg-label { font-size: var(--fs-xs); color: var(--text-secondary); min-width: 6rem; }
  .hcg-input {
    flex: 1 1 16rem;
    box-sizing: border-box;
    min-height: 36px;
    padding: var(--sp-2) var(--sp-3);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    background: var(--bg-code);
    color: var(--text-secondary);
    font: inherit;
    font-size: var(--fs-sm);
  }
  .hcg-input:focus-visible { outline: var(--ring-width) solid var(--ring-color); outline-offset: 1px; }
  .mono { font-family: var(--font-mono); font-size: var(--fs-xs); }
  .hcg-status { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); margin: 0; font-size: var(--fs-sm); color: var(--text-secondary); }
  .hcg-facts { display: flex; flex-wrap: wrap; gap: var(--sp-2) var(--sp-5); margin: 0; font-size: var(--fs-sm); }
  .hcg-facts div { display: flex; align-items: center; gap: var(--sp-2); }
  .hcg-facts dt { color: var(--text-muted); }
  .hcg-facts dd { margin: 0; }
  .hcg-manual { border: 1px solid var(--border); border-radius: var(--radius-lg); padding: var(--sp-3) var(--sp-4); }
  .hcg-manual summary { cursor: pointer; font-size: var(--fs-sm); color: var(--accent); }
  .hcg-manual summary:focus-visible { outline: var(--ring-width) solid var(--ring-color); outline-offset: 2px; }
  .hcg-manual-body { margin-top: var(--sp-4); }
</style>
