<!--
  ReferenceListModal: read-only list in a native modal (built-in User-Agent
  and JA4 lists, ISO country codes). The list is loaded when the modal first
  opens and can be filtered.
-->
<script lang="ts" module>
  export interface ReferenceItem { value: string; note?: string }
</script>

<script lang="ts">
  import Modal from '#lib/components/ui/Modal.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Spinner from '#lib/components/ui/Spinner.svelte';
  import InlineError from '#lib/components/ui/InlineError.svelte';

  let {
    open = false,
    title,
    description,
    load,
    onclose
  }: {
    open?: boolean;
    title: string;
    description: string;
    /** Loads the entries; errors are shown with a retry. */
    load: () => Promise<{ items?: ReferenceItem[]; source?: string; error?: string }>;
    onclose: () => void;
  } = $props();

  let items = $state<ReferenceItem[] | null>(null);
  let source = $state('');
  let error = $state('');
  let loading = $state(false);
  let filter = $state('');

  async function fetchItems() {
    loading = true;
    error = '';
    try {
      const result = await load();
      if (result.error) error = result.error;
      else {
        items = result.items ?? [];
        source = result.source ?? '';
      }
    } catch {
      error = 'Could not load the list.';
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    if (open && items === null && !loading) void fetchItems();
  });

  const visible = $derived.by(() => {
    const q = filter.trim().toLowerCase();
    const list = items ?? [];
    return q ? list.filter((item) => item.value.toLowerCase().includes(q) || item.note?.toLowerCase().includes(q)) : list;
  });
</script>

<Modal {open} {title} size="lg" {onclose}>
  <p class="wp-ref-desc">{description}</p>
  {#if loading}
    <Spinner label="Loading list" layout="block" />
  {:else if error}
    <InlineError message={error} onretry={fetchItems} />
  {:else if items}
    <div class="wp-ref-toolbar">
      <label class="sr-only" for="wp-ref-filter">Filter {title}</label>
      <input id="wp-ref-filter" type="search" placeholder="Filter" bind:value={filter} autocomplete="off" />
      <span class="wp-ref-count" aria-live="polite">{visible.length} of {items.length} entries{source ? ` · ${source}` : ''}</span>
    </div>
    {#if items.length === 0}
      <p class="wp-ref-desc">The server returned no entries.</p>
    {:else}
      <ul class="wp-ref-list">
        {#each visible as item, index (`${item.value}-${index}`)}
          <li><code>{item.value}</code>{#if item.note}<span>{item.note}</span>{/if}</li>
        {/each}
      </ul>
    {/if}
  {/if}
  {#snippet footer()}
    <Button variant="secondary" onclick={onclose}>Close</Button>
  {/snippet}
</Modal>

<style>
  .wp-ref-desc { margin: 0 0 var(--sp-3); font-size: var(--fs-sm); line-height: 1.55; color: var(--text-secondary); }
  .wp-ref-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-3); margin-bottom: var(--sp-3); }
  .wp-ref-toolbar input {
    flex: 1 1 14rem;
    min-width: 0;
    padding: var(--sp-2) var(--sp-3);
    background: var(--surface-input);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    color: var(--text-primary);
    font-size: var(--fs-base);
  }
  .wp-ref-toolbar input:focus-visible { outline: var(--ring-width) solid var(--ring-color); outline-offset: 1px; }
  .wp-ref-count { font-size: var(--fs-xs); color: var(--text-muted); }
  .wp-ref-list { list-style: none; margin: 0; padding: 0; max-height: 50vh; overflow-y: auto; border: 1px solid var(--border); border-radius: var(--radius); }
  .wp-ref-list li { display: flex; flex-wrap: wrap; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); border-bottom: 1px solid var(--border); font-size: var(--fs-sm); }
  .wp-ref-list li:last-child { border-bottom: 0; }
  .wp-ref-list code { font-family: var(--font-mono); color: var(--text-primary); overflow-wrap: anywhere; }
  .wp-ref-list span { color: var(--text-muted); }
</style>
