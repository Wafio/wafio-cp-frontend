<!--
  ResponseEditor: native modal for the six custom response pages. Edits go
  straight into the policy draft (they are saved, reviewed and discarded with
  the policy), so closing never loses work. The code editor loads on first
  open; the preview is rebuilt shortly after typing stops.
-->
<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte';
  import Modal from '#lib/components/ui/Modal.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Tabs from '#lib/components/ui/Tabs.svelte';
  import { theme } from '#lib/stores/theme.js';
  import ChoiceGroup from './ChoiceGroup.svelte';
  import CodeEditor from './CodeEditor.svelte';
  import {
    RESPONSE_PAGES,
    CONTENT_TYPES,
    exampleTemplate,
    pageCustomized,
    pageFormat,
    pageMeta,
    previewDocument,
    PreviewScheduler,
    templateKey,
    type PreviewColors,
    type ResponsePage
  } from './responses';
  import type { ResponseFormat } from './model';
  import type { WafPolicyForm } from './waf-policy-form.svelte';

  let {
    open = false,
    form,
    page = $bindable<ResponsePage>('block'),
    readonly = false,
    onclose
  }: {
    open?: boolean;
    form: WafPolicyForm;
    page?: ResponsePage;
    readonly?: boolean;
    onclose: () => void;
  } = $props();

  const PREVIEW_DELAY_MS = 300;

  const responses = $derived(form.draft.responses);
  const meta = $derived(pageMeta(page));
  const format = $derived(pageFormat(responses, page));
  const key = $derived(templateKey(page, format));
  const content = $derived(responses[key] ?? '');

  const tabs = $derived(RESPONSE_PAGES.map((p) => ({ id: p.id, label: p.label, count: pageCustomized(responses, p.id) ? 'custom' : undefined })));
  const FORMAT_OPTIONS: { value: ResponseFormat; label: string }[] = [
    { value: 'html', label: 'HTML' },
    { value: 'json', label: 'JSON' },
    { value: 'xml', label: 'XML' }
  ];

  function setContent(next: string) {
    form.draft.responses[key] = next;
  }

  function setFormat(next: ResponseFormat) {
    if (meta.format) form.draft.responses.formats[meta.format] = next;
  }

  // Preview colours follow the dashboard theme.
  function readColors(): PreviewColors {
    const css = typeof document !== 'undefined' ? getComputedStyle(document.documentElement) : null;
    const v = (name: string, fallback: string) => css?.getPropertyValue(name).trim() || fallback;
    return {
      background: v('--bg-primary', 'Canvas'),
      text: v('--text-primary', 'CanvasText'),
      muted: v('--text-muted', 'GrayText'),
      border: v('--border', 'GrayText'),
      accent: v('--accent', 'LinkText'),
      font: v('--font-sans', 'system-ui, sans-serif'),
      mono: v('--font-mono', 'ui-monospace, monospace')
    };
  }

  let previewSrc = $state('');
  let previewPending = $state(false);

  // The dialog's srcdoc-blank-frame bug (see module doc): the iframe below is
  // remounted once, the first animation frame after this component's own
  // mount, so it never gets its first srcdoc while the host <dialog> is still
  // closed. `previewFrameEpoch` is only ever bumped by that one-shot effect;
  // the `{#key}` around the iframe is what forces the remount.
  let previewFrameEpoch = $state(0);

  // Debounced preview: rebuilt after typing pauses, immediately on page or format switch.
  // PreviewScheduler (responses.ts) owns the immediate-vs-debounced decision so it can be
  // unit tested with a fake clock instead of relying on real timers.
  const scheduler = new PreviewScheduler(PREVIEW_DELAY_MS);
  onDestroy(() => scheduler.dispose());
  $effect(() => {
    const target = `${page}/${format}`;
    const source = content;
    const currentPage = page;
    const currentFormat = format;
    const colors = readColors();
    void $theme;
    const ranImmediately = scheduler.schedule(target, () =>
      untrack(() => {
        previewSrc = previewDocument(source, currentPage, currentFormat, colors);
        previewPending = false;
      })
    );
    if (!ranImmediately) previewPending = true;
  });

  // Chrome (and other browsers) can leave the preview iframe blank forever: the modal
  // above assigns `srcdoc` on mount, in the same tick as the effect that just ran, which
  // is *before* the native <dialog> calls `showModal()` and becomes visible. An iframe
  // whose srcdoc was set while its ancestor was `display: none` is never painted, even
  // once the dialog opens with the exact same srcdoc still assigned. By the next
  // animation frame the dialog has definitely opened, so recreating the iframe then
  // (via the `{#key}` below) makes it paint correctly, without touching Modal.svelte.
  onMount(() => {
    const raf = requestAnimationFrame(() => {
      if (scheduler.markVisible()) previewFrameEpoch++;
    });
    return () => cancelAnimationFrame(raf);
  });
</script>

<Modal {open} title="Custom responses" maxWidth="min(1280px, 96vw)" initialFocus={'[role="tab"][aria-selected="true"]'} {onclose}>
  <div class="wp-re">
    <Tabs {tabs} bind:value={page} label="Response page" size="sm">
      {#snippet children(active)}
        {@const current = pageMeta(active as ResponsePage)}
        <div class="wp-re-panel">
          <div class="wp-re-meta">
            <p class="wp-note">{current.purpose}</p>
            <p class="wp-note wp-muted">
              Tokens:
              {#each current.tokens as token, i (token)}<code class="wp-re-token">{token}</code>{i < current.tokens.length - 1 ? ' ' : ''}{/each}
            </p>
          </div>
          {#if !current.htmlOnly}
            <div class="wp-re-format">
              <ChoiceGroup legend="Response format" name="wp-re-format" options={FORMAT_OPTIONS} value={format} onchange={setFormat} disabled={readonly} compact
                hint="The format the agent answers with for this page. Each format keeps its own template." />
              <span class="wp-re-ctype">Content-Type: <code>{CONTENT_TYPES[format]}</code></span>
            </div>
          {/if}
          <div class="wp-re-body">
            <div class="wp-re-pane">
              <div class="wp-re-pane-head">
                <span class="wp-re-pane-title">{format.toUpperCase()} template</span>
                <div class="wp-row">
                  {#if !content.trim() && !readonly}
                    <Button variant="ghost" size="sm" onclick={() => setContent(exampleTemplate(page, format))}>Insert example</Button>
                  {/if}
                  {#if content && !readonly}
                    <Button variant="ghost" size="sm" onclick={() => setContent('')}>Clear<span class="sr-only"> {current.label} {format.toUpperCase()} template</span></Button>
                  {/if}
                </div>
              </div>
              {#key `${active}/${format}`}
                <CodeEditor
                  language={format}
                  label="{current.label} {format.toUpperCase()} template"
                  {readonly}
                  placeholder="Empty: the built-in WAFio {format === 'html' ? 'page' : format.toUpperCase() + ' response'} is used."
                  bind:value={() => content, setContent}
                />
              {/key}
            </div>
            <div class="wp-re-pane">
              <div class="wp-re-pane-head">
                <span class="wp-re-pane-title">Preview</span>
                <span class="wp-muted wp-re-pane-sub" aria-live="polite">{previewPending ? 'Updating…' : format === 'html' ? 'Rendered with sample values' : 'Sample values filled in'}</span>
              </div>
              {#key previewFrameEpoch}
                <iframe class="wp-re-frame" title="Preview of the {current.label} response" srcdoc={previewSrc} sandbox="allow-scripts"></iframe>
              {/key}
            </div>
          </div>
        </div>
      {/snippet}
    </Tabs>
  </div>
  {#snippet footer()}
    <p class="wp-re-foot wp-muted">Templates are part of the policy draft; they apply after you save the policy.</p>
    <Button onclick={onclose}>Done</Button>
  {/snippet}
</Modal>

<style>
  .wp-re { min-width: 0; }
  .wp-re-panel { display: flex; flex-direction: column; gap: var(--sp-3); min-width: 0; }
  .wp-re-meta { display: flex; flex-direction: column; gap: var(--sp-1); }
  .wp-re-token { font-family: var(--font-mono); font-size: var(--fs-xs); padding: 0 var(--sp-1); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text-primary); background: var(--bg-secondary); }
  .wp-re-format { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--sp-3); }
  .wp-re-ctype { font-size: var(--fs-xs); color: var(--text-muted); padding-bottom: var(--sp-2); }
  .wp-re-ctype code { font-family: var(--font-mono); }
  /* Bounded, not just min-height: the templates centre their content with
     `min-height: 100vh`, so an unbounded pane grows to the full document
     height and the centred content sits far below the fold. Both columns
     (and each stacked pane on narrow widths) share the same capped height;
     the editor scrolls internally (CodeEditor.svelte) and the iframe fills
     it exactly. */
  .wp-re-body { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: var(--sp-4); }
  @media (max-width: 900px) { .wp-re-body { grid-template-columns: minmax(0, 1fr); } }
  .wp-re-pane { display: flex; flex-direction: column; gap: var(--sp-2); min-width: 0; height: min(60vh, 560px); min-height: 0; overflow: hidden; }
  .wp-re-pane-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--sp-2); min-height: 2rem; flex: 0 0 auto; }
  .wp-re-pane-title { font-size: var(--fs-sm); font-weight: var(--fw-semibold); color: var(--text-secondary); }
  .wp-re-pane-sub { font-size: var(--fs-xs); }
  .wp-re-frame { flex: 1 1 auto; width: 100%; height: 100%; min-height: 0; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-primary); }
  .wp-re-foot { margin: 0 auto 0 0; align-self: center; font-size: var(--fs-sm); }
</style>
