<script lang="ts">
  import { page } from '$app/state';
  import { base } from '#lib/paths.js';
  import { auth } from '#lib/stores/auth.js';
  import { appPath, parseProjectPath } from '#lib/shell-nav.js';
  import { usePageTitle } from '#lib/page-meta.svelte.js';

  const status = $derived(page.status);
  const notFound = $derived(status === 404);
  const heading = $derived(notFound ? 'Page not found' : status === 403 ? 'Access denied' : 'Something went wrong');
  const detail = $derived(
    notFound
      ? 'This address does not match a page in the control plane. It may have moved, or the link is incomplete.'
      : page.error?.message && page.error.message !== 'Internal error'
        ? page.error.message
        : 'The page could not be displayed. Reload it, or go back to a page you know.',
  );
  const project = $derived(parseProjectPath(appPath(page.url.pathname, base)));

  usePageTitle(() => heading);
</script>

<div class="error-page">
  <p class="status">Error {status}</p>
  <h1 class="page-title">{heading}</h1>
  <p class="detail">{detail}</p>
  <p class="path"><span>Requested</span> <code>{page.url.pathname}</code></p>
  <nav class="ways-back" aria-label="Ways back">
    {#if project && $auth.user}
      <a class="primary" href="{base}/projects/{encodeURIComponent(project.projectId)}">Go to the project Overview</a>
      <a href="{base}/projects">All projects</a>
    {:else if $auth.user}
      <a class="primary" href="{base}/projects">Go to projects</a>
    {:else}
      <a class="primary" href="{base}/login">Sign in</a>
    {/if}
    <button type="button" onclick={() => history.back()}>Go back to the previous page</button>
  </nav>
</div>

<style>
  .error-page {
    width: 100%;
    max-width: 640px;
    margin: 0 auto;
    padding: var(--sp-8) var(--page-gutter) var(--sp-7);
  }
  .status { margin: 0; font-size: var(--fs-sm); color: var(--text-muted); font-variant-numeric: tabular-nums; }
  .page-title { margin: var(--sp-2) 0 var(--sp-3); font-size: var(--fs-2xl); font-weight: var(--fw-semibold); }
  .detail { margin: 0 0 var(--sp-4); color: var(--text-secondary); line-height: 1.6; }
  .path { margin: 0 0 var(--sp-5); font-size: var(--fs-sm); color: var(--text-muted); overflow-wrap: anywhere; }
  .path code { color: var(--text-secondary); }
  .ways-back { display: flex; flex-wrap: wrap; gap: var(--sp-3); align-items: center; }
  .ways-back a, .ways-back button {
    display: inline-flex;
    align-items: center;
    padding: var(--sp-2) var(--sp-4);
    border-radius: var(--radius);
    border: 1px solid var(--border-strong);
    background: transparent;
    color: var(--text-primary);
    font-size: var(--fs-base);
    text-decoration: none;
    cursor: pointer;
  }
  .ways-back a.primary { background: var(--accent); border-color: var(--accent); color: var(--text-on-accent); }
  .ways-back a:hover, .ways-back button:hover { background: var(--bg-hover); }
  .ways-back a.primary:hover { background: var(--accent-dim); border-color: var(--accent-dim); }
</style>
