<!--
  PolicyEditor: create or edit a runtime enforcement policy in a drawer.
  New policies start in Simulate. Saving an enabled
  kill policy goes through the typed confirmation (the operator
  types the policy name); a kill policy without a narrowing match is sent
  with kill_acknowledged only after that confirmation. "Preview matches"
  replays the policy against recent events of the host.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { createPolicy, getTraceEvents, updatePolicy, type EnforcementPolicy, type TraceEvent, type TraceEventTypeInfo } from '#lib/api.js';
  import { createDirtyTracker } from '#lib/dirty.svelte.js';
  import { formatNumber } from '#lib/format.js';
  import type { HostScope } from '#lib/host-scope.svelte.js';
  import { base } from '#lib/paths.js';
  import { toast } from '#lib/stores/toast.js';
  import Alert from '#lib/components/ui/Alert.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import ConfirmModal from '#lib/components/ui/ConfirmModal.svelte';
  import Drawer from '#lib/components/ui/Drawer.svelte';
  import Select from '#lib/components/ui/Select.svelte';
  import Switch from '#lib/components/ui/Switch.svelte';
  import { timeRangeLabel, timeRangeMinutes, type TimeRangeKey } from '#lib/components/ui/time-range.js';
  import { mitreFromEventTypes } from './mitre';
  import {
    COMM_MATCH_MODES,
    MIN_SEVERITY_CHOICES,
    POLICY_ACTIONS,
    defaultPolicyDraft,
    draftFromPolicy,
    isPolicyAction,
    kernelWillDowngrade,
    needsKillAcknowledgement,
    policySaveTier,
    previewMatches,
    validatePolicyDraft,
    type DraftValidation,
    type PolicyDraft,
  } from './policy';

  let {
    open = false,
    projectId,
    scope,
    policy = null,
    prefill = null,
    eventTypes,
    range,
    canConfigure = false,
    onclose,
    onsaved,
  }: {
    open?: boolean;
    projectId: string;
    scope: HostScope;
    policy?: EnforcementPolicy | null;
    prefill?: PolicyDraft | null;
    eventTypes: TraceEventTypeInfo[];
    range: TimeRangeKey;
    canConfigure?: boolean;
    onclose: () => void;
    onsaved: (policy: EnforcementPolicy) => void;
  } = $props();

  let draft = $state<PolicyDraft>(defaultPolicyDraft());
  let errors = $state<DraftValidation>({});
  let saving = $state(false);
  let serverError = $state<string | null>(null);
  let confirmOpen = $state(false);
  let mitreAuto = $state(false);
  let typeFilter = $state('');
  let sample = $state.raw<TraceEvent[] | null>(null);
  let sampleLoading = $state(false);
  let sampleError = $state<string | null>(null);
  let sampleRange = $state<TimeRangeKey>('1h');

  const dirty = createDirtyTracker(() => draft);
  dirty.guardNavigation();

  let wasOpen = false;
  $effect(() => {
    const isOpen = open;
    untrack(() => {
      if (isOpen && !wasOpen) {
        draft = policy ? draftFromPolicy(policy) : prefill ? { ...defaultPolicyDraft(), ...$state.snapshot(prefill) } : defaultPolicyDraft();
        errors = {};
        serverError = null;
        // A draft prefilled from an event carries a suggested mapping: keep following the event types.
        mitreAuto = !policy && Boolean(prefill?.mitre_technique_id);
        typeFilter = '';
        sample = null;
        sampleError = null;
        confirmOpen = false;
        dirty.reset();
      }
      wasOpen = isOpen;
    });
  });

  const isEdit = $derived(Boolean(policy));
  const tier = $derived(policySaveTier(draft));
  const broadKill = $derived(needsKillAcknowledgement(draft));
  const downgrade = $derived(kernelWillDowngrade(draft));
  const legacyAction = $derived(!isPolicyAction(draft.action));
  const egressHref = $derived(`${base}/projects/${projectId}/host/firewall?${new URLSearchParams({ host: scope.hostId, tab: 'rules', type: 'egress' })}`);
  const preview = $derived(sample ? previewMatches(draft, sample) : null);
  const commModeHelp = $derived(COMM_MATCH_MODES.find((m) => m.value === draft.match_comm_mode)?.help ?? '');

  interface TypeGroup {
    category: string;
    types: TraceEventTypeInfo[];
  }

  const typeGroups = $derived.by<TypeGroup[]>(() => {
    const q = typeFilter.trim().toLowerCase();
    const groups = new Map<string, TraceEventTypeInfo[]>();
    for (const type of eventTypes) {
      if (q && !type.name.toLowerCase().includes(q) && !(type.description ?? '').toLowerCase().includes(q)) continue;
      const category = (type.category || 'other').split(',')[0].trim() || 'other';
      const list = groups.get(category) ?? [];
      list.push(type);
      groups.set(category, list);
    }
    return [...groups.entries()].map(([category, types]) => ({ category, types }));
  });

  function toggleType(name: string, on: boolean) {
    const next = on ? [...new Set([...draft.event_types, name])] : draft.event_types.filter((t) => t !== name);
    draft.event_types = next;
    if (!draft.mitre_technique_id || mitreAuto) {
      const suggestion = mitreFromEventTypes(next);
      if (suggestion) {
        draft.mitre_technique_id = suggestion.technique_id;
        draft.mitre_tactic = suggestion.tactic;
        mitreAuto = true;
      } else if (mitreAuto) {
        draft.mitre_technique_id = '';
        draft.mitre_tactic = '';
        mitreAuto = false;
      }
    }
  }

  async function loadSample() {
    const epoch = scope.epoch;
    sampleLoading = true;
    sampleError = null;
    sampleRange = range;
    const res = await getTraceEvents(projectId, 1000, undefined, scope.agentId, scope.hostId, timeRangeMinutes(range) ?? undefined);
    if (scope.isStale(epoch)) return;
    sampleLoading = false;
    if (res.error || !res.data) sampleError = res.error?.error ?? 'Recent events could not be loaded.';
    else sample = res.data;
  }

  function close() {
    dirty.reset();
    onclose();
  }

  function requestSave() {
    if (!canConfigure || saving) return;
    serverError = null;
    errors = validatePolicyDraft(draft);
    if (Object.keys(errors).length > 0) return;
    if (tier === 'typed' || tier === 'simple') {
      confirmOpen = true;
      return;
    }
    void save();
  }

  async function save() {
    if (!canConfigure) return;
    const epoch = scope.epoch;
    saving = true;
    const body: Partial<EnforcementPolicy> = { ...$state.snapshot(draft), name: draft.name.trim() };
    // The typed confirmation is the operator's acknowledgement of a kill
    // policy that matches every process of its event types (server guard).
    if (needsKillAcknowledgement(draft)) body.kill_acknowledged = true;
    const res = policy ? await updatePolicy(projectId, policy.id, body, scope.agentId, scope.hostId) : await createPolicy(projectId, body, scope.agentId, scope.hostId);
    if (scope.isStale(epoch)) return;
    saving = false;
    confirmOpen = false;
    if (res.error || !res.data) {
      serverError = res.error?.error ?? 'The policy could not be saved.';
      return;
    }
    toast.success(policy ? `Policy "${body.name}" updated` : `Policy "${body.name}" created`, 'Policy saved');
    dirty.reset();
    onsaved(res.data);
  }

  const uid = $props.id();
  const noPermission = 'Requires the member or owner role';
</script>

<Drawer {open} title={isEdit ? (canConfigure ? 'Edit enforcement policy' : 'Enforcement policy') : 'New enforcement policy'} size="xl" dirty={dirty.isDirty} ondiscard={() => dirty.reset()} onclose={close}>
  <form
    class="form"
    id="{uid}-form"
    onsubmit={(e) => {
      e.preventDefault();
      requestSave();
    }}
  >
    {#if !canConfigure}<Alert tone="info" message="Read-only access: your role can view this policy but not save it." />{/if}

    <fieldset class="bare" disabled={!canConfigure || saving}>
    <legend class="sr-only">Policy definition</legend>
    <div class="row">
      <label class="field grow">
        <span class="label">Name <span class="req" aria-hidden="true">*</span></span>
        <input class="input" bind:value={draft.name} required aria-required="true" aria-invalid={errors.name ? 'true' : undefined} aria-describedby={errors.name ? `${uid}-name-error` : undefined} />
        {#if errors.name}<span class="error" id="{uid}-name-error">{errors.name}</span>{/if}
      </label>
      <div class="field">
        <label class="label" for="{uid}-min-severity">Minimum severity</label>
        <Select id="{uid}-min-severity" class="min-severity" options={MIN_SEVERITY_CHOICES} bind:value={draft.min_severity} />
      </div>
    </div>
    <label class="field">
      <span class="label">Description</span>
      <input class="input" bind:value={draft.description} />
    </label>

    <fieldset class="actions">
      <legend class="label">Action</legend>
      {#each POLICY_ACTIONS as action (action.value)}
        <label class="action" class:active={draft.action === action.value}>
          <input type="radio" name="{uid}-action" value={action.value} bind:group={draft.action} />
          <span class="action-text">
            <span class="action-name">{action.label}{action.value === 'simulate' ? ' (recommended first)' : ''}</span>
            <span class="hint">{action.help}</span>
          </span>
        </label>
      {/each}
    </fieldset>
    <span class="hint">To block outbound traffic to an address, use <a href={egressHref}>Firewall, Access rules, Egress blocklist</a>.</span>
    {#if legacyAction}
      <Alert tone="warning" title={`The ${draft.action} action is no longer available`}>Choose one of the actions above before saving this policy.</Alert>
    {/if}
    {#if tier === 'typed'}
      <Alert tone="warning" title="This policy kills processes">
        {#if broadKill}It has no narrowing process, file, UID, port or IP match (UID 0, “/”, system directories such as /usr/ or /tmp/ and terms shorter than 3 characters do not narrow), so it applies to every process that emits its events. Exempt are only PID 1, the agent and verified host daemons: sshd, sshd-session, sshd-auth, systemd, systemd-journald, containerd, dockerd, kubelet and names added on the host agent, running as root from the host’s own binary.{/if}
        {#if draft.kernel_enforce}In the kernel a daemon is exempt once the agent has listed it (at start, then every 5 seconds); a child it forks stays exempt until it runs another program.{/if}
        Saving asks you to type the policy name. Run it in Simulate first and check Explore → Enforcement actions.
      </Alert>
    {/if}

    <fieldset class="group">
      <legend class="label">Match <span class="hint">(all filled fields must match; lists are comma-separated, any term matches)</span></legend>
      <div class="grid">
        <div class="field">
          <label class="label" for="{uid}-comm">Process name</label>
          <div class="combo">
            <Select class="combo-mode" aria-label="Process name match" options={COMM_MATCH_MODES} bind:value={draft.match_comm_mode} />
            <input class="input" id="{uid}-comm" bind:value={draft.match_comm} />
          </div>
          <span class="hint">{commModeHelp} For execve also the program's file name.</span>
        </div>
        <label class="field">
          <span class="label">File path contains</span>
          <input class="input" bind:value={draft.match_filename} />
        </label>
        <label class="field">
          <span class="label">User ID</span>
          <input
            class="input"
            type="number"
            min="0"
            step="1"
            value={draft.match_uid ?? ''}
            aria-invalid={errors.match_uid ? 'true' : undefined}
            oninput={(e) => {
              const value = e.currentTarget.value;
              draft.match_uid = value === '' ? null : Number(value);
            }}
          />
          <span class="hint">Empty matches any user; 0 is root.</span>
          {#if errors.match_uid}<span class="error">{errors.match_uid}</span>{/if}
        </label>
        <label class="field">
          <span class="label">Destination ports</span>
          <input class="input" bind:value={draft.match_dest_port} aria-invalid={errors.match_dest_port ? 'true' : undefined} />
          <span class="hint">connect, bind and listen events only.</span>
          {#if errors.match_dest_port}<span class="error">{errors.match_dest_port}</span>{/if}
        </label>
        <label class="field">
          <span class="label">Destination IP</span>
          <input class="input" bind:value={draft.match_dest_ip} placeholder="203.0.113.7" />
          <span class="hint">One IPv4 address, for connect and sendto events.</span>
        </label>
      </div>
    </fieldset>

    <fieldset class="group">
      <legend class="label">Event types <span class="hint">({draft.event_types.length ? `${draft.event_types.length} selected` : 'none selected: every event type matches'})</span></legend>
      <label class="field">
        <span class="sr-only">Filter event types</span>
        <input class="input" type="search" bind:value={typeFilter} placeholder="Filter event types" />
      </label>
      <div class="types">
        {#each typeGroups as group (group.category)}
          <div class="type-group">
            <h4>{group.category}</h4>
            {#each group.types as type (type.name)}
              <label class="type" title={type.description}>
                <input type="checkbox" checked={draft.event_types.includes(type.name)} onchange={(e) => toggleType(type.name, e.currentTarget.checked)} />
                <code>{type.name}</code>
                <span class="hint">{type.description}</span>
              </label>
            {/each}
          </div>
        {:else}
          <p class="hint">{eventTypes.length ? 'No event type matches the filter.' : 'The agent has not reported its event types.'}</p>
        {/each}
      </div>
      {#if draft.event_types.some((t) => !eventTypes.some((et) => et.name === t))}
        <p class="hint">Also selected (not reported by this agent): {draft.event_types.filter((t) => !eventTypes.some((et) => et.name === t)).join(', ')}</p>
      {/if}
    </fieldset>

    <div class="row">
      <label class="field grow">
        <span class="label">ATT&amp;CK technique {#if mitreAuto}<span class="hint">(suggested from the event types; edit to override)</span>{/if}</span>
        <input class="input" bind:value={draft.mitre_technique_id} oninput={() => (mitreAuto = false)} />
      </label>
      <label class="field grow">
        <span class="label">ATT&amp;CK tactic</span>
        <input class="input" bind:value={draft.mitre_tactic} oninput={() => (mitreAuto = false)} />
      </label>
    </div>

    <div class="checks">
      <Switch bind:checked={draft.kernel_enforce} label="Enforce in the kernel" hint="Instant; evaluates event type and severity only." />
      {#if downgrade}
        <Alert tone="warning" compact message="The kernel cannot evaluate process, file or UID matches: the agent keeps this rule in userspace, one ring-buffer round trip later. Clear those fields for in-kernel enforcement." />
      {/if}
      <Switch bind:checked={draft.enabled} label="Enabled" />
    </div>
    </fieldset>

    <section class="preview" aria-labelledby="{uid}-preview">
      <div class="preview-head">
        <h4 id="{uid}-preview">Preview</h4>
        <Button variant="secondary" size="sm" loading={sampleLoading} disabled={sampleLoading} onclick={loadSample}>{sample ? 'Reload recent events' : 'Preview against recent events'}</Button>
      </div>
      {#if sampleError}
        <p class="error">{sampleError}</p>
      {:else if preview}
        <p role="status">
          Would have matched <strong>{formatNumber(preview.matched)}</strong> of the newest {formatNumber(preview.sampled)} stored events ({sampleRange === 'all' ? 'all time' : timeRangeLabel(sampleRange).toLowerCase()}).
          {#if preview.processes.length}Top processes: {preview.processes.map((p) => `${p.comm} (${formatNumber(p.count)})`).join(', ')}.{/if}
        </p>
        <p class="hint">Stored events only: suppressed events and capture loss are not included. The agent evaluates live events the same way.</p>
      {:else}
        <p class="hint">Replays this policy against up to 1,000 stored events of the page time range, without saving.</p>
      {/if}
    </section>

    {#if serverError}<Alert tone="error" message={serverError} />{/if}
  </form>

  {#snippet footer()}
    <Button variant="ghost" onclick={close}>{canConfigure ? 'Cancel' : 'Close'}</Button>
    <Button
      variant={tier === 'typed' ? 'danger' : 'primary'}
      type="submit"
      form="{uid}-form"
      loading={saving}
      disabled={!canConfigure || saving}
      title={canConfigure ? undefined : noPermission}
    >
      {isEdit ? 'Save policy' : 'Create policy'}{tier === 'typed' ? '…' : ''}
    </Button>
  {/snippet}
</Drawer>

<ConfirmModal
  open={confirmOpen}
  title={draft.action === 'kill' ? `Enable kill policy "${draft.name.trim()}"?` : 'Save this policy?'}
  confirmLabel={draft.action === 'kill' ? 'Save and kill matches' : 'Save'}
  tone={tier === 'typed' ? 'danger' : 'warning'}
  requireText={tier === 'typed' ? draft.name.trim() : ''}
  requireTextLabel={tier === 'typed' ? `Type the policy name, ${draft.name.trim()}, to confirm` : undefined}
  loading={saving}
  onconfirm={save}
  onclose={() => (confirmOpen = false)}
>
  <div class="confirm-body">
    {#if draft.action === 'kill'}
      <p>The agent sends SIGKILL to every process that matches, on {scope.agent?.hostname || 'this host'}. Misconfiguration can stop legitimate services.</p>
    {/if}
    {#if broadKill}<p>It has no narrowing match: every process that emits its events is killed, except PID 1, the agent and verified host daemons (sshd, systemd, containerd, dockerd, kubelet and names added on the host agent). Confirming records your acknowledgement.</p>{/if}
    {#if preview}<p>Preview: {formatNumber(preview.matched)} of the newest {formatNumber(preview.sampled)} stored events would have matched.</p>{:else}<p>No preview was run. Consider Simulate first.</p>{/if}
  </div>
</ConfirmModal>

<style>
  .form { display: grid; gap: var(--sp-4); min-width: 0; }
  .bare { display: grid; gap: var(--sp-4); min-width: 0; margin: 0; padding: 0; border: 0; }
  .row { display: flex; flex-wrap: wrap; gap: var(--sp-3); }
  .grow { flex: 1 1 14rem; }
  .field { display: grid; gap: var(--sp-1); min-width: 0; align-content: start; }
  .label { font-size: var(--fs-sm); font-weight: var(--fw-medium); color: var(--text-secondary); }
  .req { color: var(--danger); }
  .hint { font-size: var(--fs-xs); color: var(--text-muted); font-weight: 400; }
  .error { font-size: var(--fs-xs); color: var(--danger); margin: 0; }
  .input { width: 100%; padding: var(--sp-2); border: 1px solid var(--border-strong); border-radius: var(--radius); background: var(--surface-input); color: var(--text-primary); font-size: var(--fs-sm); }
  .input[aria-invalid='true'] { border-color: var(--danger); }
  .combo { display: flex; gap: var(--sp-2); min-width: 0; }
  .row :global(.min-severity) { min-width: 11rem; }
  .combo :global(.combo-mode) { flex: 0 0 auto; width: auto; min-width: 9rem; }
  fieldset { margin: 0; min-width: 0; }
  .actions { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 14rem), 1fr)); gap: var(--sp-2); padding: 0; border: 0; }
  .actions legend { margin-bottom: var(--sp-2); }
  .action { display: flex; gap: var(--sp-2); align-items: flex-start; padding: var(--sp-2) var(--sp-3); border: 1px solid var(--border); border-radius: var(--radius); cursor: pointer; }
  .action.active { border-color: var(--accent); background: var(--accent-soft); }
  .action-text { display: grid; gap: calc(var(--sp-1) / 2); }
  .action-name { font-size: var(--fs-sm); font-weight: var(--fw-semibold); color: var(--text-primary); }
  .group { display: grid; gap: var(--sp-3); padding: var(--sp-3); border: 1px solid var(--border); border-radius: var(--radius-lg); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 14rem), 1fr)); gap: var(--sp-3); }
  .types { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr)); gap: var(--sp-3); max-height: 22rem; overflow-y: auto; }
  .type-group h4 { margin: 0 0 var(--sp-1); font-size: var(--fs-sm); color: var(--text-muted); }
  .type { display: grid; grid-template-columns: auto auto minmax(0, 1fr); gap: var(--sp-2); align-items: baseline; padding: calc(var(--sp-1) / 2) 0; font-size: var(--fs-sm); cursor: pointer; }
  .type .hint { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  code { font-size: var(--fs-xs); }
  .checks { display: grid; gap: var(--sp-2); }
  .preview { display: grid; gap: var(--sp-2); padding: var(--sp-3); border: 1px dashed var(--border-strong); border-radius: var(--radius-lg); font-size: var(--fs-sm); }
  .preview p { margin: 0; }
  .preview-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--sp-2); }
  .preview-head h4 { margin: 0; font-size: var(--fs-sm); }
  .confirm-body { display: grid; gap: var(--sp-2); font-size: var(--fs-sm); }
  .confirm-body p { margin: 0; }
</style>
