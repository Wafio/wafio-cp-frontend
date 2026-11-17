<!--
  CustomRulesSummary: custom rules are managed on the Custom rules page (one
  editor with import, export, dry run and scripts); this section shows how
  many apply to the application and links there.
-->
<script lang="ts">
  import { base } from '#lib/paths.js';
  import { listCustomRules } from '#lib/api.js';
  import Button from '#lib/components/ui/Button.svelte';
  import InlineError from '#lib/components/ui/InlineError.svelte';
  import PolicySection from './PolicySection.svelte';
  import type { WafPolicyForm } from './waf-policy-form.svelte';

  let { form, projectId, appId }: { form: WafPolicyForm; projectId: string; appId: string } = $props();

  let total = $state<number | null>(null);
  let error = $state('');
  let loading = $state(false);
  let version = 0;

  async function load() {
    const token = ++version;
    const project = projectId, app = appId;
    loading = true;
    error = '';
    const res = await listCustomRules(project, app, { limit: 1 });
    if (token !== version) return;
    loading = false;
    if (res.data) total = res.data.total ?? res.data.rules?.length ?? 0;
    else error = res.error?.error ?? 'Could not load custom rules.';
  }

  $effect(() => {
    if (projectId && appId) void load();
    return () => { version++; };
  });

  const href = $derived(`${base}/projects/${projectId}/rules?app=${encodeURIComponent(appId)}`);
</script>

<PolicySection id="custom-rules" title="Custom rules" description="Your own conditions and scripts that run for this application alongside the WAF engines. They are saved on their own, not with this policy." {form}>
  <div class="wp-row-between">
    <p class="wp-note" aria-live="polite">
      {#if loading && total === null}Counting custom rules…
      {:else if total !== null}{total === 0 ? 'No custom rules apply to this application.' : `${total} custom ${total === 1 ? 'rule applies' : 'rules apply'} to this application.`}
      {/if}
    </p>
    <Button variant="secondary" size="sm" {href}>Manage custom rules</Button>
  </div>
  {#if error}<InlineError message={error} onretry={load} />{/if}
</PolicySection>
