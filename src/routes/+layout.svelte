<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { goto as navigate } from '$app/navigation';
  import { base } from '#lib/paths.js';
  import Icon from 'svelte-awesome/components/Icon.svelte';
  import chevronDown from 'svelte-awesome/icons/chevronDown';
  import { auth, isAdmin, signOutPath } from '#lib/stores/auth.js';
  import { theme, toggleTheme } from '#lib/stores/theme.js';
  import { loginRedirectPath } from '#lib/api.js';
  import { appPath, documentTitle, isPublicPath } from '#lib/shell-nav.js';
  import { createPageMeta } from '#lib/page-meta.svelte.js';
  import BrandLogo from '#lib/components/BrandLogo.svelte';
  import GlobalSearch from '#lib/components/GlobalSearch.svelte';
  import ToastContainer from '#lib/components/ui/ToastContainer.svelte';
  import { createPoller } from '#lib/polling.svelte.js';
  import { STORAGE_ALERT_POLL_MS, storageAlert } from '#lib/storage-alert.svelte.js';
  import { alertMessage, alertVisible, indicatorLabel } from '#lib/storage-retention.js';

  let { children } = $props();

  // The only <title> writer: "<page>, <project>, WAFio".
  const meta = createPageMeta();

  let userMenuOpen = $state(false);
  let mobileMenuOpen = $state(false);
  let userMenuEl: HTMLElement | undefined = $state();
  let signingOut = $state(false);

  const path = $derived(appPath(page.url.pathname, base));
  // Shells with a left sidebar (project, administration): the header's left
  // edge lines up with the sidebar content instead of the page gutter.
  const withSidebar = $derived(/^\/projects\/[^/]+(\/|$)/.test(path) || path === '/admin' || path.startsWith('/admin/'));
  const publicPage = $derived(isPublicPath(path) || page.error !== null);
  const signedIn = $derived(Boolean($auth.user));
  /** Signed-out visitors of a protected page see nothing but the redirect. */
  const mayRender = $derived(publicPage || ($auth.inited && signedIn));
  const title = $derived(documentTitle({ path, projectName: meta.projectName, details: meta.details, override: meta.title }));

  onMount(() => {
    auth.init();
  });

  // Database disk pressure for system administrators (header indicator and
  // the Administration banner share it). At most one request per 5 min.
  const storagePoller = createPoller((signal) => storageAlert.refresh(signal), STORAGE_ALERT_POLL_MS, { bindToOwner: false });
  $effect(() => {
    if ($auth.inited && $auth.user && $isAdmin) storagePoller.start();
    else {
      storagePoller.stop();
      storageAlert.clear();
    }
  });
  $effect(() => () => storagePoller.dispose());
  const storageWarn = $derived($isAdmin && alertVisible(storageAlert.current) ? storageAlert.current : null);

  // One sign-in gate for every protected page: back to /login with the page
  // the visitor asked for. Child layouts never render without a user.
  $effect(() => {
    if (!$auth.inited || signedIn || publicPage || signingOut) return;
    const { pathname, search, hash } = page.url;
    void navigate(loginRedirectPath(base, { pathname, search, hash }), { replace: true });
  });

  $effect(() => {
    // Close the menus on every navigation.
    void page.url.pathname;
    userMenuOpen = false;
    mobileMenuOpen = false;
  });

  $effect(() => {
    if (!userMenuOpen) return;
    const onPointer = (event: MouseEvent) => {
      if (userMenuEl && !userMenuEl.contains(event.target as Node)) userMenuOpen = false;
    };
    document.addEventListener('click', onPointer);
    return () => document.removeEventListener('click', onPointer);
  });

  // Leave the page first: its unsaved-change guards (an issued key not yet
  // downloaded) may cancel. /login ends the session on arrival.
  async function signOut() {
    if (signingOut) return;
    signingOut = true;
    userMenuOpen = false;
    auth.requestSignOut();
    try {
      await navigate(signOutPath(base), { replace: true });
    } finally {
      signingOut = false;
    }
  }

  function onUserMenuFocusOut(event: FocusEvent) {
    const next = event.relatedTarget as Node | null;
    if (userMenuOpen && next && userMenuEl && !userMenuEl.contains(next)) userMenuOpen = false;
  }

  function onWindowKeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    if (userMenuOpen) {
      userMenuOpen = false;
      userMenuEl?.querySelector<HTMLButtonElement>('.user-trigger')?.focus();
    }
    mobileMenuOpen = false;
  }
</script>

<svelte:window onkeydown={onWindowKeydown} />
<svelte:head><title>{title}</title></svelte:head>

<a class="skip-link" href="#main-content">Skip to main content</a>
<div class="layout">
  <header class="header">
    <div class="header-inner" class:with-sidebar={withSidebar}>
      <a href={signedIn ? `${base}/projects` : `${base}/login`} class="logo">
        <BrandLogo size={38} />
      </a>
      {#if signedIn}
        <button
          type="button"
          class="global-menu-toggle"
          aria-controls="global-navigation"
          aria-expanded={mobileMenuOpen}
          onclick={() => (mobileMenuOpen = !mobileMenuOpen)}
        >{mobileMenuOpen ? 'Close menu' : 'Menu'}</button>
      {/if}
      <nav class="global-nav" class:mobile-open={mobileMenuOpen} class:signed-out={!signedIn} id="global-navigation" aria-label="Global">
        {#if signedIn && $auth.user}
          <div class="search-slot"><GlobalSearch /></div>
          <a href="{base}/projects" aria-current={path === '/projects' ? 'page' : undefined} class:active={path.startsWith('/projects')}>Projects</a>
          {#if $isAdmin}
            <a href="{base}/admin/users" class:active={path.startsWith('/admin')} aria-current={path.startsWith('/admin') ? 'page' : undefined}>Administration</a>
            {#if storageWarn}
              <a
                href="{base}/admin/retention"
                class="storage-indicator"
                class:critical={storageWarn.level === 'critical'}
                title={alertMessage(storageWarn)}
                aria-label={`${indicatorLabel(storageWarn)}, ${storageWarn.level === 'critical' ? 'critical' : 'warning'}: ${alertMessage(storageWarn)} Open Data retention.`}
              >
                <span class="storage-dot" aria-hidden="true"></span>{indicatorLabel(storageWarn)}
              </a>
            {/if}
          {/if}
          <button
            type="button"
            class="theme-toggle"
            onclick={toggleTheme}
            aria-label={$theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            title={$theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          >
            {#if $theme === 'dark'}
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
              </svg>
            {:else}
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            {/if}
          </button>
          <div class="user-menu" bind:this={userMenuEl} onfocusout={onUserMenuFocusOut}>
            <button
              type="button"
              class="user-trigger"
              aria-expanded={userMenuOpen}
              aria-controls="user-menu-panel"
              onclick={(event) => { event.stopPropagation(); userMenuOpen = !userMenuOpen; }}
            >
              <span class="sr-only">Account menu for</span>
              <span class="user-email">{$auth.user.email}</span>
              <Icon data={chevronDown} class={`user-chevron ${userMenuOpen ? 'open' : ''}`} scale={0.9} />
            </button>
            {#if userMenuOpen}
              <div class="user-panel" id="user-menu-panel">
                <p class="user-panel-email">{$auth.user.email}{#if $isAdmin}<span class="user-panel-role">System administrator</span>{/if}</p>
                <ul>
                  <li><a href="{base}/account" aria-current={path === '/account' ? 'page' : undefined}>Account</a></li>
                  {#if $isAdmin}
                    <li><a href="{base}/admin/users">Users</a></li>
                    <li><a href="{base}/admin/security-data">Security data</a></li>
                  {/if}
                  <li><button type="button" onclick={signOut}>Sign out</button></li>
                </ul>
              </div>
            {/if}
          </div>
        {:else if $auth.inited && !path.startsWith('/login')}
          <a href="{base}/login" class="sign-in">Sign in</a>
        {/if}
      </nav>
    </div>
  </header>

  <div class="root-content" id="main-content" tabindex="-1">
    {#if mayRender}
      {@render children()}
    {:else}
      <p class="gate" role="status">{$auth.inited ? 'Redirecting to sign in…' : 'Loading…'}</p>
    {/if}
  </div>
</div>
<ToastContainer />

<style>
  .skip-link {
    position: absolute;
    left: var(--sp-4);
    top: -100px;
    z-index: 1000;
    padding: var(--sp-2) var(--sp-3);
    background: var(--bg-elevated);
    color: var(--text-primary);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    font-size: var(--fs-sm);
  }
  .skip-link:focus { top: var(--sp-2); }
  .layout { min-height: 100vh; display: flex; flex-direction: column; }
  .header {
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border);
    position: sticky;
    top: 0;
    z-index: 100;
  }
  /* Full width like the shells below it (app.css still carries a legacy
     centred 1320px rule for .header-inner). Both edges sit on --page-gutter on
     every page, so the logo does not move when a project opens: the sidebar
     shells start their text on the same line (their left padding is the
     gutter less the nav-link padding). */
  .header-inner {
    height: 56px;
    max-width: none;
    margin: 0;
    padding: 0 var(--page-gutter);
    display: flex;
    align-items: center;
    gap: var(--sp-5);
    width: 100%;
    box-sizing: border-box;
  }
  .logo { display: flex; align-items: center; flex-shrink: 0; }
  .logo { text-decoration: none; }
  .global-nav { display: flex; align-items: center; gap: var(--sp-4); margin-left: auto; min-width: 0; }
  .global-nav > a, .sign-in {
    color: var(--text-secondary);
    text-decoration: none;
    font-size: var(--fs-base);
    font-weight: var(--fw-medium);
  }
  .global-nav > a:hover, .global-nav > a.active { color: var(--text-primary); }
  .sign-in {
    padding: var(--sp-1) var(--sp-3);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    color: var(--text-primary);
  }
  .search-slot { width: clamp(220px, 26vw, 400px); min-width: 0; }
  .root-content { flex: 1; min-width: 0; }
  .root-content:focus { outline: none; }
  .gate { text-align: center; color: var(--text-muted); padding: var(--sp-6); font-size: var(--fs-sm); }
  .theme-toggle {
    width: 34px;
    height: 34px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    color: var(--text-secondary);
    cursor: pointer;
  }
  .theme-toggle:hover { color: var(--accent); border-color: var(--accent); background: var(--accent-soft); }
  /* Database disk pressure (system admins): warning/critical, text carries the meaning. */
  .global-nav > a.storage-indicator {
    --tone: var(--warning);
    display: inline-flex;
    align-items: center;
    gap: var(--sp-2);
    padding: 2px var(--sp-2);
    border: 1px solid var(--tone);
    border-radius: var(--radius);
    background: color-mix(in srgb, var(--tone) var(--tint), transparent);
    color: var(--text-primary);
    font-size: var(--fs-xs);
    font-weight: var(--fw-medium);
    white-space: nowrap;
  }
  .global-nav > a.storage-indicator.critical { --tone: var(--danger); }
  .global-nav > a.storage-indicator:hover { color: var(--text-primary); text-decoration: underline; }
  .storage-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--tone); flex-shrink: 0; }
  .user-menu { position: relative; }
  .user-trigger {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    background: transparent;
    border: 1px solid transparent;
    cursor: pointer;
    color: var(--text-secondary);
    font-size: var(--fs-base);
    padding: var(--sp-1) var(--sp-2);
    border-radius: var(--radius);
  }
  .user-trigger:hover { background: var(--bg-hover); color: var(--text-primary); }
  .user-email { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  :global(.user-chevron) { flex-shrink: 0; transition: transform 0.2s; }
  :global(.user-chevron.open) { transform: rotate(180deg); }
  .user-panel {
    position: absolute;
    right: 0;
    top: calc(100% + 6px);
    min-width: 220px;
    background: var(--bg-elevated);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-lg);
    z-index: 200;
    overflow: hidden;
  }
  .user-panel-email {
    margin: 0;
    padding: var(--sp-3) var(--sp-3) var(--sp-2);
    font-size: var(--fs-sm);
    color: var(--text-muted);
    overflow-wrap: anywhere;
  }
  .user-panel-role { display: block; margin-top: var(--sp-1); font-size: var(--fs-xs); color: var(--text-secondary); }
  .user-panel ul { list-style: none; margin: 0; padding: 0 0 var(--sp-1); border-top: 1px solid var(--border); }
  .user-panel a, .user-panel button {
    display: block;
    width: 100%;
    padding: var(--sp-2) var(--sp-3);
    font-size: var(--fs-base);
    color: var(--text-secondary);
    text-align: left;
    background: none;
    border: none;
    cursor: pointer;
    text-decoration: none;
  }
  .user-panel a:hover, .user-panel button:hover { background: var(--bg-hover); color: var(--text-primary); }
  .global-menu-toggle { display: none; }
  @media (max-width: 760px) {
    .header-inner,
    .header-inner.with-sidebar { padding: 0 var(--sp-4); gap: var(--sp-3); position: relative; }
    .global-menu-toggle {
      display: block;
      margin-left: auto;
      padding: var(--sp-2) var(--sp-3);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius);
      background: transparent;
      color: var(--text-primary);
      font-size: var(--fs-xs);
    }
    .global-nav {
      display: none;
      position: absolute;
      top: 56px;
      left: 0;
      right: 0;
      margin: 0;
      padding: var(--sp-5) var(--sp-4);
      align-items: stretch;
      gap: var(--sp-4);
      border-bottom: 1px solid var(--border-strong);
      background: var(--bg-secondary);
    }
    .global-nav.mobile-open { display: flex; flex-direction: column; }
    .search-slot { width: 100%; }
    .user-trigger { width: 100%; justify-content: space-between; }
    .user-email { max-width: none; }
    .user-panel { position: static; width: 100%; margin-top: var(--sp-2); }
    .global-nav > a { padding: var(--sp-1) 0; }
    .global-nav.signed-out { display: flex; position: static; padding: 0; border: 0; background: none; }
    .global-nav > a.sign-in { padding: var(--sp-1) var(--sp-3); }
  }
</style>
