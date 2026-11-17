<!--
  PoliciesView: Enforcement, Detection, Correlations and Templates as URL
  sections (?section=) under the Policies tab.
-->
<script lang="ts">
  import type { DetectionRule, EnforcementPolicy } from '#lib/api.js';
  import type { HostScope } from '#lib/host-scope.svelte.js';
  import Tabs from '#lib/components/ui/Tabs.svelte';
  import { tabDomIds } from '#lib/components/ui/tabs.js';
  import CorrelationRules from './CorrelationRules.svelte';
  import DetectionRules from './DetectionRules.svelte';
  import EnforcementPolicies from './EnforcementPolicies.svelte';
  import PolicyTemplates from './PolicyTemplates.svelte';
  import { POLICY_SECTIONS, type PolicySection } from './url';

  let {
    projectId,
    scope,
    section,
    canConfigure = false,
    canManage = false,
    policiesVersion = 0,
    rulesVersion = 0,
    onsection,
    oneditpolicy,
    oneditrule,
    onpoliciesimported,
  }: {
    projectId: string;
    scope: HostScope;
    section: PolicySection;
    canConfigure?: boolean;
    canManage?: boolean;
    policiesVersion?: number;
    rulesVersion?: number;
    onsection: (section: PolicySection) => void;
    oneditpolicy: (policy: EnforcementPolicy | null) => void;
    oneditrule: (rule: DetectionRule | null) => void;
    onpoliciesimported: () => void;
  } = $props();

  let value = $state<string>('enforcement');
  const panelIds = $derived(tabDomIds('runtime-policies', section));
  $effect.pre(() => {
    value = section;
  });
</script>

<!-- Panels follow the committed section (URL), like the page tabs. -->
<Tabs tabs={[...POLICY_SECTIONS]} bind:value onchange={(id) => onsection(id as PolicySection)} label="Policy sections" size="sm" id="runtime-policies" panels="external" />
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div class="section-body" role="tabpanel" id={panelIds.panel} aria-labelledby={panelIds.tab} tabindex="0">
      {#if section === 'enforcement'}
        <EnforcementPolicies {projectId} {scope} {canConfigure} version={policiesVersion} onedit={oneditpolicy} ontemplates={() => onsection('templates')} />
      {:else if section === 'detection'}
        <DetectionRules {projectId} {scope} {canConfigure} version={rulesVersion} onedit={oneditrule} />
      {:else if section === 'correlations'}
        <CorrelationRules {projectId} {canManage} />
      {:else if section === 'templates'}
        <PolicyTemplates {projectId} {scope} {canConfigure} onimported={onpoliciesimported} />
      {/if}
</div>

<style>
  .section-body { padding-top: var(--sp-4); min-width: 0; }
</style>
