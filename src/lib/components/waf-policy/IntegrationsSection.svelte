<!--
  IntegrationsSection: SIEM webhook delivery of BLOCK and LOG events.
  The URL is masked like a secret because it usually carries a token.
-->
<script lang="ts">
  import Field from '#lib/components/ui/Field.svelte';
  import PolicySection from './PolicySection.svelte';
  import Switch from '#lib/components/ui/Switch.svelte';
  import SecretInput from './SecretInput.svelte';
  import { isHiddenSecret } from '#lib/secret-redaction.js';
  import { fieldId } from './validate';
  import type { WafPolicyForm } from './waf-policy-form.svelte';

  let { form, readonly = false }: { form: WafPolicyForm; readonly?: boolean } = $props();
</script>

<PolicySection id="integrations" title="SIEM delivery" description="Send BLOCK and LOG events as JSON to a webhook for your SIEM or log collector." {form}>
  <div class="wp-stack">
    <Switch bind:checked={form.draft.siem.enabled} id={fieldId('siem.enabled')} disabled={readonly} label="Send events to a webhook" />
    <Field label="Webhook URL" hint="http or https URL that receives a POST per event. Masked because it often carries a token." error={form.error('siem.webhookUrl')} id={fieldId('siem.webhookUrl')} required={form.draft.siem.enabled}>
      {#snippet children(c)}<SecretInput {...c} label="webhook URL" placeholder="https://collector.example.com/wafio" bind:value={form.draft.siem.webhookUrl} disabled={readonly} hidden={isHiddenSecret(form.secrets?.secrets_redacted, form.secrets?.webhook_url_set, form.draft.siem.webhookUrl)} />{/snippet}
    </Field>
  </div>
</PolicySection>
