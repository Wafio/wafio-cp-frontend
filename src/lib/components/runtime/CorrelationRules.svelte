<!--
  CorrelationRules: project-wide multi-stage chains. Owners create, edit
  (custom chains), enable/disable and delete; built-in chains can only be
  disabled. Other roles see the list with disabled controls.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { deleteCorrelationRule, listCorrelationRules, updateCorrelationRule, type StoredCorrelationRule } from '#lib/api.js';
  import { formatNumber } from '#lib/format.js';
  import { createLifecycle } from '#lib/host-scope.svelte.js';
  import { categoryTone } from '#lib/tone.js';
  import { toast } from '#lib/stores/toast.js';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import ConfirmModal from '#lib/components/ui/ConfirmModal.svelte';
  import DataTable from '#lib/components/ui/DataTable.svelte';
  import type { DataTableColumn } from '#lib/components/ui/types.js';
  import CorrelationEditor from './CorrelationEditor.svelte';
  import { CORRELATION_ENTITIES, formatSpan, formatStages } from './correlation';
  import { loadAllPages } from './pages';

  let { projectId, canManage = false }: { projectId: string; canManage?: boolean } = $props();

  const life = createLifecycle();
  const ownerOnly = 'Requires the owner role';
  const ENTITY_VALUES = CORRELATION_ENTITIES.map((e) => e.value);

  let rules = $state.raw<StoredCorrelationRule[]>([]);
  let total = $state(0);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let toggling = $state<string | null>(null);
  let confirmDelete = $state<StoredCorrelationRule | null>(null);
  let deleting = $state(false);
  let editor = $state<{ rule: StoredCorrelationRule | null } | null>(null);

  async function load() {
    loading = true;
    const result = await loadAllPages<StoredCorrelationRule>(
      async (limit, offset) => {
        const res = await listCorrelationRules(projectId, { limit, offset });
        return { data: res.data ? { rows: res.data.rules ?? [], total: res.data.total } : null, error: res.error?.error ?? (res.data ? null : 'Correlation chains could not be loaded.') };
      },
      { isStale: () => life.destroyed },
    );
    if (!result) return;
    loading = false;
    if (result.error) {
      error = result.error;
      return;
    }
    error = null;
    rules = result.rows;
    total = result.total;
  }

  $effect(() => {
    void projectId;
    untrack(() => void load());
  });

  async function toggle(rule: StoredCorrelationRule) {
    if (!canManage) return;
    toggling = rule.id;
    const res = await updateCorrelationRule(projectId, rule.id, { enabled: !rule.enabled });
    if (life.destroyed) return;
    toggling = null;
    if (res.error) {
      toast.error(res.error.error || 'The chain could not be updated.', 'Chain not changed');
      return;
    }
    toast.success(`Chain "${rule.name}" ${rule.enabled ? 'disabled' : 'enabled'}`, 'Correlation chain updated');
    await load();
  }

  async function doDelete() {
    const rule = confirmDelete;
    if (!rule || !canManage || rule.built_in) return;
    deleting = true;
    const res = await deleteCorrelationRule(projectId, rule.id);
    if (life.destroyed) return;
    deleting = false;
    if (res.error) {
      toast.error(res.error.code === 'BUILTIN_RULE' ? 'Built-in chains cannot be deleted; disable them instead.' : res.error.error || 'The chain could not be deleted.', 'Chain not deleted');
      return;
    }
    confirmDelete = null;
    toast.success(`Chain "${rule.name}" deleted`, 'Correlation chain deleted');
    await load();
  }

  const columns: DataTableColumn<StoredCorrelationRule>[] = [
    { key: 'name', label: 'Chain', rowHeader: true, sortable: true },
    { key: 'entity', label: 'Correlate by', nowrap: true },
    { key: 'stages', label: 'Stages' },
    { key: 'span', label: 'Maximum span', nowrap: true, align: 'right' },
    { key: 'status', label: 'Status', nowrap: true },
  ];
</script>

<section class="section" aria-labelledby="corr-title">
  <div class="head">
    <div>
      <h2 id="corr-title" class="section-title">Correlation chains</h2>
      <p class="caption">
        Multi-stage chains evaluated as events arrive from every host of the project; a completed chain raises its last event to critical.
        {formatNumber(rules.filter((r) => r.enabled).length)} of {formatNumber(rules.length)} enabled.
      </p>
    </div>
    <Button variant="primary" size="sm" disabled={!canManage} title={canManage ? undefined : ownerOnly} onclick={() => (editor = { rule: null })}>New chain</Button>
  </div>
  {#if total > rules.length}<p class="caption">Showing the first {formatNumber(rules.length)} of {formatNumber(total)} chains.</p>{/if}

  <DataTable
    rows={rules}
    {columns}
    rowKey={(r) => r.id}
    caption="Correlation chains"
    itemLabel="chains"
    pageSize={25}
    loading={loading && rules.length === 0}
    {error}
    onretry={load}
    rowClass={(r) => (r.enabled ? undefined : 'is-disabled')}
    emptyTitle="No correlation chains"
    emptyMessage="Chains link events that are harmless alone, such as a file drop followed by its execution."
  >
    {#snippet cell(rule, column)}
      {#if column.key === 'name'}
        <span class="name">{rule.name}</span>
        {#if rule.built_in}<Badge tone="neutral" title="Seeded with the project; disable only">Built-in</Badge>{/if}
        {#if rule.description}<span class="desc">{rule.description}</span>{/if}
      {:else if column.key === 'entity'}
        <Badge tone={categoryTone(rule.rule.entity, ENTITY_VALUES)}>{CORRELATION_ENTITIES.find((e) => e.value === rule.rule.entity)?.label ?? rule.rule.entity}</Badge>
      {:else if column.key === 'stages'}
        <span class="stages" title={formatStages(rule.rule.stages)}>{rule.rule.stages?.length ?? 0} stages: {formatStages(rule.rule.stages)}</span>
      {:else if column.key === 'span'}
        {formatSpan(rule.rule.max_span)}
      {:else if column.key === 'status'}
        <label class="switch" title={canManage ? (rule.enabled ? 'Disable this chain' : 'Enable this chain') : ownerOnly}>
          <input type="checkbox" role="switch" checked={rule.enabled} disabled={!canManage || toggling === rule.id} aria-label={`${rule.name} enabled`} onclick={(e) => { e.preventDefault(); void toggle(rule); }} />
          <span>{rule.enabled ? 'Enabled' : 'Disabled'}</span>
        </label>
      {/if}
    {/snippet}
    {#snippet actions(rule)}
      {@const editable = canManage && !rule.built_in}
      <Button variant="ghost" size="sm" aria-label={`${editable ? 'Edit' : 'View'} ${rule.name}`} onclick={() => (editor = { rule })}>{editable ? 'Edit' : 'View'}</Button>
      {#if !rule.built_in}
        <Button variant="ghost" size="sm" disabled={!canManage} title={canManage ? undefined : ownerOnly} aria-label={`Delete ${rule.name}`} onclick={() => (confirmDelete = rule)}>Delete…</Button>
      {/if}
    {/snippet}
  </DataTable>
</section>

<CorrelationEditor
  open={editor !== null}
  {projectId}
  rule={editor?.rule ?? null}
  {canManage}
  onclose={() => (editor = null)}
  onsaved={() => {
    editor = null;
    void load();
  }}
/>

<ConfirmModal
  open={confirmDelete !== null}
  title="Delete correlation chain?"
  message={confirmDelete ? `"${confirmDelete.name}" stops escalating events on every host of the project.` : ''}
  confirmLabel="Delete chain"
  loading={deleting}
  onconfirm={doDelete}
  onclose={() => (confirmDelete = null)}
/>

<style>
  .section { display: grid; gap: var(--sp-3); min-width: 0; }
  .head { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: var(--sp-3); }
  .section-title { margin: 0; font-size: var(--fs-md); font-weight: var(--fw-semibold); }
  .caption { margin: var(--sp-1) 0 0; font-size: var(--fs-xs); color: var(--text-muted); max-width: 80ch; }
  .name { font-weight: var(--fw-semibold); color: var(--text-primary); margin-right: var(--sp-1); }
  .desc { display: block; font-size: var(--fs-xs); color: var(--text-muted); max-width: 36rem; }
  .stages { display: inline-block; max-width: 40rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; font-size: var(--fs-xs); color: var(--text-secondary); }
  .switch { display: inline-flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm); cursor: pointer; }
  .section :global(tr.is-disabled > td), .section :global(tr.is-disabled > th) { color: var(--text-muted); }
</style>
