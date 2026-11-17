<!--
  Administration › Data retention: database size against an optional budget
  (warning 80 %, critical 95 %), the TimescaleDB state and the retention per
  time-series table (GET/PUT /api/admin/storage). Retention changes apply at
  once; only changed rows are sent. System administrators only.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { getStorageStatus, updateRetention, updateStorageBudget, type StorageStatus, type StorageTable } from '#lib/api.js';
  import { createDirtyTracker } from '#lib/dirty.svelte.js';
  import { formatNumber, formatPercent } from '#lib/format.js';
  import { focusFormError } from '#lib/focus-error.js';
  import { capabilityTone, jobStateTone, pressureTone } from '#lib/tone.js';
  import { storageAlert } from '#lib/storage-alert.svelte.js';
  import {
    BUDGET_MAX_GB,
    BUDGET_MIN_GB,
    alertFromDatabase,
    budgetInput,
    buildRetentionUpdate,
    compressionRatio,
    formatSize,
    growthSourceNote,
    meterLevel,
    meterPercent,
    modeLabel,
    noBreak,
    parseBudget,
    projectionText,
    retentionErrorTable,
    retentionForm,
    validateRetention,
    type RetentionErrors,
    type RetentionForm,
  } from '#lib/storage-retention.js';
  import PageHeader from '#lib/components/ui/PageHeader.svelte';
  import Alert from '#lib/components/ui/Alert.svelte';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Card from '#lib/components/ui/Card.svelte';
  import DateTime from '#lib/components/ui/DateTime.svelte';
  import Field from '#lib/components/ui/Field.svelte';
  import InlineError from '#lib/components/ui/InlineError.svelte';
  import Table from '#lib/components/ui/Table.svelte';
  import { toast } from '#lib/stores/toast.js';

  let status = $state<StorageStatus | null>(null);
  let loading = $state(true);
  let reloading = $state(false);
  let loadError = $state('');

  let form = $state<RetentionForm>({});
  let baseline = $state<RetentionForm>({});
  let errors = $state<RetentionErrors>({});
  let saveError = $state('');
  let saveMessage = $state('');
  let saving = $state(false);

  let budget = $state('');
  let budgetError = $state('');
  let budgetSaving = $state(false);

  let retentionFormEl = $state<HTMLFormElement | null>(null);
  let budgetFormEl = $state<HTMLFormElement | null>(null);

  const dirty = createDirtyTracker(() => ({ form, budget }));
  dirty.guardNavigation();

  const db = $derived(status?.database ?? null);
  const tables = $derived(status?.tables ?? []);
  const level = $derived(db ? meterLevel(db.used_ratio, db.warning_ratio, db.critical_ratio) : 'none');
  const fsLevel = $derived(db ? meterLevel(db.filesystem.used_ratio, db.warning_ratio, db.critical_ratio) : 'none');
  const warnPct = $derived(formatPercent(db?.warning_ratio ?? 0.8, { digits: 0 }));
  const critPct = $derived(formatPercent(db?.critical_ratio ?? 0.95, { digits: 0 }));
  const retentionDirty = $derived(tables.some((t) => (form[t.table] ?? '') !== (baseline[t.table] ?? '')));
  const budgetDirty = $derived(budget.trim() !== budgetInput(db?.budget_bytes ?? null));

  function apply(next: StorageStatus) {
    status = next;
    form = retentionForm(next);
    baseline = retentionForm(next);
    budget = budgetInput(next.database.budget_bytes);
    errors = {};
    budgetError = '';
    dirty.reset();
    storageAlert.set(alertFromDatabase(next.database));
  }

  async function load() {
    if (status) reloading = true;
    else loading = true;
    const res = await getStorageStatus();
    loading = false;
    reloading = false;
    if (res.error || !res.data) {
      loadError = res.error?.error ?? 'Unable to load the storage status.';
      return;
    }
    loadError = '';
    // A reload keeps unsaved edits only if the operator agrees to drop them.
    if (dirty.isDirty && status && !(await dirty.confirmDiscard())) return;
    apply(res.data);
  }

  async function saveRetention(event: SubmitEvent) {
    event.preventDefault();
    if (!status || saving) return;
    saveError = '';
    saveMessage = '';
    errors = validateRetention(form, tables);
    if (Object.keys(errors).length > 0) {
      void focusFormError(retentionFormEl);
      return;
    }
    const update = buildRetentionUpdate(form, baseline, tables);
    if (Object.keys(update.tables).length === 0) return;
    saving = true;
    const res = await updateRetention(update);
    saving = false;
    if (res.error || !res.data) {
      const table = retentionErrorTable(res.error?.field);
      if (table && (res.error?.code === 'VALIDATION_FAILED' || res.error?.code === 'RETENTION_BELOW_COMPRESSION')) {
        errors = { [table]: res.error?.error ?? 'Invalid value.' };
      } else {
        saveError = res.error?.error ?? 'The retention could not be saved.';
      }
      void focusFormError(retentionFormEl);
      return;
    }
    // Keep an unsaved budget edit; the retention rows refill from the response.
    const keepBudget = budget;
    apply(res.data);
    budget = keepBudget;
    const n = Object.keys(update.tables).length;
    saveMessage = `Retention saved for ${n} ${n === 1 ? 'table' : 'tables'}. It applies at once.`;
  }

  function discardRetention() {
    form = { ...baseline };
    errors = {};
    saveError = '';
  }

  async function saveBudget(value: number | null) {
    budgetSaving = true;
    const res = await updateStorageBudget(value);
    budgetSaving = false;
    if (res.error || !res.data) {
      budgetError = res.error?.error ?? 'The budget could not be saved.';
      void focusFormError(budgetFormEl);
      return;
    }
    // Keep unsaved retention edits; only the budget and the status refresh.
    const keepForm = { ...form };
    const keepErrors = errors;
    apply(res.data);
    form = keepForm;
    errors = keepErrors;
    dirty.reset({ form: baseline, budget: budgetInput(res.data.database.budget_bytes) });
    toast.success(value === null ? 'Budget removed.' : 'Budget saved.');
  }

  async function submitBudget(event: SubmitEvent) {
    event.preventDefault();
    if (budgetSaving) return;
    const parsed = parseBudget(budget);
    if (parsed.error) {
      budgetError = parsed.error;
      void focusFormError(budgetFormEl);
      return;
    }
    budgetError = '';
    await saveBudget(parsed.value);
  }

  function resetRow(t: StorageTable) {
    form[t.table] = '';
    const { [t.table]: _drop, ...rest } = errors;
    errors = rest;
  }

  const rowDirty = (t: StorageTable) => (form[t.table] ?? '') !== (baseline[t.table] ?? '');

  onMount(load);
</script>

<div class="admin-page">
  <PageHeader title="Data retention" subtitle="Database size, its growth and how long each kind of event data is kept.">
    {#snippet actions()}
      <Button variant="secondary" loading={reloading} disabled={loading || reloading} onclick={load}>{reloading ? 'Reloading…' : 'Reload'}</Button>
    {/snippet}
  </PageHeader>

  {#if loading}
    <p class="hint" role="status">Loading storage status…</p>
  {:else if loadError && !status}
    <Alert tone="error" message={loadError}>
      {#snippet actions()}<Button variant="secondary" size="sm" onclick={load}>Retry</Button>{/snippet}
    </Alert>
  {:else if status && db}
    {#if loadError}<Alert tone="error" compact message={`Reload failed: ${loadError}`} />{/if}

    <Card title="Database size">
      <div class="meter-block">
        <div class="meter-head">
          <span class="big nowrap">{formatSize(db.size_bytes)}</span>
          <span class="muted">
            {#if db.budget_bytes !== null}of <span class="nowrap">{formatSize(db.budget_bytes)}</span> budget · <span class="nowrap">{formatPercent(db.used_ratio, { digits: 0 })} used</span>{:else}No budget set{/if}
          </span>
        </div>
        {#if db.budget_bytes !== null}
          <div
            class="meter level-{level}"
            role="meter"
            aria-label="Database size against its budget"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(meterPercent(db.used_ratio))}
            aria-valuetext={`${formatPercent(db.used_ratio, { digits: 0 })} of the budget${level === 'critical' ? ', critical' : level === 'warning' ? ', warning' : ''}`}
          >
            <span class="meter-fill" style:width="{meterPercent(db.used_ratio)}%"></span>
            <span class="meter-mark" style:left="{meterPercent(db.warning_ratio)}%" aria-hidden="true"></span>
            <span class="meter-mark" style:left="{meterPercent(db.critical_ratio)}%" aria-hidden="true"></span>
          </div>
          {#if level === 'critical' || level === 'warning'}
            <p class="level-text level-{level}">{level === 'critical' ? 'Critical' : 'Warning'}: the database is above {level === 'critical' ? critPct : warnPct} of its budget.</p>
          {/if}
        {/if}
      </div>

      <dl class="facts">
        <div><dt>Ingest per day</dt><dd class="nowrap">{formatSize(db.ingest_bytes_per_day)}</dd></div>
        <div>
          <dt>Net growth per day</dt>
          <dd><span class="nowrap">{formatSize(db.growth_bytes_per_day)}</span> <span class="muted">({growthSourceNote(db.growth_source)})</span></dd>
        </div>
        <div><dt>Projected steady-state size</dt><dd class="nowrap">{formatSize(db.projected_size_bytes)}</dd></div>
        <div><dt>Projection</dt><dd>{projectionText(db)}</dd></div>
        <div>
          <dt>Disk holding the database</dt>
          <dd>
            {#if db.filesystem.known}
              <span class="nowrap">{formatSize(db.filesystem.free_bytes)}</span> free of <span class="nowrap">{formatSize(db.filesystem.total_bytes)}</span>
              <span class="muted nowrap">({formatPercent(db.filesystem.used_ratio, { digits: 0 })} used)</span>
              {#if fsLevel === 'critical' || fsLevel === 'warning'}<Badge tone={pressureTone(fsLevel)}>{fsLevel === 'critical' ? 'Critical' : 'Warning'}</Badge>{/if}
            {:else}
              <span class="muted">Unknown{db.filesystem.reason ? `: ${db.filesystem.reason}` : ''}</span>
            {/if}
          </dd>
        </div>
        <div><dt>Checked</dt><dd><DateTime value={db.checked_at ?? status.checked_at} relative /></dd></div>
      </dl>

      <form class="budget" bind:this={budgetFormEl} onsubmit={submitBudget} novalidate>
        <Field
          label="Size budget (GB)"
          optional
          hint={`Empty: no budget. ${noBreak(`${BUDGET_MIN_GB}–${formatNumber(BUDGET_MAX_GB)} GB`)}. Administrators are warned at ${warnPct} and at ${critPct} (critical) of the budget, and when the disk holding the database passes those levels.`}
          error={budgetError}
        >
          {#snippet children(control)}
            <div class="budget-control">
              <input {...control} type="text" inputmode="decimal" bind:value={budget} placeholder="No budget" maxlength="12" autocomplete="off" />
              <Button type="submit" variant="secondary" loading={budgetSaving} disabled={budgetSaving || !budgetDirty}>Save budget</Button>
              {#if db.budget_bytes !== null}
                <Button variant="ghost" disabled={budgetSaving} onclick={() => { budget = ''; budgetError = ''; void saveBudget(null); }}>Remove budget</Button>
              {/if}
            </div>
          {/snippet}
        </Field>
      </form>
    </Card>

    <Card title="TimescaleDB">
      {#if status.timescaledb.installed}
        <p class="ts-line">
          <Badge tone={capabilityTone(true)}>Installed</Badge>
          <span>Version {status.timescaledb.version || 'n/a'}</span>
          {#if status.timescaledb.license}<span class="muted">· {status.timescaledb.license} license</span>{/if}
          {#if !status.timescaledb.policies_supported}<span class="muted">· retention policies not supported</span>{/if}
        </p>
      {:else}
        <p class="ts-line"><Badge tone={capabilityTone(false)}>Not installed</Badge></p>
      {/if}
      {#if status.timescaledb.note}<p class="note">{status.timescaledb.note}</p>{/if}
    </Card>

    <Card title="Retention per table">
      <p class="intro">
        Data older than the retention is deleted automatically. Changes apply immediately. Each table accepts the days shown under its input;
        leave a field empty (or use “Reset to default”) to use the default.
      </p>
      <form bind:this={retentionFormEl} onsubmit={saveRetention} novalidate class="retention-form">
        <Table
          label="Retention per table"
          columns={['Table', 'Retention', 'Mode / status', { label: 'Size', align: 'right' }, 'Compression', 'Oldest data', { label: 'Ingest / day', align: 'right' }]}
        >
          {#each tables as t (t.table)}
            {@const errId = `ret-err-${t.table}`}
            {@const hintId = `ret-hint-${t.table}`}
            <tr class:changed={rowDirty(t)}>
              <td>
                <div class="t-label">{t.label}</div>
                <code class="t-name">{t.table}</code>
              </td>
              <td class="ret-cell">
                <Field label={`Retention for ${t.label}, in days`} hideLabel>
                  {#snippet children(control)}
                    <div class="ret-input">
                      <input
                        {...control}
                        type="text"
                        inputmode="numeric"
                        maxlength="6"
                        autocomplete="off"
                        bind:value={form[t.table]}
                        placeholder={`${t.default_days}`}
                        aria-invalid={errors[t.table] ? 'true' : undefined}
                        aria-describedby={errors[t.table] ? `${errId} ${hintId}` : hintId}
                      />
                      <span class="muted" aria-hidden="true">days</span>
                    </div>
                  {/snippet}
                </Field>
                <div class="ret-hint" id={hintId}>
                  <span class="nowrap">default {t.default_days} days</span> · <span class="nowrap">allowed {t.min_days}–{t.max_days}</span>
                </div>
                {#if t.live_days !== null && t.live_days !== t.retention_days}
                  <div class="ret-hint">In force now: <span class="nowrap">{t.live_days} days</span></div>
                {/if}
                {#if t.saved && (baseline[t.table] ?? '') !== '' && (form[t.table] ?? '') !== ''}
                  <button type="button" class="link-btn" onclick={() => resetRow(t)}>Reset to default</button>
                {/if}
                <InlineError id={errId} class="row-error" message={errors[t.table]} />
              </td>
              <td>
                <div>{modeLabel(t.mode)}</div>
                {#if t.active}
                  <Badge tone={jobStateTone(true)}>Active</Badge>
                {:else}
                  <Badge tone={jobStateTone(false)}>Not active</Badge>
                  {#if t.inactive_reason}<p class="reason">{t.inactive_reason}</p>{/if}
                {/if}
                {#if t.last_run_at}
                  <div class="ret-hint">Last run <DateTime value={t.last_run_at} relative /></div>
                  {#if t.last_run_deleted !== null}
                    <div class="ret-hint"><span class="nowrap">{formatNumber(t.last_run_deleted)} removed</span></div>
                  {/if}
                {/if}
              </td>
              <td class="num">{formatSize(t.total_bytes)}</td>
              <td>
                {#if t.compression?.enabled && t.compression.ratio !== null}
                  <div>{compressionRatio(t)}</div>
                  <div class="ret-hint"><span class="nowrap">{formatSize(t.compression.after_bytes)}</span> from <span class="nowrap">{formatSize(t.compression.before_bytes)}</span></div>
                {:else if t.compression?.enabled}
                  <div class="muted">On, nothing compressed yet</div>
                {:else}
                  <span class="muted">n/a</span>
                {/if}
              </td>
              <td>
                {#if t.oldest_at}
                  {#if t.oldest_kind === 'chunk'}<div class="ret-hint">oldest chunk starts</div>{/if}
                  <DateTime value={t.oldest_at} relative />
                {:else}
                  <span class="muted">n/a</span>
                {/if}
              </td>
              <td class="num">{formatSize(t.ingest_bytes_per_day)}</td>
            </tr>
          {/each}
        </Table>

        {#if saveError}<Alert tone="error" compact message={saveError} />{/if}
        {#if saveMessage && !retentionDirty}<Alert tone="success" compact message={saveMessage} />{/if}
        <div class="actions">
          <Button type="submit" loading={saving} disabled={saving || !retentionDirty}>{saving ? 'Saving…' : 'Save retention'}</Button>
          <Button variant="ghost" disabled={saving || !retentionDirty} onclick={discardRetention}>Discard changes</Button>
        </div>
      </form>
    </Card>
  {/if}
</div>

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
  .hint { margin: 0; font-size: var(--fs-sm); color: var(--text-muted); }
  .muted { color: var(--text-muted); }
  .meter-block { display: grid; gap: var(--sp-2); margin-bottom: var(--sp-4); }
  .meter-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--sp-3); }
  .big { font-size: var(--fs-xl, 1.5rem); font-weight: var(--fw-semibold); color: var(--text-primary); }
  .meter {
    --meter: var(--accent);
    position: relative;
    height: 10px;
    border-radius: var(--radius);
    background: var(--bg-tertiary);
    border: 1px solid var(--border-strong);
    overflow: hidden;
  }
  .meter.level-warning { --meter: var(--warning); }
  .meter.level-critical { --meter: var(--danger); }
  .meter-fill { position: absolute; inset: 0 auto 0 0; background: var(--meter); }
  .meter-mark { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--text-muted); }
  .level-text { margin: 0; font-size: var(--fs-sm); font-weight: var(--fw-medium); }
  .level-text.level-warning { color: var(--warning); }
  .level-text.level-critical { color: var(--danger); }
  .facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: var(--sp-3) var(--sp-5); margin: 0 0 var(--sp-4); }
  .facts dt { font-size: var(--fs-sm); color: var(--text-muted); }
  .facts dd { margin: var(--sp-1) 0 0; font-size: var(--fs-sm); color: var(--text-primary); overflow-wrap: anywhere; }
  .budget { border-top: 1px solid var(--border); padding-top: var(--sp-4); }
  .budget-control { display: flex; flex-wrap: wrap; gap: var(--sp-3); align-items: stretch; }
  .budget-control input { flex: 0 1 180px; min-width: 0; }
  .ts-line { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); margin: 0; font-size: var(--fs-sm); }
  .note { margin: var(--sp-3) 0 0; font-size: var(--fs-sm); color: var(--text-secondary); }
  .intro { margin: 0 0 var(--sp-4); font-size: var(--fs-sm); color: var(--text-secondary); }
  .retention-form { display: flex; flex-direction: column; gap: var(--sp-4); }
  .retention-form :global(td) { vertical-align: top; font-size: var(--fs-sm); }
  .t-label { color: var(--text-primary); font-weight: var(--fw-medium); }
  .t-name { font-family: var(--font-mono, monospace); font-size: var(--fs-xs); color: var(--text-muted); }
  .ret-cell { min-width: 170px; }
  .ret-input { display: flex; align-items: center; gap: var(--sp-2); }
  /* Body line height, as the budget input: table cells set 1.5. */
  .ret-input input { width: 80px; line-height: 1.6; }
  .ret-input input[aria-invalid='true'] { border-color: var(--danger); }
  .ret-hint { margin-top: var(--sp-1); font-size: var(--fs-xs); color: var(--text-muted); }
  .reason { margin: var(--sp-1) 0 0; max-width: 260px; font-size: var(--fs-xs); color: var(--text-secondary); }
  .ret-cell :global(.row-error) { margin-top: var(--sp-1); max-width: 240px; }
  .nowrap { white-space: nowrap; }
  .link-btn {
    margin-top: var(--sp-1);
    padding: 0;
    border: 0;
    background: none;
    color: var(--accent);
    font-size: var(--fs-xs);
    cursor: pointer;
    text-decoration: underline;
  }
  .num { text-align: right; white-space: nowrap; }
  tr.changed :global(td:first-child) { box-shadow: inset 3px 0 0 var(--accent); }
  .actions { display: flex; flex-wrap: wrap; gap: var(--sp-3); align-items: center; }
</style>
