<!--
  ConfigWafForm: the WAF policy editor.
  A thin shell over WafPolicyForm (waf-policy/waf-policy-form.svelte.ts) and
  the section components in waf-policy/: section index, error summary, the
  sections (protection preset first), a sticky save bar, a review drawer and
  unsaved-change guards.

  Props kept from the old form: initialRules, generation, source, onSave,
  projectId, appId. New:
    - `bind:dirty`, true while unsaved changes exist (guard tab switches);
    - `readonly`, show the policy without edit controls;
    - `onReload`, called from the 409 CONFIG_CONFLICT notice (`onSave` may
      return `{ error, code }`); the parent reloads and passes new rules;
    - `enforcementMode` / `onEnforcementChange` / `enforcementBusy`, the
      application route's Monitor/Block mode shown in the protection section;
    - `appId` tells an application's policy from the project defaults;
    - `title`, heading of the editor (default "WAF policy");
    - `heading`, false when the embedding page already has a heading for the editor (the title and its sentence go);
    - `navigationGuard`, false when the embedding page already guards
      navigation on `bind:dirty` (one prompt instead of two);
    - `secretFlags`, credential flags of the config read: redacted
      secrets show as "Configured (hidden)" and the form is read-only, so the
      blanks are never saved back.
  A new `initialRules` value (a new object) reloads the form and drops unsaved
  edits.
-->
<script lang="ts">
  import './waf-policy/policy.css';
  import { onMount, tick, untrack } from 'svelte';
  import { getCountryCodes, type ConfigSecretFlags } from '#lib/api.js';
  import { hasRedactedSecrets } from '#lib/secret-redaction.js';
  import { policySaveError, type PolicySaveError } from './waf-policy/save-errors';
  import { toast } from '#lib/stores/toast.js';
  import Alert from '#lib/components/ui/Alert.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import InlineError from '#lib/components/ui/InlineError.svelte';
  import ConfirmModal from '#lib/components/ui/ConfirmModal.svelte';
  import { WafPolicyForm } from './waf-policy/waf-policy-form.svelte';
  import { policySections, sectionDomId } from './waf-policy/sections';
  import type { PolicyIssue, SectionId } from './waf-policy/validate';
  import PolicyIndex from './waf-policy/PolicyIndex.svelte';
  import ErrorSummary from './waf-policy/ErrorSummary.svelte';
  import SaveBar from './waf-policy/SaveBar.svelte';
  import ReviewDrawer from './waf-policy/ReviewDrawer.svelte';
  import ProtectionSection from './waf-policy/ProtectionSection.svelte';
  import AccessSection from './waf-policy/AccessSection.svelte';
  import RateLimitSection from './waf-policy/RateLimitSection.svelte';
  import BotSection from './waf-policy/BotSection.svelte';
  import ChallengeSection from './waf-policy/ChallengeSection.svelte';
  import IpReputationSection from './waf-policy/IpReputationSection.svelte';
  import ContentScanSection from './waf-policy/ContentScanSection.svelte';
  import SsrfSection from './waf-policy/SsrfSection.svelte';
  import WebSocketSection from './waf-policy/WebSocketSection.svelte';
  import PathRulesSection from './waf-policy/PathRulesSection.svelte';
  import CustomRulesSummary from './waf-policy/CustomRulesSummary.svelte';
  import ResponsesSection from './waf-policy/ResponsesSection.svelte';
  import IntegrationsSection from './waf-policy/IntegrationsSection.svelte';

  type EnforcementMode = 'block' | 'monitor';
  type SaveResult = { error?: string; code?: string; status?: number } | void;

  interface Props {
    initialRules?: Record<string, any>;
    generation?: number | null;
    source?: string | null;
    onSave?: (args: { rules_json: Record<string, any> }) => Promise<SaveResult>;
    projectId?: string;
    appId?: string;
    /** True while the form holds unsaved changes (bindable, read by the page). */
    dirty?: boolean;
    readonly?: boolean;
    onReload?: () => void | Promise<void>;
    enforcementMode?: EnforcementMode | null;
    onEnforcementChange?: (mode: EnforcementMode) => void;
    enforcementBusy?: boolean;
    title?: string;
    heading?: boolean;
    /** Register this form's own leave-page guard (default true). */
    navigationGuard?: boolean;
    /** Credential flags from the config read (secrets_redacted, *_set). */
    secretFlags?: ConfigSecretFlags | null;
  }

  let {
    initialRules = {},
    generation = null,
    source = null,
    onSave = async () => ({}),
    projectId = '',
    appId = '',
    dirty = $bindable(false),
    readonly = false,
    onReload = undefined,
    enforcementMode = null,
    onEnforcementChange = undefined,
    enforcementBusy = false,
    title = 'WAF policy',
    heading = true,
    navigationGuard = true,
    secretFlags = null
  }: Props = $props();

  const form = new WafPolicyForm(
    untrack(() => initialRules),
    { includeWebSocket: untrack(() => Boolean(appId)) }
  );

  $effect.pre(() => {
    form.engineScope = appId ? 'app' : 'project';
  });

  // Leave/discard prompts use a native dialog instead of window.confirm.
  let prompt = $state<{ message: string; resolve: (ok: boolean) => void } | null>(null);
  function askDiscard(): Promise<boolean> {
    const count = form.changeCount;
    const message = `The WAF policy has ${count} unsaved ${count === 1 ? 'change' : 'changes'}; they are lost if you leave this page.`;
    prompt?.resolve(false);
    return new Promise((resolve) => (prompt = { message, resolve }));
  }
  function answerPrompt(ok: boolean) {
    const current = prompt;
    prompt = null;
    current?.resolve(ok);
  }
  form.setConfirm(askDiscard);
  // A page that guards navigation on `bind:dirty` passes navigationGuard={false}.
  if (untrack(() => navigationGuard)) form.guardNavigation();

  let saving = $state(false);
  let saveError = $state<PolicySaveError | null>(null);
  let reloading = $state(false);
  let reviewOpen = $state(false);
  let discardOpen = $state(false);
  let summary = $state<ReturnType<typeof ErrorSummary>>();

  // New rules from the page (reload after a save, a restore or a conflict).
  // When the page only echoes back what this form just saved, edits made
  // while the save was in flight are kept instead of being reloaded away.
  let loadedRules = untrack(() => initialRules);
  let lastSaved: { json: string } | null = null;
  $effect.pre(() => {
    const rules = initialRules;
    if (rules === loadedRules) return;
    loadedRules = rules;
    untrack(() => {
      if (lastSaved && JSON.stringify(rules ?? {}) === lastSaved.json) {
        lastSaved = null;
        return;
      }
      form.load(rules);
      saveError = null;
    });
  });

  $effect(() => {
    dirty = form.isDirty;
  });

  // A disabled <fieldset> around the form (older embedding pages) also means read-only.
  let rootEl = $state<HTMLDivElement>();
  let fieldsetDisabled = $state(false);
  $effect(() => {
    const fieldset = rootEl?.parentElement?.closest('fieldset');
    if (!fieldset) return;
    const update = () => (fieldsetDisabled = fieldset.matches(':disabled'));
    update();
    const observer = new MutationObserver(update);
    observer.observe(fieldset, { attributes: true, attributeFilter: ['disabled'] });
    return () => observer.disconnect();
  });
  // Redacted credentials arrive blank; saving would overwrite the real ones.
  const redacted = $derived(hasRedactedSecrets(secretFlags));
  const isReadonly = $derived(readonly || fieldsetDisabled || redacted);
  $effect.pre(() => {
    form.secrets = secretFlags ?? null;
  });

  const sections = $derived(policySections({ app: Boolean(appId) }));

  let countries = $state<{ code: string; name: string }[]>([]);
  let countriesError = $state<string | null>(null);
  let countriesLoading = $state(false);
  async function loadCountries() {
    countriesLoading = true;
    const res = await getCountryCodes();
    countriesLoading = false;
    if (res.data) {
      countriesError = null;
      countries = res.data.list ?? [];
      form.countryCodes = new Set((res.data.codes ?? []).map((code) => code.toUpperCase()));
    } else {
      // Without the list, country pickers are empty and codes are not checked.
      countriesError = `Could not load the country list${res.error?.error ? `: ${res.error.error}` : ''}. Country codes are not checked until it loads.`;
    }
  }
  onMount(() => void loadCountries());

  const summaryIssues = $derived(form.submitted ? form.issues : []);

  async function save() {
    if (isReadonly || saving) return;
    form.submitted = true;
    saveError = null;
    if (form.issues.length > 0) {
      reviewOpen = false;
      await tick();
      summary?.focus();
      return;
    }
    const rules = form.toRules();
    // Baseline after success: the draft as saved, not edits typed while saving.
    const savedDraft = form.snapshot();
    lastSaved = { json: JSON.stringify(rules) };
    saving = true;
    let result: SaveResult;
    try {
      result = await onSave({ rules_json: rules });
    } catch {
      saving = false;
      lastSaved = null;
      saveError = policySaveError(null);
      return;
    }
    saving = false;
    if (result && result.error) {
      lastSaved = null;
      saveError = policySaveError(result.error, result.code, result.status);
      return;
    }
    form.markSaved(rules, savedDraft);
    reviewOpen = false;
    toast.success('Policy saved. Agents apply it on their next configuration update.');
    // The page echoes the saved rules before onSave resolves; later new rules always reload.
    await tick();
    lastSaved = null;
  }

  async function reload() {
    if (!onReload || reloading) return;
    lastSaved = null;
    reloading = true;
    try {
      await onReload();
      saveError = null;
    } finally {
      reloading = false;
    }
  }

  function discard() {
    form.discard();
    saveError = null;
    discardOpen = false;
    toast.info('Unsaved policy changes discarded.');
  }

  async function showSection(section: SectionId) {
    reviewOpen = false;
    await tick();
    const el = document.getElementById(sectionDomId(section));
    el?.scrollIntoView({ block: 'start' });
    document.getElementById(`${sectionDomId(section)}-title`)?.focus({ preventScroll: true });
  }

  async function jumpTo(issue: PolicyIssue) {
    form.revealIssue(issue);
    await tick();
    await tick();
    const target = document.getElementById(issue.id) ?? document.getElementById(`${sectionDomId(issue.section)}-title`);
    if (!target) return;
    target.scrollIntoView({ block: 'center' });
    target.focus({ preventScroll: true });
    target.classList.add('wp-focus-flash');
    setTimeout(() => target.classList.remove('wp-focus-flash'), 1300);
  }
</script>

{#snippet saveNotice()}
  {#if saveError?.code === 'CONFIG_CONFLICT'}
    <Alert tone="warning" role="alert" compact title="Someone else saved this policy after you opened it.">
      Your changes were not saved. {onReload ? 'Reloading the latest policy discards your unsaved edits; use Review changes to note them first.' : 'Reload the page to get the latest policy.'}
      {#snippet actions()}
        {#if onReload}<Button variant="secondary" size="sm" loading={reloading} onclick={() => void reload()}>Reload latest policy</Button>{/if}
      {/snippet}
    </Alert>
  {:else if saveError}
    <Alert tone="error" compact title={saveError.title} message={saveError.message} ondismiss={() => (saveError = null)} />
  {/if}
{/snippet}

<div class="wp-form" bind:this={rootEl}>
  <header class="wp-form-head">
    {#if heading}
      <div class="wp-form-titles">
        <h2>{title}</h2>
        <p>How requests are inspected and answered. Saving stores the desired policy; agents pick it up on their next configuration update, so check the agent acknowledgement to confirm it is applied.</p>
      </div>
    {/if}
    {#if redacted}
      <p class="wp-form-meta">Credentials (webhook URL, challenge secret, AES keys) are hidden at your access level.</p>
    {/if}
    {#if source || generation !== null}
      <p class="wp-form-meta">
        {#if source}Source: <code>{source}</code>{/if}
        {#if source && generation !== null}{' · '}{/if}
        {#if generation !== null}Generation <code>{generation}</code>{/if}
      </p>
    {/if}
  </header>

  <div class="wp-layout">
    <PolicyIndex {form} {sections} />

    <div class="wp-main">
      <ErrorSummary bind:this={summary} issues={summaryIssues} onjump={jumpTo} />

      <ProtectionSection {form} readonly={isReadonly} {enforcementMode} {onEnforcementChange} {enforcementBusy} />
      <InlineError message={countriesError} onretry={() => void loadCountries()} retrying={countriesLoading} />
      <AccessSection {form} readonly={isReadonly} {countries} />
      <RateLimitSection {form} readonly={isReadonly} />
      <BotSection {form} readonly={isReadonly} />
      <IpReputationSection {form} readonly={isReadonly} />
      <ChallengeSection {form} readonly={isReadonly} />
      <ContentScanSection {form} readonly={isReadonly} />
      <SsrfSection {form} readonly={isReadonly} />
      {#if appId}<WebSocketSection {form} readonly={isReadonly} />{/if}
      <PathRulesSection {form} readonly={isReadonly} />
      {#if projectId && appId}<CustomRulesSummary {form} {projectId} {appId} />{/if}
      <ResponsesSection {form} readonly={isReadonly} />
      <IntegrationsSection {form} readonly={isReadonly} />

      <SaveBar {form} {saving} readonly={isReadonly} notice={saveError ? saveNotice : undefined} onreview={() => (reviewOpen = true)} ondiscard={() => (discardOpen = true)} onsave={() => void save()} />
    </div>
  </div>
</div>

<ReviewDrawer
  open={reviewOpen}
  {form}
  {saving}
  readonly={isReadonly}
  onclose={() => (reviewOpen = false)}
  onsave={() => void save()}
  ongoto={(section) => void showSection(section)}
/>

<ConfirmModal
  open={discardOpen}
  tone="warning"
  title="Discard unsaved changes?"
  message={`The policy returns to the last saved version; ${form.changeCount} unsaved ${form.changeCount === 1 ? 'change is' : 'changes are'} lost.`}
  confirmLabel="Discard changes"
  cancelLabel="Keep editing"
  onconfirm={discard}
  onclose={() => (discardOpen = false)}
/>

<ConfirmModal
  open={prompt !== null}
  tone="warning"
  title="Leave without saving?"
  message={prompt?.message ?? ''}
  confirmLabel="Leave and discard"
  cancelLabel="Stay on this page"
  onconfirm={() => answerPrompt(true)}
  onclose={() => answerPrompt(false)}
/>

<style>
  .wp-form { display: flex; flex-direction: column; gap: var(--sp-5); min-width: 0; }
  .wp-form-head { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: var(--sp-3); }
  .wp-form-titles { min-width: 0; flex: 1 1 28rem; }
  .wp-form-titles h2 { margin: 0; font-size: var(--fs-lg); font-weight: var(--fw-semibold); color: var(--text-primary); }
  .wp-form-titles p { margin: var(--sp-1) 0 0; max-width: 80ch; font-size: var(--fs-sm); line-height: 1.6; color: var(--text-secondary); }
  .wp-form-meta { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
  .wp-form-meta code { font-family: var(--font-mono); color: var(--text-secondary); }
  .wp-layout { display: grid; grid-template-columns: 13.5rem minmax(0, 1fr); gap: var(--sp-5); align-items: start; min-width: 0; }
  .wp-main { display: flex; flex-direction: column; gap: var(--sp-4); min-width: 0; }
  @media (max-width: 1100px) {
    .wp-layout { grid-template-columns: minmax(0, 1fr); }
  }
</style>
