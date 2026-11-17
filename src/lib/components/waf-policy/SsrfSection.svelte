<!--
  SsrfSection: destinations the SSRF engine treats as internal. The
  dashboard list and the agent-side file path are separate settings:
  the path is never copied into the list.
-->
<script lang="ts">
  import Field from '#lib/components/ui/Field.svelte';
  import PolicySection from './PolicySection.svelte';
  import { splitLines } from './model';
  import { fieldId } from './validate';
  import type { WafPolicyForm } from './waf-policy-form.svelte';

  let { form, readonly = false }: { form: WafPolicyForm; readonly?: boolean } = $props();

  const entries = $derived(splitLines(form.draft.ssrf.list, { comments: true }).length);
</script>

<PolicySection id="ssrf" title="SSRF destinations" description="Extra hosts the SSRF engine treats as internal targets, in addition to its built-in private and metadata ranges." {form}>
  <div class="wp-grid">
    <Field
      label="Blocked destinations"
      hint="One host, .suffix (matches every subdomain) or IP per line; lines starting with # are ignored. {entries === 0 ? 'None' : `${entries} ${entries === 1 ? 'entry' : 'entries'}`}. When this list has entries the agent uses it instead of the file below."
      error={form.error('ssrf.list')}
      id={fieldId('ssrf.list')}
      optional
    >
      {#snippet children(c)}
        <textarea {...c} class="wp-textarea" rows="4" spellcheck="false" placeholder={'.internal.example\n169.254.169.254'} bind:value={form.draft.ssrf.list} disabled={readonly}></textarea>
      {/snippet}
    </Field>
    <Field
      label="Blocklist file on the agent"
      hint="Absolute path of a file on each WAF agent host, one entry per line. Used only while the list above is empty."
      id={fieldId('ssrf.path')}
      optional
    >
      {#snippet children(c)}
        <input {...c} type="text" class="wp-mono" spellcheck="false" placeholder="/etc/wafio/ssrf-blocklist.txt" bind:value={form.draft.ssrf.path} disabled={readonly} />
      {/snippet}
    </Field>
  </div>
</PolicySection>
