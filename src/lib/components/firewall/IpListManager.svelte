<!--
  IpListManager: bulk entry for the block, allow and egress block lists.
  Paste one address, CIDR prefix or IPv4 range per line
  (commas and spaces work too); invalid entries are listed with the reason
  before anything is sent. The parent owns the values and builds the request
  with parseAddressList().
-->
<script lang="ts">
  import './controls.css';
  import TtlPicker from './TtlPicker.svelte';
  import { parseAddressList, type TtlKey, type TtlUnit } from './rules';

  let {
    kind,
    text = $bindable(''),
    ttl = $bindable<TtlKey>('permanent'),
    ttlAmount = $bindable<number | ''>(''),
    ttlUnit = $bindable<TtlUnit>('hours'),
    disabled = false,
  }: {
    kind: 'block' | 'allow' | 'egress';
    text?: string;
    ttl?: TtlKey;
    ttlAmount?: number | '';
    ttlUnit?: TtlUnit;
    disabled?: boolean;
  } = $props();

  const uid = $props.id();
  const parsed = $derived(parseAddressList(text));
  const LABEL = { block: 'Source addresses to block', allow: 'Source addresses to allow', egress: 'Destination addresses to block' } as const;
</script>

<div class="ipm">
  <div class="ipm-field">
    <label class="ipm-label" for={`${uid}-text`}>{LABEL[kind]}</label>
    <textarea
      id={`${uid}-text`}
      class="fw-textarea"
      bind:value={text}
      {disabled}
      rows="6"
      spellcheck="false"
      autocomplete="off"
      placeholder={'203.0.113.7\n198.51.100.0/24\n192.0.2.10-192.0.2.40'}
      aria-describedby={`${uid}-hint ${uid}-result`}
      aria-invalid={parsed.invalid.length ? 'true' : undefined}
    ></textarea>
    <p id={`${uid}-hint`} class="ipm-hint">One per line, or separated by commas or spaces. Accepts an IPv4 or IPv6 address, a CIDR prefix (up to 100,000 addresses, e.g. /16 or /112), or an IPv4 range such as 192.0.2.10-192.0.2.40. Lines starting with # are ignored.</p>
  </div>

  <div id={`${uid}-result`} class="ipm-result" aria-live="polite">
    {#if parsed.valid.length || parsed.invalid.length}
      <p class="ipm-count"><strong>{parsed.valid.length}</strong> {parsed.valid.length === 1 ? 'entry' : 'entries'} ready{#if parsed.invalid.length}, <strong class="ipm-bad">{parsed.invalid.length}</strong> not valid{/if}.</p>
    {/if}
    {#if parsed.invalid.length}
      <ul class="ipm-invalid" role="alert">
        {#each parsed.invalid.slice(0, 8) as item (item.value)}
          <li><code>{item.value}</code>: {item.error}</li>
        {/each}
        {#if parsed.invalid.length > 8}<li>and {parsed.invalid.length - 8} more</li>{/if}
      </ul>
    {/if}
  </div>

  <TtlPicker bind:value={ttl} bind:amount={ttlAmount} bind:unit={ttlUnit} {disabled} />
</div>

<style>
  .ipm { display: grid; gap: var(--sp-4); }
  .ipm-field { display: grid; gap: var(--sp-1); }
  .ipm-label { font-size: var(--fs-xs); font-weight: var(--fw-medium); color: var(--text-secondary); }
  .ipm-hint { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); line-height: 1.5; }
  .ipm-result:empty { display: none; }
  .ipm-count { margin: 0; font-size: var(--fs-sm); color: var(--text-secondary); }
  .ipm-bad { color: var(--danger); }
  .ipm-invalid { margin: var(--sp-2) 0 0; padding-left: var(--sp-5); font-size: var(--fs-xs); color: var(--text-secondary); line-height: 1.6; }
  .ipm-invalid code { color: var(--danger); font-family: var(--font-mono); }
</style>
