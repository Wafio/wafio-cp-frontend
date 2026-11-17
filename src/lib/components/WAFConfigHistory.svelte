<!--
  WAFConfigHistory: saved revisions of a WAF policy (project defaults, or an
  application override when `appId` is set), with a redacted preview, the
  scoring changes to the newest revision on the page, and restore.
  The server redacts everything except scoring settings in these previews.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { configChanges } from '#lib/waf-history.js';
  import { getWAFConfigHistory, rollbackWAFConfig, getProjectConfigHistory, rollbackProjectConfig, type WAFConfigHistoryEntry } from '#lib/api.js';
  import ConfirmModal from '#lib/components/ui/ConfirmModal.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import DateTime from '#lib/components/ui/DateTime.svelte';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Alert from '#lib/components/ui/Alert.svelte';
  import Spinner from '#lib/components/ui/Spinner.svelte';
  import Pagination from '#lib/components/ui/Pagination.svelte';
  import { toast } from '#lib/stores/toast.js';

  let {
    projectId,
    appId,
    currentRevision,
    canConfigure = false,
    unsavedChanges = false,
    onChanged
  }: {
    projectId: string;
    appId?: string;
    currentRevision: number;
    canConfigure?: boolean;
    /** The policy editor above holds unsaved edits (a restore reloads it). */
    unsavedChanges?: boolean;
    onChanged: () => Promise<void>;
  } = $props();

  const PAGE_SIZE = 20;

  let rows: WAFConfigHistoryEntry[] = $state([]);
  let selected: WAFConfigHistoryEntry | null = $state(null);
  let loading = $state(false);
  let restoring = $state(false);
  let confirmOpen = $state(false);
  let error = $state('');
  let offset = $state(0);
  let total = $state(0);
  let version = 0;
  let restoreVersion = 0;
  let loadedScope = $state('');
  const scope = $derived(`${projectId}/${appId ?? ''}/${currentRevision}`);
  const ready = $derived(!loading && !error && loadedScope === scope);

  async function load() {
    const token = ++version;
    const requestedScope = scope;
    const targetProject = projectId;
    const targetApp = appId;
    const targetOffset = offset;
    loading = true;
    error = '';
    rows = [];
    selected = null;
    total = 0;
    loadedScope = '';
    const result = await (targetApp ? getWAFConfigHistory(targetProject, targetApp, targetOffset) : getProjectConfigHistory(targetProject, targetOffset));
    if (token !== version || requestedScope !== scope) return;
    loading = false;
    if (result.error) {
      error = result.error.error || 'Could not load the configuration history.';
      return;
    }
    rows = result.data?.history ?? [];
    total = result.data?.total ?? 0;
    loadedScope = requestedScope;
  }

  $effect(() => {
    const target = scope;
    if (target) {
      untrack(() => {
        offset = 0;
        ++restoreVersion;
        restoring = false;
        confirmOpen = false;
        void load();
      });
    }
    return () => {
      version++;
    };
  });

  function goToPage(next: number) {
    offset = next;
    void load();
  }

  async function restore() {
    if (!selected || !canConfigure || !ready || restoring || selected.revision === currentRevision) return;
    const token = version;
    const requestedScope = scope;
    const restoreToken = ++restoreVersion;
    const targetProject = projectId;
    const targetApp = appId;
    const revision = selected.revision;
    const expected = currentRevision;
    const notifyChanged = onChanged;
    restoring = true;
    error = '';
    try {
      const result = await (targetApp ? rollbackWAFConfig(targetProject, targetApp, revision, expected) : rollbackProjectConfig(targetProject, revision, expected));
      if (token !== version || requestedScope !== scope) return;
      if (result.error) {
        error = result.error.code === 'CONFIG_CONFLICT'
          ? 'The policy changed since this history was loaded. Reload the history and the policy, then try again.'
          : result.error.error || 'Could not restore the configuration.';
        toast.error(error, 'Restore failed');
        return;
      }
      toast.success(`Revision ${revision} restored as a new revision. Agents apply it on their next configuration update.`, 'Configuration restored');
      await notifyChanged();
      if (token === version && requestedScope === scope) await load();
    } catch {
      if (token === version && requestedScope === scope) {
        error = 'Could not restore the configuration. Reload the history before retrying.';
        toast.error(error, 'Restore failed');
      }
    } finally {
      if (restoreToken === restoreVersion && requestedScope === scope) {
        restoring = false;
        confirmOpen = false;
      }
    }
  }

  const newest = $derived(rows[0]);
  const changes = $derived(selected && newest && newest.revision !== selected.revision ? configChanges(selected.rules_json, newest.rules_json) : []);
  const show = (value: unknown) => (value === undefined ? '(absent)' : JSON.stringify(value));
</script>

<section class="wh" aria-labelledby="wh-title">
  <div class="wh-head">
    <div>
      <h3 id="wh-title">Configuration history</h3>
      <p>Current revision {currentRevision}. Previews show scoring settings only; other fields are redacted. Restoring saves the chosen revision as a new one; agents apply it asynchronously.</p>
    </div>
    {#if error}<Button variant="secondary" size="sm" disabled={loading || restoring} onclick={() => void load()}>Reload history</Button>{/if}
  </div>

  {#if error}<Alert tone="error" compact message={error} />{/if}

  {#if loading}
    <Spinner label="Loading history" size="sm" />
  {:else if !error && rows.length === 0}
    <p class="wh-empty">No configuration changes recorded yet.</p>
  {:else if rows.length > 0}
    <div class="wh-table-wrap">
      <table class="wh-table">
        <caption class="sr-only">Saved revisions</caption>
        <thead><tr><th scope="col">Revision</th><th scope="col">Saved</th><th scope="col">Type</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>
          {#each rows as row (row.revision)}
            <tr class:is-selected={selected?.revision === row.revision}>
              <th scope="row">{row.revision}{#if row.revision === currentRevision} <Badge tone="info">Current</Badge>{/if}</th>
              <td><DateTime value={row.created_at} relative /></td>
              <td>{appId ? (row.inherited ? 'Inherits project defaults' : 'Application override') : 'Project defaults'}</td>
              <td class="wh-action">
                <Button variant={selected?.revision === row.revision ? 'secondary' : 'ghost'} size="sm" aria-pressed={selected?.revision === row.revision} disabled={restoring || !ready} onclick={() => (selected = selected?.revision === row.revision ? null : row)}>
                  {selected?.revision === row.revision ? 'Hide' : 'View'}<span class="sr-only"> revision {row.revision}</span>
                </Button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  {#if selected}
    <div class="wh-detail" aria-live="polite">
      <div class="wh-detail-head">
        <h4>Revision {selected.revision}</h4>
        {#if canConfigure}
          <Button variant="warning" size="sm" onclick={() => (confirmOpen = true)} disabled={restoring || !ready || selected.revision === currentRevision} loading={restoring}>
            {selected.revision === currentRevision ? 'Current revision' : `Restore revision ${selected.revision}`}
          </Button>
        {/if}
      </div>
      {#if appId}
        {#if selected.project_revision != null}
          <p>Captured project defaults: revision {selected.project_revision}. This records the inputs at save time, not agent acknowledgement. Restoring an inherited revision follows the current project defaults.</p>
        {:else}
          <p>Project defaults were not captured for this older revision.</p>
        {/if}
      {/if}
      {#if newest && newest.revision !== selected.revision}
        <h5>Scoring changes from revision {selected.revision} to {newest.revision}, the newest on this page</h5>
        {#if changes.length === 0}
          <p>No scoring differences. Redacted fields may still differ.</p>
        {:else}
          <ul class="wh-changes">
            {#each changes as change (change.path)}
              <li><code>{change.path}</code>: {show(change.before)} → {show(change.after)}</li>
            {/each}
          </ul>
          <p>Redacted fields may differ as well.</p>
        {/if}
      {/if}
      <details>
        <summary>Redacted preview of revision {selected.revision}</summary>
        <pre>{JSON.stringify(selected.rules_json, null, 2)}</pre>
      </details>
      {#if appId && selected.project_revision != null}
        <details>
          <summary>Captured project defaults (revision {selected.project_revision})</summary>
          <pre>{JSON.stringify(selected.project_rules_json, null, 2)}</pre>
        </details>
      {/if}
      {#if newest && newest.revision !== selected.revision}
        <details>
          <summary>Redacted preview of the newest revision on this page ({newest.revision})</summary>
          <pre>{JSON.stringify(newest.rules_json, null, 2)}</pre>
        </details>
      {/if}
    </div>
  {/if}

  {#if total > PAGE_SIZE}
    <Pagination offset={offset} limit={PAGE_SIZE} {total} itemLabel="revisions" onchange={goToPage} disabled={loading || restoring} label="Configuration history pages" />
  {/if}
</section>

<ConfirmModal
  open={confirmOpen}
  tone="warning"
  title="Restore revision {selected?.revision ?? ''}?"
  message={`The current policy is kept in the history and revision ${selected?.revision ?? ''} is saved as a new revision.${unsavedChanges ? ' Your unsaved edits in the policy editor are discarded.' : ''}`}
  confirmLabel="Restore"
  loading={restoring}
  onconfirm={() => void restore()}
  onclose={() => (confirmOpen = false)}
/>

<style>
  .wh { display: flex; flex-direction: column; gap: var(--sp-4); min-width: 0; margin-top: var(--sp-5); padding: var(--sp-5); background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-lg); color: var(--text-primary); }
  .wh-head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: var(--sp-3); }
  h3 { margin: 0; font-size: var(--fs-md); font-weight: var(--fw-semibold); }
  h4 { margin: 0; font-size: var(--fs-base); font-weight: var(--fw-semibold); }
  h5 { margin: var(--sp-2) 0 0; font-size: var(--fs-sm); font-weight: var(--fw-semibold); color: var(--text-secondary); }
  p { margin: var(--sp-1) 0 0; color: var(--text-secondary); font-size: var(--fs-sm); line-height: 1.6; overflow-wrap: anywhere; max-width: 80ch; }
  .wh-empty { color: var(--text-muted); }
  .wh-table-wrap { position: relative; min-width: 0; overflow-x: auto; border: 1px solid var(--border); border-radius: var(--radius-lg); }
  .wh-table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
  .wh-table th, .wh-table td { padding: var(--sp-2) var(--sp-3); border-bottom: 1px solid var(--border); text-align: left; vertical-align: middle; }
  .wh-table thead th { font-size: var(--fs-xs); font-weight: var(--fw-semibold); color: var(--text-muted); background: var(--bg-secondary); white-space: nowrap; }
  .wh-table tbody tr:last-child > * { border-bottom: 0; }
  .wh-table tbody th { font-weight: var(--fw-medium); color: var(--text-primary); white-space: nowrap; }
  .wh-table tr.is-selected > * { background: var(--accent-soft); }
  .wh-action { text-align: right; white-space: nowrap; }
  .wh-detail { display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-4); border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-secondary); min-width: 0; }
  .wh-detail-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--sp-2); }
  .wh-changes { margin: var(--sp-1) 0 0; padding-left: var(--sp-5); font-size: var(--fs-sm); color: var(--text-secondary); display: grid; gap: var(--sp-1); overflow-wrap: anywhere; }
  .wh-changes code { font-family: var(--font-mono); color: var(--text-primary); }
  details { min-width: 0; }
  summary { cursor: pointer; font-size: var(--fs-sm); color: var(--accent); padding: var(--sp-1) 0; }
  pre { min-width: 0; max-width: 100%; overflow: auto; max-height: 18rem; margin: var(--sp-2) 0 0; padding: var(--sp-3); background: var(--bg-code); border: 1px solid var(--border); border-radius: var(--radius); font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--text-primary); }
  @media (max-width: 640px) { .wh { padding: var(--sp-4); } }
</style>
