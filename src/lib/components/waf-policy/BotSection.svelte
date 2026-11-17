<!--
  BotSection: bot protection as one mode (Off / Log only / Score /
  Block), the checks it runs and its User-Agent and JA4 lists. Legacy JA3
  hashes are kept in their own lists (the agent still matches them).
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import Icon from 'svelte-awesome/components/Icon.svelte';
  import chevronRight from 'svelte-awesome/icons/chevronRight';
  import Field from '#lib/components/ui/Field.svelte';
  import { getDefaultUABlocklist, getDefaultJA4Blocklist, getDefaultJA4Allowlist } from '#lib/api.js';
  import PolicySection from './PolicySection.svelte';
  import ChoiceGroup from './ChoiceGroup.svelte';
  import Switch from '#lib/components/ui/Switch.svelte';
  import ReferenceListModal from './ReferenceListModal.svelte';
  import { DEFAULT_BOT_SCORE_THRESHOLD, splitLines, type BotMode } from './model';
  import { fieldId } from './validate';
  import type { WafPolicyForm } from './waf-policy-form.svelte';

  let { form, readonly = false }: { form: WafPolicyForm; readonly?: boolean } = $props();

  const bot = $derived(form.draft.bot);
  const off = $derived(bot.mode === 'off');
  let reference = $state<'ua' | 'ja4-block' | 'ja4-allow' | null>(null);
  let legacyOpen = $state(false);
  const hasLegacy = $derived(bot.ja3Blocklist.trim() !== '' || bot.ja3Allowlist.trim() !== '' || form.baseline.bot.ja3Blocklist.trim() !== '' || form.baseline.bot.ja3Allowlist.trim() !== '');

  $effect(() => {
    const reveal = form.reveal;
    if (reveal?.section === 'bots' && reveal.group === 'legacy-ja3') untrack(() => (legacyOpen = true));
  });

  const MODES: { value: BotMode; label: string; description: string }[] = [
    { value: 'off', label: 'Off', description: 'No bot checks run.' },
    { value: 'log', label: 'Log only', description: 'Bots are forwarded and logged with category Bot. Use to observe first.' },
    { value: 'score', label: 'Score', description: 'A bot score at or above the score threshold blocks a request that already has a weak detection or an incomplete scan. On a clean request it changes nothing.' },
    { value: 'block', label: 'Block', description: 'A detected bot is rejected with 403 immediately.' }
  ];

  const entries = (text: string) => {
    const n = splitLines(text).length;
    return n === 0 ? 'None added' : `${n} added`;
  };

  const referenceConfig = $derived.by(() => {
    if (reference === 'ua') return {
      title: 'Built-in User-Agent blocklist',
      description: 'The agent always uses this list; patterns you add are combined with it.',
      load: async () => {
        const res = await getDefaultUABlocklist();
        return res.data ? { items: res.data.items.map((value) => ({ value })), source: res.data.source } : { error: res.error?.error ?? 'Could not load the list.' };
      }
    };
    if (reference === 'ja4-block' || reference === 'ja4-allow') {
      const block = reference === 'ja4-block';
      return {
        title: block ? 'Built-in JA4 blocklist' : 'Built-in JA4 allowlist',
        description: block
          ? 'TLS fingerprints of automation tools. The agent always uses this list; fingerprints you add are combined with it.'
          : 'TLS fingerprints of common browsers. Matching clients are never scored as bots.',
        load: async () => {
          const res = await (block ? getDefaultJA4Blocklist() : getDefaultJA4Allowlist());
          return res.data ? { items: res.data.items.map((item) => ({ value: item.fingerprint, note: item.comment })), source: res.data.source } : { error: res.error?.error ?? 'Could not load the list.' };
        }
      };
    }
    return null;
  });
</script>

<PolicySection id="bots" title="Bot protection" description="Detect automated clients from their User-Agent, request headers and TLS (JA4) fingerprint." {form}>
  <ChoiceGroup legend="When a bot is detected" name="wp-bot-mode" options={MODES} bind:value={form.draft.bot.mode} disabled={readonly} columns={4} />

  <div class="wp-bot-body" class:is-off={off}>
    {#if off}<p class="wp-note wp-muted">Bot protection is off. The settings below are kept and apply when you pick a mode.</p>{/if}
    <div class="wp-grid">
      <Field label="Bot score" hint="0 to 999. The score a detected bot gets. In Score mode it is compared with the score threshold; in the other modes it is only recorded with the decision." error={form.error('bot.baseScore')} id={fieldId('bot.baseScore')} required>
        {#snippet children(c)}<input {...c} type="number" min="0" max="999" step="1" bind:value={form.draft.bot.baseScore} disabled={readonly} />{/snippet}
      </Field>
      {#if bot.mode === 'score'}
        <Field label="Score threshold" hint="A bot score at or above this value blocks a request that has a weak detection or an incomplete scan." error={form.error('bot.scoreThreshold')} id={fieldId('bot.scoreThreshold')} required>
          {#snippet children(c)}<input {...c} type="number" min="1" max="9999" step="1" placeholder={String(DEFAULT_BOT_SCORE_THRESHOLD)} bind:value={form.draft.bot.scoreThreshold} disabled={readonly} />{/snippet}
        </Field>
      {/if}
    </div>

    <h4 class="wp-subhead">Checks</h4>
    <div class="wp-grid">
      <Switch bind:checked={form.draft.bot.emptyUA} id={fieldId('bot.emptyUA')} disabled={readonly} label="Treat an empty User-Agent as a bot" hint="Requests without a User-Agent, or with “-”." />
      <Switch bind:checked={form.draft.bot.headerChecks} id={fieldId('bot.headerChecks')} disabled={readonly} label="Header checks" hint="Accept and Accept-Language both missing, typical of scripts." />
      <Switch bind:checked={form.draft.bot.clientHints} id={fieldId('bot.clientHints')} disabled={readonly} label="Client Hints consistency" hint="Chromium User-Agents without Sec-CH-UA, HeadlessChrome, or a platform that contradicts the User-Agent." />
      <Switch bind:checked={form.draft.bot.browserImpersonation} id={fieldId('bot.browserImpersonation')} disabled={readonly} label="Browser impersonation" hint="Browser User-Agents sent with script-style headers (for example Accept: */* on a page request)." />
      <Switch bind:checked={form.draft.bot.blockAICrawlers} id={fieldId('bot.blockAICrawlers')} disabled={readonly} label="Block AI crawlers and scrapers" hint="GPTBot, ClaudeBot, Bytespider, CCBot, PerplexityBot, Diffbot and similar." />
    </div>

    <h4 class="wp-subhead">Fingerprint and User-Agent lists <small>added to the built-in lists</small></h4>
    <div class="wp-grid">
      <Field label="JA4 blocklist" hint="TLS fingerprints to treat as bots, one per line. {entries(bot.ja4Blocklist)}." error={form.error('bot.ja4Blocklist')} id={fieldId('bot.ja4Blocklist')}>
        {#snippet labelExtra()}<button type="button" class="wp-link-button" onclick={() => (reference = 'ja4-block')}>Built-in list</button>{/snippet}
        {#snippet children(c)}<textarea {...c} class="wp-textarea is-short" rows="3" spellcheck="false" placeholder="t13d1516h2_8daaf6152771_e562703ab859" bind:value={form.draft.bot.ja4Blocklist} disabled={readonly}></textarea>{/snippet}
      </Field>
      <Field label="JA4 allowlist" hint="TLS fingerprints never scored as bots, one per line. {entries(bot.ja4Allowlist)}." error={form.error('bot.ja4Allowlist')} id={fieldId('bot.ja4Allowlist')}>
        {#snippet labelExtra()}<button type="button" class="wp-link-button" onclick={() => (reference = 'ja4-allow')}>Built-in list</button>{/snippet}
        {#snippet children(c)}<textarea {...c} class="wp-textarea is-short" rows="3" spellcheck="false" placeholder="t13d1516h2_8daaf6152771_b92d69e0f5f8" bind:value={form.draft.bot.ja4Allowlist} disabled={readonly}></textarea>{/snippet}
      </Field>
      <Field label="User-Agent blocklist" hint="Substring or regular expression per line; User-Agents are easy to spoof, so JA4 and Client Hints carry most of the detection. {entries(bot.uaBlocklist)}." error={form.error('bot.uaBlocklist')} id={fieldId('bot.uaBlocklist')}>
        {#snippet labelExtra()}<button type="button" class="wp-link-button" onclick={() => (reference = 'ua')}>Built-in list</button>{/snippet}
        {#snippet children(c)}<textarea {...c} class="wp-textarea" rows="4" spellcheck="false" placeholder={'curl\npython-requests\nscrapy'} bind:value={form.draft.bot.uaBlocklist} disabled={readonly}></textarea>{/snippet}
      </Field>
      <Field label="User-Agent allowlist" hint="A matching User-Agent is never scored as a bot. {entries(bot.uaAllowlist)}." error={form.error('bot.uaAllowlist')} id={fieldId('bot.uaAllowlist')}>
        {#snippet children(c)}<textarea {...c} class="wp-textarea" rows="4" spellcheck="false" placeholder={'Googlebot\nbingbot'} bind:value={form.draft.bot.uaAllowlist} disabled={readonly}></textarea>{/snippet}
      </Field>
    </div>

    {#if hasLegacy}
      <button type="button" class="wp-disclosure wp-legacy" aria-expanded={legacyOpen} aria-controls="wp-legacy-ja3" onclick={() => (legacyOpen = !legacyOpen)}>
        <span class="wp-chevron" aria-hidden="true"><Icon data={chevronRight} scale={0.75} /></span>
        JA3 hashes
        <span class="wp-disclosure-meta">{splitLines(bot.ja3Blocklist).length} blocked · {splitLines(bot.ja3Allowlist).length} allowed</span>
      </button>
      <div id="wp-legacy-ja3" class="wp-disclosure-body" hidden={!legacyOpen}>
        <p class="wp-note">JA3 (MD5) hashes. The agent matches them; they are not JA4 fingerprints and stay in their own lists.</p>
        <div class="wp-grid">
          <Field label="JA3 blocklist" id={fieldId('bot.ja3Blocklist')}>
            {#snippet children(c)}<textarea {...c} class="wp-textarea is-short" rows="3" spellcheck="false" bind:value={form.draft.bot.ja3Blocklist} disabled={readonly}></textarea>{/snippet}
          </Field>
          <Field label="JA3 allowlist" id={fieldId('bot.ja3Allowlist')}>
            {#snippet children(c)}<textarea {...c} class="wp-textarea is-short" rows="3" spellcheck="false" bind:value={form.draft.bot.ja3Allowlist} disabled={readonly}></textarea>{/snippet}
          </Field>
        </div>
      </div>
    {/if}
  </div>
</PolicySection>

{#if referenceConfig}
  <ReferenceListModal open={true} title={referenceConfig.title} description={referenceConfig.description} load={referenceConfig.load} onclose={() => (reference = null)} />
{/if}

<style>
  .wp-bot-body { margin-top: var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-3); min-width: 0; }
  .wp-legacy { margin-top: var(--sp-3); }
</style>
