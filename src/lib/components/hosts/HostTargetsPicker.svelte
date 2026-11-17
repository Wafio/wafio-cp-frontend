<!--
  HostTargetsPicker: chooses the hosts an apply writes to: either hosts picked by search and
  checkbox, or every non-revoked host carrying one label `key=value`
  (resolved by the server once, at request time). Each host shows what will
  happen to it: skipped without a host agent, stored for later while its
  agent is offline, refused for a port-scoped allowlist entry without
  `allowlist_ports`.
-->
<script lang="ts">
  import Badge from '#lib/components/ui/Badge.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Select from '#lib/components/ui/Select.svelte';
  import type { FleetHost } from '#lib/api.js';
  import { filterHosts, sortHosts } from '#lib/host-nav.js';
  import { hostsWithLabel, labelFacets, labelParam, parseLabelParam, targetHints, toggleAllIds, toggleId } from '#lib/host-fleet.js';

  let {
    hosts,
    mode = $bindable('hosts'),
    selected = $bindable([]),
    label = $bindable(null),
    excludeIds = [],
    needsAgent = true,
    scopedAllowlist = false,
    disabled = false,
  }: {
    hosts: readonly FleetHost[];
    mode?: 'hosts' | 'label';
    selected?: string[];
    label?: { key: string; value: string } | null;
    /** Hosts that cannot be targets (the source host, the current host). */
    excludeIds?: readonly string[];
    /** The op needs a host agent (false for detection rules). */
    needsAgent?: boolean;
    /** The rule holds a port-scoped allowlist entry. */
    scopedAllowlist?: boolean;
    disabled?: boolean;
  } = $props();

  const uid = $props.id();
  let query = $state('');

  const candidates = $derived(sortHosts(hosts.filter((h) => h.status !== 'revoked' && !excludeIds.includes(h.id))));
  const shown = $derived(filterHosts(candidates, query));
  const shownIds = $derived(shown.map((h) => h.id));
  const facets = $derived(labelFacets(candidates));
  const labelChoices = $derived([{ value: '', label: 'Choose a label' }, ...facets.map((f) => ({ value: labelParam(f), label: `${f.key}=${f.value} (${f.count})` }))]);
  const labelMatches = $derived(label ? hostsWithLabel(candidates, label) : []);
  const hintOpts = $derived({ needsAgent, scopedAllowlist });
  const labelHintCounts = $derived.by(() => {
    const out = new Map<string, number>();
    for (const host of labelMatches) for (const hint of targetHints(host, hintOpts)) out.set(hint.text, (out.get(hint.text) ?? 0) + 1);
    return [...out.entries()];
  });
  const allShownSelected = $derived(shownIds.length > 0 && shownIds.every((id) => selected.includes(id)));
</script>

<div class="tp">
  <fieldset class="tp-mode" {disabled}>
    <legend class="tp-legend">Target hosts</legend>
    <label><input type="radio" name={`${uid}-mode`} value="hosts" bind:group={mode} /> Pick hosts</label>
    <label><input type="radio" name={`${uid}-mode`} value="label" bind:group={mode} /> Hosts with a label</label>
  </fieldset>

  {#if mode === 'hosts'}
    <div class="tp-bar">
      <div class="tp-field">
        <label for={`${uid}-q`}>Find host</label>
        <input id={`${uid}-q`} type="search" bind:value={query} placeholder="Name, OS or env=prod" autocomplete="off" {disabled} />
      </div>
      <Button variant="ghost" size="sm" disabled={disabled || !shownIds.length} onclick={() => (selected = toggleAllIds(selected, shownIds))}>
        {allShownSelected ? `Unselect ${shownIds.length} shown` : `Select ${shownIds.length} shown`}
      </Button>
      <p class="tp-count" aria-live="polite">{selected.length} selected</p>
    </div>
    {#if !candidates.length}
      <p class="tp-empty">No other hosts in this project.</p>
    {:else if !shown.length}
      <p class="tp-empty">No host matches “{query}”.</p>
    {:else}
      <ul class="tp-list" aria-label="Hosts">
        {#each shown as host (host.id)}
          {@const hints = targetHints(host, hintOpts)}
          <li>
            <label class="tp-host">
              <input type="checkbox" checked={selected.includes(host.id)} onchange={() => (selected = toggleId(selected, host.id))} {disabled} />
              <span class="tp-name">{host.name}</span>
              {#each Object.entries(host.labels ?? {}).slice(0, 3) as [k, v] (k)}<span class="tp-label">{k}={v}</span>{/each}
              {#each hints as hint (hint.text)}<Badge tone={hint.tone}>{hint.text}</Badge>{/each}
            </label>
          </li>
        {/each}
      </ul>
    {/if}
  {:else}
    <div class="tp-field tp-label-field">
      <label for={`${uid}-label`}>Label</label>
      <Select id={`${uid}-label`} options={labelChoices} value={label ? labelParam(label) : ''} onchange={(next) => (label = parseLabelParam(next))} disabled={disabled || !facets.length} />
    </div>
    {#if !facets.length}
      <p class="tp-empty">No host carries a label yet. Edit labels on the Hosts page first.</p>
    {:else if label}
      <p class="tp-note" aria-live="polite">
        Matches {labelMatches.length} {labelMatches.length === 1 ? 'host' : 'hosts'} now. The label is resolved again when the request is sent; hosts labelled later do not get the rule.
      </p>
      {#if labelHintCounts.length}
        <ul class="tp-hints">
          {#each labelHintCounts as [text, n] (text)}<li>{n} × {text}</li>{/each}
        </ul>
      {/if}
    {/if}
  {/if}
</div>

<style>
  .tp { display: grid; gap: var(--sp-3); min-width: 0; }
  .tp-mode { display: flex; flex-wrap: wrap; gap: var(--sp-4); margin: 0; padding: 0; border: 0; font-size: var(--fs-sm); color: var(--text-secondary); }
  .tp-mode label { display: inline-flex; align-items: center; gap: var(--sp-2); cursor: pointer; }
  .tp-legend { width: 100%; padding: 0; margin-bottom: var(--sp-1); font-size: var(--fs-xs); font-weight: var(--fw-medium); color: var(--text-secondary); }
  .tp-bar { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--sp-3); }
  .tp-field { display: grid; gap: var(--sp-1); font-size: var(--fs-xs); color: var(--text-secondary); flex: 1 1 14rem; max-width: 22rem; }
  .tp-label-field { max-width: 26rem; }
  .tp-field input {
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
  .tp-field input:focus-visible { outline: var(--ring-width) solid var(--ring-color); outline-offset: 1px; }
  .tp-count { margin: 0 0 0 auto; align-self: center; font-size: var(--fs-xs); color: var(--text-muted); }
  .tp-list { display: grid; margin: 0; padding: 0; list-style: none; max-height: 18rem; overflow-y: auto; border: 1px solid var(--border); border-radius: var(--radius); }
  .tp-list li + li { border-top: 1px solid var(--border); }
  .tp-host { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); font-size: var(--fs-sm); cursor: pointer; }
  .tp-host:hover { background: var(--bg-hover); }
  .tp-host input { accent-color: var(--accent); }
  .tp-host input:focus-visible { outline: var(--ring-width) solid var(--ring-color); outline-offset: 2px; }
  .tp-name { font-weight: var(--fw-medium); color: var(--text-primary); overflow-wrap: anywhere; }
  .tp-label { padding: 0 var(--sp-1); border: 1px solid var(--border); border-radius: var(--radius); font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--text-muted); }
  .tp-empty, .tp-note { margin: 0; font-size: var(--fs-sm); color: var(--text-muted); }
  .tp-hints { margin: 0; padding-left: var(--sp-5); font-size: var(--fs-xs); color: var(--text-secondary); }
</style>
