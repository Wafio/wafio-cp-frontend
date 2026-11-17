<!--
  IpReputationSection: FireHOL IP reputation, checked by the WAF agent
  before a request is analysed. It works without the bot challenge; only a
  level set to Challenge needs the challenge, so that case is called out.
-->
<script lang="ts">
  import Alert from '#lib/components/ui/Alert.svelte';
  import PolicySection from './PolicySection.svelte';
  import ChoiceGroup from './ChoiceGroup.svelte';
  import Switch from '#lib/components/ui/Switch.svelte';
  import { sectionDomId } from './sections';
  import { fieldId } from './validate';
  import type { WafPolicyForm } from './waf-policy-form.svelte';

  let { form, readonly = false }: { form: WafPolicyForm; readonly?: boolean } = $props();

  const c = $derived(form.draft.challenge);
  // A level set to Challenge does nothing while the challenge is off.
  const idleLevels = $derived(
    c.ipRepEnabled && !c.enabled ? [!c.ipRepLevel1Block ? 'Level 1' : '', !c.ipRepLevel2Block ? 'Level 2' : ''].filter(Boolean) : []
  );

  const LEVEL_OPTIONS = [
    { value: true, label: 'Block (403)' },
    { value: false, label: 'Challenge' }
  ];
</script>

<PolicySection id="ip-reputation" title="IP reputation" description="Check each visitor's address against FireHOL threat-intelligence lists before the request is analysed. Works on its own: Bot challenge is only needed for a level set to Challenge." {form}>
  <div class="wp-stack">
    <Switch bind:checked={form.draft.challenge.ipRepEnabled} id={fieldId('challenge.ipRepEnabled')} disabled={readonly}
      label="Check visitors against threat-intelligence lists"
      hint="The WAF agent downloads the lists at start and checks every request before it is analysed." />
  </div>

  {#if c.ipRepEnabled}
    <div class="wp-grid wp-iprep-levels">
      <ChoiceGroup legend="Level 1: known malicious IPs" hint="Confirmed attack sources, botnets and exploit scanners. Block is recommended." name="wp-iprep-1" options={LEVEL_OPTIONS} bind:value={form.draft.challenge.ipRepLevel1Block} disabled={readonly} compact />
      <ChoiceGroup legend="Level 2: suspicious or datacenter IPs" hint="Wider lists with datacenter ranges and open proxies; may include legitimate VPN users and cloud services." name="wp-iprep-2" options={LEVEL_OPTIONS} bind:value={form.draft.challenge.ipRepLevel2Block} disabled={readonly} compact />
    </div>

    {#if idleLevels.length > 0}
      <Alert tone="warning" compact>
        {idleLevels.join(' and ')} {idleLevels.length > 1 ? 'are' : 'is'} set to Challenge, but Bot challenge is off, so these addresses are let through and only logged.
        Choose Block, or turn on <a href="#{sectionDomId('challenge')}">Bot challenge</a>.
      </Alert>
    {/if}

    <ul class="wp-note wp-iprep-notes">
      <li><strong>Monitor mode:</strong> nothing is blocked or challenged. An address a level blocks is recorded as monitor, one a level challenges is logged, and the request is forwarded.</li>
      <li><strong>Before access rules:</strong> addresses on an Access control allow list are checked too.</li>
      <li><strong>APIs and server-to-server clients</strong> cannot solve a challenge: use Block for the levels they could match.</li>
      <li><strong>Public IPv4 only:</strong> loopback, private and IPv6 addresses are never checked.</li>
    </ul>
  {/if}
</PolicySection>

<style>
  .wp-iprep-levels { margin: var(--sp-4) 0; }
  .wp-iprep-notes { display: flex; flex-direction: column; gap: var(--sp-1); margin-top: var(--sp-4); padding-left: var(--sp-5); }
</style>
