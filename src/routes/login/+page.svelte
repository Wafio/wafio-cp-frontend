<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { base } from '#lib/paths.js';
  import { auth, SIGN_OUT_PARAM } from '#lib/stores/auth.js';
  import { getRecoveryInfo, isTwoFactorChallenge, login, login2fa, safeNextPath, type AuthSession } from '#lib/api.js';
  import { authErrorMessage } from '#lib/auth-errors.js';
  import Alert from '#lib/components/ui/Alert.svelte';
  import Button from '#lib/components/ui/Button.svelte';

  let email = $state('');
  let password = $state('');
  let code = $state('');
  let tempToken = $state('');
  let step = $state<'password' | '2fa'>('password');
  let loading = $state(false);
  let error = $state('');

  /** Where to go after sign-in: the page that sent the visitor here, else Projects. */
  const nextPath = $derived(safeNextPath(page.url.searchParams.get('next'), base));
  const destination = $derived(nextPath ?? `${base}/projects`);
  const setupDone = $derived(page.url.searchParams.get('setup') === 'done');
  const resetDone = $derived(page.url.searchParams.get('reset') === 'done');
  /** Email recovery offered by this server; null until known, and when the server cannot be asked. */
  let emailRecovery = $state<boolean | null>(null);

  onMount(async () => {
    const res = await getRecoveryInfo();
    if (res.data) emailRecovery = res.data.email_recovery;
  });

  // Already signed in (another tab, or back button): continue to the destination.
  $effect(() => {
    // Sign out from the shell: the session ends here, after the page that
    // was left had its chance to cancel. The parameter is then dropped.
    if (page.url.searchParams.has(SIGN_OUT_PARAM)) {
      if (auth.consumeSignOutRequest()) auth.logout();
      const url = new URL(page.url.href);
      url.searchParams.delete(SIGN_OUT_PARAM);
      void goto(url, { replace: true, reset: false });
      return;
    }
    if ($auth.inited && $auth.user && !loading) void goto(destination, { replace: true });
  });

  function finish(session: AuthSession) {
    auth.setAuth(session.token, session.user);
    void goto(destination, { replace: true });
  }

  async function submitPassword(event: SubmitEvent) {
    event.preventDefault();
    error = '';
    if (!email.trim()) {
      error = 'Enter your email address.';
      return;
    }
    loading = true;
    const res = await login(email.trim(), password);
    if (res.error || !res.data) {
      loading = false;
      error = authErrorMessage(res.error, 'Sign-in failed.');
      return;
    }
    if (isTwoFactorChallenge(res.data)) {
      loading = false;
      tempToken = res.data.temp_token;
      password = '';
      step = '2fa';
      return;
    }
    // `loading` stays true: the page is navigating away.
    finish(res.data);
  }

  async function submitCode(event: SubmitEvent) {
    event.preventDefault();
    error = '';
    if (!code.trim()) {
      error = 'Enter a code from your authenticator app or a backup code.';
      return;
    }
    loading = true;
    const res = await login2fa(tempToken, code.trim());
    if (res.error || !res.data) {
      loading = false;
      if (res.error?.code === 'PREAUTH_INVALID') {
        // The pre-auth token expired, was spent or revoked: start over.
        backToPassword();
        error = authErrorMessage(res.error);
        return;
      }
      error = authErrorMessage(res.error, 'The code was not accepted.');
      return;
    }
    finish(res.data);
  }

  function backToPassword() {
    error = '';
    code = '';
    tempToken = '';
    step = 'password';
  }
</script>

<div class="auth-page">
  <div class="auth-card">
    <h1>Sign in to WAFio</h1>
    {#if step === 'password'}
      <p class="sub">Use the email address and password of your control-plane account.</p>
    {:else}
      <p class="sub">Two-factor authentication is on for this account.</p>
    {/if}

    {#if setupDone}
      <Alert tone="success" compact message="Setup complete. Sign in with your new administrator account." />
    {/if}
    {#if resetDone && step === 'password'}
      <Alert tone="success" compact message="Your password was changed and every session was signed out. Sign in with the new password." />
    {/if}
    {#if nextPath && step === 'password' && !setupDone && !resetDone}
      <p class="next-note">After signing in you return to the page you opened.</p>
    {/if}
    {#if error}
      <Alert tone="error" compact message={error} />
    {/if}

    {#if step === 'password'}
      <form onsubmit={submitPassword} novalidate>
        <div class="field">
          <label for="login-email">Email address</label>
          <input id="login-email" type="email" bind:value={email} autocomplete="email" required />
        </div>
        <div class="field">
          <label for="login-password">Password</label>
          <input id="login-password" type="password" bind:value={password} autocomplete="current-password" required />
        </div>
        <Button type="submit" class="block" loading={loading} disabled={loading}>{loading ? 'Signing in…' : 'Sign in'}</Button>
      </form>
      {#if emailRecovery === false}
        <p class="forgot">Forgot your password? Ask your administrator to reset it.</p>
      {:else}
        <p class="forgot"><a href="{base}/forgot-password">Forgot password?</a></p>
      {/if}
    {:else}
      <form onsubmit={submitCode} novalidate>
        <div class="field">
          <label for="login-code">Authenticator or backup code</label>
          <input id="login-code" type="text" bind:value={code} maxlength="14" autocomplete="one-time-code" inputmode="text" aria-describedby="login-code-hint" required />
          <p class="hint" id="login-code-hint">The 6-digit code from your authenticator app, or one of your backup codes.</p>
        </div>
        <Button type="submit" class="block" loading={loading} disabled={loading}>{loading ? 'Verifying…' : 'Verify and sign in'}</Button>
        <Button variant="ghost" class="block" onclick={backToPassword}>Use a different account</Button>
      </form>
    {/if}

    <p class="footer-note">New here? Accounts are created from an invitation link sent by an administrator.</p>
  </div>
</div>

<style>
  .auth-page { width: 100%; max-width: 460px; margin: 0 auto; padding: var(--sp-7) var(--page-gutter) var(--sp-7); }
  .auth-card { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: var(--sp-6) var(--sp-5); display: grid; gap: var(--sp-4); }
  h1 { font-size: var(--fs-xl); margin: 0; }
  .sub { color: var(--text-secondary); font-size: var(--fs-base); margin: calc(-1 * var(--sp-2)) 0 0; }
  .next-note { margin: 0; font-size: var(--fs-sm); color: var(--text-muted); }
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
  .hint { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
  .forgot { margin: calc(-1 * var(--sp-2)) 0 0; font-size: var(--fs-sm); color: var(--text-muted); text-align: center; }
  :global(.auth-card .block) { width: 100%; justify-content: center; }
  .footer-note { margin: var(--sp-2) 0 0; font-size: var(--fs-sm); color: var(--text-muted); text-align: center; }
</style>
