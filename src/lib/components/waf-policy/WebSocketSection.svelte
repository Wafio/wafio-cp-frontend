<!--
  WebSocketSection: per-application WebSocket inspection, origin check and
  message limits (0 = agent default: 64 KiB text, 1 MiB binary, 100/min).
-->
<script lang="ts">
  import Field from '#lib/components/ui/Field.svelte';
  import PolicySection from './PolicySection.svelte';
  import Switch from '#lib/components/ui/Switch.svelte';
  import ByteSizeInput from './ByteSizeInput.svelte';
  import { fieldId } from './validate';
  import type { WafPolicyForm } from './waf-policy-form.svelte';

  let { form, readonly = false }: { form: WafPolicyForm; readonly?: boolean } = $props();

  const w = $derived(form.draft.websocket);
</script>

<PolicySection id="websocket" title="WebSocket" description="Inspect WebSocket messages with the detection engines and limit their size and rate." {form}>
  <div class="wp-grid">
    <Switch bind:checked={form.draft.websocket.enabled} id={fieldId('websocket.enabled')} disabled={readonly} label="Inspect WebSocket messages" />
    <Switch bind:checked={form.draft.websocket.scanServerFrames} id={fieldId('websocket.scanServerFrames')} disabled={readonly || !w.enabled} label="Also scan messages from the server" />
    <Switch bind:checked={form.draft.websocket.scanBinaryHashes} id={fieldId('websocket.scanBinaryHashes')} disabled={readonly || !w.enabled} label="Check binary messages against malware hashes" hint="Needs the malware hash engine on the agent." />
    <Switch bind:checked={form.draft.websocket.originCheck} id={fieldId('websocket.originCheck')} disabled={readonly} label="Require an allowed Origin" hint="Rejects upgrades from browsers on other sites." />
    <Field label="Allowed origins" hint="One exact origin per line (scheme, host and port when not default); no paths or wildcards." error={form.error('websocket.origins')} id={fieldId('websocket.origins')} class="wp-span-2" required={w.originCheck}>
      {#snippet children(c)}<textarea {...c} class="wp-textarea is-short" rows="3" spellcheck="false" placeholder="https://app.example.com" bind:value={form.draft.websocket.origins} disabled={readonly}></textarea>{/snippet}
    </Field>
  </div>
  <h4 class="wp-subhead">Limits <small>0 = agent default</small></h4>
  <div class="wp-grid-3">
    <Field label="Maximum text message" hint="Default 64 KiB." error={form.error('websocket.maxTextBytes')} id={fieldId('websocket.maxTextBytes')}>
      {#snippet children(c)}<ByteSizeInput {...c} bind:value={form.draft.websocket.maxTextBytes} emptyLabel="Agent default" disabled={readonly} />{/snippet}
    </Field>
    <Field label="Maximum binary message" hint="Default 1 MiB." error={form.error('websocket.maxBinaryBytes')} id={fieldId('websocket.maxBinaryBytes')}>
      {#snippet children(c)}<ByteSizeInput {...c} bind:value={form.draft.websocket.maxBinaryBytes} emptyLabel="Agent default" disabled={readonly} />{/snippet}
    </Field>
    <Field label="Messages per minute" hint="Default 100." error={form.error('websocket.maxMessagesPerMin')} id={fieldId('websocket.maxMessagesPerMin')}>
      {#snippet children(c)}<input {...c} type="number" min="0" step="1" bind:value={form.draft.websocket.maxMessagesPerMin} disabled={readonly} />{/snippet}
    </Field>
  </div>
</PolicySection>
