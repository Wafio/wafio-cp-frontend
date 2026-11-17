<!--
  CustomRuleModal: the custom rule editor (Match & act, Engine tuning,
  Script) on the native Modal: focus stays inside, Escape and the backdrop go
  through the dirty guard ("Discard unsaved changes?"), and a browser
  navigation while it holds changes asks first.

  `mode` decides the wording and the starting values:
    create: empty rule;
    edit  , `editingRule` as saved ("Save changes");
    clone , a copy of `editingRule` named "<name> (copy)", disabled until
             the operator turns it on ("Create copy").
  Without `mode` it is "edit" when `editingRule` is set, else "create".

  Saving a rule that will run and newly weakens protection (an Allow or Log
  rule, a Block/Challenge rule that matches every request, a script that can
  return ALLOW, tuning that turns inspection off or applies everywhere) asks
  first, with the tier from rule-risk.ts. A copy starts disabled, so
  cloning itself never asks. `scriptRules` false (the agent cannot run script
  rules) shows a warning on the Script tab.

  `onSave(body)` persists the rule. Returning false keeps the dialog open;
  throwing shows the message here.
-->
<script lang="ts" module>
  export type CustomRuleModalMode = 'create' | 'edit' | 'clone';
</script>

<script lang="ts">
  import { untrack } from 'svelte';
  import Icon from 'svelte-awesome/components/Icon.svelte';
  import plus from 'svelte-awesome/icons/plus';
  import {
    validateCustomGUIRule,
    validateTuningRule,
    type CreateCustomRuleBody,
    type CustomRule,
    type CustomRuleDryRunResult,
    type CustomRuleDryRunSample,
    type CustomRuleMode,
  } from '#lib/api.js';
  import Modal from '#lib/components/ui/Modal.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Badge from '#lib/components/ui/Badge.svelte';
  import InlineError from '#lib/components/ui/InlineError.svelte';
  import Alert from '#lib/components/ui/Alert.svelte';
  import Select from '#lib/components/ui/Select.svelte';
  import { ruleRegexError } from './rules/regex-error';
  import ConfirmModal from '#lib/components/ui/ConfirmModal.svelte';
  import { actionTone } from '#lib/tone.js';
  import { createDirtyTracker } from '#lib/dirty.svelte.js';
  import ConditionRow from './rules/ConditionRow.svelte';
  import TuningTab from './rules/TuningTab.svelte';
  import SegmentedRadio from './rules/SegmentedRadio.svelte';
  import DryRunPanel from './rules/DryRunPanel.svelte';
  import ScriptTab from './rules/ScriptTab.svelte';
  import { RuleSaveError, SCRIPT_OWNER_MESSAGE, scriptSizeError, touchesScriptRule } from './rules/script-access';
  import { RULE_STAGES } from './rules/rule-stages';
  import { saveRisk, type RuleRisk } from './rules/rule-risk';
  import { scriptRulesWarning } from '#lib/inspection.js';
  import {
    buildTuningPayload,
    buildTuningRuleBody,
    conditionFieldError,
    conditionToRow,
    emptyConditionRow,
    emptyTuningState,
    rowToCondition,
    rowsToConditions,
    tuningFromRule,
    tuningStateError,
    type ConditionRowModel,
    type TuningFormState,
  } from './rules/registry';

  type Action = 'block' | 'allow' | 'challenge' | 'log';

  interface Props {
    open?: boolean;
    projectId?: string;
    appId?: string;
    /** The rule to edit, or the source of a copy. */
    editingRule?: CustomRule | null;
    mode?: CustomRuleModalMode;
    /** Project owner: may create or change script rules. */
    canEditScripts?: boolean;
    /** The application's WAF agent can run script rules: false = it cannot, null or absent = unknown. */
    scriptRules?: boolean | null;
    onSave?: (rule: CreateCustomRuleBody) => Promise<boolean | void>;
    onClose?: () => void;
  }

  let {
    open = false,
    projectId = '',
    appId = '',
    editingRule = null,
    mode = undefined,
    canEditScripts = true,
    scriptRules = null,
    onSave = async () => {},
    onClose = () => {},
  }: Props = $props();

  const uid = $props.id();
  const effectiveMode = $derived<CustomRuleModalMode>(mode ?? (editingRule ? 'edit' : 'create'));

  const DEFAULT_SCRIPT = `// Custom rule script (uddin-lang)
//
// Runs after the decision engine. The first script that returns a decision
// (waf_block / waf_allow / waf_log) replaces the engine verdict; a script that
// returns nothing leaves it unchanged. The Guide tab explains when scripts run.
//
// Variables: path, method, query, ip, country, ua, body, score, action
// ("allow" | "log" | "block"). Accessors: waf_header("name"), waf_query("name").
//
// Example: block scanner user agents and high-score requests.
ua_val = waf_header("user-agent")
if (ua_val != null and contains(lower(ua_val), "sqlmap")) then:
    waf_block()
end
if (score > 120.0) then:
    waf_block()
end
`;

  const MODES: { value: CustomRuleMode; label: string; disabled?: boolean; title?: string }[] = $derived([
    { value: 'gui', label: RULE_STAGES.gui.label },
    { value: 'tuning', label: RULE_STAGES.tuning.label },
    { value: 'script', label: RULE_STAGES.script.label, disabled: !canEditScripts, title: canEditScripts ? undefined : SCRIPT_OWNER_MESSAGE },
  ]);

  const LOGIC: { value: 'and' | 'or'; label: string }[] = [
    { value: 'and', label: 'All match (AND)' },
    { value: 'or', label: 'Any matches (OR)' },
  ];

  const ACTIONS: { value: Action; label: string }[] = [
    { value: 'block', label: 'Block' },
    { value: 'allow', label: 'Allow (skip detection)' },
    { value: 'challenge', label: 'Challenge (browser check)' },
    { value: 'log', label: 'Log (pass and record)' },
  ];

  // ── Form state ──
  let formName = $state('');
  let formDescription = $state('');
  let formEnabled = $state(true);
  let formPriority = $state(0);
  let formMode = $state<CustomRuleMode>('gui');
  let formAction = $state<Action>('block');
  let formConditionLogic = $state<'and' | 'or'>('and');
  let formConditions = $state<ConditionRowModel[]>([]);
  let formScript = $state('');
  let tuningState = $state<TuningFormState>(emptyTuningState());

  let saving = $state(false);
  let modalError = $state('');
  /** Names from a 400 SCRIPT_BUILTIN_FORBIDDEN on save, shown next to the editor. */
  let forbiddenBuiltins = $state<string[]>([]);
  /** Server message of a 400 SCRIPT_INVALID on save, shown next to the editor. */
  let scriptInvalid = $state('');
  let scriptInvalidFor = $state('');
  /** A non-owner may open a script rule but not save it (the server answers 403). */
  const scriptLocked = $derived(!canEditScripts && touchesScriptRule(effectiveMode === 'edit' ? editingRule?.mode : null, formMode));
  // A save that needs a confirmation first (saveRisk), with the body to save.
  let pendingRisk = $state<{ risk: RuleRisk; body: CreateCustomRuleBody } | null>(null);
  let modal = $state<ReturnType<typeof Modal>>();

  function snapshot() {
    return {
      formName,
      formDescription,
      formEnabled,
      formPriority,
      formMode,
      formAction,
      formConditionLogic,
      formConditions,
      formScript,
      tuningState,
    };
  }

  // Dirty only while open; the baseline is taken right after the form is filled.
  const tracker = createDirtyTracker(() => (open ? snapshot() : null));
  tracker.guardNavigation({ message: 'The custom rule has unsaved changes. Leave without saving?' });
  const isDirty = $derived(open && tracker.isDirty);

  const title = $derived(
    effectiveMode === 'edit' ? 'Edit custom rule' : effectiveMode === 'clone' ? 'Copy custom rule' : 'New custom rule'
  );
  const saveLabel = $derived(effectiveMode === 'edit' ? 'Save changes' : effectiveMode === 'clone' ? 'Create copy' : 'Create rule');

  // Dry-run keys: a stale test result is cleared when the rule changes.
  const guiResetKey = $derived(`${formConditionLogic}|${formAction}|${JSON.stringify(formConditions)}`);
  const tuningResetKey = $derived(JSON.stringify(tuningState));

  function fillForm(rule: CustomRule | null, as: CustomRuleModalMode) {
    if (rule) {
      formName = as === 'clone' ? `${rule.name ?? ''} (copy)` : (rule.name ?? '');
      formDescription = rule.description ?? '';
      formEnabled = as === 'clone' ? false : (rule.enabled ?? true);
      formPriority = rule.priority ?? 0;
      formMode = rule.mode === 'script' ? 'script' : rule.mode === 'tuning' ? 'tuning' : 'gui';
      formAction = (['block', 'allow', 'challenge', 'log'] as const).includes(rule.action) ? rule.action : 'block';
      formConditionLogic = rule.condition_logic === 'or' ? 'or' : 'and';
      formScript = rule.script ?? '';
      tuningState = tuningFromRule(rule);
      // Legacy not_* operators become the positive operator + NOT.
      formConditions = Array.isArray(rule.conditions) && rule.mode !== 'tuning' ? rule.conditions.map(conditionToRow) : [];
    } else {
      formName = '';
      formDescription = '';
      formEnabled = true;
      formPriority = 0;
      formMode = 'gui';
      formAction = 'block';
      formConditionLogic = 'and';
      formConditions = [];
      tuningState = emptyTuningState();
      formScript = DEFAULT_SCRIPT;
    }
    modalError = '';
    forbiddenBuiltins = [];
    scriptInvalid = '';
    saving = false;
    pendingRisk = null;
  }

  $effect(() => {
    const isOpen = open;
    const rule = editingRule;
    const as = effectiveMode;
    if (!isOpen) {
      // Closed (saved, cancelled or discarded): the tracked value is null
      // again, so take it as the baseline. Without this the last open form
      // stayed the baseline and every later navigation, a filter tab click
      // updates the URL, asked to leave "unsaved changes".
      untrack(() => tracker.reset());
      return;
    }
    untrack(() => {
      fillForm(rule, as);
      tracker.reset();
    });
  });

  async function runDryRun(sample: CustomRuleDryRunSample): Promise<CustomRuleDryRunResult | { error: string }> {
    const sampleRequest: Record<string, unknown> = {
      method: sample.method,
      path: sample.path,
      query: sample.query,
      ip: sample.ip,
      country: sample.country,
      user_agent: sample.user_agent,
      body: sample.body,
      headers: sample.headers,
      cookies: sample.cookies,
    };
    if (sample.content_type) sampleRequest.content_type = sample.content_type;
    if (formMode === 'tuning') {
      const res = await validateTuningRule(projectId, appId, buildTuningPayload(tuningState), sampleRequest);
      if (res.error || !res.data) return { error: res.error?.error || 'Test request failed.' };
      return res.data;
    }
    const res = await validateCustomGUIRule(projectId, appId, rowsToConditions(formConditions), formConditionLogic, formAction, sampleRequest);
    if (res.error || !res.data) return { error: res.error?.error || 'Test request failed.' };
    return res.data;
  }

  function addCondition() {
    formConditions = [...formConditions, emptyConditionRow()];
  }

  function removeCondition(id: string) {
    formConditions = formConditions.filter((c) => c.id !== id);
  }

  function conditionRowsError(rows: ConditionRowModel[], label: string): string | null {
    if (rows.length > 64) return `${label}: at most 64 conditions per rule.`;
    for (let i = 0; i < rows.length; i++) {
      const err = conditionFieldError(rowToCondition(rows[i]).field);
      if (err) return `${label}, condition ${i + 1}: ${err}.`;
    }
    return null;
  }

  function validate(): string | null {
    if (!formName.trim()) return 'Enter a rule name.';
    if (!Number.isInteger(Number(formPriority))) return 'Priority must be a whole number.';
    if (formMode === 'gui') {
      if (formConditions.length === 0) return 'Add at least one condition. A Match & act rule without conditions never matches.';
      return conditionRowsError(formConditions, 'Match');
    }
    if (formMode === 'script') return formScript.trim() ? scriptSizeError(formScript) : 'Write a script, or pick a template.';
    return tuningStateError(tuningState) ?? conditionRowsError(tuningState.scopeConditions, 'Apply when');
  }

  function buildBody(): CreateCustomRuleBody {
    const meta = {
      name: formName.trim(),
      description: formDescription.trim(),
      enabled: formEnabled,
      priority: Number(formPriority) || 0,
    };
    if (formMode === 'tuning') return buildTuningRuleBody(tuningState, meta);
    return {
      ...meta,
      mode: formMode,
      // Scripts decide for themselves; the stored action is not evaluated.
      action: formAction,
      condition_logic: formConditionLogic,
      conditions: formMode === 'gui' ? rowsToConditions(formConditions) : [],
      script: formMode === 'script' ? formScript : '',
    };
  }

  async function handleSave() {
    const problem = validate();
    if (problem) {
      modalError = problem;
      return;
    }
    modalError = '';
    const body = buildBody();
    const risk = saveRisk(effectiveMode === 'edit' ? editingRule : null, body);
    if (risk) {
      pendingRisk = { risk, body };
      return;
    }
    await persist(body);
  }

  async function confirmRisk() {
    const pending = pendingRisk;
    pendingRisk = null;
    if (pending) await persist(pending.body);
  }

  async function persist(body: CreateCustomRuleBody) {
    saving = true;
    modalError = '';
    forbiddenBuiltins = [];
    scriptInvalid = '';
    try {
      const ok = await onSave(body);
      if (ok !== false) {
        tracker.reset();
        onClose();
      }
    } catch (err) {
      modalError = err instanceof Error && err.message ? err.message : 'The rule could not be saved.';
      if (err instanceof RuleSaveError) {
        if (err.title) modalError = `${err.title} ${err.message}`;
        forbiddenBuiltins = err.forbidden;
        if (err.code === 'SCRIPT_INVALID') {
          scriptInvalid = err.message;
          scriptInvalidFor = body.script ?? '';
        }
      }
    } finally {
      saving = false;
    }
  }
</script>

<Modal
  bind:this={modal}
  {open}
  {title}
  size="2xl"
  class="cr-modal"
  dirty={isDirty}
  dismissible={!saving}
  discardMessage="The changes to this custom rule have not been saved and will be lost."
  onclose={onClose}
>
  <div class="cr-body">
    {#if effectiveMode === 'clone'}
      <p class="cr-note" role="note">The copy starts disabled so it cannot change traffic until you turn it on.</p>
    {/if}
    {#if effectiveMode === 'edit' && ruleRegexError(editingRule)}
      <Alert tone="warning" compact title="Not applied by agents: fix the regex and save" message={ruleRegexError(editingRule)} />
    {/if}

    <div class="cr-meta">
      <div class="cr-field cr-span-6">
        <label for="{uid}-name">Rule name <span class="cr-req" aria-hidden="true">*</span></label>
        <input id="{uid}-name" type="text" class="cr-input" placeholder="e.g. Block admin scanners" required aria-required="true" bind:value={formName} data-autofocus />
      </div>
      <div class="cr-field cr-span-6">
        <label for="{uid}-desc">Description</label>
        <input id="{uid}-desc" type="text" class="cr-input" placeholder="Optional note for your team" bind:value={formDescription} />
      </div>

      <div class="cr-field cr-span-6">
        <span class="cr-label" id="{uid}-mode-label">Rule type</span>
        <SegmentedRadio options={MODES} bind:value={formMode} labelledby="{uid}-mode-label" describedby="{uid}-mode-hint" fill />
      </div>

      <div class="cr-field cr-span-3">
        {#if formMode === 'gui'}
          <label for="{uid}-action">Action on match</label>
          <Select id="{uid}-action" options={ACTIONS} bind:value={formAction} />
        {:else}
          <span class="cr-label">Action on match</span>
          <p class="cr-static">{formMode === 'tuning' ? 'None: adjusts the engines' : 'Decided by the script'}</p>
        {/if}
      </div>

      <div class="cr-field cr-span-1">
        <label for="{uid}-priority">Priority</label>
        <input id="{uid}-priority" type="number" step="1" class="cr-input" bind:value={formPriority} aria-describedby="{uid}-priority-hint" />
      </div>

      <div class="cr-field cr-span-2">
        <span class="cr-label" id="{uid}-status-label">Status</span>
        <label class="cr-switch">
          <input type="checkbox" role="switch" bind:checked={formEnabled} aria-labelledby="{uid}-status-label" aria-describedby="{uid}-status-text" />
          <span class="cr-switch-track" aria-hidden="true"></span>
          <span id="{uid}-status-text">{formEnabled ? 'Enabled' : 'Disabled'}</span>
        </label>
      </div>

      <p class="cr-hint cr-span-12" id="{uid}-mode-hint">
        <strong>{RULE_STAGES[formMode].when}.</strong>
        {RULE_STAGES[formMode].effect}
        <span id="{uid}-priority-hint">Lower priority numbers run first.</span>
      </p>
    </div>

    {#if formMode === 'gui'}
      <section class="cr-work" aria-labelledby="{uid}-match">
        <header class="cr-work-head">
          <h3 id="{uid}-match">Match</h3>
          <SegmentedRadio options={LOGIC} bind:value={formConditionLogic} label="Condition logic" size="sm" />
          <Button variant="secondary" size="sm" class="cr-add" onclick={addCondition}>
            <Icon data={plus} scale={0.75} aria-hidden="true" /> Add condition
          </Button>
        </header>

        {#if formConditions.length === 0}
          <p class="cr-empty">No conditions yet. Match on URLs, methods, headers, cookies, JSON or form fields, or client IPs.</p>
        {:else}
          <div class="cr-cond-head" aria-hidden="true">
            <span>Field</span>
            <span>Operator</span>
            <span>Value</span>
            <span></span>
          </div>
          <div class="cr-conditions">
            {#each formConditions as cond, i (cond.id)}
              <ConditionRow bind:cond={formConditions[i]} rowId={`${i + 1}`} onremove={() => removeCondition(cond.id)} />
            {/each}
          </div>
        {/if}

        <DryRunPanel canRun={formConditions.length > 0} cannotRunHint="Add at least one condition first" runTest={runDryRun} resetKey={guiResetKey} />
      </section>
    {:else if formMode === 'tuning'}
      <section class="cr-work-plain">
        <TuningTab bind:tuning={tuningState} />
        <DryRunPanel canRun={tuningState.scopeConditions.length > 0} cannotRunHint="Add at least one condition first" runTest={runDryRun} resetKey={tuningResetKey} />
      </section>
    {:else}
      {#if scriptLocked}
        <p class="cr-note" role="note">{SCRIPT_OWNER_MESSAGE} You can read this script; ask an owner to change it.</p>
      {/if}
      {#if scriptRulesWarning(scriptRules, 'app')}
        <Alert tone="warning" compact message={scriptRulesWarning(scriptRules, 'app') ?? ''} />
      {/if}
      <ScriptTab {open} active={formMode === 'script'} {projectId} {appId} bind:script={formScript} forbidden={forbiddenBuiltins} invalid={formScript === scriptInvalidFor ? scriptInvalid : ''} />
    {/if}
  </div>

  <ConfirmModal
    open={pendingRisk !== null}
    tone="warning"
    title={pendingRisk?.risk.title ?? ''}
    message={pendingRisk?.risk.message ?? ''}
    confirmLabel={pendingRisk?.risk.confirmLabel ?? 'Save'}
    onconfirm={confirmRisk}
    onclose={() => (pendingRisk = null)}
  />

  {#snippet footer()}
    <div class="cr-footer">
      <InlineError message={modalError} class="cr-error" />
      <div class="cr-footer-row">
        <p class="cr-summary">
          {#if formMode === 'gui'}
            <Badge tone={actionTone(formAction)}>{ACTIONS.find((a) => a.value === formAction)?.label.split(' ')[0]}</Badge>
          {:else}
            <Badge tone="neutral">{RULE_STAGES[formMode].label}</Badge>
          {/if}
          <span>Priority {formPriority} · {RULE_STAGES[formMode].when} · {formEnabled ? 'Enabled' : 'Disabled'}</span>
        </p>
        <div class="cr-actions">
          <Button variant="secondary" disabled={saving} onclick={() => modal?.requestClose('close-button')}>Cancel</Button>
          <Button variant="primary" loading={saving} disabled={saving || !formName.trim() || scriptLocked} title={scriptLocked ? SCRIPT_OWNER_MESSAGE : undefined} onclick={handleSave}>
            {saving ? 'Saving…' : saveLabel}
          </Button>
        </div>
      </div>
    </div>
  {/snippet}
</Modal>

<style>
  :global(.ui-modal.cr-modal) { height: min(90dvh, 860px); }
  .cr-body { display: flex; flex-direction: column; gap: var(--sp-4); min-width: 0; }

  .cr-note {
    margin: 0;
    padding: var(--sp-2) var(--sp-3);
    background: var(--info-tint);
    border: 1px solid var(--info);
    border-radius: var(--radius);
    font-size: var(--fs-sm);
    color: var(--text-primary);
  }

  .cr-meta { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: var(--sp-3) var(--sp-4); align-items: start; }
  .cr-span-1 { grid-column: span 1; }
  .cr-span-2 { grid-column: span 2; }
  .cr-span-3 { grid-column: span 3; }
  .cr-span-6 { grid-column: span 6; }
  .cr-span-12 { grid-column: 1 / -1; }

  .cr-field { display: flex; flex-direction: column; gap: var(--sp-1); min-width: 0; }
  .cr-field label, .cr-label { font-size: var(--fs-xs); font-weight: var(--fw-semibold); color: var(--text-secondary); white-space: nowrap; }
  .cr-req { color: var(--danger); }
  .cr-input {
    width: 100%;
    box-sizing: border-box;
    height: 36px;
    padding: 0 var(--sp-3);
    background: var(--surface-input);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    color: var(--text-primary);
    font-size: var(--fs-base);
  }
  .cr-static { margin: 0; height: 36px; display: flex; align-items: center; font-size: var(--fs-sm); color: var(--text-muted); }
  .cr-hint { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.55; }
  .cr-hint strong { color: var(--text-secondary); }

  .cr-switch { display: inline-flex; align-items: center; gap: var(--sp-2); min-height: 44px; cursor: pointer; font-size: var(--fs-sm); color: var(--text-primary); }
  .cr-switch input { position: absolute; opacity: 0; width: 1px; height: 1px; }
  .cr-switch-track { position: relative; width: 34px; height: 20px; flex-shrink: 0; border-radius: var(--radius); background: var(--bg-tertiary); border: 1px solid var(--border-strong); transition: background 0.15s; }
  .cr-switch-track::after { content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: calc(var(--radius) - 2px); background: var(--text-secondary); transition: transform 0.15s; }
  .cr-switch input:checked + .cr-switch-track { background: var(--accent); border-color: var(--accent); }
  .cr-switch input:checked + .cr-switch-track::after { transform: translateX(14px); background: var(--text-on-accent); }
  .cr-switch input:focus-visible + .cr-switch-track { outline: var(--ring-width) solid var(--ring-color); outline-offset: 2px; }

  .cr-work {
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
    padding: var(--sp-3) var(--sp-4) var(--sp-4);
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
  }
  .cr-work-plain { display: flex; flex-direction: column; gap: var(--sp-3); }
  .cr-work-head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2) var(--sp-3); }
  .cr-work-head h3 { margin: 0; font-size: var(--fs-sm); font-weight: var(--fw-semibold); color: var(--text-primary); }
  .cr-work-head :global(.cr-add) { margin-left: auto; }
  .cr-empty { margin: 0; padding: var(--sp-4); text-align: center; font-size: var(--fs-sm); color: var(--text-muted); border: 1px dashed var(--border-strong); border-radius: var(--radius); }
  .cr-cond-head {
    display: grid;
    /* Keep in sync with .crow in rules/ConditionRow.svelte */
    grid-template-columns: minmax(0, 1.2fr) minmax(0, 1.5fr) minmax(0, 1.75fr) 34px;
    gap: var(--sp-2);
    padding: 0 var(--sp-3);
  }
  .cr-cond-head span { font-size: var(--fs-sm); font-weight: var(--fw-semibold); color: var(--text-muted); }
  .cr-conditions { display: flex; flex-direction: column; gap: var(--sp-2); }

  .cr-footer { display: flex; flex-direction: column; gap: var(--sp-2); width: 100%; }
  .cr-footer :global(.cr-error) { margin: 0; }
  .cr-footer-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--sp-2) var(--sp-4); }
  .cr-summary { margin: 0; display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm); color: var(--text-muted); }
  .cr-actions { display: flex; gap: var(--sp-2); margin-left: auto; }

  @media (max-width: 860px) {
    .cr-meta { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .cr-meta > [class*='cr-span'] { grid-column: auto; }
    .cr-meta > .cr-span-6, .cr-meta > .cr-span-12 { grid-column: 1 / -1; }
    .cr-cond-head { display: none; }
    .cr-actions { width: 100%; }
    .cr-actions :global(.btn) { flex: 1; }
  }
</style>
