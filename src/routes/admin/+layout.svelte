<!--
  Administration shell: the same composition as the project shell (226px
  sidebar with a back link, an identity block and one labelled nav group),
  so moving between a project and administration keeps the layout. Each
  page owns its gutter; page titles match the labels below exactly.
-->
<script lang="ts">
  import { page } from '$app/state';
  import { goto, base } from '#lib/paths.js';
  import Icon from 'svelte-awesome/components/Icon.svelte';
  import chevronLeft from 'svelte-awesome/icons/chevronLeft';
  import history from 'svelte-awesome/icons/history';
  import envelope from 'svelte-awesome/icons/envelope';
  import database from 'svelte-awesome/icons/database';
  import paperPlane from 'svelte-awesome/icons/paperPlane';
  import users from 'svelte-awesome/icons/users';
  import hddO from 'svelte-awesome/icons/hddO';
  import { onMount } from 'svelte';
  import { auth, isAdmin } from '#lib/stores/auth.js';
  import Alert from '#lib/components/ui/Alert.svelte';
  import { storageAlert } from '#lib/storage-alert.svelte.js';
  import { alertMessage, alertTone, alertVisible } from '#lib/storage-retention.js';

  let { children }: { children: import('svelte').Snippet } = $props();

  // Signed-out visitors never get here: the root layout sends them to
  // /login?next=… first. Signed-in non-admins go back to their projects.
  $effect(() => {
    if (!$auth.inited || !$auth.user) return;
    if (!$isAdmin) goto('/projects', { replace: true });
  });

  const currentPath = $derived(page.url.pathname);

  const ITEMS = [
    { title: 'Users', path: '/admin/users', icon: users },
    { title: 'Invitations', path: '/admin/invites', icon: envelope },
    { title: 'Security data', path: '/admin/security-data', icon: database },
    { title: 'Email (SMTP)', path: '/admin/email', icon: paperPlane },
    { title: 'Data retention', path: '/admin/retention', icon: hddO },
    { title: 'Global audit log', path: '/admin/audit-log', icon: history },
  ];

  // Database disk pressure: fresh on entering Administration; the root
  // layout keeps polling it (every 5 min). Failures show nothing.
  onMount(() => {
    void storageAlert.refresh();
  });
  const storageWarn = $derived(alertVisible(storageAlert.current) ? storageAlert.current : null);
  const onRetention = $derived(isActive('/admin/retention'));

  function isActive(path: string): boolean {
    return currentPath === base + path || currentPath.startsWith(`${base}${path}/`);
  }
</script>

{#if $auth.inited && $isAdmin}
  <div class="admin-shell">
    <aside class="sidebar">
      <div class="proj">
        <a href="{base}/projects" class="proj-back">
          <Icon data={chevronLeft} scale={0.7} aria-hidden="true" />
          All projects
        </a>
        <div class="proj-info">
          <div class="proj-avatar" aria-hidden="true">A</div>
          <div class="proj-name">Administration</div>
        </div>
      </div>

      <nav class="admin-nav" aria-label="Administration">
        <div class="nav-group-title" aria-hidden="true">Instance</div>
        {#each ITEMS as item (item.path)}
          <a href="{base}{item.path}" class="nav-link" class:active={isActive(item.path)} aria-current={isActive(item.path) ? 'page' : undefined}>
            <span class="nav-ic-wrap" aria-hidden="true"><Icon data={item.icon} scale={0.95} /></span>
            <span class="nav-label">{item.title}</span>
          </a>
        {/each}
      </nav>
    </aside>

    <main class="main">
      {#if storageWarn}
        <!-- A standing notice, not a live region: the 5-min poll would
             re-announce it whenever a percentage moves. The region name
             makes it findable; the header indicator carries it on every page. -->
        <div class="storage-banner" role="region" aria-label="Database storage">
          <Alert role="none" tone={alertTone(storageWarn.level)} title={storageWarn.level === 'critical' ? 'Database storage critical' : 'Database storage warning'} message={alertMessage(storageWarn)}>
            {#snippet actions()}
              {#if !onRetention}<a href="{base}/admin/retention">Review data retention</a>{/if}
            {/snippet}
          </Alert>
        </div>
      {/if}
      {@render children()}
    </main>
  </div>
{/if}

<style>
  .admin-shell {
    display: grid;
    grid-template-columns: 226px minmax(0, 1fr);
    min-height: calc(100vh - var(--header-height));
    background: var(--bg-primary);
  }
  .sidebar {
    position: sticky;
    top: var(--header-height);
    height: calc(100vh - var(--header-height));
    /* Left: text starts on --page-gutter, under the header logo. */
    padding: var(--sp-5) var(--sp-3) var(--sp-5) calc(var(--page-gutter) - var(--sp-3));
    overflow-y: auto;
    background: var(--bg-secondary);
    border-right: 1px solid var(--border);
  }
  /* Inline padding = .nav-link's (one left edge with the group title). */
  .proj { padding: 0 var(--sp-3) var(--sp-5); margin-bottom: var(--sp-5); border-bottom: 1px solid var(--border); }
  .proj-back {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    margin-bottom: var(--sp-4);
    font-size: var(--fs-xs);
    color: var(--text-muted);
    text-decoration: none;
  }
  .proj-back:hover { color: var(--text-primary); }
  .proj-info { display: flex; align-items: center; gap: var(--sp-3); }
  .proj-avatar {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    flex-shrink: 0;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    background: var(--bg-hover);
    color: var(--accent-dim);
    font-size: var(--fs-xs);
    font-weight: var(--fw-semibold);
  }
  .proj-name { font-size: var(--fs-sm); font-weight: var(--fw-semibold); color: var(--text-primary); }
  /* Not `.nav`: app.css styles the header's `.nav` (fixed height, active
     underline, a full-screen overlay at <= 768px), and those rules would
     win over the scoped link padding here (the active item dropped ~4px). */
  .admin-nav { display: grid; gap: 2px; }
  .nav-group-title {
    margin: 0;
    padding: 0 var(--sp-3) var(--sp-2);
    font-size: var(--fs-sm);
    font-weight: var(--fw-semibold);
    color: var(--text-muted);
  }
  .nav-link {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: var(--sp-2) var(--sp-3);
    border-radius: var(--radius);
    color: var(--text-secondary);
    font-size: var(--fs-sm);
    text-decoration: none;
  }
  .nav-link:hover { background: var(--bg-hover); color: var(--text-primary); text-decoration: none; }
  .nav-link.active { background: var(--accent-soft); color: var(--accent-dim); font-weight: var(--fw-medium); }
  .nav-ic-wrap { display: flex; align-items: center; justify-content: center; width: 18px; color: var(--text-muted); }
  .nav-link.active .nav-ic-wrap { color: inherit; }
  .nav-label { min-width: 0; }
  /* Same gutter as the pages below it. */
  .storage-banner { padding: var(--page-top, 32px) var(--page-gutter, 24px) 0; }
  .main { min-width: 0; max-width: none; width: 100%; padding: 0; margin: 0; }

  @media (max-width: 820px) {
    .admin-shell { grid-template-columns: 1fr; }
    .sidebar { position: static; height: auto; padding: var(--sp-3) var(--sp-4); border-right: 0; border-bottom: 1px solid var(--border); }
    .proj { display: none; }
    .admin-nav { display: flex; gap: var(--sp-1); overflow-x: auto; }
    .nav-group-title { display: none; }
    .nav-link { flex-shrink: 0; white-space: nowrap; }
  }
</style>
