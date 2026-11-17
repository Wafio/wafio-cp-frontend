<!--
  AccessSection: allow and block by client IP / CIDR range and by country.
  Geo decisions use the connection address only, never X-Forwarded-For.
-->
<script lang="ts">
  import Field from '#lib/components/ui/Field.svelte';
  import PolicySection from './PolicySection.svelte';
  import ReferenceListModal from './ReferenceListModal.svelte';
  import { splitLines } from './model';
  import { fieldId } from './validate';
  import type { WafPolicyForm } from './waf-policy-form.svelte';

  let {
    form,
    readonly = false,
    countries = []
  }: {
    form: WafPolicyForm;
    readonly?: boolean;
    /** ISO country codes and names from the server (for the reference list). */
    countries?: { code: string; name: string }[];
  } = $props();

  let showCountries = $state(false);

  const count = (text: string) => {
    const n = splitLines(text, { commas: true }).length;
    return n === 0 ? 'None' : `${n} ${n === 1 ? 'entry' : 'entries'}`;
  };

  const FIELDS = [
    { path: 'allowIps', label: 'Always allow these IPs', hint: 'IP addresses or CIDR ranges, one per line. Always allowed, even from a blocked country.', placeholder: '203.0.113.7\n10.0.0.0/8' },
    { path: 'blockIps', label: 'Block these IPs', hint: 'IP addresses or CIDR ranges, one per line. Rejected with 403.', placeholder: '198.51.100.0/24' },
    { path: 'allowCountries', label: 'Only allow these countries', hint: 'ISO 3166-1 alpha-2 codes, one per line. When set, every other country is rejected.', placeholder: 'ID\nSG' },
    { path: 'blockCountries', label: 'Block these countries', hint: 'ISO 3166-1 alpha-2 codes, one per line. Rejected with 403.', placeholder: 'RU' }
  ] as const;
</script>

<PolicySection id="access" title="Access control" description="Allow or block clients by address and by country before any inspection runs. Country is taken from the connection address, never from X-Forwarded-For." {form}>
  <div class="wp-grid">
    {#each FIELDS as field (field.path)}
      {@const path = `geo.${field.path}`}
      <Field label={field.label} hint="{field.hint} {count(form.draft.geo[field.path])}." error={form.error(path)} id={fieldId(path)}>
        {#snippet labelExtra()}
          {#if field.path === 'allowCountries' || field.path === 'blockCountries'}
            <button type="button" class="wp-link-button" onclick={() => (showCountries = true)}>Country codes</button>
          {/if}
        {/snippet}
        {#snippet children(c)}
          <textarea {...c} class="wp-textarea" rows="4" spellcheck="false" placeholder={field.placeholder} bind:value={form.draft.geo[field.path]} disabled={readonly}></textarea>
        {/snippet}
      </Field>
    {/each}
  </div>
</PolicySection>

<ReferenceListModal
  open={showCountries}
  title="Country codes (ISO 3166-1 alpha-2)"
  description="Use the two-letter code in the country lists, one per line."
  load={async () => (countries.length ? { items: countries.map((c) => ({ value: c.code, note: c.name })) } : { error: 'The country list has not loaded. Check your connection and retry.' })}
  onclose={() => (showCountries = false)}
/>
