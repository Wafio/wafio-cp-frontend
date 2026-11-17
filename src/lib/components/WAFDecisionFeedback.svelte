<!--
  WAFDecisionFeedback: human assessment of one stored decision (true
  positive / false positive / unsure) with a note. Feedback never changes
  rules; "Tune false positive" in the decision drawer does that.
  Permissions come from the project context (no getProject per load).
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { getWAFDecisionFeedback, addWAFDecisionFeedback, type WAFDecisionFeedback } from '#lib/api.js';
  import { Button, DateTime, Field, InlineError, Pagination, Spinner } from '#lib/components/ui/index.js';
  import Select from '#lib/components/ui/Select.svelte';
  import { tryGetProjectContext } from '#lib/project-context.svelte.js';
  import { toast } from '#lib/stores/toast.js';

  let { projectId, appId, decisionId, recordedAt }: { projectId: string; appId: string; decisionId: number; recordedAt: string } = $props();

  const PAGE = 20;
  const uid = $props.id();
  const project = tryGetProjectContext();
  const canWrite = $derived(project?.canConfigure ?? false);

  let rows: WAFDecisionFeedback[] = $state([]);
  let total = $state(0);
  let offset = $state(0);
  let loading = $state(false);
  let saving = $state(false);
  let error = $state('');
  let note = $state('');
  let verdict: WAFDecisionFeedback['verdict'] = $state('unsure');
  const VERDICTS: { value: WAFDecisionFeedback['verdict']; label: string }[] = [
    { value: 'true_positive', label: 'True positive' },
    { value: 'false_positive', label: 'False positive' },
    { value: 'unsure', label: 'Unsure' },
  ];
  let version = 0;

  async function load() {
    const current = ++version;
    loading = true;
    error = '';
    const result = await getWAFDecisionFeedback(projectId, appId, decisionId, recordedAt, offset);
    if (current !== version) return;
    loading = false;
    if (result.error) {
      error = result.error.error;
      return;
    }
    rows = result.data?.feedback ?? [];
    total = result.data?.total ?? 0;
  }

  $effect(() => {
    const identity = `${projectId}/${appId}/${decisionId}/${recordedAt}`;
    if (identity && decisionId > 0) {
      untrack(() => {
        offset = 0;
        note = '';
        rows = [];
        void load();
      });
    }
    return () => {
      version++;
    };
  });

  async function save() {
    if (!canWrite || saving) return;
    saving = true;
    error = '';
    try {
      const result = await addWAFDecisionFeedback(projectId, appId, decisionId, recordedAt, verdict, note);
      if (result.error) {
        error = result.error.error;
        toast.error(result.error.error || 'Failed to save feedback.');
        return;
      }
      toast.success('Feedback saved.');
      note = '';
      offset = 0;
      await load();
    } finally {
      saving = false;
    }
  }

  const VERDICT_LABELS: Record<WAFDecisionFeedback['verdict'], string> = {
    true_positive: 'True positive',
    false_positive: 'False positive',
    unsure: 'Unsure',
  };
</script>

<section class="feedback" aria-labelledby={`${uid}-title`}>
  <h3 id={`${uid}-title`}>Assessment</h3>
  <p class="feedback-note">Record whether this decision was right. Feedback is kept with the decision; it does not change rules or allowlists.</p>
  {#if decisionId <= 0}
    <p class="feedback-note">Live decisions can be assessed once they are stored. Open the decision again from the Decisions tab.</p>
  {:else}
    <InlineError message={error} onretry={error ? () => void load() : undefined} />
    {#if canWrite}
      <form class="feedback-form" onsubmit={(event) => { event.preventDefault(); void save(); }}>
        <Field label="Assessment">
          {#snippet children(c)}
            <Select {...c} options={VERDICTS} bind:value={verdict} disabled={saving} />
          {/snippet}
        </Field>
        <Field label="Note" optional hint="Why you assessed it this way. Do not paste secrets.">
          {#snippet children(c)}<textarea {...c} bind:value={note} maxlength="2000" rows="3" disabled={saving}></textarea>{/snippet}
        </Field>
        <div><Button type="submit" variant="secondary" size="sm" loading={saving} disabled={saving || loading}>Save assessment</Button></div>
      </form>
    {:else if !loading}
      <p class="feedback-note">Viewers can read assessments; project members and owners can add them.</p>
    {/if}
    {#if loading}
      <Spinner size="sm" label="Loading assessments" />
    {:else if rows.length === 0 && !error}
      <p class="feedback-note">No assessments recorded.</p>
    {:else}
      <ul class="feedback-list">
        {#each rows as row (row.id)}
          <li>
            <strong>{VERDICT_LABELS[row.verdict] ?? row.verdict}</strong>
            {#if row.note}<p>{row.note}</p>{/if}
            <small>{row.actor_user_id} · <DateTime value={row.created_at} /></small>
          </li>
        {/each}
      </ul>
      {#if total > PAGE}
        <Pagination {offset} limit={PAGE} {total} count={rows.length} itemLabel="assessments" disabled={loading} onchange={(next) => { offset = next; void load(); }} />
      {/if}
    {/if}
  {/if}
</section>

<style>
  .feedback { display: flex; flex-direction: column; gap: var(--sp-3); color: var(--text-primary); }
  h3 { margin: 0; font-size: var(--fs-sm); color: var(--text-muted); }
  .feedback-note { margin: 0; font-size: var(--fs-sm); color: var(--text-secondary); line-height: 1.5; }
  .feedback-form { display: flex; flex-direction: column; gap: var(--sp-3); }
  .feedback-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
  .feedback-list li { border-top: 1px solid var(--border); padding: var(--sp-3) 0; display: flex; flex-direction: column; gap: var(--sp-1); }
  .feedback-list p { margin: 0; color: var(--text-secondary); font-size: var(--fs-sm); white-space: pre-wrap; overflow-wrap: anywhere; }
  .feedback-list small { color: var(--text-muted); font-size: var(--fs-xs); }
</style>
