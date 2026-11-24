<!--
  DetectionRuleEditor: create or edit a detection (ingest) rule in a drawer.
  Opened from Policies → Detection, from a Triage group ("Suppress…") or an
  Explore event, optionally with a prefilled draft. Unsaved edits are
  guarded (Escape, ×, backdrop, navigation). Built-in rules are not edited
  here.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { createDetectionRule, updateDetectionRule, type DetectionRule } from '#lib/api.js';
  import { createDirtyTracker } from '#lib/dirty.svelte.js';
  import { toast } from '#lib/stores/toast.js';
  import Alert from '#lib/components/ui/Alert.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Drawer from '#lib/components/ui/Drawer.svelte';
  import Select from '#lib/components/ui/Select.svelte';
  import Switch from '#lib/components/ui/Switch.svelte';
  import {
    DETECTION_ACTIONS,
    DETECTION_FIELDS,
    SEVERITY_LEVELS,
    compatibleOp,
    draftFromRule,
    draftToBody,
    emptyRuleDraft,
    opsForField,
    type DetectionRuleDraft,
  } from './detection';

  let {
    open = false,
    projectId,
    hostId,
    hostLabel = '',
    rule = null,
    prefill = null,
    canConfigure = false,
    onclose,
    onsaved,
  }: {
    open?: boolean;
    projectId: string;
    /** Host the rule belongs to (detection rules are per host). */
    hostId: string;
    hostLabel?: string;
    /** Rule being edited; null creates a rule. */
    rule?: DetectionRule | null;
    /** Draft to start from (e.g. an exception prefilled from incidents). */
    prefill?: { draft: DetectionRuleDraft; warning?: string; context?: string } | null;
    canConfigure?: boolean;
    onclose: () => void;
    onsaved: (rule: DetectionRule) => void;
  } = $props();

  let draft = $state<DetectionRuleDraft>(emptyRuleDraft());
  let saving = $state(false);
  let formError = $state<string | null>(null);
  let conditionErrors = $state<Record<number, string>>({});
  let serverError = $state<string | null>(null);

  const dirty = createDirtyTracker(() => draft);
  dirty.guardNavigation();

  let wasOpen = false;
  $effect(() => {
    const isOpen = open;
    untrack(() => {
      if (isOpen && !wasOpen) {
        draft = rule ? draftFromRule(rule) : prefill ? structuredClone($state.snapshot(prefill.draft)) : emptyRuleDraft();
        formError = null;
        serverError = null;
        conditionErrors = {};
        dirty.reset();
      }
      wasOpen = isOpen;
    });
  });

  const isEdit = $derived(Boolean(rule));
  const showSeverity = $derived(draft.action === 'escalate' || draft.action === 'downgrade');
  const actionHelp = $derived(DETECTION_ACTIONS.find((a) => a.value === draft.action)?.help ?? '');

  function close() {
    dirty.reset();
    onclose();
  }

  function addCondition() {
    draft.conditions = [...draft.conditions, { field: 'comm', op: 'eq', value: '' }];
  }

  function removeCondition(index: number) {
    draft.conditions = draft.conditions.filter((_, i) => i !== index);
    conditionErrors = {};
  }

  /** Escalate and downgrade need a target severity: start from a sensible one. */
  function changeAction(action: DetectionRuleDraft['action']) {
    draft.action = action;
    if (action === 'escalate' && draft.severity_override === null) draft.severity_override = 3;
    if (action === 'downgrade' && draft.severity_override === null) draft.severity_override = 1;
    if (action !== 'escalate' && action !== 'downgrade') draft.severity_override = null;
  }

  function changeField(index: number, field: string) {
    const condition = draft.conditions[index];
    condition.field = field;
    condition.op = compatibleOp(field, condition.op);
  }

  async function save() {
    if (!canConfigure || saving) return;
    serverError = null;
    const result = draftToBody(draft);
    formError = result.error ?? null;
    conditionErrors = result.conditionErrors;
    if (!result.body) return;
    saving = true;
    const res = rule ? await updateDetectionRule(projectId, hostId, rule.id, result.body) : await createDetectionRule(projectId, hostId, result.body);
    saving = false;
    if (res.error || !res.data) {
      serverError = res.error?.error ?? 'The rule could not be saved.';
      return;
    }
    toast.success(rule ? `Detection rule "${result.body.name}" updated` : `Detection rule "${result.body.name}" created`, 'Detection rule saved');
    dirty.reset();
    onsaved(res.data);
  }

  const uid = $props.id();

  function describedBy(index: number, field: string) {
    return [field === 'args' && `${uid}-cond-${index}-hint`, conditionErrors[index] && `${uid}-cond-${index}`].filter(Boolean).join(' ') || undefined;
  }
</script>

<Drawer
  {open}
  title={isEdit ? (canConfigure ? 'Edit detection rule' : 'Detection rule') : 'New detection rule'}
  size="lg"
  dirty={dirty.isDirty}
  ondiscard={() => dirty.reset()}
  onclose={close}
>
  <form
    class="form"
    id="{uid}-form"
    onsubmit={(e) => {
      e.preventDefault();
      void save();
    }}
  >
    <p class="context">
      Evaluated when events arrive from {hostLabel || 'this host'}, in priority order; all conditions must match.
      {#if prefill?.context}{prefill.context}{/if}
    </p>
    {#if prefill?.warning}<Alert tone="warning" message={prefill.warning} />{/if}
    {#if !canConfigure}<Alert tone="info" message="Read-only access: your role can view this rule but not save it." />{/if}

    <fieldset class="bare" disabled={!canConfigure || saving}>
    <legend class="sr-only">Rule definition</legend>
    <label class="field">
      <span class="label">Name <span class="req" aria-hidden="true">*</span></span>
      <input class="input" required aria-required="true" bind:value={draft.name} aria-invalid={formError === 'Enter a rule name.' || undefined} />
    </label>
    <label class="field">
      <span class="label">Description</span>
      <input class="input" bind:value={draft.description} />
    </label>

    <div class="row">
      <div class="field">
        <label class="label" for="{uid}-action">Action</label>
        <Select id="{uid}-action" aria-describedby="{uid}-action-hint" options={DETECTION_ACTIONS} value={draft.action} onchange={(action) => changeAction(action)} />
        <span class="hint" id="{uid}-action-hint">{actionHelp}</span>
      </div>
      {#if showSeverity}
        <div class="field">
          <label class="label" for="{uid}-severity">New severity <span class="req" aria-hidden="true">*</span></label>
          <Select
            id="{uid}-severity"
            aria-required="true"
            aria-describedby="{uid}-severity-hint"
            placeholder="Choose a severity"
            options={SEVERITY_LEVELS}
            value={draft.severity_override ?? -1}
            onchange={(level) => (draft.severity_override = level)}
          />
          <span class="hint" id="{uid}-severity-hint">Matching events are stored with this severity.</span>
        </div>
      {/if}
      <label class="field narrow">
        <span class="label">Priority</span>
        <input class="input" type="number" min="1" max="999" step="1" bind:value={draft.priority} />
        <span class="hint">Lower runs first (1–999).</span>
      </label>
    </div>

    <fieldset class="conditions">
      <legend class="label">Conditions <span class="hint">(all must match)</span></legend>
      {#each draft.conditions as condition, index (index)}
        <div class="condition" class:invalid={conditionErrors[index]}>
          <div class="field">
            <label class="sr-only" for="{uid}-cond-{index}-field">Field of condition {index + 1}</label>
            <Select id="{uid}-cond-{index}-field" options={DETECTION_FIELDS} value={condition.field} onchange={(field) => changeField(index, field)} />
          </div>
          <div class="field">
            <label class="sr-only" for="{uid}-cond-{index}-op">Operator of condition {index + 1}</label>
            <Select id="{uid}-cond-{index}-op" options={opsForField(condition.field)} bind:value={condition.op} />
          </div>
          <label class="field grow">
            <span class="sr-only">Value of condition {index + 1}</span>
            <input
              class="input"
              bind:value={condition.value}
              aria-invalid={conditionErrors[index] ? 'true' : undefined}
              aria-describedby={describedBy(index, condition.field)}
              placeholder={condition.op === 'in' || condition.op === 'not_in' ? 'a, b, c' : ''}
            />
          </label>
          <Button variant="ghost" size="sm" disabled={draft.conditions.length <= 1} aria-label={`Remove condition ${index + 1}`} onclick={() => removeCondition(index)}>Remove</Button>
          {#if condition.field === 'args'}<p class="hint" id="{uid}-cond-{index}-hint">The new path of a renamed file. Only rename events carry it.</p>{/if}
          {#if conditionErrors[index]}<p class="error" id="{uid}-cond-{index}">{conditionErrors[index]}</p>{/if}
        </div>
      {/each}
      <div><Button variant="secondary" size="sm" onclick={addCondition}>Add condition</Button></div>
    </fieldset>

    <label class="field">
      <span class="label">Tags</span>
      <input class="input" bind:value={draft.tags} />
      <span class="hint">Comma-separated. A Tag rule adds these to matching events.</span>
    </label>

    <Switch bind:checked={draft.enabled} label="Enabled" hint="It applies to the next events that arrive." />
    </fieldset>

    {#if formError}<p class="error" role="alert">{formError}</p>{/if}
    {#if serverError}<Alert tone="error" message={serverError} />{/if}
  </form>

  {#snippet footer()}
    <Button variant="ghost" onclick={close}>{canConfigure ? 'Cancel' : 'Close'}</Button>
    <Button variant="primary" type="submit" form="{uid}-form" loading={saving} disabled={!canConfigure || saving} title={canConfigure ? undefined : 'Requires the member or owner role'}>
      {isEdit ? 'Save changes' : 'Create rule'}
    </Button>
  {/snippet}
</Drawer>

<style>
  .form { display: grid; gap: var(--sp-4); min-width: 0; }
  .bare { display: grid; gap: var(--sp-4); min-width: 0; margin: 0; padding: 0; border: 0; }
  .context { margin: 0; font-size: var(--fs-sm); color: var(--text-secondary); }
  .row { display: flex; flex-wrap: wrap; gap: var(--sp-3); }
  .row .field { flex: 1 1 12rem; }
  .row .narrow { flex: 0 1 8rem; }
  .field { display: grid; gap: var(--sp-1); min-width: 0; }
  .label { font-size: var(--fs-sm); font-weight: var(--fw-medium); color: var(--text-secondary); }
  .req { color: var(--danger); }
  .hint { font-size: var(--fs-xs); color: var(--text-muted); font-weight: 400; }
  .input { width: 100%; padding: var(--sp-2); border: 1px solid var(--border-strong); border-radius: var(--radius); background: var(--surface-input); color: var(--text-primary); font-size: var(--fs-sm); }
  .input[aria-invalid='true'] { border-color: var(--danger); }
  .conditions { display: grid; gap: var(--sp-2); margin: 0; padding: var(--sp-3); border: 1px solid var(--border); border-radius: var(--radius-lg); }
  .condition { display: grid; grid-template-columns: minmax(9rem, 1fr) minmax(8rem, 0.8fr) minmax(8rem, 1.2fr) auto; gap: var(--sp-2); align-items: center; }
  .condition .error, .condition .hint { grid-column: 1 / -1; }
  .condition .hint { margin: 0; }
  .error { margin: 0; font-size: var(--fs-xs); color: var(--danger); }
  @media (max-width: 640px) {
    .condition { grid-template-columns: minmax(0, 1fr); }
  }
</style>
