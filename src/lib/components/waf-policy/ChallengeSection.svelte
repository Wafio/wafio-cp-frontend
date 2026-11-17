<!--
  ChallengeSection: serve a JavaScript proof-of-work, click puzzle or
  CAPTCHA before letting a visitor through. IP reputation has its own
  section (IpReputationSection).
-->
<script lang="ts">
  import Field from '#lib/components/ui/Field.svelte';
  import Alert from '#lib/components/ui/Alert.svelte';
  import Select from '#lib/components/ui/Select.svelte';
  import { formatDuration } from '#lib/format.js';
  import PolicySection from './PolicySection.svelte';
  import ChoiceGroup from './ChoiceGroup.svelte';
  import Switch from '#lib/components/ui/Switch.svelte';
  import SecretInput from './SecretInput.svelte';
  import { isHiddenSecret } from '#lib/secret-redaction.js';
  import { type ChallengeType } from './model';
  import { fieldId } from './validate';
  import type { WafPolicyForm } from './waf-policy-form.svelte';

  let { form, readonly = false }: { form: WafPolicyForm; readonly?: boolean } = $props();

  const c = $derived(form.draft.challenge);
  const secretHidden = $derived(isHiddenSecret(form.secrets?.secrets_redacted, form.secrets?.challenge_secret_key_set, form.draft.challenge.secretKey));
  const captcha = $derived(c.type === 'turnstile' || c.type === 'hcaptcha');
  const provider = $derived(c.type === 'turnstile' ? 'Cloudflare Turnstile' : 'hCaptcha');

  const TYPES: { value: ChallengeType; label: string; description: string }[] = [
    { value: 'js_challenge', label: 'JS challenge', description: 'Invisible SHA-256 proof of work plus browser checks, solved in about 100–200 ms. No third party.' },
    { value: 'adaptive', label: 'Adaptive', description: 'Starts with the JS challenge and escalates to the click puzzle when automation is suspected.' },
    { value: 'click_puzzle', label: 'Click puzzle', description: 'A 3×3 grid the visitor solves. Stops headless browsers. No third party.' },
    { value: 'turnstile', label: 'Cloudflare Turnstile', description: 'Hosted CAPTCHA, usually non-interactive. Needs a site key and secret.' },
    { value: 'hcaptcha', label: 'hCaptcha', description: 'Hosted privacy-focused CAPTCHA. Needs a site key and secret.' }
  ];

  const TRIGGERS: { value: typeof c.trigger; label: string }[] = [
    { value: 'always', label: 'Every new visitor' },
    { value: 'on_bot_detect', label: 'Only on bot detection' }
  ];
  const POW_DIFFICULTIES = [
    { value: 8, label: 'Light: 8 bits (about 20 to 50 ms)' },
    { value: 12, label: 'Standard: 12 bits (about 100 to 200 ms)' },
    { value: 14, label: 'Elevated: 14 bits (about 300 to 500 ms)' },
    { value: 16, label: 'Aggressive: 16 bits (about 0.8 to 1.5 s)' }
  ];
</script>

<PolicySection id="challenge" title="Bot challenge" description="Ask visitors without a valid challenge cookie to prove they run a real browser. A solved challenge sets a signed cookie for the configured lifetime." {form}>
  <div class="wp-stack">
    <Switch bind:checked={form.draft.challenge.enabled} id={fieldId('challenge.enabled')} disabled={readonly} label="Challenge visitors" />
    <Switch bind:checked={form.draft.challenge.allowLocalIPs} id={fieldId('challenge.allowLocalIPs')} disabled={readonly}
      label="Skip local and private addresses"
      hint="Loopback, RFC 1918 and CGNAT (100.64.0.0/10) clients skip the challenge. Recommended for health checks and internal services. IP reputation never checks these addresses." />
  </div>

  {#if c.enabled}
    <div class="wp-challenge">
      <ChoiceGroup legend="Challenge type" name="wp-challenge-type" options={TYPES} bind:value={form.draft.challenge.type} disabled={readonly} />

      <div class="wp-grid">
        {#if captcha}
          <Field label="{provider} site key" hint="Public key from the provider dashboard; it is included in the page." error={form.error('challenge.siteKey')} id={fieldId('challenge.siteKey')} required>
            {#snippet children(ctl)}<input {...ctl} type="text" spellcheck="false" autocomplete="off" bind:value={form.draft.challenge.siteKey} disabled={readonly} />{/snippet}
          </Field>
          <Field label="{provider} secret key" hint="Used by the agent to verify tokens; never sent to visitors." error={form.error('challenge.secretKey')} id={fieldId('challenge.secretKey')} required>
            {#snippet children(ctl)}<SecretInput {...ctl} label="{provider} secret key" bind:value={form.draft.challenge.secretKey} disabled={readonly} hidden={secretHidden} />{/snippet}
          </Field>
        {:else}
          <Field label="Cookie signing secret" hint="HMAC key that signs the challenge cookie. Empty = the agent generates one. Changing it invalidates existing cookies." id={fieldId('challenge.secretKey')} optional class="wp-span-2">
            {#snippet children(ctl)}<SecretInput {...ctl} label="cookie signing secret" generate bind:value={form.draft.challenge.secretKey} disabled={readonly} hidden={secretHidden} />{/snippet}
          </Field>
        {/if}
        <Field label="Cookie lifetime (seconds)" hint="60 seconds to 24 hours (86,400). {typeof c.cookieTTL === 'number' && c.cookieTTL > 0 ? formatDuration(c.cookieTTL, 's') : ''}" error={form.error('challenge.cookieTTL')} id={fieldId('challenge.cookieTTL')} required>
          {#snippet children(ctl)}<input {...ctl} type="number" min="60" max="86400" step="1" bind:value={form.draft.challenge.cookieTTL} disabled={readonly} />{/snippet}
        </Field>
        <Field label="Challenge" hint="Every visitor without a valid cookie, or only clients that bot protection flags." id={fieldId('challenge.trigger')}>
          {#snippet children(ctl)}
            <Select {...ctl} options={TRIGGERS} bind:value={form.draft.challenge.trigger} disabled={readonly} />
          {/snippet}
        </Field>
        {#if c.type === 'js_challenge' || c.type === 'adaptive'}
          <Field label="Proof-of-work difficulty" hint="CPU cost for the client; higher values slow automated clients more." id={fieldId('challenge.powDifficulty')}>
            {#snippet children(ctl)}
              <Select {...ctl} options={POW_DIFFICULTIES} bind:value={form.draft.challenge.powDifficulty} disabled={readonly} />
            {/snippet}
          </Field>
        {/if}
      </div>

      <h4 class="wp-subhead">Testing and allowlist</h4>
      <Switch bind:checked={form.draft.challenge.simulation} id={fieldId('challenge.simulation')} disabled={readonly}
        label="Simulation mode"
        hint="Shows the challenge on every request, even after it was solved. For testing only." />
      {#if c.simulation}
        <Alert tone="warning" compact>Simulation mode challenges every request. Turn it off before production traffic reaches this policy.</Alert>
      {/if}
      <Field label="Good bot allowlist" hint="User-Agent substrings (case-insensitive), one per line, that skip the challenge. Empty = the 17 built-in crawlers. Googlebot and Bingbot are verified by IP range; the others by User-Agent only." id={fieldId('challenge.goodBotAllowlist')} optional>
        {#snippet children(ctl)}<textarea {...ctl} class="wp-textarea" rows="4" spellcheck="false" placeholder={'Googlebot\nbingbot\nDuckDuckBot'} bind:value={form.draft.challenge.goodBotAllowlist} disabled={readonly}></textarea>{/snippet}
      </Field>
    </div>
  {/if}
</PolicySection>

<style>
  .wp-challenge { display: flex; flex-direction: column; gap: var(--sp-4); margin-top: var(--sp-4); min-width: 0; }
  .wp-challenge :global(.wp-subhead) { margin-bottom: 0; }
</style>
