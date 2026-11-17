<!--
  ReviewDrawer: every unsaved change of the policy, grouped by section:
  values as before → after, lists as added and removed entries, secrets as
  "changed (value hidden)", templates by size. Save from here or keep editing.
-->
<script lang="ts">
  import Drawer from '#lib/components/ui/Drawer.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Alert from '#lib/components/ui/Alert.svelte';
  import { groupBySection } from './sections';
  import { enginesLogOnlySummary, enginesOffSummary } from './review';
  import type { SectionId } from './validate';
  import type { WafPolicyForm } from './waf-policy-form.svelte';

  let {
    open = false,
    form,
    saving = false,
    readonly = false,
    onclose,
    onsave,
    ongoto
  }: {
    open?: boolean;
    form: WafPolicyForm;
    saving?: boolean;
    readonly?: boolean;
    onclose: () => void;
    onsave: () => void;
    /** Close the drawer and show a section. */
    ongoto: (section: SectionId) => void;
  } = $props();

  const groups = $derived(groupBySection(form.changes));
  const problems = $derived(form.issues.length);
  const off = $derived(enginesOffSummary(form.draft));
  const anyOff = $derived(off.policy.length > 0 || off.paths.length > 0);
  const logOnly = $derived(enginesLogOnlySummary(form.draft));
  const anyLogOnly = $derived(logOnly.policy.length > 0 || logOnly.paths.length > 0);
  const LIST_PREVIEW = 12;
</script>

<Drawer {open} title="Review changes" size="lg" {onclose}>
  <div class="wp-review">
    <p class="wp-note">
      {#if form.changeCount === 0}No unsaved changes.
      {:else}{form.changeCount} {form.changeCount === 1 ? 'change' : 'changes'} in {groups.length} {groups.length === 1 ? 'section' : 'sections'}, compared with the policy you loaded.{/if}
      Secrets and keys are never shown; templates are summarised by size.
    </p>
    {#if problems > 0 && !readonly}
      <Alert tone="error" compact>{problems} {problems === 1 ? 'problem needs' : 'problems need'} fixing before this policy can be saved.</Alert>
    {/if}

    {#if anyOff}
      <Alert tone="warning" compact title="Engines that are off">
        <ul class="wp-review-off">
          {#if off.policy.length > 0}<li>Policy: {off.policy.join(', ')}</li>{/if}
          {#each off.paths as entry (entry.path)}<li>Rule path <code>{entry.path}</code>: {entry.engines.join(', ')}</li>{/each}
        </ul>
      </Alert>
    {/if}

    {#if anyLogOnly}
      <Alert tone="info" compact title="Engines that only log">
        <ul class="wp-review-off">
          {#if logOnly.policy.length > 0}<li>Policy: {logOnly.policy.join(', ')}</li>{/if}
          {#each logOnly.paths as entry (entry.path)}<li>Rule path <code>{entry.path}</code>: {entry.engines.join(', ')}</li>{/each}
        </ul>
        <p class="wp-review-note">Their detections are recorded as LOG and the request is let through.</p>
      </Alert>
    {/if}

    {#each groups as group (group.section.id)}
      <section class="wp-review-group" aria-labelledby="wp-review-{group.section.id}">
        <div class="wp-row-between">
          <h3 id="wp-review-{group.section.id}">{group.section.title}</h3>
          <button type="button" class="wp-link-button" onclick={() => ongoto(group.section.id)}>Show<span class="sr-only"> {group.section.title}</span></button>
        </div>
        <ul class="wp-review-list">
          {#each group.items as change (change.path)}
            <li>
              <span class="wp-review-label">{change.label}</span>
              {#if change.kind === 'value'}
                <span class="wp-review-value">
                  <span class="wp-review-before"><span class="sr-only">from </span>{change.before}</span>
                  <span aria-hidden="true">→</span>
                  <span class="wp-review-after"><span class="sr-only">to </span>{change.after}</span>
                </span>
              {:else if change.kind === 'list'}
                <div class="wp-review-lists">
                  {#if change.added?.length}
                    <div>
                      <span class="wp-review-tag is-added">Added {change.added.length}</span>
                      <ul class="wp-review-entries">
                        {#each change.added.slice(0, LIST_PREVIEW) as entry, i (`a-${i}`)}<li><code>{entry}</code></li>{/each}
                        {#if change.added.length > LIST_PREVIEW}<li class="wp-muted">and {change.added.length - LIST_PREVIEW} more</li>{/if}
                      </ul>
                    </div>
                  {/if}
                  {#if change.removed?.length}
                    <div>
                      <span class="wp-review-tag is-removed">Removed {change.removed.length}</span>
                      <ul class="wp-review-entries">
                        {#each change.removed.slice(0, LIST_PREVIEW) as entry, i (`r-${i}`)}<li><code>{entry}</code></li>{/each}
                        {#if change.removed.length > LIST_PREVIEW}<li class="wp-muted">and {change.removed.length - LIST_PREVIEW} more</li>{/if}
                      </ul>
                    </div>
                  {/if}
                </div>
              {:else}
                <span class="wp-review-note">{change.note}</span>
              {/if}
            </li>
          {/each}
        </ul>
      </section>
    {/each}
    <p class="wp-note wp-muted">Saving stores the desired policy. Agents apply it asynchronously; check the agent acknowledgement to confirm.</p>
  </div>

  {#snippet footer()}
    <Button variant="secondary" onclick={onclose}>Keep editing</Button>
    {#if !readonly}
      <Button onclick={onsave} loading={saving} disabled={saving || form.changeCount === 0 || problems > 0}>Save policy</Button>
    {/if}
  {/snippet}
</Drawer>

<style>
  .wp-review { display: flex; flex-direction: column; gap: var(--sp-4); min-width: 0; }
  .wp-review-off { margin: 0; padding-left: var(--sp-4); }
  .wp-review-off code { font-family: var(--font-mono); }
  .wp-review-note { margin: var(--sp-2) 0 0; }
  .wp-review-group { padding-top: var(--sp-3); border-top: 1px solid var(--border); }
  .wp-review-group h3 { margin: 0; font-size: var(--fs-base); font-weight: var(--fw-semibold); }
  .wp-review-list { list-style: none; margin: var(--sp-2) 0 0; padding: 0; display: grid; gap: var(--sp-3); }
  .wp-review-list > li { display: flex; flex-direction: column; gap: var(--sp-1); min-width: 0; }
  .wp-review-label { font-size: var(--fs-sm); color: var(--text-secondary); }
  .wp-review-value { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--sp-2); font-size: var(--fs-sm); overflow-wrap: anywhere; }
  .wp-review-before { color: var(--text-muted); text-decoration: line-through; }
  .wp-review-after { color: var(--text-primary); font-weight: var(--fw-semibold); }
  .wp-review-note { font-size: var(--fs-sm); color: var(--text-primary); overflow-wrap: anywhere; }
  .wp-review-lists { display: grid; gap: var(--sp-2); }
  .wp-review-tag { display: inline-block; font-size: var(--fs-xs); font-weight: var(--fw-semibold); padding: 0 var(--sp-2); border-radius: var(--radius); border: 1px solid var(--border-strong); color: var(--text-primary); }
  .wp-review-tag.is-added { background: var(--info-tint); }
  .wp-review-tag.is-removed { background: var(--bg-tertiary); }
  .wp-review-entries { list-style: none; margin: var(--sp-1) 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: var(--sp-1); font-size: var(--fs-xs); }
  .wp-review-entries code { font-family: var(--font-mono); padding: 0 var(--sp-1); border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-secondary); color: var(--text-primary); overflow-wrap: anywhere; }
</style>
