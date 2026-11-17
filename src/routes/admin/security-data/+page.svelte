<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { base } from '#lib/paths.js';
  import MalwareProviderSettings from '#lib/components/MalwareProviderSettings.svelte';
  import Icon from 'svelte-awesome/components/Icon.svelte';
  import arrowRight from 'svelte-awesome/icons/arrowRight';
  import check from 'svelte-awesome/icons/check';
  import circle from 'svelte-awesome/icons/circle';
  import download from 'svelte-awesome/icons/download';
  import refresh from 'svelte-awesome/icons/refresh';
  import times from 'svelte-awesome/icons/times';
  import { getSecurityDataStatus, streamSecurityDataUpdate, type SecurityDataProgress, type SecurityDataStatus } from '#lib/api.js';
  import { EMPTY, formatBytes } from '#lib/format.js';
  import { categoryTone } from '#lib/tone.js';
  import { DateTime } from '#lib/components/ui/index.js';
  import PageHeader from '#lib/components/ui/PageHeader.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Alert from '#lib/components/ui/Alert.svelte';
  import DataTable from '#lib/components/ui/DataTable.svelte';
  import Spinner from '#lib/components/ui/Spinner.svelte';
  import ConfirmModal from '#lib/components/ui/ConfirmModal.svelte';
  import type { DataTableColumn } from '#lib/components/ui/types.js';
  import { toast } from '#lib/stores/toast.js';


  type ProgressType = 'start' | 'downloading' | 'done' | 'skipped' | 'error' | 'log' | 'agents' | 'complete';
  interface ProgressEvent {
    type: ProgressType;
    component?: string;
    message: string;
  }

  interface Location {
    name: string;
    kind: 'cp' | 'waf' | 'host';
    exists: boolean;
    size_bytes: number;
    modified_at?: string;
    path?: string;
  }
  interface ComponentRow {
    component: string;
    label: string;
    usedBy: ('cp' | 'waf' | 'host')[];
    installed: boolean;
    size: number;
    updated?: string;
    locations: Location[];
  }

  // Canonical order of the components.
  const CANONICAL = ['geoip-country', 'geoip-city', 'geoip-asn', 'firehol-level1', 'firehol-level2', 'ja4', 'ua', 'malware'];
  const KIND_LABEL: Record<Location['kind'], string> = { cp: 'Control plane', waf: 'WAF agent', host: 'Host agent' };
  const KINDS = ['cp', 'waf', 'host'];
  const PROGRESS_TYPES: ProgressType[] = ['start', 'downloading', 'done', 'skipped', 'error', 'log', 'agents', 'complete'];

  let status = $state<SecurityDataStatus>({ components: [], agent_reports: [] });
  let loading = $state(true);
  let error = $state('');

  let running = $state(false);
  let progressLog = $state<ProgressEvent[]>([]);
  let progressDone = $state(false);
  let runError = $state('');
  let forceUpdate = $state(false);
  let pendingForce = $state<{ componentIds?: string[] } | null>(null);
  let malwareConfigured = $state(false);
  let expandedKeys = $state<Array<string | number>>([]);

  let updateController: AbortController | undefined;
  onDestroy(() => updateController?.abort());

  async function loadStatus() {
    loading = true;
    error = '';
    const res = await getSecurityDataStatus();
    loading = false;
    if (res.error || !res.data) {
      error = res.error?.error ?? 'The security data status could not be loaded.';
      return;
    }
    status = { components: res.data.components ?? [], agent_reports: res.data.agent_reports ?? [] };
  }

  onMount(loadStatus);

  const rows = $derived.by<ComponentRow[]>(() => {
    const cpMap = new Map(status.components.map((c) => [c.component, c]));
    const agentsByComp = new Map<string, Location[]>();
    for (const report of status.agent_reports) {
      const kind: Location['kind'] = (report.agent_kind || '').toLowerCase() === 'host' ? 'host' : 'waf';
      for (const comp of report.components ?? []) {
        const list = agentsByComp.get(comp.component) ?? [];
        list.push({ name: report.agent_name || report.credential_id, kind, exists: comp.exists, size_bytes: comp.size_bytes, modified_at: comp.modified_at, path: comp.path });
        agentsByComp.set(comp.component, list);
      }
    }
    const out: ComponentRow[] = [];
    for (const key of CANONICAL) {
      const cp = cpMap.get(key);
      const agents = agentsByComp.get(key) ?? [];
      if (!cp && agents.length === 0) continue;
      const usedBy: ComponentRow['usedBy'] = [];
      // The control plane / WAF badges follow the component's profile; the
      // host badge appears only when a host agent actually reports it.
      if (cp && (cp.profile === 'both' || cp.profile === 'control-plane')) usedBy.push('cp');
      if (cp && (cp.profile === 'both' || cp.profile === 'agent')) usedBy.push('waf');
      if (agents.some((a) => a.kind === 'host')) usedBy.push('host');
      const locations: Location[] = [];
      if (cp) locations.push({ name: usedBy.includes('cp') ? 'Control plane' : 'Stored on the control plane', kind: 'cp', exists: cp.exists, size_bytes: cp.size_bytes, modified_at: cp.modified_at, path: cp.path });
      locations.push(...agents);
      const dates = locations.map((l) => l.modified_at).filter(Boolean) as string[];
      out.push({
        component: key,
        label: cp?.label ?? agents[0]?.name ?? key,
        usedBy,
        installed: locations.some((l) => l.exists),
        size: Math.max(0, ...locations.map((l) => l.size_bytes ?? 0)),
        updated: dates.sort().at(-1),
        locations,
      });
    }
    return out;
  });

  const installedCount = $derived(rows.filter((r) => r.installed).length);

  function startUpdate(componentIds?: string[]) {
    if (running) return;
    if (forceUpdate) {
      pendingForce = { componentIds };
      return;
    }
    void runUpdate(componentIds);
  }

  async function runUpdate(componentIds?: string[], force = forceUpdate) {
    if (running) return;
    running = true;
    progressDone = false;
    progressLog = [];
    runError = '';
    let sawError = false;
    updateController = new AbortController();
    const selected = componentIds ?? CANONICAL.filter((id) => id !== 'malware' || malwareConfigured);
    try {
      await streamSecurityDataUpdate(
        selected,
        force,
        (event: string, data: SecurityDataProgress) => {
          if (event === 'complete') {
            progressDone = true;
            if (data.ok === false || (data.failed ?? 0) > 0) {
              sawError = true;
              runError = 'Some updates failed. Review the errors below; the previous valid malware database is kept.';
            }
          }
          if (event === 'error') sawError = true;
          if (!PROGRESS_TYPES.includes(event as ProgressType)) return;
          const message =
            data.message ??
            (event === 'start'
              ? `Starting the update of ${data.total ?? selected.length} component(s)…`
              : event === 'complete'
                ? 'The control plane finished. Reload the status to check the agents.'
                : '');
          progressLog = [...progressLog, { type: event as ProgressType, component: data.component, message }];
        },
        updateController.signal
      );
    } catch (cause) {
      if (!updateController.signal.aborted) {
        sawError = true;
        runError = cause instanceof Error ? cause.message : 'The update failed.';
      }
    } finally {
      running = false;
      if (!updateController.signal.aborted) {
        if (sawError || runError) toast.error('The update finished with errors.');
        else toast.success('The update finished.');
        await loadStatus();
      }
    }
  }

  function eventIcon(type: ProgressType) {
    if (type === 'done' || type === 'complete') return check;
    if (type === 'error') return times;
    if (type === 'skipped') return refresh;
    if (type === 'downloading') return download;
    if (type === 'agents') return arrowRight;
    return circle;
  }

  const columns: DataTableColumn<ComponentRow>[] = [
    { key: 'label', label: 'Component', rowHeader: true },
    { key: 'usedBy', label: 'Used by', nowrap: true },
    { key: 'installed', label: 'Status', nowrap: true },
    { key: 'size', label: 'Size', align: 'right', nowrap: true },
    { key: 'updated', label: 'Last updated', nowrap: true },
  ];
</script>

<div class="admin-page">
  <PageHeader title="Security data" subtitle="Threat intelligence and GeoIP databases used by the control plane and the agents, and their update runs." />

  {#if error}
    <Alert tone="error" message={error}>
      {#snippet actions()}<Button variant="secondary" size="sm" onclick={loadStatus}>Retry</Button>{/snippet}
    </Alert>
  {/if}

  <MalwareProviderSettings updating={running} onupdate={() => runUpdate(['malware'], true)} onconfigured={(configured) => (malwareConfigured = configured)} />

  <section class="toolbar" aria-label="Update options">
    <label class="force">
      <input type="checkbox" bind:checked={forceUpdate} disabled={running} aria-describedby="force-hint" />
      <span>Force re-download</span>
    </label>
    <span class="hint" id="force-hint">Downloads again even when the current copy is up to date.</span>
    <div class="toolbar-actions">
      <Button variant="secondary" disabled={loading || running} onclick={loadStatus}>Reload status</Button>
      <Button variant="primary" loading={running} onclick={() => startUpdate()}>{running ? 'Updating…' : 'Update all'}</Button>
    </div>
    {#if !malwareConfigured}
      <p class="hint wide">Malware hashes are left out of Update all until a provider key is configured above.</p>
    {/if}
  </section>

  <section class="components" aria-labelledby="components-heading">
    <div class="components-head">
      <h2 id="components-heading">Components</h2>
      <span class="hint">{installedCount} of {rows.length} installed</span>
      <span class="legend" aria-label="Legend">
        {#each KINDS as kind (kind)}
          <Badge tone={categoryTone(kind, KINDS)}>{KIND_LABEL[kind as Location['kind']]}</Badge>
        {/each}
      </span>
    </div>
    <DataTable
      {rows}
      {columns}
      rowKey={(r) => r.component}
      caption="Security data components"
      manualSort
      {loading}
      loadingLabel="Loading the security data status…"
      emptyTitle="No components reported"
      bind:expandedKeys
      expandLabel={(r) => `Where ${r.label} is installed`}
    >
      {#snippet cell(row, column)}
        {#if column.key === 'label'}
          {row.label}
        {:else if column.key === 'usedBy'}
          <span class="badges">
            {#each row.usedBy as kind (kind)}
              <Badge tone={categoryTone(kind, KINDS)}>{KIND_LABEL[kind]}</Badge>
            {/each}
          </span>
        {:else if column.key === 'installed'}
          <Badge tone={row.installed ? 'success' : 'warning'}>{row.installed ? 'Installed' : 'Not installed'}</Badge>
        {:else if column.key === 'size'}
          {row.size > 0 ? formatBytes(row.size) : EMPTY}
        {:else if column.key === 'updated'}
          <DateTime value={row.updated} />
        {/if}
      {/snippet}
      {#snippet actions(row)}
        <Button
          variant="secondary"
          size="sm"
          disabled={running || (row.component === 'malware' && !malwareConfigured)}
          aria-label={`${row.installed ? 'Update' : 'Install'} ${row.label}`}
          onclick={() => startUpdate([row.component])}
        >
          {row.installed ? 'Update' : 'Install'}
        </Button>
      {/snippet}
      {#snippet expanded(row)}
        <ul class="locations">
          {#each row.locations as loc, i (i)}
            <li>
              <Badge tone={categoryTone(loc.kind, KINDS)}>{KIND_LABEL[loc.kind]}</Badge>
              {#if loc.kind !== 'cp'}<span class="mono">{loc.name}</span>{/if}
              <span class={loc.exists ? 'ok' : 'miss'}>{loc.exists ? 'Installed' : 'Not installed'}</span>
              <span class="mono path">{loc.path || EMPTY}</span>
              {#if loc.modified_at}<span class="hint">updated <DateTime value={loc.modified_at} /></span>{/if}
            </li>
          {/each}
        </ul>
      {/snippet}
    </DataTable>
  </section>

  <section class="sources" aria-labelledby="sources-heading">
    <h2 id="sources-heading">Sources and credits</h2>
    <p>
      The IP reputation lists are downloaded straight from their providers to protect this server. They may not be
      resold, and WAFio does not mirror or serve them. Agents refresh them at most once every 24 hours.
    </p>
    <ul>
      <li>
        <strong>GeoIP databases:</strong> IP geolocation data by
        <a href="https://db-ip.com" target="_blank" rel="noopener noreferrer">DB-IP.com<span class="sr-only"> (opens in a new tab)</span></a>,
        licensed CC BY 4.0. MaxMind GeoLite2 is used only when you supply your own license key.
      </li>
      <li>
        <strong>IP reputation (FireHOL level 1 and 2):</strong> built from the Spamhaus DROP and EDROP lists, a service of
        The Spamhaus Project; DShield from the SANS Internet Storm Center (CC BY-NC-SA 4.0; use it to protect your own
        network and do not resell it); Feodo Tracker from abuse.ch (CC0); blocklist.de; GreenSnow; and the Team Cymru fullbogons.
      </li>
      <li>
        <strong>Fingerprints and bot lists:</strong> JA3 lists from Salesforce (BSD-3-Clause) and abuse.ch SSLBL (CC0), bad user
        agents from nginx-ultimate-bad-bot-blocker (MIT), and the JA4 format by FoxIO (BSD-3-Clause).
      </li>
      <li><strong>Malware hashes:</strong> MalwareBazaar by abuse.ch, downloaded with your own auth key.</li>
    </ul>
    <p class="hint">
      License texts for the software and data in this product:
      <a href="{base}/NOTICES.txt" target="_blank" rel="noopener noreferrer">NOTICES.txt<span class="sr-only"> (opens in a new tab)</span></a>.
    </p>
  </section>

  {#if progressLog.length > 0 || running}
    <section class="progress" aria-labelledby="progress-heading" aria-busy={running}>
      <div class="progress-head">
        <h2 id="progress-heading">Update progress</h2>
        {#if running}
          <Spinner size="sm" tone="accent" label="Running" />
        {:else if progressDone}
          <Badge tone={runError ? 'danger' : 'success'}>{runError ? 'Finished with errors' : 'Finished'}</Badge>
        {/if}
      </div>
      {#if runError}<Alert tone="error" message={runError} compact />{/if}
      <ol class="log" aria-live="polite">
        {#each progressLog as evt, i (i)}
          <li class="log-row type-{evt.type}">
            <span class="log-icon" aria-hidden="true"><Icon data={eventIcon(evt.type)} scale={0.75} /></span>
            <span class="sr-only">{evt.type}:</span>
            {#if evt.component}<span class="log-comp">{evt.component}</span>{/if}
            <span class="log-msg">{evt.message}</span>
          </li>
        {/each}
      </ol>
    </section>
  {/if}
</div>

<ConfirmModal
  open={pendingForce !== null}
  tone="warning"
  title="Force re-download"
  message="Download and replace the selected security datasets from upstream, even where the current copy is up to date?"
  confirmLabel="Re-download"
  loading={running}
  onconfirm={() => {
    const ids = pendingForce?.componentIds;
    pendingForce = null;
    void runUpdate(ids);
  }}
  onclose={() => (pendingForce = null)}
/>

<style>
  .admin-page {
    padding: var(--page-top, 32px) var(--page-gutter, 24px) 48px;
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: var(--sp-5);
  }
  .admin-page :global(.page-header) { margin-bottom: 0; }
  h2 { margin: 0; font-size: var(--fs-md); font-weight: var(--fw-semibold); color: var(--text-primary); }
  .hint { font-size: var(--fs-xs); color: var(--text-muted); }

  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--sp-2) var(--sp-4);
    padding: var(--sp-3) var(--sp-4);
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
  }
  .toolbar .wide { flex-basis: 100%; margin: 0; }
  .force { display: inline-flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm); color: var(--text-primary); cursor: pointer; }
  .force input { width: 16px; height: 16px; accent-color: var(--accent); }
  .toolbar-actions { display: flex; gap: var(--sp-2); margin-left: auto; }

  .components { display: flex; flex-direction: column; gap: var(--sp-2); min-width: 0; }
  .components-head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2) var(--sp-4); }
  .legend, .badges { display: inline-flex; flex-wrap: wrap; gap: var(--sp-1); }
  .legend { margin-left: auto; }

  .locations { list-style: none; margin: 0; padding: var(--sp-2) 0; display: flex; flex-direction: column; gap: var(--sp-2); }
  .locations li { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm); }
  .mono { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--text-secondary); }
  .path { flex: 1 1 240px; min-width: 0; overflow-wrap: anywhere; color: var(--text-muted); }
  .ok { color: var(--success); font-size: var(--fs-xs); }
  .miss { color: var(--warning); font-size: var(--fs-xs); }

  .sources { display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-3) var(--sp-4); background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-lg); font-size: var(--fs-sm); color: var(--text-secondary); }
  .sources p { margin: 0; max-width: 72ch; }
  .sources ul { margin: 0; padding-left: var(--sp-5); display: flex; flex-direction: column; gap: var(--sp-1); max-width: 72ch; }
  .sources strong { color: var(--text-primary); font-weight: var(--fw-semibold); }

  .progress { display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-3) var(--sp-4); background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-lg); }
  .progress-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); }
  .log { list-style: none; margin: 0; padding: 0; max-height: 360px; overflow-y: auto; display: flex; flex-direction: column; gap: var(--sp-1); }
  .log-row { display: flex; align-items: baseline; gap: var(--sp-2); font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--text-secondary); }
  .log-icon { width: 14px; flex-shrink: 0; color: var(--text-muted); }
  .log-comp { color: var(--text-primary); font-weight: var(--fw-semibold); }
  .log-msg { min-width: 0; overflow-wrap: anywhere; }
  .type-done .log-icon, .type-complete .log-icon { color: var(--success); }
  .type-error .log-icon, .type-error .log-msg { color: var(--danger); }
  .type-downloading .log-icon, .type-agents .log-icon { color: var(--info); }
  .type-skipped .log-msg { color: var(--text-muted); }

  @media (max-width: 700px) {
    .toolbar-actions { margin-left: 0; width: 100%; }
    .legend { margin-left: 0; }
  }
</style>
