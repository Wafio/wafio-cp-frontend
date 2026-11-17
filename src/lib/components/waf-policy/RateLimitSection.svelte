<!--
  RateLimitSection: repeat-offender blocking (block_policy) and the L7 HTTP
  flood limit (l7_flood). Both key clients by the same key fields.
-->
<script lang="ts">
  import Field from '#lib/components/ui/Field.svelte';
  import { formatDuration } from '#lib/format.js';
  import { KEY_FIELDS } from '#lib/validation.js';
  import PolicySection from './PolicySection.svelte';
  import Switch from '#lib/components/ui/Switch.svelte';
  import { fieldId } from './validate';
  import type { WafPolicyForm } from './waf-policy-form.svelte';

  let { form, readonly = false }: { form: WafPolicyForm; readonly?: boolean } = $props();

  const bp = $derived(form.draft.blockPolicy);
  const flood = $derived(form.draft.flood);
  const KEY_HINT = `Comma-separated: ${KEY_FIELDS.join(', ')}, or header:Header-Name.`;
  const duration = (seconds: number | null) => (typeof seconds === 'number' && seconds > 0 ? formatDuration(seconds, 's') : '');
</script>

<PolicySection id="rate-limits" title="Rate limits" description="Temporarily block clients that keep getting blocked, and cap how many requests one client can send." {form}>
  <h4 class="wp-subhead">Repeat offenders</h4>
  <Switch bind:checked={form.draft.blockPolicy.enabled} id={fieldId('blockPolicy.enabled')} disabled={readonly}
    label="Block clients that keep getting blocked"
    hint="After the given number of blocked requests, every request from the client is blocked for the duration. Active blocks are listed under Block window." />
  <div class="wp-grid wp-gap-top">
    <Field label="Block after (blocked requests)" hint="1 to 999." error={form.error('blockPolicy.afterN')} id={fieldId('blockPolicy.afterN')} required>
      {#snippet children(c)}<input {...c} type="number" min="1" max="999" step="1" bind:value={form.draft.blockPolicy.afterN} disabled={readonly} />{/snippet}
    </Field>
    <Field label="Block duration (seconds)" hint="1 second to 7 days (604,800). {duration(bp.durationSec)}" error={form.error('blockPolicy.durationSec')} id={fieldId('blockPolicy.durationSec')} required>
      {#snippet children(c)}<input {...c} type="number" min="1" max="604800" step="1" bind:value={form.draft.blockPolicy.durationSec} disabled={readonly} />{/snippet}
    </Field>
    <Field label="Client key" hint="{KEY_HINT} Empty = remote_addr." error={form.error('blockPolicy.keyFields')} id={fieldId('blockPolicy.keyFields')} class="wp-span-2">
      {#snippet children(c)}<input {...c} type="text" spellcheck="false" placeholder="remote_addr, user_agent" bind:value={form.draft.blockPolicy.keyFields} disabled={readonly} />{/snippet}
    </Field>
  </div>

  <h4 class="wp-subhead">HTTP flood</h4>
  <Switch bind:checked={form.draft.flood.enabled} id={fieldId('flood.enabled')} disabled={readonly}
    label="Limit requests per client"
    hint="A client that sends more than the maximum within one period gets 403 until the period ends." />
  <div class="wp-grid wp-gap-top">
    <Field label="Maximum requests per period" hint="1–100,000." error={form.error('flood.maxRequests')} id={fieldId('flood.maxRequests')} required>
      {#snippet children(c)}<input {...c} type="number" min="1" max="100000" step="1" bind:value={form.draft.flood.maxRequests} disabled={readonly || !flood.enabled} />{/snippet}
    </Field>
    <Field label="Period (seconds)" hint="1 second to 24 hours (86,400). {duration(flood.windowSec)}" error={form.error('flood.windowSec')} id={fieldId('flood.windowSec')} required>
      {#snippet children(c)}<input {...c} type="number" min="1" max="86400" step="1" bind:value={form.draft.flood.windowSec} disabled={readonly || !flood.enabled} />{/snippet}
    </Field>
    <Field label="Client key" hint="{KEY_HINT} Empty = remote_addr." error={form.error('flood.keyFields')} id={fieldId('flood.keyFields')} class="wp-span-2">
      {#snippet children(c)}<input {...c} type="text" spellcheck="false" placeholder="remote_addr" bind:value={form.draft.flood.keyFields} disabled={readonly || !flood.enabled} />{/snippet}
    </Field>
    <Field label="Exempt clients" hint="IP addresses or CIDR ranges, one per line, such as your own servers calling the API. Not counted by the flood limit; every other check still applies." error={form.error('flood.allowIps')} id={fieldId('flood.allowIps')} class="wp-span-2">
      {#snippet children(c)}<textarea {...c} class="wp-textarea" rows="3" spellcheck="false" placeholder={'203.0.113.7\n10.0.0.0/8'} bind:value={form.draft.flood.allowIps} disabled={readonly || !flood.enabled}></textarea>{/snippet}
    </Field>
  </div>
</PolicySection>

<style>
  .wp-gap-top { margin-top: var(--sp-4); }
</style>
