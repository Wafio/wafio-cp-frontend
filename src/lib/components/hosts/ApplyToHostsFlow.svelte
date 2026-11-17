<!--
  ApplyToHostsFlow: one firewall rule on many hosts: targets → rule → dry run
  preview (every host checked with its own lockout guard and features,
  nothing written) → typed confirmation (`apply-to-hosts`: the operator types
  "<n> hosts") → results, with "Retry failed hosts".

  The real apply is sent for exactly the hosts the dry run said would apply,
  by id, so a label target cannot grow between preview and confirm. Lists of
  more than 1,000 hosts go out in chunks of 1,000. Blocklist, allowlist (with
  ports), egress blocklist and port rules, add and remove; no geo, no mode
  settings.
-->
<script lang="ts">
  import { tick } from 'svelte';
  import Modal from '#lib/components/ui/Modal.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Alert from '#lib/components/ui/Alert.svelte';
  import Select from '#lib/components/ui/Select.svelte';
  import Spinner from '#lib/components/ui/Spinner.svelte';
  import AddRulesDrawer from '#lib/components/firewall/AddRulesDrawer.svelte';
  import { applyFirewallToHosts, type FleetHost, type HostApplyResponse, type HostTargets } from '#lib/api.js';
  import { describeAdd, parseAddressList, parsePortInput, type AccessRuleAdd, type RuleDirection } from '#lib/components/firewall/rules.js';
  import { firewallErrorMessage } from '#lib/components/firewall/guard-codes.js';
  import { tierFor, typedConfirmationMatches } from '#lib/confirm-tiers.js';
  import {
    accessRuleToApply,
    chunkIds,
    describeRemove,
    hostCountPhrase,
    hostsWithLabel,
    mergeApplyResponses,
    partialApplyResponse,
    payloadNeedsAllowlistPorts,
    payloadSize,
    removeRuleToApply,
    replaceResults,
    type FirewallApplyPayload,
    type FirewallRemove,
  } from '#lib/host-fleet.js';
  import { toast } from '#lib/stores/toast.js';
  import HostTargetsPicker from './HostTargetsPicker.svelte';
  import ApplyResultsTable from './ApplyResultsTable.svelte';
  import { loadFleet } from './fleet-loader';

  type Step = 'targets' | 'rule' | 'preview' | 'confirm' | 'results';

  let {
    open = false,
    projectId,
    mode = 'add',
    hosts = undefined,
    initialHostIds = [],
    initialRequest = null,
    excludeHostIds = [],
    onclose,
    onapplied = undefined,
  }: {
    open?: boolean;
    projectId: string;
    mode?: 'add' | 'remove';
    /** Fleet rows; loaded on open when not given. */
    hosts?: readonly FleetHost[];
    initialHostIds?: readonly string[];
    /** A rule already defined (e.g. the one just added on one host). */
    initialRequest?: AccessRuleAdd | null;
    excludeHostIds?: readonly string[];
    onclose: () => void;
    onapplied?: (response: HostApplyResponse) => void;
  } = $props();

  const uid = $props.id();
  const PROTO_OPTIONS = [
    { value: 'tcp', label: 'TCP' },
    { value: 'udp', label: 'UDP' },
    { value: 'any', label: 'Any' },
  ];
  const DIRECTION_OPTIONS: { value: RuleDirection; label: string }[] = [
    { value: 'ingress', label: 'Ingress' },
    { value: 'egress', label: 'Egress' },
    { value: 'both', label: 'Both' },
  ];
  const STEPS: { id: Step; label: string }[] = [
    { id: 'targets', label: 'Hosts' },
    { id: 'rule', label: 'Rule' },
    { id: 'preview', label: 'Dry run' },
    { id: 'confirm', label: 'Confirm' },
    { id: 'results', label: 'Results' },
  ];

  let step = $state<Step>('targets');
  let fleet = $state.raw<readonly FleetHost[]>([]);
  let fleetLoading = $state(false);
  let fleetError = $state<string | null>(null);
  let targetMode = $state<'hosts' | 'label'>('hosts');
  let selected = $state<string[]>([]);
  let label = $state<{ key: string; value: string } | null>(null);
  let request = $state<AccessRuleAdd | null>(null);
  let drawerOpen = $state(false);
  // Removal form
  let removeType = $state<FirewallRemove['type']>('block');
  let removeText = $state('');
  let removePorts = $state('');
  let removeProto = $state('tcp');
  let removeDirection = $state<RuleDirection>('ingress');

  let preview = $state<HostApplyResponse | null>(null);
  let result = $state<HostApplyResponse | null>(null);
  let typed = $state('');
  let busy = $state(false);
  let retrying = $state(false);
  let error = $state<string | null>(null);
  let modal = $state<ReturnType<typeof Modal>>();
  let heading = $state<HTMLElement>();

  let wasOpen = false;
  $effect.pre(() => {
    if (open && !wasOpen) reset();
    wasOpen = open;
  });

  function reset() {
    step = 'targets';
    targetMode = 'hosts';
    selected = initialHostIds.filter((id) => !excludeHostIds.includes(id));
    label = null;
    request = initialRequest && initialRequest.type !== 'geo' ? initialRequest : null;
    removeType = 'block';
    removeText = '';
    removePorts = '';
    removeProto = 'tcp';
    removeDirection = 'ingress';
    preview = null;
    result = null;
    typed = '';
    busy = false;
    retrying = false;
    error = null;
    fleetError = null;
    if (hosts) fleet = hosts;
    else void loadHosts();
  }

  async function loadHosts() {
    fleetLoading = true;
    const res = await loadFleet(projectId, () => !open);
    fleetLoading = false;
    if (res.error) fleetError = res.error;
    else if (res.hosts) fleet = res.hosts;
  }

  $effect(() => {
    if (hosts) fleet = hosts;
  });

  // ── Derived request ─────────────────────────────────────────────────
  const removeBuilt = $derived.by((): { request: FirewallRemove | null; problem: string | null } => {
    if (removeType === 'port') {
      const parsed = parsePortInput(removePorts);
      if (parsed.error) return { request: null, problem: parsed.error };
      return { request: { type: 'port', ports: parsed.ports, proto: removeProto, direction: removeDirection }, problem: null };
    }
    const parsed = parseAddressList(removeText);
    if (!parsed.valid.length) return { request: null, problem: 'Enter at least one address.' };
    if (parsed.invalid.length) return { request: null, problem: 'Fix or remove the entries that are not valid.' };
    return { request: { type: removeType, addresses: parsed.valid }, problem: null };
  });

  const built = $derived.by((): { payload: FirewallApplyPayload | null; text: string; problem: string | null } => {
    if (mode === 'remove') {
      const r = removeBuilt.request;
      return r ? { payload: removeRuleToApply(r), text: describeRemove(r), problem: null } : { payload: null, text: '', problem: removeBuilt.problem };
    }
    if (!request) return { payload: null, text: '', problem: 'Define the rule first.' };
    const mapped = accessRuleToApply(request);
    return { payload: mapped.payload, text: describeAdd(request), problem: mapped.error };
  });

  const candidates = $derived(fleet.filter((h) => h.status !== 'revoked' && !excludeHostIds.includes(h.id)));
  const targetCount = $derived(targetMode === 'label' ? (label ? hostsWithLabel(candidates, label).length : 0) : selected.length);
  const targetsProblem = $derived(
    targetMode === 'label' ? (!label ? 'Choose a label.' : targetCount === 0 ? 'No host carries this label.' : null) : selected.length ? null : 'Select at least one host.',
  );
  const wouldIds = $derived(preview ? preview.results.filter((r) => r.status === 'would_apply').map((r) => r.host_id) : []);
  const phrase = $derived(hostCountPhrase(wouldIds.length));
  const typedTier = tierFor('apply-to-hosts') === 'typed';
  const confirmed = $derived(!typedTier || typedConfirmationMatches(typed, phrase));
  const dirty = $derived(step !== 'results' && (step !== 'targets' || Boolean(request) || Boolean(removeText.trim() || removePorts.trim())));

  function hostName(id: string): string {
    return fleet.find((h) => h.id === id)?.name ?? preview?.results.find((r) => r.host_id === id)?.host_name ?? '';
  }

  async function goTo(next: Step, keepError = false) {
    if (!keepError) error = null;
    step = next;
    await tick();
    heading?.focus();
  }

  function targetsFor(ids: readonly string[] | null): HostTargets[] {
    if (ids) return chunkIds(ids).map((chunk) => ({ host_ids: chunk }));
    if (targetMode === 'label' && label) return [{ label }];
    return chunkIds(selected).map((chunk) => ({ host_ids: chunk }));
  }

  function requestError(err: { error: string; code?: string; matched?: number }): string {
    if (err.code === 'APPLY_IN_PROGRESS') return 'Another apply is running in this project. Try again when it has finished.';
    if (err.code === 'TOO_MANY_TARGETS') return `The label matches ${err.matched ?? 'more than 1,000'} hosts; one apply takes at most 1,000. Pick hosts instead or use a narrower label.`;
    if (err.code === 'NO_TARGETS') return 'No host carries this label any more.';
    if (err.code === 'HOST_NOT_FOUND') return 'One of the hosts no longer exists in this project; nothing was changed. Close this dialog and refresh the list.';
    return firewallErrorMessage(err, 'The request was refused.');
  }

  async function send(ids: readonly string[] | null, dryRun: boolean): Promise<HostApplyResponse | null> {
    const payload = built.payload;
    if (!payload) return null;
    const responses: HostApplyResponse[] = [];
    const chunks = targetsFor(ids);
    for (const [i, targets] of chunks.entries()) {
      const res = await applyFirewallToHosts(projectId, { targets, ...payload, dry_run: dryRun });
      if (res.error || !res.data) {
        error = requestError(res.error ?? { error: 'No response from the server.' });
        if (dryRun) return null;
        // Chunks already sent stay applied: show them, and every host of this
        // and later chunks as failed (not sent) with the error.
        const unsent = chunks.slice(i).flatMap((t) => ('host_ids' in t ? t.host_ids : []));
        return partialApplyResponse(responses, unsent, hostName, error);
      }
      responses.push(res.data);
    }
    return mergeApplyResponses(responses);
  }

  async function runDryRun() {
    if (busy || built.problem || targetsProblem) return;
    busy = true;
    error = null;
    const res = await send(null, true);
    busy = false;
    if (!res) return;
    preview = res;
    typed = '';
    await goTo('preview');
  }

  async function apply() {
    if (busy || !confirmed || !wouldIds.length) return;
    busy = true;
    error = null;
    const res = await send(wouldIds, false);
    busy = false;
    if (!res) return;
    result = res;
    const s = res.summary;
    if (s.failed || s.skipped || error) toast.warning(`${s.applied} applied, ${s.failed} failed, ${s.skipped} skipped.`, 'Applied with problems');
    else toast.success(`${built.text} on ${hostCountPhrase(s.applied)}.`, 'Rule applied');
    onapplied?.(res);
    // A refused later chunk keeps its error above the per-host results.
    await goTo('results', true);
  }

  async function retry(ids: string[]) {
    if (!result || retrying) return;
    retrying = true;
    error = null;
    const res = await send(ids, false);
    retrying = false;
    if (!res) return;
    result = replaceResults(result, res);
    onapplied?.(result);
  }

  function next() {
    if (step === 'targets' && !targetsProblem) void goTo('rule');
    else if (step === 'rule') void runDryRun();
    else if (step === 'preview' && wouldIds.length) void goTo('confirm');
  }

  function back() {
    if (step === 'rule') void goTo('targets');
    else if (step === 'preview') void goTo('rule');
    else if (step === 'confirm') void goTo('preview');
  }

  const stepIndex = $derived(STEPS.findIndex((s) => s.id === step));
  const title = $derived(mode === 'add' ? 'Add a firewall rule to hosts' : 'Remove a firewall rule from hosts');
</script>

<Modal bind:this={modal} {open} {title} size="xl" placement="top" minHeight="40rem" {dirty} dismissible={!busy && !retrying} {onclose}>
  <div class="flow">
    <ol class="steps" aria-label="Steps">
      {#each STEPS as s, i (s.id)}
        <li class:done={i < stepIndex} class:current={i === stepIndex} aria-current={i === stepIndex ? 'step' : undefined}>{i + 1}. {s.label}</li>
      {/each}
    </ol>

    <h3 class="step-title" tabindex="-1" bind:this={heading}>
      {#if step === 'targets'}Which hosts?{:else if step === 'rule'}{mode === 'add' ? 'Which rule?' : 'What to remove?'}{:else if step === 'preview'}Dry run: what each host would do{:else if step === 'confirm'}Confirm{:else}Results{/if}
    </h3>

    {#if step === 'targets'}
      {#if fleetLoading && !fleet.length}
        <Spinner label="Loading hosts…" layout="block" />
      {:else if fleetError && !fleet.length}
        <Alert tone="error" compact title="Hosts did not load" message={fleetError}>
          {#snippet actions()}<Button variant="secondary" size="sm" onclick={() => void loadHosts()}>Retry</Button>{/snippet}
        </Alert>
      {:else}
        <HostTargetsPicker hosts={fleet} bind:mode={targetMode} bind:selected bind:label excludeIds={excludeHostIds} scopedAllowlist={payloadNeedsAllowlistPorts(built.payload)} />
      {/if}
    {:else if step === 'rule'}
      <p class="lead">Targets: {targetMode === 'label' && label ? `hosts labelled ${label.key}=${label.value} (${hostCountPhrase(targetCount)} now)` : hostCountPhrase(targetCount)}.</p>
      {#if mode === 'add'}
        {#if request}
          <div class="rule-card">
            <p class="rule-text">{built.text}.</p>
            {#if built.problem}<Alert tone="warning" compact message={built.problem} />{/if}
            <Button variant="secondary" size="sm" onclick={() => (drawerOpen = true)}>Change rule…</Button>
          </div>
        {:else}
          <p class="lead">Blocklist, allowlist (optionally on some ports), egress blocklist or port rules. Geo policy and firewall mode stay per host.</p>
          <Button variant="primary" onclick={() => (drawerOpen = true)}>Define the rule…</Button>
        {/if}
      {:else}
        <fieldset class="rm-types">
          <legend class="rm-legend">Rule type</legend>
          {#each [['block', 'Blocklist'], ['allow', 'Allowlist'], ['egress', 'Egress blocklist'], ['port', 'Port rule']] as [value, text] (value)}
            <label><input type="radio" name={`${uid}-rm`} {value} bind:group={removeType} /> {text}</label>
          {/each}
        </fieldset>
        {#if removeType === 'port'}
          <div class="rm-grid">
            <label class="rm-field">Ports<input type="text" bind:value={removePorts} placeholder="22, 8080" autocomplete="off" /></label>
            <div class="rm-field">
              <label for={`${uid}-rm-proto`}>Protocol</label>
              <Select id={`${uid}-rm-proto`} class="rm-select" options={PROTO_OPTIONS} bind:value={removeProto} />
            </div>
            <div class="rm-field">
              <label for={`${uid}-rm-direction`}>Direction</label>
              <Select id={`${uid}-rm-direction`} class="rm-select" options={DIRECTION_OPTIONS} bind:value={removeDirection} />
            </div>
          </div>
          <p class="hint">Removes the port rule with exactly this port, protocol and direction; hosts without it report Unchanged.</p>
        {:else}
          <label class="rm-field">Addresses or CIDR prefixes, one per line or separated by commas
            <textarea rows="5" bind:value={removeText} autocomplete="off" spellcheck="false"></textarea>
          </label>
          <p class="hint">Entries must match exactly as listed on each host; hosts without them report Unchanged.</p>
        {/if}
        {#if built.payload}<p class="rule-text">{built.text}.</p>{/if}
      {/if}
    {:else if step === 'preview' && preview}
      <p class="lead">{built.text} on {hostCountPhrase(preview.total)}. Nothing has been written yet.</p>
      <ApplyResultsTable response={preview} caption="Dry run result per host" />
      {#if !wouldIds.length}
        <Alert tone="warning" compact message="No host would change. Go back to adjust the hosts or the rule." />
      {/if}
    {:else if step === 'confirm'}
      <p class="lead">{built.text} on <strong>{phrase}</strong>{payloadSize(built.payload ?? { op: 'blocklist.add' }) > 1 ? ` (${payloadSize(built.payload ?? { op: 'blocklist.add' })} items each)` : ''}. Hosts that failed or were skipped in the dry run are left out. Each host gets the same audit entry as a change made on its own Firewall page.</p>
      {#if typedTier}
        <label class="typed-label" for={`${uid}-typed`}>Type <strong>{phrase}</strong> to confirm</label>
        <input id={`${uid}-typed`} class="typed" type="text" bind:value={typed} autocomplete="off" spellcheck="false" onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void apply(); } }} />
      {/if}
    {:else if step === 'results' && result}
      <ApplyResultsTable response={result} caption="Apply result per host" onretry={retry} {retrying} />
    {/if}

    {#if error}<Alert tone="error" compact title="Not applied" message={error} />{/if}
  </div>

  {#snippet footer()}
    {#if step === 'results'}
      <Button variant="primary" onclick={onclose}>Done</Button>
    {:else}
      {#if step === 'rule' && built.problem && (mode === 'remove' ? Boolean(removeText.trim() || removePorts.trim()) : Boolean(request))}<span class="problem">{built.problem}</span>{/if}
      {#if step === 'targets' && targetsProblem && fleet.length}<span class="problem">{targetsProblem}</span>{/if}
      <Button variant="ghost" disabled={busy} onclick={() => (step === 'targets' ? modal?.requestClose() : back())}>{step === 'targets' ? 'Cancel' : 'Back'}</Button>
      {#if step === 'confirm'}
        <Button variant="danger" loading={busy} disabled={!confirmed || !wouldIds.length} onclick={() => void apply()}>Apply to {phrase}</Button>
      {:else if step === 'rule'}
        <Button variant="primary" loading={busy} disabled={Boolean(built.problem)} onclick={next}>Run dry run</Button>
      {:else}
        <Button variant="primary" disabled={step === 'targets' ? Boolean(targetsProblem) : !wouldIds.length} onclick={next}>Next</Button>
      {/if}
    {/if}
  {/snippet}
</Modal>

{#if mode === 'add'}
  <AddRulesDrawer
    open={drawerOpen}
    initialType={request && request.type !== 'geo' ? request.type : 'block'}
    types={['block', 'allow', 'egress', 'port']}
    multiHost
    hostCount={targetCount}
    onsubmit={(r) => { request = r; return Promise.resolve(null); }}
    onclose={() => (drawerOpen = false)}
  />
{/if}

<style>
  .flow { display: grid; gap: var(--sp-4); min-width: 0; }
  .steps { display: flex; flex-wrap: wrap; gap: var(--sp-2) var(--sp-4); margin: 0; padding: 0; list-style: none; font-size: var(--fs-xs); color: var(--text-muted); }
  .steps .done { color: var(--text-secondary); }
  .steps .current { color: var(--text-primary); font-weight: var(--fw-semibold); }
  .step-title { margin: 0; font-size: var(--fs-base); font-weight: var(--fw-semibold); color: var(--text-primary); }
  .step-title:focus-visible { outline: var(--ring-width) solid var(--ring-color); outline-offset: 2px; }
  .lead, .hint { margin: 0; font-size: var(--fs-sm); color: var(--text-secondary); line-height: 1.5; }
  .hint { font-size: var(--fs-xs); color: var(--text-muted); }
  .rule-card { display: grid; gap: var(--sp-2); justify-items: start; padding: var(--sp-3) var(--sp-4); border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface-1); }
  .rule-text { margin: 0; font-size: var(--fs-sm); color: var(--text-primary); }
  .rm-types { display: flex; flex-wrap: wrap; gap: var(--sp-4); margin: 0; padding: 0; border: 0; font-size: var(--fs-sm); color: var(--text-secondary); }
  .rm-types label { display: inline-flex; align-items: center; gap: var(--sp-2); cursor: pointer; }
  .rm-legend { width: 100%; padding: 0; margin-bottom: var(--sp-1); font-size: var(--fs-xs); font-weight: var(--fw-medium); }
  .rm-grid { display: flex; flex-wrap: wrap; gap: var(--sp-3); }
  .rm-field { display: grid; gap: var(--sp-1); font-size: var(--fs-xs); color: var(--text-secondary); }
  .rm-grid :global(.rm-select) { min-width: 8rem; }
  .rm-field input, .rm-field textarea, .typed {
    box-sizing: border-box;
    width: 100%;
    min-height: 36px;
    padding: var(--sp-2) var(--sp-3);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    background: var(--surface-input);
    color: var(--text-primary);
    font: inherit;
    font-size: var(--fs-sm);
  }
  .rm-field textarea { font-family: var(--font-mono); font-size: var(--fs-xs); resize: vertical; }
  .typed { max-width: 20rem; }
  /* One sentence: the expected text stays inline. */
  .typed-label { display: block; margin-bottom: calc(-1 * var(--sp-2)); font-size: var(--fs-sm); color: var(--text-secondary); }
  .typed-label strong { color: var(--text-primary); font-weight: var(--fw-semibold); }
  .rm-field :focus-visible, .typed:focus-visible { outline: var(--ring-width) solid var(--ring-color); outline-offset: 1px; }
  .problem { margin-right: auto; font-size: var(--fs-xs); color: var(--text-muted); }
</style>
