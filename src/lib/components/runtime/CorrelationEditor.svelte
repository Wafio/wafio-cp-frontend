<!--
  CorrelationEditor: stage builder for a multi-stage correlation chain.
  Durations are entered in seconds or minutes and sent as the API expects
  (stage `within` in nanoseconds, `max_span_ms`); the draft is validated
  like the server's ValidateCorrelationRule before it is sent. The name of
  an existing chain cannot change (the server keeps it).
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { createCorrelationRule, updateCorrelationRule, type StoredCorrelationRule } from '#lib/api.js';
  import { createDirtyTracker } from '#lib/dirty.svelte.js';
  import { toast } from '#lib/stores/toast.js';
  import Alert from '#lib/components/ui/Alert.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Drawer from '#lib/components/ui/Drawer.svelte';
  import Select from '#lib/components/ui/Select.svelte';
  import { SEVERITY_LEVELS } from './detection';
  import {
    CORRELATION_ENTITIES,
    DEST_SCOPES,
    MAX_SPAN_MINUTES,
    MAX_STAGES,
    MIN_STAGES,
    chainDraftFromRule,
    chainDraftToBody,
    conditionDefaultsFor,
    conditionValueKind,
    correlationFieldsFor,
    correlationOpsFor,
    emptyChainDraft,
    emptyStage,
    exampleChainDraft,
    listValue,
    toggleListItem,
    type ChainDraft,
    type DurationUnit,
  } from './correlation';

  const DURATION_UNITS: { value: DurationUnit; label: string }[] = [
    { value: 's', label: 'seconds' },
    { value: 'min', label: 'minutes' },
  ];
  const SEVERITY_OPTIONS = SEVERITY_LEVELS.map((level) => ({ value: String(level.value), label: level.label }));
  const BOOLEAN_OPTIONS = [
    { value: 'true', label: 'true' },
    { value: 'false', label: 'false' },
  ];

  let {
    open = false,
    projectId,
    rule = null,
    canManage = false,
    onclose,
    onsaved,
  }: {
    open?: boolean;
    projectId: string;
    /** Custom chain being edited; null creates one. */
    rule?: StoredCorrelationRule | null;
    canManage?: boolean;
    onclose: () => void;
    onsaved: () => void;
  } = $props();

  let draft = $state<ChainDraft>(emptyChainDraft());
  let errors = $state<string[]>([]);
  let fieldErrors = $state<Record<string, string>>({});
  let serverError = $state<string | null>(null);
  let saving = $state(false);

  const dirty = createDirtyTracker(() => draft);
  dirty.guardNavigation();

  let wasOpen = false;
  $effect(() => {
    const isOpen = open;
    untrack(() => {
      if (isOpen && !wasOpen) {
        draft = rule ? chainDraftFromRule(rule) : emptyChainDraft();
        errors = [];
        fieldErrors = {};
        serverError = null;
        dirty.reset();
      }
      wasOpen = isOpen;
    });
  });

  const isEdit = $derived(Boolean(rule));
  /** Viewers and members read chains; built-in chains are never edited here (disable only). */
  const readOnly = $derived(!canManage || Boolean(rule?.built_in));

  function close() {
    dirty.reset();
    onclose();
  }

  function addStage() {
    if (draft.stages.length >= MAX_STAGES) return;
    draft.stages = [...draft.stages, emptyStage()];
  }

  function removeStage(index: number) {
    if (draft.stages.length <= MIN_STAGES) return;
    draft.stages = draft.stages.filter((_, i) => i !== index);
    if (draft.stages[0]) draft.stages[0].within = null;
    fieldErrors = {};
  }

  function addCondition(stageIndex: number) {
    draft.stages[stageIndex].conditions = [...draft.stages[stageIndex].conditions, { field: 'event_name', op: 'eq', value: '' }];
  }

  function removeCondition(stageIndex: number, conditionIndex: number) {
    draft.stages[stageIndex].conditions = draft.stages[stageIndex].conditions.filter((_, i) => i !== conditionIndex);
    fieldErrors = {};
  }

  function changeField(stageIndex: number, conditionIndex: number, field: string) {
    const condition = draft.stages[stageIndex].conditions[conditionIndex];
    const before = conditionValueKind(condition.field, 'eq');
    condition.field = field;
    // Severity, boolean and scope fields take their own operators and values.
    if (before !== conditionValueKind(field, 'eq') || !correlationOpsFor(field).some((op) => op.value === condition.op)) {
      const defaults = conditionDefaultsFor(field);
      condition.op = defaults.op;
      condition.value = defaults.value;
    }
  }

  async function save() {
    if (readOnly || saving) return;
    serverError = null;
    const result = chainDraftToBody(draft);
    errors = result.errors;
    fieldErrors = result.fieldErrors;
    if (!result.body) return;
    saving = true;
    const res = rule ? await updateCorrelationRule(projectId, rule.id, result.body) : await createCorrelationRule(projectId, result.body);
    saving = false;
    if (res.error || !res.data) {
      serverError = res.error?.error ?? 'The chain could not be saved.';
      return;
    }
    toast.success(rule ? `Chain "${rule.name}" updated` : `Chain "${result.body.name}" created`, 'Correlation chain saved');
    dirty.reset();
    onsaved();
  }

  const uid = $props.id();
</script>

<Drawer {open} title={readOnly && isEdit ? 'Correlation chain' : isEdit ? 'Edit correlation chain' : 'New correlation chain'} size="xl" dirty={!readOnly && dirty.isDirty} ondiscard={() => dirty.reset()} onclose={close}>
  <form
    class="form"
    id="{uid}-form"
    onsubmit={(e) => {
      e.preventDefault();
      void save();
    }}
  >
    <p class="context">
      A chain raises the event that completes it to critical when its stages happen in order, on the same process tree or container, within the maximum span.
      Applies to every host of the project.
    </p>
    {#if rule?.built_in}
      <Alert tone="info" message="Built-in chain: its stages are fixed. Owners can disable it from the list; tuning built-in detection is planned separately." />
    {:else if !canManage}
      <Alert tone="info" message="Read-only: project owners manage correlation chains." />
    {/if}
    <fieldset class="bare" disabled={readOnly || saving}>
    <legend class="sr-only">Chain definition</legend>
    {#if !isEdit}
      <div><Button variant="ghost" size="sm" onclick={() => (draft = exampleChainDraft())}>Start from the web-shell example</Button></div>
    {/if}

    <div class="row">
      <label class="field grow">
        <span class="label">Name <span class="req" aria-hidden="true">*</span></span>
        <input class="input" bind:value={draft.name} required aria-required="true" disabled={isEdit} />
        {#if isEdit}<span class="hint">The name of a saved chain cannot change.</span>{/if}
      </label>
      <div class="field">
        <label class="label" for="{uid}-entity">Correlate by</label>
        <Select id="{uid}-entity" aria-describedby="{uid}-entity-hint" options={CORRELATION_ENTITIES} bind:value={draft.entity} />
        <span class="hint" id="{uid}-entity-hint">{CORRELATION_ENTITIES.find((e) => e.value === draft.entity)?.help}</span>
      </div>
      <div class="field">
        <span class="label" id="{uid}-span">Maximum span</span>
        <div class="duration" role="group" aria-labelledby="{uid}-span">
          <input class="input" type="number" min="1" step="1" aria-label="Maximum span amount" bind:value={draft.span} aria-invalid={fieldErrors.span ? 'true' : undefined} />
          <Select aria-label="Maximum span unit" options={DURATION_UNITS} bind:value={draft.spanUnit} />
        </div>
        <span class={fieldErrors.span ? 'error' : 'hint'}>{fieldErrors.span ?? `First to last stage; at most ${MAX_SPAN_MINUTES} minutes.`}</span>
      </div>
    </div>
    <label class="field">
      <span class="label">Description</span>
      <input class="input" bind:value={draft.description} />
    </label>

    <ol class="stages">
      {#each draft.stages as stage, si (si)}
        <li class="stage" aria-labelledby="{uid}-stage-{si}">
          <div class="stage-head">
            <h3 id="{uid}-stage-{si}">Stage {si + 1}</h3>
            {#if si > 0}
              <div class="within">
                <span class="label" id="{uid}-within-{si}">within</span>
                <div class="duration" role="group" aria-labelledby="{uid}-within-{si}">
                  <input class="input" type="number" min="1" step="1" aria-label={`Stage ${si + 1}: time after stage ${si}`} bind:value={stage.within} aria-invalid={fieldErrors[`${si}`] ? 'true' : undefined} />
                  <Select aria-label={`Stage ${si + 1}: time unit`} options={DURATION_UNITS} bind:value={stage.withinUnit} />
                </div>
                <span class="hint">after stage {si}</span>
              </div>
            {:else}
              <span class="hint">starts the chain</span>
            {/if}
            <Button variant="ghost" size="sm" disabled={draft.stages.length <= MIN_STAGES} aria-label={`Remove stage ${si + 1}`} onclick={() => removeStage(si)}>Remove stage</Button>
          </div>
          {#if fieldErrors[`${si}`]}<p class="error">{fieldErrors[`${si}`]}</p>{/if}
          {#each stage.conditions as condition, ci (ci)}
            {@const id = `${si}.${ci}`}
            {@const kind = conditionValueKind(condition.field, condition.op)}
            {@const cid = `${uid}-c-${si}-${ci}`}
            <div class="condition">
              <div class="field">
                <label class="sr-only" for="{cid}-field">Stage {si + 1} condition {ci + 1} field</label>
                <Select id="{cid}-field" options={correlationFieldsFor(condition.field)} value={condition.field} onchange={(field) => changeField(si, ci, field)} />
              </div>
              <div class="field">
                <label class="sr-only" for="{cid}-op">Stage {si + 1} condition {ci + 1} operator</label>
                <Select id="{cid}-op" options={correlationOpsFor(condition.field)} bind:value={condition.op} />
              </div>
              {#if kind === 'scope_list'}
                {@const chosen = listValue(condition.value)}
                <fieldset class="field scopes">
                  <legend class="sr-only">Stage {si + 1} condition {ci + 1} value</legend>
                  {#each DEST_SCOPES as scope (scope.value)}
                    <label class="scope"><input type="checkbox" checked={chosen.includes(scope.value)} onchange={(e) => (condition.value = toggleListItem(condition.value, scope.value, e.currentTarget.checked))} /> {scope.label}</label>
                  {/each}
                </fieldset>
              {:else}
                <div class="field">
                  <label class="sr-only" for="{cid}-value">Stage {si + 1} condition {ci + 1} value</label>
                  {#if kind === 'severity'}
                    <Select id="{cid}-value" options={SEVERITY_OPTIONS} bind:value={condition.value} />
                  {:else if kind === 'boolean'}
                    <Select id="{cid}-value" options={BOOLEAN_OPTIONS} bind:value={condition.value} aria-invalid={fieldErrors[id] ? 'true' : undefined} />
                  {:else if kind === 'scope'}
                    <Select id="{cid}-value" options={DEST_SCOPES} bind:value={condition.value} aria-invalid={fieldErrors[id] ? 'true' : undefined} />
                  {:else}
                    <input id="{cid}-value" class="input" bind:value={condition.value} aria-invalid={fieldErrors[id] ? 'true' : undefined} placeholder={kind === 'list' ? 'a, b, c' : ''} />
                  {/if}
                </div>
              {/if}
              <Button variant="ghost" size="sm" disabled={stage.conditions.length <= 1} aria-label={`Remove stage ${si + 1} condition ${ci + 1}`} onclick={() => removeCondition(si, ci)}>Remove</Button>
              {#if fieldErrors[id]}<p class="error full">{fieldErrors[id]}</p>{/if}
            </div>
          {/each}
          <div><Button variant="secondary" size="sm" onclick={() => addCondition(si)}>Add condition</Button></div>
        </li>
      {/each}
    </ol>
    <div><Button variant="secondary" size="sm" disabled={draft.stages.length >= MAX_STAGES} onclick={addStage}>Add stage</Button> <span class="hint">{draft.stages.length} of {MIN_STAGES}–{MAX_STAGES} stages</span></div>
    </fieldset>

    {#if errors.length}<Alert tone="error" message={errors.join(' ')} />{/if}
    {#if serverError}<Alert tone="error" message={serverError} />{/if}
  </form>

  {#snippet footer()}
    <Button variant="ghost" onclick={close}>{readOnly ? 'Close' : 'Cancel'}</Button>
    {#if !rule?.built_in}
      <Button variant="primary" type="submit" form="{uid}-form" loading={saving} disabled={readOnly || saving} title={canManage ? undefined : 'Requires the owner role'}>
        {isEdit ? 'Save chain' : 'Create chain'}
      </Button>
    {/if}
  {/snippet}
</Drawer>

<style>
  .form { display: grid; gap: var(--sp-4); min-width: 0; }
  .bare { display: grid; gap: var(--sp-4); min-width: 0; margin: 0; padding: 0; border: 0; }
  .context { margin: 0; font-size: var(--fs-sm); color: var(--text-secondary); }
  .row { display: flex; flex-wrap: wrap; gap: var(--sp-3); }
  .grow { flex: 1 1 14rem; }
  .field { display: grid; gap: var(--sp-1); min-width: 0; align-content: start; }
  .label { font-size: var(--fs-sm); font-weight: var(--fw-medium); color: var(--text-secondary); }
  .req { color: var(--danger); }
  .hint { font-size: var(--fs-xs); color: var(--text-muted); font-weight: 400; }
  .error { margin: 0; font-size: var(--fs-xs); color: var(--danger); }
  .input { width: 100%; padding: var(--sp-2); border: 1px solid var(--border-strong); border-radius: var(--radius); background: var(--surface-input); color: var(--text-primary); font-size: var(--fs-sm); }
  .input[aria-invalid='true'] { border-color: var(--danger); }
  .duration { display: grid; grid-template-columns: 6rem 8rem; gap: var(--sp-1); }
  .stages { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--sp-3); }
  .stage { display: grid; gap: var(--sp-2); padding: var(--sp-3); border: 1px solid var(--border); border-left: 3px solid var(--accent); border-radius: var(--radius-lg); }
  .stage-head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-3); }
  .stage-head h3 { margin: 0; font-size: var(--fs-sm); font-weight: var(--fw-semibold); }
  .stage-head :global(button:last-child) { margin-left: auto; }
  .within { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); }
  .condition { display: grid; grid-template-columns: minmax(9rem, 1fr) minmax(8rem, 0.8fr) minmax(8rem, 1.4fr) auto; gap: var(--sp-2); align-items: center; }
  .full { grid-column: 1 / -1; }
  .scopes { display: flex; flex-wrap: wrap; gap: var(--sp-1) var(--sp-3); margin: 0; padding: 0; border: 0; font-size: var(--fs-sm); color: var(--text-secondary); }
  .scope { display: inline-flex; align-items: center; gap: var(--sp-1); }
  @media (max-width: 640px) {
    .condition { grid-template-columns: minmax(0, 1fr); }
    .duration { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  }
</style>
