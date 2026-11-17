<script lang="ts">
  // Tones and the helpers that pick them (severityTone, actionTone, statusTone,
  // modeTone, categoricalTone …) live in $lib/tone, pages call a helper instead
  // of choosing a colour inline. Verdict tones (allow/log/block) are for decision
  // actions only; the label text always carries the meaning.
  import type { BadgeTone } from '#lib/tone.js';

  let {
    tone = 'neutral',
    title = undefined,
    children = undefined
  }: {
    tone?: BadgeTone;
    title?: string;
    children?: import('svelte').Snippet;
  } = $props();
</script>

<span {title} class="badge tone-{tone}">{@render children?.()}</span>

<style>
  .badge {
    --tone: var(--text-secondary);
    display: inline-flex;
    align-items: center;
    gap: var(--sp-1);
    padding: 2px var(--sp-2);
    border-radius: var(--radius);
    font-size: var(--fs-xs);
    font-weight: var(--fw-medium);
    line-height: 1.6;
    border: 1px solid transparent;
    color: var(--tone);
    background: color-mix(in srgb, var(--tone) var(--tint), transparent);
  }

  /* Generic */
  .tone-neutral { background: var(--bg-tertiary); color: var(--text-secondary); border-color: var(--border); }
  .tone-info { --tone: var(--info); }
  .tone-success { --tone: var(--success); }
  .tone-warning { --tone: var(--warning); }
  .tone-danger { --tone: var(--danger); }

  /* WAF / firewall / runtime decision verdicts */
  .tone-allow { --tone: var(--allow); }
  .tone-log { --tone: var(--log); }
  .tone-block { --tone: var(--block); }

  /* Agent / host status */
  .tone-status-online { --tone: var(--status-online); }
  .tone-status-pending { --tone: var(--status-pending); }
  .tone-status-offline { --tone: var(--status-offline); }

  /* Protection mode */
  .tone-mode-block { --tone: var(--mode-block); }
  .tone-mode-monitor { --tone: var(--mode-monitor); }

  /* Severity */
  .tone-sev-critical { --tone: var(--sev-critical); }
  .tone-sev-high { --tone: var(--sev-high); }
  .tone-sev-medium { --tone: var(--sev-medium); }
  .tone-sev-low { --tone: var(--sev-low); }
  .tone-sev-info { --tone: var(--sev-info); }

  /* Categorical: identity, not state, neutral label text, colour on a dot and the tint. */
  .tone-cat1 { --tone: var(--cat-1); }
  .tone-cat2 { --tone: var(--cat-2); }
  .tone-cat3 { --tone: var(--cat-3); }
  .tone-cat4 { --tone: var(--cat-4); }
  .tone-cat5 { --tone: var(--cat-5); }
  .tone-cat6 { --tone: var(--cat-6); }
  .tone-cat7 { --tone: var(--cat-7); }
  .tone-cat1, .tone-cat2, .tone-cat3, .tone-cat4, .tone-cat5, .tone-cat6, .tone-cat7 { color: var(--text-primary); }
  .tone-cat1::before, .tone-cat2::before, .tone-cat3::before, .tone-cat4::before,
  .tone-cat5::before, .tone-cat6::before, .tone-cat7::before {
    content: '';
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--tone);
    flex-shrink: 0;
  }

  @media (forced-colors: active) {
    .badge { border-color: CanvasText; }
  }
</style>
