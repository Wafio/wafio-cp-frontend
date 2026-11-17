<!--
  ResponsesSection: which of the six response pages use a custom template,
  in which format, and an editor for them (ResponseEditor, loaded on open).
-->
<script lang="ts">
  import Button from '#lib/components/ui/Button.svelte';
  import Badge from '#lib/components/ui/Badge.svelte';
  import PolicySection from './PolicySection.svelte';
  import ResponseEditor from './ResponseEditor.svelte';
  import { RESPONSE_PAGES, pageCustomized, pageFormat, templateKey, type ResponsePage } from './responses';
  import type { WafPolicyForm } from './waf-policy-form.svelte';

  let { form, readonly = false }: { form: WafPolicyForm; readonly?: boolean } = $props();

  let editorOpen = $state(false);
  let editorPage = $state<ResponsePage>('block');

  const responses = $derived(form.draft.responses);

  function open(page: ResponsePage) {
    editorPage = page;
    editorOpen = true;
  }

  function firstSentence(text: string): string {
    const end = text.indexOf('. ');
    return end === -1 ? text : text.slice(0, end + 1);
  }

  function status(page: ResponsePage): string {
    const format = pageFormat(responses, page);
    const custom = (responses[templateKey(page, format)] ?? '').trim() !== '';
    const label = format.toUpperCase();
    if (custom) return `Custom ${label}`;
    return pageCustomized(responses, page) ? `Built-in ${label} (custom templates kept for other formats)` : `Built-in ${label}`;
  }
</script>

<PolicySection id="responses" title="Custom responses" description="What visitors receive when a request is blocked or a challenge is shown. Empty templates use the built-in WAFio pages." {form}>
  <div class="wp-table-wrap">
    <table class="wp-table">
      <caption class="sr-only">Response pages</caption>
      <thead>
        <tr><th scope="col">Page</th><th scope="col" class="wp-resp-purpose-col">Shown when</th><th scope="col">Response</th><th scope="col"><span class="sr-only">Actions</span></th></tr>
      </thead>
      <tbody>
        {#each RESPONSE_PAGES as page (page.id)}
          {@const custom = pageCustomized(responses, page.id)}
          <tr>
            <th scope="row">{page.label}</th>
            <td class="wp-resp-purpose wp-resp-purpose-col">{firstSentence(page.purpose)}</td>
            <td class="wp-resp-status">{#if custom}<Badge tone="info">{status(page.id)}</Badge>{:else}<span class="wp-muted">{status(page.id)}</span>{/if}</td>
            <td class="wp-resp-action">
              <Button variant="secondary" size="sm" onclick={() => open(page.id)}>{readonly ? 'View' : 'Edit'}<span class="sr-only"> {page.label} response</span></Button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</PolicySection>

{#if editorOpen}
  <ResponseEditor open={true} {form} bind:page={editorPage} {readonly} onclose={() => (editorOpen = false)} />
{/if}

<style>
  .wp-resp-purpose { font-size: var(--fs-xs); color: var(--text-secondary); max-width: 32rem; }
  /* The badge text (e.g. "Custom HTML") otherwise wraps onto two lines once the
     column narrows past its content width; keep it one line like the Actions
     column already does, and let .wp-table-wrap's own horizontal scroll (see
     policy.css) take over on very narrow viewports instead of breaking words. */
  .wp-resp-status { white-space: nowrap; }
  .wp-resp-action { text-align: right; white-space: nowrap; }
  @media (max-width: 640px) { .wp-resp-purpose-col { display: none; } }
</style>
