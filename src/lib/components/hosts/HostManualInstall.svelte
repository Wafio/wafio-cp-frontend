<!--
  HostManualInstall: the manual fallback of "Connect this host", shown inside HostConnectGuide's
  "Manual install (fallback)" disclosure.

  1. A project-wide mTLS credential: create one for this host (CA, client
     certificate and key shown once) or reuse a project credential.
  2. The interactive installer and every answer it asks for, each copyable.
  3. The gRPC server name when the certificate's name differs from the
     address the agent dials.
  4. Env file, systemd unit and the steps to place them (automation).

  The network interface is never guessed (`<interface>`, `ip route show default`).
-->
<script lang="ts">
  import { base } from '#lib/paths.js';
  import Alert from '#lib/components/ui/Alert.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import { provisionAgentMTLSCredential, type AgentConnectInfo, type AgentMTLSProvisionResponse } from '#lib/api.js';
  import {
    endpointError,
    hostCredentialName,
    INSTALLER_COMMAND,
    INTERFACE_HINT_COMMAND,
    installerAnswers,
    manualEnvFile,
    manualSteps,
    manualUnit,
    serverNameCommand,
    serverNameNotice,
    suggestEndpoint,
    type EndpointSuggestion,
  } from '#lib/host-connect.js';
  import { credentialFileName } from '#lib/overview.js';
  import { createTar } from '#lib/tar.js';
  import { copyWithToast as copy } from './copy';

  let {
    projectId,
    hostName,
    hostKey = null,
    info,
    canConfigure = false,
    oncredential = undefined,
  }: {
    projectId: string;
    hostName: string;
    hostKey?: string | null;
    /** null while loading or when it failed (the address is then typed by hand). */
    info: AgentConnectInfo | null;
    canConfigure?: boolean;
    oncredential?: (shown: boolean) => void;
  } = $props();

  const uid = $props.id();

  let endpoint = $state('');
  /** Why the address was prefilled as it was (null once edited by hand or not prefilled). */
  let endpointReason = $state<EndpointSuggestion['reason'] | null>(null);
  let prefilled = false;
  let credential = $state<AgentMTLSProvisionResponse | null>(null);
  let credBusy = $state(false);
  let credError = $state<string | null>(null);

  $effect(() => {
    if (!info || prefilled) return;
    prefilled = true;
    if (endpoint) return;
    const suggestion = suggestEndpoint(info.grpc_endpoint, typeof window === 'undefined' ? '' : window.location.hostname);
    endpoint = suggestion.endpoint;
    endpointReason = suggestion.reason;
  });

  async function createCredential() {
    if (credBusy || !canConfigure) return;
    credBusy = true;
    credError = null;
    const res = await provisionAgentMTLSCredential(projectId, hostCredentialName(hostName));
    credBusy = false;
    if (res.error || !res.data) {
      credError = res.error?.error ?? 'The credential was not created.';
      return;
    }
    credential = res.data;
    if (!endpoint && res.data.server_hint) endpoint = res.data.server_hint;
    oncredential?.(true);
  }

  const answers = $derived(installerAnswers({ endpoint, hostKey, credential }));
  const notice = $derived(info ? serverNameNotice(info, endpoint) : null);
  const endpointProblem = $derived(endpoint ? endpointError(endpoint) : null);
  const serverName = $derived(notice?.needed ? info?.grpc_server_name ?? null : null);
  const envFile = $derived(manualEnvFile({ endpoint, serverName, hostKey }));
  const unit = $derived(manualUnit({ agentName: hostName, endpoint, serverName }));
  const serverNameCmd = $derived(serverName ? serverNameCommand(serverName) : '');
  const endpointHint = $derived(
    endpointReason === 'internal'
      ? `The control plane calls itself ${info?.grpc_endpoint}, a name other hosts usually cannot resolve, so this uses the address this dashboard is open on. Change it if hosts reach the control plane another way.`
      : endpointReason === 'missing'
        ? 'The control plane has no gRPC domain configured, so this uses the address this dashboard is open on. Change it if hosts reach the control plane another way.'
        : 'The host:port this host dials. Change it if hosts reach the control plane another way (VPN, NAT, private network).',
  );

  function download(name: string, content: BlobPart, type: string) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  function downloadCredential() {
    if (!credential) return;
    const safe = credentialFileName(credential.name);
    const tar = createTar([
      { name: 'ca.crt', content: credential.ca_cert },
      { name: 'client.crt', content: credential.client_cert },
      { name: 'client.key', content: credential.client_key, mode: 0o600 },
      { name: 'host-agent.env', content: envFile, mode: 0o600 },
      { name: 'wafio-host-agent.service', content: unit },
    ]);
    download(`wafio-${safe}-bundle.tar`, tar, 'application/x-tar');
  }
</script>

<div class="hmi">
  <section class="hmi-step" aria-labelledby={`${uid}-m1`}>
    <h4 id={`${uid}-m1`}>1. A project credential</h4>
    <p class="hmi-text">
      The agent needs an mTLS credential of this project. Such a credential is project-wide: it is not bound to this host and is not revoked when the host is revoked or deleted (revoke it on the Credentials page). One credential may serve many hosts; a credential per host lets you revoke one host without touching the others.
    </p>
    {#if credential}
      <Alert tone="warning" compact title="Copy or download the credential now" message="The client private key is shown only once." />
      <div class="hmi-actions">
        <Button variant="secondary" size="sm" onclick={downloadCredential}>Download bundle (.tar)</Button>
        <span class="hmi-muted">ca.crt, client.crt, client.key, host-agent.env and the systemd unit</span>
      </div>
    {:else}
      <div class="hmi-actions">
        <Button variant="secondary" size="sm" loading={credBusy} disabled={!canConfigure} title={canConfigure ? undefined : 'Your role cannot create credentials'} onclick={createCredential}>Create a credential for this host</Button>
        <a href={`${base}/projects/${projectId}/settings/credentials`}>Use an existing project credential</a>
      </div>
      {#if credError}<Alert tone="error" compact title="Credential not created" message={credError} />{/if}
    {/if}
  </section>

  <section class="hmi-step" aria-labelledby={`${uid}-m2`}>
    <h4 id={`${uid}-m2`}>2. Run the interactive installer on the host</h4>
    <div class="hmi-code">
      <pre><code>{INSTALLER_COMMAND}</code></pre>
      <Button variant="outline" size="sm" onclick={() => copy(INSTALLER_COMMAND, 'Command')}>Copy</Button>
    </div>
    <p class="hmi-text">It needs a terminal and asks for these values, in this order:</p>
    <div class="hmi-field">
      <label class="hmi-label" for={`${uid}-ep`}>Address agents use to reach the control plane</label>
      <input
        id={`${uid}-ep`}
        class="hmi-input mono"
        type="text"
        bind:value={endpoint}
        oninput={() => (endpointReason = null)}
        placeholder="cp.example.com:9090"
        autocomplete="off"
        spellcheck="false"
        aria-invalid={endpointProblem ? 'true' : undefined}
        aria-describedby={`${uid}-ep-hint`}
      />
      <p id={`${uid}-ep-hint`} class="hmi-muted">{endpointHint}{endpointProblem ? ` ${endpointProblem}` : ''}</p>
    </div>
    {#if info}
      <div class="hmi-field">
        <label class="hmi-label" for={`${uid}-sn`}>TLS server name the agent verifies</label>
        <input id={`${uid}-sn`} class="hmi-input mono" type="text" readonly value={info.grpc_server_name} aria-describedby={`${uid}-sn-hint`} />
        <p id={`${uid}-sn-hint`} class="hmi-muted">The name in the control plane's gRPC certificate (server.grpc_domain).</p>
      </div>
    {/if}
    <ol class="hmi-answers">
      {#each answers as answer (answer.prompt)}
        <li>
          <span class="hmi-prompt">{answer.prompt}</span>
          {#if answer.multiline && answer.known}
            <details>
              <summary>Show {answer.prompt}</summary>
              <pre class="hmi-pem"><code>{answer.value}</code></pre>
            </details>
          {:else}
            <code class="hmi-value" class:placeholder={!answer.known}>{answer.secret && answer.known ? `${answer.value.slice(0, 9)}…` : answer.value}</code>
          {/if}
          {#if answer.known}<Button variant="ghost" size="sm" onclick={() => copy(answer.value, answer.prompt)}>Copy</Button>{/if}
          {#if answer.multiline}<span class="hmi-muted">paste, then an empty line</span>{/if}
        </li>
      {/each}
    </ol>
  </section>

  {#if notice?.needed}
    <section class="hmi-step" aria-labelledby={`${uid}-m3`}>
      <h4 id={`${uid}-m3`}>3. Set the gRPC server name</h4>
      <p class="hmi-text">
        The agent dials <code>{endpoint || 'the address above'}</code> but the control plane's certificate names <code>{info?.grpc_server_name}</code>, so the agent must verify that name instead. If the installer did not write it, run this on the host (it adds <code>{notice.envLine}</code> to <code>/etc/wafio/host-agent.env</code> and restarts the agent). The env file and unit below already include it.
      </p>
      <div class="hmi-code">
        <pre><code>{serverNameCmd || notice.envLine}</code></pre>
        <Button variant="outline" size="sm" onclick={() => copy(serverNameCmd || notice?.envLine || '', 'Command')}>Copy</Button>
      </div>
    </section>
  {/if}

  <section class="hmi-step" aria-labelledby={`${uid}-m4`}>
    <h4 id={`${uid}-m4`}>{notice?.needed ? '4' : '3'}. Automation: env file and systemd unit</h4>
    <p class="hmi-text">Install the binary and eBPF objects with the installer or your own tooling, then place these files. Replace <code>&lt;interface&gt;</code> with the interface to protect: the <code>dev</code> of <code>{INTERFACE_HINT_COMMAND}</code>.</p>
    <div class="hmi-code">
      <pre><code>{envFile}</code></pre>
      <Button variant="outline" size="sm" onclick={() => copy(envFile, 'Env file')}>Copy</Button>
    </div>
    <div class="hmi-code">
      <pre><code>{unit}</code></pre>
      <Button variant="outline" size="sm" onclick={() => copy(unit, 'Unit')}>Copy</Button>
    </div>
    <div class="hmi-code">
      <pre><code>{manualSteps()}</code></pre>
      <Button variant="outline" size="sm" onclick={() => copy(manualSteps(), 'Steps')}>Copy</Button>
    </div>
  </section>
</div>

<style>
  .hmi { display: grid; gap: var(--sp-5); min-width: 0; }
  .hmi-step { display: grid; gap: var(--sp-3); min-width: 0; }
  .hmi-step h4 { margin: 0; font-size: var(--fs-sm); font-weight: var(--fw-semibold); color: var(--text-primary); }
  .hmi-text { margin: 0; font-size: var(--fs-sm); color: var(--text-secondary); line-height: 1.5; }
  .hmi-muted { font-size: var(--fs-xs); color: var(--text-muted); }
  .hmi-label { font-size: var(--fs-xs); color: var(--text-secondary); }
  .hmi-field { display: grid; gap: var(--sp-1); max-width: 32rem; }
  .hmi-field .hmi-muted { margin: 0; }
  .hmi-input {
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
  .hmi-input[readonly] { background: var(--bg-code); color: var(--text-secondary); }
  .hmi-input:focus-visible { outline: var(--ring-width) solid var(--ring-color); outline-offset: 1px; }
  .mono, code, pre { font-family: var(--font-mono); font-size: var(--fs-xs); }
  .hmi-actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-3); font-size: var(--fs-sm); }
  .hmi-actions a { color: var(--accent); }
  .hmi-code { display: flex; align-items: flex-start; gap: var(--sp-2); min-width: 0; }
  .hmi-code pre, .hmi-pem {
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
  .hmi-answers { display: grid; gap: var(--sp-2); margin: 0; padding-left: var(--sp-5); font-size: var(--fs-sm); }
  .hmi-answers li { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); }
  .hmi-prompt { color: var(--text-secondary); min-width: 14rem; }
  .hmi-value { padding: 0 var(--sp-2); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text-primary); overflow-wrap: anywhere; }
  .hmi-value.placeholder { color: var(--text-muted); border-style: dashed; }
  details summary { cursor: pointer; font-size: var(--fs-sm); color: var(--accent); }
  details summary:focus-visible { outline: var(--ring-width) solid var(--ring-color); outline-offset: 2px; }
  .hmi-pem { margin-top: var(--sp-2); }
</style>
