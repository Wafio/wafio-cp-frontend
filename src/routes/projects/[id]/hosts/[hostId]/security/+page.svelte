<!--
  Old host sub-route kept for bookmarks: /hosts/<id>/security opens the
  host-scoped Runtime security page (one implementation).
-->
<script lang="ts">
  import { page } from '$app/state';
  import { base } from '#lib/paths.js';
  import { goto } from '$app/navigation';
  import PageHeader from '#lib/components/ui/PageHeader.svelte';
  import Spinner from '#lib/components/ui/Spinner.svelte';

  const projectId = $derived(page.params.id ?? '');
  const hostId = $derived(page.params.hostId ?? '');
  const destination = $derived(`${base}/projects/${projectId}/host/trace?host=${encodeURIComponent(hostId)}`);
  $effect(() => {
    void goto(destination, { replace: true });
  });
</script>

<div class="page">
  <PageHeader title="Runtime security" subtitle="Opening the Runtime security page for this host." backHref={`${base}/projects/${projectId}/hosts/${hostId}`} backLabel="← Host" />
  <p class="note"><Spinner size="sm" /> Opening runtime security… <a href={destination}>Open runtime security for this host</a></p>
</div>

<style>
  .page { display: grid; gap: var(--sp-4); width: 100%; min-width: 0; box-sizing: border-box; padding: var(--page-top) var(--page-gutter) var(--sp-7); align-content: start; }
  .note { display: flex; align-items: center; gap: var(--sp-2); margin: 0; font-size: var(--fs-sm); color: var(--text-muted); }
  .note a { color: var(--accent); }
</style>
