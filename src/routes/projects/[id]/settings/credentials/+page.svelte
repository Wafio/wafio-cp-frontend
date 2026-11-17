<script lang="ts">
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { tick, untrack } from 'svelte';
  import { base } from '#lib/paths.js';
  import {
    listAgentMTLSCredentials,
    provisionAgentMTLSCredential,
    revokeAgentMTLSCredential,
    type AgentMTLSCredential,
    type AgentMTLSProvisionResponse,
  } from '#lib/api.js';
  import { credentialBinding, credentialService } from '#lib/credential-service.js';
  import { createTar } from '#lib/tar.js';
  import { agentCertDir, credentialFileName, installCommand } from '#lib/overview.js';
  import { tierFor } from '#lib/confirm-tiers.js';
  import { getProjectContext } from '#lib/project-context.svelte.js';
  import { toast } from '#lib/stores/toast.js';
  import { createDirtyTracker } from '#lib/dirty.svelte.js';
  import { DateTime } from '#lib/components/ui/index.js';
  import PageHeader from '#lib/components/ui/PageHeader.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Alert from '#lib/components/ui/Alert.svelte';
  import EmptyState from '#lib/components/ui/EmptyState.svelte';
  import ConfirmModal from '#lib/components/ui/ConfirmModal.svelte';
  import Select from '#lib/components/ui/Select.svelte';
  import Pagination from '#lib/components/ui/Pagination.svelte';
  import ActionMenu from '#lib/components/ActionMenu.svelte';

  const PAGE_SIZE = 20;
  const EXPIRING_DAYS = 30;

  const project = getProjectContext();
  const projectId = $derived(page.params.id ?? '');
  const highlightId = $derived(page.url.searchParams.get('credential') ?? '');
  const expiringOnly = $derived(page.url.searchParams.get('filter') === 'expiring');

  let credentials = $state<AgentMTLSCredential[]>([]);
  let total = $state(0);
  let offset = $state(0);
  let loading = $state(true);
  let error = $state('');

  let newName = $state('');
  let validityDays = $state(365);
  let agentKind = $state<'waf' | 'host'>('waf');
  const AGENT_KINDS: { value: 'waf' | 'host'; label: string }[] = [
    { value: 'waf', label: 'WAF agent' },
    { value: 'host', label: 'Host agent' },
  ];
  let provisioning = $state(false);
  let provisionError = $state('');
  let provisioned = $state<AgentMTLSProvisionResponse | null>(null);
  let showPem = $state(false);
  let copiedCommand = $state(false);
  /** Id of the issued credential whose bundle was downloaded. */
  let downloadedId = $state<string | null>(null);

  // The private key exists only in this page until the bundle is downloaded:
  // leaving, reloading or dismissing before that asks first.
  const KEY_NOT_SAVED = 'The private key of the new credential has not been downloaded and cannot be shown again. Leave anyway?';
  const keyGuard = createDirtyTracker(() => (provisioned && provisioned.id !== downloadedId ? provisioned.id : null), { message: KEY_NOT_SAVED });
  keyGuard.guardNavigation();
  // While the issue request runs, leaving would drop the response and its
  // private key (it is never shown again): ask first as well.
  const ISSUING = 'A credential is being issued. Leaving now loses its private key, which cannot be shown again. Leave anyway?';
  const issueGuard = createDirtyTracker(() => provisioning, { message: ISSUING });
  issueGuard.guardNavigation();

  let revokeTarget = $state<AgentMTLSCredential | null>(null);
  let revoking = $state(false);
  const revokeNeedsTyping = tierFor('revoke-credential') === 'typed';

  let scopeEpoch = 0;

  type ExpiryState = 'expired' | 'expiring' | 'valid' | 'unknown';

  function expiryState(c: AgentMTLSCredential, now = Date.now()): ExpiryState {
    if (c.expired) return 'expired';
    if (c.expiring) return 'expiring';
    const until = c.valid_until ? Date.parse(c.valid_until) : NaN;
    if (!Number.isFinite(until)) return 'unknown';
    if (until <= now) return 'expired';
    if (until - now <= EXPIRING_DAYS * 86_400_000) return 'expiring';
    return 'valid';
  }

  const EXPIRY_LABEL: Record<ExpiryState, string> = { expired: 'Expired', expiring: 'Expiring soon', valid: 'Valid', unknown: 'Unknown' };
  const EXPIRY_TONE = { expired: 'danger', expiring: 'warning', valid: 'neutral', unknown: 'neutral' } as const;

  const shown = $derived(expiringOnly ? credentials.filter((c) => ['expired', 'expiring'].includes(expiryState(c))) : credentials);
  const counts = $derived({
    expired: credentials.filter((c) => expiryState(c) === 'expired').length,
    expiring: credentials.filter((c) => expiryState(c) === 'expiring').length,
  });

  async function load() {
    const target = projectId;
    const epoch = scopeEpoch;
    loading = true;
    error = '';
    const res = await listAgentMTLSCredentials(target, { limit: PAGE_SIZE, offset });
    if (epoch !== scopeEpoch || target !== projectId) return;
    loading = false;
    if (res.error || !res.data) {
      error = res.error?.error ?? 'Credentials could not be loaded.';
      return;
    }
    credentials = res.data.credentials ?? [];
    total = res.data.total ?? credentials.length;
    if (offset > 0 && offset >= total) {
      offset = Math.max(0, Math.floor((total - 1) / PAGE_SIZE) * PAGE_SIZE);
      return load();
    }
    await tick();
    if (highlightId) document.getElementById(`credential-${highlightId}`)?.scrollIntoView({ block: 'center' });
  }

  $effect(() => {
    const id = projectId;
    untrack(() => {
      scopeEpoch++;
      credentials = [];
      provisioning = false;
      provisioned = null;
      showPem = false;
      offset = 0;
      if (id) void load();
    });
    return () => { scopeEpoch++; };
  });

  async function provision(event: SubmitEvent) {
    event.preventDefault();
    if (!project.canConfigure) return;
    provisionError = '';
    if (!newName.trim()) {
      provisionError = 'Enter a name for the credential, for example the agent host name.';
      return;
    }
    const days = Math.round(Number(validityDays));
    if (!Number.isFinite(days) || days < 1 || days > 36500) {
      provisionError = 'Validity must be between 1 and 36500 days.';
      return;
    }
    const target = projectId;
    const epoch = scopeEpoch;
    provisioning = true;
    let res: Awaited<ReturnType<typeof provisionAgentMTLSCredential>>;
    try {
      res = await provisionAgentMTLSCredential(target, newName.trim(), days);
    } finally {
      // Always cleared, even when the page moved on to another project.
      if (epoch === scopeEpoch) provisioning = false;
    }
    if (epoch !== scopeEpoch || target !== projectId) return;
    if (res.error || !res.data) {
      provisionError = res.error?.error ?? 'The credential could not be provisioned.';
      return;
    }
    toast.success(`Credential "${res.data.name}" issued. Download the bundle now; the private key is shown once.`);
    provisioned = res.data;
    showPem = false;
    newName = '';
    validityDays = 365;
    offset = 0;
    void load();
  }

  function downloadBundle(p: AgentMTLSProvisionResponse) {
    // One .tar instead of four downloads (browsers block the 2nd+ automatic
    // download from one click, which silently lost the private key).
    const safe = credentialFileName(p.name);
    const tar = createTar([
      { name: 'ca.crt', content: p.ca_cert },
      { name: 'client.crt', content: p.client_cert },
      { name: 'client.key', content: p.client_key, mode: 0o600 },
      { name: `wafio-${safe}.service`, content: credentialService(p.name, p.server_hint ?? '', agentKind) },
    ]);
    const url = URL.createObjectURL(new Blob([tar], { type: 'application/x-tar' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `wafio-${safe}-bundle.tar`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    downloadedId = p.id;
  }

  async function dismissReveal() {
    if (!(await keyGuard.confirmDiscard())) return;
    provisioned = null;
    showPem = false;
  }

  const command = $derived(provisioned ? installCommand(provisioned.name, agentKind) : '');

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${what} copied.`);
      return true;
    } catch {
      toast.error('Copy failed. Select the text and copy it manually.');
      return false;
    }
  }

  async function copyCommand() {
    copiedCommand = await copy(command, 'Install command');
    if (copiedCommand) setTimeout(() => (copiedCommand = false), 2000);
  }

  async function confirmRevoke() {
    const target = revokeTarget;
    if (!target || !project.canConfigure) return;
    const pid = projectId;
    const epoch = scopeEpoch;
    revoking = true;
    const res = await revokeAgentMTLSCredential(pid, target.id);
    if (epoch !== scopeEpoch || pid !== projectId) return;
    revoking = false;
    if (res.error) {
      toast.error(res.error.error ?? 'The credential could not be revoked.');
      return;
    }
    toast.success(`Credential "${target.name}" revoked.`);
    revokeTarget = null;
    if (provisioned?.id === target.id) provisioned = null;
    void load();
  }

  function setFilter(expiring: boolean) {
    const url = new URL(page.url.href);
    if (expiring) url.searchParams.set('filter', 'expiring');
    else url.searchParams.delete('filter');
    void goto(`${url.pathname}${url.search}`, { replace: true, reset: false });
  }

  function changePage(next: number) {
    offset = next;
    void load();
  }
</script>

<div class="page">
  <PageHeader title="Credentials" subtitle="mTLS client certificates that WAF and host agents use to connect to the control plane." backHref="{base}/projects/{projectId}" />

  {#if !project.canConfigure && project.project}
    <Alert tone="info" compact message="Read-only: issuing and revoking credentials needs the member or owner role." />
  {/if}

  <section class="card" aria-labelledby="issue-title">
    <h2 id="issue-title">Issue a credential</h2>
    <p class="card-sub">Each credential is a client certificate signed by the WAFio agent CA. The private key is shown <strong>once</strong>: download the bundle before you leave this page.</p>
    <form class="issue-form" onsubmit={provision} novalidate>
      {#if provisionError}<Alert tone="error" compact message={provisionError} />{/if}
      <div class="fields">
        <div class="field grow">
          <label for="cred-name">Name</label>
          <input id="cred-name" type="text" bind:value={newName} maxlength="100" disabled={!project.canConfigure} aria-describedby="cred-name-hint" />
          <p class="hint" id="cred-name-hint">Shown in this list and used as the agent name, e.g. edge-waf-1.</p>
        </div>
        <div class="field">
          <label for="cred-days">Valid for (days)</label>
          <input id="cred-days" type="number" bind:value={validityDays} min="1" max="36500" disabled={!project.canConfigure} class="narrow" />
        </div>
        <div class="field">
          <label for="cred-kind">Agent type</label>
          <Select id="cred-kind" options={AGENT_KINDS} bind:value={agentKind} disabled={!project.canConfigure} aria-describedby="cred-kind-hint" />
          <p class="hint" id="cred-kind-hint">Selects the systemd unit in the bundle.</p>
        </div>
      </div>
      <div class="form-actions">
        <Button type="submit" disabled={!project.canConfigure || provisioning} loading={provisioning}>{provisioning ? 'Issuing…' : 'Issue credential'}</Button>
      </div>
    </form>

    {#if provisioned}
      <div class="reveal" role="region" aria-labelledby="reveal-title">
        <div class="reveal-head">
          <h3 id="reveal-title">Credential "{provisioned.name}" issued</h3>
          <Button variant="primary" size="sm" onclick={() => downloadBundle(provisioned!)}>Download bundle (.tar)</Button>
        </div>
        <Alert tone="warning" compact message="The private key is not stored on the server. After you dismiss this panel or leave the page it cannot be shown again." />
        <dl class="meta">
          <dt>Fingerprint</dt><dd><code>{provisioned.fingerprint}</code></dd>
          <dt>Expires</dt><dd><DateTime value={provisioned.valid_until} relative /></dd>
          <dt>Control plane address</dt><dd>{provisioned.server_hint || 'Not configured: replace YOUR_CONTROL_PLANE:9090 in the unit file'}</dd>
        </dl>
        <div class="install">
          <div class="install-head">
            <p>Install on the agent host</p>
            <div class="inline-select">
              <label for="cred-bundle-kind">Bundle and command for</label>
              <Select id="cred-bundle-kind" size="sm" options={AGENT_KINDS} bind:value={agentKind} />
            </div>
            <Button size="sm" variant="secondary" onclick={copyCommand}>{copiedCommand ? 'Copied' : 'Copy command'}</Button>
          </div>
          <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
          <pre class="command" tabindex="0" aria-label="Install command"><code>{command}</code></pre>
          <p class="hint">
            Run it in the unpacked agent release, which contains <code>install.sh</code>. The installer asks for the control plane address
            (<code>{provisioned.server_hint || 'host:9090 of this control plane'}</code>){agentKind === 'host' ? ', the network interface and whether to turn on runtime tracing' : ''}; it creates the <code>wafio-{agentKind}-agent</code> service.
          </p>
          <p class="hint">The bundle also holds a sample unit, <code>wafio-{credentialFileName(provisioned.name)}.service</code>, for a manual install without the installer: binary in <code>/usr/local/bin</code>, certificates in <code>{agentCertDir(agentKind)}</code>, the same place the installer uses.</p>
        </div>
        <details bind:open={showPem}>
          <summary>Certificates and key (PEM)</summary>
          <div class="pems">
            {#each [['CA certificate', provisioned.ca_cert], ['Client certificate', provisioned.client_cert], ['Client key', provisioned.client_key]] as [label, pem] (label)}
              <div>
                <p class="pem-label">{label}</p>
                <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
                <pre class="pem" tabindex="0" aria-label={label}>{pem}</pre>
              </div>
            {/each}
          </div>
        </details>
        <div class="form-actions">
          <Button variant="ghost" size="sm" onclick={() => void dismissReveal()}>{keyGuard.isDirty ? 'Dismiss without downloading' : 'I have the bundle, dismiss'}</Button>
        </div>
      </div>
    {/if}
  </section>

  <section class="card" aria-labelledby="issued-title">
    <div class="list-head">
      <h2 id="issued-title">Issued credentials <span class="count">{total}</span></h2>
      <div class="filters" role="group" aria-label="Filter credentials">
        <button type="button" class="chip" aria-pressed={!expiringOnly} onclick={() => setFilter(false)}>All</button>
        <button type="button" class="chip" aria-pressed={expiringOnly} onclick={() => setFilter(true)}>Expired or expiring{counts.expired + counts.expiring ? ` (${counts.expired + counts.expiring})` : ''}</button>
      </div>
    </div>
    <p class="hint">Credentials enrolled by the one-command install are bound to their host and one agent, and are revoked with their host. Project-wide credentials issued here are not: revoke them here.</p>
    {#if counts.expired || counts.expiring}
      <Alert tone="warning" compact message={`${counts.expired ? `${counts.expired} expired` : ''}${counts.expired && counts.expiring ? ' and ' : ''}${counts.expiring ? `${counts.expiring} expiring within ${EXPIRING_DAYS} days` : ''} on this page. Issue a replacement, confirm the agent reconnects with it, then revoke the old one.`} />
    {/if}
    {#if error}
      <Alert tone="error" message={error}>
        {#snippet actions()}<Button size="sm" variant="secondary" onclick={() => load()}>Retry</Button>{/snippet}
      </Alert>
    {:else if loading && credentials.length === 0}
      <p class="muted" role="status">Loading credentials…</p>
    {:else if credentials.length === 0}
      <EmptyState title="No credentials yet" message="Issue one above, then install it on the agent host." />
    {:else if shown.length === 0}
      <EmptyState title="No expired or expiring credentials" message={`Nothing on this page expires within ${EXPIRING_DAYS} days.`}>
        {#snippet action()}<Button size="sm" variant="secondary" onclick={() => setFilter(false)}>Show all credentials</Button>{/snippet}
      </EmptyState>
    {:else}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div class="table-wrap" role="region" aria-labelledby="issued-title" tabindex="0">
        <table>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Expiry</th>
              <th scope="col">Expires</th>
              <th scope="col">Issued</th>
              <th scope="col">Fingerprint</th>
              <th scope="col"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {#each shown as c (c.id)}
              {@const state = expiryState(c)}
              <tr id="credential-{c.id}" class:highlight={c.id === highlightId}>
                <th scope="row">
                  {c.name}
                  <span class="binding">{credentialBinding(c)}</span>
                </th>
                <td><Badge tone={EXPIRY_TONE[state]}>{EXPIRY_LABEL[state]}</Badge></td>
                <td class="nowrap"><DateTime value={c.valid_until} relative /></td>
                <td class="nowrap"><DateTime value={c.created_at} /></td>
                <td><code class="fp" title={c.fingerprint}>{c.fingerprint.slice(0, 16)}…</code></td>
                <td class="act">
                  <ActionMenu
                    label={`Actions for credential ${c.name}`}
                    items={[
                      { label: 'Copy fingerprint', onselect: () => void copy(c.fingerprint, 'Fingerprint') },
                      {
                        label: 'Revoke…',
                        tone: 'danger',
                        disabled: !project.canConfigure,
                        hint: project.canConfigure ? undefined : 'Revoking needs the member or owner role',
                        onselect: () => (revokeTarget = c),
                      },
                    ]}
                  />
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if total > PAGE_SIZE}
        <Pagination {offset} limit={PAGE_SIZE} {total} onchange={changePage} label="Credential pages" itemLabel="credentials" disabled={loading} />
      {/if}
    {/if}
  </section>
</div>

<ConfirmModal
  open={revokeTarget !== null}
  tone="danger"
  title="Revoke credential"
  confirmLabel="Revoke credential"
  requireText={revokeNeedsTyping ? (revokeTarget?.name ?? '') : ''}
  requireTextLabel={revokeTarget ? `Type the credential name, ${revokeTarget.name}, to confirm` : undefined}
  loading={revoking}
  onconfirm={confirmRevoke}
  onclose={() => { if (!revoking) revokeTarget = null; }}
>
  {#if revokeTarget}
    <p class="confirm-text">Revoke <strong>{revokeTarget.name}</strong>?</p>
    <p class="confirm-text">Agents using this certificate lose their connection at once and cannot reconnect until they get a new credential. Their protection keeps running on the last configuration, without updates or reporting.</p>
  {/if}
</ConfirmModal>

<style>
  .page { padding: var(--page-top) var(--page-gutter) var(--sp-7); width: 100%; min-width: 0; display: grid; gap: var(--sp-5); align-content: start; }
  .card { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: var(--sp-5); min-width: 0; display: grid; gap: var(--sp-4); }
  h2 { margin: 0; font-size: var(--fs-md); font-weight: var(--fw-semibold); }
  h3 { margin: 0; font-size: var(--fs-base); font-weight: var(--fw-semibold); }
  .count { font-size: var(--fs-sm); color: var(--text-muted); font-weight: 400; margin-left: var(--sp-1); }
  .card-sub { margin: calc(-1 * var(--sp-2)) 0 0; font-size: var(--fs-sm); color: var(--text-secondary); max-width: 76ch; }
  .issue-form { display: grid; gap: var(--sp-3); }
  .fields { display: flex; flex-wrap: wrap; gap: var(--sp-4); align-items: flex-start; }
  .field { display: grid; gap: var(--sp-1); min-width: 0; }
  .field.grow { flex: 1 1 16rem; }
  .field label { font-size: var(--fs-sm); font-weight: var(--fw-medium); }
  .field input {
    width: 100%;
    padding: var(--sp-2) var(--sp-3);
    background: var(--surface-input);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    color: var(--text-primary);
    font-size: var(--fs-base);
  }
  .field input.narrow { width: 8rem; }
  .hint { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
  .binding { display: block; margin-top: calc(var(--sp-1) / 2); font-size: var(--fs-xs); font-weight: normal; color: var(--text-muted); }
  .form-actions { display: flex; justify-content: flex-end; gap: var(--sp-2); }
  .reveal { border: 1px solid var(--border); border-left: 3px solid var(--accent); border-radius: var(--radius); padding: var(--sp-4); display: grid; gap: var(--sp-3); background: var(--bg-secondary); }
  .reveal-head { display: flex; justify-content: space-between; align-items: center; gap: var(--sp-3); flex-wrap: wrap; }
  .meta { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: var(--sp-1) var(--sp-4); margin: 0; font-size: var(--fs-sm); }
  .meta dt { color: var(--text-muted); }
  .meta dd { margin: 0; overflow-wrap: anywhere; }
  .install { display: grid; gap: var(--sp-2); }
  .install-head { display: flex; justify-content: space-between; align-items: center; gap: var(--sp-3); flex-wrap: wrap; }
  .install-head p { margin: 0 auto 0 0; font-size: var(--fs-sm); font-weight: var(--fw-medium); }
  .inline-select { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-xs); color: var(--text-secondary); }
  .command, .pem { margin: 0; padding: var(--sp-3); background: var(--bg-code); border: 1px solid var(--border); border-radius: var(--radius); overflow-x: auto; font-size: var(--fs-xs); line-height: 1.6; font-family: var(--font-mono); }
  .pem { white-space: pre; }
  details summary { cursor: pointer; font-size: var(--fs-sm); color: var(--text-secondary); }
  .pems { display: grid; gap: var(--sp-3); margin-top: var(--sp-3); }
  .pem-label { margin: 0 0 var(--sp-1); font-size: var(--fs-xs); color: var(--text-muted); }
  .list-head { display: flex; justify-content: space-between; align-items: center; gap: var(--sp-3); flex-wrap: wrap; }
  .filters { display: flex; gap: var(--sp-2); flex-wrap: wrap; }
  .chip { border: 1px solid var(--border-strong); background: transparent; color: var(--text-secondary); border-radius: var(--radius); padding: var(--sp-1) var(--sp-3); font-size: var(--fs-sm); cursor: pointer; }
  .chip[aria-pressed='true'] { background: var(--accent-soft); border-color: var(--accent); color: var(--text-primary); }
  .muted { color: var(--text-muted); font-size: var(--fs-sm); margin: 0; }
  .table-wrap { position: relative; overflow-x: auto; min-width: 0; }
  table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
  th, td { text-align: left; padding: var(--sp-3); border-top: 1px solid var(--border); vertical-align: middle; }
  thead th { border-top: 0; font-size: var(--fs-xs); color: var(--text-muted); font-weight: var(--fw-medium); }
  tbody th { font-weight: var(--fw-medium); color: var(--text-primary); overflow-wrap: anywhere; }
  tr.highlight { background: var(--accent-soft); }
  tr.highlight th { box-shadow: inset 3px 0 0 var(--accent); }
  .nowrap { white-space: nowrap; }
  .fp { font-size: var(--fs-xs); color: var(--text-secondary); }
  .act { text-align: right; width: 1%; }
  .confirm-text { margin: 0 0 var(--sp-3); font-size: var(--fs-sm); color: var(--text-secondary); line-height: 1.55; }
  @media (max-width: 640px) {
    .card { padding: var(--sp-4); }
    .meta { grid-template-columns: minmax(0, 1fr); }
  }
</style>
