<!--
  RuleStagesExplainer: "When custom rules run", from rule-stages.ts (the
  single description shared with the editor and the script guide).
-->
<script lang="ts">
  import { INFRASTRUCTURE_CHECKS, PIPELINE_STEPS, RULE_STAGES, SCRIPT_FAST_PATH, SCRIPT_SKIPPED_WHEN } from './rule-stages';

  let { open = false }: { open?: boolean } = $props();

  const ORDER = ['gui', 'tuning', 'script'] as const;
</script>

<details class="rs" {open}>
  <summary>When custom rules run</summary>
  <div class="rs-body">
    <ol class="rs-flow" aria-label="Request pipeline, in order">
      {#each PIPELINE_STEPS as step (step.label)}
        <li class:is-rule={step.mode !== undefined}>{step.label}</li>
      {/each}
    </ol>
    <p class="rs-text">Infrastructure checks ({INFRASTRUCTURE_CHECKS}) run first. A request they stop never reaches a custom rule.</p>
    <dl class="rs-stages">
      {#each ORDER as mode (mode)}
        <div class="rs-stage">
          <dt>{RULE_STAGES[mode].label} <span>{RULE_STAGES[mode].when}</span></dt>
          <dd>
            {RULE_STAGES[mode].effect}
            {#if mode === 'script'}
              {SCRIPT_FAST_PATH} {SCRIPT_SKIPPED_WHEN}
            {/if}
          </dd>
        </div>
      {/each}
    </dl>
  </div>
</details>

<style>
  .rs { border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-card); min-width: 0; }
  .rs summary {
    padding: var(--sp-2) var(--sp-4);
    font-size: var(--fs-sm);
    font-weight: var(--fw-semibold);
    color: var(--text-primary);
    cursor: pointer;
    border-radius: var(--radius-lg);
  }
  .rs summary:hover { background: var(--bg-hover); }
  .rs-body { display: flex; flex-direction: column; gap: var(--sp-3); padding: var(--sp-1) var(--sp-4) var(--sp-4); border-top: 1px solid var(--border); }
  .rs-flow { list-style: none; margin: var(--sp-2) 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: var(--sp-1); counter-reset: step; }
  .rs-flow li {
    counter-increment: step;
    padding: 2px var(--sp-2);
    font-size: var(--fs-xs);
    color: var(--text-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface-input);
  }
  .rs-flow li::before { content: counter(step) '. '; color: var(--text-muted); }
  .rs-flow li.is-rule { color: var(--text-primary); border-color: var(--accent); background: var(--accent-soft); font-weight: var(--fw-medium); }
  .rs-text { margin: 0; font-size: var(--fs-sm); color: var(--text-secondary); line-height: 1.55; }
  .rs-stages { margin: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--sp-3); }
  .rs-stage { min-width: 0; }
  .rs-stage dt { font-size: var(--fs-sm); font-weight: var(--fw-semibold); color: var(--text-primary); }
  .rs-stage dt span { display: block; font-size: var(--fs-xs); font-weight: var(--fw-medium); color: var(--text-muted); }
  .rs-stage dd { margin: var(--sp-1) 0 0; font-size: var(--fs-sm); color: var(--text-secondary); line-height: 1.55; }
  @media (max-width: 900px) {
    .rs-stages { grid-template-columns: 1fr; }
  }
</style>
