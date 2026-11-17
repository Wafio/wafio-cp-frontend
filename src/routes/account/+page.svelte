<script lang="ts">
  import { onMount } from 'svelte';
  import { qrSvg as drawQr } from '#lib/qr.js';
  import { base } from '#lib/paths.js';
  import { goto } from '$app/navigation';
  import { getMe, updateProfile, changePassword, setup2fa, enable2fa, disable2fa, regenerateBackupCodes, logoutAll } from '#lib/api.js';
  import { authErrorMessage, isRetryableAuthError } from '#lib/auth-errors.js';
  import { needsConfirmation } from '#lib/confirm-tiers.js';
  import { auth } from '#lib/stores/auth.js';
  import { toast } from '#lib/stores/toast.js';
  import PageHeader from '#lib/components/ui/PageHeader.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Modal from '#lib/components/ui/Modal.svelte';
  import ConfirmModal from '#lib/components/ui/ConfirmModal.svelte';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Alert from '#lib/components/ui/Alert.svelte';
  import InlineError from '#lib/components/ui/InlineError.svelte';
  import { focusFormError, submitScope } from '#lib/focus-error.js';

  let name = $state('');
  let email = $state('');
  let loading = $state(true);
  let loadError = $state('');

  let saving = $state(false);
  let profileError = $state('');
  let profileMessage = $state('');

  let currentPassword = $state('');
  let newPassword = $state('');
  let confirmPassword = $state('');
  let passwordSaving = $state(false);
  let passwordMessage = $state('');
  let passwordError = $state('');

  let totpEnabled = $state(false);
  let totpSecret = $state('');
  let totpAuthUrl = $state('');
  let totpCode = $state('');
  let totpLoading = $state(false);
  let totpError = $state('');
  let totpMessage = $state('');
  let setupMode = $state(false);
  let backupCodes = $state<string[]>([]);
  let backupRemaining = $state(0);
  let regenMode = $state(false);
  let regenConfirm = $state(false);
  let regenCode = $state('');
  let disableMode = $state(false);
  let disableConfirm = $state(false);
  let enablePassword = $state('');
  let backupWarning = $state('');

  let logoutAllConfirm = $state(false);
  let logoutAllBusy = $state(false);
  let logoutAllError = $state('');
  let logoutAllRetryable = $state(false);

  const qrSvg = $derived(totpAuthUrl ? drawQr(totpAuthUrl) : '');

  onMount(async () => {
    const res = await getMe();
    loading = false;
    if (res.error) {
      loadError = res.error.error ?? 'Failed to load your account.';
      return;
    }
    if (res.data) {
      name = res.data.name ?? '';
      email = res.data.email ?? '';
      totpEnabled = res.data.totp_enabled === true;
      backupRemaining = res.data.backup_codes_remaining ?? 0;
    }
  });

  async function saveProfile(event: SubmitEvent) {
    event.preventDefault();
    const scope = submitScope(event);
    profileError = '';
    profileMessage = '';
    saving = true;
    const res = await updateProfile(name.trim());
    saving = false;
    if (res.error) {
      profileError = res.error.error ?? 'Failed to save.';
      toast.error(profileError);
      void focusFormError(scope);
      return;
    }
    if (res.data) auth.updateUser(res.data);
    profileMessage = 'Profile updated.';
    toast.success(profileMessage);
  }

  async function submitPassword(event: SubmitEvent) {
    event.preventDefault();
    const scope = submitScope(event);
    passwordError = '';
    passwordMessage = '';
    if (newPassword.length < 8) {
      passwordError = 'New password must be at least 8 characters.';
      void focusFormError(scope);
      return;
    }
    if (newPassword !== confirmPassword) {
      passwordError = 'New password and confirmation do not match.';
      void focusFormError(scope);
      return;
    }
    passwordSaving = true;
    const res = await changePassword(currentPassword, newPassword);
    passwordSaving = false;
    if (res.error) {
      passwordError = authErrorMessage(res.error, 'Failed to change password.');
      toast.error(passwordError);
      void focusFormError(scope);
      return;
    }
    // Every earlier token is revoked; keep this session on the replacement.
    if (res.data?.token) auth.replaceToken(res.data.token);
    passwordMessage = 'Password changed. Other devices are signed out.';
    toast.success(passwordMessage);
    currentPassword = '';
    newPassword = '';
    confirmPassword = '';
  }

  async function start2FASetup() {
    totpError = '';
    totpLoading = true;
    setupMode = true;
    const res = await setup2fa();
    totpLoading = false;
    if (res.error) {
      totpError = authErrorMessage(res.error, 'Failed to start two-factor setup.');
      toast.error(totpError);
      setupMode = false;
      if (res.error.code === 'TOTP_ALREADY_ENABLED') totpEnabled = true;
      return;
    }
    if (res.data) {
      totpSecret = res.data.secret;
      totpAuthUrl = res.data.otpauth;
    }
  }

  function cancelSetup() {
    setupMode = false;
    totpSecret = '';
    totpAuthUrl = '';
    totpCode = '';
    enablePassword = '';
    totpError = '';
  }

  async function submitEnable2FA(event: SubmitEvent) {
    event.preventDefault();
    const scope = submitScope(event);
    totpError = '';
    totpMessage = '';
    if (!/^\d{6}$/.test(totpCode.trim())) {
      totpError = 'Enter the 6-digit code from your authenticator app.';
      void focusFormError(scope);
      return;
    }
    if (!enablePassword) {
      totpError = 'Enter your current password.';
      void focusFormError(scope);
      return;
    }
    totpLoading = true;
    const res = await enable2fa(totpCode.trim(), enablePassword);
    totpLoading = false;
    if (res.error) {
      totpError = authErrorMessage(res.error, 'Invalid code.');
      toast.error(totpError);
      if (res.error.code === 'TOTP_ALREADY_ENABLED') {
        cancelSetup();
        totpEnabled = true;
        totpError = authErrorMessage(res.error);
      } else if (res.error.code === 'TOTP_SETUP_REQUIRED') {
        // The pending secret is gone: issue a new one to scan.
        totpCode = '';
        void start2FASetup().then(() => { if (!totpError) totpError = 'Scan the new QR code: the earlier setup expired.'; });
      }
      void focusFormError(scope);
      return;
    }
    // Enabling 2FA revokes every earlier token; keep this session on the replacement.
    if (res.data?.token) auth.replaceToken(res.data.token);
    backupWarning = res.data?.backup_codes_warning ?? '';
    enablePassword = '';
    totpEnabled = true;
    setupMode = false;
    totpMessage = 'Two-factor authentication is on.';
    toast.success(totpMessage);
    totpCode = '';
    totpSecret = '';
    totpAuthUrl = '';
    backupCodes = res.data?.backup_codes ?? [];
    backupRemaining = backupCodes.length;
  }

  async function submitDisable2FA(event: SubmitEvent) {
    event.preventDefault();
    const scope = submitScope(event);
    totpError = '';
    totpMessage = '';
    if (!/^\d{6}$/.test(totpCode.trim())) {
      totpError = 'Enter the 6-digit code from your authenticator app.';
      void focusFormError(scope);
      return;
    }
    totpLoading = true;
    const res = await disable2fa(totpCode.trim());
    totpLoading = false;
    if (res.error) {
      totpError = authErrorMessage(res.error, 'Invalid code.');
      toast.error(totpError);
      void focusFormError(scope);
      return;
    }
    if (res.data?.token) auth.replaceToken(res.data.token);
    totpEnabled = false;
    totpMessage = 'Two-factor authentication is off.';
    toast.success(totpMessage);
    totpCode = '';
    disableMode = false;
    backupCodes = [];
    backupRemaining = 0;
  }

  function cancelDisable() {
    disableMode = false;
    totpCode = '';
    totpError = '';
  }

  async function submitRegenerate(event: SubmitEvent) {
    event.preventDefault();
    const scope = submitScope(event);
    totpError = '';
    if (!/^\d{6}$/.test(regenCode.trim())) {
      totpError = 'Enter the 6-digit code from your authenticator app.';
      void focusFormError(scope);
      return;
    }
    totpLoading = true;
    const res = await regenerateBackupCodes(regenCode.trim());
    totpLoading = false;
    if (res.error) {
      totpError = authErrorMessage(res.error, 'Invalid code.');
      toast.error(totpError);
      void focusFormError(scope);
      return;
    }
    backupCodes = res.data?.backup_codes ?? [];
    backupRemaining = backupCodes.length;
    regenMode = false;
    regenCode = '';
    toast.success('New backup codes generated.');
  }

  function requestLogoutAll() {
    logoutAllError = '';
    if (needsConfirmation('logout-all')) logoutAllConfirm = true;
    else void runLogoutAll();
  }

  async function runLogoutAll() {
    logoutAllBusy = true;
    logoutAllError = '';
    const res = await logoutAll();
    logoutAllBusy = false;
    if (res.error) {
      // A 401 already ended the session in the API client; 503
      // AUTH_UNAVAILABLE and network errors leave it and can be retried.
      logoutAllRetryable = isRetryableAuthError(res.error);
      logoutAllError = authErrorMessage(res.error, 'Could not sign out the other sessions.');
      logoutAllConfirm = false;
      return;
    }
    logoutAllConfirm = false;
    auth.logout();
    await goto(`${base}/login`, { replace: true });
  }

  function downloadBackupCodes() {
    const blob = new Blob([backupCodes.join('\n') + '\n'], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'wafio-backup-codes.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    toast.success('Backup codes downloaded.');
  }

  async function copyBackupCodes() {
    try {
      await navigator.clipboard.writeText(backupCodes.join('\n'));
      toast.success('Backup codes copied.');
    } catch {
      toast.error('Copy failed. Select the codes and copy them manually.');
    }
  }
</script>

<div class="account-page">
  <PageHeader title="Account" subtitle="Your name, password, two-factor authentication and sessions." backHref="{base}/projects" />

  {#if loading}
    <p class="muted" role="status">Loading…</p>
  {:else if loadError}
    <Alert tone="error" title="Account unavailable" message={loadError} />
  {:else}
    <section class="section" aria-labelledby="profile-heading">
      <h2 id="profile-heading">Profile</h2>
      <form class="form" onsubmit={saveProfile}>
        {#if profileError}<Alert tone="error" compact message={profileError} />{/if}
        {#if profileMessage}<Alert tone="success" compact message={profileMessage} />{/if}
        <div class="field">
          <label for="account-email">Email</label>
          <input id="account-email" type="email" value={email} readonly aria-describedby="account-email-hint" class="input readonly" />
          <p class="hint" id="account-email-hint">Your sign-in address. An administrator can change it.</p>
        </div>
        <div class="field">
          <label for="account-name">Name</label>
          <input id="account-name" type="text" bind:value={name} class="input" maxlength="200" autocomplete="name" />
        </div>
        <div class="actions">
          <Button type="submit" loading={saving} disabled={saving}>{saving ? 'Saving…' : 'Save profile'}</Button>
        </div>
      </form>
    </section>

    <section class="section" aria-labelledby="password-heading">
      <h2 id="password-heading">Password</h2>
      <form class="form" onsubmit={submitPassword}>
        {#if passwordError}<Alert tone="error" compact message={passwordError} />{/if}
        {#if passwordMessage}<Alert tone="success" compact message={passwordMessage} />{/if}
        <div class="field">
          <label for="account-current-password">Current password</label>
          <input id="account-current-password" type="password" bind:value={currentPassword} class="input" autocomplete="current-password" required />
        </div>
        <div class="field">
          <label for="account-new-password">New password</label>
          <input id="account-new-password" type="password" bind:value={newPassword} class="input" autocomplete="new-password" minlength="8" aria-describedby="account-new-password-hint" required />
          <p class="hint" id="account-new-password-hint">At least 8 characters.</p>
        </div>
        <div class="field">
          <label for="account-confirm-password">Confirm new password</label>
          <input id="account-confirm-password" type="password" bind:value={confirmPassword} class="input" autocomplete="new-password" required />
        </div>
        <div class="actions">
          <Button type="submit" loading={passwordSaving} disabled={passwordSaving}>{passwordSaving ? 'Changing…' : 'Change password'}</Button>
        </div>
      </form>
    </section>

    <section class="section" aria-labelledby="twofa-heading">
      <h2 id="twofa-heading">Two-factor authentication</h2>
      <div class="form">
        {#if totpMessage}<Alert tone="success" compact message={totpMessage} />{/if}
        {#if totpError && !setupMode}<Alert tone="error" compact message={totpError} />{/if}

        {#if backupCodes.length > 0}
          <div class="backup-panel">
            <p><strong>Save these backup codes now.</strong> They are shown once. Each code signs you in once if you lose your authenticator.</p>
            {#if backupWarning}<Alert tone="warning" compact message={backupWarning} />{/if}
            <ul class="backup-list" aria-label="Backup codes">
              {#each backupCodes as code (code)}<li><code>{code}</code></li>{/each}
            </ul>
            <div class="actions start">
              <Button variant="secondary" size="sm" onclick={copyBackupCodes}>Copy all</Button>
              <Button variant="secondary" size="sm" onclick={downloadBackupCodes}>Download .txt</Button>
              <Button variant="secondary" size="sm" onclick={() => { backupCodes = []; backupWarning = ''; }}>I have saved them</Button>
            </div>
          </div>
        {/if}

        {#if totpEnabled}
          <p class="status-row"><Badge tone="success">On</Badge> Sign-in asks for a code from your authenticator app.</p>
          <p class="muted">Backup codes remaining: <strong>{backupRemaining}</strong></p>
          {#if regenMode}
            <form class="inline-form" onsubmit={submitRegenerate}>
              <div class="field">
                <label for="regen-code">Authenticator code</label>
                <input id="regen-code" type="text" inputmode="numeric" bind:value={regenCode} class="input narrow" maxlength="6" autocomplete="one-time-code" aria-describedby="regen-hint" />
                <p class="hint" id="regen-hint">New codes replace every old backup code.</p>
              </div>
              <div class="actions start">
                <Button type="submit" size="sm" loading={totpLoading} disabled={totpLoading}>Generate new codes</Button>
                <Button variant="ghost" size="sm" onclick={() => { regenMode = false; regenCode = ''; }}>Cancel</Button>
              </div>
            </form>
          {:else if disableMode}
            <form class="inline-form" onsubmit={submitDisable2FA}>
              <div class="field">
                <label for="disable-code">Authenticator code</label>
                <input id="disable-code" type="text" inputmode="numeric" bind:value={totpCode} class="input narrow" maxlength="6" autocomplete="one-time-code" />
              </div>
              <div class="actions start">
                <Button type="submit" variant="danger" size="sm" loading={totpLoading} disabled={totpLoading}>Turn off two-factor authentication</Button>
                <Button variant="ghost" size="sm" onclick={cancelDisable}>Cancel</Button>
              </div>
            </form>
          {:else}
            <div class="actions start">
              <Button variant="secondary" size="sm" onclick={() => { regenConfirm = true; totpError = ''; }}>Regenerate backup codes</Button>
              <Button variant="outline" size="sm" onclick={() => (disableConfirm = true)}>Turn off…</Button>
            </div>
          {/if}
        {:else}
          <p class="status-row"><Badge tone="neutral">Off</Badge> A second factor protects the account if your password leaks.</p>
          <div class="actions start">
            <Button size="sm" loading={totpLoading} disabled={totpLoading} onclick={start2FASetup}>Set up two-factor authentication</Button>
          </div>
        {/if}
      </div>
    </section>

    <section class="section" aria-labelledby="sessions-heading">
      <h2 id="sessions-heading">Sessions</h2>
      <div class="form">
        <p class="muted">Sign out on every device and browser, this one included. Use it after a lost device or a suspected password leak.</p>
        {#if logoutAllError}
          <InlineError message={logoutAllError} onretry={logoutAllRetryable ? runLogoutAll : undefined} retrying={logoutAllBusy} />
        {/if}
        <div class="actions start">
          <Button variant="outline" size="sm" loading={logoutAllBusy} disabled={logoutAllBusy} onclick={requestLogoutAll}>Log out everywhere…</Button>
        </div>
      </div>
    </section>
  {/if}
</div>

<Modal open={setupMode} title="Set up two-factor authentication" onclose={cancelSetup} dirty={totpCode.trim().length > 0 || enablePassword.length > 0}>
  <p class="modal-desc">Scan the QR code with an authenticator app, then enter the 6-digit code it shows.</p>
  <div class="qr-setup">
    {#if qrSvg}
      <div class="qr-svg" role="img" aria-label="QR code for your authenticator app">{@html qrSvg}</div>
    {:else}
      <p class="muted" role="status">Preparing the QR code…</p>
    {/if}
    <p class="qr-secret"><span>Or enter this key manually</span> <code>{totpSecret}</code></p>
  </div>
  <form class="form" onsubmit={submitEnable2FA}>
    {#if totpError}<Alert tone="error" compact message={totpError} />{/if}
    <div class="field">
      <label for="enable-code">Verification code</label>
      <input id="enable-code" type="text" inputmode="numeric" bind:value={totpCode} class="input narrow" maxlength="6" autocomplete="one-time-code" data-autofocus />
    </div>
    <div class="field">
      <label for="enable-password">Current password</label>
      <input id="enable-password" type="password" bind:value={enablePassword} class="input" autocomplete="current-password" aria-describedby="enable-password-hint" required />
      <p class="hint" id="enable-password-hint">Confirms it is you. Other devices are signed out when two-factor authentication turns on.</p>
    </div>
    <div class="actions">
      <Button variant="ghost" onclick={cancelSetup}>Cancel</Button>
      <Button type="submit" loading={totpLoading} disabled={totpLoading}>Turn on</Button>
    </div>
  </form>
</Modal>

<ConfirmModal
  open={disableConfirm}
  tone="warning"
  title="Turn off two-factor authentication?"
  message="Your account loses its second factor: anyone with your password can sign in. You confirm with a code from your authenticator app in the next step."
  confirmLabel="Continue"
  onconfirm={() => { disableConfirm = false; disableMode = true; totpError = ''; }}
  onclose={() => (disableConfirm = false)}
/>

<ConfirmModal
  open={logoutAllConfirm}
  tone="warning"
  title="Log out everywhere?"
  message="Every session of your account ends, on all devices and this browser. You sign in again afterwards."
  confirmLabel="Log out everywhere"
  loading={logoutAllBusy}
  onconfirm={runLogoutAll}
  onclose={() => (logoutAllConfirm = false)}
/>

<ConfirmModal
  open={regenConfirm}
  tone="warning"
  title="Regenerate backup codes?"
  message="Every existing backup code stops working as soon as the new codes are issued."
  confirmLabel="Continue"
  onconfirm={() => { regenConfirm = false; regenMode = true; totpError = ''; }}
  onclose={() => (regenConfirm = false)}
/>

<style>
  .account-page { width: 100%; max-width: 760px; padding: var(--page-top) var(--page-gutter) var(--sp-7); }
  .section { border-top: 1px solid var(--border); padding: var(--sp-5) 0; }
  .section h2 { font-size: var(--fs-md); font-weight: var(--fw-semibold); margin: 0 0 var(--sp-4); }
  .form { display: grid; gap: var(--sp-4); }
  .inline-form { display: grid; gap: var(--sp-3); }
  .field { display: grid; gap: var(--sp-1); }
  .field label { font-size: var(--fs-sm); font-weight: var(--fw-medium); color: var(--text-primary); }
  .input {
    width: 100%;
    padding: var(--sp-2) var(--sp-3);
    background: var(--surface-input);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    color: var(--text-primary);
    font-size: var(--fs-base);
  }
  .input.narrow { max-width: 12rem; font-family: var(--font-mono); letter-spacing: 0.08em; }
  .input.readonly { background: var(--bg-tertiary); color: var(--text-secondary); }
  .hint { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
  .actions { display: flex; flex-wrap: wrap; gap: var(--sp-2); justify-content: flex-end; }
  .actions.start { justify-content: flex-start; }
  .muted { color: var(--text-muted); font-size: var(--fs-sm); margin: 0; }
  .status-row { display: flex; align-items: center; gap: var(--sp-2); margin: 0; font-size: var(--fs-sm); color: var(--text-secondary); flex-wrap: wrap; }
  .backup-panel { border: 1px solid var(--border); border-left: 3px solid var(--warning); border-radius: var(--radius); padding: var(--sp-4); background: var(--bg-card); }
  .backup-panel p { margin: 0 0 var(--sp-3); font-size: var(--fs-sm); color: var(--text-secondary); }
  .backup-list { list-style: none; padding: 0; margin: 0 0 var(--sp-3); display: grid; grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr)); gap: var(--sp-2); }
  .backup-list code { display: block; padding: var(--sp-1) var(--sp-2); background: var(--bg-tertiary); border-radius: var(--radius); text-align: center; font-size: var(--fs-sm); }
  .modal-desc { color: var(--text-secondary); font-size: var(--fs-sm); line-height: 1.5; margin: 0 0 var(--sp-3); }
  .qr-setup { display: grid; justify-items: center; gap: var(--sp-3); margin-bottom: var(--sp-4); }
  /* The QR code needs a light quiet zone in both themes to scan reliably. */
  .qr-svg { background: var(--bg-card); padding: var(--sp-3); border: 1px solid var(--border); border-radius: var(--radius-lg); }
  :global([data-theme='dark']) .qr-svg { background: var(--text-primary); }
  .qr-secret { margin: 0; text-align: center; font-size: var(--fs-xs); color: var(--text-muted); overflow-wrap: anywhere; }
  .qr-secret span { display: block; margin-bottom: var(--sp-1); }
  .qr-secret code { user-select: all; font-size: var(--fs-sm); color: var(--text-primary); background: var(--bg-tertiary); padding: var(--sp-1) var(--sp-2); border-radius: var(--radius); }
</style>
