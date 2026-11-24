<!--
  CacheSection: the Cache part of the Speed tab. A switch, the two lifetimes, the path rules, the limits folded under
  "Advanced limits", one status line, the numbers of the last hour and its own Save; below them the removal of stored
  copies. A switch saves nothing by itself. Saves that delete or share copies ask first (turning the cache off, a
  disk space below what the copies use, a rule for signed-in visitors that needs the prefix typed). The settings and
  what the agent reported come from the page's feed.
-->
<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { purgeAppCache, putAppCache, type ApiError, type AppCache } from '#lib/api.js';
  import { needsConfirmation } from '#lib/confirm-tiers.js';
  import { focusFormError } from '#lib/focus-error.js';
  import { toast } from '#lib/stores/toast.js';
  import { Alert, Button, ConfirmModal, DateTime, Field, Select, Switch } from '#lib/components/ui/index.js';
  import ChoiceGroup from '#lib/components/waf-policy/ChoiceGroup.svelte';
  import LifetimeInput from './LifetimeInput.svelte';
  import PartStatus from './PartStatus.svelte';
  import type { DeliveryFeed } from './delivery-feed.svelte.js';
  import { mergeEdits } from './tls';
  import {
    CACHE_FIXED,
    CACHE_LEAD,
    CACHE_LIMITS,
    CACHE_SWITCH_HINT,
    COOKIES_IN_CACHE,
    PURGE_APP_CONFIRM_BODY,
    REMOVE_EMPTY,
    REMOVE_HINT_PREFIX,
    REMOVE_HINT_URL,
    RULES_EMPTY,
    RULES_LEAD,
    RULE_SIGNED_IN_HINT,
    cacheConfirmText,
    cacheConfirmations,
    cacheForm,
    cacheInput,
    cacheNumbers,
    cacheSkipLines,
    classifyCacheRefusal,
    classifyPurgeRefusal,
    emptyRule,
    inAdvanced,
    nextQuestion,
    normalizeCache,
    normalizePurge,
    purgeAppConfirmTitle,
    purgeAsksFirst,
    purgeView,
    removalBlockedText,
    ruleFieldOf,
    sameCache,
    type CacheConfirm,
    type CacheField,
    type CacheForm,
    type ConfirmText,
    type PurgeScope,
  } from './cache';
  import { UNASSIGNED_TEXT, partLine, tooOld } from './speed';

  let {
    projectId,
    appId,
    appName = '',
    feed,
    canConfigure = false,
    dirty = $bindable(false),
  }: {
    projectId: string;
    appId: string;
    /** Named in the question before everything is removed. */
    appName?: string;
    /** The settings and the agent's report, kept current by the page. */
    feed: DeliveryFeed;
    canConfigure?: boolean;
    /** Unsaved edits; the page asks before leaving the tab. */
    dirty?: boolean;
  } = $props();

  const uid = $props.id();
  const DEFAULT_CACHE: AppCache = {
    enabled: false,
    default_ttl_s: 3600,
    stale_if_error_s: 600,
    disk_bytes: 1 << 30,
    memory_bytes: 32 << 20,
    max_object_bytes: 8 << 20,
    session_cookies: [],
    rules: [],
  };

  // ── Data ────────────────────────────────────────────────────────────────
  const delivery = $derived(feed.state);
  const agent = $derived(delivery?.agent ?? null);
  const agentName = $derived(agent?.name ?? '');
  const readonly = $derived(!canConfigure);
  const stored = $derived(delivery?.cache ?? DEFAULT_CACHE);

  let form = $state<CacheForm>(untrack(() => cacheForm(feed.state?.cache ?? DEFAULT_CACHE)));
  let base = untrack(() => cacheForm(feed.state?.cache ?? DEFAULT_CACHE));

  // A read replaces what the person has not changed and keeps what they typed.
  $effect(() => {
    const settings = feed.state?.cache;
    if (!settings) return;
    const next = cacheForm(settings);
    untrack(() => {
      if (JSON.stringify(next) === JSON.stringify(base)) return;
      form = mergeEdits(form, base, next);
      base = next;
    });
  });

  // ── Checks and what the form shows ──────────────────────────────────────
  let busy = $state(false);
  let attempted = $state(false);
  let touched = $state<Record<string, boolean>>({});
  let serverError = $state<{ field: CacheField; message: string; sent: string } | null>(null);
  let saveError = $state<string | null>(null);
  let advanced = $state(false);
  let steps = $state<CacheConfirm[]>([]);
  let sectionEl = $state<HTMLElement>();
  let rulesEl = $state<HTMLElement>();
  let addEl = $state<HTMLElement>();

  const check = $derived(normalizeCache(cacheInput(form)));
  const formDirty = $derived(!sameCache(form, stored));
  $effect(() => {
    dirty = formDirty;
  });

  function fieldValue(field: CacheField): unknown {
    const rule = ruleFieldOf(field);
    if (rule) {
      const row = form.rules[rule.index];
      return rule.part === 'prefix' ? row?.prefix : rule.part === 'action' ? row?.action : row?.ttl;
    }
    switch (field) {
      case 'default_ttl_s': return form.defaultTtl;
      case 'stale_if_error_s': return form.staleIfError;
      case 'disk_bytes': return form.disk;
      case 'memory_bytes': return form.memory;
      case 'max_object_bytes': return form.object;
      default: return form.rules.length;
    }
  }

  /** The text under a field: after the person left it or tried to save, and a refusal of the server while the field still holds what was sent. */
  function shown(field: CacheField): string | undefined {
    if (check.error?.field === field && (touched[field] || attempted)) return check.error.message;
    if (serverError?.field === field && serverError.sent === JSON.stringify(fieldValue(field))) return serverError.message;
    return undefined;
  }
  const touch = (field: string) => (touched[field] = true);
  const ruleError = (index: number, part: 'prefix' | 'action' | 'ttl_s') => shown(`rules[${index}].${part}`);

  const ttlError = $derived(shown('default_ttl_s'));
  const staleError = $derived(shown('stale_if_error_s'));
  const diskError = $derived(shown('disk_bytes'));
  const memoryError = $derived(shown('memory_bytes'));
  const objectError = $derived(shown('max_object_bytes'));
  const rulesError = $derived(shown('rules'));

  // ── The line under the part, the numbers, the lock ──────────────────────
  const line = $derived(partLine({ delivery, now: feed.now, waitingSince: feed.waitingSince, quiet: ['unassigned'], part: 'cache', inUse: stored.enabled }));
  // An agent that is too old cannot be switched on and its settings cannot change, but a cache that is on can be turned off.
  const old = $derived(tooOld(delivery, 'cache'));
  const locked = $derived(old && !stored.enabled);
  const limits = $derived({ diskBytes: stored.disk_bytes, memoryBytes: stored.memory_bytes, maxObjectBytes: stored.max_object_bytes });
  const numbers = $derived(stored.enabled ? cacheNumbers(delivery?.cache_stats ?? null, limits) : []);
  const skips = $derived(stored.enabled ? cacheSkipLines(delivery?.cache_stats ?? null, limits) : []);
  const noNumbers = $derived(stored.enabled && numbers.length === 0 && line?.tone === 'success');
  const note = $derived(busy ? 'Saving…' : formDirty ? 'Unsaved changes' : '');

  // ── Rules ───────────────────────────────────────────────────────────────
  const ACTIONS = [
    { value: 'cache' as const, label: 'Keep for a time' },
    { value: 'bypass' as const, label: 'Never keep' },
  ];

  /** The rows move, so what was left in them is no longer tied to the place it was left in. */
  function forgetRuleTouches() {
    for (const key of Object.keys(touched)) if (key.startsWith('rules[')) delete touched[key];
  }

  async function addRule() {
    form.rules = [...form.rules, emptyRule()];
    forgetRuleTouches();
    await tick();
    const inputs = rulesEl?.querySelectorAll<HTMLInputElement>('input[data-rule-prefix]');
    inputs?.[inputs.length - 1]?.focus();
  }

  async function removeRule(index: number) {
    form.rules = form.rules.filter((_, i) => i !== index);
    forgetRuleTouches();
    await tick();
    addEl?.querySelector('button')?.focus();
  }

  // ── Saving ──────────────────────────────────────────────────────────────
  function refused(error: ApiError | undefined) {
    const refusal = classifyCacheRefusal(error);
    if (refusal.kind === 'field') {
      serverError = { field: refusal.field, message: refusal.message, sent: JSON.stringify(fieldValue(refusal.field)) };
      if (refusal.advanced) advanced = true;
    } else {
      saveError = refusal.message;
      // An agent that is too old for it has told the control plane so: read the flags again.
      if (refusal.kind === 'too-old') void feed.refresh();
    }
    void focusFormError(sectionEl);
  }

  function askSave() {
    if (!canConfigure || busy || !delivery) return;
    attempted = true;
    saveError = null;
    const result = check;
    if (result.error) {
      if (inAdvanced(result.error.field)) advanced = true;
      void focusFormError(sectionEl);
      return;
    }
    const asked = cacheConfirmations(stored, result.settings, delivery.cache_stats?.disk_bytes ?? null).filter((step) => needsConfirmation(step.kind));
    if (asked.length > 0) steps = asked;
    else void save();
  }

  /** The last question runs the save; an earlier one passes on to the next. */
  function confirmStep() {
    const rest = nextQuestion(steps);
    if (rest) steps = rest;
    else void save();
  }

  async function save() {
    const result = check;
    if (!canConfigure || busy || !delivery || result.error) return;
    busy = true;
    saveError = null;
    serverError = null;
    const res = await putAppCache(projectId, appId, result.settings);
    busy = false;
    steps = [];
    if (res.error || !res.data) {
      refused(res.error);
      return;
    }
    const next = cacheForm(res.data.cache);
    form = next;
    base = next;
    attempted = false;
    touched = {};
    feed.saved({ cache: res.data.cache }, res.data.generation);
    toast.success(agent ? `${agentName || 'The WAF agent'} applies it with its next configuration bundle.` : UNASSIGNED_TEXT, 'Cache saved');
  }

  // The question on screen. It stays readable while the dialog closes, and a new question starts with an empty input.
  const current = $derived<ConfirmText | null>(steps[0] ? cacheConfirmText(steps[0]) : null);
  let lastText = $state<ConfirmText | null>(null);
  $effect(() => {
    if (current) lastText = current;
  });
  const question = $derived(current ?? lastText);
  const questionKey = $derived(current ? `${current.title}` : 'none');

  // ── Removing copies ─────────────────────────────────────────────────────
  const SCOPES: { value: PurgeScope; label: string }[] = [
    { value: 'url', label: 'One address' },
    { value: 'prefix', label: 'Everything under a path' },
    { value: 'app', label: 'Everything' },
  ];

  let scope = $state<PurgeScope>('url');
  let address = $state('');
  let purging = $state(false);
  let purgeAsked = $state(false);
  let purgeTouched = $state(false);
  let purgeConfirm = $state(false);
  let purgeRefused = $state<{ message: string; sent: string } | null>(null);
  let purgeFailed = $state<string | null>(null);
  let removeEl = $state<HTMLElement>();

  const blocked = $derived(delivery ? removalBlockedText(delivery) : null);
  const purgeCheck = $derived(normalizePurge(scope, address));
  const addressError = $derived.by(() => {
    if (purgeCheck.error?.field === 'url' && (purgeTouched || purgeAsked)) return purgeCheck.error.message;
    return purgeRefused && purgeRefused.sent === `${scope}:${address}` ? purgeRefused.message : undefined;
  });
  const purges = $derived(delivery?.purges ?? []);

  function askPurge() {
    if (!canConfigure || purging || blocked) return;
    purgeAsked = true;
    purgeFailed = null;
    if (purgeCheck.error) {
      void focusFormError(removeEl);
      return;
    }
    if (purgeAsksFirst(scope)) purgeConfirm = true;
    else void purge();
  }

  async function purge() {
    const result = purgeCheck;
    if (!canConfigure || purging || blocked || result.error) return;
    purging = true;
    purgeFailed = null;
    purgeRefused = null;
    const res = await purgeAppCache(projectId, appId, scope === 'app' ? { scope } : { scope, url: result.url });
    purging = false;
    purgeConfirm = false;
    if (res.error || !res.data) {
      const refusal = classifyPurgeRefusal(res.error, agentName);
      if (refusal.kind === 'field') purgeRefused = { message: refusal.message, sent: `${scope}:${address}` };
      else {
        purgeFailed = refusal.message;
        if (refusal.refresh) void feed.refresh();
      }
      void focusFormError(removeEl);
      return;
    }
    purgeAsked = false;
    purgeTouched = false;
    address = '';
    feed.purged(res.data);
  }
</script>

<section class="cs" aria-labelledby="{uid}-title" bind:this={sectionEl}>
  <h3 id="{uid}-title">Cache</h3>
  <p class="cs-lead">{CACHE_LEAD}</p>
  <Switch bind:checked={form.enabled} label="Keep copies of answers" hint={CACHE_SWITCH_HINT} disabled={readonly || busy || locked} />
  <PartStatus {line} />

  <fieldset class="cs-fieldset" disabled={readonly || old}>
    <div onfocusout={() => touch('default_ttl_s')}>
      <Field
        label="Keep images, styles, scripts and fonts for"
        error={ttlError}
        hint="When your application does not say how long. Pages and data are kept only when your application says so. 0 turns this off."
      >
        {#snippet children(c)}
          <LifetimeInput control={c} label="Keep images, styles, scripts and fonts for" placeholder="Off" bind:value={form.defaultTtl} disabled={readonly || old} />
        {/snippet}
      </Field>
    </div>
    <div onfocusout={() => touch('stale_if_error_s')}>
      <Field
        label="When your application is down, keep sending stored copies for"
        error={staleError}
        hint="Visitors get the last good copy instead of an error page. 0 sends the error."
      >
        {#snippet children(c)}
          <LifetimeInput control={c} label="When your application is down, keep sending stored copies for" placeholder="Off" bind:value={form.staleIfError} disabled={readonly || old} />
        {/snippet}
      </Field>
    </div>

    <fieldset class="cs-rules" bind:this={rulesEl} aria-describedby="{uid}-rules-lead">
      <legend>Path rules</legend>
      <p class="cs-note" id="{uid}-rules-lead">{RULES_LEAD}</p>
      {#if form.rules.length === 0}
        <p class="cs-note">{RULES_EMPTY}</p>
      {:else}
        <ul class="cs-rule-list">
          {#each form.rules as rule, i (i)}
            <li>
              <fieldset class="cs-rule">
                <legend class="sr-only">Path rule {i + 1}</legend>
                <div onfocusout={() => touch(`rules[${i}].prefix`)}>
                  <Field label="Path starts with" error={ruleError(i, 'prefix')}>
                    {#snippet children(c)}
                      <input {...c} class="mono" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="/blog/" data-rule-prefix bind:value={rule.prefix} />
                    {/snippet}
                  </Field>
                </div>
                <Field label="What to do" error={ruleError(i, 'action')}>
                  {#snippet children(c)}
                    <Select {...c} class="cs-select" options={ACTIONS} bind:value={rule.action} disabled={readonly || old} />
                  {/snippet}
                </Field>
                {#if rule.action === 'cache'}
                  <div onfocusout={() => touch(`rules[${i}].ttl_s`)}>
                    <Field label="Keep for" error={ruleError(i, 'ttl_s')}>
                      {#snippet children(c)}
                        <LifetimeInput control={c} label={`Rule ${i + 1}, keep for`} placeholder="Required" bind:value={rule.ttl} disabled={readonly || old} />
                      {/snippet}
                    </Field>
                  </div>
                  <Field layout="inline" label="Also for signed-in visitors" hint={RULE_SIGNED_IN_HINT}>
                    {#snippet children(c)}
                      <input {...c} type="checkbox" bind:checked={rule.signedIn} disabled={readonly || old} />
                    {/snippet}
                  </Field>
                {/if}
                <div class="cs-rule-end">
                  <Button variant="ghost" size="sm" class="cs-tap" disabled={readonly || old} aria-label="Delete rule {i + 1}" onclick={() => void removeRule(i)}>Delete rule</Button>
                </div>
              </fieldset>
            </li>
          {/each}
        </ul>
      {/if}
      {#if rulesError}<p class="cs-error" role="alert">{rulesError}</p>{/if}
      <div class="cs-add" bind:this={addEl}>
        <Button variant="secondary" size="sm" class="cs-tap" disabled={readonly || old || form.rules.length >= CACHE_LIMITS.rules} onclick={() => void addRule()}>Add a path rule</Button>
        <span class="cs-count">{form.rules.length} of {CACHE_LIMITS.rules} rules</span>
      </div>
    </fieldset>

    <details class="cs-advanced" bind:open={advanced}>
      <summary>Advanced limits</summary>
      <div class="cs-advanced-body">
        <div onfocusout={() => touch('disk_bytes')}>
          <Field label="Disk space" error={diskError} hint="The most this application's copies may use on disk. When it is full, WAFio removes the least used copies first.">
            {#snippet children(c)}
              <input {...c} class="cs-short" type="text" autocomplete="off" spellcheck="false" placeholder="1 GiB" bind:value={form.disk} />
            {/snippet}
          </Field>
        </div>
        <div onfocusout={() => touch('memory_bytes')}>
          <Field label="Memory for hot copies" error={memoryError} hint="Small copies asked for often are also kept in the agent's memory. 0 keeps them on disk only.">
            {#snippet children(c)}
              <input {...c} class="cs-short" type="text" autocomplete="off" spellcheck="false" placeholder="32 MiB" bind:value={form.memory} />
            {/snippet}
          </Field>
        </div>
        <div onfocusout={() => touch('max_object_bytes')}>
          <Field label="Largest answer to keep" error={objectError} hint="Bigger answers always come from your application.">
            {#snippet children(c)}
              <input {...c} class="cs-short" type="text" autocomplete="off" spellcheck="false" placeholder="8 MiB" bind:value={form.object} />
            {/snippet}
          </Field>
        </div>
        <p class="cs-note">{COOKIES_IN_CACHE}</p>
      </div>
    </details>
  </fieldset>

  <p class="cs-fixed">{CACHE_FIXED}</p>
  {#if numbers.length > 0}
    <div class="cs-numbers" aria-live="polite">
      {#each numbers as text (text)}<p>{text}</p>{/each}
    </div>
  {:else if noNumbers}
    <p class="cs-numbers">No numbers from {agentName} yet.</p>
  {/if}
  {#if skips.length > 0}
    <ul class="cs-skips">
      {#each skips as text (text)}<li>{text}</li>{/each}
    </ul>
  {/if}
  {#if saveError}
    <Alert tone="error" title="Not saved" message={saveError} />
  {/if}
  <div class="cs-actions">
    <span class="cs-dirty" role="status">{note}</span>
    <Button class="cs-tap" loading={busy} disabled={readonly || busy || !formDirty} onclick={askSave}>Save cache</Button>
  </div>

  <section class="cs-remove" aria-labelledby="{uid}-remove" bind:this={removeEl}>
    <h4 id="{uid}-remove">Remove stored copies</h4>
    {#if blocked}<p class="cs-note cs-blocked">{blocked}</p>{/if}
    <fieldset class="cs-fieldset" disabled={readonly || blocked !== null}>
      <ChoiceGroup
        legend="What to remove"
        name="{uid}-scope"
        options={SCOPES}
        bind:value={scope}
        columns={3}
        disabled={readonly || blocked !== null}
        onchange={() => {
          purgeTouched = false;
          purgeAsked = false;
          purgeRefused = null;
        }}
      />
      {#if scope !== 'app'}
        <div onfocusout={() => (purgeTouched = true)}>
          <Field label={scope === 'url' ? 'Address' : 'Path starts with'} error={addressError} hint={scope === 'url' ? REMOVE_HINT_URL : REMOVE_HINT_PREFIX}>
            {#snippet children(c)}
              <input
                {...c}
                class="mono"
                type="text"
                autocomplete="off"
                autocapitalize="off"
                spellcheck="false"
                placeholder={scope === 'url' ? 'https://shop.example.com/products/42' : '/blog/'}
                bind:value={address}
              />
            {/snippet}
          </Field>
        </div>
      {/if}
    </fieldset>
    {#if purgeFailed}
      <Alert tone="error" title="Not removed" message={purgeFailed} />
    {/if}
    <div class="cs-actions">
      <Button variant="secondary" class="cs-tap" loading={purging} disabled={readonly || purging || blocked !== null} onclick={askPurge}>Remove copies</Button>
    </div>

    <div aria-live="polite">
      {#if purges.length === 0}
        <p class="cs-note">{REMOVE_EMPTY}</p>
      {:else}
        <ul class="cs-purges">
          {#each purges as row (row.id)}
            {@const view = purgeView(row, agent, feed.now)}
            <li class="cs-purge">
              <p class="cs-purge-what" class:mono={view.address}>{view.what}</p>
              <p class="cs-purge-by">{view.by}, <DateTime value={row.created_at} /></p>
              <Alert compact tone={view.tone} role="none"><p>{view.state}</p></Alert>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </section>
</section>

{#key questionKey}
  <ConfirmModal
    open={steps.length > 0}
    tone={question?.tone ?? 'warning'}
    title={question?.title ?? ''}
    confirmLabel={question?.confirmLabel ?? 'Confirm'}
    cancelLabel="Cancel"
    requireText={question?.requireText ?? ''}
    loading={busy}
    onconfirm={confirmStep}
    onclose={() => (steps = [])}
  >
    <p class="cs-confirm">{question?.body ?? ''}</p>
  </ConfirmModal>
{/key}

<ConfirmModal
  open={purgeConfirm}
  tone="warning"
  title={purgeAppConfirmTitle(appName)}
  confirmLabel="Remove all copies"
  cancelLabel="Cancel"
  loading={purging}
  onconfirm={() => void purge()}
  onclose={() => (purgeConfirm = false)}
>
  <p class="cs-confirm">{PURGE_APP_CONFIRM_BODY}</p>
</ConfirmModal>

<style>
  .cs { display: flex; flex-direction: column; gap: var(--sp-3); min-width: 0; padding-top: var(--sp-5); border-top: 1px solid var(--border); }
  .cs h3 { margin: 0; font-size: var(--fs-base); font-weight: var(--fw-semibold); color: var(--text-primary); }
  .cs-lead { margin: calc(var(--sp-1) * -1) 0 0; font-size: var(--fs-sm); color: var(--text-secondary); line-height: 1.5; max-width: 70ch; }
  .cs-fixed { margin: var(--sp-1) 0 0; font-size: var(--fs-sm); color: var(--text-muted); line-height: 1.5; max-width: 70ch; }
  .cs-note { margin: 0; font-size: var(--fs-sm); color: var(--text-muted); line-height: 1.5; max-width: 70ch; }
  .cs-fieldset { display: flex; flex-direction: column; gap: var(--sp-4); border: 0; padding: 0; margin: 0; min-width: 0; }
  .cs :global(input.mono) { font-family: var(--font-mono); font-size: var(--fs-sm); }
  .cs-short { max-width: 14rem; }
  .cs-error { margin: 0; font-size: var(--fs-sm); color: var(--danger); }

  .cs-rules { display: flex; flex-direction: column; gap: var(--sp-2); border: 0; padding: 0; margin: 0; min-width: 0; }
  .cs-rules > legend { padding: 0; margin-bottom: var(--sp-1); font-size: var(--fs-sm); font-weight: var(--fw-medium); color: var(--text-secondary); }
  .cs-rule-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-3); }
  .cs-rule {
    display: grid;
    grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
    gap: var(--sp-3) var(--sp-4);
    align-items: start;
    min-width: 0;
    margin: 0;
    padding: var(--sp-3) var(--sp-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--bg-secondary);
  }
  .cs-rule-end { grid-column: 1 / -1; display: flex; justify-content: flex-end; }
  .cs-add { display: flex; align-items: center; gap: var(--sp-3); flex-wrap: wrap; }
  .cs-count { font-size: var(--fs-xs); color: var(--text-muted); font-variant-numeric: tabular-nums; }

  .cs-advanced { border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--bg-secondary); }
  .cs-advanced > summary { cursor: pointer; padding: var(--sp-3) var(--sp-4); font-size: var(--fs-sm); font-weight: var(--fw-semibold); color: var(--text-primary); }
  .cs-advanced-body { display: flex; flex-direction: column; gap: var(--sp-4); padding: 0 var(--sp-4) var(--sp-4); }

  /* The region of an empty line stays in the page for screen readers and takes no room. */
  .cs :global(.part-status:empty) { margin-top: calc(var(--sp-3) * -1); }
  .cs-numbers { display: flex; flex-direction: column; gap: var(--sp-1); margin: 0; font-size: var(--fs-sm); color: var(--text-secondary); line-height: 1.5; }
  .cs-numbers p { margin: 0; }
  .cs-skips { margin: 0; padding-left: var(--sp-5); display: flex; flex-direction: column; gap: var(--sp-1); font-size: var(--fs-sm); color: var(--text-secondary); line-height: 1.5; max-width: 70ch; }
  .cs-confirm { margin: 0; color: var(--text-secondary); line-height: 1.5; }

  .cs-actions { display: flex; align-items: center; justify-content: flex-end; gap: var(--sp-2); flex-wrap: wrap; }
  .cs-dirty { margin-right: auto; font-size: var(--fs-sm); color: var(--text-muted); }

  .cs-remove { display: flex; flex-direction: column; gap: var(--sp-3); margin-top: var(--sp-4); padding-top: var(--sp-4); border-top: 1px solid var(--border); min-width: 0; }
  .cs-remove h4 { margin: 0; font-size: var(--fs-base); font-weight: var(--fw-semibold); color: var(--text-primary); }
  .cs-blocked { color: var(--text-secondary); }
  .cs-purges { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-2); }
  .cs-purge { display: flex; flex-direction: column; gap: 2px; padding: var(--sp-3); border: 1px solid var(--border); border-radius: var(--radius); min-width: 0; }
  .cs-purge p { margin: 0; font-size: var(--fs-sm); line-height: 1.5; overflow-wrap: anywhere; }
  .cs-purge-what { color: var(--text-primary); font-weight: var(--fw-medium); }
  .cs-purge-what.mono { font-family: var(--font-mono); }
  .cs-purge-by { color: var(--text-muted); }

  @media (max-width: 760px) {
    .cs-actions { flex-direction: column-reverse; align-items: stretch; }
    .cs-dirty { margin-right: 0; text-align: center; }
    .cs :global(.cs-tap), .cs :global(input[type='text']), .cs :global(.lifetime-unit button), .cs :global(.cs-select button) { min-height: 44px; }
    .cs :global(input[type='checkbox']) { width: 1.5rem; height: 1.5rem; }
    .cs :global(.layout-inline .field-label) { display: inline-flex; align-items: center; min-height: 44px; }
    .cs-short { max-width: none; }
    .cs-rule { grid-template-columns: minmax(0, 1fr); padding: var(--sp-3); }
    .cs :global(.cs-select) { width: 100%; }
    .cs-rule-end { justify-content: stretch; }
    .cs-rule-end :global(.cs-tap) { width: 100%; }
    .cs :global(.wp-choice-options) { grid-template-columns: minmax(0, 1fr); }
    .cs-advanced > summary { min-height: 44px; display: flex; align-items: center; }
  }
</style>
