// What the bot Score mode text says it does.
import './support/runes';
import './support/ssr';
import { describe, expect, test } from 'bun:test';
import { renderComponent } from './support/ssr';

// The UI barrel pulls in PageHeader, which reads `dev` from SvelteKit.
Bun.plugin({
  name: 'app-environment-stub',
  setup(build) {
    build.module('$app/env', () => ({ loader: 'object', exports: { dev: false, browser: false, building: false, version: 'test' } }));
  },
});

const { WafPolicyForm } = await import('../src/lib/components/waf-policy/waf-policy-form.svelte');
const { default: BotSection } = await import('../src/lib/components/waf-policy/BotSection.svelte');

const text = (html: string) => html.replace(/<!--.*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/&#39;|&apos;/g, "'").replace(/\s+/g, ' ');

describe('bot protection score mode', () => {
  test('the Score mode text says what a bot score does', async () => {
    const t = text(await renderComponent(BotSection, { form: WafPolicyForm.fromRules({ bot_protection: { enabled: true, mode: 'score' } }) } as never));
    expect(t).not.toContain('Add to score');
    expect(t).toContain('A bot score at or above the score threshold blocks a request that already has a weak detection or an incomplete scan. On a clean request it changes nothing.');
    expect(t).toContain('In Score mode it is compared with the score threshold; in the other modes it is only recorded with the decision.');
    expect(t).not.toContain('block score');
    expect(t).not.toContain('changes only the score recorded');
  });

  test('Score mode shows its own threshold field with a hint, the other modes do not', async () => {
    const shown = text(await renderComponent(BotSection, { form: WafPolicyForm.fromRules({ bot_protection: { enabled: true, mode: 'score', score_threshold: 180 } }) } as never));
    expect(shown).toContain('Score threshold');
    expect(shown).toContain('A bot score at or above this value blocks a request that has a weak detection or an incomplete scan.');
    const html = await renderComponent(BotSection, { form: WafPolicyForm.fromRules({ bot_protection: { enabled: true, mode: 'score', score_threshold: 180 } }) } as never);
    expect(html).toMatch(/<input[^>]*value="180"/);
    for (const mode of ['log', 'block']) {
      const other = text(await renderComponent(BotSection, { form: WafPolicyForm.fromRules({ bot_protection: { enabled: true, mode } }) } as never));
      expect(other).not.toContain('Score threshold');
    }
  });
});
