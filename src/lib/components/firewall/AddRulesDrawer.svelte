<!--
  AddRulesDrawer: bulk add for every access-rule type. Pick a
  type, enter the values (IpListManager, GeoBlockManager or PortRuleForm),
  then Review: the review step is the confirmation, it says what will be
  added and what that does before anything is sent (simple tier).
  Typed input is guarded: closing with unsent values asks first.
  Multi-host mode (`multiHost`): `types` limits the rule
  types (no geo), the Ports field is always available (each host's agent is
  checked in the dry run that follows), and the review says "on N hosts";
  submitting hands the request to the caller without sending anything.
-->
<script lang="ts">
  import './controls.css';
  import Drawer from '#lib/components/ui/Drawer.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Alert from '#lib/components/ui/Alert.svelte';
  import IpListManager from './IpListManager.svelte';
  import GeoBlockManager from './GeoBlockManager.svelte';
  import PortRuleForm from './PortRuleForm.svelte';
  import AllowPortsField from './AllowPortsField.svelte';
  import {
    ACCESS_RULE_TYPES,
    accessRuleType,
    addWarnings,
    allowAddProblem,
    allowPortsLabel,
    parsePortScopes,
    describeAdd,
    parseAddressList,
    parseCountryCodes,
    parsePortInput,
    resolveTtl,
    type AccessRuleAdd,
    type AccessRuleType,
    type AddContext,
    type RuleAction,
    type RuleDirection,
    type TtlKey,
    type TtlUnit,
  } from './rules';

  let {
    open = false,
    initialType = 'block',
    initialText = '',
    context = {},
    blockedCountries = [],
    geoMode = 'block',
    allowedCountries = [],
    disabled = false,
    sshPorts = null,
    allowlistPortsSupported = false,
    types = undefined,
    multiHost = false,
    hostCount = undefined,
    onsubmit,
    onclose,
  }: {
    open?: boolean;
    /** Type selected when the drawer opens. */
    initialType?: AccessRuleType;
    /** Prefill for the address field (e.g. an address from Top sources of dropped traffic). */
    initialText?: string;
    context?: AddContext;
    blockedCountries?: readonly string[];
    /** Geo policy mode; in allow mode geo codes are added to the allowed countries. */
    geoMode?: 'block' | 'allow';
    allowedCountries?: readonly string[];
    /** Read-only role: the form is shown but cannot be sent. */
    disabled?: boolean;
    /** sshd ports the host reported (host_info.ssh_ports); empty = 22. Port presets of the allowlist. */
    sshPorts?: readonly number[] | null;
    /** The host enforces port-scoped allowlist entries; otherwise the Ports field stays on All ports. */
    allowlistPortsSupported?: boolean;
    /** Rule types offered (default: all). */
    types?: readonly AccessRuleType[];
    /** The rule is for several hosts: no per-host feature gate here, review names the host count. */
    multiHost?: boolean;
    /** Number of target hosts, for the multi-host review text. */
    hostCount?: number;
    /** Sends the request; resolves to an error message, or null on success. */
    onsubmit: (request: AccessRuleAdd) => Promise<string | null>;
    onclose: () => void;
  } = $props();

  const uid = $props.id();
  const typeOptions = $derived(types ? ACCESS_RULE_TYPES.filter((option) => types.includes(option.id)) : ACCESS_RULE_TYPES);
  // Multi-host: each target's agent is checked in the dry run, so scoped entries are always offered.
  const portsSupported = $derived(multiHost || allowlistPortsSupported);

  let type = $state<AccessRuleType>('block');
  let step = $state<'edit' | 'review'>('edit');
  let ipText = $state('');
  let geoText = $state('');
  let ports = $state('');
  let allowScope = $state<'all' | 'ports'>('all');
  let allowPortsText = $state('');
  let proto = $state('tcp');
  let direction = $state<RuleDirection>('ingress');
  let action = $state<RuleAction>('allow');
  let ttl = $state<TtlKey>('permanent');
  let ttlAmount = $state<number | ''>('');
  let ttlUnit = $state<TtlUnit>('hours');
  let busy = $state(false);
  let error = $state<string | null>(null);
  let drawer = $state<ReturnType<typeof Drawer>>();

  let wasOpen = false;
  $effect.pre(() => {
    if (open && !wasOpen) {
      type = types && !types.includes(initialType) ? (types[0] ?? 'block') : initialType;
      step = 'edit';
      error = null;
      if (initialText) ipText = initialText;
    }
    wasOpen = open;
  });

  function clear() {
    ipText = '';
    geoText = '';
    ports = '';
    allowScope = 'all';
    allowPortsText = '';
    ttl = 'permanent';
    ttlAmount = '';
    step = 'edit';
    error = null;
  }

  const isDirty = $derived(Boolean(ipText.trim() || geoText.trim() || ports.trim() || allowPortsText.trim()));

  const built = $derived.by((): { request: AccessRuleAdd | null; problem: string | null } => {
    if (type === 'block' || type === 'allow' || type === 'egress') {
      const parsed = parseAddressList(ipText);
      const expiry = resolveTtl(ttl, { amount: ttlAmount, unit: ttlUnit });
      if (!parsed.valid.length) return { request: null, problem: 'Enter at least one address.' };
      if (parsed.invalid.length) return { request: null, problem: 'Fix or remove the entries that are not valid.' };
      if (expiry.error) return { request: null, problem: expiry.error };
      if (type !== 'allow') return { request: { type, addresses: parsed.valid, ttlMs: expiry.ms }, problem: null };
      if (allowScope === 'all') return { request: { type, addresses: parsed.valid, ttlMs: expiry.ms }, problem: null };
      // Never widen a scoped add to every port when support disappears.
      if (!portsSupported) return { request: null, problem: 'This host does not enforce port-scoped entries; choose All ports or update the host agent.' };
      const scopes = parsePortScopes(allowPortsText);
      if (scopes.error) return { request: null, problem: scopes.error };
      const problem = allowAddProblem(parsed.valid, scopes.scopes);
      if (problem) return { request: null, problem };
      return { request: { type, addresses: parsed.valid, ttlMs: expiry.ms, ports: scopes.scopes }, problem: null };
    }
    if (type === 'geo') {
      const parsed = parseCountryCodes(geoText);
      if (!parsed.valid.length) return { request: null, problem: 'Enter at least one country code.' };
      if (parsed.invalid.length) return { request: null, problem: 'Fix or remove the codes that are not countries.' };
      return { request: { type: 'geo', codes: parsed.valid, allow: geoMode === 'allow' }, problem: null };
    }
    const parsed = parsePortInput(ports);
    const expiry = resolveTtl(ttl, { amount: ttlAmount, unit: ttlUnit });
    if (parsed.error) return { request: null, problem: parsed.error };
    if (expiry.error) return { request: null, problem: expiry.error };
    return { request: { type: 'port', ports: parsed.ports, proto, direction, action, ttlMs: expiry.ms }, problem: null };
  });

  const warnings = $derived(built.request ? addWarnings(built.request, context) : []);
  const reviewItems = $derived.by(() => {
    const request = built.request;
    if (!request) return [];
    if (request.type === 'geo') return request.codes;
    if (request.type === 'port') return request.ports.map((port) => `${port}/${request.proto}`);
    return request.addresses;
  });

  async function submit() {
    const request = built.request;
    if (!request || busy || disabled) return;
    busy = true;
    error = null;
    const result = await onsubmit(request);
    busy = false;
    if (result) {
      error = result;
      return;
    }
    clear();
    onclose();
  }
</script>

<Drawer
  bind:this={drawer}
  {open}
  title="Add access rules"
  size="md"
  dirty={isDirty && !busy}
  ondiscard={clear}
  dismissible={!busy}
  {onclose}
>
  <div class="add">
    {#if step === 'edit'}
      <fieldset class="add-types" {disabled}>
        <legend class="add-legend">Rule type</legend>
        <div class="fw-segmented add-type-options">
          {#each typeOptions as option (option.id)}
            <label>
              <input type="radio" name={`${uid}-type`} value={option.id} bind:group={type} />
              {option.label}
            </label>
          {/each}
        </div>
        <p class="add-desc">{accessRuleType(type).description}</p>
      </fieldset>

      {#if type === 'block' || type === 'allow' || type === 'egress'}
        <IpListManager kind={type} bind:text={ipText} bind:ttl bind:ttlAmount bind:ttlUnit {disabled} />
        {#if type === 'allow'}
          <AllowPortsField bind:mode={allowScope} bind:text={allowPortsText} {sshPorts} supported={portsSupported} {disabled} />
        {/if}
      {:else if type === 'geo'}
        <GeoBlockManager bind:text={geoText} mode={geoMode} blocked={geoMode === 'allow' ? allowedCountries : blockedCountries} geoEnabled={geoMode === 'allow' || (context.geoEnabled ?? true)} {disabled} />
      {:else}
        <PortRuleForm bind:ports bind:proto bind:direction bind:action bind:ttl bind:ttlAmount bind:ttlUnit {disabled} />
      {/if}
      {#if disabled}
        <Alert tone="info" compact message="Your role can view access rules but not change them." />
      {/if}
    {:else if built.request}
      <section class="review" aria-labelledby={`${uid}-review`}>
        <h3 id={`${uid}-review`} class="review-title">Review</h3>
        <p class="review-summary">{describeAdd(built.request)}{multiHost && hostCount !== undefined ? ` on ${hostCount} ${hostCount === 1 ? 'host' : 'hosts'}` : ''}.</p>
        {#if built.request.type === 'allow'}
          <p class="review-summary">Ports: <code class="fw-mono">{allowPortsLabel(built.request.ports)}</code></p>
        {/if}
        <ul class="review-items">
          {#each reviewItems.slice(0, 30) as item (item)}<li><code>{item}</code></li>{/each}
          {#if reviewItems.length > 30}<li class="fw-muted">and {reviewItems.length - 30} more</li>{/if}
        </ul>
        {#each warnings as warning (warning)}
          <Alert tone="warning" compact message={warning} />
        {/each}
        {#if multiHost}
          <p class="fw-muted review-note">Nothing is sent yet: a dry run next checks the rule on every target host with that host's own lockout guard and features.</p>
        {:else}
          <p class="fw-muted review-note">The rules are stored as the host's desired state and pushed to its agent; Configuration delivery under Data quality on Overview shows when the agent has applied them.</p>
        {/if}
      </section>
    {/if}
    {#if error}
      <Alert tone="error" title="Rules were not added" message={error} />
    {/if}
  </div>

  {#snippet footer()}
    {#if step === 'edit'}
      {#if built.problem && isDirty}<span class="add-problem">{built.problem}</span>{/if}
      <Button variant="ghost" onclick={() => drawer?.requestClose()} disabled={busy}>Cancel</Button>
      <Button variant="primary" disabled={disabled || !built.request} onclick={() => (step = 'review')}>
        Review {reviewItems.length ? `(${reviewItems.length})` : ''}
      </Button>
    {:else}
      <Button variant="ghost" onclick={() => (step = 'edit')} disabled={busy}>Back</Button>
      <Button variant="primary" loading={busy} disabled={disabled || !built.request} onclick={submit}>{multiHost ? 'Use this rule' : 'Add rules'}</Button>
    {/if}
  {/snippet}
</Drawer>

<style>
  .add { display: grid; gap: var(--sp-5); }
  .add-types { border: 0; margin: 0; padding: 0; min-width: 0; display: grid; gap: var(--sp-2); }
  .add-legend { padding: 0; margin-bottom: var(--sp-1); font-size: var(--fs-xs); font-weight: var(--fw-medium); color: var(--text-secondary); }
  .add-desc { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.5; }
  .add-problem { margin-right: auto; font-size: var(--fs-xs); color: var(--text-muted); }
  .review { display: grid; gap: var(--sp-3); }
  .review-title { margin: 0; font-size: var(--fs-base); font-weight: var(--fw-semibold); }
  .review-summary { margin: 0; font-size: var(--fs-sm); color: var(--text-primary); }
  .review-items { display: flex; flex-wrap: wrap; gap: var(--sp-2); margin: 0; padding: 0; list-style: none; }
  .review-items code { display: inline-block; padding: calc(var(--sp-1) / 2) var(--sp-2); border: 1px solid var(--border); border-radius: var(--radius); font-family: var(--font-mono); font-size: var(--fs-xs); }
  .review-note { margin: 0; font-size: var(--fs-xs); line-height: 1.5; }
</style>
