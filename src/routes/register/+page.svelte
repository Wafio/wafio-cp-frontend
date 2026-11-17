<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { base, goto } from '#lib/paths.js';
  import { auth } from '#lib/stores/auth.js';
  import { registerWithInvite, getInviteInfo } from '#lib/api.js';
  import Alert from '#lib/components/ui/Alert.svelte';
  import Button from '#lib/components/ui/Button.svelte';

  const token = $derived(page.url.searchParams.get('token') ?? '');

  let email = $state('');
  let emailLocked = $state(false);
  let name = $state('');
  let password = $state('');
  let loading = $state(false);
  let error = $state('');
  let tokenError = $state('');
  let checking = $state(true);

  $effect(() => {
    if ($auth.inited && $auth.user && !loading) void goto('/projects', { replace: true });
  });

  onMount(async () => {
    if (!token) {
      checking = false;
      return;
    }
    const res = await getInviteInfo(token);
    checking = false;
    if (res.error) {
      tokenError = res.error.error ?? 'This invitation link is invalid or has expired.';
      return;
    }
    if (res.data?.email) {
      email = res.data.email;
      emailLocked = true;
    }
  });

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    error = '';
    if (!token) { error = 'The invitation token is missing. Open the link from your invitation again.'; return; }
    if (!email.trim()) { error = 'Enter your email address.'; return; }
    if (!name.trim()) { error = 'Enter your name.'; return; }
    if (password.length < 8) { error = 'The password needs at least 8 characters.'; return; }
    loading = true;
    const res = await registerWithInvite({ token, email: email.trim(), name: name.trim(), password });
    if (res.error || !res.data) {
      loading = false;
      error = res.error?.error ?? 'Registration failed.';
      return;
    }
    auth.setAuth(res.data.token, res.data.user);
    void goto('/projects', { replace: true });
  }
</script>

<div class="auth-page">
  <div class="auth-card">
    <h1>Create your account</h1>
    {#if checking}
      <p class="sub" role="status">Checking the invitation…</p>
    {:else if !token || tokenError}
      <Alert tone="error" title="Invitation unavailable" message={tokenError || 'This page needs the invitation link your administrator sent. Open that link again.'} />
      <p class="footer-note">Already have an account? <a href="{base}/login">Sign in</a></p>
    {:else}
      <p class="sub">You were invited to WAFio. Choose a name and a password to continue.</p>
      {#if error}<Alert tone="error" compact message={error} />{/if}
      <form onsubmit={submit} novalidate>
        <div class="field">
          <label for="reg-email">Email</label>
          <input id="reg-email" type="email" bind:value={email} autocomplete="email" readonly={emailLocked} aria-describedby={emailLocked ? 'reg-email-hint' : undefined} required />
          {#if emailLocked}<p class="hint" id="reg-email-hint">Set by the invitation.</p>{/if}
        </div>
        <div class="field">
          <label for="reg-name">Full name</label>
          <input id="reg-name" type="text" bind:value={name} autocomplete="name" required />
        </div>
        <div class="field">
          <label for="reg-pw">Password</label>
          <input id="reg-pw" type="password" bind:value={password} autocomplete="new-password" minlength="8" aria-describedby="reg-pw-hint" required />
          <p class="hint" id="reg-pw-hint">At least 8 characters.</p>
        </div>
        <Button type="submit" class="block" loading={loading} disabled={loading}>{loading ? 'Creating account…' : 'Create account'}</Button>
      </form>
    {/if}
  </div>
</div>

<style>
  .auth-page { width: 100%; max-width: 460px; margin: 0 auto; padding: var(--sp-7) var(--page-gutter) var(--sp-7); }
  .auth-card { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: var(--sp-6) var(--sp-5); display: grid; gap: var(--sp-4); }
  h1 { font-size: var(--fs-xl); margin: 0; }
  .sub { color: var(--text-secondary); font-size: var(--fs-base); margin: 0; }
  form { display: grid; gap: var(--sp-4); }
  .field { display: grid; gap: var(--sp-1); }
  .field label { font-size: var(--fs-sm); font-weight: var(--fw-medium); }
  .field input {
    width: 100%;
    padding: var(--sp-2) var(--sp-3);
    background: var(--surface-input);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    color: var(--text-primary);
    font-size: var(--fs-base);
  }
  .field input[readonly] { background: var(--bg-tertiary); color: var(--text-secondary); }
  .hint { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
  :global(.auth-card .block) { width: 100%; justify-content: center; }
  .footer-note { margin: 0; font-size: var(--fs-sm); color: var(--text-muted); }
</style>
