<!--
  InspectionOptions: the two switches that change what is inspected at all, closed by default. Inspection off turns
  the detection engines off for every request; "Scan all request headers" widens or narrows the headers they read.
-->
<script lang="ts">
  import Switch from '#lib/components/ui/Switch.svelte';
  import { POLICY_INSPECTION_OFF } from '#lib/inspection.js';
  import { fieldId } from './validate';
  import type { WafPolicyForm } from './waf-policy-form.svelte';

  let { form, readonly = false }: { form: WafPolicyForm; readonly?: boolean } = $props();
</script>

<div class="wp-stack">
  <Switch bind:checked={form.draft.engines.inspectionOff} id={fieldId('engines.inspectionOff')} disabled={readonly}
    label={POLICY_INSPECTION_OFF.label} hint={POLICY_INSPECTION_OFF.hint} />
  <Switch bind:checked={form.draft.engines.scanAllHeaders} id={fieldId('engines.scanAllHeaders')} disabled={readonly || form.draft.engines.inspectionOff}
    label="Scan all request headers"
    hint="On by default. Off limits header analysis to User-Agent, Referer, Cookie, Origin and a redacted Authorization; requests that carry other headers are then flagged as not fully inspected." />
</div>
