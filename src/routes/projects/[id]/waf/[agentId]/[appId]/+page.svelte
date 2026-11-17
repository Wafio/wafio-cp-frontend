<!--
  Old per-agent application URL. +page.ts redirects to the application page
  before this renders; the link is a fallback if the redirect cannot run.
-->
<script lang="ts">
  import { page } from '$app/state';
  import { base } from '#lib/paths.js';
  import { legacyAppRedirect } from '#lib/components/apps/app-page.js';

  const target = $derived(legacyAppRedirect(base, page.params.id ?? '', page.params.appId ?? '', page.url.search));
</script>

<div class="page">
  <p>This application has moved. <a href={target}>Open the application page</a>.</p>
</div>

<style>
  .page { padding: var(--page-top) var(--page-gutter) var(--sp-7); color: var(--text-secondary); font-size: var(--fs-base); }
  a { color: var(--accent); }
</style>
