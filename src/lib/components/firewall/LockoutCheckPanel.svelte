<!--
  LockoutCheckPanel: the checks shown before Enforce, Deny all or Disable.
  Each check states its outcome in words ("Blocks the change",
  "Warning", "Passed", "Note"); colour and icon only repeat it. A failing
  check can offer a way to fix it (`onfix`).
-->
<script lang="ts">
  import Icon from 'svelte-awesome/components/Icon.svelte';
  import checkCircle from 'svelte-awesome/icons/checkCircle';
  import timesCircle from 'svelte-awesome/icons/timesCircle';
  import exclamationTriangle from 'svelte-awesome/icons/exclamationTriangle';
  import infoCircle from 'svelte-awesome/icons/infoCircle';
  import type { CheckFix, CheckStatus, LockoutCheck } from './lockout';

  let {
    checks,
    title = 'Lockout check',
    headingLevel = 3,
    onfix = undefined,
  }: {
    checks: readonly LockoutCheck[];
    title?: string;
    headingLevel?: 3 | 4;
    /** Opens the place where a check can be fixed (Access rules, Settings …). */
    onfix?: (fix: CheckFix) => void;
  } = $props();

  const OUTCOME: Record<CheckStatus, string> = { fail: 'Blocks the change', warn: 'Warning', pass: 'Passed', info: 'Note' };
  const ICON = { fail: timesCircle, warn: exclamationTriangle, pass: checkCircle, info: infoCircle };
  const FIX_LABEL: Record<CheckFix, string> = { rules: 'Open Access rules', settings: 'Open settings', overview: 'Open overview', live: 'Open live' };

  const failures = $derived(checks.filter((check) => check.status === 'fail').length);
  const warnings = $derived(checks.filter((check) => check.status === 'warn').length);
  const summary = $derived(
    failures ? `${failures} ${failures === 1 ? 'check blocks' : 'checks block'} this change`
      : warnings ? `${warnings} ${warnings === 1 ? 'warning' : 'warnings'} to review`
      : 'No lockout risk found',
  );
</script>

<section class="lockout" aria-label={title}>
  <div class="lockout-head">
    <svelte:element this={`h${headingLevel}`} class="lockout-title">{title}</svelte:element>
    <span class="lockout-summary" class:has-fail={failures > 0} role="status">{summary}</span>
  </div>
  <ul class="lockout-list">
    {#each checks as check (check.id)}
      <li class="check status-{check.status}">
        <span class="check-icon" aria-hidden="true"><Icon data={ICON[check.status]} scale={0.85} /></span>
        <div class="check-body">
          <p class="check-title"><span class="check-outcome">{OUTCOME[check.status]}:</span> {check.title}</p>
          <p class="check-detail">{check.detail}</p>
          {#if check.fix && onfix && (check.status === 'fail' || check.status === 'warn')}
            <button type="button" class="check-fix" onclick={() => onfix?.(check.fix!)}>{FIX_LABEL[check.fix]}</button>
          {/if}
        </div>
      </li>
    {/each}
  </ul>
</section>

<style>
  .lockout { border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-secondary); }
  .lockout-head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: var(--sp-2); padding: var(--sp-3) var(--sp-4); border-bottom: 1px solid var(--border); }
  .lockout-title { margin: 0; font-size: var(--fs-sm); font-weight: var(--fw-semibold); color: var(--text-primary); }
  .lockout-summary { font-size: var(--fs-xs); color: var(--text-secondary); }
  .lockout-summary.has-fail { color: var(--danger); font-weight: var(--fw-medium); }
  .lockout-list { list-style: none; margin: 0; padding: 0; }
  .check { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: var(--sp-3); padding: var(--sp-3) var(--sp-4); border-top: 1px solid var(--border); }
  .check:first-child { border-top: 0; }
  .check-icon { display: inline-flex; padding-top: calc(var(--sp-1) / 2); }
  .status-pass .check-icon { color: var(--success); }
  .status-fail .check-icon { color: var(--danger); }
  .status-warn .check-icon { color: var(--warning); }
  .status-info .check-icon { color: var(--info); }
  .check-body { min-width: 0; }
  .check-title { margin: 0; font-size: var(--fs-sm); color: var(--text-primary); line-height: 1.45; }
  .check-outcome { font-weight: var(--fw-semibold); }
  .status-fail .check-outcome { color: var(--danger); }
  .status-warn .check-outcome { color: var(--warning); }
  .status-pass .check-outcome { color: var(--success); }
  .status-info .check-outcome { color: var(--info); }
  .check-detail { margin: var(--sp-1) 0 0; font-size: var(--fs-xs); color: var(--text-secondary); line-height: 1.5; }
  .check-fix { margin-top: var(--sp-2); padding: 0; border: 0; background: none; color: var(--accent); font-size: var(--fs-xs); font-weight: var(--fw-medium); cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
</style>
