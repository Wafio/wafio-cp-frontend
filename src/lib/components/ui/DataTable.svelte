<!--
  DataTable: typed table with a caption, keyed rows, sortable headers
  (aria-sort), a labelled action column, keyboard-operable row drill-down
  (disclosure button with aria-expanded; Escape on it or inside the open
  detail collapses the row and refocuses the button), loading / empty /
  error states, and
  a pagination footer. The scroll wrapper is a focusable, named region.

  Sorting: client-side by default (column.sortValue ?? column.value ?? row[key]);
  set `manualSort` when the server orders rows and react in `onsort`.
  Pagination: server-driven with `onpage` (+ `total`, `offset`, `limit`), or
  client-side with `pageSize` alone.
  Row click (`onrowclick`, or row expansion) is a mouse convenience: the
  keyboard path is the disclosure button or an action/link inside the row.
  Selection (optional, set `onselectionchange`): a leading checkbox column;
  the header checkbox selects every row of `rows` (all client pages, i.e. the
  whole filtered set) and shows a mixed state when only some are selected.
-->
<script lang="ts" generics="T">
  import type { Snippet } from 'svelte';
  import EmptyState from './EmptyState.svelte';
  import InlineError from './InlineError.svelte';
  import Pagination from './Pagination.svelte';
  import Spinner from './Spinner.svelte';
  import Icon from 'svelte-awesome/components/Icon.svelte';
  import sortIcon from 'svelte-awesome/icons/sort';
  import sortUpIcon from 'svelte-awesome/icons/sortUp';
  import sortDownIcon from 'svelte-awesome/icons/sortDown';
  import chevronRight from 'svelte-awesome/icons/chevronRight';
  import { ariaSort, nextSort, sortRows, type SortState } from './table-sort';
  import { DEFAULT_PAGE_SIZE, slicePage } from './pagination';
  import type { DataTableColumn } from './types';
  import { collapsesOnEscape } from './disclosure';

  interface Props {
    rows: readonly T[];
    columns: DataTableColumn<T>[];
    /** Stable identity of a row (used for keyed rendering and expansion). */
    rowKey: (row: T) => string | number;
    /** Table caption; also names the scroll region. */
    caption: string;
    /** Show the caption above the table (default: visually hidden). */
    captionVisible?: boolean;
    /** Accessible name of the scroll region (default: caption). */
    label?: string;
    /** Custom cell rendering; receives the row, the column and the row index. */
    cell?: Snippet<[T, DataTableColumn<T>, number]>;
    /** Per-row actions, rendered in a labelled last column. */
    actions?: Snippet<[T, number]>;
    actionsLabel?: string;
    /** Show the action column header text (default: visually hidden). */
    actionsLabelVisible?: boolean;
    /** Current sort (bindable). */
    sort?: SortState | null;
    onsort?: (sort: SortState) => void;
    /** Rows are already ordered by the server; do not sort locally. */
    manualSort?: boolean;
    /** Server pagination: called with the new offset. */
    onpage?: (offset: number) => void;
    total?: number | null;
    offset?: number;
    limit?: number;
    hasMore?: boolean;
    pageSizes?: number[];
    onlimitchange?: (limit: number) => void;
    /** Client pagination page size (used when `onpage` is not set). */
    pageSize?: number;
    /** Noun for the pagination range, e.g. "events". */
    itemLabel?: string;
    loading?: boolean;
    loadingLabel?: string;
    error?: string | null;
    onretry?: () => void;
    emptyTitle?: string;
    emptyMessage?: string;
    empty?: Snippet;
    loadingState?: Snippet;
    errorState?: Snippet<[string]>;
    /** Detail content for an expanded row; adds a disclosure column. */
    expanded?: Snippet<[T]>;
    /** Keys of expanded rows (bindable). */
    expandedKeys?: Array<string | number>;
    /** Accessible name of a row's disclosure button, e.g. `Details for ${row.name}`. */
    expandLabel?: (row: T) => string;
    /** Click on a row toggles its expansion (default true). */
    expandOnRowClick?: boolean;
    onrowclick?: (row: T, index: number) => void;
    rowClass?: (row: T) => string | undefined;
    density?: 'normal' | 'compact';
    stickyHeader?: boolean;
    /** Scroll vertically inside the table (e.g. '480px') so the sticky header applies. */
    maxHeight?: string;
    /** Content on the left of the footer (e.g. "Updated 21:49"). */
    footer?: Snippet;
    class?: string;
    /** Selected row keys (controlled; used with `onselectionchange`). */
    selectedKeys?: Array<string | number>;
    /** Enables the selection column; called with the next selected keys. */
    onselectionchange?: (keys: Array<string | number>) => void;
    /** Accessible name of a row's checkbox, e.g. `Select ${row.name}`. */
    selectionLabel?: (row: T) => string;
  }

  let {
    rows,
    columns,
    rowKey,
    caption,
    captionVisible = false,
    label = undefined,
    cell = undefined,
    actions = undefined,
    actionsLabel = 'Actions',
    actionsLabelVisible = false,
    sort = $bindable(null),
    onsort = undefined,
    manualSort = false,
    onpage = undefined,
    total = undefined,
    offset = $bindable(0),
    limit = DEFAULT_PAGE_SIZE,
    hasMore = false,
    pageSizes = undefined,
    onlimitchange = undefined,
    pageSize = undefined,
    itemLabel = undefined,
    loading = false,
    loadingLabel = 'Loading…',
    error = undefined,
    onretry = undefined,
    emptyTitle = 'No results',
    emptyMessage = undefined,
    empty = undefined,
    loadingState = undefined,
    errorState = undefined,
    expanded = undefined,
    expandedKeys = $bindable([]),
    expandLabel = undefined,
    expandOnRowClick = true,
    onrowclick = undefined,
    rowClass = undefined,
    density = 'normal',
    stickyHeader = true,
    maxHeight = undefined,
    footer = undefined,
    class: className = undefined,
    selectedKeys = [],
    onselectionchange = undefined,
    selectionLabel = undefined
  }: Props = $props();

  // ── Selection ──────────────────────────────────────────────────────────
  const selectable = $derived(Boolean(onselectionchange));
  const selectedSet = $derived(new Set(selectedKeys));
  const allRowKeys = $derived(selectable ? rows.map((row) => rowKey(row)) : []);
  const selectedInRows = $derived(allRowKeys.filter((key) => selectedSet.has(key)).length);
  const allSelected = $derived(allRowKeys.length > 0 && selectedInRows === allRowKeys.length);
  const someSelected = $derived(selectedInRows > 0 && !allSelected);
  let headerBox = $state<HTMLInputElement>();
  $effect(() => {
    if (headerBox) headerBox.indeterminate = someSelected;
  });

  function toggleAllRows() {
    if (allSelected) {
      const drop = new Set(allRowKeys);
      onselectionchange?.(selectedKeys.filter((key) => !drop.has(key)));
    } else {
      const next = [...selectedKeys];
      for (const key of allRowKeys) if (!selectedSet.has(key)) next.push(key);
      onselectionchange?.(next);
    }
  }

  function toggleRowSelected(row: T) {
    const key = rowKey(row);
    onselectionchange?.(selectedSet.has(key) ? selectedKeys.filter((k) => k !== key) : [...selectedKeys, key]);
  }

  const uid = $props.id();

  function rawValue(row: T, column: DataTableColumn<T>): unknown {
    if (column.value) return column.value(row);
    return (row as unknown as Record<string, unknown>)[column.key];
  }

  function display(value: unknown): string {
    if (value === null || value === undefined || value === '') return 'n/a';
    if (value instanceof Date) return value.toISOString();
    return String(value);
  }

  const sorted = $derived.by(() => {
    const column = !manualSort && sort ? columns.find((col) => col.key === sort?.key) : undefined;
    if (!column) return rows.slice();
    const valueOf = column.sortValue ?? ((row: T) => rawValue(row, column));
    return sortRows(rows, sort, (row) => valueOf(row));
  });
  const clientPaging = $derived(!onpage && typeof pageSize === 'number' && pageSize > 0);
  const visibleRows = $derived(clientPaging ? slicePage(sorted, offset, pageSize as number) : sorted);
  const columnCount = $derived(columns.length + (expanded ? 1 : 0) + (actions ? 1 : 0) + (selectable ? 1 : 0));
  const showPagination = $derived(Boolean(onpage) || (clientPaging && sorted.length > (pageSize as number)));
  const regionLabel = $derived(label ?? caption);

  function toggleSort(column: DataTableColumn<T>) {
    const next = nextSort(sort, column.key, column.firstSortDir ?? 'asc');
    sort = next;
    if (clientPaging) offset = 0;
    onsort?.(next);
  }

  function isExpanded(row: T): boolean {
    return expandedKeys.includes(rowKey(row));
  }

  function toggleExpanded(row: T) {
    const key = rowKey(row);
    expandedKeys = expandedKeys.includes(key) ? expandedKeys.filter((k) => k !== key) : [...expandedKeys, key];
  }

  function toggleId(row: T): string {
    return `${detailId(row)}-toggle`;
  }

  /**
   * Escape on an expanded row's toggle or inside its detail collapses it and
   * returns focus to the toggle. A control that already consumed
   * Escape (preventDefault, an open select, an inner dialog) keeps it, and
   * a collapsed row lets Escape through to an enclosing Modal/Drawer.
   */
  function onDisclosureKeydown(event: KeyboardEvent, row: T) {
    if (!collapsesOnEscape(event, isExpanded(row))) return;
    event.preventDefault();
    event.stopPropagation();
    document.getElementById(toggleId(row))?.focus();
    const key = rowKey(row);
    expandedKeys = expandedKeys.filter((k) => k !== key);
  }

  const INTERACTIVE = 'a, button, input, select, textarea, label, summary, [role="button"], [role="link"], [contenteditable="true"]';

  function onRowClick(event: MouseEvent, row: T, index: number) {
    const target = event.target as Element | null;
    if (target?.closest(INTERACTIVE)) return;
    if (typeof window !== 'undefined' && window.getSelection()?.toString()) return;
    if (onrowclick) onrowclick(row, index);
    else if (expanded && expandOnRowClick) toggleExpanded(row);
  }

  function changePage(next: number) {
    if (onpage) onpage(next);
    else offset = next;
  }

  function detailId(row: T): string {
    return `${uid}-detail-${String(rowKey(row)).replace(/[^A-Za-z0-9_-]/g, '_')}`;
  }
</script>

<div class={['ui-dt', `density-${density}`, className]}>
  {#if error && rows.length > 0}
    <div class="ui-dt-stale">
      <InlineError message={error} {onretry} />
    </div>
  {/if}

  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div class="ui-dt-scroll" role="region" aria-label={regionLabel} tabindex="0" style:max-height={maxHeight}>
    <table class="ui-dt-table" class:sticky={stickyHeader} aria-busy={loading || undefined}>
      <caption class={captionVisible ? 'ui-dt-caption' : 'sr-only'}>{caption}</caption>
      <thead>
        <tr>
          {#if selectable}
            <th scope="col" class="ui-dt-select-col">
              <input
                bind:this={headerBox}
                type="checkbox"
                class="ui-dt-check"
                checked={allSelected}
                disabled={allRowKeys.length === 0}
                aria-label={`Select all ${allRowKeys.length} ${itemLabel ?? 'rows'}`}
                onchange={toggleAllRows}
              />
            </th>
          {/if}
          {#if expanded}<th scope="col" class="ui-dt-toggle-col"><span class="sr-only">Details</span></th>{/if}
          {#each columns as column (column.key)}
            <th
              scope="col"
              class={[column.class, column.align && `align-${column.align}`]}
              style:width={column.width}
              aria-sort={column.sortable ? ariaSort(sort, column.key) : undefined}
            >
              {#if column.sortable}
                {@const state = ariaSort(sort, column.key)}
                <button type="button" class="ui-dt-sort" onclick={() => toggleSort(column)}>
                  <span class={column.hideLabel ? 'sr-only' : undefined}>{column.label}</span>
                  <span class="ui-dt-sort-icon" class:active={state !== 'none'} aria-hidden="true">
                    <Icon data={state === 'ascending' ? sortUpIcon : state === 'descending' ? sortDownIcon : sortIcon} scale={0.7} />
                  </span>
                </button>
              {:else if column.hideLabel}
                <span class="sr-only">{column.label}</span>
              {:else}
                {column.label}
              {/if}
            </th>
          {/each}
          {#if actions}
            <th scope="col" class="ui-dt-actions-col align-right">
              <span class={actionsLabelVisible ? undefined : 'sr-only'}>{actionsLabel}</span>
            </th>
          {/if}
        </tr>
      </thead>
      <tbody>
        {#if rows.length === 0}
          <tr class="ui-dt-state">
            <td colspan={columnCount}>
              {#if loading}
                {#if loadingState}{@render loadingState()}{:else}<Spinner layout="block" tone="accent" label={loadingLabel} />{/if}
              {:else if error}
                {#if errorState}{@render errorState(error)}{:else}<div class="ui-dt-error"><InlineError message={error} {onretry} /></div>{/if}
              {:else if empty}
                {@render empty()}
              {:else}
                <EmptyState title={emptyTitle} message={emptyMessage} level={4} compact />
              {/if}
            </td>
          </tr>
        {:else}
          {#each visibleRows as row, index (rowKey(row))}
            {@const open = expanded ? isExpanded(row) : false}
            {@const clickable = Boolean(onrowclick) || Boolean(expanded && expandOnRowClick)}
            <!-- Row click is a mouse shortcut; the keyboard path is the disclosure button or a control in the row. -->
            <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
            <tr
              class={['ui-dt-row', clickable && 'is-clickable', open && 'is-expanded', selectable && selectedSet.has(rowKey(row)) && 'is-selected', rowClass?.(row)]}
              onclick={clickable ? (event) => onRowClick(event, row, index) : undefined}
            >
              {#if selectable}
                <td class="ui-dt-select-col">
                  <input
                    type="checkbox"
                    class="ui-dt-check"
                    checked={selectedSet.has(rowKey(row))}
                    aria-label={selectionLabel ? selectionLabel(row) : `Select row ${index + 1}`}
                    onchange={() => toggleRowSelected(row)}
                  />
                </td>
              {/if}
              {#if expanded}
                <td class="ui-dt-toggle-col">
                  <button
                    type="button"
                    id={toggleId(row)}
                    class="ui-dt-toggle"
                    aria-expanded={open}
                    aria-controls={open ? detailId(row) : undefined}
                    aria-label={expandLabel ? expandLabel(row) : `Row ${index + 1} details`}
                    onclick={() => toggleExpanded(row)}
                    onkeydown={(event) => onDisclosureKeydown(event, row)}
                  >
                    <span class="ui-dt-chevron" class:open aria-hidden="true"><Icon data={chevronRight} scale={0.7} /></span>
                  </button>
                </td>
              {/if}
              {#each columns as column (column.key)}
                {#if column.rowHeader}
                  <th scope="row" class={[column.class, column.align && `align-${column.align}`, column.nowrap && 'nowrap']}>
                    {#if cell}{@render cell(row, column, index)}{:else}{display(rawValue(row, column))}{/if}
                  </th>
                {:else}
                  <td class={[column.class, column.align && `align-${column.align}`, column.nowrap && 'nowrap']}>
                    {#if cell}{@render cell(row, column, index)}{:else}{display(rawValue(row, column))}{/if}
                  </td>
                {/if}
              {/each}
              {#if actions}
                <td class="ui-dt-actions align-right">
                  <div class="ui-dt-actions-inner">{@render actions(row, index)}</div>
                </td>
              {/if}
            </tr>
            {#if expanded && open}
              <!-- Escape bubbling from a control inside the detail collapses it. -->
              <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
              <tr class="ui-dt-detail" id={detailId(row)} onkeydown={(event) => onDisclosureKeydown(event, row)}>
                <td colspan={columnCount}>{@render expanded(row)}</td>
              </tr>
            {/if}
          {/each}
        {/if}
      </tbody>
    </table>
  </div>

  {#if showPagination || footer || (loading && rows.length > 0)}
    <div class="ui-dt-footer">
      <div class="ui-dt-footer-start">
        {#if loading && rows.length > 0}<Spinner size="sm" tone="accent" label={loadingLabel} />{/if}
        {@render footer?.()}
      </div>
      {#if showPagination}
        <Pagination
          {offset}
          limit={onpage ? limit : (pageSize as number)}
          total={onpage ? total : sorted.length}
          count={onpage ? rows.length : visibleRows.length}
          {hasMore}
          pageSizes={onpage ? pageSizes : undefined}
          onlimitchange={onpage ? onlimitchange : undefined}
          onchange={changePage}
          label={`${caption} pages`}
          {itemLabel}
          disabled={loading}
        />
      {/if}
    </div>
  {/if}
</div>

<style>
  .ui-dt { min-width: 0; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-card); overflow: hidden; }
  .ui-dt-stale { padding: var(--sp-2) var(--sp-4); border-bottom: 1px solid var(--border); }
  .ui-dt-scroll { position: relative; min-width: 0; max-width: 100%; overflow-x: auto; overscroll-behavior-x: contain; }
  .ui-dt-scroll:focus-visible { outline: var(--ring-width) solid var(--ring-color); outline-offset: -2px; }
  .ui-dt-table { width: 100%; border-collapse: collapse; font-size: var(--fs-base); font-variant-numeric: tabular-nums; }
  .ui-dt-caption { caption-side: top; text-align: left; padding: var(--sp-3) var(--sp-4); font-weight: var(--fw-semibold); color: var(--text-primary); }

  .ui-dt-table th,
  .ui-dt-table td { text-align: left; padding: var(--sp-3) var(--sp-4); vertical-align: top; }
  /* Row cells centre their content: a row mixing text with a select or a
     button stays on one line. The detail and state rows keep top alignment. */
  .ui-dt-row > td,
  .ui-dt-row > th { vertical-align: middle; }
  .density-compact .ui-dt-table th,
  .density-compact .ui-dt-table td { padding: var(--sp-2) var(--sp-3); }

  .ui-dt-table thead th {
    background: var(--bg-secondary);
    color: var(--text-muted);
    font-size: var(--fs-sm);
    font-weight: var(--fw-medium);
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
    vertical-align: bottom;
  }
  .ui-dt-table.sticky thead th { position: sticky; top: 0; z-index: 1; }
  .ui-dt-table tbody tr + tr { border-top: 1px solid var(--border); }
  .ui-dt-row:hover { background: var(--bg-hover); }
  .ui-dt-row.is-clickable { cursor: pointer; }
  .ui-dt-row.is-expanded { background: var(--surface-1); }
  .ui-dt-table tbody th { font-weight: var(--fw-medium); color: var(--text-primary); }

  .align-right { text-align: right !important; }
  .align-center { text-align: center !important; }
  .nowrap { white-space: nowrap; }

  .ui-dt-sort {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-1);
    min-height: 24px;
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    letter-spacing: inherit;
    text-transform: inherit;
    cursor: pointer;
  }
  .ui-dt-sort:hover { color: var(--text-primary); }
  .ui-dt-sort:focus-visible { outline: var(--ring-width) solid var(--ring-color); outline-offset: 2px; border-radius: 2px; }
  .ui-dt-sort-icon { display: inline-flex; opacity: 0.55; }
  .ui-dt-sort-icon.active { opacity: 1; color: var(--text-primary); }
  .align-right .ui-dt-sort { flex-direction: row-reverse; }

  .ui-dt-toggle-col { width: 1%; padding-right: 0 !important; }
  .ui-dt-select-col { width: 1%; padding-right: 0 !important; }
  .ui-dt-check { width: 16px; height: 16px; margin: 2px 0 0; accent-color: var(--accent); cursor: pointer; }
  .ui-dt-check:focus-visible { outline: var(--ring-width) solid var(--ring-color); outline-offset: 2px; }
  .ui-dt-row.is-selected { background: var(--accent-soft); }
  .ui-dt-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: 0;
    border-radius: var(--radius);
    background: none;
    color: var(--text-muted);
    cursor: pointer;
  }
  .ui-dt-toggle:hover { color: var(--text-primary); background: var(--bg-hover); }
  .ui-dt-toggle:focus-visible { outline: var(--ring-width) solid var(--ring-color); outline-offset: 1px; }
  .ui-dt-chevron { display: inline-flex; transition: transform 0.15s; }
  .ui-dt-chevron.open { transform: rotate(90deg); }

  .ui-dt-actions-col { width: 1%; }
  .ui-dt-actions { white-space: nowrap; }
  .ui-dt-actions-inner { display: inline-flex; gap: var(--sp-2); align-items: center; justify-content: flex-end; }

  .ui-dt-detail > td { background: var(--surface-1); padding-top: 0; }
  .ui-dt-state > td { padding: 0 !important; }
  .ui-dt-state:hover { background: none; }
  .ui-dt-error { padding: var(--sp-5) var(--sp-4); }

  .ui-dt-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: var(--sp-2);
    border-top: 1px solid var(--border);
    min-width: 0;
  }
  .ui-dt-footer-start { display: flex; align-items: center; gap: var(--sp-3); padding: var(--sp-2) var(--sp-4); font-size: var(--fs-sm); color: var(--text-muted); min-width: 0; }
  .ui-dt-footer-start:empty { display: none; }
  .ui-dt-footer :global(.ui-pagination) { margin-left: auto; }
</style>
