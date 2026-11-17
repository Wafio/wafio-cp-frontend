<script lang="ts">
  import { base } from '#lib/paths.js';
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import Icon from 'svelte-awesome/components/Icon.svelte';
  import ban from 'svelte-awesome/icons/ban';
  import bolt from 'svelte-awesome/icons/bolt';
  import chevronLeft from 'svelte-awesome/icons/chevronLeft';
  import cog from 'svelte-awesome/icons/cog';
  import cubes from 'svelte-awesome/icons/cubes';
  import history from 'svelte-awesome/icons/history';
  import home from 'svelte-awesome/icons/home';
  import key from 'svelte-awesome/icons/key';
  import listAlt from 'svelte-awesome/icons/listAlt';
  import server from 'svelte-awesome/icons/server';
  import shield from 'svelte-awesome/icons/shield';
  import users from 'svelte-awesome/icons/users';
  import { getServerVersion } from '#lib/api.js';
  import { createProjectContext } from '#lib/project-context.svelte.js';
  import { projectRoleLabel } from '#lib/project-access.js';
  import { tryGetPageMeta } from '#lib/page-meta.svelte.js';
  import {
    PROJECT_NAV,
    activeNavItem,
    appPath,
    navItemMatches,
    parseProjectPath,
    projectBreadcrumbs,
    type NavIconId,
    type ProjectNavItem,
  } from '#lib/shell-nav.js';
  import { hostFromRoute, withHost } from '#lib/host-nav.js';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Button from '#lib/components/ui/Button.svelte';

  let { children } = $props();

  const ICONS: Record<NavIconId, typeof home> = {
    overview: home,
    applications: cubes,
    waf: shield,
    rules: listAlt,
    hosts: server,
    firewall: ban,
    runtime: bolt,
    settings: cog,
    credentials: key,
    members: users,
    audit: history,
  };

  const projectId = $derived(page.params.id ?? '');
  const path = $derived(appPath(page.url.pathname, base));
  const rel = $derived(parseProjectPath(path)?.rel ?? '');
  const root = $derived(`${base}/projects/${projectId}`);
  // Firewall / Runtime security links keep the host the current route is about
  // (?host= or /hosts/<id>); without one the page opens the remembered host.
  const routeHost = $derived(hostFromRoute(rel, page.url.searchParams));

  // One project + permissions request per project, shared with every page
  // below through getProjectContext().
  const projectContext = createProjectContext();
  $effect(() => {
    if (projectId) void projectContext.load(projectId);
  });

  const project = $derived(projectContext.project);
  const loading = $derived(projectContext.loading || (!project && !projectContext.error));
  /** 404/403: the project does not exist or is not the caller's (cross-tenant = 404). */
  const unavailable = $derived(!project && !projectContext.loading && (projectContext.error?.status === 404 || projectContext.error?.status === 403));
  const projectName = $derived(project?.name ?? '');
  const projectCode = $derived(project?.code ?? '');
  const shortCode = $derived(projectCode.length > 12 ? projectCode.slice(0, 12) + '…' : projectCode);
  const roleLabel = $derived(projectRoleLabel(projectContext.role));
  const roleHint = $derived(
    projectContext.role === 'owner' ? 'Owner: full access, including members and deletion'
      : projectContext.role === 'member' ? 'Member: can change configuration; deletion and members need an owner'
        : projectContext.role === 'viewer' ? 'Viewer: read-only access'
          : '',
  );

  // Title and breadcrumbs name the project and the entity a detail page shows.
  const meta = tryGetPageMeta();
  $effect(() => {
    if (!meta) return;
    meta.projectName = projectName || null;
  });
  $effect(() => () => { if (meta) meta.projectName = null; });
  // An unknown or foreign project is not an "Overview" (or any other page).
  const titleOwner = Symbol('project-unavailable');
  $effect(() => {
    if (!meta) return;
    if (unavailable) meta.setTitle(titleOwner, 'Project not found');
    else meta.clearTitle(titleOwner);
  });
  $effect(() => () => meta?.clearTitle(titleOwner));

  const active = $derived(activeNavItem(rel));
  const activeLabel = $derived(active?.item.label ?? 'Project');
  const crumbs = $derived(projectBreadcrumbs({
    base,
    projectId,
    rel,
    projectName: loading ? 'Loading…' : projectName || 'Project',
    details: meta?.details ?? [],
  }));

  let serverVersion = $state('');
  let navOpen = $state(false);
  $effect(() => { void path; navOpen = false; });
  onMount(() => {
    let alive = true;
    void getServerVersion().then((result) => { if (alive && result.data) serverVersion = result.data.version; });
    return () => { alive = false; };
  });

  function isCurrent(item: ProjectNavItem): boolean {
    return navItemMatches(item, rel) && !(item.children ?? []).some((child) => navItemMatches(child, rel));
  }
  function isAncestor(item: ProjectNavItem): boolean {
    return (item.children ?? []).some((child) => navItemMatches(child, rel));
  }
</script>

<svelte:window onkeydown={(event) => { if (event.key === 'Escape' && navOpen) navOpen = false; }} />

<div class="mobile-navigation">
  <button type="button" aria-expanded={navOpen} aria-controls="project-navigation" onclick={() => (navOpen = !navOpen)}>
    {navOpen ? 'Close project menu' : 'Project menu'} <span aria-hidden="true">{navOpen ? '−' : '+'}</span>
  </button>
  <span class="mobile-current">{activeLabel}{#if roleLabel}{' · '}{roleLabel}{/if}</span>
</div>
<div class="enterprise-shell">
  <aside class="sidebar" class:nav-open={navOpen} id="project-navigation" aria-label="Project">
    <div class="proj">
      <a href="{base}/projects" class="proj-back">
        <Icon data={chevronLeft} scale={0.7} />
        All projects
      </a>
      {#if projectName}
        <div class="proj-info">
          <div class="proj-avatar" aria-hidden="true">{projectName.charAt(0).toUpperCase()}</div>
          <div class="proj-details">
            <div class="proj-name" title={projectName}>{projectName}</div>
            {#if shortCode}<code class="proj-code" title={projectCode}>{shortCode}</code>{/if}
          </div>
        </div>
        {#if roleLabel}
          <p class="proj-role"><span class="sr-only">Your role:</span><Badge tone="neutral" title={roleHint}>{roleLabel}</Badge><span class="proj-role-hint">{projectContext.role === 'viewer' ? 'Read-only' : projectContext.role === 'member' ? 'Can configure' : 'Full access'}</span></p>
        {/if}
      {:else if loading}
        <p class="proj-loading" role="status">Loading project…</p>
      {:else}
        <p class="proj-loading">Project unavailable</p>
      {/if}
    </div>

    <nav class="project-nav" aria-label="Project navigation">
      {#each PROJECT_NAV as section (section.title)}
        <div class="nav-group">
          {#if section.title}<h2 class="nav-group-title">{section.title}</h2>{/if}
          <ul>
            {#each section.items as item (item.id)}
              <li>
                <a
                  href="{root}{item.path}"
                  class="nav-link"
                  class:active={isCurrent(item)}
                  class:ancestor={isAncestor(item)}
                  aria-current={isCurrent(item) ? 'page' : undefined}
                >
                  <span class="nav-ic-wrap" aria-hidden="true"><Icon class="nav-ic" data={ICONS[item.icon]} scale={0.95} /></span>
                  <span class="nav-label">{item.label}</span>
                </a>
                {#if item.children?.length}
                  <ul class="nav-children">
                    {#each item.children as child (child.id)}
                      <li>
                        <a
                          href={withHost(`${root}${child.path}`, child.hostScoped ? routeHost : '')}
                          class="nav-link nav-child"
                          class:active={navItemMatches(child, rel)}
                          aria-current={navItemMatches(child, rel) ? 'page' : undefined}
                        >
                          <span class="nav-ic-wrap" aria-hidden="true"><Icon class="nav-ic" data={ICONS[child.icon]} scale={0.85} /></span>
                          <span class="nav-label">{child.label}</span>
                        </a>
                      </li>
                    {/each}
                  </ul>
                {/if}
              </li>
            {/each}
          </ul>
        </div>
      {/each}
    </nav>

    {#if serverVersion}
      <div class="sidebar-version">WAFio {serverVersion}</div>
    {/if}
    <div class="sidebar-dbip">
      GeoIP by <a href="https://db-ip.com" target="_blank" rel="noopener noreferrer">DB-IP</a>
    </div>
  </aside>

  <div class="project-content">
    <nav class="breadcrumbs" aria-label="Breadcrumb">
      <ol>
        {#each crumbs as crumb, i (i)}
          <li>
            {#if crumb.href}
              <a href={crumb.href}>{crumb.label}</a>
            {:else}
              <span aria-current="page">{crumb.label}</span>
            {/if}
          </li>
        {/each}
      </ol>
    </nav>
    <main class="main" id="project-main">
      {#if unavailable}
        <div class="unavailable">
          <h1 class="page-title">Project not found</h1>
          <p>This project does not exist, or your account is not a member of it. Ask a project owner for an invitation if you expected access.</p>
          <Button variant="primary" href="{base}/projects">Go to projects</Button>
        </div>
      {:else}
        {#if projectContext.error && !project && !projectContext.loading}
          <div class="load-error" role="alert">
            <span>Project details failed to load: {projectContext.error.error}</span>
            <Button size="sm" variant="secondary" onclick={() => void projectContext.refresh()}>Retry</Button>
          </div>
        {/if}
        {@render children()}
      {/if}
    </main>
  </div>
</div>

<style>
  .enterprise-shell { display: grid; grid-template-columns: 226px minmax(0, 1fr); min-height: calc(100dvh - 56px); }
  .sidebar {
    background: var(--bg-secondary);
    border-right: 1px solid var(--border);
    /* Left: text of the nav links and the project block starts on
       --page-gutter, under the header logo (routes/+layout.svelte). */
    padding: var(--sp-5) var(--sp-3) var(--sp-4) calc(var(--page-gutter) - var(--sp-3));
    display: flex;
    flex-direction: column;
    position: sticky;
    top: 56px;
    height: calc(100dvh - 56px);
    overflow: auto;
  }
  /* Inline padding = .nav-link's, so the project block, the group titles and
     the link icons start on one line. */
  .proj { padding: var(--sp-3) var(--sp-3) var(--sp-4); border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); margin-bottom: var(--sp-5); }
  .proj-back { display: flex; gap: var(--sp-2); align-items: center; font-size: var(--fs-xs); color: var(--text-muted); text-decoration: none; margin-bottom: var(--sp-3); }
  .proj-back:hover { color: var(--text-primary); }
  .proj-info { display: flex; align-items: center; gap: var(--sp-2); }
  .proj-avatar {
    width: 30px;
    height: 30px;
    display: grid;
    place-items: center;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    background: var(--bg-hover);
    color: var(--accent-dim);
    flex-shrink: 0;
  }
  .proj-details { min-width: 0; }
  .proj-name { font-size: var(--fs-sm); font-weight: var(--fw-semibold); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .proj-code { font-size: var(--fs-xs); color: var(--text-muted); }
  .proj-role { display: flex; align-items: center; gap: var(--sp-2); margin: var(--sp-3) 0 0; }
  .proj-role-hint { font-size: var(--fs-xs); color: var(--text-muted); }
  .proj-loading { margin: 0; font-size: var(--fs-sm); color: var(--text-muted); }
  .project-nav { display: grid; gap: var(--sp-5); }
  .project-nav ul { list-style: none; margin: 0; padding: 0; }
  .nav-group-title {
    font-size: var(--fs-sm);
    font-weight: var(--fw-semibold);
    padding: 0 var(--sp-3) var(--sp-2);
    margin: 0;
    color: var(--text-muted);
  }
  .nav-link {
    display: flex;
    gap: var(--sp-2);
    align-items: center;
    padding: var(--sp-2) var(--sp-3);
    margin: 2px 0;
    border-radius: var(--radius);
    text-decoration: none;
    color: var(--text-secondary);
    font-size: var(--fs-sm);
  }
  .nav-link:hover { background: var(--bg-hover); color: var(--text-primary); }
  .nav-link.active { background: var(--accent-soft); color: var(--accent-dim); font-weight: var(--fw-medium); }
  .nav-link.ancestor { color: var(--text-primary); }
  .nav-ic-wrap { display: flex; width: 18px; justify-content: center; color: var(--text-muted); }
  .active .nav-ic-wrap { color: inherit; }
  .nav-child { padding-left: var(--sp-5); }
  .sidebar-version { margin-top: auto; padding: var(--sp-6) var(--sp-3) var(--sp-1); color: var(--text-muted); font-size: var(--fs-xs); }
  .sidebar-dbip { padding: var(--sp-1) var(--sp-3); font-size: var(--fs-xs); color: var(--text-muted); }
  .sidebar-dbip a { color: inherit; }
  .project-content { min-width: 0; }
  .breadcrumbs {
    min-height: 56px;
    padding: var(--sp-3) var(--page-gutter);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-3);
    border-bottom: 1px solid var(--border);
    color: var(--text-muted);
    font-size: var(--fs-xs);
    flex-wrap: wrap;
  }
  .breadcrumbs ol { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); min-width: 0; }
  .breadcrumbs li { display: flex; align-items: center; gap: var(--sp-2); min-width: 0; }
  .breadcrumbs li + li::before { content: '/'; color: var(--text-muted); }
  .breadcrumbs a { color: var(--text-secondary); text-decoration: none; max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .breadcrumbs a:hover { color: var(--text-primary); text-decoration: underline; }
  .breadcrumbs [aria-current='page'] { color: var(--text-primary); max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .main { min-width: 0; width: 100%; margin: 0; padding: 0; }
  .unavailable { padding: var(--page-top) var(--page-gutter) var(--sp-7); max-width: 720px; }
  .unavailable .page-title { font-size: var(--fs-2xl); margin: 0 0 var(--sp-3); }
  .unavailable p { color: var(--text-secondary); line-height: 1.6; margin: 0 0 var(--sp-5); }
  .load-error {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-3);
    margin: var(--sp-4) var(--page-gutter) 0;
    padding: var(--sp-3) var(--sp-4);
    border: 1px solid var(--border);
    border-left: 3px solid var(--danger);
    border-radius: var(--radius);
    background: var(--bg-card);
    font-size: var(--fs-sm);
    flex-wrap: wrap;
  }
  .mobile-navigation { display: none; }
  @media (max-width: 1100px) {
    .enterprise-shell { grid-template-columns: 200px minmax(0, 1fr); }
  }
  @media (max-width: 760px) {
    .enterprise-shell { display: block; }
    .mobile-navigation {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--sp-3);
      padding: var(--sp-2) var(--sp-4);
      border-bottom: 1px solid var(--border);
      font-size: var(--fs-xs);
      color: var(--text-muted);
    }
    .mobile-navigation button {
      display: flex;
      gap: var(--sp-4);
      align-items: center;
      background: transparent;
      border: 1px solid var(--border-strong);
      border-radius: var(--radius);
      color: var(--text-primary);
      padding: var(--sp-2) var(--sp-3);
    }
    .mobile-current { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sidebar { display: none; position: static; height: auto; border-bottom: 1px solid var(--border); border-right: 0; padding: var(--sp-4); }
    .sidebar.nav-open { display: flex; }
    .sidebar-version { display: none; }
    .proj { margin-bottom: var(--sp-4); }
    .project-nav { grid-template-columns: 1fr 1fr; gap: var(--sp-4); }
    .breadcrumbs { padding: var(--sp-3) var(--sp-4); gap: var(--sp-2); }
    .breadcrumbs a { max-width: 160px; }
  }
</style>
