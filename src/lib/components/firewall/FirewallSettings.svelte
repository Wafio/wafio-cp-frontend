<!--
  FirewallSettings: the Firewall "Settings" tab. One draft for the kernel
  firewall configuration and the port-rule defaults, a sticky save bar with the unsaved-change count, Discard and
  Save. Save runs the lockout check and the confirmation tier in the page;
  nothing here writes to the host directly.
-->
<script lang="ts">
  import './controls.css';
  import type { Snippet } from 'svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Alert from '#lib/components/ui/Alert.svelte';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Switch from '#lib/components/ui/Switch.svelte';
  import type { EBPFPortPolicy } from '#lib/api.js';
  import PortPolicyManager from './PortPolicyManager.svelte';
  import { MAX_PORT_SCAN_UNIQUE_PORTS, type SettingsDraft } from './settings';

  let {
    draft = $bindable<SettingsDraft>(),
    errors = {},
    changeCount = 0,
    saving = false,
    saveError = null,
    canConfigure = false,
    portRules = [],
    sshPorts = null,
    onsave,
    ondiscard,
    onaddrule,
  }: {
    draft: SettingsDraft;
    errors?: Record<string, string>;
    changeCount?: number;
    saving?: boolean;
    saveError?: string | null;
    canConfigure?: boolean;
    portRules?: readonly EBPFPortPolicy[];
    /** sshd ports the host agent reported; empty = 22. */
    sshPorts?: readonly number[] | null;
    onsave: () => void;
    ondiscard: () => void;
    onaddrule: () => void;
  } = $props();

  const uid = $props.id();
  const disabled = $derived(!canConfigure || saving);
  const errorCount = $derived(Object.keys(errors).length);
  const fieldId = (path: string) => `${uid}-${path.replace(/\W/g, '-')}`;
</script>

{#snippet toggle(checked: boolean, set: (value: boolean) => void, name: string, desc: string, extraDisabled = false)}
  <Switch {checked} label={name} hint={desc} disabled={disabled || extraDisabled} onchange={set} />
{/snippet}

{#snippet number(path: string, label: string, value: number, set: (value: number) => void, hint: string, attrs: { min?: number; max?: number; step?: number } = {}, extraDisabled = false)}
  <div class="num">
    <label class="num-label" for={fieldId(path)}>{label}</label>
    <input
      id={fieldId(path)}
      class="fw-input"
      type="number"
      inputmode="numeric"
      min={attrs.min ?? 0}
      max={attrs.max}
      step={attrs.step ?? 1}
      value={value}
      disabled={disabled || extraDisabled}
      oninput={(event) => set(event.currentTarget.value === '' ? Number.NaN : Number(event.currentTarget.value))}
      aria-invalid={errors[path] ? 'true' : undefined}
      aria-describedby={`${fieldId(path)}-hint${errors[path] ? ` ${fieldId(path)}-error` : ''}`}
    />
    <span id={`${fieldId(path)}-hint`} class="num-hint">{hint}</span>
    {#if errors[path]}<span id={`${fieldId(path)}-error`} class="num-error" role="alert">{errors[path]}</span>{/if}
  </div>
{/snippet}

{#snippet section(id: string, title: string, desc: string, body: Snippet)}
  <section class="fw-panel set-section" aria-labelledby={`${uid}-${id}`}>
    <div class="set-head">
      <h2 id={`${uid}-${id}`}>{title}</h2>
      <p class="fw-panel-sub">{desc}</p>
    </div>
    {@render body()}
  </section>
{/snippet}

<div class="settings">
  {#if !canConfigure}
    <Alert tone="info" compact message="Your role can view the firewall settings but not change them." />
  {/if}

  {#snippet modeBody()}
    <div class="toggles">
      {@render toggle(draft.config.global.enabled, (v) => (draft.config.global.enabled = v), 'Firewall enabled', 'Master switch for all XDP/TC filtering. Turning it off stops every rule on this host.')}
      {@render toggle(draft.config.global.monitor_only, (v) => (draft.config.global.monitor_only = v), 'Monitor only', 'Evaluate and log rules without dropping packets. Turn off to enforce.')}
    </div>
    <p class="mode-now">
      Result:
      {#if !draft.config.global.enabled}<Badge tone="neutral">Off</Badge> nothing is filtered.
      {:else if draft.config.global.monitor_only}<Badge tone="mode-monitor">Monitor-only</Badge> matches are logged, not dropped.
      {:else}<Badge tone="mode-block">Enforcing</Badge> matching packets are dropped.{/if}
    </p>
  {/snippet}
  {@render section('mode', 'Firewall mode', 'Changes here are confirmed with a lockout check before they are applied.', modeBody)}

  {#snippet protectionBody()}
    <div class="toggles">
      {@render toggle(draft.config.global.enable_conntrack, (v) => (draft.config.global.enable_conntrack = v), 'Connection tracking', 'Lets replies to connections this host opens back in. Required for ingress Deny all.')}
      {@render toggle(draft.config.global.enable_synflood, (v) => (draft.config.global.enable_synflood = v), 'SYN flood protection', 'Detect and mitigate SYN floods.')}
      {@render toggle(draft.config.global.enable_ratelimit, (v) => (draft.config.global.enable_ratelimit = v), 'Rate limiting', 'Per-source packet and byte rate limits (see Rate limiting below).')}
      {@render toggle(draft.config.global.enable_geoblock, (v) => (draft.config.global.enable_geoblock = v), 'Geo-blocking', 'Drop traffic from the countries in Access rules.')}
      {@render toggle(draft.config.global.log_allowed, (v) => (draft.config.global.log_allowed = v), 'Log allowed packets', 'Emit an event for every allowed packet (high volume).')}
      {@render toggle(draft.config.global.log_blocked, (v) => (draft.config.global.log_blocked = v), 'Log dropped packets', 'Emit an event for every dropped or would-drop packet.')}
    </div>
    <div class="nums">
      {@render number('global.max_payload_bytes', 'Maximum payload (bytes)', draft.config.global.max_payload_bytes, (v) => (draft.config.global.max_payload_bytes = v), '0 = no limit.', { step: 1024 })}
    </div>
  {/snippet}
  {@render section('protections', 'Protections and logging', 'Which kernel checks run and what the agent reports.', protectionBody)}

  {#snippet portBody()}
    <PortPolicyManager bind:value={draft.portPolicy} conntrack={draft.config.global.enable_conntrack} {portRules} {sshPorts} {disabled} {onaddrule} />
  {/snippet}
  {@render section('ports', 'Port rules and default policy', 'The rules themselves are listed in Access rules.', portBody)}

  {#snippet rateBody()}
    <div class="nums">
      {@render number('rate.window_ms', 'Window (ms)', draft.config.rate.window_ms, (v) => (draft.config.rate.window_ms = v), '0 = agent default, otherwise 10–60,000.')}
      {@render number('rate.max_pps', 'Max packets per second', draft.config.rate.max_pps, (v) => (draft.config.rate.max_pps = v), 'Per source; 0 = no limit.')}
      {@render number('rate.max_bps', 'Max bytes per second', draft.config.rate.max_bps, (v) => (draft.config.rate.max_bps = v), 'Per source, in bytes; 0 = no limit.')}
      {@render number('rate.max_syn_pps', 'Max SYN per second', draft.config.rate.max_syn_pps, (v) => (draft.config.rate.max_syn_pps = v), 'Per source; 0 = no limit.')}
      {@render number('rate.burst_pps', 'Burst packets', draft.config.rate.burst_pps, (v) => (draft.config.rate.burst_pps = v), 'Extra packets allowed per window.')}
      {@render number('rate.burst_syn', 'Burst SYN', draft.config.rate.burst_syn, (v) => (draft.config.rate.burst_syn = v), 'Extra SYN packets allowed per window.')}
    </div>
    <div class="toggles">
      {@render toggle(draft.config.rate.drop_on_limit, (v) => (draft.config.rate.drop_on_limit = v), 'Drop on limit', 'Drop packets over the limit; otherwise only count them.')}
    </div>
  {/snippet}
  {@render section('rate', 'Rate limiting', 'Applies when Rate limiting is on under Protections and logging.', rateBody)}

  {#snippet anomalyBody()}
    <div class="toggles">
      {@render toggle(draft.config.anomaly.detect_xmas, (v) => (draft.config.anomaly.detect_xmas = v), 'XMAS scan', 'TCP packets with FIN, PSH and URG set.')}
      {@render toggle(draft.config.anomaly.detect_null, (v) => (draft.config.anomaly.detect_null = v), 'NULL scan', 'TCP packets with no flags set.')}
      {@render toggle(draft.config.anomaly.detect_fin_only, (v) => (draft.config.anomaly.detect_fin_only = v), 'FIN-only scan', 'TCP packets with only FIN set.')}
      {@render toggle(draft.config.anomaly.drop_on_detect, (v) => (draft.config.anomaly.drop_on_detect = v), 'Drop on detect', 'Drop anomalous packets instead of only logging them.')}
    </div>
  {/snippet}
  {@render section('anomaly', 'Anomaly detection', 'Malformed TCP flag combinations used by scanners.', anomalyBody)}

  {#snippet scanBody()}
    <div class="toggles">
      {@render toggle(draft.config.port_scan.enabled, (v) => (draft.config.port_scan.enabled = v), 'Port scan detection', 'Count unique destination ports per source.')}
      {@render toggle(draft.config.port_scan.drop_on_detect, (v) => (draft.config.port_scan.drop_on_detect = v), 'Drop on detect', 'Drop packets from scanning sources; off = log only.', !draft.config.port_scan.enabled)}
    </div>
    <div class="nums">
      {@render number('port_scan.window_ms', 'Detection window (ms)', draft.config.port_scan.window_ms, (v) => (draft.config.port_scan.window_ms = v), '10–60,000 ms (default 10,000).', { min: 10, max: 60000, step: 1000 }, !draft.config.port_scan.enabled)}
      {@render number('port_scan.max_unique_ports', 'Unique ports before detection', draft.config.port_scan.max_unique_ports, (v) => (draft.config.port_scan.max_unique_ports = v), `1–${MAX_PORT_SCAN_UNIQUE_PORTS} ports per window (default 20).`, { min: 1, max: MAX_PORT_SCAN_UNIQUE_PORTS }, !draft.config.port_scan.enabled)}
    </div>
  {/snippet}
  {@render section('scan', 'Port scan detection', 'Reconnaissance: one source probing many ports in a short window.', scanBody)}

  <div class="savebar" role="region" aria-label="Unsaved settings">
    <div class="savebar-status" aria-live="polite">
      {#if saving}Saving…
      {:else if errorCount}<span class="savebar-error">{errorCount} {errorCount === 1 ? 'field needs' : 'fields need'} a fix</span>
      {:else if changeCount}{changeCount} unsaved {changeCount === 1 ? 'change' : 'changes'}
      {:else}No unsaved changes{/if}
    </div>
    {#if saveError}<Alert tone="error" compact title="Settings were not saved" message={saveError} />{/if}
    <div class="fw-row">
      <Button variant="ghost" disabled={!changeCount || saving} onclick={ondiscard}>Discard</Button>
      <Button variant="primary" disabled={disabled || !changeCount || errorCount > 0} loading={saving} onclick={onsave}>Review and save</Button>
    </div>
  </div>
</div>

<style>
  .settings { display: grid; gap: var(--sp-4); min-width: 0; }
  .set-section { display: grid; gap: var(--sp-4); }
  .set-head { display: grid; gap: var(--sp-1); }
  .set-head h2 { margin: 0; font-size: var(--fs-base); font-weight: var(--fw-semibold); }
  .set-head .fw-panel-sub:empty { display: none; }
  .toggles { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr)); gap: var(--sp-3) var(--sp-5); }
  .mode-now { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); margin: 0; font-size: var(--fs-sm); color: var(--text-secondary); }
  .nums { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 200px), 1fr)); gap: var(--sp-3) var(--sp-4); }
  .num { display: grid; gap: var(--sp-1); align-content: start; }
  .num-label { font-size: var(--fs-xs); font-weight: var(--fw-medium); color: var(--text-secondary); }
  .num-hint { font-size: var(--fs-xs); color: var(--text-muted); }
  .num-error { font-size: var(--fs-xs); color: var(--danger); }
  .savebar { position: sticky; bottom: 0; z-index: 2; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--sp-3); padding: var(--sp-3) var(--sp-4); border: 1px solid var(--border-strong); border-radius: var(--radius-lg); background: var(--bg-elevated); }
  .savebar-status { font-size: var(--fs-sm); color: var(--text-secondary); }
  .savebar-error { color: var(--danger); font-weight: var(--fw-medium); }
</style>
