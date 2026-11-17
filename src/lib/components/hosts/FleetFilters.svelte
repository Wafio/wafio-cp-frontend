<!--
  FleetFilters: client-side filters of the Hosts fleet table. The parent keeps the state in the URL
  (`#lib/host-fleet.js` readFleetFilters / fleetFilterSearch); the search box
  reports after a short pause so typing does not rewrite the URL per key.
-->
<script lang="ts">
  import Button from '#lib/components/ui/Button.svelte';
  import Select from '#lib/components/ui/Select.svelte';
  import { formatCount } from '#lib/format.js';
  import {
    EMPTY_FLEET_FILTERS,
    FIREWALL_STATES,
    FIREWALL_STATE_TEXT,
    HOST_STATUSES,
    RUNTIME_STATES,
    RUNTIME_STATE_TEXT,
    hasActiveFilters,
    labelParam,
    parseLabelParam,
    type FleetFilterState,
    type LabelFacet,
  } from '#lib/host-fleet.js';
  import { HOST_STATUS } from '#lib/host-nav.js';

  let {
    filters,
    facets = [],
    shown,
    total,
    onchange,
  }: {
    filters: FleetFilterState;
    facets?: readonly LabelFacet[];
    /** Rows matching the filters. */
    shown: number;
    total: number;
    onchange: (next: FleetFilterState) => void;
  } = $props();

  const uid = $props.id();

  let q = $state('');
  let lastSent = '';
  $effect.pre(() => {
    // Follow URL changes (back/forward, Clear) without fighting the typist.
    if (filters.q !== lastSent) {
      q = filters.q;
      lastSent = filters.q;
    }
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => () => clearTimeout(timer));

  function onSearch(value: string) {
    q = value;
    clearTimeout(timer);
    timer = setTimeout(() => {
      lastSent = value;
      onchange({ ...filters, q: value });
    }, 250);
  }

  function set<K extends keyof FleetFilterState>(key: K, value: FleetFilterState[K]) {
    onchange({ ...filters, q, [key]: value });
  }

  const ANY = { value: '', label: 'Any' } as const;
  const statusOptions: { value: FleetFilterState['status']; label: string }[] = [ANY, ...HOST_STATUSES.map((s) => ({ value: s, label: HOST_STATUS[s]?.label ?? s }))];
  const firewallOptions: { value: FleetFilterState['fw']; label: string }[] = [ANY, ...FIREWALL_STATES.map((s) => ({ value: s, label: FIREWALL_STATE_TEXT[s] }))];
  const runtimeOptions: { value: FleetFilterState['rt']; label: string }[] = [ANY, ...RUNTIME_STATES.map((s) => ({ value: s, label: RUNTIME_STATE_TEXT[s] }))];

  const labelValue = $derived(filters.label ? labelParam(filters.label) : '');
  // A label from the URL that no host carries any more stays selectable.
  const labelOptions = $derived(
    filters.label && !facets.some((f) => f.key === filters.label?.key && f.value === filters.label?.value)
      ? [{ ...filters.label, count: 0 }, ...facets]
      : facets,
  );
  const labelChoices = $derived([ANY, ...labelOptions.map((f) => ({ value: labelParam(f), label: `${f.key}=${f.value} (${f.count})` }))]);
</script>

<div class="ff" role="search" aria-label="Filter hosts">
  <div class="ff-field ff-search">
    <label for={`${uid}-q`}>Find host</label>
    <input id={`${uid}-q`} type="search" value={q} oninput={(e) => onSearch(e.currentTarget.value)} placeholder="Name, OS, kernel or env=prod" autocomplete="off" />
  </div>
  <div class="ff-field">
    <label for={`${uid}-status`}>Status</label>
    <Select id={`${uid}-status`} class="ff-select" options={statusOptions} value={filters.status} onchange={(status) => set('status', status)} />
  </div>
  <div class="ff-field">
    <label for={`${uid}-fw`}>Firewall</label>
    <Select id={`${uid}-fw`} class="ff-select" options={firewallOptions} value={filters.fw} onchange={(fw) => set('fw', fw)} />
  </div>
  <div class="ff-field">
    <label for={`${uid}-rt`}>Runtime</label>
    <Select id={`${uid}-rt`} class="ff-select" options={runtimeOptions} value={filters.rt} onchange={(rt) => set('rt', rt)} />
  </div>
  <div class="ff-field">
    <label for={`${uid}-label`}>Label</label>
    <Select id={`${uid}-label`} class="ff-select" options={labelChoices} value={labelValue} onchange={(label) => set('label', parseLabelParam(label))} disabled={!labelOptions.length} />
  </div>
  <label class="ff-check">
    <input type="checkbox" checked={filters.attention} onchange={(e) => set('attention', e.currentTarget.checked)} />
    Needs attention only
  </label>
  {#if hasActiveFilters(filters)}
    <Button variant="ghost" size="sm" onclick={() => { q = ''; lastSent = ''; onchange({ ...EMPTY_FLEET_FILTERS }); }}>Clear filters</Button>
  {/if}
  <p class="ff-count" aria-live="polite">{shown === total ? formatCount(total, 'host') : `${shown} of ${formatCount(total, 'host')}`}</p>
</div>

<style>
  .ff { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--sp-3); min-width: 0; }
  .ff-field { display: grid; gap: var(--sp-1); font-size: var(--fs-xs); color: var(--text-secondary); min-width: 8rem; }
  .ff-search { flex: 1 1 14rem; max-width: 22rem; }
  .ff-field :global(.ff-select) { min-width: 8rem; max-width: 16rem; }
  .ff-field input {
    box-sizing: border-box;
    width: 100%;
    min-height: 36px;
    padding: var(--sp-2) var(--sp-3);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    background: var(--surface-input);
    color: var(--text-primary);
    font: inherit;
    font-size: var(--fs-sm);
  }
  .ff-field input:focus-visible, .ff-check input:focus-visible { outline: var(--ring-width) solid var(--ring-color); outline-offset: 1px; }
  .ff-check { display: inline-flex; align-items: center; gap: var(--sp-2); min-height: 36px; font-size: var(--fs-sm); color: var(--text-secondary); cursor: pointer; }
  .ff-check input { accent-color: var(--accent); }
  .ff-count { margin: 0 0 0 auto; align-self: center; font-size: var(--fs-xs); color: var(--text-muted); }
</style>
