<script lang="ts">
  import { untrack } from 'svelte';
  import { page } from '$app/state';
  import { base } from '#lib/paths.js';
  import { auth } from '#lib/stores/auth.js';
  import {
    listProjectMembers,
    listProjectInvites,
    createProjectInvite,
    updateProjectMemberRole,
    removeProjectMember,
    revokeProjectInvite,
    type CreatedInvite,
    type ProjectInvite,
    type ProjectMember,
  } from '#lib/api.js';
  import { getProjectContext } from '#lib/project-context.svelte.js';
  import { projectRoleLabel } from '#lib/project-access.js';
  import { isURL } from '#lib/validation.js';
  import { DateTime } from '#lib/components/ui/index.js';
  import PageHeader from '#lib/components/ui/PageHeader.svelte';
  import DataTable from '#lib/components/ui/DataTable.svelte';
  import Modal from '#lib/components/ui/Modal.svelte';
  import ConfirmModal from '#lib/components/ui/ConfirmModal.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Alert from '#lib/components/ui/Alert.svelte';
  import Select from '#lib/components/ui/Select.svelte';
  import InlineError from '#lib/components/ui/InlineError.svelte';
  import type { DataTableColumn } from '#lib/components/ui/types.js';
  import { toast } from '#lib/stores/toast.js';
  import { roleChangeError } from '#lib/member-errors.js';
  import { canConfirmInvite, checkInviteEmail, completeInviteLink, decideInviteSubmit } from '#lib/invite-flow.js';
  import { focusFormError } from '#lib/focus-error.js';

  const project = getProjectContext();
  const projectId = $derived(page.params.id ?? '');
  const canManage = $derived(project.canManage);
  const myRoleLabel = $derived(projectRoleLabel(project.role));

  // Mirrors RequireProjectAccess levels in fiber.go (viewer reads, member
  // writes configuration and agents, owner deletes and manages membership).
  const ROLES = [
    { value: 'viewer', label: 'Viewer', hint: 'Reads everything in the project.', effect: 'Viewers can read the project but change nothing.' },
    { value: 'member', label: 'Member', hint: 'Also changes configuration, rules and agents.', effect: 'Members can also change configuration, rules and agents.' },
    { value: 'owner', label: 'Owner', hint: 'Also deletes resources and manages members and invitations.', effect: 'Owners can also delete resources and manage members and invitations.' },
  ];

  // ── Members (server paging) ──
  let members: ProjectMember[] = $state([]);
  let membersTotal = $state(0);
  let membersOffset = $state(0);
  let membersLimit = $state(20);
  let membersLoading = $state(true);
  let membersError = $state('');

  // ── Pending invitations (owners only; 20 per page) ──
  const INVITE_PAGE = 20;
  let invites: ProjectInvite[] = $state([]);
  let invitesTotal = $state(0);
  let invitesOffset = $state(0);
  let invitesLoading = $state(false);
  let invitesError = $state('');

  let epoch = 0;

  async function loadMembers() {
    const scope = projectId;
    const run = epoch;
    membersLoading = true;
    membersError = '';
    const res = await listProjectMembers(scope, { limit: membersLimit, offset: membersOffset });
    if (scope !== projectId || run !== epoch) return;
    membersLoading = false;
    if (res.error || !res.data) {
      membersError = res.error?.error ?? 'Members could not be loaded.';
      return;
    }
    members = res.data.members ?? [];
    membersTotal = res.data.total ?? members.length;
    // A removal can leave the last page empty: step back once.
    if (members.length === 0 && membersOffset > 0) {
      membersOffset = Math.max(0, membersOffset - membersLimit);
      void loadMembers();
    }
  }

  async function loadInvites() {
    if (!canManage) return;
    const scope = projectId;
    const run = epoch;
    const offset = invitesOffset;
    invitesLoading = true;
    invitesError = '';
    const res = await listProjectInvites(scope, offset);
    if (scope !== projectId || run !== epoch || offset !== invitesOffset) return;
    invitesLoading = false;
    if (res.error || !res.data) {
      invitesError = res.error?.error ?? 'Invitations could not be loaded.';
      invites = [];
      return;
    }
    invites = (res.data.invites ?? []).map((i) => ({ ...i, invite_url: fullLink(i.invite_url) ?? '' }));
    invitesTotal = res.data.total ?? invites.length;
    if (invites.length === 0 && invitesOffset > 0) {
      invitesOffset = Math.max(0, invitesOffset - INVITE_PAGE);
      void loadInvites();
    }
  }

  // New project: reset everything and load again.
  $effect(() => {
    void projectId;
    untrack(() => {
      epoch++;
      members = [];
      invites = [];
      membersOffset = 0;
      invitesOffset = 0;
      created = null;
      void loadMembers();
    });
  });

  // Invitations need owner access, known once the project context has loaded.
  $effect(() => {
    void projectId;
    if (canManage) untrack(() => void loadInvites());
  });

  // ── Invite ──
  let showInvite = $state(false);
  let inviteEmail = $state('');
  let inviteRole = $state('member');
  let inviteLoading = $state(false);
  let inviteError = $state('');
  let emailInvalid = $state(false);
  let created = $state<CreatedInvite | null>(null);
  let inviteModal = $state<ReturnType<typeof Modal>>();

  function openInvite() {
    inviteEmail = '';
    inviteRole = 'member';
    inviteError = '';
    emailInvalid = false;
    showInvite = true;
  }

  // Enter in the form opens the confirmation; only Confirm creates it.
  let pendingInvite = $state<{ email: string; role: string } | null>(null);
  let inviteFormEl = $state<HTMLFormElement>();

  function requestInvite() {
    const check = checkInviteEmail(inviteEmail, false);
    const decision = decideInviteSubmit({ busy: inviteLoading, pending: pendingInvite !== null, invalid: check.invalid });
    if (decision === 'ignore') return;
    inviteError = '';
    emailInvalid = check.invalid;
    if (decision === 'invalid') {
      inviteError = 'Enter a valid email address.';
      void focusFormError(inviteFormEl);
      return;
    }
    const next = { email: check.email, role: inviteRole };
    if (decision === 'create') void doInvite(next);
    else pendingInvite = next;
  }

  async function doInvite(invite: { email: string; role: string }) {
    const scope = projectId;
    inviteLoading = true;
    const res = await createProjectInvite(scope, invite.email, invite.role);
    inviteLoading = false;
    pendingInvite = null;
    if (scope !== projectId) return;
    if (res.error || !res.data) {
      inviteError = res.error?.error ?? 'The invitation could not be created.';
      void focusFormError(inviteFormEl);
      return;
    }
    created = { ...res.data, invite_url: fullLink(res.data.invite_url) ?? '' };
    showInvite = false;
    toast.success(`Invitation created for ${res.data.email || invite.email}.`);
    invitesOffset = 0;
    await loadInvites();
  }

  // Relative links (no dashboard base URL) get this dashboard's address.
  function fullLink(url: string | undefined): string | undefined {
    return completeInviteLink(url, window.location.origin, base);
  }

  async function copyLink(url: string | undefined) {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Invitation link copied.');
    } catch {
      toast.error('The link could not be copied. Select it and copy it by hand.');
    }
  }

  // ── Role change (simple confirmation) ──
  let roleChange = $state<{ member: ProjectMember; nextRole: string } | null>(null);
  let changingRole = $state(false);

  // The select is bound to the member's current role, so it keeps showing it until the change is confirmed.
  function requestRoleChange(m: ProjectMember, nextRole: string) {
    if (nextRole !== m.role) roleChange = { member: m, nextRole };
  }

  async function applyRoleChange() {
    const change = roleChange;
    if (!change) return;
    const scope = projectId;
    changingRole = true;
    const res = await updateProjectMemberRole(scope, change.member.user_id, change.nextRole);
    changingRole = false;
    if (scope !== projectId) return;
    if (res.error) {
      const failure = roleChangeError(res.error);
      toast.error(failure.message, 'Role not changed');
      if (failure.reload) {
        roleChange = null;
        await loadMembers();
      }
      return;
    }
    toast.success(`${change.member.user_name || change.member.user_email} is now ${projectRoleLabel(change.nextRole) || change.nextRole}.`);
    roleChange = null;
    await loadMembers();
  }

  // ── Remove member / revoke invitation (simple confirmation) ──
  let removeTarget = $state<ProjectMember | null>(null);
  let removing = $state(false);
  let revokeTarget = $state<ProjectInvite | null>(null);
  let revoking = $state(false);

  async function removeMember() {
    const target = removeTarget;
    if (!target) return;
    const scope = projectId;
    removing = true;
    const res = await removeProjectMember(scope, target.user_id);
    removing = false;
    if (scope !== projectId) return;
    if (res.error) {
      toast.error(res.error.error ?? 'The member could not be removed.');
      return;
    }
    toast.success(`${target.user_name || target.user_email} was removed from the project.`);
    removeTarget = null;
    await loadMembers();
  }

  async function revokeInvite() {
    const target = revokeTarget;
    if (!target) return;
    const scope = projectId;
    revoking = true;
    const res = await revokeProjectInvite(scope, target.token);
    revoking = false;
    if (scope !== projectId) return;
    if (res.error) {
      toast.error(res.error.error ?? 'The invitation could not be revoked.');
      return;
    }
    toast.success(`Invitation for ${target.email} revoked.`);
    revokeTarget = null;
    await loadInvites();
  }

  function isSelf(m: ProjectMember): boolean {
    return m.user_id === $auth.user?.id;
  }

  function safeLink(url: string | undefined): string | undefined {
    return url && isURL(url) ? url : undefined;
  }

  const memberColumns: DataTableColumn<ProjectMember>[] = [
    { key: 'user_email', label: 'Email', rowHeader: true },
    { key: 'user_name', label: 'Name' },
    { key: 'role', label: 'Role', nowrap: true },
    { key: 'created_at', label: 'Member since', nowrap: true },
  ];

  const inviteColumns: DataTableColumn<ProjectInvite>[] = [
    { key: 'email', label: 'Email', rowHeader: true },
    { key: 'role', label: 'Role', nowrap: true },
    { key: 'expires_at', label: 'Expires', nowrap: true },
  ];
</script>

<div class="members-page">
  <PageHeader title="Members" subtitle="Who can open this project, and what each person may change." backHref="{base}/projects/{projectId}">
    {#snippet actions()}
      {#if canManage}
        <Button variant="primary" onclick={openInvite}>Invite member</Button>
      {/if}
    {/snippet}
    {#if myRoleLabel}
      <p class="my-role">Your role: <Badge tone="info">{myRoleLabel}</Badge></p>
    {/if}
  </PageHeader>

  <dl class="roles" aria-label="What each role may do">
    {#each ROLES as r (r.value)}
      <div><dt>{r.label}</dt><dd>{r.hint}</dd></div>
    {/each}
  </dl>

  {#if created}
    <Alert tone="success" title={`Invitation created for ${created.email}`} ondismiss={() => (created = null)}>
      <p class="created-text">Email delivery is not confirmed, so share the link yourself. It expires <DateTime value={created.expires_at} relative />.</p>
      <div class="link-row">
        <label for="created-link" class="sr-only">Invitation link</label>
        <input id="created-link" class="link-input" readonly value={created.invite_url} onfocus={(e) => e.currentTarget.select()} />
        <Button variant="secondary" size="sm" onclick={() => copyLink(created?.invite_url)}>Copy link</Button>
      </div>
    </Alert>
  {/if}

  <section class="section" aria-labelledby="members-heading">
    <h2 id="members-heading" class="section-title">Project members</h2>
    <DataTable
      rows={members}
      columns={memberColumns}
      rowKey={(m) => m.user_id}
      caption="Project members"
      manualSort
      loading={membersLoading}
      loadingLabel="Loading members…"
      error={membersError || null}
      onretry={loadMembers}
      emptyTitle="No members"
      onpage={(offset) => {
        membersOffset = offset;
        void loadMembers();
      }}
      total={membersTotal}
      offset={membersOffset}
      limit={membersLimit}
      pageSizes={[20, 50, 100]}
      onlimitchange={(limit) => {
        membersLimit = limit;
        membersOffset = 0;
        void loadMembers();
      }}
      itemLabel="members"
    >
      {#snippet cell(m, column)}
        {#if column.key === 'user_email'}
          {m.user_email}{#if isSelf(m)}<span class="you">(you)</span>{/if}
        {:else if column.key === 'user_name'}
          {m.user_name || 'n/a'}
        {:else if column.key === 'role'}
          {#if canManage && !isSelf(m)}
            <Select
              size="sm"
              aria-label={`Role of ${m.user_email}`}
              options={ROLES}
              bind:value={() => m.role, (role) => requestRoleChange(m, role)}
            />
          {:else}
            <Badge tone={m.role === 'owner' ? 'info' : 'neutral'}>{projectRoleLabel(m.role) || m.role}</Badge>
          {/if}
        {:else if column.key === 'created_at'}
          <DateTime value={m.created_at} format="date" />
        {/if}
      {/snippet}
      {#snippet actions(m)}
        {#if canManage && !isSelf(m)}
          <Button variant="ghost" size="sm" onclick={() => (removeTarget = m)} aria-label={`Remove ${m.user_email}`}>Remove</Button>
        {/if}
      {/snippet}
    </DataTable>
  </section>

  {#if canManage}
    <section class="section" aria-labelledby="invites-heading">
      <h2 id="invites-heading" class="section-title">Pending invitations</h2>
      <p class="section-sub">Links that have not been used yet. Email delivery is not confirmed; copy a link to share it.</p>
      <DataTable
        rows={invites}
        columns={inviteColumns}
        rowKey={(i) => i.token}
        caption="Pending invitations"
        manualSort
        loading={invitesLoading}
        loadingLabel="Loading invitations…"
        error={invitesError || null}
        onretry={loadInvites}
        emptyTitle="No pending invitations"
        onpage={(offset) => {
          invitesOffset = offset;
          void loadInvites();
        }}
        total={invitesTotal}
        offset={invitesOffset}
        limit={INVITE_PAGE}
        itemLabel="invitations"
      >
        {#snippet cell(inv, column)}
          {#if column.key === 'email'}
            {inv.email}
          {:else if column.key === 'role'}
            <Badge tone={inv.role === 'owner' ? 'info' : 'neutral'}>{projectRoleLabel(inv.role) || inv.role}</Badge>
          {:else if column.key === 'expires_at'}
            <DateTime value={inv.expires_at} relative />
          {/if}
        {/snippet}
        {#snippet actions(inv)}
          <Button variant="secondary" size="sm" onclick={() => copyLink(inv.invite_url)} disabled={!inv.invite_url} aria-label={`Copy invitation link for ${inv.email}`}>Copy link</Button>
          {#if safeLink(inv.invite_url)}
            <Button variant="ghost" size="sm" href={safeLink(inv.invite_url)} target="_blank" rel="noopener noreferrer" aria-label={`Open invitation link for ${inv.email} (new tab)`}>Open</Button>
          {/if}
          <Button variant="ghost" size="sm" onclick={() => (revokeTarget = inv)} aria-label={`Revoke invitation for ${inv.email}`}>Revoke</Button>
        {/snippet}
      </DataTable>
    </section>
  {/if}
</div>

<Modal bind:this={inviteModal} open={showInvite} title="Invite member" dirty={inviteEmail.trim().length > 0 && !inviteLoading} dismissible={!inviteLoading} onclose={() => (showInvite = false)}>
  <form
    id="invite-form"
    class="invite-form"
    bind:this={inviteFormEl}
    onsubmit={(e) => {
      e.preventDefault();
      requestInvite();
    }}
  >
    <p class="modal-sub">Creates an invitation link for this project. Owners can revoke it until it is used.</p>
    <div class="field">
      <label for="invite-email">Email address</label>
      <input id="invite-email" type="email" autocomplete="email" required bind:value={inviteEmail} placeholder="user@example.com" aria-invalid={emailInvalid ? 'true' : undefined} aria-describedby={inviteError ? 'invite-error' : undefined} data-autofocus />
    </div>
    <div class="field">
      <label for="invite-role">Role</label>
      <Select id="invite-role" options={ROLES} bind:value={inviteRole} aria-describedby="invite-role-hint" />
      <span class="hint" id="invite-role-hint">{ROLES.find((r) => r.value === inviteRole)?.hint}</span>
    </div>
    <InlineError id="invite-error" message={inviteError} />
  </form>

  {#snippet footer()}
    <Button variant="secondary" disabled={inviteLoading} onclick={() => inviteModal?.requestClose('close-button')}>Cancel</Button>
    <Button variant="primary" type="submit" form="invite-form" loading={inviteLoading}>{inviteLoading ? 'Creating…' : 'Create invitation'}</Button>
  {/snippet}
</Modal>

<ConfirmModal
  open={pendingInvite !== null}
  tone="primary"
  title="Create invitation"
  confirmLabel="Create invitation"
  loading={inviteLoading}
  onconfirm={() => {
    if (pendingInvite && canConfirmInvite(pendingInvite, inviteLoading)) void doInvite(pendingInvite);
  }}
  onclose={() => (pendingInvite = null)}
>
  {#if pendingInvite}
    <p class="confirm-lead">Create an invitation link for this project?</p>
    <dl class="confirm-summary">
      <dt>Email</dt>
      <dd>{pendingInvite.email}</dd>
      <dt>Role</dt>
      <dd>{projectRoleLabel(pendingInvite.role) || pendingInvite.role}</dd>
    </dl>
    <p class="confirm-note">The link works until it is used, it expires, or an owner revokes it.</p>
  {/if}
</ConfirmModal>

<ConfirmModal
  open={removeTarget !== null}
  title="Remove member"
  message={removeTarget ? `Remove ${removeTarget.user_email} from this project? They lose access immediately; invite them again to restore it.` : ''}
  confirmLabel="Remove member"
  loading={removing}
  onconfirm={removeMember}
  onclose={() => (removeTarget = null)}
/>

<ConfirmModal
  open={revokeTarget !== null}
  title="Revoke invitation"
  message={revokeTarget ? `The link for ${revokeTarget.email} stops working immediately. They will need a new invitation.` : ''}
  confirmLabel="Revoke invitation"
  loading={revoking}
  onconfirm={revokeInvite}
  onclose={() => (revokeTarget = null)}
/>

<ConfirmModal
  open={roleChange !== null}
  tone="warning"
  title="Change role"
  message={roleChange
    ? `Change ${roleChange.member.user_name || roleChange.member.user_email} from ${projectRoleLabel(roleChange.member.role) || roleChange.member.role} to ${projectRoleLabel(roleChange.nextRole)}? ${ROLES.find((r) => r.value === roleChange?.nextRole)?.effect ?? ''}`
    : ''}
  confirmLabel="Change role"
  loading={changingRole}
  onconfirm={applyRoleChange}
  onclose={() => (roleChange = null)}
/>

<style>
  .members-page {
    padding: var(--page-top, 32px) var(--page-gutter, 24px) 48px;
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: var(--sp-5);
  }
  .members-page :global(.page-header) { margin-bottom: 0; }
  .my-role { margin: var(--sp-2) 0 0; display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm); color: var(--text-secondary); }

  .roles { margin: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--sp-3); }
  .roles > div { padding: var(--sp-3); background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-lg); }
  .roles dt { font-size: var(--fs-sm); font-weight: var(--fw-semibold); color: var(--text-primary); }
  .roles dd { margin: var(--sp-1) 0 0; font-size: var(--fs-sm); color: var(--text-secondary); line-height: 1.5; }

  .created-text { margin: 0 0 var(--sp-2); }
  .link-row { display: flex; flex-wrap: wrap; gap: var(--sp-2); align-items: center; }
  .link-input {
    flex: 1 1 280px;
    min-width: 0;
    height: 32px;
    padding: 0 var(--sp-2);
    background: var(--surface-input);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    color: var(--text-primary);
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
  }

  .section { display: flex; flex-direction: column; gap: var(--sp-2); min-width: 0; }
  .section-title { margin: 0; font-size: var(--fs-md); font-weight: var(--fw-semibold); color: var(--text-primary); }
  .section-sub { margin: 0 0 var(--sp-1); font-size: var(--fs-sm); color: var(--text-muted); }
  /* A margin, not a literal space: Svelte trims the space at the start of the {#if} block. */
  .you { margin-left: var(--sp-1); font-size: var(--fs-xs); color: var(--text-muted); }

  .confirm-lead { margin: 0 0 var(--sp-2); }
  .confirm-summary { margin: 0; display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: var(--sp-1) var(--sp-3); }
  .confirm-summary dt { font-size: var(--fs-sm); color: var(--text-muted); }
  .confirm-summary dd { margin: 0; color: var(--text-primary); overflow-wrap: anywhere; }
  .confirm-note { margin: var(--sp-2) 0 0; font-size: var(--fs-sm); color: var(--text-muted); }
  .invite-form { display: flex; flex-direction: column; gap: var(--sp-3); }
  .modal-sub { margin: 0; font-size: var(--fs-sm); color: var(--text-muted); }
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
  .hint { font-size: var(--fs-xs); color: var(--text-muted); }

  @media (max-width: 760px) {
    .roles { grid-template-columns: 1fr; }
  }
</style>
