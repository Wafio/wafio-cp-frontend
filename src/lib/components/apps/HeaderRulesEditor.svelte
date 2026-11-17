<!--
  HeaderRulesEditor: rows of "Set <name>: <value>" or "Remove <name>"
  rules for the proxy's request or response headers (replaces the old
  `Name: value` / `-Name` textarea). Validation stays with the form model.
-->
<script lang="ts">
  import { Button, InlineError } from '#lib/components/ui/index.js';
  import Select from '#lib/components/ui/Select.svelte';
  import type { HeaderRule } from './route-model';
  import { PROXY_LIMITS } from './route-model';
  import { HIDDEN_SECRET_TEXT } from '#lib/secret-redaction.js';

  let {
    rules = $bindable([]),
    legend,
    hint = undefined,
    error = undefined,
    disabled = false,
    hiddenValues = false,
  }: {
    rules?: HeaderRule[];
    legend: string;
    hint?: string;
    error?: string | null;
    disabled?: boolean;
    /** Values were redacted by the server: a blank value shows as hidden. */
    hiddenValues?: boolean;
  } = $props();

  const ACTIONS: { value: HeaderRule['action']; label: string }[] = [
    { value: 'set', label: 'Set' },
    { value: 'remove', label: 'Remove' },
  ];

  const uid = $props.id();
  const errorId = `${uid}-error`;
  const hintId = `${uid}-hint`;

  function add() {
    rules = [...rules, { action: 'set', name: '', value: '' }];
  }

  function remove(index: number) {
    rules = rules.filter((_, i) => i !== index);
  }

  function update(index: number, patch: Partial<HeaderRule>) {
    rules = rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule));
  }
</script>

<fieldset class="header-rules" aria-describedby={[hint ? hintId : '', error ? errorId : ''].filter(Boolean).join(' ') || undefined}>
  <legend>{legend}</legend>
  {#if hint}<p class="header-rules-hint" id={hintId}>{hint}</p>{/if}
  {#if rules.length === 0}
    <p class="header-rules-empty">No rules. Headers pass through unchanged.</p>
  {:else}
    <ul class="header-rules-list">
      {#each rules as rule, index (index)}
        <li class="header-rule">
          <Select
            aria-label={`${legend} rule ${index + 1} action`}
            options={ACTIONS}
            value={rule.action}
            {disabled}
            onchange={(action) => update(index, { action })}
          />
          <input
            type="text"
            aria-label={`${legend} rule ${index + 1} header name`}
            placeholder="Header name, e.g. X-Frame-Options"
            autocomplete="off"
            spellcheck="false"
            value={rule.name}
            aria-invalid={error ? 'true' : undefined}
            {disabled}
            oninput={(event) => update(index, { name: event.currentTarget.value })}
          />
          {#if rule.action === 'set' && hiddenValues && !rule.value}
            <input
              type="text"
              aria-label={`${legend} rule ${index + 1} value`}
              value={HIDDEN_SECRET_TEXT}
              readonly
              disabled
              class="header-rule-hidden"
            />
          {:else if rule.action === 'set'}
            <input
              type="text"
              aria-label={`${legend} rule ${index + 1} value`}
              placeholder="Value"
              autocomplete="off"
              spellcheck="false"
              value={rule.value}
              {disabled}
              oninput={(event) => update(index, { value: event.currentTarget.value })}
            />
          {:else}
            <span class="header-rule-remove-note">Removed before forwarding</span>
          {/if}
          <Button variant="ghost" size="sm" {disabled} aria-label={`Delete ${legend.toLowerCase()} rule ${index + 1}`} onclick={() => remove(index)}>Delete</Button>
        </li>
      {/each}
    </ul>
  {/if}
  <div class="header-rules-actions">
    <Button variant="secondary" size="sm" disabled={disabled || rules.length >= PROXY_LIMITS.maxHeaderRules} onclick={add}>Add header rule</Button>
    <span class="header-rules-count">{rules.length} / {PROXY_LIMITS.maxHeaderRules}</span>
  </div>
  <InlineError id={errorId} message={error ?? ''} />
</fieldset>

<style>
  .header-rules { border: 0; padding: 0; margin: 0; min-width: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
  legend { padding: 0; font-size: var(--fs-sm); font-weight: var(--fw-medium); color: var(--text-secondary); }
  .header-rules-hint, .header-rules-empty { margin: 0; font-size: var(--fs-sm); color: var(--text-muted); line-height: 1.45; }
  .header-rules-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
  .header-rule { display: grid; grid-template-columns: 7rem minmax(0, 1fr) minmax(0, 1fr) auto; gap: var(--sp-2); align-items: center; }
  .header-rule input {
    width: 100%;
    min-width: 0;
    padding: var(--sp-2) var(--sp-3);
    background: var(--surface-input);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    color: var(--text-primary);
    font-size: var(--fs-sm);
    font-family: var(--font-mono);
  }
  .header-rule input.header-rule-hidden { font-family: inherit; color: var(--text-muted); }
  .header-rule input[aria-invalid='true'] { border-color: var(--danger); }
  .header-rule-remove-note { font-size: var(--fs-xs); color: var(--text-muted); }
  .header-rules-actions { display: flex; align-items: center; gap: var(--sp-3); }
  .header-rules-count { font-size: var(--fs-xs); color: var(--text-muted); font-variant-numeric: tabular-nums; }
  @media (max-width: 640px) {
    .header-rule { grid-template-columns: minmax(0, 1fr) auto; }
    .header-rule input { grid-column: 1 / -1; }
  }
</style>
