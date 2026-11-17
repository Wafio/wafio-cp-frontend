<script lang="ts">
  import type { GenericTone, ModeTone, SeverityTone, StatusTone, VerdictTone } from '#lib/tone.js';
  import { toneApplies } from './kpi-tone';

  /** Colour of the value, used only while the value is above zero. Pick it with the $lib/tone helpers (severityTone,
   *  statusTone, modeTone, actionTone); 'default' and 'neutral' stay uncoloured. */
  type Tone = 'default' | GenericTone | VerdictTone | StatusTone | ModeTone | SeverityTone;
  let {
    label,
    value,
    tone = 'default',
    onclick = undefined,
    hint = undefined
  }: {
    label: string;
    value: string | number;
    tone?: Tone;
    onclick?: (() => void) | undefined;
    hint?: string | undefined;
  } = $props();

  const interactive = $derived(typeof onclick === 'function');
  // A state colour only for a value above zero.
  const shown = $derived(toneApplies(value) ? tone : 'default');
</script>

{#snippet contents()}
  <div class="stat-label">{label}</div>
  <div class="stat-value">{value}</div>
  {#if interactive}<span class="stat-drill" aria-hidden="true">→</span>{/if}
{/snippet}

{#if interactive}
  <button type="button" class="stat-card tone-{shown} interactive" title={hint} onclick={onclick}>
    {@render contents()}
  </button>
{:else}
  <div class="stat-card tone-{shown}" title={hint}>
    {@render contents()}
  </div>
{/if}

<style>
  .stat-card { position: relative; background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: var(--sp-3) var(--sp-4); overflow: hidden; }
  .stat-label { font-size: var(--fs-xs); color: var(--text-muted); }
  .stat-value { font-size: var(--fs-xl); font-weight: 500; color: var(--text-primary); margin-top: var(--sp-1); font-variant-numeric: tabular-nums; }
  /* Value colour per tone family ($lib/tone). The label always carries the meaning. */
  .stat-card.tone-info .stat-value { color: var(--info); }
  .stat-card.tone-success .stat-value { color: var(--success); }
  .stat-card.tone-warning .stat-value { color: var(--warning); }
  .stat-card.tone-danger .stat-value { color: var(--danger); }
  .stat-card.tone-block .stat-value { color: var(--block); }
  .stat-card.tone-log .stat-value { color: var(--log); }
  .stat-card.tone-allow .stat-value { color: var(--allow); }
  .stat-card.tone-status-online .stat-value { color: var(--status-online); }
  .stat-card.tone-status-pending .stat-value { color: var(--status-pending); }
  .stat-card.tone-status-offline .stat-value { color: var(--status-offline); }
  .stat-card.tone-mode-block .stat-value { color: var(--mode-block); }
  .stat-card.tone-mode-monitor .stat-value { color: var(--mode-monitor); }
  .stat-card.tone-sev-critical .stat-value { color: var(--sev-critical); }
  .stat-card.tone-sev-high .stat-value { color: var(--sev-high); }
  .stat-card.tone-sev-medium .stat-value { color: var(--sev-medium); }
  .stat-card.tone-sev-low .stat-value { color: var(--sev-low); }
  .stat-card.tone-sev-info .stat-value { color: var(--sev-info); }
  .stat-card.interactive { display: block; width: 100%; text-align: left; font: inherit; cursor: pointer; transition: border-color .15s; }
  .stat-card.interactive:hover { border-color: var(--accent); background: var(--bg-hover); }
  .stat-card.interactive:focus-visible { outline: var(--ring-width) solid var(--ring-color); outline-offset: 2px; }
  .stat-drill { position: absolute; top: var(--sp-2); right: var(--sp-3); font-size: .85rem; color: var(--text-muted); opacity: 0; transition: opacity .15s; }
  .stat-card.interactive:hover .stat-drill { opacity: .8; }
</style>
