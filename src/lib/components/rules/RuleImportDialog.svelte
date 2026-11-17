<!--
  RuleImportDialog: preview of a custom rules file before anything is
  created: one row per entry with its check result, per-row
  selection, invalid rows excluded from selection and from the count, and
  every imported rule created disabled unless the operator explicitly keeps
  the enabled state from the file. Logic lives in $lib/custom-rules-io; the
  page performs the API calls through `onimport`.
-->
<script lang="ts">
  import Modal from '#lib/components/ui/Modal.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Alert from '#lib/components/ui/Alert.svelte';
  import DataTable from '#lib/components/ui/DataTable.svelte';
  import type { DataTableColumn } from '#lib/components/ui/types.js';
  import { actionTone } from '#lib/tone.js';
  import {
    buildImportItems,
    capacityError,
    defaultImportSelection,
    importBlockedReason,
    importsEnabled,
    isImportable,
    summarizeImport,
    type ImportItem,
    type ImportRow,
  } from '#lib/custom-rules-io.js';
  import { RULE_STAGES } from './rule-stages';
  import { tuningScopeMatchesEverything } from './rule-risk';

  interface Props {
    open: boolean;
    rows: ImportRow[];
    fileName?: string;
    appName?: string;
    /** Rules the application already has (for the per-app cap). */
    existingCount: number;
    importing?: boolean;
    /** False for a non-owner: script rows are listed but cannot be selected. */
    canEditScripts?: boolean;
    /** Per-row errors of the last import attempt, by row index (rows that were refused). */
    rowErrors?: Record<number, string>;
    onimport: (items: ImportItem[]) => void | Promise<void>;
    onclose: () => void;
  }

  let { open, rows, fileName = '', appName = 'this application', existingCount, importing = false, canEditScripts = true, rowErrors = {}, onimport, onclose }: Props = $props();
  const access = $derived({ canEditScripts });

  const uid = $props.id();
  let selected = $state<Set<number>>(new Set());
  let keepEnabled = $state(false);

  // Fresh selection for every file.
  $effect(() => {
    const list = rows;
    if (!open) return;
    selected = defaultImportSelection(list, access);
  });

  // A new file (not the rows left after a partial import) starts with the
  // file's enabled state ignored.
  $effect(() => {
    void fileName;
    if (open) keepEnabled = false;
  });

  const summary = $derived(summarizeImport(rows, selected, keepEnabled, access));
  const capacity = $derived(capacityError(existingCount, summary.selected));
  const canImport = $derived(summary.selected > 0 && !capacity && !importing);

  function toggle(row: ImportRow, on: boolean) {
    if (!isImportable(row, access)) return;
    const next = new Set(selected);
    if (on) next.add(row.index);
    else next.delete(row.index);
    selected = next;
  }

  function selectAll(on: boolean) {
    selected = on ? defaultImportSelection(rows, access) : new Set();
  }

  /** Things to know about a valid row before importing it. */
  function rowNotes(row: ImportRow): string[] {
    const notes: string[] = [];
    if (row.duplicate) notes.push('A rule with this name already exists; both are kept.');
    if (row.body?.mode === 'tuning' && tuningScopeMatchesEverything(row.body.tuning)) {
      notes.push('No "Apply when" conditions: it applies to every request.');
    }
    return notes;
  }

  function modeLabel(mode: string): string {
    return mode === 'gui' || mode === 'script' || mode === 'tuning' ? RULE_STAGES[mode].label : mode || 'n/a';
  }

  function submit() {
    if (!canImport) return;
    void onimport(buildImportItems(rows, selected, { keepEnabled, canEditScripts }));
  }

  const columns: DataTableColumn<ImportRow>[] = [
    { key: 'select', label: 'Import', width: '4.5rem' },
    { key: 'name', label: 'Rule', rowHeader: true },
    { key: 'mode', label: 'Type', nowrap: true },
    { key: 'action', label: 'Action', nowrap: true },
    { key: 'starts', label: 'Starts as', nowrap: true },
    { key: 'check', label: 'Check' },
  ];
</script>

<Modal {open} title="Import custom rules" size="xl" dismissible={!importing} onclose={onclose}>
  <div class="ri">
    <p class="ri-lead">
      {#if fileName}<strong>{fileName}</strong>{': '}{/if}{summary.total} {summary.total === 1 ? 'rule' : 'rules'} in the file,
      {summary.valid} valid{summary.invalid ? `, ${summary.invalid} cannot be imported` : ''}. Rules are added to <strong>{appName}</strong>; existing rules are kept.
    </p>
    {#if summary.blocked > 0}
      <Alert tone="info" compact message={`${summary.blocked} script ${summary.blocked === 1 ? 'rule' : 'rules'} cannot be selected: only project owners can create script rules.`} />
    {/if}
    {#if Object.keys(rowErrors).length > 0}
      <Alert tone="error" compact title="Some rules were not imported" message="The rules still listed here were not created; see the Check column. Imported rules were removed from the list." />
    {/if}

    <div class="ri-tools">
      <Button variant="ghost" size="sm" disabled={summary.valid - summary.blocked === 0 || summary.selected === summary.valid - summary.blocked} onclick={() => selectAll(true)}>Select all valid</Button>
      <Button variant="ghost" size="sm" disabled={summary.selected === 0} onclick={() => selectAll(false)}>Select none</Button>
    </div>

    <DataTable
      {rows}
      {columns}
      rowKey={(r) => r.index}
      caption="Rules in the file"
      density="compact"
      maxHeight="340px"
      rowClass={(r) => (r.body ? undefined : 'ri-invalid')}
    >
      {#snippet cell(row, column)}
        {#if column.key === 'select'}
          {@const blocked = importBlockedReason(row, access)}
          <input
            type="checkbox"
            class="ri-check"
            checked={isImportable(row, access) && selected.has(row.index)}
            disabled={!isImportable(row, access) || importing}
            title={blocked ?? undefined}
            aria-label={isImportable(row, access) ? `Import ${row.name}` : `${row.name} cannot be imported${blocked ? `: ${blocked}` : ''}`}
            onchange={(e) => toggle(row, e.currentTarget.checked)}
          />
        {:else if column.key === 'name'}
          <span class="ri-name">{row.name}</span>
          {#if row.priority !== null}<span class="ri-sub">Priority {row.priority}</span>{/if}
        {:else if column.key === 'mode'}
          {modeLabel(row.mode)}
        {:else if column.key === 'action'}
          {#if !row.body}
            <span class="ri-muted">{row.action || 'n/a'}</span>
          {:else if row.mode === 'gui' && row.action}
            <Badge tone={actionTone(row.action)}>{row.action.charAt(0).toUpperCase()}{row.action.slice(1)}</Badge>
          {:else if row.mode === 'script'}
            <span class="ri-muted">Script decides</span>
          {:else}
            <span class="ri-muted">n/a</span>
          {/if}
        {:else if column.key === 'starts'}
          {#if !row.body}
            <span class="ri-muted">n/a</span>
          {:else if importsEnabled(row, keepEnabled)}
            <Badge tone="warning">Enabled</Badge>
          {:else}
            <Badge tone="neutral">Disabled</Badge>
          {/if}
        {:else if column.key === 'check'}
          {@const blocked = importBlockedReason(row, access)}
          {#if row.error}
            <span class="ri-error">Cannot import: {row.error}</span>
          {:else if rowErrors[row.index]}
            <span class="ri-error">Not imported: {rowErrors[row.index]}</span>
          {:else if blocked}
            <span class="ri-muted">{blocked}</span>
          {:else}
            {@const notes = rowNotes(row)}
            {#if notes.length > 0}
              <span class="ri-warn">Ready. {notes.join(' ')}</span>
            {:else}
              <span class="ri-ok">Ready</span>
            {/if}
          {/if}
        {/if}
      {/snippet}
    </DataTable>

    <label class="ri-keep">
      <input type="checkbox" bind:checked={keepEnabled} disabled={importing} aria-describedby="{uid}-keep-hint" />
      <span>Keep the enabled state from the file</span>
    </label>
    <p class="ri-hint" id="{uid}-keep-hint">
      {keepEnabled
        ? `${summary.enabledOnImport} of the selected rules start enabled and act on traffic as soon as they are created.`
        : 'Every imported rule starts disabled. Review it in the list and turn it on there.'}
    </p>

    {#if keepEnabled && summary.risky.length > 0}
      <Alert tone="warning" title="Some rules change how traffic is inspected as soon as they are created">
        <ul class="ri-risks">
          {#each summary.risky as item (item.row.index)}
            <li><strong>{item.row.name}</strong>: {item.risk.message}</li>
          {/each}
        </ul>
      </Alert>
    {/if}
    {#if capacity}
      <Alert tone="error" message={capacity} />
    {/if}
  </div>

  {#snippet footer()}
    <Button variant="secondary" disabled={importing} onclick={onclose}>Cancel</Button>
    <Button variant={keepEnabled && summary.risky.length > 0 ? 'warning' : 'primary'} loading={importing} disabled={!canImport} onclick={submit}>
      {importing ? 'Importing…' : `Import ${summary.selected} ${summary.selected === 1 ? 'rule' : 'rules'}`}
    </Button>
  {/snippet}
</Modal>

<style>
  .ri { display: flex; flex-direction: column; gap: var(--sp-3); min-width: 0; }
  .ri-lead { margin: 0; font-size: var(--fs-sm); color: var(--text-secondary); line-height: 1.55; }
  .ri-lead strong { color: var(--text-primary); }
  .ri-tools { display: flex; flex-wrap: wrap; gap: var(--sp-2); }
  .ri-check { width: 16px; height: 16px; accent-color: var(--accent); }
  .ri-name { display: block; color: var(--text-primary); overflow-wrap: anywhere; }
  .ri-sub, .ri-muted { font-size: var(--fs-xs); color: var(--text-muted); }
  .ri-error { font-size: var(--fs-xs); color: var(--danger); }
  .ri-warn { font-size: var(--fs-xs); color: var(--warning); }
  .ri-ok { font-size: var(--fs-xs); color: var(--success); }
  :global(.ri-invalid) { background: var(--danger-tint); }
  .ri-keep { display: inline-flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm); color: var(--text-primary); cursor: pointer; }
  .ri-keep input { width: 16px; height: 16px; accent-color: var(--accent); }
  .ri-hint { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
  .ri-risks { margin: var(--sp-1) 0 0; padding-left: var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-1); font-size: var(--fs-sm); }
</style>
