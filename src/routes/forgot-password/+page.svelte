<script lang="ts">
  import { onMount } from 'svelte';
  import { base } from '#lib/paths.js';
  import { getRecoveryInfo, requestPasswordReset } from '#lib/api.js';
  import { authErrorMessage } from '#lib/auth-errors.js';
  import { recoveryEmailError } from '#lib/password-reset.js';
  import Alert from '#lib/components/ui/Alert.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Field from '#lib/components/ui/Field.svelte';

  let email = $state('');
  let emailError = $state<string | null>(null);
  let error = $state('');
  let loading = $state(false);
  let sent = $state(false);
  /** null until the server answered; when it cannot be asked, offer the form (the server decides). */
  let available = $state<boolean | null>(null);

  onMount(async () => {
    const res = await getRecoveryInfo();
    available = res.data ? res.data.email_recovery : true;
  });

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    error = '';
    emailError = recoveryEmailError(email);
    if (emailError) return;
    loading = true;
    const res = await requestPasswordReset(email.trim());
    loading = false;
    if (res.error) {
      error = authErrorMessage(res.error, 'The request could not be sent. Try again.');
      return;
    }
    sent = true;
  }
</script>

<div class="auth-page">
  <div class="auth-card">
    <h1>Reset your password</h1>
    {#if available === null}
      <p class="sub" role="status">Checking how this server handles password recovery…</p>
    {:else if !available}
      <Alert tone="info" title="Ask your administrator" message="This server is not set up to send email, so passwords cannot be reset by email. Ask your administrator to reset your password." />
    {:else if sent}
      <Alert tone="success" title="Check your email" message="If an account uses that address, a link to choose a new password is on its way. The link works once and expires in 30 minutes. Nothing arrived? Check your spam folder; you can ask for another link after 5 minutes." />
    {:else}
      <p class="sub">Enter the email address of your account. You will get a link to choose a new password.</p>
      {#if error}<Alert tone="error" compact message={error} />{/if}
      <form onsubmit={submit} novalidate>
        <Field label="Email address" error={emailError} required>
          {#snippet children(control)}
            <input {...control} type="email" bind:value={email} autocomplete="email" maxlength="255" />
          {/snippet}
        </Field>
        <Button type="submit" class="block" loading={loading} disabled={loading}>{loading ? 'Sending…' : 'Send reset link'}</Button>
      </form>
    {/if}
    <p class="footer-note"><a href="{base}/login">Back to sign in</a></p>
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
