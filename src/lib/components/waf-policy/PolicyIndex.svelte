<!--
  PolicyIndex: section index of the policy editor with problem and unsaved
  markers, and a short summary of the draft (Operations A: index, draft
  summary, redacted review, save). On narrow screens it collapses into a
  disclosure above the sections.
-->
<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { inspectionSummary } from '#lib/inspection.js';
  import { enginesLogOnly, enginesOff } from './model';
  import { sectionDomId, type PolicySectionMeta } from './sections';
  import type { SectionId } from './validate';
  import type { WafPolicyForm } from './waf-policy-form.svelte';

  let { form, sections }: { form: WafPolicyForm; sections: PolicySectionMeta[] } = $props();

  let active = $state<SectionId | null>(untrack(() => sections[0]?.id ?? null));
  let expanded = $state(false);

  const d = $derived(form.draft);
  const BOT_MODES: Record<string, string> = { off: 'Off', log: 'Log only', score: 'Score', block: 'Block' };
  const inspection = $derived(inspectionSummary(d.engines.inspectionOff));
  const engineCount = $derived(enginesOff(d).length);
  const logOnlyCount = $derived(enginesLogOnly(d).length);

  async function go(id: SectionId) {
    active = id;
    expanded = false;
    await tick();
    const section = document.getElementById(sectionDomId(id));
    section?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    document.getElementById(`${sectionDomId(id)}-title`)?.focus({ preventScroll: true });
  }

  // Highlight the section in view.
  onMount(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const visible = new Map<string, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.set(entry.target.id, entry.boundingClientRect.top);
          else visible.delete(entry.target.id);
        }
        const top = [...visible.entries()].sort((a, b) => a[1] - b[1])[0];
        if (top) active = top[0].replace(/^wp-section-/, '') as SectionId;
      },
      { rootMargin: '-15% 0px -55% 0px' }
    );
    for (const section of sections) {
      const el = document.getElementById(sectionDomId(section.id));
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  });
</script>

<div class="wp-index">
  <button type="button" class="wp-index-toggle" aria-expanded={expanded} aria-controls="wp-index-nav" onclick={() => (expanded = !expanded)}>
    Sections{#if form.visibleIssues.length}{` · ${form.visibleIssues.length} ${form.visibleIssues.length === 1 ? 'problem' : 'problems'}`}{/if}
  </button>
  <nav id="wp-index-nav" class="wp-index-nav" class:is-open={expanded} aria-label="Policy sections">
    <ol>
      {#each sections as section (section.id)}
        {@const problems = form.issueCount(section.id)}
        {@const changed = form.changedSection(section.id)}
        <li>
          <button type="button" class:is-active={active === section.id} aria-current={active === section.id ? 'true' : undefined} onclick={() => go(section.id)}>
            <span class="wp-index-title">{section.title}</span>
            {#if problems > 0}<span class="wp-index-problems">{problems}<span class="sr-only"> {problems === 1 ? 'problem' : 'problems'}</span></span>{/if}
            {#if changed}<span class="wp-index-changed" title="Unsaved changes"><span class="sr-only">, unsaved changes</span></span>{/if}
          </button>
        </li>
      {/each}
    </ol>
  </nav>

  <div class="wp-index-summary">
    <h3 class="wp-index-eyebrow">This draft</h3>
    <dl>
      <div><dt>Weak detections</dt><dd>{d.engines.recordWeakDetections ? 'Recorded' : 'Not recorded'}</dd></div>
      <div><dt>Inspection</dt><dd>{inspection}</dd></div>
      <div><dt>Engines off</dt><dd>{engineCount}</dd></div>
      <div><dt>Engines log only</dt><dd>{logOnlyCount}</dd></div>
      <div><dt>Bot protection</dt><dd>{BOT_MODES[d.bot.mode] ?? d.bot.mode}</dd></div>
      <div><dt>Rule paths</dt><dd>{d.pathRules.length}</dd></div>
    </dl>
    <p>{form.isDirty ? `${form.changeCount} unsaved ${form.changeCount === 1 ? 'change' : 'changes'}.` : 'No unsaved changes.'} Saving stores the desired policy; agents apply it on their next update.</p>
  </div>
</div>

<style>
  .wp-index { position: sticky; top: calc(var(--header-height) + var(--sp-4)); display: flex; flex-direction: column; gap: var(--sp-4); min-width: 0; }
  .wp-index-toggle { display: none; }
  .wp-index-nav ol { list-style: none; margin: 0; padding: 0; display: grid; gap: calc(var(--sp-1) / 2); }
  .wp-index-nav button {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    width: 100%;
    padding: var(--sp-2) var(--sp-3);
    border: 0;
    border-radius: var(--radius);
    background: none;
    color: var(--text-secondary);
    font-size: var(--fs-sm);
    text-align: left;
    cursor: pointer;
  }
  .wp-index-nav button:hover { background: var(--bg-hover); color: var(--text-primary); }
  .wp-index-nav button:focus-visible { outline: var(--ring-width) solid var(--ring-color); outline-offset: -2px; }
  .wp-index-nav button.is-active { background: var(--accent-soft); color: var(--text-primary); box-shadow: inset 2px 0 var(--accent); font-weight: var(--fw-semibold); }
  .wp-index-title { flex: 1 1 auto; min-width: 0; }
  .wp-index-problems {
    flex-shrink: 0;
    min-width: 1.25rem;
    padding: 0 var(--sp-1);
    border-radius: var(--radius);
    background: var(--danger-tint);
    color: var(--danger);
    font-size: var(--fs-xs);
    font-weight: var(--fw-semibold);
    text-align: center;
  }
  .wp-index-changed { flex-shrink: 0; width: 0.5rem; height: 0.5rem; border-radius: 50%; background: var(--info); }
  .wp-index-summary { padding-top: var(--sp-4); border-top: 1px solid var(--border); }
  .wp-index-eyebrow { margin: 0 0 var(--sp-2); font-size: var(--fs-sm); font-weight: var(--fw-semibold); color: var(--text-secondary); }
  .wp-index-summary dl { display: grid; gap: var(--sp-1); margin: 0; font-size: var(--fs-xs); }
  .wp-index-summary dl div { display: flex; justify-content: space-between; gap: var(--sp-2); }
  .wp-index-summary dt { color: var(--text-muted); }
  .wp-index-summary dd { margin: 0; color: var(--text-primary); text-align: right; }
  .wp-index-summary p { margin: var(--sp-3) 0 0; font-size: var(--fs-xs); line-height: 1.55; color: var(--text-muted); }

  @media (max-width: 1100px) {
    .wp-index { position: static; }
    .wp-index-toggle {
      display: block;
      width: 100%;
      padding: var(--sp-2) var(--sp-3);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius);
      background: var(--bg-secondary);
      color: var(--text-primary);
      font-size: var(--fs-sm);
      font-weight: var(--fw-medium);
      text-align: left;
      cursor: pointer;
    }
    .wp-index-nav { display: none; }
    .wp-index-nav.is-open { display: block; }
    .wp-index-summary { display: none; }
  }
</style>
