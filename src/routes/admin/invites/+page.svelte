<script lang="ts">
  import { onMount } from 'svelte';
  import { adminListInvites, adminCreateInvite, adminDeleteInvite, type CreatedInvite, type InviteToken } from '#lib/api.js';
  import { projectRoleLabel } from '#lib/project-access.js';
  import { DateTime } from '#lib/components/ui/index.js';
  import PageHeader from '#lib/components/ui/PageHeader.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Alert from '#lib/components/ui/Alert.svelte';
  import DataTable from '#lib/components/ui/DataTable.svelte';
  import ConfirmModal from '#lib/components/ui/ConfirmModal.svelte';
  import InlineError from '#lib/components/ui/InlineError.svelte';
  import type { DataTableColumn } from '#lib/components/ui/types.js';
  import type { BadgeTone } from '#lib/tone.js';
  import { toast } from '#lib/stores/toast.js';
  import { canConfirmInvite, checkInviteEmail, completeInviteLink, decideInviteSubmit } from '#lib/invite-flow.js';
  import { base } from '#lib/paths.js';
  import { focusFormError } from '#lib/focus-error.js';

  let invites = $state<InviteToken[]>([]);
  let total = $state(0);
  let offset = $state(0);
  let limit = $state(20);
  let loading = $state(true);
  let error = $state('');

  let email = $state('');
  let creating = $state(false);
  let createError = $state('');
  let emailInvalid = $state(false);
  let created = $state<CreatedInvite | null>(null);

  let revokeTarget = $state<InviteToken | null>(null);
  let revoking = $state(false);
  let now = $state(Date.now());

  let epoch = 0;

  async function load() {
    const run = ++epoch;
    loading = true;
    error = '';
    const res = await adminListInvites({ limit, offset });
    if (run !== epoch) return; // a newer page request is on its way
    loading = false;
    now = Date.now();
    if (res.error || !res.data) {
      error = res.error?.error ?? 'Invitations could not be loaded.';
      return;
    }
    invites = (res.data.invites ?? []).map((i) => ({ ...i, invite_url: fullLink(i.invite_url) }));
    total = res.data.total ?? invites.length;
    if (invites.length === 0 && offset > 0) {
      offset = Math.max(0, offset - limit);
      void load();
    }
  }

  // Enter in the form opens the confirmation; only Confirm creates it.
  let pendingEmail = $state<string | null>(null);
  let createPanel = $state<HTMLElement>();

  function requestCreate() {
    const check = checkInviteEmail(email, true);
    const decision = decideInviteSubmit({ busy: creating, pending: pendingEmail !== null, invalid: check.invalid });
    if (decision === 'ignore') return;
    createError = '';
    emailInvalid = check.invalid;
    if (decision === 'invalid') {
      createError = 'Enter a valid email address, or leave it empty.';
      void focusFormError(createPanel);
      return;
    }
    if (decision === 'create') void create(check.email);
    else pendingEmail = check.email;
  }

  async function create(value: string) {
    creating = true;
    const res = await adminCreateInvite(value || undefined);
    creating = false;
    pendingEmail = null;
    if (res.error || !res.data) {
      createError = res.error?.error ?? 'The invitation could not be created.';
      void focusFormError(createPanel);
      return;
    }
    created = { ...res.data, invite_url: fullLink(res.data.invite_url) ?? '' };
    email = '';
    toast.success('Invitation created.');
    offset = 0;
    await load();
  }

  async function revoke() {
    const target = revokeTarget;
    if (!target) return;
    revoking = true;
    const res = await adminDeleteInvite(target.token);
    revoking = false;
    if (res.error) {
      toast.error(res.error.error ?? 'The invitation could not be revoked.');
      return;
    }
    toast.success('Invitation revoked.');
    revokeTarget = null;
    await load();
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

  function status(i: InviteToken): { label: string; tone: BadgeTone } {
    if (i.used_at) return { label: 'Used', tone: 'neutral' };
    if (new Date(i.expires_at).getTime() < now) return { label: 'Expired', tone: 'warning' };
    return { label: 'Pending', tone: 'status-pending' };
  }

  const columns: DataTableColumn<InviteToken>[] = [
    { key: 'email', label: 'Email', rowHeader: true },
    { key: 'kind', label: 'Grants', nowrap: true },
    { key: 'status', label: 'Status', nowrap: true },
    { key: 'expires_at', label: 'Expires', nowrap: true },
    { key: 'invite_url', label: 'Invitation link' },
  ];

  onMount(load);
</script>

<div class="admin-page">
  <PageHeader title="Invitations" subtitle="Create sign-up invitations for this WAFio instance and revoke the ones that are no longer needed." />

  <section class="panel" aria-labelledby="create-heading" bind:this={createPanel}>
    <h2 id="create-heading">Create invitation</h2>
    <p class="panel-sub">Leave the email empty for a link that works with any address.</p>
    <form
      class="invite-form"
      onsubmit={(e) => {
        e.preventDefault();
        requestCreate();
      }}
    >
      <label for="admin-invite-email" class="sr-only">Email (optional)</label>
      <input id="admin-invite-email" type="email" autocomplete="off" placeholder="user@example.com (optional)" bind:value={email} aria-invalid={emailInvalid ? 'true' : undefined} aria-describedby={createError ? 'admin-invite-error' : undefined} />
      <Button type="submit" variant="primary" loading={creating}>Create invitation</Button>
    </form>
    <InlineError id="admin-invite-error" message={createError} />
    {#if created}
      <Alert tone="success" title={`Invitation created${created.email ? ` for ${created.email}` : ''}`} ondismiss={() => (created = null)}>
        <p class="created-text">Share this link. It expires <DateTime value={created.expires_at} relative {now} />.</p>
        <div class="link-row">
          <label for="created-invite-link" class="sr-only">Invitation link</label>
          <input id="created-invite-link" class="link-input" readonly value={created.invite_url} onfocus={(e) => e.currentTarget.select()} />
          <Button variant="secondary" size="sm" onclick={() => copyLink(created?.invite_url)}>Copy link</Button>
        </div>
      </Alert>
    {/if}
  </section>

  <section class="panel-plain" aria-labelledby="issued-heading">
    <h2 id="issued-heading">Issued invitations</h2>
    <DataTable
      rows={invites}
      {columns}
      rowKey={(i) => i.token}
      caption="Issued invitations"
      manualSort
      {loading}
      loadingLabel="Loading invitations…"
      error={error || null}
      onretry={load}
      emptyTitle="No invitations issued"
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
      itemLabel="invitations"
    >
      {#snippet cell(inv, column)}
        {#if column.key === 'email'}
          {inv.email || 'Any email'}
        {:else if column.key === 'kind'}
          {inv.project_id ? `Project access${inv.role ? ` (${projectRoleLabel(inv.role) || inv.role})` : ''}` : 'Sign-up'}
        {:else if column.key === 'status'}
          {@const s = status(inv)}
          <Badge tone={s.tone}>{s.label}</Badge>
        {:else if column.key === 'expires_at'}
          <DateTime value={inv.expires_at} relative {now} />
        {:else if column.key === 'invite_url'}
          {#if inv.invite_url}
            <code class="link" title={inv.invite_url}>{inv.invite_url}</code>
          {:else}
            <span class="muted">Not returned by the server</span>
          {/if}
        {/if}
      {/snippet}
      {#snippet actions(inv)}
        {#if inv.invite_url && !inv.used_at}
          <Button variant="secondary" size="sm" onclick={() => copyLink(inv.invite_url)} aria-label={`Copy invitation link for ${inv.email || 'any email'}`}>Copy link</Button>
        {/if}
        {#if !inv.used_at}
          <Button variant="ghost" size="sm" onclick={() => (revokeTarget = inv)} aria-label={`Revoke invitation for ${inv.email || 'any email'}`}>Revoke</Button>
        {/if}
      {/snippet}
    </DataTable>
  </section>
</div>

<ConfirmModal
  open={pendingEmail !== null}
  tone="primary"
  title="Create invitation"
  confirmLabel="Create invitation"
  loading={creating}
  onconfirm={() => {
    if (pendingEmail !== null && canConfirmInvite(pendingEmail, creating)) void create(pendingEmail);
  }}
  onclose={() => (pendingEmail = null)}
>
  {#if pendingEmail !== null}
    <p class="confirm-lead">Create a sign-up invitation for this WAFio instance?</p>
    <dl class="confirm-summary">
      <dt>Email</dt>
      <dd>{pendingEmail || 'Any email address'}</dd>
      <dt>Grants</dt>
      <dd>Sign-up</dd>
    </dl>
    <p class="confirm-note">The link works until it is used, it expires, or it is revoked.</p>
  {/if}
</ConfirmModal>

<ConfirmModal
  open={revokeTarget !== null}
  title="Revoke invitation"
  message={revokeTarget ? `Revoke the invitation for ${revokeTarget.email || 'any email'}? The link stops working immediately.` : ''}
  confirmLabel="Revoke invitation"
  loading={revoking}
  onconfirm={revoke}
  onclose={() => (revokeTarget = null)}
/>

<style>
  .admin-page {
    padding: var(--page-top, 32px) var(--page-gutter, 24px) 48px;
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: var(--sp-5);
  }
  .admin-page :global(.page-header) { margin-bottom: 0; }
  h2 { margin: 0 0 var(--sp-1); font-size: var(--fs-md); font-weight: var(--fw-semibold); color: var(--text-primary); }
  .panel { display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-4) var(--sp-5); background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-lg); }
  .panel-plain { display: flex; flex-direction: column; gap: var(--sp-2); min-width: 0; }
  .panel-sub { margin: 0; font-size: var(--fs-sm); color: var(--text-muted); }
  .confirm-lead { margin: 0 0 var(--sp-2); }
  .confirm-summary { margin: 0; display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: var(--sp-1) var(--sp-3); }
  .confirm-summary dt { font-size: var(--fs-sm); color: var(--text-muted); }
  .confirm-summary dd { margin: 0; color: var(--text-primary); overflow-wrap: anywhere; }
  .confirm-note { margin: var(--sp-2) 0 0; font-size: var(--fs-sm); color: var(--text-muted); }
  .invite-form { display: flex; flex-wrap: wrap; gap: var(--sp-2); align-items: center; }
  .invite-form input {
    flex: 1 1 260px;
    min-width: 0;
    height: 36px;
    padding: 0 var(--sp-3);
    background: var(--surface-input);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    color: var(--text-primary);
    font-size: var(--fs-base);
  }
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
  .link {
    display: inline-block;
    max-width: 26ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    vertical-align: bottom;
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    color: var(--text-secondary);
  }
  .muted { font-size: var(--fs-xs); color: var(--text-muted); }
</style>
