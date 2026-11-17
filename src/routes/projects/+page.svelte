<script lang="ts">
  import { onMount } from 'svelte';
  import { base, goto } from '#lib/paths.js';
  import { listProjects, createProject, deleteProject, type Project } from '#lib/api.js';
  import { isAdmin } from '#lib/stores/auth.js';
  import { toast } from '#lib/stores/toast.js';
  import { projectRoleLabel } from '#lib/project-access.js';
  import { tierFor } from '#lib/confirm-tiers.js';
  import { DateTime } from '#lib/components/ui/index.js';
  import Button from '#lib/components/ui/Button.svelte';
  import Modal from '#lib/components/ui/Modal.svelte';
  import ConfirmModal from '#lib/components/ui/ConfirmModal.svelte';
  import EmptyState from '#lib/components/ui/EmptyState.svelte';
  import PageHeader from '#lib/components/ui/PageHeader.svelte';
  import Pagination from '#lib/components/ui/Pagination.svelte';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Alert from '#lib/components/ui/Alert.svelte';
  import ActionMenu from '#lib/components/ActionMenu.svelte';

  const PAGE_SIZE = 20;

  let projects = $state<Project[]>([]);
  let offset = $state(0);
  let total = $state(0);
  let loading = $state(true);
  let error = $state('');

  let showCreate = $state(false);
  let createModal = $state<ReturnType<typeof Modal>>();
  let newName = $state('');
  let newDesc = $state('');
  let creating = $state(false);
  let createError = $state('');

  let deleteTarget = $state<Project | null>(null);
  let deleting = $state(false);

  const deleteNeedsTyping = tierFor('delete-project') === 'typed';

  onMount(() => { void load(); });

  async function load() {
    loading = true;
    error = '';
    const res = await listProjects(PAGE_SIZE, offset);
    if (res.error) {
      loading = false;
      error = res.error.error ?? 'Projects could not be loaded.';
      return;
    }
    total = res.data?.total ?? 0;
    if (offset > 0 && offset >= total) {
      offset = Math.max(0, Math.floor((total - 1) / PAGE_SIZE) * PAGE_SIZE);
      return load();
    }
    projects = res.data?.projects ?? [];
    loading = false;
  }

  function openCreate() {
    createError = '';
    showCreate = true;
  }

  function closeCreate() {
    showCreate = false;
    newName = '';
    newDesc = '';
    createError = '';
  }

  async function submitCreate(event?: SubmitEvent) {
    event?.preventDefault();
    if (!newName.trim()) {
      createError = 'Enter a project name.';
      return;
    }
    creating = true;
    createError = '';
    const res = await createProject(newName.trim(), newDesc.trim());
    creating = false;
    if (res.error || !res.data) {
      createError = res.error?.error ?? 'The project could not be created.';
      return;
    }
    toast.success(`Project "${res.data.name}" created.`);
    const id = res.data.id;
    closeCreate();
    // A new project starts on its Overview, where the Get started checklist is.
    void goto(`/projects/${id}`);
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    deleting = true;
    const res = await deleteProject(deleteTarget.id);
    deleting = false;
    if (res.error) {
      toast.error(res.error.error ?? 'The project could not be deleted.');
      return;
    }
    toast.success(`Project "${deleteTarget.name}" deleted.`);
    deleteTarget = null;
    void load();
  }

  function changePage(next: number) {
    offset = next;
    void load();
  }
</script>

<div class="projects-page">
  <PageHeader title="Projects" subtitle="Each project holds its own agents, hosts, applications, policies and members.">
    {#snippet actions()}
      {#if $isAdmin}<Button variant="secondary" href="{base}/admin/users">Administration</Button>{/if}
      <Button variant="primary" onclick={openCreate}>New project</Button>
    {/snippet}
  </PageHeader>

  {#if error}
    <Alert tone="error" title="Projects unavailable" message={error}>
      {#snippet actions()}<Button size="sm" variant="secondary" onclick={() => load()}>Retry</Button>{/snippet}
    </Alert>
  {/if}

  {#if loading && projects.length === 0}
    <p class="muted" role="status">Loading projects…</p>
  {:else if !error && projects.length === 0}
    <EmptyState title="No projects yet" message="Create a project, then follow its Get started checklist to connect hosts and applications.">
      {#snippet action()}<Button variant="primary" onclick={openCreate}>New project</Button>{/snippet}
    </EmptyState>
  {:else if projects.length > 0}
    <div class="list-heading">
      <h2>Your projects <span>{total}</span></h2>
    </div>
    <ul class="project-list" aria-busy={loading}>
      {#each projects as p (p.id)}
        {@const role = projectRoleLabel(p.effective_role)}
        <li class="project-item">
          <a href="{base}/projects/{p.id}" class="project-link">
            <span class="project-name">{p.name}</span>
            <span class="project-meta"><code>{p.code}</code>{#if p.created_at}{' · created '}<DateTime value={p.created_at} format="date" />{/if}</span>
            {#if p.description}<span class="project-desc">{p.description}</span>{/if}
          </a>
          {#if role}<Badge tone="neutral" title="Your role in this project">{role}</Badge>{/if}
          <ActionMenu
            label={`Actions for project ${p.name}`}
            items={[
              { label: 'Open overview', onselect: () => goto(`/projects/${p.id}`) },
              { label: 'Project settings', onselect: () => goto(`/projects/${p.id}/settings/general`) },
              {
                label: 'Delete project…',
                tone: 'danger',
                disabled: !p.permissions?.delete_project,
                hint: p.permissions?.delete_project ? undefined : 'Only a project owner can delete the project',
                onselect: () => (deleteTarget = p),
              },
            ]}
          />
        </li>
      {/each}
    </ul>
    {#if total > PAGE_SIZE}
      <Pagination offset={offset} limit={PAGE_SIZE} total={total} onchange={changePage} label="Project pages" itemLabel="projects" disabled={loading} />
    {/if}
  {/if}
</div>

<Modal bind:this={createModal} open={showCreate} title="New project" onclose={closeCreate} dirty={Boolean(newName.trim() || newDesc.trim())} ondiscard={closeCreate}>
  <form id="create-project-form" class="create-form" onsubmit={submitCreate} novalidate>
    {#if createError}<Alert tone="error" compact message={createError} />{/if}
    <div class="field">
      <label for="new-name">Name</label>
      <input id="new-name" type="text" bind:value={newName} maxlength="100" required data-autofocus />
    </div>
    <div class="field">
      <label for="new-desc">Description <span class="optional">(optional)</span></label>
      <input id="new-desc" type="text" bind:value={newDesc} maxlength="500" />
    </div>
    <p class="hint">You become the owner. The project opens on its Overview with a setup checklist.</p>
  </form>
  {#snippet footer()}
    <!-- Same dirty guard as Escape and ×: typed input is not dropped without asking. -->
    <Button variant="ghost" disabled={creating} onclick={() => createModal?.requestClose()}>Cancel</Button>
    <Button variant="primary" type="submit" form="create-project-form" loading={creating} disabled={creating}>Create project</Button>
  {/snippet}
</Modal>

<ConfirmModal
  open={deleteTarget !== null}
  tone="danger"
  title="Delete project"
  confirmLabel="Delete project"
  requireText={deleteNeedsTyping ? (deleteTarget?.name ?? '') : ''}
  requireTextLabel={deleteTarget ? `Type the project name, ${deleteTarget.name}, to confirm` : undefined}
  loading={deleting}
  onconfirm={confirmDelete}
  onclose={() => { if (!deleting) deleteTarget = null; }}
>
  {#if deleteTarget}
    <p class="confirm-text">Delete <strong>{deleteTarget.name}</strong> and everything in it?</p>
    <p class="confirm-text">Its WAF agents, hosts, firewall and runtime policies, applications, credentials and audit log are removed permanently. Agents using its credentials stop reporting. This cannot be undone.</p>
  {/if}
</ConfirmModal>

<style>
  .projects-page { width: 100%; min-width: 0; padding: var(--page-top) var(--page-gutter) var(--sp-7); }
  .muted { color: var(--text-muted); font-size: var(--fs-sm); }
  .list-heading { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: var(--sp-3); margin: var(--sp-5) 0 var(--sp-3); }
  .list-heading h2 { font-size: var(--fs-md); font-weight: var(--fw-medium); margin: 0; }
  .list-heading h2 span { font-size: var(--fs-sm); margin-left: var(--sp-2); color: var(--text-muted); font-weight: 400; }
  .project-list { list-style: none; padding: 0; margin: 0 0 var(--sp-4); border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-card); }
  .project-item { display: flex; align-items: center; gap: var(--sp-3); padding: var(--sp-4) var(--sp-5); border-top: 1px solid var(--border); }
  .project-item:first-child { border-top: 0; }
  .project-link { flex: 1; min-width: 0; text-decoration: none; color: inherit; display: grid; gap: var(--sp-1); }
  .project-link:hover .project-name { color: var(--accent-dim); text-decoration: underline; }
  .project-name { font-weight: var(--fw-semibold); overflow-wrap: anywhere; }
  .project-meta { font-size: var(--fs-xs); color: var(--text-muted); overflow-wrap: anywhere; }
  .project-meta code { font-family: var(--font-mono); }
  .project-desc { font-size: var(--fs-sm); color: var(--text-secondary); overflow-wrap: anywhere; }
  .create-form { display: grid; gap: var(--sp-4); }
  .field { display: grid; gap: var(--sp-1); }
  .field label { font-size: var(--fs-sm); font-weight: var(--fw-medium); }
  .optional { color: var(--text-muted); font-weight: 400; }
  .field input {
    width: 100%;
    padding: var(--sp-2) var(--sp-3);
    background: var(--surface-input);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    color: var(--text-primary);
    font-size: var(--fs-base);
  }
  .hint { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
  .confirm-text { margin: 0 0 var(--sp-3); font-size: var(--fs-sm); color: var(--text-secondary); line-height: 1.55; }
  @media (max-width: 640px) {
    .project-item { padding: var(--sp-3) var(--sp-4); align-items: flex-start; }
  }
</style>
