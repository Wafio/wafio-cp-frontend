<!--
  ErrorSummary: every problem that blocks a save, grouped by section, each
  a button that reveals and focuses the field. Shown after a save attempt;
  the shell focuses it (focus()) so screen readers announce it.
-->
<script lang="ts">
  import { groupBySection } from './sections';
  import type { PolicyIssue } from './validate';

  let { issues, onjump }: { issues: PolicyIssue[]; onjump: (issue: PolicyIssue) => void } = $props();

  let el = $state<HTMLDivElement>();
  const groups = $derived(groupBySection(issues));

  export function focus() {
    el?.focus();
    el?.scrollIntoView({ block: 'nearest' });
  }
</script>

{#if issues.length > 0}
  <div class="wp-errsum" bind:this={el} tabindex="-1" role="alert" aria-labelledby="wp-errsum-title">
    <h3 id="wp-errsum-title">Fix {issues.length} {issues.length === 1 ? 'problem' : 'problems'} before saving</h3>
    {#each groups as group (group.section.id)}
      <p class="wp-errsum-section">{group.section.title}</p>
      <ul>
        {#each group.items as issue, i (`${issue.path}-${i}`)}
          <li><button type="button" class="wp-link-button" onclick={() => onjump(issue)}>{issue.message}</button></li>
        {/each}
      </ul>
    {/each}
  </div>
{/if}

<style>
  .wp-errsum {
    padding: var(--sp-4) var(--sp-5);
    border: 1px solid var(--border);
    border-left: 3px solid var(--danger);
    border-radius: var(--radius-lg);
    background: var(--danger-tint);
  }
  .wp-errsum:focus-visible { outline: var(--ring-width) solid var(--ring-color); outline-offset: 2px; }
  h3 { margin: 0 0 var(--sp-2); font-size: var(--fs-base); font-weight: var(--fw-semibold); color: var(--text-primary); }
  .wp-errsum-section { margin: var(--sp-3) 0 var(--sp-1); font-size: var(--fs-sm); font-weight: var(--fw-semibold); color: var(--text-secondary); }
  ul { margin: 0; padding: 0; list-style: none; display: grid; gap: var(--sp-1); }
  li { font-size: var(--fs-sm); color: var(--danger); }
  li :global(.wp-link-button) { color: var(--danger); text-align: left; overflow-wrap: anywhere; }
</style>
