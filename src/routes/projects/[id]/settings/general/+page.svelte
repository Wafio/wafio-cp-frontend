<!--
  Project settings: project details on their own, and the
  project's default WAF policy in a separate, URL-addressable tab
  (?tab=policy). Both panels stay mounted, so switching tabs never loses
  unsaved edits; leaving the page with unsaved changes asks first.
-->
<script lang="ts">
  import { page } from '$app/state';
  import { afterNavigate, replaceState } from '$app/navigation';
  import { base } from '#lib/paths.js';
  import { getProjectConfig, putProjectConfig, updateProject, type ConfigSecretFlags } from '#lib/api.js';
  import { inspectionOffFromFlags, inspectionSummary } from '#lib/inspection.js';
  import { draftFromRules } from '#lib/components/waf-policy/model.js';
  import { getProjectContext } from '#lib/project-context.svelte.js';
  import { createDirtyTracker } from '#lib/dirty.svelte.js';
  import { toast } from '#lib/stores/toast.js';
  import { DateTime } from '#lib/components/ui/index.js';
  import PageHeader from '#lib/components/ui/PageHeader.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Field from '#lib/components/ui/Field.svelte';
  import Tabs from '#lib/components/ui/Tabs.svelte';
  import Alert from '#lib/components/ui/Alert.svelte';
  import Spinner from '#lib/components/ui/Spinner.svelte';
  import ConfirmModal from '#lib/components/ui/ConfirmModal.svelte';
  import { readTabParam, tabDomIds, tabSearch } from '#lib/components/ui/tabs.js';
  import ConfigWafForm from '#lib/components/ConfigWafForm.svelte';
  import WAFConfigHistory from '#lib/components/WAFConfigHistory.svelte';
  import { focusFormError } from '#lib/focus-error.js';

  type ProjectConfig = { rules_json: Record<string, unknown>; config_revision: number } & ConfigSecretFlags;

  const ctx = getProjectContext();
  const projectId = $derived(page.params.id ?? '');
  const project = $derived(ctx.project);
  const canConfigure = $derived(ctx.canConfigure);

  // ── Tabs (URL: ?tab=policy; details is the default) ──
  const TABS_ID = 'project-settings';
  const TABS = [
    { id: 'details', label: 'Project details' },
    { id: 'policy', label: 'Default WAF policy' }
  ];
  const urlTab = () => readTabParam(page.url.searchParams, 'tab', TABS, 'details') ?? 'details';
  let tab = $state(urlTab());
  // Every real navigation (sidebar link, back/forward) selects the tab its
  // URL names, also the sidebar's plain /settings/general while the policy
  // tab is open. The shallow replaceState below is not a navigation and
  // leaves page.url as it was, so comparing URLs missed that case.
  afterNavigate(() => {
    tab = urlTab();
  });
  function selectTab(id: string) {
    tab = id;
    const url = new URL(page.url.href);
    url.search = tabSearch(url.searchParams, 'tab', id, 'details');
    // Shallow update: no navigation, so unsaved-change guards are not triggered.
    // goto(..., { shallow: true }) would run the navigation hooks, the deprecated replaceState does not.
    try {
      replaceState(url, page.state);
    } catch {
      // Router not ready (first render); the tab still switches.
    }
  }
  const ids = (id: string) => tabDomIds(TABS_ID, id);

  // ── Leave prompt shared by both panels ──
  let leavePrompt = $state<{ message: string; resolve: (ok: boolean) => void } | null>(null);
  function askLeave(message: string): Promise<boolean> {
    leavePrompt?.resolve(false);
    return new Promise((resolve) => (leavePrompt = { message, resolve }));
  }
  function answerLeave(ok: boolean) {
    const current = leavePrompt;
    leavePrompt = null;
    current?.resolve(ok);
  }

  // ── Project details ──
  let details = $state({ name: '', description: '' });
  const detailsTracker = createDirtyTracker(() => details, { confirm: askLeave });
  let detailsLoadedFor = '';
  let detailsSubmitted = $state(false);
  let detailsSaving = $state(false);
  let detailsError = $state('');

  // Fill the fields once per project (a later context refresh keeps edits in progress).
  $effect(() => {
    const p = project;
    if (!p || p.id === detailsLoadedFor) return;
    detailsLoadedFor = p.id;
    details = { name: p.name ?? '', description: p.description ?? '' };
    detailsTracker.reset();
    detailsSubmitted = false;
    detailsError = '';
  });

  const nameError = $derived(detailsSubmitted && !details.name.trim() ? 'Project name is required.' : undefined);

  let detailsSection = $state<HTMLElement>();

  async function saveDetails() {
    if (!canConfigure || detailsSaving) return;
    detailsSubmitted = true;
    if (!details.name.trim()) {
      void focusFormError(detailsSection);
      return;
    }
    const id = projectId;
    const next = { name: details.name.trim(), description: details.description.trim() };
    detailsSaving = true;
    detailsError = '';
    const result = await updateProject(id, next.name, next.description);
    detailsSaving = false;
    if (id !== projectId) return;
    if (result.error) {
      detailsError = result.error.error || 'Could not save the project details.';
      void focusFormError(detailsSection);
      return;
    }
    details = next;
    detailsTracker.reset();
    detailsSubmitted = false;
    ctx.update(next);
    toast.success('Project details saved.', 'Project updated');
  }

  function discardDetails() {
    details = { ...(detailsTracker.baseline as typeof details) };
    detailsSubmitted = false;
    detailsError = '';
  }

  // ── Default WAF policy ──
  let config = $state<ProjectConfig | null>(null);
  let configError = $state('');
  let configLoading = $state(false);
  let policyDirty = $state(false);

  // One leave-page guard for both panels (the policy form's own guard is off),
  // so leaving with edits in both asks once.
  function leaveMessage(): string {
    const parts = [detailsTracker.isDirty ? 'the project details' : '', policyDirty ? 'the default WAF policy' : ''].filter(Boolean);
    return `Your changes to ${parts.join(' and ') || 'this page'} are not saved; they are lost if you leave this page.`;
  }
  const leaveTracker = createDirtyTracker(() => detailsTracker.isDirty || policyDirty);
  leaveTracker.guardNavigation({ confirm: () => askLeave(leaveMessage()) });
  let scopeEpoch = 0;

  async function loadConfig(): Promise<void> {
    const id = projectId;
    const epoch = ++scopeEpoch;
    configLoading = true;
    configError = '';
    const result = await getProjectConfig(id);
    if (epoch !== scopeEpoch || id !== projectId) return;
    configLoading = false;
    if (result.data) config = result.data;
    else configError = result.error?.error ?? 'Could not load the default WAF policy.';
  }

  $effect(() => {
    if (!projectId) return;
    config = null;
    void loadConfig();
    return () => {
      scopeEpoch++;
    };
  });

  async function saveConfig(value: { rules_json: Record<string, unknown> }) {
    const id = projectId;
    const epoch = scopeEpoch;
    const expected = config?.config_revision ?? -1;
    const result = await putProjectConfig(id, value.rules_json, expected);
    if (id !== projectId || epoch !== scopeEpoch) return { error: 'The project changed while saving. Reload its policy before saving again.' };
    if (result.error) return { error: result.error.error || 'Could not save the default WAF policy.', code: result.error.code, status: result.error.status };
    if (result.data) config = { rules_json: value.rules_json, config_revision: result.data.config_revision };
    return {};
  }

  const policySummary = $derived.by(() => {
    if (!config) return null;
    const rules = config.rules_json as { semantic_policies?: Record<string, unknown>; path_exceptions?: unknown[] };
    return {
      inspection: inspectionSummary(inspectionOffFromFlags(rules.semantic_policies)),
      weak: draftFromRules(config.rules_json).engines.recordWeakDetections,
      paths: Array.isArray(rules.path_exceptions) ? rules.path_exceptions.length : 0
    };
  });
</script>

<div class="settings-page">
  <PageHeader
    title="Project settings"
    subtitle="Project details, and the default WAF policy that applications use unless they have their own."
    backHref={`${base}/projects/${projectId}`}
  />

  {#if ctx.error && !project}
    <Alert tone="error" message={ctx.error.error}>
      {#snippet actions()}<Button variant="secondary" size="sm" onclick={() => void ctx.refresh()}>Retry</Button>{/snippet}
    </Alert>
  {:else if !project}
    <Spinner label="Loading project" layout="block" />
  {:else}
    {#if !canConfigure}
      <div class="settings-notice"><Alert tone="info" message="You have read-only access. Project members and owners can change these settings." /></div>
    {/if}

    <Tabs tabs={TABS} bind:value={tab} onchange={selectTab} label="Project settings" id={TABS_ID} panels="external" />

    <div class="settings-panel" role="tabpanel" id={ids('details').panel} aria-labelledby={ids('details').tab} hidden={tab !== 'details'}>
      <section class="settings-card" aria-labelledby="project-details-title" bind:this={detailsSection}>
        <div class="settings-card-head">
          <h2 id="project-details-title">Project details</h2>
          <p>How this project is named across the dashboard.</p>
        </div>
        <div class="settings-fields">
          <Field label="Name" error={nameError} id="project-name" required>
            {#snippet children(c)}<input {...c} type="text" autocomplete="off" bind:value={details.name} disabled={!canConfigure} />{/snippet}
          </Field>
          <Field label="Description" hint="Shown under the project name in the project list." id="project-description" optional>
            {#snippet children(c)}<textarea {...c} rows="2" bind:value={details.description} disabled={!canConfigure}></textarea>{/snippet}
          </Field>
          <dl class="settings-facts">
            {#if project.code}<div><dt>Project code</dt><dd><code>{project.code}</code></dd></div>{/if}
            <div><dt>Project ID</dt><dd><code>{project.id}</code></dd></div>
            {#if project.created_at}<div><dt>Created</dt><dd><DateTime value={project.created_at} /></dd></div>{/if}
          </dl>
        </div>
        {#if detailsError}<Alert tone="error" compact message={detailsError} />{/if}
        {#if canConfigure}
          <div class="settings-actions">
            <span class="settings-status" aria-live="polite">{detailsTracker.isDirty ? 'Unsaved changes' : ''}</span>
            <Button variant="secondary" onclick={discardDetails} disabled={!detailsTracker.isDirty || detailsSaving}>Discard</Button>
            <Button onclick={() => void saveDetails()} loading={detailsSaving} disabled={!detailsTracker.isDirty || detailsSaving}>Save details</Button>
          </div>
        {/if}
      </section>

      <section class="settings-card" aria-labelledby="policy-summary-title">
        <div class="settings-card-head">
          <h2 id="policy-summary-title">Default WAF policy</h2>
          <p>Detection settings every application in this project starts from. An application can override them on the Config tab of its application page.</p>
        </div>
        {#if policySummary}
          <dl class="settings-policy">
            <div><dt>Inspection</dt><dd>{policySummary.inspection}</dd></div>
            <div><dt>Weak detections</dt><dd>{policySummary.weak ? 'Recorded' : 'Not recorded'}</dd></div>
            <div><dt>Rule paths</dt><dd>{policySummary.paths}</dd></div>
            <div><dt>Revision</dt><dd>{config?.config_revision ?? 'n/a'}</dd></div>
          </dl>
        {:else if configError}
          <Alert tone="error" compact message={configError} />
        {:else}
          <Spinner label="Loading default policy" size="sm" />
        {/if}
        <div class="settings-actions">
          {#if policyDirty}<span class="settings-status">The default policy has unsaved changes.</span>{/if}
          <Button variant="secondary" onclick={() => selectTab('policy')}>{canConfigure ? 'Edit default WAF policy' : 'View default WAF policy'}</Button>
        </div>
      </section>
    </div>

    <div class="settings-panel" role="tabpanel" id={ids('policy').panel} aria-labelledby={ids('policy').tab} hidden={tab !== 'policy'}>
      {#if configError && !config}
        <Alert tone="error" message={configError}>
          {#snippet actions()}<Button variant="secondary" size="sm" onclick={() => void loadConfig()}>Retry</Button>{/snippet}
        </Alert>
      {:else if !config}
        <Spinner label="Loading default policy" layout="block" />
      {:else}
        <ConfigWafForm
          title="Default WAF policy"
          {projectId}
          initialRules={config.rules_json}
          source={`project defaults, revision ${config.config_revision}`}
          readonly={!canConfigure}
          secretFlags={config}
          navigationGuard={false}
          bind:dirty={policyDirty}
          onSave={saveConfig}
          onReload={loadConfig}
        />
        <WAFConfigHistory
          {projectId}
          currentRevision={config.config_revision}
          {canConfigure}
          unsavedChanges={policyDirty}
          onChanged={loadConfig}
        />
      {/if}
    </div>
  {/if}
</div>

<ConfirmModal
  open={leavePrompt !== null}
  tone="warning"
  title="Leave without saving?"
  message={leavePrompt?.message ?? ''}
  confirmLabel="Leave and discard"
  cancelLabel="Stay on this page"
  onconfirm={() => answerLeave(true)}
  onclose={() => answerLeave(false)}
/>

<style>
  .settings-page { padding: var(--page-top, 32px) var(--page-gutter, 24px) 48px; width: 100%; min-width: 0; box-sizing: border-box; }
  .settings-notice { margin-bottom: var(--sp-4); }
  .settings-panel { display: flex; flex-direction: column; gap: var(--sp-5); min-width: 0; }
  .settings-panel[hidden] { display: none; }
  .settings-card { display: flex; flex-direction: column; gap: var(--sp-4); padding: var(--sp-5); background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-lg); min-width: 0; }
  .settings-card-head h2 { margin: 0; font-size: var(--fs-md); font-weight: var(--fw-semibold); color: var(--text-primary); }
  .settings-card-head p { margin: var(--sp-1) 0 0; font-size: var(--fs-sm); line-height: 1.6; color: var(--text-muted); max-width: 72ch; }
  .settings-fields { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 2fr); gap: var(--sp-4) var(--sp-5); }
  .settings-fields textarea { resize: vertical; }
  .settings-facts { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: var(--sp-2) var(--sp-6); margin: 0; font-size: var(--fs-sm); }
  .settings-facts dt, .settings-policy dt { color: var(--text-muted); font-size: var(--fs-xs); }
  .settings-facts dd, .settings-policy dd { margin: calc(var(--sp-1) / 2) 0 0; color: var(--text-primary); overflow-wrap: anywhere; }
  .settings-facts code { font-family: var(--font-mono); font-size: var(--fs-xs); }
  .settings-policy { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: var(--sp-3) var(--sp-5); margin: 0; }
  .settings-policy dd { font-size: var(--fs-md); font-weight: var(--fw-semibold); }
  .settings-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: var(--sp-2); padding-top: var(--sp-4); border-top: 1px solid var(--border); }
  .settings-status { margin-right: auto; font-size: var(--fs-sm); color: var(--text-secondary); }
  @media (max-width: 640px) {
    .settings-fields { grid-template-columns: minmax(0, 1fr); }
    .settings-card { padding: var(--sp-4); }
  }
</style>
