<!--
  CopyRuntimeFlow: copy runtime enforcement policies or detection rules
  from one host to many:
  source host and items → target hosts → dry run → typed confirmation
  (`copy-runtime-to-hosts`: "<n> hosts") → results, with "Retry failed hosts".

  Copies are keyed by name on each target: `skip` keeps a target's own item
  of the same name, `replace` overwrites it. Built-in detection rules exist
  on every host and are not copied. Policies need a host agent on the
  target; detection rules run at ingest and do not.
-->
<script lang="ts">
  import { tick } from 'svelte';
  import Modal from '#lib/components/ui/Modal.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Alert from '#lib/components/ui/Alert.svelte';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Select from '#lib/components/ui/Select.svelte';
  import Spinner from '#lib/components/ui/Spinner.svelte';
  import {
    applyDetectionRulesToHosts,
    applyTracePoliciesToHosts,
    listDetectionRules,
    listPolicies,
    type CopyConflict,
    type DetectionRule,
    type EnforcementPolicy,
    type FleetHost,
    type HostApplyResponse,
  } from '#lib/api.js';
  import { enforcementTone } from '#lib/tone.js';
  import { tierFor, typedConfirmationMatches, ENFORCING_POLICY_ACTIONS } from '#lib/confirm-tiers.js';
  import { chunkIds, hostCountPhrase, hostsWithLabel, mergeApplyResponses, partialApplyResponse, replaceResults } from '#lib/host-fleet.js';
  import { sortHosts } from '#lib/host-nav.js';
  import { toast } from '#lib/stores/toast.js';
  import HostTargetsPicker from './HostTargetsPicker.svelte';
  import ApplyResultsTable from './ApplyResultsTable.svelte';
  import { loadFleet } from './fleet-loader';

  type Step = 'source' | 'targets' | 'preview' | 'confirm' | 'results';
  type Item = { id: string; name: string; action: string; enabled: boolean; enforcing: boolean };

  let {
    open = false,
    projectId,
    kind,
    sourceHostId = '',
    itemIds = [],
    hosts = undefined,
    initialHostIds = [],
    onclose,
  }: {
    open?: boolean;
    projectId: string;
    kind: 'policies' | 'rules';
    sourceHostId?: string;
    /** Preselected policy ids (numbers) or rule ids. */
    itemIds?: readonly (string | number)[];
    hosts?: readonly FleetHost[];
    initialHostIds?: readonly string[];
    onclose: () => void;
  } = $props();

  const uid = $props.id();
  const noun = $derived(kind === 'policies' ? 'policy' : 'rule');
  const nouns = $derived(kind === 'policies' ? 'enforcement policies' : 'detection rules');
  const STEPS: { id: Step; label: string }[] = [
    { id: 'source', label: 'Source' },
    { id: 'targets', label: 'Hosts' },
    { id: 'preview', label: 'Dry run' },
    { id: 'confirm', label: 'Confirm' },
    { id: 'results', label: 'Results' },
  ];

  let step = $state<Step>('source');
  let fleet = $state.raw<readonly FleetHost[]>([]);
  let fleetLoading = $state(false);
  let fleetError = $state<string | null>(null);
  let source = $state('');
  let items = $state.raw<Item[]>([]);
  let itemsLoading = $state(false);
  let itemsError = $state<string | null>(null);
  let picked = $state<string[]>([]);
  let onConflict = $state<CopyConflict>('skip');
  let targetMode = $state<'hosts' | 'label'>('hosts');
  let selected = $state<string[]>([]);
  let label = $state<{ key: string; value: string } | null>(null);
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
    source = sourceHostId;
    picked = itemIds.map(String);
    items = [];
    itemsError = null;
    onConflict = 'skip';
    targetMode = 'hosts';
    selected = initialHostIds.filter((id) => id !== sourceHostId);
    label = null;
    preview = null;
    result = null;
    typed = '';
    busy = false;
    retrying = false;
    error = null;
    fleetError = null;
    step = sourceHostId && itemIds.length ? 'targets' : 'source';
    if (hosts) fleet = hosts;
    else void loadHosts();
    if (source) void loadItems(source);
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

  async function loadItems(hostId: string) {
    itemsLoading = true;
    itemsError = null;
    if (kind === 'policies') {
      const res = await listPolicies(projectId, undefined, hostId);
      if (source !== hostId) return;
      itemsLoading = false;
      if (res.error) itemsError = res.error.error;
      else items = (res.data ?? []).map((p: EnforcementPolicy) => ({ id: String(p.id), name: p.name, action: p.action, enabled: p.enabled, enforcing: p.enabled && (ENFORCING_POLICY_ACTIONS as readonly string[]).includes(p.action) }));
    } else {
      const res = await listDetectionRules(projectId, hostId, { limit: 100 });
      if (source !== hostId) return;
      itemsLoading = false;
      if (res.error) itemsError = res.error.error;
      else items = (res.data?.rules ?? []).filter((r: DetectionRule) => !r.built_in).map((r) => ({ id: r.id, name: r.name, action: r.action, enabled: r.enabled, enforcing: false }));
    }
    picked = picked.filter((id) => items.some((i) => i.id === id));
  }

  function chooseSource(hostId: string) {
    source = hostId;
    picked = [];
    items = [];
    selected = selected.filter((id) => id !== hostId);
    if (hostId) void loadItems(hostId);
  }

  const sourceOptions = $derived(sortHosts(fleet.filter((h) => h.status !== 'revoked' && (kind === 'rules' || h.protection.agents.host))));
  const sourceChoices = $derived([{ value: '', label: 'Choose a host' }, ...sourceOptions.map((h) => ({ value: h.id, label: h.name }))]);
  const sourceHost = $derived(fleet.find((h) => h.id === source));
  const sourceName = $derived(sourceHost?.name ?? (source ? 'the source host' : ''));
  const pickedItems = $derived(items.filter((i) => picked.includes(i.id)));
  const enforcingCount = $derived(pickedItems.filter((i) => i.enforcing).length);
  const sourceProblem = $derived(!source ? 'Choose the source host.' : !picked.length ? `Choose at least one ${noun}.` : picked.length > 50 ? `Copy at most 50 ${nouns} at once.` : null);

  const candidates = $derived(fleet.filter((h) => h.status !== 'revoked' && h.id !== source));
  const targetCount = $derived(targetMode === 'label' ? (label ? hostsWithLabel(candidates, label).length : 0) : selected.length);
  const targetsProblem = $derived(
    targetMode === 'label' ? (!label ? 'Choose a label.' : targetCount === 0 ? 'No other host carries this label.' : null) : selected.length ? null : 'Select at least one host.',
  );
  const wouldIds = $derived(preview ? preview.results.filter((r) => r.status === 'would_apply').map((r) => r.host_id) : []);
  const phrase = $derived(hostCountPhrase(wouldIds.length));
  const typedTier = tierFor('copy-runtime-to-hosts') === 'typed';
  const confirmed = $derived(!typedTier || typedConfirmationMatches(typed, phrase));
  const dirty = $derived(step !== 'results' && (picked.length > 0 || selected.length > 0));

  function hostName(id: string): string {
    return fleet.find((h) => h.id === id)?.name ?? preview?.results.find((r) => r.host_id === id)?.host_name ?? '';
  }

  async function goTo(next: Step, keepError = false) {
    if (!keepError) error = null;
    step = next;
    await tick();
    heading?.focus();
  }

  function requestError(err: { error: string; code?: string; matched?: number }): string {
    switch (err.code) {
      case 'APPLY_IN_PROGRESS': return 'Another apply is running in this project. Try again when it has finished.';
      case 'TOO_MANY_TARGETS': return `The label matches ${err.matched ?? 'more than 1,000'} hosts; one copy takes at most 1,000.`;
      case 'NO_TARGETS': return 'No host carries this label any more.';
      case 'NO_HOST_AGENT': return `${sourceName} has no host agent, so it has no policies to copy.`;
      case 'POLICY_NOT_FOUND':
      case 'RULE_NOT_FOUND': return `One of the ${nouns} no longer exists on ${sourceName}. Go back and choose again.`;
      case 'BUILTIN_RULE': return 'Built-in rules exist on every host and cannot be copied; enable or disable them per host.';
      case 'HOST_NOT_FOUND': return 'One of the hosts no longer exists in this project; nothing was changed.';
      case 'SOURCE_CHANGED': return SOURCE_CHANGED_TEXT;
      default: return err.error || 'The request was refused.';
    }
  }

  const SOURCE_CHANGED_TEXT = $derived(`The source host's ${kind === 'policies' ? 'policies' : 'detection rules'} changed after the dry run. Run the dry run again.`);

  /** The source changed since the dry run (409 SOURCE_CHANGED): back to the dry-run step, preview dropped. */
  async function sourceChanged(appliedSoFar: number) {
    preview = null;
    result = null;
    typed = '';
    await goTo('preview');
    error = SOURCE_CHANGED_TEXT;
    if (appliedSoFar) toast.warning(`${hostCountPhrase(appliedSoFar)} had already received the copy before the change was noticed; the new dry run shows them.`, 'Partly copied');
  }

  async function send(ids: readonly string[] | null, dryRun: boolean): Promise<HostApplyResponse | null> {
    // The real apply carries the digest of the source items the dry run read.
    const digest = dryRun ? undefined : (result?.source_digest ?? preview?.source_digest);
    const extra = digest ? { source_digest: digest } : {};
    const targetsList = ids ? chunkIds(ids).map((c) => ({ host_ids: c })) : targetMode === 'label' && label ? [{ label }] : chunkIds(selected).map((c) => ({ host_ids: c }));
    const responses: HostApplyResponse[] = [];
    for (const [i, targets] of targetsList.entries()) {
      const res = kind === 'policies'
        ? await applyTracePoliciesToHosts(projectId, { targets, source: { host_id: source, policy_ids: picked.map(Number) }, on_conflict: onConflict, dry_run: dryRun, ...extra })
        : await applyDetectionRulesToHosts(projectId, { targets, source: { host_id: source, rule_ids: picked }, on_conflict: onConflict, dry_run: dryRun, ...extra });
      if (res.error?.code === 'SOURCE_CHANGED') {
        await sourceChanged(responses.reduce((n, r) => n + r.summary.applied, 0));
        return null;
      }
      if (res.error || !res.data) {
        error = requestError(res.error ?? { error: 'No response from the server.' });
        if (dryRun) return null;
        // Chunks already sent stay copied: show them, and every host of this
        // and later chunks as failed (not sent) with the error.
        const unsent = targetsList.slice(i).flatMap((t) => ('host_ids' in t ? t.host_ids : []));
        return partialApplyResponse(responses, unsent, hostName, error);
      }
      responses.push(res.data);
    }
    return mergeApplyResponses(responses);
  }

  async function runDryRun() {
    if (busy || sourceProblem || targetsProblem) return;
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
    if (s.failed || s.skipped || error) toast.warning(`${s.applied} applied, ${s.failed} failed, ${s.skipped} skipped.`, 'Copied with problems');
    else toast.success(`${picked.length} ${picked.length === 1 ? noun : nouns} copied to ${hostCountPhrase(s.applied)}.`, 'Copied');
    // A refused later chunk keeps its error above the per-host results.
    await goTo('results', true);
  }

  async function retry(ids: string[]) {
    if (!result || retrying) return;
    retrying = true;
    error = null;
    const res = await send(ids, false);
    retrying = false;
    if (res) result = replaceResults(result, res);
  }

  function next() {
    if (step === 'source' && !sourceProblem) void goTo('targets');
    else if (step === 'targets') void runDryRun();
    else if (step === 'preview' && wouldIds.length) void goTo('confirm');
  }

  function back() {
    if (step === 'targets') void goTo('source');
    else if (step === 'preview') void goTo('targets');
    else if (step === 'confirm') void goTo('preview');
  }

  const stepIndex = $derived(STEPS.findIndex((s) => s.id === step));
  const title = $derived(kind === 'policies' ? 'Copy runtime policies to hosts' : 'Copy detection rules to hosts');
</script>

<Modal bind:this={modal} {open} {title} size="xl" placement="top" minHeight="40rem" {dirty} dismissible={!busy && !retrying} {onclose}>
  <div class="flow">
    <ol class="steps" aria-label="Steps">
      {#each STEPS as s, i (s.id)}
        <li class:done={i < stepIndex} class:current={i === stepIndex} aria-current={i === stepIndex ? 'step' : undefined}>{i + 1}. {s.label}</li>
      {/each}
    </ol>

    <h3 class="step-title" tabindex="-1" bind:this={heading}>
      {#if step === 'source'}What to copy?{:else if step === 'targets'}To which hosts?{:else if step === 'preview'}Dry run: what each host would do{:else if step === 'confirm'}Confirm{:else}Results{/if}
    </h3>

    {#if fleetLoading && !fleet.length && step !== 'results'}
      <Spinner label="Loading hosts…" layout="block" />
    {:else if fleetError && !fleet.length}
      <Alert tone="error" compact title="Hosts did not load" message={fleetError}>
        {#snippet actions()}<Button variant="secondary" size="sm" onclick={() => void loadHosts()}>Retry</Button>{/snippet}
      </Alert>
    {:else if step === 'source'}
      <div class="field">
        <label for={`${uid}-src`}>Source host</label>
        <Select id={`${uid}-src`} options={sourceChoices} value={source} onchange={(hostId) => chooseSource(hostId)} />
        {#if kind === 'policies'}<span class="hint">Only hosts with a host agent have enforcement policies.</span>{/if}
      </div>
      {#if source}
        {#if itemsLoading}
          <Spinner label={`Loading ${nouns}…`} />
        {:else if itemsError}
          <Alert tone="error" compact message={itemsError}>
            {#snippet actions()}<Button variant="secondary" size="sm" onclick={() => void loadItems(source)}>Retry</Button>{/snippet}
          </Alert>
        {:else if !items.length}
          <p class="hint">{sourceName} has no {kind === 'rules' ? 'custom detection rules (built-in rules exist on every host)' : 'enforcement policies'}.</p>
        {:else}
          <fieldset class="items">
            <legend class="legend">{kind === 'policies' ? 'Policies' : 'Custom rules'} on {sourceName}</legend>
            <ul>
              {#each items as item (item.id)}
                <li>
                  <label class="item">
                    <input type="checkbox" checked={picked.includes(item.id)} onchange={() => (picked = picked.includes(item.id) ? picked.filter((p) => p !== item.id) : [...picked, item.id])} />
                    <span class="item-name">{item.name}</span>
                    {#if kind === 'policies'}<Badge tone={enforcementTone(item.action)}>{item.action}</Badge>{:else}<Badge tone="neutral">{item.action}</Badge>{/if}
                    {#if !item.enabled}<span class="hint">disabled</span>{/if}
                  </label>
                </li>
              {/each}
            </ul>
          </fieldset>
        {/if}
      {/if}
      <fieldset class="conflict">
        <legend class="legend">When a target already has a {noun} with the same name</legend>
        <label><input type="radio" name={`${uid}-conflict`} value="skip" bind:group={onConflict} /> Keep the target's {noun} (skip)</label>
        <label><input type="radio" name={`${uid}-conflict`} value="replace" bind:group={onConflict} /> Replace it with this copy</label>
      </fieldset>
      {#if enforcingCount}
        <Alert tone="warning" compact message={`${enforcingCount} of the chosen policies kill processes. Each copy keeps its action and acknowledgement and enforces on every target host as soon as it is applied.`} />
      {/if}
    {:else if step === 'targets'}
      <p class="lead">Copying {pickedItems.length || picked.length} {(pickedItems.length || picked.length) === 1 ? noun : nouns} from {sourceName}{onConflict === 'replace' ? ', replacing same-named ones' : ''}.</p>
      <HostTargetsPicker hosts={fleet} bind:mode={targetMode} bind:selected bind:label excludeIds={source ? [source] : []} needsAgent={kind === 'policies'} />
    {:else if step === 'preview' && !preview}
      <p class="lead">Nothing has been written by this run. The dry run reads the source host again.</p>
    {:else if step === 'preview' && preview}
      <p class="lead">Nothing has been written yet.</p>
      <ApplyResultsTable response={preview} caption="Dry run result per host" />
      {#if !wouldIds.length}<Alert tone="warning" compact message="No host would change. Go back to adjust the hosts or the items." />{/if}
    {:else if step === 'confirm'}
      <p class="lead">Copy {picked.length} {picked.length === 1 ? noun : nouns} from {sourceName} to <strong>{phrase}</strong>. Hosts that failed or were skipped in the dry run are left out.{enforcingCount ? ` ${enforcingCount} of them kill processes.` : ''}</p>
      {#if typedTier}
        <label class="typed-label" for={`${uid}-typed`}>Type <strong>{phrase}</strong> to confirm</label>
        <input id={`${uid}-typed`} class="typed" type="text" bind:value={typed} autocomplete="off" spellcheck="false" onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void apply(); } }} />
      {/if}
    {:else if step === 'results' && result}
      <ApplyResultsTable response={result} caption="Copy result per host" onretry={retry} {retrying} />
    {/if}

    {#if error}<Alert tone="error" compact title="Not copied" message={error} />{/if}
  </div>

  {#snippet footer()}
    {#if step === 'results'}
      <Button variant="primary" onclick={onclose}>Done</Button>
    {:else}
      {#if step === 'source' && sourceProblem && source}<span class="problem">{sourceProblem}</span>{/if}
      {#if step === 'targets' && targetsProblem}<span class="problem">{targetsProblem}</span>{/if}
      <Button variant="ghost" disabled={busy} onclick={() => (step === 'source' ? modal?.requestClose() : back())}>{step === 'source' ? 'Cancel' : 'Back'}</Button>
      {#if step === 'confirm'}
        <Button variant="danger" loading={busy} disabled={!confirmed || !wouldIds.length} onclick={() => void apply()}>Copy to {phrase}</Button>
      {:else if step === 'targets' || (step === 'preview' && !preview)}
        <Button variant="primary" loading={busy} disabled={Boolean(targetsProblem || sourceProblem)} onclick={() => void runDryRun()}>{step === 'preview' ? 'Run dry run again' : 'Run dry run'}</Button>
      {:else}
        <Button variant="primary" disabled={step === 'source' ? Boolean(sourceProblem) : !wouldIds.length} onclick={next}>Next</Button>
      {/if}
    {/if}
  {/snippet}
</Modal>

<style>
  .flow { display: grid; gap: var(--sp-4); min-width: 0; }
  .steps { display: flex; flex-wrap: wrap; gap: var(--sp-2) var(--sp-4); margin: 0; padding: 0; list-style: none; font-size: var(--fs-xs); color: var(--text-muted); }
  .steps .done { color: var(--text-secondary); }
  .steps .current { color: var(--text-primary); font-weight: var(--fw-semibold); }
  .step-title { margin: 0; font-size: var(--fs-base); font-weight: var(--fw-semibold); color: var(--text-primary); }
  .step-title:focus-visible { outline: var(--ring-width) solid var(--ring-color); outline-offset: 2px; }
  .lead { margin: 0; font-size: var(--fs-sm); color: var(--text-secondary); line-height: 1.5; }
  .hint { font-size: var(--fs-xs); color: var(--text-muted); }
  .field { display: grid; gap: var(--sp-1); font-size: var(--fs-xs); color: var(--text-secondary); max-width: 26rem; }
  .typed {
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
  .typed { max-width: 20rem; }
  /* One sentence: the expected text stays inline. */
  .typed-label { display: block; margin-bottom: calc(-1 * var(--sp-2)); font-size: var(--fs-sm); color: var(--text-secondary); }
  .typed-label strong { color: var(--text-primary); font-weight: var(--fw-semibold); }
  .typed:focus-visible { outline: var(--ring-width) solid var(--ring-color); outline-offset: 1px; }
  .items, .conflict { margin: 0; padding: 0; border: 0; min-width: 0; }
  .legend { padding: 0; margin-bottom: var(--sp-2); font-size: var(--fs-xs); font-weight: var(--fw-medium); color: var(--text-secondary); }
  .items ul { display: grid; margin: 0; padding: 0; list-style: none; max-height: 16rem; overflow-y: auto; border: 1px solid var(--border); border-radius: var(--radius); }
  .items li + li { border-top: 1px solid var(--border); }
  .item { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); font-size: var(--fs-sm); cursor: pointer; }
  .item:hover { background: var(--bg-hover); }
  .item input, .conflict input { accent-color: var(--accent); }
  .item-name { font-weight: var(--fw-medium); color: var(--text-primary); overflow-wrap: anywhere; }
  .conflict { display: grid; gap: var(--sp-1); font-size: var(--fs-sm); color: var(--text-secondary); }
  .conflict label { display: inline-flex; align-items: center; gap: var(--sp-2); cursor: pointer; }
  .problem { margin-right: auto; font-size: var(--fs-xs); color: var(--text-muted); }
</style>
