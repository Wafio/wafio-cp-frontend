<!--
  ContentScanSection: the request body size limit and malicious upload scanning
  (content_scan: exact SHA-256 matches against the agent's hash database).
-->
<script lang="ts">
  import Field from '#lib/components/ui/Field.svelte';
  import PolicySection from './PolicySection.svelte';
  import Switch from '#lib/components/ui/Switch.svelte';
  import Select from '#lib/components/ui/Select.svelte';
  import ByteSizeInput from './ByteSizeInput.svelte';
  import { splitLines } from './model';
  import { fieldId } from './validate';
  import type { WafPolicyForm } from './waf-policy-form.svelte';

  let { form, readonly = false }: { form: WafPolicyForm; readonly?: boolean } = $props();

  const cs = $derived(form.draft.contentScan);
  type ScanMode = typeof cs.mode;
  type OnIncomplete = typeof cs.onIncomplete;
  // A policy saved with the scan disabled keeps showing that value.
  const modeOptions = $derived<{ value: ScanMode; label: string }[]>([
    { value: 'block', label: 'Block upload' },
    { value: 'log', label: 'Log only' },
    ...(cs.mode === 'disabled' ? [{ value: 'disabled' as const, label: 'Scan disabled (saved value)' }] : []),
  ]);
  const ON_INCOMPLETE: { value: OnIncomplete; label: string }[] = [
    { value: 'log', label: 'Forward and log (recommended)' },
    { value: 'block', label: 'Reject upload' },
    { value: 'allow', label: 'Forward with scan details' },
  ];
  const hashes = (text: string) => {
    const n = splitLines(text, { comments: true }).length;
    return n === 0 ? 'None' : `${n} ${n === 1 ? 'hash' : 'hashes'}`;
  };
</script>

<PolicySection id="uploads" title="Uploads and body size" description="Reject oversized request bodies and check uploaded files against known malware hashes." {form}>
  <div class="wp-grid">
    <Field
      label="Request body limit"
      hint="Requests with a larger body are blocked before inspection. Empty = no size limit is enforced. Up to 1 GiB."
      error={form.error('bodyLimit')}
      id={fieldId('bodyLimit')}
      optional
    >
      {#snippet children(c)}<ByteSizeInput {...c} bind:value={form.draft.bodyLimit} emptyLabel="No limit" placeholder="5" disabled={readonly} />{/snippet}
    </Field>
  </div>

  <h4 class="wp-subhead">Malicious uploads</h4>
  <Switch bind:checked={form.draft.contentScan.enabled} id={fieldId('contentScan.enabled')} disabled={readonly}
    label="Scan uploads for known malware"
    hint="Uses the signature database on each WAF agent. Detection needs an exact SHA-256 match; without a downloaded database only the EICAR test signature is known." />

  {#if cs.enabled}
    <div class="wp-uploads">
      <div class="wp-grid">
        <Field label="When malware is detected" hint="Block answers 403; Log only records the detection and forwards the upload." id={fieldId('contentScan.mode')}>
          {#snippet children(c)}
            <Select {...c} options={modeOptions} bind:value={form.draft.contentScan.mode} disabled={readonly} />
          {/snippet}
        </Field>
        <Field label="When scanning is incomplete" hint="A scan can stop at the budget or on an error. Log only mode always forwards; a decompression-budget skip is at most logged." id={fieldId('contentScan.onIncomplete')}>
          {#snippet children(c)}
            <Select {...c} options={ON_INCOMPLETE} bind:value={form.draft.contentScan.onIncomplete} disabled={readonly} />
          {/snippet}
        </Field>
        <Field
          label="Scan budget per request"
          hint="Shared by every file and field in one request; files past the budget are not scanned. Default 10 MiB, at most 100 MiB."
          error={form.error('contentScan.maxBytes')}
          id={fieldId('contentScan.maxBytes')}
          required
        >
          {#snippet children(c)}<ByteSizeInput {...c} bind:value={form.draft.contentScan.maxBytes} disabled={readonly} />{/snippet}
        </Field>
        <div class="wp-stack">
          <Switch bind:checked={form.draft.contentScan.multipart} id={fieldId('contentScan.multipart')} disabled={readonly} label="Multipart file uploads" hint="Check each file sent through a form." />
          <Switch bind:checked={form.draft.contentScan.rawBody} id={fieldId('contentScan.rawBody')} disabled={readonly} label="Raw request bodies" hint="Check the whole body of other requests, whatever the content type." />
        </div>
      </div>
      <p class="wp-note wp-muted">Archives are checked without extraction. A file without a hash match is not guaranteed to be safe.</p>

      <h4 class="wp-subhead">Your hash lists <small>optional, SHA-256</small></h4>
      <div class="wp-grid">
        <Field label="Blocked hashes" hint="Extra hashes to treat as malware in this policy, one per line; # starts a comment. {hashes(cs.blocklist)}." error={form.error('contentScan.blocklist')} id={fieldId('contentScan.blocklist')}>
          {#snippet children(c)}<textarea {...c} class="wp-textarea is-short" rows="3" spellcheck="false" placeholder="One SHA-256 hash per line" bind:value={form.draft.contentScan.blocklist} disabled={readonly}></textarea>{/snippet}
        </Field>
        <Field label="Allowed hashes" hint="Matching files are never reported as malware; takes precedence over the blocked list. {hashes(cs.allowlist)}." error={form.error('contentScan.allowlist')} id={fieldId('contentScan.allowlist')}>
          {#snippet children(c)}<textarea {...c} class="wp-textarea is-short" rows="3" spellcheck="false" placeholder="One SHA-256 hash per line" bind:value={form.draft.contentScan.allowlist} disabled={readonly}></textarea>{/snippet}
        </Field>
      </div>
    </div>
  {/if}
</PolicySection>

<style>
  .wp-uploads { display: flex; flex-direction: column; gap: var(--sp-4); margin-top: var(--sp-4); min-width: 0; }
  .wp-uploads :global(.wp-subhead) { margin-bottom: 0; }
</style>
