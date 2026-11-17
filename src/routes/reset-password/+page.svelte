<script lang="ts">
  import { onMount } from 'svelte';
  import { base, goto } from '#lib/paths.js';
  import { auth } from '#lib/stores/auth.js';
  import { resetPassword } from '#lib/api.js';
  import { authErrorMessage } from '#lib/auth-errors.js';
  import { MIN_PASSWORD_LENGTH, resetFormErrors, takeResetToken } from '#lib/password-reset.js';
  import Alert from '#lib/components/ui/Alert.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Field from '#lib/components/ui/Field.svelte';

  /** The token of the link, taken out of the URL fragment on arrival. */
  let token = $state<string | null>(null);
  let checked = $state(false);
  let linkInvalid = $state(false);
  let password = $state('');
  let confirm = $state('');
  let errors = $state<{ password?: string; confirm?: string }>({});
  let error = $state('');
  let loading = $state(false);

  onMount(() => {
    // Removes the fragment from the address bar (history entry replaced).
    token = takeResetToken(window);
    checked = true;
  });

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    error = '';
    errors = resetFormErrors(password, confirm);
    if (errors.password || errors.confirm || !token) return;
    loading = true;
    const res = await resetPassword(token, password);
    if (res.error) {
      loading = false;
      if (res.error.code === 'RESET_TOKEN_INVALID') {
        token = null;
        linkInvalid = true;
        password = '';
        confirm = '';
        return;
      }
      if (res.error.code === 'VALIDATION_FAILED') {
        errors = { password: res.error.error };
        return;
      }
      error = authErrorMessage(res.error, 'The password could not be changed. Try again.');
      return;
    }
    password = '';
    confirm = '';
    // The reset ended every session of the account, this browser's included.
    auth.logout();
    void goto('/login?reset=done', { replace: true });
  }
</script>

<div class="auth-page">
  <div class="auth-card">
    <h1>Choose a new password</h1>
    {#if !checked}
      <p class="sub" role="status">Reading the reset link…</p>
    {:else if !token}
      <Alert
        tone="error"
        title="This reset link does not work"
        message={linkInvalid
          ? 'The link was already used, has expired (links last 30 minutes), or a newer link replaced it.'
          : 'This page needs the link from a password reset email. Open the link from the email again, or ask for a new one.'}
      />
      <p class="footer-note"><a href="{base}/forgot-password">Ask for a new link</a> · <a href="{base}/login">Back to sign in</a></p>
    {:else}
      <p class="sub">Every session of the account is signed out when the password changes. Two-factor authentication stays on.</p>
      {#if error}<Alert tone="error" compact message={error} />{/if}
      <form onsubmit={submit} novalidate>
        <Field label="New password" hint={`At least ${MIN_PASSWORD_LENGTH} characters.`} error={errors.password} required>
          {#snippet children(control)}
            <input {...control} type="password" bind:value={password} autocomplete="new-password" minlength={MIN_PASSWORD_LENGTH} />
          {/snippet}
        </Field>
        <Field label="Repeat the new password" error={errors.confirm} required>
          {#snippet children(control)}
            <input {...control} type="password" bind:value={confirm} autocomplete="new-password" />
          {/snippet}
        </Field>
        <Button type="submit" class="block" loading={loading} disabled={loading}>{loading ? 'Changing password…' : 'Change password'}</Button>
      </form>
      <p class="footer-note"><a href="{base}/login">Back to sign in</a></p>
    {/if}
  </div>
</div>

<style>
  .auth-page { width: 100%; max-width: 460px; margin: 0 auto; padding: var(--sp-7) var(--page-gutter) var(--sp-7); }
  .auth-card { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: var(--sp-6) var(--sp-5); display: grid; gap: var(--sp-4); }
  h1 { font-size: var(--fs-xl); margin: 0; }
  .sub { color: var(--text-secondary); font-size: var(--fs-base); margin: 0; }
  form { display: grid; gap: var(--sp-4); }
  :global(.auth-card .block) { width: 100%; justify-content: center; }
  .footer-note { margin: 0; font-size: var(--fs-sm); color: var(--text-muted); text-align: center; }
</style>
