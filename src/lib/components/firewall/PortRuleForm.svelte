<!--
  PortRuleForm: one or more port rules with the same protocol, direction,
  action and expiry. Ports are validated before anything is
  sent; the parent builds the request with parsePortInput().
-->
<script lang="ts">
  import './controls.css';
  import TtlPicker from './TtlPicker.svelte';
  import Select from '#lib/components/ui/Select.svelte';
  import { MAX_PORTS_PER_ADD, parsePortInput, type RuleAction, type RuleDirection, type TtlKey, type TtlUnit } from './rules';

  let {
    ports = $bindable(''),
    proto = $bindable('tcp'),
    direction = $bindable<RuleDirection>('ingress'),
    action = $bindable<RuleAction>('allow'),
    ttl = $bindable<TtlKey>('permanent'),
    ttlAmount = $bindable<number | ''>(''),
    ttlUnit = $bindable<TtlUnit>('hours'),
    disabled = false,
  }: {
    ports?: string;
    proto?: string;
    direction?: RuleDirection;
    action?: RuleAction;
    ttl?: TtlKey;
    ttlAmount?: number | '';
    ttlUnit?: TtlUnit;
    disabled?: boolean;
  } = $props();

  const uid = $props.id();
  const PROTO_OPTIONS = [
    { value: 'tcp', label: 'TCP' },
    { value: 'udp', label: 'UDP' },
    { value: 'any', label: 'Any protocol' },
  ];
  const DIRECTION_OPTIONS: { value: RuleDirection; label: string }[] = [
    { value: 'ingress', label: 'Ingress (to this host)' },
    { value: 'egress', label: 'Egress (from this host)' },
    { value: 'both', label: 'Both' },
  ];
  const ACTION_OPTIONS: { value: RuleAction; label: string }[] = [
    { value: 'allow', label: 'Allow' },
    { value: 'drop', label: 'Drop' },
    { value: 'log', label: 'Log only' },
  ];
  const parsed = $derived(parsePortInput(ports));
  const showError = $derived(ports.trim().length > 0 && parsed.error !== null);
</script>

<div class="prf">
  <div class="prf-field">
    <label class="prf-label" for={`${uid}-ports`}>Ports</label>
    <input
      id={`${uid}-ports`}
      class="fw-input prf-ports"
      type="text"
      inputmode="numeric"
      bind:value={ports}
      {disabled}
      autocomplete="off"
      placeholder="22, 443"
      aria-describedby={`${uid}-hint${showError ? ` ${uid}-error` : ''}`}
      aria-invalid={showError ? 'true' : undefined}
    />
    <p id={`${uid}-hint`} class="prf-hint">1–65535, separated by commas or spaces; up to {MAX_PORTS_PER_ADD} ports per add.</p>
    {#if showError}<p id={`${uid}-error`} class="prf-error" role="alert">{parsed.error}</p>{/if}
  </div>

  <div class="prf-grid">
    <div class="prf-field">
      <label class="prf-label" for={`${uid}-proto`}>Protocol</label>
      <Select id={`${uid}-proto`} options={PROTO_OPTIONS} bind:value={proto} {disabled} />
    </div>
    <div class="prf-field">
      <label class="prf-label" for={`${uid}-direction`}>Direction</label>
      <Select id={`${uid}-direction`} options={DIRECTION_OPTIONS} bind:value={direction} {disabled} />
    </div>
    <div class="prf-field">
      <label class="prf-label" for={`${uid}-action`}>Action</label>
      <Select id={`${uid}-action`} options={ACTION_OPTIONS} bind:value={action} {disabled} />
    </div>
  </div>
  <p class="prf-hint">Ingress rules match the port on this host; egress rules match the remote port. An ALLOW rule opens the port under Deny all; a permanent ingress ALLOW rule counts as management access.</p>

  <TtlPicker bind:value={ttl} bind:amount={ttlAmount} bind:unit={ttlUnit} {disabled} />
</div>

<style>
  .prf { display: grid; gap: var(--sp-4); }
  .prf-field { display: grid; gap: var(--sp-1); min-width: 0; }
  .prf-label { font-size: var(--fs-xs); font-weight: var(--fw-medium); color: var(--text-secondary); }
  .prf-ports { width: 100%; }
  .prf-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--sp-3); }
  @media (max-width: 480px) {
    .prf-grid { grid-template-columns: 1fr; }
  }
  .prf-hint { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.5; }
  .prf-error { margin: 0; font-size: var(--fs-xs); color: var(--danger); }
</style>
