<!--
  GeoPolicyPanel: the host's geo policy mode at the top of the Access rules
  tab: "Block these countries" (the geo rows are dropped) or "Only allow these
  countries" (every country not listed is dropped). Picking the other mode
  shows what the switch applies; the page confirms a switch to allow mode
  before sending it. The country lists themselves are edited in the table
  (remove) and the Add rules drawer (add).
-->
<script lang="ts">
  import './controls.css';
  import Button from '#lib/components/ui/Button.svelte';
  import GeoBlockManager from './GeoBlockManager.svelte';
  import { parseCountryCodes } from './rules';
  import { GEO_ALLOW_UNSUPPORTED_HINT, GEO_MODE_LABEL, allowListAfter, type GeoMode } from './geo-policy';

  let {
    mode,
    allowed = [],
    blockedCount = 0,
    allowSupported = false,
    canConfigure = false,
    busy = false,
    onswitch,
  }: {
    /** Mode saved on the host. */
    mode: GeoMode;
    /** Allowed countries (kept while in block mode). */
    allowed?: readonly string[];
    blockedCount?: number;
    allowSupported?: boolean;
    canConfigure?: boolean;
    busy?: boolean;
    /** Switches the mode, adding `codes` to the allowed countries on a switch to allow. */
    onswitch: (next: GeoMode, codes: string[]) => void;
  } = $props();

  const uid = $props.id();
  // Selection follows the saved mode until the operator picks the other one.
  let selected = $derived<GeoMode>(mode);
  let addText = $state('');
  const parsed = $derived(parseCountryCodes(addText));
  const resulting = $derived(allowListAfter(allowed, parsed.valid));
  const switching = $derived(selected !== mode);
  const switchProblem = $derived.by(() => {
    if (!switching || selected !== 'allow') return null;
    if (parsed.invalid.length) return 'Fix or remove the codes that are not countries.';
    if (!resulting.length) return 'Add at least one country to allow; allow mode with an empty list is refused (GEO_ALLOW_EMPTY).';
    return null;
  });

  function cancel() {
    selected = mode;
    addText = '';
  }

  function apply() {
    if (!switching || switchProblem || busy) return;
    onswitch(selected, selected === 'allow' ? parsed.valid : []);
  }

  // A saved switch resets the form.
  $effect(() => {
    void mode;
    addText = '';
  });
</script>

<section class="fw-panel geo-policy" aria-labelledby={`${uid}-title`}>
  <div class="fw-panel-head">
    <h2 id={`${uid}-title`}>Geo policy</h2>
    <p class="fw-panel-sub">
      {#if mode === 'allow'}Only the {allowed.length} allowed {allowed.length === 1 ? 'country' : 'countries'} below can open new inbound connections.
      {:else}{blockedCount} {blockedCount === 1 ? 'country is' : 'countries are'} blocked; every other country is allowed.{/if}
    </p>
  </div>

  <fieldset class="geo-mode" disabled={!canConfigure || busy}>
    <legend class="sr-only">Geo policy mode</legend>
    <div class="fw-segmented">
      <label><input type="radio" name={`${uid}-mode`} value="block" bind:group={selected} />{GEO_MODE_LABEL.block}</label>
      <label><input type="radio" name={`${uid}-mode`} value="allow" bind:group={selected} disabled={!allowSupported && mode !== 'allow'} aria-describedby={!allowSupported ? `${uid}-unsupported` : undefined} />{GEO_MODE_LABEL.allow}</label>
    </div>
    {#if !allowSupported && mode !== 'allow'}
      <p id={`${uid}-unsupported`} class="fw-panel-sub">{GEO_ALLOW_UNSUPPORTED_HINT}</p>
    {/if}
  </fieldset>

  {#if switching && canConfigure}
    <div class="geo-switch">
      {#if selected === 'allow'}
        <p class="geo-switch-lead">
          Switching to allow mode drops new inbound connections from every country not listed and turns geo filtering on.
          {#if allowed.length}Kept allowed countries: <strong>{allowed.join(', ')}</strong>.{/if}
        </p>
        <GeoBlockManager bind:text={addText} mode="allow" blocked={allowed} disabled={busy} />
      {:else}
        <p class="geo-switch-lead">Switching to block mode drops only the {blockedCount} blocked {blockedCount === 1 ? 'country' : 'countries'}; the allowed countries are kept for later.</p>
      {/if}
      <div class="fw-row geo-switch-actions">
        {#if switchProblem}<span class="fw-muted geo-problem">{switchProblem}</span>{/if}
        <Button variant="ghost" size="sm" onclick={cancel} disabled={busy}>Cancel</Button>
        <Button variant="primary" size="sm" loading={busy} disabled={Boolean(switchProblem)} onclick={apply}>
          {selected === 'allow' ? 'Switch to allow mode…' : 'Switch to block mode'}
        </Button>
      </div>
    </div>
  {/if}
</section>

<style>
  .geo-policy { display: grid; gap: var(--sp-3); }
  .geo-policy .fw-panel-head { margin-bottom: 0; }
  .geo-mode { display: grid; gap: var(--sp-2); border: 0; margin: 0; padding: 0; min-width: 0; }
  .geo-switch { display: grid; gap: var(--sp-3); padding-top: var(--sp-3); border-top: 1px solid var(--border); }
  .geo-switch-lead { margin: 0; font-size: var(--fs-sm); color: var(--text-secondary); line-height: 1.5; }
  .geo-switch-lead strong { color: var(--text-primary); font-family: var(--font-mono); font-weight: var(--fw-medium); }
  .geo-switch-actions { justify-content: flex-end; }
  .geo-problem { margin-right: auto; font-size: var(--fs-xs); }
</style>
