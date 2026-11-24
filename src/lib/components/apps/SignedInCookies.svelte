<!--
  SignedInCookies: the session cookie names of the Speed tab. Compression and the cache both tell a signed-in visitor
  by an Authorization header or a session cookie, so the names the application uses live in one place with its own
  Save, beside Compression. They are stored with the cache settings (the agent gets them while compression or the
  cache is on, the cache being off included), so a save sends the stored cache settings with the new names.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { putAppCache, type ApiError } from '#lib/api.js';
  import { focusFormError } from '#lib/focus-error.js';
  import { toast } from '#lib/stores/toast.js';
  import { Alert, Button, Field } from '#lib/components/ui/index.js';
  import type { DeliveryFeed } from './delivery-feed.svelte.js';
  import { COOKIES_HINT, COOKIES_LEAD, classifyCacheRefusal, sameCookieNames, withCookieNames } from './cache';
  import { UNASSIGNED_TEXT } from './speed';

  let {
    projectId,
    appId,
    feed,
    canConfigure = false,
    dirty = $bindable(false),
  }: {
    projectId: string;
    appId: string;
    /** The settings and the agent's report, kept current by the page. */
    feed: DeliveryFeed;
    canConfigure?: boolean;
    /** Unsaved edits; the page asks before leaving the tab. */
    dirty?: boolean;
  } = $props();

  const uid = $props.id();
  const delivery = $derived(feed.state);
  const stored = $derived(delivery?.cache ?? null);
  const readonly = $derived(!canConfigure);
  const storedText = $derived((stored?.session_cookies ?? []).join('\n'));

  let text = $state(untrack(() => storedText));
  let base = untrack(() => storedText);

  // A read replaces the names when the person has not changed them and keeps what they typed.
  $effect(() => {
    const next = storedText;
    untrack(() => {
      if (next === base) return;
      if (text === base) text = next;
      base = next;
    });
  });

  let busy = $state(false);
  let attempted = $state(false);
  let touched = $state(false);
  let serverError = $state<{ message: string; sent: string } | null>(null);
  let saveError = $state<string | null>(null);
  let sectionEl = $state<HTMLElement>();

  const check = $derived(stored ? withCookieNames(stored, text) : null);
  const changed = $derived(stored !== null && !sameCookieNames(stored, text));
  $effect(() => {
    dirty = changed;
  });

  /** The text under the field: after the person left it or tried to save, and a refusal of the server while the field still holds what was sent. */
  const error = $derived.by(() => {
    if (check?.error && (touched || attempted)) return check.error.message;
    return serverError && serverError.sent === text ? serverError.message : undefined;
  });
  const note = $derived(busy ? 'Saving…' : changed ? 'Unsaved changes' : '');

  function refused(failure: ApiError | undefined) {
    const refusal = classifyCacheRefusal(failure);
    if (refusal.kind === 'field' && refusal.field === 'session_cookies') {
      serverError = { message: refusal.message, sent: text };
    } else {
      saveError = refusal.message;
      // An agent that is too old for it has told the control plane so: read the flags again.
      if (refusal.kind === 'too-old') void feed.refresh();
    }
    void focusFormError(sectionEl);
  }

  async function save() {
    if (!canConfigure || busy || !stored || !check) return;
    attempted = true;
    saveError = null;
    if (check.error) {
      void focusFormError(sectionEl);
      return;
    }
    busy = true;
    serverError = null;
    const res = await putAppCache(projectId, appId, check.settings);
    busy = false;
    if (res.error || !res.data) {
      refused(res.error);
      return;
    }
    const next = res.data.cache.session_cookies.join('\n');
    text = next;
    base = next;
    attempted = false;
    touched = false;
    feed.saved({ cache: res.data.cache }, res.data.generation);
    const used = res.data.cache.enabled || delivery?.compression.enabled;
    const agent = delivery?.agent;
    toast.success(!agent ? UNASSIGNED_TEXT : used ? `${agent.name || 'The WAF agent'} applies it with its next configuration bundle.` : 'The names are used once compression or the cache is on.', 'Cookie names saved');
  }
</script>

<section class="sc" aria-labelledby="{uid}-title" bind:this={sectionEl}>
  <h3 id="{uid}-title">Signed-in visitors</h3>
  <p class="sc-lead">{COOKIES_LEAD}</p>
  <div onfocusout={() => (touched = true)}>
    <Field label="Session cookie names" {error} hint={COOKIES_HINT}>
      {#snippet children(c)}
        <textarea {...c} class="mono" rows="3" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="shop_session" disabled={readonly} bind:value={text}></textarea>
      {/snippet}
    </Field>
  </div>
  {#if saveError}
    <Alert tone="error" title="Not saved" message={saveError} />
  {/if}
  <div class="sc-actions">
    <span class="sc-dirty" role="status">{note}</span>
    <Button class="sc-tap" loading={busy} disabled={readonly || busy || !changed} onclick={() => void save()}>Save cookie names</Button>
  </div>
</section>

<style>
  .sc { display: flex; flex-direction: column; gap: var(--sp-3); min-width: 0; padding-top: var(--sp-5); border-top: 1px solid var(--border); }
  .sc h3 { margin: 0; font-size: var(--fs-base); font-weight: var(--fw-semibold); color: var(--text-primary); }
  .sc-lead { margin: calc(var(--sp-1) * -1) 0 0; font-size: var(--fs-sm); color: var(--text-secondary); line-height: 1.5; max-width: 70ch; }
  .sc :global(textarea.mono) { font-family: var(--font-mono); font-size: var(--fs-sm); }

  .sc-actions { display: flex; align-items: center; justify-content: flex-end; gap: var(--sp-2); flex-wrap: wrap; }
  .sc-dirty { margin-right: auto; font-size: var(--fs-sm); color: var(--text-muted); }

  @media (max-width: 760px) {
    .sc-actions { flex-direction: column-reverse; align-items: stretch; }
    .sc-dirty { margin-right: 0; text-align: center; }
    .sc :global(.sc-tap), .sc :global(textarea) { min-height: 44px; }
  }
</style>
