<!--
  Administration › Email (SMTP): the mail server and the dashboard base URL
  used for invitations and password reset emails. Values set
  in the server configuration are shown read-only; the password is
  write-only. Saves apply at once (no restart).
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { auth } from '#lib/stores/auth.js';
  import { clearSmtpSettings, getSmtpSettings, sendSmtpTest, updateSmtpSettings, type SmtpField, type SmtpSettings } from '#lib/api.js';
  import { createDirtyTracker } from '#lib/dirty.svelte.js';
  import {
    SECURITY_OPTIONS,
    buildSmtpUpdate,
    defaultPort,
    formFromSettings,
    hasErrors,
    hasSavedSettings,
    isManaged,
    passwordClearedBy,
    testRecipientError,
    smtpStatus,
    sourceNote,
    validateSmtpForm,
    type SmtpForm,
    type SmtpFormErrors,
  } from '#lib/smtp-settings.js';
  import PageHeader from '#lib/components/ui/PageHeader.svelte';
  import Alert from '#lib/components/ui/Alert.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Card from '#lib/components/ui/Card.svelte';
  import ConfirmModal from '#lib/components/ui/ConfirmModal.svelte';
  import Field from '#lib/components/ui/Field.svelte';
  import Select from '#lib/components/ui/Select.svelte';
  import { toast } from '#lib/stores/toast.js';

  const EMPTY: SmtpForm = { host: '', port: '', security: 'auto', username: '', password: '', clearPassword: false, fromAddress: '', fromName: '', baseUrl: '' };

  let settings = $state<SmtpSettings | null>(null);
  let form = $state<SmtpForm>({ ...EMPTY });
  let baseline = $state<SmtpForm>({ ...EMPTY });
  let errors = $state<SmtpFormErrors>({});
  let loadError = $state('');
  let saveError = $state('');
  let loading = $state(true);
  let saving = $state(false);
  let confirmClear = $state(false);
  let clearing = $state(false);
  let testTo = $state('');
  let testing = $state(false);
  let testResult = $state<{ tone: 'success' | 'error'; message: string } | null>(null);

  const dirty = createDirtyTracker(() => form);
  dirty.guardNavigation();

  const status = $derived(settings ? smtpStatus(settings) : null);
  const smtpLocked = $derived(settings?.smtp_managed_by_config ?? false);
  const baseLocked = $derived(settings?.base_url_managed_by_config ?? false);
  const canEdit = $derived(!!settings?.editable);
  const securityHint = $derived(SECURITY_OPTIONS.find((o) => o.value === form.security)?.hint ?? '');
  // Saving a new host or username without a new password clears the saved one.
  const clearedBy = $derived(passwordClearedBy(form, baseline, settings));

  function apply(next: SmtpSettings) {
    settings = next;
    form = formFromSettings(next);
    baseline = formFromSettings(next);
    errors = {};
    dirty.reset();
  }

  async function load() {
    loading = true;
    const res = await getSmtpSettings();
    loading = false;
    if (res.error || !res.data) {
      loadError = res.error?.error ?? 'Unable to load the email settings.';
      return;
    }
    loadError = '';
    apply(res.data);
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (!settings || saving) return;
    saveError = '';
    errors = validateSmtpForm(form, settings);
    if (hasErrors(errors)) return;
    const update = buildSmtpUpdate(form, baseline, settings);
    if (Object.keys(update).length === 0) {
      dirty.reset();
      return;
    }
    saving = true;
    const res = await updateSmtpSettings(update);
    saving = false;
    if (res.error || !res.data) {
      const field = res.error?.field as SmtpField | undefined;
      if (field && res.error?.code === 'VALIDATION_FAILED') errors = { [field]: res.error.error };
      else saveError = res.error?.error ?? 'The settings could not be saved.';
      return;
    }
    apply(res.data);
    testResult = null;
    toast.success('Email settings saved. They apply at once.');
  }

  function discard() {
    form = { ...baseline };
    errors = {};
    saveError = '';
  }

  async function clearSaved() {
    clearing = true;
    const res = await clearSmtpSettings();
    clearing = false;
    if (res.error) {
      toast.error(res.error.error ?? 'The saved settings could not be removed.');
      return;
    }
    confirmClear = false;
    testResult = null;
    toast.success('Saved email settings removed.');
    await load();
  }

  async function sendTest() {
    if (testing) return;
    const to = testTo.trim();
    const problem = testRecipientError(to);
    if (problem) {
      testResult = { tone: 'error', message: problem };
      return;
    }
    testing = true;
    testResult = null;
    const res = await sendSmtpTest(to || undefined);
    testing = false;
    testResult = res.error || !res.data
      ? { tone: 'error', message: res.error?.error ?? 'The test email could not be sent.' }
      : { tone: 'success', message: `Test email sent to ${res.data.to}. Check that it arrived (and not in spam).` };
  }

  onMount(load);
</script>

<div class="admin-page">
  <PageHeader title="Email (SMTP)" subtitle="Mail server and dashboard address for invitation and password reset emails. Changes apply at once." />

  {#if loading}
    <p class="hint" role="status">Loading email settings…</p>
  {:else if loadError}
    <Alert tone="error" message={loadError}>
      {#snippet actions()}<Button variant="secondary" size="sm" onclick={load}>Retry</Button>{/snippet}
    </Alert>
  {:else if settings}
    {#if status}<Alert tone={status.tone} message={status.message} />{/if}
    {#if !canEdit}
      <Alert tone="warning" title="Secure storage unavailable" message="The server encryption key is not available, so settings cannot be saved here. Values from the server configuration still apply." />
    {/if}

    <form onsubmit={save} novalidate class="settings">
      <Card title="Mail server">
        {#if smtpLocked}
          <p class="managed-note">The mail server is set in the server configuration (<code>smtp.host</code> in config.yaml or <code>WAFIO_SMTP_*</code>), so these fields are read-only here. To manage it on this page, remove it from the configuration and restart the control plane.</p>
        {/if}
        <div class="grid">
          <Field label="Host" hint={sourceNote(settings.sources.host) || 'For example smtp.example.com. Empty: no email is sent.'} error={errors.host}>
            {#snippet children(control)}
              <input {...control} type="text" bind:value={form.host} readonly={smtpLocked || !canEdit} autocomplete="off" spellcheck="false" maxlength="253" />
            {/snippet}
          </Field>
          <Field label="Port" hint={isManaged(settings, 'port') ? sourceNote('config') : `Empty uses ${defaultPort(form.security)} for this security mode.`} error={errors.port}>
            {#snippet children(control)}
              <input {...control} type="text" inputmode="numeric" bind:value={form.port} readonly={smtpLocked || !canEdit} placeholder={String(defaultPort(form.security))} maxlength="5" />
            {/snippet}
          </Field>
          <Field label="Security" hint={isManaged(settings, 'security') ? sourceNote('config') : securityHint}>
            {#snippet children(control)}
              <Select {...control} options={SECURITY_OPTIONS} bind:value={form.security} disabled={smtpLocked || !canEdit} />
            {/snippet}
          </Field>
          <Field label="Username" optional hint={sourceNote(settings.sources.username) || 'Account on the mail server; empty for a server without login.'} error={errors.username}>
            {#snippet children(control)}
              <input {...control} type="text" bind:value={form.username} readonly={smtpLocked || !canEdit} autocomplete="off" spellcheck="false" maxlength="256" />
            {/snippet}
          </Field>
          <Field
            label="Password"
            optional
            hint={smtpLocked
              ? `${sourceNote('config')} ${settings.password_set ? 'A password is set.' : 'No password is set.'}`
              : form.clearPassword
                ? 'The saved password is removed when you save.'
                : settings.password_set
                  ? 'Saved. Leave empty to keep it. Changing the host or username clears it: enter it again then. Stored encrypted and never shown again.'
                  : 'Stored encrypted on the server and never shown again.'}
            error={errors.password}
          >
            {#snippet children(control)}
              <input {...control} type="password" bind:value={form.password} readonly={smtpLocked || !canEdit || form.clearPassword} autocomplete="new-password" placeholder={settings?.password_set ? '••••••••' : ''} />
            {/snippet}
          </Field>
          {#if clearedBy && !smtpLocked && canEdit}
            <Alert
              tone="warning"
              compact
              message={`You changed the ${clearedBy}, so saving clears the saved password. It is never sent to a different server or account. Enter the password again to keep sending with a login.`}
            />
          {/if}
          {#if settings.password_set && !smtpLocked && canEdit}
            <Field label="Remove the saved password" layout="inline">
              {#snippet children(control)}
                <input {...control} type="checkbox" bind:checked={form.clearPassword} onchange={() => (form.password = '')} />
              {/snippet}
            </Field>
          {/if}
          <Field label="Sender address" hint={sourceNote(settings.sources.from_address) || 'The From address. Many servers require it to belong to the account above.'} error={errors.from_address}>
            {#snippet children(control)}
              <input {...control} type="email" bind:value={form.fromAddress} readonly={smtpLocked || !canEdit} autocomplete="off" maxlength="254" placeholder="noreply@example.com" />
            {/snippet}
          </Field>
          <Field label="Sender name" optional hint={sourceNote(settings.sources.from_name) || 'Shown as the sender, for example WAFio.'} error={errors.from_name}>
            {#snippet children(control)}
              <input {...control} type="text" bind:value={form.fromName} readonly={smtpLocked || !canEdit} autocomplete="off" maxlength="128" />
            {/snippet}
          </Field>
        </div>
      </Card>

      <Card title="Links in emails">
        <Field
          label="Dashboard base URL"
          hint={baseLocked
            ? `${sourceNote('config')} (server.base_url)`
            : 'The address people open the dashboard at, for example https://waf.example.com. Reset and invitation links point here; it is never taken from the incoming request.'}
          error={errors.base_url}
        >
          {#snippet children(control)}
            <input {...control} type="url" bind:value={form.baseUrl} readonly={baseLocked || !canEdit} autocomplete="off" spellcheck="false" placeholder="https://waf.example.com" />
          {/snippet}
        </Field>
      </Card>

      {#if saveError}<Alert tone="error" compact message={saveError} />{/if}
      {#if canEdit && !(smtpLocked && baseLocked)}
        <div class="actions">
          <Button type="submit" loading={saving} disabled={saving || !dirty.isDirty}>{saving ? 'Saving…' : 'Save settings'}</Button>
          <Button variant="ghost" disabled={saving || !dirty.isDirty} onclick={discard}>Discard changes</Button>
          {#if hasSavedSettings(settings)}
            <Button variant="danger" class="push" disabled={saving} onclick={() => (confirmClear = true)}>Clear saved settings</Button>
          {/if}
        </div>
      {/if}
    </form>

    <Card title="Send a test email">
      <p class="hint">Uses the settings in force{dirty.isDirty ? '. Save your changes first to test them' : ''}. At most three tests a minute.</p>
      <div class="test-row">
        <Field label="Recipient" hint={`Empty sends it to your own address${$auth.user?.email ? ` (${$auth.user.email})` : ''}.`}>
          {#snippet children(control)}
            <!-- Button on the input's line, so it lines up with the input and not with the hint below. -->
            <div class="test-control">
              <input {...control} type="email" bind:value={testTo} autocomplete="email" maxlength="254" placeholder={$auth.user?.email ?? ''} />
              <Button variant="secondary" loading={testing} disabled={testing || !settings.mail_configured} onclick={sendTest}>{testing ? 'Sending…' : 'Send test email'}</Button>
            </div>
          {/snippet}
        </Field>
      </div>
      {#if testResult}<Alert tone={testResult.tone} compact message={testResult.message} />{/if}
    </Card>
  {/if}
</div>

<ConfirmModal
  open={confirmClear}
  tone="danger"
  title="Clear saved email settings"
  message="Remove the mail server, password and base URL saved on this page? Values from the server configuration stay in force. Without a mail server, invitations are not emailed and password reset by email turns off."
  confirmLabel="Clear settings"
  loading={clearing}
  onconfirm={clearSaved}
  onclose={() => (confirmClear = false)}
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
  .settings { display: flex; flex-direction: column; gap: var(--sp-5); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: var(--sp-4); }
  .managed-note { margin: 0 0 var(--sp-4); font-size: var(--fs-sm); color: var(--text-secondary); }
  .hint { margin: 0 0 var(--sp-3); font-size: var(--fs-sm); color: var(--text-muted); }
  .actions { display: flex; flex-wrap: wrap; gap: var(--sp-3); align-items: center; }
  .actions :global(.push) { margin-left: auto; }
  .test-row { margin-bottom: var(--sp-3); }
  .test-control { display: flex; flex-wrap: wrap; gap: var(--sp-3); align-items: stretch; }
  .test-control input { flex: 1 1 260px; min-width: 0; }
  .test-control :global(.btn) { flex: none; }
  code { font-family: var(--font-mono, monospace); font-size: var(--fs-xs); }
</style>
