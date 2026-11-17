<!--
  PathRulesSection: per-path WAF controls (path_exceptions): the inspection
  switch, what each engine does, detection tuning, IP access, limits, login
  protection and field rules. Edits happen in a dialog on a copy and are
  saved with the policy; removal can be undone until then.
-->
<script lang="ts">
  import Button from '#lib/components/ui/Button.svelte';
  import Badge from '#lib/components/ui/Badge.svelte';
  import EmptyState from '#lib/components/ui/EmptyState.svelte';
  import PolicySection from './PolicySection.svelte';
  import PathRuleEditor from './PathRuleEditor.svelte';
  import { EMPTY } from '#lib/format.js';
  import { newPathRule, effectiveCaseInsensitive, pathEnginesLogOnly, pathEnginesOff, pathHasOwnValues, tuningHasEffect, tuningSkipCount, tuningSkipsAll, type PathRuleDraft } from './model';
  import { fieldId } from './validate';
  import type { WafPolicyForm } from './waf-policy-form.svelte';

  let { form, readonly = false }: { form: WafPolicyForm; readonly?: boolean } = $props();

  const MAX_RULES = 50;
  let editing = $state<{ index: number | null; rule: PathRuleDraft } | null>(null);
  let removed = $state<{ index: number; rule: PathRuleDraft } | null>(null);

  const rules = $derived(form.draft.pathRules);

  function features(rule: PathRuleDraft): string[] {
    const list: string[] = [];
    if (tuningHasEffect(rule.tuning)) list.push(`Tuning (${tuningSkipCount(rule.tuning)} skips)`);
    if (pathHasOwnValues(rule, form.draft)) list.push('Own engine values');
    if (rule.ipRules) list.push(rule.ipRules.mode === 'allowlist' ? 'IP allowlist' : 'IP blocklist');
    if (rule.block) list.push(`Hard block ${rule.block.status ?? 403}`);
    if (rule.rateLimit) list.push(`${rule.rateLimit.maxRequests ?? '?'} req / ${rule.rateLimit.windowSec ?? '?'} s`);
    if (rule.bodySizeLimit) list.push('Body limit');
    if (rule.loginProtection?.enabled) list.push('Login protection');
    if (rule.fieldRules.length) list.push(`${rule.fieldRules.length} field ${rule.fieldRules.length === 1 ? 'rule' : 'rules'}`);
    if (rule.responseDecryptAes || rule.responseFieldRules.length) list.push('Response decryption');
    return list;
  }

  function add() {
    editing = { index: null, rule: newPathRule() };
  }

  function edit(index: number) {
    editing = { index, rule: form.draft.pathRules[index] };
  }

  function apply(rule: PathRuleDraft) {
    if (!editing) return;
    if (editing.index === null) form.draft.pathRules.push(rule);
    else form.draft.pathRules[editing.index] = rule;
    editing = null;
  }

  function remove(index: number) {
    const [rule] = form.draft.pathRules.splice(index, 1);
    removed = { index, rule: JSON.parse(JSON.stringify(rule)) };
  }

  function undo() {
    if (!removed) return;
    form.draft.pathRules.splice(Math.min(removed.index, form.draft.pathRules.length), 0, removed.rule);
    removed = null;
  }
</script>

<PolicySection id="path-rules" title="Rule paths" description="Per-path controls: whether a path is inspected, detection tuning, IP access, limits, login protection and field encryption. Global settings still apply to every other path; flood, block policy, geo and bot controls always apply." {form}>
  {#snippet aside()}
    <span class="wp-muted wp-count">{rules.length} / {MAX_RULES}</span>
  {/snippet}

  {#if removed}
    <div class="wp-undo" role="status">
      <span>Removed rule path <code>{removed.rule.path || 'without a path'}</code>. It is deleted when you save.</span>
      <button type="button" class="wp-link-button" onclick={undo}>Undo</button>
    </div>
  {/if}

  {#if rules.length === 0}
    <EmptyState title="No rule paths" message="Add one to tune detection or restrict access for a specific path, such as a rich-text editor or a login endpoint." level={4} compact />
  {:else}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div class="wp-table-wrap" role="region" aria-label="Rule paths" tabindex="0">
      <table class="wp-table wp-rules">
        <thead>
          <tr>
            <th scope="col">Path</th>
            <th scope="col">Inspection</th>
            <th scope="col">Controls</th>
            <th scope="col">Note</th>
            <th scope="col"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {#each rules as rule, index (index)}
            {@const problem = form.error(`pathRules.${index}`)}
            <tr class:is-off={!rule.active}>
              <th scope="row">
                <code class="wp-rule-path">{rule.path || EMPTY}</code>
                <span class="wp-rule-meta">{rule.match}{effectiveCaseInsensitive(rule) ? ', ignore case' : ''}{rule.active ? '' : ', inactive'}</span>
                {#if problem}<span class="wp-cell-error">{problem}</span>{/if}
              </th>
              <td>
                {#if rule.inspectionOff || tuningSkipsAll(rule.tuning)}<Badge tone="warning" title="Requests to this path are not checked for attacks.">Off</Badge>
                {:else}
                  {@const off = pathEnginesOff(rule).length}
                  {@const logOnly = pathEnginesLogOnly(rule).length}
                  {#if off > 0}<Badge tone="warning" title="Engines turned off on this path; open the rule path to see which.">{off} {off === 1 ? 'engine' : 'engines'} off</Badge>
                  {:else if logOnly === 0}<span class="wp-muted">On</span>{/if}
                  {#if logOnly > 0}<Badge tone="neutral" title="Engines that only log on this path: their detections are recorded as LOG and the request is let through. Open the rule path to see which.">{logOnly} {logOnly === 1 ? 'engine' : 'engines'} log only</Badge>{/if}
                {/if}
              </td>
              <td>
                {#if features(rule).length}
                  <ul class="wp-features">{#each features(rule) as feature (feature)}<li>{feature}</li>{/each}</ul>
                {:else}<span class="wp-muted">None</span>{/if}
              </td>
              <td class="wp-rule-note">{rule.comment || ''}</td>
              <td class="wp-rule-actions">
                <Button variant="secondary" size="sm" id={fieldId(`pathRules.${index}.edit`)} onclick={() => edit(index)}>
                  {readonly ? 'View' : 'Edit'}<span class="sr-only"> {rule.path}</span>
                </Button>
                {#if !readonly}
                  <Button variant="ghost" size="sm" onclick={() => remove(index)}>Remove<span class="sr-only"> {rule.path}</span></Button>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
  {#if form.error('pathRules')}<p class="wp-cell-error" role="alert">{form.error('pathRules')}</p>{/if}

  {#if !readonly}
    <div class="wp-add">
      <Button variant="secondary" onclick={add} disabled={rules.length >= MAX_RULES}>Add rule path</Button>
      {#if rules.length >= MAX_RULES}<span class="wp-note wp-muted">The limit is {MAX_RULES} rule paths.</span>{/if}
    </div>
  {/if}
</PolicySection>

{#if editing}
  <PathRuleEditor
    open={true}
    rule={editing.rule}
    isNew={editing.index === null}
    secrets={form.secrets}
    policy={form.draft}
    {readonly}
    onapply={apply}
    onclose={() => (editing = null)}
  />
{/if}

<style>
  .wp-count { font-size: var(--fs-sm); }
  .wp-undo {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--sp-3);
    margin-bottom: var(--sp-3);
    padding: var(--sp-2) var(--sp-3);
    border: 1px solid var(--border);
    border-left: 3px solid var(--info);
    border-radius: var(--radius);
    background: var(--bg-secondary);
    font-size: var(--fs-sm);
    color: var(--text-secondary);
  }
  .wp-undo code { font-family: var(--font-mono); color: var(--text-primary); }
  .wp-rule-path { font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--text-primary); overflow-wrap: anywhere; }
  .wp-rule-meta { display: block; font-size: var(--fs-xs); font-weight: 400; color: var(--text-muted); }
  .wp-features { margin: 0; padding: 0; list-style: none; display: flex; flex-wrap: wrap; gap: var(--sp-1) var(--sp-3); font-size: var(--fs-xs); color: var(--text-secondary); }
  .wp-rule-note { font-size: var(--fs-xs); color: var(--text-muted); max-width: 16rem; }
  .wp-rule-actions { white-space: nowrap; text-align: right; }
  .wp-rule-actions :global(.btn) { margin-left: var(--sp-1); }
  .wp-add { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-3); margin-top: var(--sp-4); }
</style>
