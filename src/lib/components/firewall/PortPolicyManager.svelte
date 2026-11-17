<!--
  PortPolicyManager: port-rule switch and default policies with the lockout
  guards. Edits the Settings draft; the hints
  update as you type, and the full lockout check runs again when you save.
-->
<script lang="ts">
  import './controls.css';
  import Button from '#lib/components/ui/Button.svelte';
  import Switch from '#lib/components/ui/Switch.svelte';
  import type { EBPFPortPolicy, EBPFPortPolicyConfig } from '#lib/api.js';
  import { egressAllows, guardedSSHPorts, permanentIngressAllows, portRuleLabel, sshAllowed } from './rules';

  let {
    value = $bindable<EBPFPortPolicyConfig>(),
    conntrack,
    portRules = [],
    sshPorts = null,
    disabled = false,
    onaddrule,
  }: {
    value: EBPFPortPolicyConfig;
    /** Connection tracking in the same draft. */
    conntrack: boolean;
    portRules?: readonly EBPFPortPolicy[];
    /** sshd ports the host agent reported; empty = 22. */
    sshPorts?: readonly number[] | null;
    disabled?: boolean;
    /** Opens Add rules for a port rule. */
    onaddrule: () => void;
  } = $props();

  const uid = $props.id();
  const ingressAllows = $derived(permanentIngressAllows(portRules));
  const sshOpen = $derived(sshAllowed(portRules, sshPorts));
  const sshText = $derived(guardedSSHPorts(sshPorts).map((p) => `${p}/tcp`).join(', '));
  const outbound = $derived(egressAllows(portRules));
  const ingressDeny = $derived(value.enabled && value.default_ingress === 'deny');
  const egressDeny = $derived(value.enabled && value.default_egress === 'deny');
</script>

<div class="ppm">
  <Switch bind:checked={value.enabled} {disabled} label="Apply port rules" hint="Evaluate the port rules in Access rules and the default policies below (ingress at XDP, egress at TC)." />

  <div class="ppm-defaults">
    <fieldset class="ppm-group" disabled={disabled || !value.enabled}>
      <legend>Ingress default <span class="fw-muted">(ports without a rule, new inbound connections)</span></legend>
      <div class="fw-segmented">
        <label><input type="radio" name={`${uid}-in`} value="allow" bind:group={value.default_ingress} />Allow all</label>
        <label><input type="radio" name={`${uid}-in`} value="deny" bind:group={value.default_ingress} />Deny all</label>
      </div>
    </fieldset>
    <fieldset class="ppm-group" disabled={disabled || !value.enabled}>
      <legend>Egress default <span class="fw-muted">(remote ports without a rule)</span></legend>
      <div class="fw-segmented">
        <label><input type="radio" name={`${uid}-out`} value="allow" bind:group={value.default_egress} />Allow all</label>
        <label><input type="radio" name={`${uid}-out`} value="deny" bind:group={value.default_egress} />Deny all</label>
      </div>
    </fieldset>
  </div>

  {#if ingressDeny}
    <ul class="ppm-checks" aria-label="Ingress deny all requirements">
      <li class:ok={conntrack} class:bad={!conntrack}>
        <strong>{conntrack ? 'Met' : 'Missing'}:</strong> connection tracking {conntrack ? 'is on' : 'is off. Turn it on under Protections'}.
      </li>
      <li class:ok={sshOpen} class:bad={!sshOpen}>
        <strong>{sshOpen ? 'Met' : 'Missing'}:</strong>
        {#if sshOpen}
          SSH ({sshText}) stays open{ingressAllows.length ? `; permanent ingress ALLOW rules: ${ingressAllows.map((rule) => portRuleLabel(rule)).join(', ')}` : ''}.
        {:else}
          no permanent ingress TCP ALLOW for the SSH port ({sshText}) that no other rule overrides, so SSH would be dropped and the control plane refuses Deny all.
          <Button variant="outline" size="sm" {disabled} onclick={onaddrule}>Add an SSH rule</Button>
        {/if}
      </li>
    </ul>
  {/if}
  {#if egressDeny}
    <p class="ppm-warn">
      {#if !conntrack}<strong>Missing:</strong> connection tracking is off. Egress Deny all needs it; turn it on under Protections.{/if}
      Replies to inbound connections (SSH sessions included), the agent's control-plane connection, DHCP client requests and IPv6 neighbour discovery always pass. Everything else outbound needs an egress ALLOW rule; allow DNS (53/udp) to keep name resolution working.
      {outbound.length ? `Outbound ports that stay open: ${outbound.map((rule) => portRuleLabel(rule)).join(', ')}.` : 'No egress ALLOW rule exists yet.'}
    </p>
  {/if}
</div>

<style>
  .ppm { display: grid; gap: var(--sp-4); }
  .ppm-defaults { display: flex; flex-wrap: wrap; gap: var(--sp-4) var(--sp-6); }
  .ppm-group { border: 0; margin: 0; padding: 0; min-width: 0; display: grid; gap: var(--sp-2); }
  .ppm-group legend { padding: 0; margin-bottom: var(--sp-2); font-size: var(--fs-xs); font-weight: var(--fw-medium); color: var(--text-secondary); }
  .ppm-group:disabled { opacity: 0.6; }
  .ppm-checks { display: grid; gap: var(--sp-2); margin: 0; padding: 0; list-style: none; font-size: var(--fs-xs); color: var(--text-secondary); line-height: 1.5; }
  .ppm-checks li { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); padding-left: var(--sp-3); border-left: 2px solid var(--border); }
  .ppm-checks li.ok { border-left-color: var(--success); }
  .ppm-checks li.ok strong { color: var(--success); }
  .ppm-checks li.bad { border-left-color: var(--danger); }
  .ppm-checks li.bad strong { color: var(--danger); }
  .ppm-warn { margin: 0; padding-left: var(--sp-3); border-left: 2px solid var(--warning); font-size: var(--fs-xs); color: var(--text-secondary); line-height: 1.5; }
  .ppm-warn strong { color: var(--warning); }
</style>
