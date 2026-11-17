<!--
  HostEnrollInstall: "Install with one command" of HostConnectGuide (host-key enrollment).

  Builds the installer command (`host-agent`, and optionally `waf-agent`):
  the private key is created on the host, enrolled with the host key at
  `<url>/api/internal/host-enroll`, and nothing is written unless the CA
  matches `--ca-sha256`. Explains the enrollment window and the limits from
  GET /agent-connect-info (`enrollment`, defaults when an older server omits
  it). The parent renders this only when `ca_sha256` is known.
-->
<script lang="ts">
  import Alert from '#lib/components/ui/Alert.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import DateTime from '#lib/components/ui/DateTime.svelte';
  import { apiBaseUrl, type AgentConnectInfo } from '#lib/api.js';
  import {
    dashboardUrlError,
    endpointError,
    enrollCommand,
    enrollLimits,
    enrollWindowState,
    LOOPBACK_URL_HOSTS,
    suggestEndpoint,
    suggestWafAgentName,
    type EndpointSuggestion,
  } from '#lib/host-connect.js';
  import { formatDuration } from '#lib/format.js';
  import { copyWithToast as copy } from './copy';

  let {
    hostName,
    hostKey = null,
    info,
    enrollExpiresAt = undefined,
  }: {
    hostName: string;
    /** Known only right after the host is created or its key rotated. */
    hostKey?: string | null;
    info: AgentConnectInfo & { ca_sha256: string };
    /** End of the enrollment window; null = closed, undefined = not known here. */
    enrollExpiresAt?: string | null;
  } = $props();

  const uid = $props.id();

  let dashboardUrl = $state(apiBaseUrl());
  let endpoint = $state('');
  let endpointReason = $state<EndpointSuggestion['reason']>('public');
  let endpointEdited = $state(false);
  let serverName = $state('');
  let hostAgentName = $state('');
  let wafName = $state('');
  let includeKey = $state(true);
  let prefilled = false;
  let now = $state(Date.now());

  $effect(() => {
    if (prefilled) return;
    prefilled = true;
    const suggestion = suggestEndpoint(info.grpc_endpoint, typeof window === 'undefined' ? '' : window.location.hostname);
    endpoint = suggestion.endpoint;
    endpointReason = suggestion.reason;
    wafName = suggestWafAgentName(hostName);
  });

  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(timer);
  });

  const limits = $derived(enrollLimits(info));
  const windowState = $derived(enrollWindowState(enrollExpiresAt, now));
  /** The server's own grpc_endpoint is not usable from other hosts: always pass --control-plane. */
  const endpointNeeded = $derived(endpointReason !== 'public');
  const passEndpoint = $derived(endpointNeeded || (endpointEdited && endpoint.trim() !== (info.grpc_endpoint ?? '').trim()));
  const urlProblem = $derived(dashboardUrlError(dashboardUrl));
  const endpointProblem = $derived(passEndpoint ? endpointError(endpoint) : null);
  const loopbackUrl = $derived.by(() => {
    try {
      return LOOPBACK_URL_HOSTS.includes(new URL(dashboardUrl.trim()).hostname.toLowerCase());
    } catch {
      return false;
    }
  });
  const problem = $derived(urlProblem ?? endpointProblem);

  const common = $derived({
    dashboardUrl,
    caSha256: info.ca_sha256,
    hostKey: includeKey ? hostKey : null,
    endpoint: passEndpoint ? endpoint : null,
    serverName,
  });
  const hostCommand = $derived(enrollCommand({ ...common, kind: 'host', agentName: hostAgentName }));
  const wafCommand = $derived(enrollCommand({ ...common, kind: 'waf', agentName: wafName.trim() || suggestWafAgentName(hostName) }));
  const remaining = $derived(windowState.open ? formatDuration(Math.max(60_000, Math.round(windowState.remainingMs / 60_000) * 60_000), 'ms') : '');
</script>

<div class="hei">
  <p class="hei-text">
    Run this on the host as root. The installer creates the agent's private key on the host (it never leaves it), enrolls it with the host key, checks that the control plane's CA matches <code>--ca-sha256</code> before it writes anything, and starts the agent.
  </p>

  {#if enrollExpiresAt === undefined}
    <p class="hei-text">A host key can enroll agents for {limits.window_hours} hours after the host is registered or its key is rotated.</p>
  {:else if windowState.open}
    <p class="hei-window">Enrollment window open until <DateTime value={windowState.expiresAt.toISOString()} /> ({remaining} left).</p>
  {:else}
    <Alert
      tone="warning"
      compact
      title="The enrollment window of this host key is closed"
      message={`A host key can enroll agents only within ${limits.window_hours} hours after the host is registered or its key is rotated; hosts registered before enrollment existed have no window. Rotate the host key (Host key and lifecycle) to open a new window, then run the command and enter the new key.`}
    />
  {/if}

  <div class="hei-field">
    <label class="hei-label" for={`${uid}-url`}>Dashboard address the host can reach</label>
    <input
      id={`${uid}-url`}
      class="hei-input mono"
      type="url"
      bind:value={dashboardUrl}
      autocomplete="off"
      spellcheck="false"
      aria-invalid={urlProblem ? 'true' : undefined}
      aria-describedby={`${uid}-url-hint`}
    />
    <p id={`${uid}-url-hint`} class="hei-muted">
      {urlProblem ?? (loopbackUrl ? 'A loopback address works only when the agent runs on the control plane machine itself; use the https:// address hosts reach otherwise.' : 'The installer enrolls at this address (https://, or http:// only for 127.0.0.1, localhost or [::1]).')}
    </p>
  </div>

  {#if endpointNeeded}
    <div class="hei-field">
      <label class="hei-label" for={`${uid}-ep`}>Address agents use to reach the control plane (gRPC)</label>
      <input id={`${uid}-ep`} class="hei-input mono" type="text" bind:value={endpoint} placeholder="cp.example.com:9090" autocomplete="off" spellcheck="false" aria-invalid={endpointProblem ? 'true' : undefined} aria-describedby={`${uid}-ep-hint`} />
      <p id={`${uid}-ep-hint`} class="hei-muted">
        {endpointProblem ?? (endpointReason === 'internal'
          ? `The control plane calls itself ${info.grpc_endpoint}, a name other hosts usually cannot resolve, so the command passes this address instead.`
          : 'The control plane has no gRPC domain configured, so the command passes this address. Change it if hosts reach the control plane another way.')}
      </p>
    </div>
  {/if}

  {#if hostKey}
    <label class="hei-check">
      <input type="checkbox" bind:checked={includeKey} />
      <span>Put the host key in the command</span>
    </label>
    <p class="hei-muted">
      {includeKey
        ? 'The key is piped to the installer (--host-key-stdin), so it stays out of the process list and sudo’s log; it still lands in your shell history. Clear this to have the installer ask for it without echo instead.'
        : 'The installer asks for the host key without echo; paste the key shown above.'}
    </p>
  {:else}
    <p class="hei-text">
      The command does not carry the host key: the installer asks for it without echo, which also keeps it out of shell history and the process list. The key was shown once when the host was registered or its key rotated; if it is lost or its enrollment window has passed, rotate it first.
    </p>
  {/if}

  <div class="hei-code">
    <pre><code>{hostCommand}</code></pre>
    <Button variant="outline" size="sm" disabled={Boolean(problem)} title={problem ?? undefined} onclick={() => copy(hostCommand, 'Command')}>Copy</Button>
  </div>
  {#if problem}<p class="hei-muted" role="status">Fix the address above before copying the command.</p>{/if}

  <details class="hei-more">
    <summary>Advanced options</summary>
    <div class="hei-more-body">
      {#if !endpointNeeded}
        <div class="hei-field">
          <label class="hei-label" for={`${uid}-ep2`}>Address agents use to reach the control plane (gRPC)</label>
          <input id={`${uid}-ep2`} class="hei-input mono" type="text" bind:value={endpoint} oninput={() => (endpointEdited = true)} autocomplete="off" spellcheck="false" aria-invalid={endpointProblem ? 'true' : undefined} aria-describedby={`${uid}-ep2-hint`} />
          <p id={`${uid}-ep2-hint`} class="hei-muted">{endpointProblem ?? 'The control plane tells the installer this address. Change it only if hosts reach the gRPC port another way (VPN, NAT, private network); the command then passes --control-plane.'}</p>
        </div>
      {/if}
      <div class="hei-field">
        <label class="hei-label" for={`${uid}-sn`}>TLS server name (optional)</label>
        <input id={`${uid}-sn`} class="hei-input mono" type="text" bind:value={serverName} placeholder={info.grpc_server_name} autocomplete="off" spellcheck="false" aria-describedby={`${uid}-sn-hint`} />
        <p id={`${uid}-sn-hint`} class="hei-muted">Leave empty to use the name the control plane returns ({info.grpc_server_name}); the installer writes it to the agent's env file.</p>
      </div>
      <div class="hei-field">
        <label class="hei-label" for={`${uid}-an`}>Host agent name (optional)</label>
        <input id={`${uid}-an`} class="hei-input mono" type="text" bind:value={hostAgentName} placeholder="<hostname>@ebpf" maxlength="128" autocomplete="off" spellcheck="false" aria-describedby={`${uid}-an-hint`} />
        <p id={`${uid}-an-hint`} class="hei-muted">Leave empty for the installer's default, the machine's hostname followed by @ebpf.</p>
      </div>
    </div>
  </details>

  <details class="hei-more">
    <summary>Optional: also install the WAF agent on this host</summary>
    <div class="hei-more-body">
      <p class="hei-text">For L7 inspection of web applications on this host. Once it is online, assign applications to it on WAF agents.</p>
      <div class="hei-field">
        <label class="hei-label" for={`${uid}-waf`}>WAF agent name</label>
        <input id={`${uid}-waf`} class="hei-input mono" type="text" bind:value={wafName} maxlength="128" autocomplete="off" spellcheck="false" />
      </div>
      <div class="hei-code">
        <pre><code>{wafCommand}</code></pre>
        <Button variant="outline" size="sm" disabled={Boolean(problem)} title={problem ?? undefined} onclick={() => copy(wafCommand, 'Command')}>Copy</Button>
      </div>
    </div>
  </details>

  <ul class="hei-limits">
    <li>Up to {limits.max_credentials_per_host} enrolled agents per host, one certificate per agent name, and an agent name can be used by only one agent in the project. Each agent enrolls once per host key: running the command again on the same host (it still holds its key) returns the certificate it already has; a new certificate is issued only after that one expires or the agent CA changes. From anywhere else it is refused.</li>
    <li>Certificates are valid {limits.cert_validity_days} days. To renew, rotate the host key (that opens a new {limits.window_hours}-hour window) and run the same command again.</li>
    <li>Each certificate works only for this host and its own agent; it cannot register another agent name or host. Revoking or deleting this host revokes them all.</li>
  </ul>
</div>

<style>
  .hei { display: grid; gap: var(--sp-3); min-width: 0; }
  .hei-text { margin: 0; font-size: var(--fs-sm); color: var(--text-secondary); line-height: 1.5; }
  .hei-window { margin: 0; font-size: var(--fs-sm); color: var(--text-primary); }
  .hei-muted { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.5; }
  .hei-label { font-size: var(--fs-xs); color: var(--text-secondary); }
  .hei-field { display: grid; gap: var(--sp-1); max-width: 32rem; }
  .hei-input {
    box-sizing: border-box;
    min-height: 36px;
    padding: var(--sp-2) var(--sp-3);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    background: var(--surface-input);
    color: var(--text-primary);
    font: inherit;
    font-size: var(--fs-sm);
  }
  .hei-input:focus-visible { outline: var(--ring-width) solid var(--ring-color); outline-offset: 1px; }
  .mono, code, pre { font-family: var(--font-mono); font-size: var(--fs-xs); }
  .hei-check { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm); color: var(--text-primary); }
  .hei-check input:focus-visible { outline: var(--ring-width) solid var(--ring-color); outline-offset: 2px; }
  .hei-code { display: flex; align-items: flex-start; gap: var(--sp-2); min-width: 0; }
  .hei-code pre {
    flex: 1;
    min-width: 0;
    margin: 0;
    padding: var(--sp-3);
    overflow-x: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg-code);
    color: var(--text-primary);
    white-space: pre;
  }
  .hei-more summary { cursor: pointer; font-size: var(--fs-sm); color: var(--accent); }
  .hei-more summary:focus-visible { outline: var(--ring-width) solid var(--ring-color); outline-offset: 2px; }
  .hei-more-body { display: grid; gap: var(--sp-3); margin-top: var(--sp-3); }
  .hei-limits { display: grid; gap: var(--sp-1); margin: 0; padding-left: var(--sp-5); font-size: var(--fs-xs); color: var(--text-secondary); line-height: 1.5; }
</style>
