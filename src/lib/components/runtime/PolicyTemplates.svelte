<!--
  PolicyTemplates: the shipped policy library. Templates import into the
  selected host as disabled drafts (a broad kill template as an alert
  draft); enabling one is a separate, confirmed step in Enforcement.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { createPolicy, type EnforcementPolicy } from '#lib/api.js';
  import { formatNumber } from '#lib/format.js';
  import type { HostScope } from '#lib/host-scope.svelte.js';
  import { enforcementTone, severityTone } from '#lib/tone.js';
  import { toast } from '#lib/stores/toast.js';
  import { POLICY_TEMPLATES, POLICY_TEMPLATE_CATEGORIES, templateToPolicyBody, type PolicyTemplate } from '#lib/policyTemplates.js';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import ConfirmModal from '#lib/components/ui/ConfirmModal.svelte';
  import EmptyState from '#lib/components/ui/EmptyState.svelte';
  import Select from '#lib/components/ui/Select.svelte';

  let {
    projectId,
    scope,
    canConfigure = false,
    onimported,
  }: {
    projectId: string;
    scope: HostScope;
    canConfigure?: boolean;
    /** Called after one or more drafts were created. */
    onimported: () => void;
  } = $props();

  // The view is keyed per host: it lives within one scope epoch.
  const hostEpoch = untrack(() => scope.epoch);
  const noPermission = 'Requires the member or owner role';
  const CATEGORY_OPTIONS = [{ value: '', label: 'All categories' }, ...POLICY_TEMPLATE_CATEGORIES.map((item) => ({ value: item, label: item }))];

  let query = $state('');
  let category = $state('');
  let importing = $state<string[]>([]);
  let imported = $state<string[]>([]);
  let failures = $state<Record<string, string>>({});
  let confirmAll = $state(false);
  let importingAll = $state(false);

  const visible = $derived(
    POLICY_TEMPLATES.filter((t) => {
      if (category && t.category !== category) return false;
      const q = query.trim().toLowerCase();
      if (!q) return true;
      return [t.name, t.description, t.mitre_technique_id, t.mitre_tactic, ...t.tags].some((text) => text.toLowerCase().includes(q));
    }),
  );
  const pending = $derived(visible.filter((t) => !imported.includes(t.id)));

  async function importOne(template: PolicyTemplate, quiet = false): Promise<boolean> {
    if (!canConfigure || importing.includes(template.id)) return false;
    importing = [...importing, template.id];
    failures = Object.fromEntries(Object.entries(failures).filter(([id]) => id !== template.id));
    const res = await createPolicy(projectId, templateToPolicyBody(template) as Partial<EnforcementPolicy>, scope.agentId, scope.hostId);
    if (scope.isStale(hostEpoch)) return false;
    importing = importing.filter((id) => id !== template.id);
    if (res.error) {
      failures = { ...failures, [template.id]: res.error.error || 'Import failed' };
      if (!quiet) toast.error(`"${template.name}" was not imported: ${res.error.error || 'Import failed'}`, 'Import failed');
      return false;
    }
    imported = [...imported, template.id];
    if (!quiet) {
      toast.success(`"${template.name}" imported as a disabled draft`, 'Template imported');
      onimported();
    }
    return true;
  }

  async function importAll() {
    if (!canConfigure) return;
    importingAll = true;
    let count = 0;
    for (const template of pending) {
      if (await importOne(template, true)) count += 1;
      if (scope.isStale(hostEpoch)) return;
    }
    importingAll = false;
    confirmAll = false;
    if (count) {
      toast.success(`${formatNumber(count)} template${count === 1 ? '' : 's'} imported as disabled drafts`, 'Templates imported');
      onimported();
    }
    const failed = Object.keys(failures).length;
    if (failed) toast.error(`${formatNumber(failed)} template${failed === 1 ? '' : 's'} not imported`, 'Import incomplete');
  }
</script>

<section class="section" aria-labelledby="tpl-title">
  <div class="head">
    <div>
      <h2 id="tpl-title" class="section-title">Policy templates</h2>
      <p class="caption">
        Templates import into this host as disabled drafts; a kill template without a narrowing match imports as an alert. Review conditions and action before enabling, and try Simulate first.
        ATT&amp;CK mappings and severities are review context, not proof of an attack.
      </p>
    </div>
    <Button variant="secondary" size="sm" disabled={!canConfigure || pending.length === 0 || importingAll} title={canConfigure ? undefined : noPermission} onclick={() => (confirmAll = true)}>
      Import {formatNumber(pending.length)} shown as drafts…
    </Button>
  </div>

  <div class="filters">
    <label class="field">
      <span class="field-label">Search templates</span>
      <input class="input" type="search" bind:value={query} />
    </label>
    <div class="field">
      <label class="field-label" for="policy-template-category">Category</label>
      <Select id="policy-template-category" class="category-filter" size="sm" options={CATEGORY_OPTIONS} bind:value={category} />
    </div>
    <span class="count">{formatNumber(visible.length)} of {formatNumber(POLICY_TEMPLATES.length)} templates</span>
  </div>

  {#if visible.length === 0}
    <EmptyState title="No template matches" message="Clear the search or choose another category." level={3} compact />
  {:else}
    <ul class="grid">
      {#each visible as template (template.id)}
        {@const busy = importing.includes(template.id)}
        {@const done = imported.includes(template.id)}
        <li class="card">
          <div class="card-head">
            <span class="category">{template.category}</span>
            <Badge tone={severityTone(template.severity)}>{template.severity}</Badge>
          </div>
          <h3>{template.name}</h3>
          <p class="desc">{template.description}</p>
          <p class="mitre"><code>{template.mitre_technique_id}</code> {template.mitre_technique_name} · {template.mitre_tactic}</p>
          <div class="meta">
            <span>If enabled:</span> <Badge tone={enforcementTone(template.policy.action)}>{template.policy.action}</Badge>
            <span class="muted">{template.policy.kernel_enforce ? 'kernel' : 'userspace'}</span>
            {#each template.tags as tag (tag)}<span class="tag">#{tag}</span>{/each}
          </div>
          {#if template.pentest}
            <details class="lab">
              <summary>Lab example <span class="muted">(review side effects and active policies before running)</span></summary>
              <pre><code>{template.pentest}</code></pre>
              <Button variant="ghost" size="sm" onclick={() => navigator.clipboard?.writeText(template.pentest ?? '').then(() => toast.success('The lab command is on the clipboard.', 'Copied'))}>Copy command</Button>
            </details>
          {/if}
          {#if failures[template.id]}<p class="error">{failures[template.id]}</p>{/if}
          <div class="card-actions">
            <Button variant={done ? 'ghost' : 'secondary'} size="sm" disabled={!canConfigure || busy || done} loading={busy} title={canConfigure ? undefined : noPermission} onclick={() => importOne(template)}>
              {done ? 'Draft imported' : 'Import draft'}
            </Button>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<ConfirmModal
  open={confirmAll}
  title="Import templates as drafts?"
  message={`Creates ${formatNumber(pending.length)} disabled policies on this host. Nothing is enforced until you enable a policy.`}
  confirmLabel="Import drafts"
  tone="primary"
  loading={importingAll}
  onconfirm={importAll}
  onclose={() => (confirmAll = false)}
/>

<style>
  .section { display: grid; gap: var(--sp-3); min-width: 0; }
  .head { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: var(--sp-3); }
  .section-title { margin: 0; font-size: var(--fs-md); font-weight: var(--fw-semibold); }
  .caption { margin: var(--sp-1) 0 0; font-size: var(--fs-xs); color: var(--text-muted); max-width: 80ch; }
  .filters { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--sp-3); }
  .field { display: grid; gap: var(--sp-1); }
  .field-label { font-size: var(--fs-xs); color: var(--text-muted); }
  .field :global(.category-filter) { min-width: 12rem; }
  .input { min-width: 12rem; padding: var(--sp-1) var(--sp-2); border: 1px solid var(--border-strong); border-radius: var(--radius); background: var(--surface-input); color: var(--text-primary); font-size: var(--fs-sm); }
  .count { font-size: var(--fs-xs); color: var(--text-muted); }
  .grid { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 20rem), 1fr)); gap: var(--sp-3); }
  .card { display: grid; align-content: start; gap: var(--sp-2); padding: var(--sp-4); border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-card); min-width: 0; }
  .card-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); }
  .category { font-size: var(--fs-sm); color: var(--text-muted); }
  h3 { margin: 0; font-size: var(--fs-base); font-weight: var(--fw-semibold); }
  .desc { margin: 0; font-size: var(--fs-xs); color: var(--text-secondary); line-height: 1.5; }
  .mitre { margin: 0; font-size: var(--fs-xs); color: var(--text-muted); }
  .meta { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-1) var(--sp-2); font-size: var(--fs-xs); color: var(--text-secondary); }
  .muted { color: var(--text-muted); font-size: var(--fs-xs); }
  .tag { color: var(--text-muted); }
  .lab { min-width: 0; }
  .lab summary { cursor: pointer; font-size: var(--fs-xs); color: var(--text-secondary); }
  .lab pre { margin: var(--sp-2) 0; padding: var(--sp-2); border-radius: var(--radius); background: var(--bg-code); overflow-x: auto; min-width: 0; max-width: 100%; box-sizing: border-box; font-size: var(--fs-xs); }
  .lab pre code { white-space: pre; }
  .error { margin: 0; font-size: var(--fs-xs); color: var(--danger); }
  .card-actions { display: flex; justify-content: flex-end; }
  code { font-size: var(--fs-xs); }
  @media (max-width: 640px) { .input { min-width: 0; width: 100%; } .field :global(.category-filter) { min-width: 0; } .field { flex: 1 1 12rem; } }
</style>
