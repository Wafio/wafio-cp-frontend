<!--
  GeoBlockManager: countries to block. Type ISO 3166-1 alpha-2
  codes; each is shown with its country name before it is sent, unknown codes
  are listed, and codes already blocked are marked.
-->
<script lang="ts">
  import './controls.css';
  import { parseCountryCodes } from './rules';

  let {
    text = $bindable(''),
    blocked = [],
    mode = 'block',
    geoEnabled = true,
    disabled = false,
  }: {
    text?: string;
    /** Codes already in the active list (blocked, or allowed in allow mode). */
    blocked?: readonly string[];
    /** Geo policy mode: allow mode edits the allowed countries. */
    mode?: 'block' | 'allow';
    /** Geo-blocking switch in Settings. */
    geoEnabled?: boolean;
    disabled?: boolean;
  } = $props();

  const uid = $props.id();
  const parsed = $derived(parseCountryCodes(text));
  const already = $derived(new Set(blocked.map((code) => code.toUpperCase())));
  const regionNames = (() => {
    try { return new Intl.DisplayNames(['en'], { type: 'region' }); } catch { return null; }
  })();
  const nameOf = (code: string) => regionNames?.of(code) ?? code;
  const allowMode = $derived(mode === 'allow');
</script>

<div class="geo">
  <div class="geo-field">
    <label class="geo-label" for={`${uid}-codes`}>Country codes</label>
    <input
      id={`${uid}-codes`}
      class="fw-input geo-input"
      type="text"
      bind:value={text}
      {disabled}
      autocomplete="off"
      spellcheck="false"
      placeholder={allowMode ? 'ID, SG' : 'CN, RU, KP'}
      aria-describedby={`${uid}-hint ${uid}-result`}
      aria-invalid={parsed.invalid.length ? 'true' : undefined}
    />
    <p id={`${uid}-hint`} class="geo-hint">Two-letter ISO 3166-1 codes separated by commas or spaces, for example CN (China), RU (Russia), KP (North Korea).</p>
  </div>

  {#if allowMode}
    <p class="geo-mode-note" role="status">These countries are added to the allowed countries. Adding only widens access; in allow mode every country not listed is dropped.</p>
  {/if}

  {#if !geoEnabled}
    <p class="geo-note" role="status">Geo-blocking is turned off in Settings. Countries you add are stored and start blocking once it is turned on.</p>
  {/if}

  <div id={`${uid}-result`} aria-live="polite">
    {#if parsed.valid.length}
      <ul class="geo-chips" aria-label={allowMode ? 'Countries to allow' : 'Countries to block'}>
        {#each parsed.valid as code (code)}
          <li class="geo-chip">
            <span><strong>{code}</strong> {nameOf(code)}</span>
            {#if already.has(code)}<span class="fw-muted">(already {allowMode ? 'allowed' : 'blocked'})</span>{/if}
          </li>
        {/each}
      </ul>
    {/if}
    {#if parsed.invalid.length}
      <p class="geo-invalid" role="alert">Not a country code: {parsed.invalid.join(', ')}.</p>
    {/if}
  </div>
</div>

<style>
  .geo { display: grid; gap: var(--sp-3); }
  .geo-field { display: grid; gap: var(--sp-1); }
  .geo-label { font-size: var(--fs-xs); font-weight: var(--fw-medium); color: var(--text-secondary); }
  .geo-input { width: 100%; text-transform: uppercase; }
  .geo-hint { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.5; }
  .geo-mode-note { margin: 0; font-size: var(--fs-xs); color: var(--text-secondary); line-height: 1.5; }
  .geo-note { margin: 0; font-size: var(--fs-xs); color: var(--warning); }
  .geo-chips { display: flex; flex-wrap: wrap; gap: var(--sp-2); margin: 0; padding: 0; list-style: none; }
  .geo-chip { display: inline-flex; align-items: center; gap: var(--sp-2); padding: var(--sp-1) var(--sp-2); border: 1px solid var(--border); border-radius: var(--radius); font-size: var(--fs-xs); color: var(--text-secondary); }
  .geo-chip strong { color: var(--text-primary); font-family: var(--font-mono); }
  .geo-invalid { margin: var(--sp-2) 0 0; font-size: var(--fs-xs); color: var(--danger); }
</style>
