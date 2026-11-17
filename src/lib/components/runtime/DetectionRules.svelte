<!--
  DetectionRules: the host's ingest rules (suppress, escalate, downgrade,
  tag) in priority order. Row details open with the keyboard-operable
  disclosure. Built-in rules can be disabled, not edited or deleted.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { deleteDetectionRule, listDetectionRules, toggleDetectionRule, type DetectionRule } from '#lib/api.js';
  import { formatNumber } from '#lib/format.js';
  import { createLifecycle, type HostScope } from '#lib/host-scope.svelte.js';
  import { categoryTone, severityTone } from '#lib/tone.js';
  import { toast } from '#lib/stores/toast.js';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import ConfirmModal from '#lib/components/ui/ConfirmModal.svelte';
  import DataTable from '#lib/components/ui/DataTable.svelte';
  import DateTime from '#lib/components/ui/DateTime.svelte';
  import type { DataTableColumn } from '#lib/components/ui/types.js';
  import CopyRuntimeFlow from '#lib/components/hosts/CopyRuntimeFlow.svelte';
  import { DETECTION_ACTIONS, DETECTION_ACTION_VALUES, fieldLabel, formatConditions, opLabel, severityLevelName } from './detection';
  import { loadAllPages } from './pages';

  let {
    projectId,
    scope,
    canConfigure = false,
    version = 0,
    onedit,
  }: {
    projectId: string;
    scope: HostScope;
    canConfigure?: boolean;
    version?: number;
    /** Opens the rule editor (null = new rule). */
    onedit: (rule: DetectionRule | null) => void;
  } = $props();

  const life = createLifecycle();
  // The view is keyed per host: it lives within one scope epoch.
  const hostEpoch = untrack(() => scope.epoch);
  const noPermission = 'Requires the member or owner role';

  let rules = $state.raw<DetectionRule[]>([]);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let total = $state(0);
  let toggling = $state<string | null>(null);
  let confirmDelete = $state<DetectionRule | null>(null);
  let deleting = $state(false);
  /** Item copied to other hosts ("Copy to hosts…"). */
  let copyIds = $state<(string | number)[] | null>(null);
  let expandedKeys = $state<Array<string | number>>([]);

  function stale(): boolean {
    return life.destroyed || scope.isStale(hostEpoch);
  }

  async function load() {
    loading = true;
    // The server orders by priority and pages at 100: follow every page.
    const result = await loadAllPages<DetectionRule>(
      async (limit, offset) => {
        const res = await listDetectionRules(projectId, scope.hostId, { limit, offset });
        return { data: res.data ? { rows: res.data.rules ?? [], total: res.data.total } : null, error: res.error?.error ?? (res.data ? null : 'Detection rules could not be loaded.') };
      },
      { isStale: stale },
    );
    if (!result) return;
    loading = false;
    if (result.error) {
      error = result.error;
      return;
    }
    error = null;
    rules = [...result.rows].sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
    total = result.total;
  }

  $effect(() => {
    void version;
    untrack(() => void load());
  });

  async function toggle(rule: DetectionRule) {
    if (!canConfigure) return;
    toggling = rule.id;
    const res = await toggleDetectionRule(projectId, scope.hostId, rule.id);
    if (stale()) return;
    toggling = null;
    if (res.error) {
      toast.error(res.error.error || 'The rule could not be updated.', 'Rule not changed');
      return;
    }
    toast.success(`Rule "${rule.name}" ${rule.enabled ? 'disabled' : 'enabled'}`, 'Detection rule updated');
    await load();
  }

  async function doDelete() {
    const rule = confirmDelete;
    if (!rule || !canConfigure || rule.built_in) return;
    deleting = true;
    const res = await deleteDetectionRule(projectId, scope.hostId, rule.id);
    if (stale()) return;
    deleting = false;
    if (res.error) {
      toast.error(res.error.code === 'BUILTIN_RULE' ? 'Built-in rules cannot be deleted; disable them instead.' : res.error.error || 'The rule could not be deleted.', 'Rule not deleted');
      return;
    }
    confirmDelete = null;
    toast.success(`Rule "${rule.name}" deleted`, 'Detection rule deleted');
    await load();
  }

  const counts = $derived(DETECTION_ACTIONS.map((a) => ({ ...a, count: rules.filter((r) => r.action === a.value).length })));

  const columns: DataTableColumn<DetectionRule>[] = [
    { key: 'priority', label: 'Priority', align: 'right', width: '5rem' },
    { key: 'name', label: 'Rule', rowHeader: true },
    { key: 'action', label: 'Action', nowrap: true },
    { key: 'conditions', label: 'Conditions' },
    { key: 'hits', label: 'Hits', align: 'right', nowrap: true },
    { key: 'status', label: 'Status', nowrap: true },
  ];
</script>

<section class="section" aria-labelledby="dr-title">
  <div class="head">
    <div>
      <h2 id="dr-title" class="section-title">Detection rules</h2>
      <p class="caption">
        Evaluated when events arrive from this host, lowest priority number first; all conditions of a rule must match.
        {#each counts as item, i (item.value)}{i ? ' · ' : ''}{formatNumber(item.count)} {item.label.toLowerCase()}{/each}.
      </p>
    </div>
    <Button variant="primary" size="sm" disabled={!canConfigure} title={canConfigure ? undefined : noPermission} onclick={() => onedit(null)}>New rule</Button>
  </div>

  {#if total > rules.length}<p class="caption">Showing the first {formatNumber(rules.length)} of {formatNumber(total)} rules (lowest priority numbers first).</p>{/if}

  <DataTable
    rows={rules}
    {columns}
    rowKey={(r) => r.id}
    caption="Detection rules"
    itemLabel="rules"
    pageSize={25}
    loading={loading && rules.length === 0}
    {error}
    onretry={load}
    bind:expandedKeys
    expandLabel={(r) => `Details of ${r.name}`}
    rowClass={(r) => (r.enabled ? undefined : 'is-disabled')}
    emptyTitle="No detection rules"
    emptyMessage="Rules suppress known-good activity, raise or lower severity, or tag events as they arrive."
  >
    {#snippet cell(rule, column)}
      {#if column.key === 'priority'}
        <span class="num">{rule.priority}</span>
      {:else if column.key === 'name'}
        <span class="name">{rule.name}</span>
        {#if rule.built_in}<Badge tone="neutral" title="Seeded with the project; disable only">Built-in</Badge>{/if}
        {#if rule.tags?.length}<span class="muted"> · {rule.tags.join(', ')}</span>{/if}
      {:else if column.key === 'action'}
        <Badge tone={categoryTone(rule.action, DETECTION_ACTION_VALUES)}>{DETECTION_ACTIONS.find((a) => a.value === rule.action)?.label ?? rule.action}</Badge>
        {#if rule.severity_override != null && (rule.action === 'escalate' || rule.action === 'downgrade')}
          <span class="muted">to</span> <Badge tone={severityTone(rule.severity_override)}>{severityLevelName(rule.severity_override)}</Badge>
        {/if}
      {:else if column.key === 'conditions'}
        <span class="conditions" title={formatConditions(rule.conditions)}>{formatConditions(rule.conditions)}</span>
      {:else if column.key === 'hits'}
        <span class="num">{formatNumber(rule.hit_count ?? 0)}</span>
        {#if rule.last_hit_at}<span class="muted block">last <DateTime value={rule.last_hit_at} relative /></span>{/if}
      {:else if column.key === 'status'}
        <label class="switch" title={canConfigure ? (rule.enabled ? 'Disable this rule' : 'Enable this rule') : noPermission}>
          <input type="checkbox" role="switch" checked={rule.enabled} disabled={!canConfigure || toggling === rule.id} aria-label={`${rule.name} enabled`} onclick={(e) => { e.preventDefault(); void toggle(rule); }} />
          <span>{rule.enabled ? 'Enabled' : 'Disabled'}</span>
        </label>
      {/if}
    {/snippet}
    {#snippet actions(rule)}
      {#if !rule.built_in}
        <Button variant="ghost" size="sm" aria-label={`${canConfigure ? 'Edit' : 'View'} ${rule.name}`} onclick={() => onedit(rule)}>{canConfigure ? 'Edit' : 'View'}</Button>
        <Button variant="ghost" size="sm" disabled={!canConfigure} title={canConfigure ? undefined : noPermission} aria-label={`Copy ${rule.name} to other hosts`} onclick={() => (copyIds = [rule.id])}>Copy to hosts…</Button>
        <Button variant="ghost" size="sm" disabled={!canConfigure} title={canConfigure ? undefined : noPermission} aria-label={`Delete ${rule.name}`} onclick={() => (confirmDelete = rule)}>Delete…</Button>
      {/if}
    {/snippet}
    {#snippet expanded(rule)}
      <div class="detail">
        {#if rule.description}<p>{rule.description}</p>{/if}
        <dl>
          {#each rule.conditions as condition, i (i)}
            <div><dt>{fieldLabel(condition.field)}</dt><dd><span class="muted">{opLabel(condition.op)}</span> <code>{Array.isArray(condition.value) ? condition.value.join(', ') : String(condition.value)}</code></dd></div>
          {/each}
          <div><dt>Type</dt><dd>{rule.built_in ? 'Built-in (disable only)' : 'Custom'}</dd></div>
          <div><dt>Created</dt><dd><DateTime value={rule.created_at} /></dd></div>
          <div><dt>Updated</dt><dd><DateTime value={rule.updated_at} /></dd></div>
          <div><dt>Last hit</dt><dd><DateTime value={rule.last_hit_at} relative /></dd></div>
        </dl>
      </div>
    {/snippet}
  </DataTable>
</section>

<ConfirmModal
  open={confirmDelete !== null}
  title="Delete detection rule?"
  message={confirmDelete ? `"${confirmDelete.name}" stops applying to new events from this host. Events it suppressed before stay dropped.` : ''}
  confirmLabel="Delete rule"
  loading={deleting}
  onconfirm={doDelete}
  onclose={() => (confirmDelete = null)}
/>

<CopyRuntimeFlow
  open={copyIds !== null}
  {projectId}
  kind="rules"
  sourceHostId={scope.hostId}
  itemIds={copyIds ?? []}
  onclose={() => (copyIds = null)}
/>

<style>
  .section { display: grid; gap: var(--sp-3); min-width: 0; }
  .head { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: var(--sp-3); }
  .section-title { margin: 0; font-size: var(--fs-md); font-weight: var(--fw-semibold); }
  .caption { margin: var(--sp-1) 0 0; font-size: var(--fs-xs); color: var(--text-muted); max-width: 80ch; }
  .name { font-weight: var(--fw-semibold); color: var(--text-primary); margin-right: var(--sp-1); }
  .muted { color: var(--text-muted); font-size: var(--fs-xs); }
  .block { display: block; }
  .num { font-variant-numeric: tabular-nums; }
  .conditions { display: inline-block; max-width: 34rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; font-size: var(--fs-xs); font-family: var(--font-mono); color: var(--text-secondary); }
  .switch { display: inline-flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm); cursor: pointer; }
  .detail { display: grid; gap: var(--sp-2); padding: var(--sp-2) 0; font-size: var(--fs-sm); }
  .detail p { margin: 0; color: var(--text-secondary); }
  .detail dl { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr)); gap: var(--sp-2) var(--sp-4); margin: 0; }
  .detail dt { font-size: var(--fs-xs); color: var(--text-muted); }
  .detail dd { margin: 0; }
  code { font-size: var(--fs-xs); }
  .section :global(tr.is-disabled > td), .section :global(tr.is-disabled > th) { color: var(--text-muted); }
</style>
