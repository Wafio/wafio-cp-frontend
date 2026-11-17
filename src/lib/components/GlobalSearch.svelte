<!--
  GlobalSearch: header search for pages and resources.

  - Loads nothing until it is first opened: the project list once, and the
    applications, hosts and WAF agents of the current project (three
    requests, cached for a minute). No per-project or per-app fan-out.
  - Pages come from the sidebar model ($lib/shell-nav), so every sidebar
    page (Applications, Custom rules, Project settings, …) is searchable.
  - ARIA 1.2 combobox: the input owns the listbox through aria-controls and
    aria-activedescendant; arrows move, Enter opens, Escape closes (a second
    Escape clears), Ctrl/⌘+K focuses the field, "/" in an empty field lists
    everything.
-->
<script lang="ts">
  import { page } from '$app/state';
  import { untrack } from 'svelte';
  import Icon from 'svelte-awesome/components/Icon.svelte';
  import search from 'svelte-awesome/icons/search';
  import times from 'svelte-awesome/icons/times';
  import { base, goto } from '#lib/paths.js';
  import { listAllProjects, listApps, listFleetAgents, listHosts, type App, type FleetAgent, type Host, type Project } from '#lib/api.js';
  import { isAdmin } from '#lib/stores/auth.js';
  import { appPath, flatNavItems, parseProjectPath, type ProjectNavItem } from '#lib/shell-nav.js';
  import { categoricalColor } from '#lib/tone.js';

  type Kind = 'page' | 'project' | 'app' | 'waf-agent' | 'host';
  const KIND_ORDER: Kind[] = ['page', 'project', 'app', 'waf-agent', 'host'];
  const KIND_LABEL: Record<Kind, string> = { page: 'Page', project: 'Project', app: 'Application', 'waf-agent': 'WAF agent', host: 'Host' };

  interface Result {
    kind: Kind;
    label: string;
    detail: string;
    /** App path without base. */
    href: string;
    /** Higher sorts first. */
    score: number;
  }

  const PROJECTS_TTL = 5 * 60_000;
  const RESOURCES_TTL = 60_000;
  const MAX_RESULTS = 12;
  const MAX_BROWSE = 40;

  const shortcut = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K';

  const uid = $props.id();
  const inputId = `${uid}-input`;
  const listId = `${uid}-list`;
  const optionId = (i: number) => `${uid}-opt-${i}`;

  let query = $state('');
  let open = $state(false);
  let activeIndex = $state(-1);
  let inputEl: HTMLInputElement | undefined = $state();
  let container: HTMLElement | undefined = $state();

  let projects = $state<Project[]>([]);
  let projectsLoadedAt = 0;
  let projectsLoading = $state(false);
  let resources = $state<{ projectId: string; apps: App[]; hosts: Host[]; agents: FleetAgent[] } | null>(null);
  let resourcesLoadedAt = 0;
  let resourcesLoading = $state(false);
  let loadError = $state('');

  const currentProjectId = $derived(parseProjectPath(appPath(page.url.pathname, base))?.projectId ?? '');
  const currentProject = $derived(projects.find((p) => p.id === currentProjectId) ?? null);

  async function ensureLoaded() {
    const now = Date.now();
    const jobs: Promise<void>[] = [];
    const projectsDue = !projectsLoading && now - projectsLoadedAt > PROJECTS_TTL;
    const resourcesDue = Boolean(currentProjectId) && !resourcesLoading
      && (resources?.projectId !== currentProjectId || now - resourcesLoadedAt > RESOURCES_TTL);
    // A new attempt replaces the note of a failed one.
    if (projectsDue || resourcesDue) loadError = '';
    if (projectsDue) {
      projectsLoading = true;
      jobs.push(listAllProjects().then((res) => {
        projectsLoading = false;
        if (res.data) {
          projects = res.data.projects;
          projectsLoadedAt = Date.now();
        } else {
          loadError = 'Projects could not be searched.';
        }
      }));
    }
    const pid = currentProjectId;
    if (resourcesDue) {
      resourcesLoading = true;
      jobs.push(Promise.all([
        listApps(pid, { limit: 100 }),
        listHosts(pid, { limit: 100 }),
        listFleetAgents({ kind: 'waf', projectId: pid, limit: 100 }),
      ]).then(([apps, hosts, agents]) => {
        resourcesLoading = false;
        if (pid !== currentProjectId) return;
        resources = {
          projectId: pid,
          apps: apps.data?.apps ?? [],
          hosts: hosts.data?.hosts ?? [],
          agents: agents.data?.agents ?? [],
        };
        resourcesLoadedAt = Date.now();
        if (apps.error || hosts.error || agents.error) loadError = 'Some resources of this project could not be searched.';
      }));
    }
    await Promise.all(jobs);
  }

  function matchScore(q: string, ...fields: (string | null | undefined)[]): number {
    let best = 0;
    for (const [i, field] of fields.entries()) {
      const value = (field ?? '').toLowerCase();
      if (!value) continue;
      const weight = i === 0 ? 3 : 1;
      if (value === q) best = Math.max(best, 10 * weight);
      else if (value.startsWith(q)) best = Math.max(best, 6 * weight);
      else if (value.includes(q)) best = Math.max(best, 3 * weight);
    }
    return best;
  }

  function pageResult(item: ProjectNavItem, project: Project | null, projectId: string, score: number): Result {
    return {
      kind: 'page',
      label: item.label,
      detail: project ? `${project.name} · ${item.description}` : item.description,
      href: `/projects/${projectId}${item.path}`,
      score,
    };
  }

  const results: Result[] = $derived.by(() => {
    const raw = query.trim();
    if (!raw) return [];
    const browse = raw === '/';
    const q = raw.toLowerCase();
    const out: Result[] = [];
    const nav = flatNavItems();

    // Pages of the current project, or of matching projects outside one.
    if (currentProjectId) {
      for (const item of nav) {
        const score = browse ? 1 : matchScore(q, item.label, item.description, ...item.keywords);
        if (score) out.push(pageResult(item, currentProject, currentProjectId, score + 2));
      }
    }
    for (const project of projects) {
      const projectScore = browse ? 0 : matchScore(q, project.name, project.code, project.description);
      if (projectScore) {
        out.push({ kind: 'project', label: project.name, detail: `Project · ${project.code}`, href: `/projects/${project.id}`, score: projectScore + 1 });
      }
      if (!browse && !currentProjectId) {
        for (const item of nav) {
          const score = matchScore(q, item.label, ...item.keywords);
          if (score) out.push(pageResult(item, project, project.id, score));
        }
      }
    }
    if (browse && !currentProjectId) {
      for (const project of projects) out.push({ kind: 'project', label: project.name, detail: `Project · ${project.code}`, href: `/projects/${project.id}`, score: 1 });
    }

    // Resources of the current project.
    if (resources && resources.projectId === currentProjectId) {
      const root = `/projects/${currentProjectId}`;
      for (const app of resources.apps) {
        const score = browse ? 1 : matchScore(q, app.name, app.upstream_url, app.listen_host);
        if (score) out.push({ kind: 'app', label: app.name, detail: `Application${app.upstream_url ? ` · ${app.upstream_url}` : ''}`, href: `${root}/apps/${app.id}`, score });
      }
      for (const agent of resources.agents) {
        const score = browse ? 1 : matchScore(q, agent.name, agent.hostname);
        if (score) out.push({ kind: 'waf-agent', label: agent.name, detail: `WAF agent · ${agent.is_online ? 'online' : 'offline'}${agent.hostname ? ` · ${agent.hostname}` : ''}`, href: `${root}/waf/${agent.id}`, score });
      }
      for (const host of resources.hosts) {
        const labels = Object.entries(host.labels ?? {}).map(([k, v]) => `${k}=${v}`).join(' ');
        const score = browse ? 1 : matchScore(q, host.name, labels, host.host_os);
        if (score) out.push({ kind: 'host', label: host.name, detail: `Host · ${host.status}`, href: `${root}/hosts/${host.id}`, score });
      }
    }

    // Account and administration.
    const globals: { label: string; detail: string; href: string; admin?: boolean; words: string[] }[] = [
      { label: 'Projects', detail: 'Every project you can open; owners delete a project here', href: '/projects', words: ['projects', 'workspace', 'delete project'] },
      { label: 'Account', detail: 'Name, password and two-factor authentication', href: '/account', words: ['account', 'profile', 'password', '2fa', 'two-factor'] },
      { label: 'Users', detail: 'Administration · user accounts', href: '/admin/users', admin: true, words: ['users', 'admin'] },
      { label: 'Invitations', detail: 'Administration · signup invitations', href: '/admin/invites', admin: true, words: ['invite', 'invitation', 'admin'] },
      { label: 'Security data', detail: 'Administration · GeoIP and bot lists', href: '/admin/security-data', admin: true, words: ['security data', 'geoip', 'update'] },
      { label: 'Data retention', detail: 'Administration · database size, budget and retention per table', href: '/admin/retention', admin: true, words: ['retention', 'storage', 'disk', 'database', 'budget', 'admin'] },
      { label: 'Global audit log', detail: 'Administration · user-management outcomes', href: '/admin/audit-log', admin: true, words: ['audit', 'admin', 'log'] },
    ];
    for (const entry of globals) {
      if (entry.admin && !$isAdmin) continue;
      const score = browse ? 0 : matchScore(q, entry.label, ...entry.words);
      if (score) out.push({ kind: 'page', label: entry.label, detail: entry.detail, href: entry.href, score });
    }

    const seen = new Set<string>();
    return out
      .filter((r) => (seen.has(r.href) ? false : (seen.add(r.href), true)))
      .sort((a, b) => b.score - a.score || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.label.localeCompare(b.label))
      .slice(0, browse ? MAX_BROWSE : MAX_RESULTS);
  });

  const loading = $derived(projectsLoading || resourcesLoading);
  const expanded = $derived(open && query.trim().length > 0);
  const statusText = $derived(
    !expanded ? '' : loading && results.length === 0 ? 'Searching…' : results.length === 0 ? `No results for ${query.trim()}` : `${results.length} ${results.length === 1 ? 'result' : 'results'}`,
  );

  $effect(() => {
    // Keep the active option valid as results change (not when it moves).
    const count = results.length;
    untrack(() => {
      activeIndex = count ? Math.min(Math.max(activeIndex, 0), count - 1) : -1;
    });
  });

  $effect(() => {
    // Close on navigation.
    void page.url.pathname;
    open = false;
  });

  $effect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        inputEl?.focus();
        inputEl?.select();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  function onFocus() {
    open = true;
    void ensureLoaded();
  }

  function onInput() {
    open = true;
    activeIndex = 0;
    void ensureLoaded();
  }

  function choose(result: Result) {
    open = false;
    query = '';
    activeIndex = -1;
    inputEl?.blur();
    void goto(result.href);
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === '/' && query === '') {
      event.preventDefault();
      query = '/';
      onInput();
      return;
    }
    if (event.key === 'Escape') {
      if (expanded) {
        event.preventDefault();
        event.stopPropagation();
        open = false;
      } else if (query) {
        event.preventDefault();
        event.stopPropagation();
        query = '';
      }
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!expanded) {
        open = true;
        return;
      }
      if (!results.length) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      activeIndex = (activeIndex + step + results.length) % results.length;
      document.getElementById(optionId(activeIndex))?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (event.key === 'Enter' && expanded && activeIndex >= 0 && results[activeIndex]) {
      event.preventDefault();
      choose(results[activeIndex]);
    }
  }

  function onFocusOut(event: FocusEvent) {
    const next = event.relatedTarget as Node | null;
    if (!next || !container?.contains(next)) open = false;
  }

  function clear() {
    query = '';
    activeIndex = -1;
    inputEl?.focus();
  }
</script>

<div class="gs" bind:this={container} onfocusout={onFocusOut}>
  <label class="sr-only" for={inputId}>Search pages and resources</label>
  <div class="gs-field" class:expanded>
    <span class="gs-icon" aria-hidden="true"><Icon data={search} scale={0.85} /></span>
    <input
      bind:this={inputEl}
      bind:value={query}
      id={inputId}
      type="text"
      role="combobox"
      aria-expanded={expanded}
      aria-controls={listId}
      aria-autocomplete="list"
      aria-activedescendant={expanded && activeIndex >= 0 ? optionId(activeIndex) : undefined}
      aria-describedby="{uid}-hint"
      placeholder="Search…"
      autocomplete="off"
      spellcheck="false"
      onfocus={onFocus}
      oninput={onInput}
      onkeydown={onKeydown}
    />
    {#if query}
      <button type="button" class="gs-clear" onclick={clear} aria-label="Clear search"><Icon data={times} scale={0.8} /></button>
    {:else}
      <kbd class="gs-hint" aria-hidden="true">{shortcut}</kbd>
    {/if}
  </div>
  <span class="sr-only" id="{uid}-hint">Type to search pages, projects and this project's applications, hosts and WAF agents. Type / to list everything.</span>

  <div class="gs-popup" hidden={!expanded}>
    <ul class="gs-list" role="listbox" id={listId} aria-label="Search results">
      {#each results as result, i (result.href)}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <li
          id={optionId(i)}
          role="option"
          aria-selected={i === activeIndex}
          class="gs-option"
          class:active={i === activeIndex}
          onmousedown={(event) => event.preventDefault()}
          onmousemove={() => (activeIndex = i)}
          onclick={() => choose(result)}
        >
          <span class="gs-kind" style="--kind-color:{categoricalColor(KIND_ORDER.indexOf(result.kind))}">{KIND_LABEL[result.kind]}</span>
          <span class="gs-body">
            <span class="gs-label">{result.label}</span>
            <span class="gs-detail">{result.detail}</span>
          </span>
        </li>
      {/each}
    </ul>
    {#if expanded && (results.length === 0 || loadError)}
      <p class="gs-note">{loading && results.length === 0 ? 'Searching…' : results.length === 0 ? `No pages or resources match "${query.trim()}".` : ''}{loadError ? ` ${loadError}` : ''}</p>
    {/if}
    {#if expanded && currentProjectId && results.length > 0}
      <p class="gs-note">Applications, hosts and WAF agents are searched in the current project.</p>
    {/if}
  </div>
  <p class="sr-only" aria-live="polite">{statusText}</p>
</div>

<style>
  .gs { position: relative; width: 100%; min-width: 0; }
  .gs-field {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    background: var(--surface-input);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    padding: 0 var(--sp-2);
    height: 34px;
  }
  /* The input's own outline is replaced by a ring on the whole field. */
  .gs-field:focus-within { outline: var(--ring-width) solid var(--ring-color); outline-offset: 1px; border-color: var(--accent); }
  .gs-field input { flex: 1; min-width: 0; background: none; border: none; color: var(--text-primary); font-size: var(--fs-sm); padding: 0; }
  .gs-field input:focus, .gs-field input:focus-visible { outline: none; }
  .gs-field input::placeholder { color: var(--text-muted); }
  .gs-icon { color: var(--text-muted); display: flex; flex-shrink: 0; }
  .gs-hint { font-size: var(--fs-xs); color: var(--text-muted); border: 1px solid var(--border); border-radius: 4px; padding: 0 var(--sp-1); white-space: nowrap; font-family: inherit; }
  .gs-clear { display: grid; place-items: center; width: 24px; height: 24px; background: none; border: none; color: var(--text-muted); cursor: pointer; border-radius: var(--radius); }
  .gs-clear:hover { color: var(--text-primary); background: var(--bg-hover); }
  .gs-popup {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    width: max(100%, min(30rem, calc(100vw - 2rem)));
    max-width: calc(100vw - 2rem);
    background: var(--bg-elevated);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-lg);
    z-index: 500;
    overflow: hidden;
  }
  .gs-popup[hidden] { display: none; }
  .gs-list { list-style: none; margin: 0; padding: var(--sp-1) 0; max-height: min(26rem, 60vh); overflow-y: auto; }
  .gs-list:empty { display: none; }
  .gs-option { display: grid; grid-template-columns: 6.5rem minmax(0, 1fr); gap: var(--sp-3); align-items: start; padding: var(--sp-2) var(--sp-3); cursor: pointer; border-left: 3px solid transparent; }
  .gs-option.active { background: var(--accent-soft); border-left-color: var(--accent); }
  .gs-kind { display: inline-flex; align-items: center; gap: var(--sp-1); font-size: var(--fs-xs); color: var(--text-secondary); padding-top: 2px; }
  .gs-kind::before { content: ''; width: 8px; height: 8px; border-radius: 2px; background: var(--kind-color); flex-shrink: 0; }
  .gs-body { display: grid; gap: 2px; min-width: 0; }
  .gs-label { font-size: var(--fs-sm); color: var(--text-primary); font-weight: var(--fw-medium); overflow-wrap: anywhere; }
  .gs-detail { font-size: var(--fs-xs); color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .gs-note { margin: 0; padding: var(--sp-2) var(--sp-3); font-size: var(--fs-xs); color: var(--text-muted); border-top: 1px solid var(--border); }
  .gs-list:empty + .gs-note { border-top: 0; }
  @media (max-width: 760px) {
    .gs-popup { position: static; width: 100%; max-width: none; margin-top: var(--sp-2); }
    .gs-option { grid-template-columns: minmax(0, 1fr); gap: var(--sp-1); }
  }
</style>
