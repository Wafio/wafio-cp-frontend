<!--
  EnforcementPolicies: the host's runtime enforcement policies. Enabling a
  kill or block policy from the status switch goes through the same typed
  confirmation as saving it; disabling needs none. Hit counts refresh
  every 15 s while the list is visible.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { deletePolicy, listPolicies, updatePolicy, type EnforcementPolicy } from '#lib/api.js';
  import { formatNumber } from '#lib/format.js';
  import { createLifecycle, type HostScope } from '#lib/host-scope.svelte.js';
  import { enforcementTone, severityTone } from '#lib/tone.js';
  import { toast } from '#lib/stores/toast.js';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import ConfirmModal from '#lib/components/ui/ConfirmModal.svelte';
  import DataTable from '#lib/components/ui/DataTable.svelte';
  import DateTime from '#lib/components/ui/DateTime.svelte';
  import type { DataTableColumn } from '#lib/components/ui/types.js';
  import CopyRuntimeFlow from '#lib/components/hosts/CopyRuntimeFlow.svelte';
  import { needsKillAcknowledgement, policyMatchSummary, policyPlacement, policySaveTier, draftFromPolicy } from './policy';

  let {
    projectId,
    scope,
    canConfigure = false,
    version = 0,
    onedit,
    ontemplates,
  }: {
    projectId: string;
    scope: HostScope;
    canConfigure?: boolean;
    /** Bumped by the page after the editor saved a policy. */
    version?: number;
    /** Opens the policy editor (null = new policy). */
    onedit: (policy: EnforcementPolicy | null) => void;
    ontemplates: () => void;
  } = $props();

  const life = createLifecycle();
  // The view is keyed per host: it lives within one scope epoch.
  const hostEpoch = untrack(() => scope.epoch);
  const noPermission = 'Requires the member or owner role';

  let policies = $state.raw<EnforcementPolicy[]>([]);
  let loading = $state(false);
  let loaded = $state(false);
  let updatedAt = $state<Date | null>(null);
  let error = $state<string | null>(null);
  let toggling = $state<number | null>(null);
  let confirmEnable = $state<EnforcementPolicy | null>(null);
  let confirmDelete = $state<EnforcementPolicy | null>(null);
  let deleting = $state(false);
  /** Item copied to other hosts ("Copy to hosts…"). */
  let copyIds = $state<(string | number)[] | null>(null);

  function stale(): boolean {
    return life.destroyed || scope.isStale(hostEpoch);
  }

  async function load() {
    loading = true;
    const res = await listPolicies(projectId, scope.agentId, scope.hostId);
    if (stale()) return;
    loading = false;
    loaded = true;
    if (res.error || !res.data) error = res.error?.error ?? 'Policies could not be loaded.';
    else {
      error = null;
      policies = res.data;
      updatedAt = new Date();
    }
  }

  $effect(() => {
    void version;
    untrack(() => void load());
  });

  life.poll(() => (toggling !== null || confirmEnable ? undefined : load()), 15_000, { immediate: false });

  async function setEnabled(policy: EnforcementPolicy, enabled: boolean) {
    if (!canConfigure) return;
    toggling = policy.id;
    const body: Partial<EnforcementPolicy> = { ...policy, enabled };
    if (enabled && needsKillAcknowledgement(draftFromPolicy(policy))) body.kill_acknowledged = true;
    const res = await updatePolicy(projectId, policy.id, body, scope.agentId, scope.hostId);
    if (stale()) return;
    toggling = null;
    confirmEnable = null;
    if (res.error) {
      toast.error(res.error.error || 'The policy could not be updated.', 'Policy not changed');
      return;
    }
    toast.success(`Policy "${policy.name}" ${enabled ? 'enabled' : 'disabled'}`, 'Policy updated');
    await load();
  }

  function requestToggle(policy: EnforcementPolicy) {
    if (!canConfigure) return;
    const next = !policy.enabled;
    if (next && policySaveTier({ action: policy.action, enabled: true }) !== 'none') {
      confirmEnable = policy;
      return;
    }
    void setEnabled(policy, next);
  }

  async function doDelete() {
    const policy = confirmDelete;
    if (!policy || !canConfigure) return;
    deleting = true;
    const res = await deletePolicy(projectId, policy.id, scope.agentId, scope.hostId);
    if (stale()) return;
    deleting = false;
    if (res.error) {
      toast.error(res.error.error || 'The policy could not be deleted.', 'Policy not deleted');
      return;
    }
    confirmDelete = null;
    toast.success(`Policy "${policy.name}" deleted`, 'Policy deleted');
    await load();
  }

  const columns: DataTableColumn<EnforcementPolicy>[] = [
    { key: 'name', label: 'Policy', rowHeader: true, sortable: true },
    { key: 'action', label: 'Action', sortable: true, nowrap: true },
    { key: 'min_severity', label: 'Minimum severity', nowrap: true },
    { key: 'match', label: 'Match' },
    { key: 'placement', label: 'Where enforced', nowrap: true },
    { key: 'hit_count', label: 'Hits', align: 'right', sortable: true, firstSortDir: 'desc' },
    { key: 'status', label: 'Status', nowrap: true },
  ];

  const enforcing = $derived(policies.filter((p) => p.enabled && (p.action === 'kill' || p.action === 'block')).length);
</script>

<section class="section" aria-labelledby="enf-title">
  <div class="head">
    <div>
      <h2 id="enf-title" class="section-title">Enforcement policies</h2>
      <p class="caption">
        {formatNumber(policies.length)} policies · {formatNumber(policies.filter((p) => p.enabled).length)} enabled · {formatNumber(enforcing)} enforcing (kill or block).
        New policies start in Simulate.
      </p>
    </div>
    <div class="head-actions">
      <Button variant="secondary" size="sm" onclick={ontemplates}>Browse templates</Button>
      <Button variant="primary" size="sm" disabled={!canConfigure} title={canConfigure ? undefined : noPermission} onclick={() => onedit(null)}>New policy</Button>
    </div>
  </div>

  <DataTable
    rows={policies}
    {columns}
    rowKey={(p) => p.id}
    caption="Enforcement policies"
    itemLabel="policies"
    pageSize={25}
    loading={loading && !loaded}
    {error}
    onretry={load}
    emptyTitle="No enforcement policies"
    emptyMessage="Add a policy, or import a template as a disabled draft, to alert on, simulate or stop matching activity."
  >
    {#snippet cell(policy, column)}
      {#if column.key === 'name'}
        <span class="name">{policy.name}</span> <span class="muted">#{policy.id}</span>
        {#if policy.mitre_technique_id}<span class="muted"> · {policy.mitre_technique_id}{policy.mitre_tactic ? ` ${policy.mitre_tactic}` : ''}</span>{/if}
        {#if policy.description}<span class="desc">{policy.description}</span>{/if}
      {:else if column.key === 'action'}
        <Badge tone={enforcementTone(policy.action)}>{policy.action}</Badge>
      {:else if column.key === 'min_severity'}
        <Badge tone={severityTone(policy.min_severity || 'info')}>{policy.min_severity || 'info'}</Badge>
      {:else if column.key === 'match'}
        <span class="match">{policyMatchSummary(policy).join(' · ')}</span>
      {:else if column.key === 'placement'}
        {@const placement = policyPlacement(policy)}
        <span title={placement.help}>{placement.label}</span>
      {:else if column.key === 'hit_count'}
        <span class="num">{formatNumber(policy.hit_count)}</span>
      {:else if column.key === 'status'}
        <label class="switch" title={canConfigure ? (policy.enabled ? 'Disable this policy' : 'Enable this policy') : noPermission}>
          <input
            type="checkbox"
            role="switch"
            checked={policy.enabled}
            disabled={!canConfigure || toggling === policy.id}
            aria-label={`${policy.name} enabled`}
            onclick={(e) => {
              e.preventDefault();
              requestToggle(policy);
            }}
          />
          <span>{policy.enabled ? 'Enabled' : 'Disabled'}</span>
        </label>
      {/if}
    {/snippet}
    {#snippet actions(policy)}
      <Button variant="ghost" size="sm" aria-label={`${canConfigure ? 'Edit' : 'View'} ${policy.name}`} onclick={() => onedit(policy)}>{canConfigure ? 'Edit' : 'View'}</Button>
      <Button variant="ghost" size="sm" disabled={!canConfigure} title={canConfigure ? undefined : noPermission} aria-label={`Copy ${policy.name} to other hosts`} onclick={() => (copyIds = [policy.id])}>Copy to hosts…</Button>
      <Button variant="ghost" size="sm" disabled={!canConfigure} title={canConfigure ? undefined : noPermission} aria-label={`Delete ${policy.name}`} onclick={() => (confirmDelete = policy)}>Delete…</Button>
    {/snippet}
    {#snippet footer()}
      {#if updatedAt}<span class="muted">Hit counts as of <DateTime value={updatedAt} seconds /></span>{/if}
    {/snippet}
  </DataTable>
</section>

<ConfirmModal
  open={confirmEnable !== null}
  title={confirmEnable ? `Enable ${confirmEnable.action} policy "${confirmEnable.name}"?` : ''}
  confirmLabel={confirmEnable?.action === 'block' ? 'Enable and block matches' : 'Enable and kill matches'}
  tone="danger"
  requireText={confirmEnable?.name ?? ''}
  requireTextLabel={confirmEnable ? `Type the policy name, ${confirmEnable.name}, to confirm` : undefined}
  loading={confirmEnable !== null && toggling === confirmEnable.id}
  onconfirm={() => confirmEnable && setEnabled(confirmEnable, true)}
  onclose={() => (confirmEnable = null)}
>
  {#if confirmEnable}
    <div class="confirm-body">
      <p>
        {confirmEnable.action === 'block'
          ? 'The kernel denies execution (-EPERM) of matching programs before they start.'
          : 'The agent sends SIGKILL to every matching process. Misconfiguration can stop legitimate services.'}
      </p>
      <p>Match: {policyMatchSummary(confirmEnable).join(' · ')}.</p>
      {#if needsKillAcknowledgement(draftFromPolicy(confirmEnable))}<p>It has no narrowing match (UID 0, “/”, system directories such as /usr/ or /tmp/ and terms shorter than 3 characters do not narrow): every process that emits its events is killed, except PID 1, the agent and verified host daemons (sshd, systemd, containerd, dockerd, kubelet and names added on the host agent). Confirming records your acknowledgement.</p>{/if}
    </div>
  {/if}
</ConfirmModal>

<ConfirmModal
  open={confirmDelete !== null}
  title="Delete policy?"
  message={confirmDelete ? `"${confirmDelete.name}" stops applying on this host and is removed. Its past enforcement records stay in the log.` : ''}
  confirmLabel="Delete policy"
  loading={deleting}
  onconfirm={doDelete}
  onclose={() => (confirmDelete = null)}
/>

<CopyRuntimeFlow
  open={copyIds !== null}
  {projectId}
  kind="policies"
  sourceHostId={scope.hostId}
  itemIds={copyIds ?? []}
  onclose={() => (copyIds = null)}
/>

<style>
  .section { display: grid; gap: var(--sp-3); min-width: 0; }
  .head { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: var(--sp-3); }
  .head-actions { display: flex; flex-wrap: wrap; gap: var(--sp-2); }
  .section-title { margin: 0; font-size: var(--fs-md); font-weight: var(--fw-semibold); }
  .caption { margin: var(--sp-1) 0 0; font-size: var(--fs-xs); color: var(--text-muted); }
  .name { font-weight: var(--fw-semibold); color: var(--text-primary); }
  .desc { display: block; max-width: 36rem; font-size: var(--fs-xs); color: var(--text-muted); white-space: pre-line; }
  .muted { color: var(--text-muted); font-size: var(--fs-xs); }
  .match { font-size: var(--fs-xs); color: var(--text-secondary); }
  .num { font-variant-numeric: tabular-nums; }
  .switch { display: inline-flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm); cursor: pointer; }
  .confirm-body { display: grid; gap: var(--sp-2); font-size: var(--fs-sm); }
  .confirm-body p { margin: 0; }
</style>
