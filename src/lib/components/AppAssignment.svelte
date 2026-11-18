<!--
  AppAssignment: the Assignment tab: which WAF agent serves this
  application and in which protection mode. One active binding per
  application; moving it keeps the configuration, history and decisions.
  Lowering protection (Block → Monitor) and unassigning ask for
  confirmation. While maintenance mode is on, the server refuses an agent
  that does not support it or whose configuration would grow too large; the
  tab says so up front and shows the server's text when it refuses. The page
  loads the agents and the binding and passes them in, so this tab adds no
  requests of its own.
-->
<script lang="ts">
  import { base } from '#lib/paths.js';
  import { assignAppWAFAgent, unassignAppWAFAgent, type AppWAFAssignment, type FleetAgent } from '#lib/api.js';
  import { Alert, Badge, Button, ConfirmModal, DateTime, Field, StatusDot } from '#lib/components/ui/index.js';
  import Select from '#lib/components/ui/Select.svelte';
  import { tierForProtectionMode } from '#lib/confirm-tiers.js';
  import { modeTone } from '#lib/tone.js';
  import { toast } from '#lib/stores/toast.js';
  import ProtectionModeSelect from './apps/ProtectionModeSelect.svelte';
  import { MOVE_NOTE } from './apps/maintenance';
  import { PROTECTION_MODE_TEXT, type ProtectionMode } from './apps/route-model';
  import { appWriteErrorMessage } from './apps/route-errors';

  let {
    projectId,
    appId,
    appName,
    agents,
    assignment,
    canConfigure = false,
    maintenance = false,
    onchanged,
  }: {
    projectId: string;
    appId: string;
    appName: string;
    /** WAF agents of the project. */
    agents: FleetAgent[];
    /** Current binding, or null when unassigned. */
    assignment: AppWAFAssignment | null;
    canConfigure?: boolean;
    /** Maintenance mode is on for the application: only an agent that supports it can serve it. */
    maintenance?: boolean;
    /** Called after a successful assign, move or unassign. */
    onchanged: () => void | Promise<void>;
  } = $props();

  let selected = $state('');
  let mode = $state<ProtectionMode>('block');
  let saving = $state(false);
  let error = $state('');
  let confirm = $state<'lower' | 'unassign' | null>(null);

  // Follow the saved binding whenever it changes (load, save, another tab).
  $effect.pre(() => {
    selected = assignment?.agent_id ?? '';
    mode = assignment?.mode === 'monitor' ? 'monitor' : 'block';
    error = '';
  });

  const current = $derived(assignment ? agents.find((a) => a.id === assignment.agent_id) : undefined);
  const target = $derived(agents.find((a) => a.id === selected));
  const changed = $derived(selected !== (assignment?.agent_id ?? '') || (Boolean(assignment) && mode !== assignment?.mode));
  const moving = $derived(Boolean(assignment) && selected !== '' && selected !== assignment?.agent_id);
  const lowering = $derived(Boolean(assignment) && tierForProtectionMode(assignment?.mode ?? 'block', mode) !== 'none');

  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!canConfigure || !selected || !changed || saving) return;
    if (lowering) {
      confirm = 'lower';
      return;
    }
    void save();
  }

  async function save() {
    saving = true;
    error = '';
    const result = await assignAppWAFAgent(projectId, appId, selected, mode);
    saving = false;
    confirm = null;
    if (result.error) {
      error = appWriteErrorMessage(result.error, 'Could not save the assignment.');
      return;
    }
    toast.success(moving ? `Now served by ${target?.name ?? 'the selected agent'}. Configuration and history are kept.` : 'The agent applies the change with its next bundle.', 'Assignment saved');
    await onchanged();
  }

  async function unassign() {
    saving = true;
    error = '';
    const result = await unassignAppWAFAgent(projectId, appId);
    saving = false;
    confirm = null;
    if (result.error) {
      error = result.error.error || 'Could not remove the assignment.';
      return;
    }
    toast.success('Configuration and history are kept; assign an agent to protect the application again.', 'Assignment removed');
    await onchanged();
  }
</script>

<section class="asg" aria-labelledby="asg-title">
  <header>
    <h2 id="asg-title">WAF agent assignment</h2>
    <p>One WAF agent serves and protects an application. Moving the assignment keeps the configuration, its history and past decisions.</p>
  </header>

  <dl class="asg-current">
    <div>
      <dt>Current agent</dt>
      <dd>
        {#if assignment}
          <a href={`${base}/projects/${projectId}/waf/${assignment.agent_id}`}>{current?.name ?? assignment.agent_id}</a>
          {#if current}<StatusDot status={current.is_online ? 'online' : 'offline'} />{/if}
        {:else}
          <span class="asg-none">Unassigned: no agent serves this application, so its traffic is not inspected.</span>
        {/if}
      </dd>
    </div>
    {#if assignment}
      <div>
        <dt>Protection mode</dt>
        <dd><Badge tone={modeTone(assignment.mode)}>{PROTECTION_MODE_TEXT[assignment.mode === 'monitor' ? 'monitor' : 'block'].label}</Badge></dd>
      </div>
      {#if current?.last_seen}
        <div><dt>Agent last seen</dt><dd><DateTime value={current.last_seen} relative /></dd></div>
      {/if}
    {/if}
  </dl>

  {#if error}<Alert tone="error" message={error} />{/if}
  {#if maintenance}<Alert tone="info" message={MOVE_NOTE} />{/if}

  <form class="asg-form" onsubmit={submit}>
    <fieldset disabled={!canConfigure || saving}>
      <legend class="sr-only">Change the assignment</legend>
      <div class="asg-fields">
        <Field label="WAF agent" hint={agents.length === 0 ? 'No WAF agents are registered in this project. Register one on WAF agents first.' : 'Offline agents can be selected; they apply the assignment when they reconnect.'}>
          {#snippet children(c)}
            <Select
              {...c}
              options={[{ value: '', label: 'Choose an agent' }, ...agents.map((agent) => ({ value: agent.id, label: `${agent.name}${agent.is_online ? '' : ' (offline)'}` }))]}
              bind:value={selected}
            />
          {/snippet}
        </Field>
        <ProtectionModeSelect bind:value={mode} previous={assignment ? (assignment.mode === 'monitor' ? 'monitor' : 'block') : undefined} disabled={!canConfigure || saving} />
      </div>
      {#if moving}
        <p class="asg-note" role="note">Moving to {target?.name ?? 'another agent'}: {current?.name ?? 'the current agent'} stops serving {appName} and the new agent starts listening on the application's address.</p>
      {/if}
      <div class="asg-actions">
        <span class="asg-status" role="status">{changed ? 'Unsaved changes' : ''}</span>
        {#if assignment}
          <Button variant="secondary" disabled={saving} onclick={() => (confirm = 'unassign')}>Unassign</Button>
        {/if}
        <Button type="submit" variant="primary" loading={saving && confirm !== 'unassign'} disabled={!selected || !changed}>
          {assignment ? (moving ? 'Move assignment' : 'Save assignment') : 'Assign agent'}
        </Button>
      </div>
    </fieldset>
  </form>
  {#if !canConfigure}
    <p class="asg-note">Read-only: changing the assignment needs member access.</p>
  {/if}
</section>

<ConfirmModal
  open={confirm === 'lower'}
  tone="warning"
  title="Switch to monitor mode?"
  confirmLabel="Switch to monitor mode"
  loading={saving}
  onconfirm={() => void save()}
  onclose={() => (confirm = null)}
>
  <p class="asg-confirm">In Monitor mode every request reaches {appName}. Attacks are logged but not blocked until you switch back to Block.</p>
</ConfirmModal>

<ConfirmModal
  open={confirm === 'unassign'}
  tone="warning"
  title={`Unassign ${appName}?`}
  confirmLabel="Unassign"
  loading={saving}
  onconfirm={() => void unassign()}
  onclose={() => (confirm = null)}
>
  <p class="asg-confirm">{current?.name ?? 'The agent'} stops serving this application: requests to its address are no longer proxied or inspected. The configuration and history are kept for a later assignment.</p>
</ConfirmModal>

<style>
  .asg { display: flex; flex-direction: column; gap: var(--sp-5); width: 100%; min-width: 0; }
  header h2 { margin: 0; font-size: var(--fs-md); }
  header p { margin: var(--sp-1) 0 0; font-size: var(--fs-sm); color: var(--text-muted); line-height: 1.5; }
  .asg-current { display: grid; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); gap: var(--sp-3) var(--sp-5); margin: 0; padding: var(--sp-4); background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-lg); width: 100%; }
  .asg-current dt { font-size: var(--fs-xs); color: var(--text-muted); margin-bottom: var(--sp-1); }
  .asg-current dd { margin: 0; display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; font-size: var(--fs-sm); }
  .asg-current a { color: var(--accent); text-decoration: none; font-weight: var(--fw-medium); }
  .asg-current a:hover { text-decoration: underline; }
  .asg-none { color: var(--warning); }
  .asg-form fieldset { border: 0; padding: 0; margin: 0; min-width: 0; display: flex; flex-direction: column; gap: var(--sp-5); }
  .asg-fields { display: grid; grid-template-columns: minmax(16rem, 24rem) minmax(0, 1fr); gap: var(--sp-4) var(--sp-6); align-items: start; }
  .asg-actions {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    flex-wrap: wrap;
    justify-content: flex-end;
    padding: var(--sp-3) var(--sp-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--bg-elevated);
    box-shadow: var(--shadow-md);
  }
  .asg-status { font-size: var(--fs-sm); color: var(--text-muted); margin-right: auto; }
  .asg-note { margin: 0; font-size: var(--fs-sm); color: var(--text-muted); line-height: 1.5; }
  .asg-confirm { margin: 0; color: var(--text-secondary); line-height: 1.5; }

  @media (max-width: 760px) {
    .asg-fields { grid-template-columns: minmax(0, 1fr); }
    .asg-actions { flex-direction: column-reverse; align-items: stretch; }
    .asg-status { margin-right: 0; text-align: center; }
  }
</style>
