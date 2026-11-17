<!--
  AppConfigPanel: the Config tab: this application's WAF policy (its own
  override or the inherited project defaults), reset to the defaults, and
  the configuration history. Moved from /waf/:agentId/:appId.

  `dirty` reports unsaved edits in ConfigWafForm so the application page can
  guard tab switches and navigation; the page owns the leave-page
  guard, so the form's own guard is off.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { getAppConfig, putAppConfig, resetAppConfig, type AppConfigSource, type ConfigSecretFlags } from '#lib/api.js';
  import ConfigWafForm from '#lib/components/ConfigWafForm.svelte';
  import WAFConfigHistory from '#lib/components/WAFConfigHistory.svelte';
  import { Alert, Badge, Button, ConfirmModal, DateTime, InlineError, Spinner } from '#lib/components/ui/index.js';
  import { toast } from '#lib/stores/toast.js';

  let {
    projectId,
    agentId,
    appId,
    appName,
    canConfigure = false,
    enforcementMode = null,
    dirty = $bindable(false),
  }: {
    projectId: string;
    agentId: string;
    appId: string;
    appName: string;
    canConfigure?: boolean;
    /** The route's Monitor/Block mode, shown in the protection section (changed on the Assignment tab). */
    enforcementMode?: 'block' | 'monitor' | null;
    dirty?: boolean;
  } = $props();

  let rules = $state<Record<string, unknown>>({});
  let generation = $state(0);
  let revision = $state(0);
  let source = $state<AppConfigSource>('default');
  let updatedAt = $state<string | undefined>(undefined);
  let secretFlags = $state<ConfigSecretFlags | null>(null);
  let loading = $state(true);
  let loaded = $state(false);
  let error = $state('');
  let resetOpen = $state(false);
  let resetting = $state(false);
  let resetError = $state('');
  let epoch = 0;

  async function load(silent = false) {
    const my = ++epoch;
    const project = projectId;
    const agent = agentId;
    const app = appId;
    if (!silent) loading = true;
    error = '';
    const result = await getAppConfig(project, agent, app);
    if (my !== epoch) return;
    loading = false;
    if (result.error || !result.data) {
      error = result.error?.error || 'Could not load the configuration.';
      return;
    }
    rules = (result.data.rules_json ?? {}) as Record<string, unknown>;
    generation = result.data.generation ?? 0;
    source = result.data.source ?? 'default';
    updatedAt = result.data.updated_at;
    const { secrets_redacted, webhook_url_set, challenge_secret_key_set, aes_keys_set } = result.data;
    secretFlags = { secrets_redacted, webhook_url_set, challenge_secret_key_set, aes_keys_set };
    // New rules reload the form; an echo of what it just saved keeps in-flight edits.
    revision = result.data.config_revision;
    loaded = true;
  }

  $effect(() => {
    void `${projectId}/${agentId}/${appId}`;
    untrack(() => {
      loaded = false;
      dirty = false;
      void load();
    });
    return () => {
      epoch++;
    };
  });

  async function save({ rules_json }: { rules_json: Record<string, unknown> }) {
    if (!canConfigure) return { error: 'Member access is required to change the configuration.' };
    const my = epoch;
    const result = await putAppConfig(projectId, agentId, appId, { rules_json, expected_revision: revision });
    if (my !== epoch) return { error: 'The application changed while saving.' };
    if (result.error) {
      if (result.error.status === 409) {
        return { error: 'Someone else saved this configuration first. Reload to see their version, then apply your change again.', code: 'CONFIG_CONFLICT' };
      }
      return { error: result.error.error || 'Could not save the configuration.', code: result.error.code, status: result.error.status };
    }
    await load(true);
    return {};
  }

  async function reset() {
    if (!canConfigure || resetting) return;
    resetting = true;
    resetError = '';
    const my = epoch;
    const result = await resetAppConfig(projectId, agentId, appId, revision);
    if (my !== epoch) return;
    resetting = false;
    if (result.error) {
      // Keep the dialog open with the reason; nothing was changed.
      resetError = result.error.status === 409
        ? 'Someone else saved this configuration first. Close this dialog, reload, and reset again if you still want to.'
        : result.error.error || 'Could not reset the configuration.';
      return;
    }
    resetOpen = false;
    toast.success('The application now inherits the project defaults.', 'Override removed');
    await load();
  }

  const SOURCE_TEXT: Record<AppConfigSource, string> = {
    app: 'Own configuration (overrides the project defaults)',
    project: 'Inherited from the project defaults',
    default: 'Built-in defaults (no project defaults saved)',
  };
</script>

<section class="cfg" aria-labelledby="cfg-title">
  <header class="cfg-head">
    <div>
      <h2 id="cfg-title">WAF configuration</h2>
      <p>Applies to <strong>{appName}</strong> only. Saving stores the desired configuration; the agent applies it when it receives the next bundle.</p>
    </div>
    <div class="cfg-meta">
      {#if loaded}
        <Badge tone={source === 'app' ? 'info' : 'neutral'}>{SOURCE_TEXT[source]}</Badge>
        <span class="cfg-rev">Revision {revision} {#if updatedAt}{" · "}saved <DateTime value={updatedAt} />{/if}</span>
      {/if}
      <Button variant="secondary" size="sm" disabled={!canConfigure || source !== 'app' || !loaded} title={source !== 'app' ? 'This application already uses the project defaults' : undefined} onclick={() => { resetError = ''; resetOpen = true; }}>Reset to project defaults</Button>
    </div>
  </header>

  {#if !canConfigure}
    <Alert tone="info" message="Read-only: viewers can inspect the configuration; project members and owners can change it." />
  {/if}

  {#if loading && !loaded}
    <Spinner layout="block" tone="accent" label="Loading configuration" />
  {:else if error && !loaded}
    <InlineError message={error} onretry={() => void load()} />
  {:else}
    <InlineError message={error} onretry={() => void load()} />
    {#key `${projectId}/${agentId}/${appId}`}
      <div class="cfg-form">
        <ConfigWafForm
          {projectId}
          {appId}
          initialRules={rules}
          {generation}
          {source}
          readonly={!canConfigure}
          heading={false}
          {secretFlags}
          {enforcementMode}
          navigationGuard={false}
          bind:dirty
          onSave={save}
          onReload={() => load()}
        />
      </div>
    {/key}
    <WAFConfigHistory {projectId} {appId} currentRevision={revision} {canConfigure} unsavedChanges={dirty} onChanged={() => load()} />
  {/if}
</section>

<ConfirmModal
  open={resetOpen}
  tone="warning"
  title="Reset to project defaults?"
  confirmLabel="Reset configuration"
  loading={resetting}
  onconfirm={() => void reset()}
  onclose={() => { if (!resetting) resetOpen = false; }}
>
  <p class="cfg-confirm">Removes this application's own configuration. It then follows the project defaults, including future changes to them. Earlier revisions stay in the configuration history below.</p>
  {#if dirty}
    <Alert tone="warning" compact message="You have unsaved changes in the form below. Resetting discards them." />
  {/if}
  {#if resetError}
    <Alert tone="error" compact title="Reset failed" message={resetError} />
  {/if}
</ConfirmModal>

<style>
  .cfg { display: flex; flex-direction: column; gap: var(--sp-4); min-width: 0; max-width: 100%; }
  .cfg-head { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--sp-4); flex-wrap: wrap; }
  .cfg-head h2 { margin: 0; font-size: var(--fs-md); }
  .cfg-head p { margin: var(--sp-1) 0 0; font-size: var(--fs-sm); color: var(--text-muted); max-width: 70ch; line-height: 1.5; }
  .cfg-head strong { color: var(--text-primary); }
  .cfg-meta { display: flex; align-items: center; gap: var(--sp-3); flex-wrap: wrap; }
  .cfg-rev { font-size: var(--fs-xs); color: var(--text-muted); }
  .cfg-form { min-width: 0; max-width: 100%; }
  .cfg-confirm { margin: 0; color: var(--text-secondary); line-height: 1.5; }
</style>
