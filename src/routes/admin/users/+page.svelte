<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from 'svelte-awesome/components/Icon.svelte';
  import plus from 'svelte-awesome/icons/plus';
  import {
    adminListUsers,
    adminCreateUser,
    adminUpdateUser,
    adminDeleteUser,
    adminResetPassword,
    listAllProjects,
    addProjectMember,
    type AdminUser,
  } from '#lib/api.js';
  import { auth } from '#lib/stores/auth.js';
  import { DateTime } from '#lib/components/ui/index.js';
  import PageHeader from '#lib/components/ui/PageHeader.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import DataTable from '#lib/components/ui/DataTable.svelte';
  import Modal from '#lib/components/ui/Modal.svelte';
  import ConfirmModal from '#lib/components/ui/ConfirmModal.svelte';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Select from '#lib/components/ui/Select.svelte';
  import InlineError from '#lib/components/ui/InlineError.svelte';
  import type { DataTableColumn } from '#lib/components/ui/types.js';
  import { toast } from '#lib/stores/toast.js';
  import { addMemberError } from '#lib/member-errors.js';

  // ── List ──
  let users: AdminUser[] = $state([]);
  let projects: { id: string; name: string }[] = $state([]);
  const projectOptions = $derived([{ value: '', label: 'No project' }, ...projects.map((p) => ({ value: p.id, label: p.name }))]);
  const ROLE_OPTIONS = [
    { value: 'user', label: 'User' },
    { value: 'admin', label: 'Administrator' },
  ];
  const PROJECT_ROLE_OPTIONS = [
    { value: 'viewer', label: 'Viewer (reads)' },
    { value: 'member', label: 'Member (reads and configures)' },
    { value: 'owner', label: 'Owner (full control)' },
  ];
  let offset = $state(0);
  let limit = $state(20);
  let total = $state(0);
  let loading = $state(true);
  let error = $state('');
  let projectsError = $state('');

  // ── Create ──
  let showCreate = $state(false);
  let createEmail = $state('');
  let createName = $state('');
  let createPassword = $state('');
  let createRole = $state('user');
  let createProjectId = $state('');
  let createProjectRole = $state('member');
  let createLoading = $state(false);
  let createError = $state('');
  // Set once the user exists, so a retry after a failed project assignment
  // does not create the user twice.
  let createdUserId = $state('');

  // ── Edit ──
  let showEdit = $state(false);
  let editUser: AdminUser | null = $state(null);
  let editName = $state('');
  let editRole = $state('');
  let editLoading = $state(false);
  let editError = $state('');

  // ── Reset password ──
  let showReset = $state(false);
  let resetUser: AdminUser | null = $state(null);
  let resetPassword = $state('');
  let resetLoading = $state(false);
  let resetError = $state('');

  // Cancel buttons go through the same unsaved-change check as Escape.
  let createModal = $state<ReturnType<typeof Modal>>();
  let editModal = $state<ReturnType<typeof Modal>>();
  let resetModal = $state<ReturnType<typeof Modal>>();
  const editDirty = $derived(editUser !== null && (editName !== editUser.name || editRole !== editUser.role));

  // ── Delete (typed confirmation) ──
  let deleteTarget: AdminUser | null = $state(null);
  let deleteLoading = $state(false);

  let epoch = 0;

  async function load() {
    const run = ++epoch;
    loading = true;
    error = '';
    const res = await adminListUsers(limit, offset);
    if (run !== epoch) return; // a newer page request is on its way
    loading = false;
    if (res.error || !res.data) {
      error = res.error?.error ?? 'Users could not be loaded.';
      return;
    }
    users = res.data.users ?? [];
    total = res.data.total ?? users.length;
    if (users.length === 0 && offset > 0) {
      offset = Math.max(0, offset - limit);
      void load();
    }
  }

  async function loadProjects() {
    const res = await listAllProjects();
    projectsError = res.error?.error ?? '';
    projects = (res.data?.projects ?? []).map((p) => ({ id: p.id, name: p.name }));
  }

  onMount(() => {
    void load();
    void loadProjects();
  });

  function openCreate() {
    createdUserId = '';
    createEmail = '';
    createName = '';
    createPassword = '';
    createRole = 'user';
    createProjectId = '';
    createProjectRole = 'member';
    createError = '';
    showCreate = true;
  }

  async function doCreate() {
    createError = '';
    if (!createEmail.trim() || !createName.trim() || !createPassword) {
      createError = 'Email, name and password are required.';
      return;
    }
    if (createPassword.length < 8) {
      createError = 'The password needs at least 8 characters.';
      return;
    }
    createLoading = true;
    if (!createdUserId) {
      const res = await adminCreateUser({ email: createEmail.trim(), name: createName.trim(), password: createPassword, role: createRole });
      if (res.error || !res.data) {
        createError = res.error?.error ?? 'The user could not be created.';
        createLoading = false;
        return;
      }
      createdUserId = res.data.id;
    }
    if (createProjectId && createdUserId) {
      const mRes = await addProjectMember(createProjectId, createdUserId, createProjectRole);
      if (mRes.error) {
        createError = `The user was created, but the project assignment failed: ${addMemberError(mRes.error)} Try again or assign the user from the project's Members page.`;
        createLoading = false;
        await load();
        return;
      }
    }
    createLoading = false;
    showCreate = false;
    toast.success('User created.');
    await load();
  }

  function openEdit(u: AdminUser) {
    editUser = u;
    editName = u.name;
    editRole = u.role;
    editError = '';
    showEdit = true;
  }

  async function doEdit() {
    if (!editUser) return;
    editError = '';
    editLoading = true;
    const res = await adminUpdateUser(editUser.id, { name: editName, role: editRole });
    editLoading = false;
    if (res.error) {
      editError = res.error.error ?? 'The user could not be saved.';
      return;
    }
    toast.success('User saved.');
    showEdit = false;
    await load();
  }

  function openReset(u: AdminUser) {
    resetUser = u;
    resetPassword = '';
    resetError = '';
    showReset = true;
  }

  async function doReset() {
    if (!resetUser) return;
    resetError = '';
    if (resetPassword.length < 8) {
      resetError = 'The password needs at least 8 characters.';
      return;
    }
    resetLoading = true;
    const res = await adminResetPassword(resetUser.id, resetPassword);
    resetLoading = false;
    if (res.error) {
      resetError = res.error.error ?? 'The password could not be reset.';
      return;
    }
    toast.success('Password reset.');
    showReset = false;
  }

  async function confirmDelete() {
    const target = deleteTarget;
    if (!target) return;
    deleteLoading = true;
    const res = await adminDeleteUser(target.id);
    deleteLoading = false;
    if (res.error) {
      toast.error(res.error.error ?? 'The user could not be deleted.');
      return;
    }
    toast.success(`${target.email} deleted.`);
    deleteTarget = null;
    await load();
  }

  function isSelf(u: AdminUser): boolean {
    return u.id === $auth.user?.id;
  }

  const columns: DataTableColumn<AdminUser>[] = [
    { key: 'email', label: 'Email', rowHeader: true },
    { key: 'name', label: 'Name' },
    { key: 'role', label: 'System role', nowrap: true },
    { key: 'created_at', label: 'Created', nowrap: true },
  ];
</script>

<div class="admin-page">
  <PageHeader title="Users" subtitle="Every account on this WAFio instance and its system role. A new user can be added to a project as it is created.">
    {#snippet actions()}
      <Button variant="primary" onclick={openCreate}>
        <Icon data={plus} scale={0.8} aria-hidden="true" />
        Add user
      </Button>
    {/snippet}
  </PageHeader>

  <DataTable
    rows={users}
    {columns}
    rowKey={(u) => u.id}
    caption="Users"
    manualSort
    {loading}
    loadingLabel="Loading users…"
    error={error || null}
    onretry={load}
    emptyTitle="No users yet"
    emptyMessage="Add the first user to get started."
    onpage={(next) => {
      offset = next;
      void load();
    }}
    {total}
    {offset}
    {limit}
    pageSizes={[20, 50, 100]}
    onlimitchange={(next) => {
      limit = next;
      offset = 0;
      void load();
    }}
    itemLabel="users"
  >
    {#snippet cell(u, column)}
      {#if column.key === 'email'}
        {u.email}{#if isSelf(u)}<span class="you">(you)</span>{/if}
      {:else if column.key === 'name'}
        {u.name || 'n/a'}
      {:else if column.key === 'role'}
        <Badge tone={u.role === 'admin' ? 'info' : 'neutral'}>{u.role === 'admin' ? 'Administrator' : 'User'}</Badge>
      {:else if column.key === 'created_at'}
        <DateTime value={u.created_at} format="date" />
      {/if}
    {/snippet}
    {#snippet actions(u)}
      <Button variant="secondary" size="sm" onclick={() => openEdit(u)} aria-label={`Edit ${u.email}`}>Edit</Button>
      <Button variant="secondary" size="sm" onclick={() => openReset(u)} aria-label={`Reset the password of ${u.email}`}>Reset password</Button>
      <Button variant="secondary" size="sm" disabled={isSelf(u)} title={isSelf(u) ? 'You cannot delete your own account' : undefined} onclick={() => (deleteTarget = u)} aria-label={`Delete ${u.email}`}>Delete</Button>
    {/snippet}
  </DataTable>
</div>

<Modal bind:this={createModal} open={showCreate} title="Add user" dismissible={!createLoading} dirty={Boolean(createEmail || createName || createPassword) && !createLoading} onclose={() => (showCreate = false)}>
  <form
    id="create-user-form"
    class="form"
    onsubmit={(e) => {
      e.preventDefault();
      void doCreate();
    }}
  >
    <div class="field">
      <label for="create-user-email">Email</label>
      <input id="create-user-email" type="email" autocomplete="off" required bind:value={createEmail} placeholder="user@example.com" disabled={Boolean(createdUserId)} data-autofocus />
    </div>
    <div class="field">
      <label for="create-user-name">Name</label>
      <input id="create-user-name" type="text" autocomplete="off" required bind:value={createName} placeholder="Full name" disabled={Boolean(createdUserId)} />
    </div>
    <div class="field">
      <label for="create-user-password">Password</label>
      <input id="create-user-password" type="password" autocomplete="new-password" required minlength="8" bind:value={createPassword} placeholder="At least 8 characters" disabled={Boolean(createdUserId)} />
    </div>
    <div class="field">
      <label for="create-user-role">System role</label>
      <Select id="create-user-role" options={ROLE_OPTIONS} bind:value={createRole} disabled={Boolean(createdUserId)} />
    </div>
    <div class="field">
      <label for="create-user-project">Add to project <span class="optional">(optional)</span></label>
      <Select id="create-user-project" options={projectOptions} bind:value={createProjectId} />
      {#if projectsError}<span class="hint">Projects could not be loaded: {projectsError}</span>{/if}
    </div>
    {#if createProjectId}
      <div class="field">
        <label for="create-user-project-role">Project role</label>
        <Select id="create-user-project-role" options={PROJECT_ROLE_OPTIONS} bind:value={createProjectRole} />
      </div>
    {/if}
    <InlineError message={createError} />
  </form>
  {#snippet footer()}
    <Button variant="secondary" disabled={createLoading} onclick={() => createModal?.requestClose('close-button')}>Cancel</Button>
    <Button variant="primary" type="submit" form="create-user-form" loading={createLoading}>{createdUserId ? 'Retry project assignment' : 'Create user'}</Button>
  {/snippet}
</Modal>

<Modal bind:this={editModal} open={showEdit && !!editUser} title="Edit user" dismissible={!editLoading} dirty={editDirty && !editLoading} onclose={() => (showEdit = false)}>
  <form
    id="edit-user-form"
    class="form"
    onsubmit={(e) => {
      e.preventDefault();
      void doEdit();
    }}
  >
    {#if editUser}<p class="sub">{editUser.email}</p>{/if}
    <div class="field">
      <label for="edit-user-name">Name</label>
      <input id="edit-user-name" type="text" bind:value={editName} data-autofocus />
    </div>
    <div class="field">
      <label for="edit-user-role">System role</label>
      <Select id="edit-user-role" options={ROLE_OPTIONS} bind:value={editRole} disabled={editUser?.id === $auth.user?.id} aria-describedby="edit-role-hint" />
      {#if editUser?.id === $auth.user?.id}<span class="hint" id="edit-role-hint">You cannot change your own role.</span>{/if}
    </div>
    <InlineError message={editError} />
  </form>
  {#snippet footer()}
    <Button variant="secondary" disabled={editLoading} onclick={() => editModal?.requestClose('close-button')}>Cancel</Button>
    <Button variant="primary" type="submit" form="edit-user-form" loading={editLoading}>Save</Button>
  {/snippet}
</Modal>

<Modal bind:this={resetModal} open={showReset && !!resetUser} title="Reset password" dismissible={!resetLoading} dirty={resetPassword.length > 0 && !resetLoading} onclose={() => (showReset = false)}>
  <form
    id="reset-user-form"
    class="form"
    onsubmit={(e) => {
      e.preventDefault();
      void doReset();
    }}
  >
    {#if resetUser}<p class="sub">{resetUser.email}</p>{/if}
    <div class="field">
      <label for="reset-user-password">New password</label>
      <input id="reset-user-password" type="password" autocomplete="new-password" minlength="8" bind:value={resetPassword} placeholder="At least 8 characters" data-autofocus />
    </div>
    <InlineError message={resetError} />
  </form>
  {#snippet footer()}
    <Button variant="secondary" disabled={resetLoading} onclick={() => resetModal?.requestClose('close-button')}>Cancel</Button>
    <Button variant="primary" type="submit" form="reset-user-form" loading={resetLoading}>Set password</Button>
  {/snippet}
</Modal>

<ConfirmModal
  open={deleteTarget !== null}
  tone="danger"
  title="Delete user"
  message={deleteTarget ? `Delete ${deleteTarget.email} permanently? They lose access to every project. This cannot be undone.` : ''}
  confirmLabel="Delete user"
  requireText={deleteTarget?.email ?? ''}
  loading={deleteLoading}
  onconfirm={confirmDelete}
  onclose={() => {
    if (!deleteLoading) deleteTarget = null;
  }}
/>

<style>
  .admin-page {
    padding: var(--page-top, 32px) var(--page-gutter, 24px) 48px;
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
  }
  .sub { margin: 0; font-size: var(--fs-sm); color: var(--text-muted); }
  /* A margin, not a literal space: Svelte trims the space at the start of
     the {#if} block, which glued "(you)" to the address. */
  .you { margin-left: var(--sp-1); font-size: var(--fs-xs); color: var(--text-muted); font-weight: normal; }
  .form { display: flex; flex-direction: column; gap: var(--sp-3); }
  .field { display: flex; flex-direction: column; gap: var(--sp-1); }
  .field label { font-size: var(--fs-sm); font-weight: var(--fw-semibold); color: var(--text-secondary); }
  .field input {
    height: 36px;
    padding: 0 var(--sp-3);
    background: var(--surface-input);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    color: var(--text-primary);
    font-size: var(--fs-base);
  }
  .field input:disabled { opacity: 0.6; }
  .optional { font-weight: normal; color: var(--text-muted); }
  .hint { font-size: var(--fs-xs); color: var(--text-muted); }
</style>
