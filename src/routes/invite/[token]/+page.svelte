<script lang="ts">
  import { page } from '$app/state';
  import { untrack } from 'svelte';
  import { base, goto } from '#lib/paths.js';
  import { acceptInvite, getInviteInfo, login, registerWithInvite, isTwoFactorChallenge, type InviteInfo } from '#lib/api.js';
  import { auth } from '#lib/stores/auth.js';
  import { inviteLoadMessage } from '#lib/invite-flow.js';
  import { projectRoleLabel } from '#lib/project-access.js';
  import { DateTime } from '#lib/components/ui/index.js';
  import Alert from '#lib/components/ui/Alert.svelte';
  import Button from '#lib/components/ui/Button.svelte';

  const token = $derived(page.params.token ?? '');

  let invite = $state<InviteInfo | null>(null);
  let loading = $state(true);
  let error = $state('');
  let authError = $state('');
  let acceptError = $state('');
  let authLoading = $state(false);
  let acceptLoading = $state(false);
  let password = $state('');
  let name = $state('');

  const inviteEmail = $derived(invite?.email ?? '');
  const emailMismatch = $derived(Boolean(
    $auth.user && inviteEmail && inviteEmail.trim().toLowerCase() !== ($auth.user.email ?? '').trim().toLowerCase(),
  ));
  const isProjectInvite = $derived(Boolean(invite?.project_id));
  const roleLabel = $derived(projectRoleLabel(invite?.role) || invite?.role || '');
  const signInHref = $derived(`${base}/login?next=${encodeURIComponent(`${base}/invite/${token}`)}`);

  let version = 0;
  $effect(() => {
    const current = token;
    untrack(() => void loadInvite(current));
  });

  async function loadInvite(value: string) {
    const v = ++version;
    loading = true;
    error = '';
    invite = null;
    const res = await getInviteInfo(value);
    if (v !== version) return;
    loading = false;
    if (res.error) {
      error = inviteLoadMessage(res.error);
      return;
    }
    invite = res.data ?? null;
  }

  async function signIn(event: SubmitEvent) {
    event.preventDefault();
    if (!inviteEmail) return;
    authError = '';
    authLoading = true;
    const res = await login(inviteEmail, password);
    authLoading = false;
    if (res.error || !res.data) {
      authError = res.error?.error ?? 'Sign-in failed.';
      return;
    }
    if (isTwoFactorChallenge(res.data)) {
      // The code step lives on the sign-in page; it returns here afterwards.
      window.location.assign(`${signInHref}`);
      return;
    }
    auth.setAuth(res.data.token, res.data.user);
    password = '';
  }

  async function register(event: SubmitEvent) {
    event.preventDefault();
    if (!inviteEmail) return;
    authError = '';
    if (!name.trim()) {
      authError = 'Enter your full name.';
      return;
    }
    if (password.length < 8) {
      authError = 'The password needs at least 8 characters.';
      return;
    }
    authLoading = true;
    const res = await registerWithInvite({ token, email: inviteEmail, name: name.trim(), password });
    authLoading = false;
    if (res.error || !res.data) {
      authError = res.error?.error ?? 'Registration failed.';
      return;
    }
    auth.setAuth(res.data.token, res.data.user);
    password = '';
  }

  async function accept() {
    acceptError = '';
    acceptLoading = true;
    const res = await acceptInvite(token);
    acceptLoading = false;
    if (res.error) {
      acceptError = res.error.error ?? 'The invitation could not be accepted.';
      return;
    }
    if (res.data?.project_id) void goto(`/projects/${res.data.project_id}`);
  }
</script>

<div class="invite-page">
  <div class="invite-card">
    <h1>{isProjectInvite ? 'Join a project' : 'Create your account'}</h1>

    {#if loading}
      <p class="muted" role="status">Loading the invitation…</p>
    {:else if error}
      <Alert tone="error" title="Invitation unavailable" message={error} />
      <p class="muted">Ask the person who invited you for a new link, or <a href="{base}/login">sign in</a> if you already have access.</p>
    {:else if invite}
      <dl class="summary">
        <div><dt>Email</dt><dd>{invite.email || 'Any email address'}</dd></div>
        <div><dt>Project</dt><dd>{invite.project_name || 'No project (account only)'}</dd></div>
        {#if isProjectInvite}<div><dt>Role</dt><dd>{roleLabel}</dd></div>{/if}
        <div><dt>Expires</dt><dd><DateTime value={invite.expires_at} relative /></dd></div>
      </dl>

      {#if $auth.user}
        {#if emailMismatch}
          <Alert tone="warning" title="Different account" message={`This invitation is for ${inviteEmail}, but you are signed in as ${$auth.user.email}. Sign out, then open the link again.`} />
          <div class="actions"><Button variant="secondary" onclick={() => auth.logout()}>Sign out</Button></div>
        {:else if !isProjectInvite}
          <Alert tone="success" message="Your account is ready." />
          <div class="actions"><Button onclick={() => goto('/projects')}>Go to projects</Button></div>
        {:else}
          <p class="lead">Signed in as <strong>{$auth.user.email}</strong>. Accept to join <strong>{invite.project_name || 'this project'}</strong> as <strong>{roleLabel}</strong>.</p>
          {#if acceptError}<Alert tone="error" compact message={acceptError} />{/if}
          <div class="actions"><Button loading={acceptLoading} disabled={acceptLoading} onclick={accept}>{acceptLoading ? 'Accepting…' : 'Accept invitation'}</Button></div>
        {/if}
      {:else if invite.user_exists}
        <p class="lead">An account exists for <strong>{invite.email}</strong>. Sign in to continue.</p>
        {#if authError}<Alert tone="error" compact message={authError} />{/if}
        <form class="form" onsubmit={signIn}>
          <div class="field">
            <label for="invite-email">Email</label>
            <input id="invite-email" type="email" value={invite.email} readonly />
          </div>
          <div class="field">
            <label for="invite-password">Password</label>
            <input id="invite-password" type="password" bind:value={password} autocomplete="current-password" required />
          </div>
          <div class="actions"><Button type="submit" loading={authLoading} disabled={authLoading}>{authLoading ? 'Signing in…' : 'Sign in'}</Button></div>
        </form>
      {:else}
        <p class="lead">Create your WAFio account to join <strong>{invite.project_name || 'WAFio'}</strong>.</p>
        {#if authError}<Alert tone="error" compact message={authError} />{/if}
        <form class="form" onsubmit={register}>
          <div class="field">
            <label for="invite-new-email">Email</label>
            <input id="invite-new-email" type="email" value={invite.email} readonly />
          </div>
          <div class="field">
            <label for="invite-name">Full name</label>
            <input id="invite-name" type="text" bind:value={name} autocomplete="name" required />
          </div>
          <div class="field">
            <label for="invite-new-password">Password</label>
            <input id="invite-new-password" type="password" bind:value={password} autocomplete="new-password" minlength="8" aria-describedby="invite-pw-hint" required />
            <p class="hint" id="invite-pw-hint">At least 8 characters.</p>
          </div>
          <div class="actions"><Button type="submit" loading={authLoading} disabled={authLoading}>{authLoading ? 'Creating account…' : 'Create account'}</Button></div>
        </form>
      {/if}
    {/if}
  </div>
</div>

<style>
  .invite-page { width: 100%; max-width: 560px; margin: 0 auto; padding: var(--sp-7) var(--page-gutter); }
  .invite-card { border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-card); padding: var(--sp-6) var(--sp-5); display: grid; gap: var(--sp-4); }
  h1 { margin: 0; font-size: var(--fs-xl); }
  .lead { margin: 0; color: var(--text-secondary); line-height: 1.6; }
  .muted { margin: 0; color: var(--text-muted); font-size: var(--fs-sm); }
  .summary { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--sp-3); margin: 0; padding: var(--sp-4); border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-tertiary); }
  .summary dt { font-size: var(--fs-xs); color: var(--text-muted); margin-bottom: var(--sp-1); }
  .summary dd { margin: 0; font-weight: var(--fw-medium); overflow-wrap: anywhere; }
  .form { display: grid; gap: var(--sp-4); }
  .field { display: grid; gap: var(--sp-1); }
  .field label { font-size: var(--fs-sm); font-weight: var(--fw-medium); }
  .field input {
    width: 100%;
    padding: var(--sp-2) var(--sp-3);
    border-radius: var(--radius);
    border: 1px solid var(--border-strong);
    background: var(--surface-input);
    color: var(--text-primary);
    font-size: var(--fs-base);
  }
  .field input[readonly] { background: var(--bg-tertiary); color: var(--text-secondary); }
  .hint { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
  .actions { display: flex; gap: var(--sp-2); flex-wrap: wrap; }
  @media (max-width: 640px) { .summary { grid-template-columns: 1fr; } }
</style>
