// What the policy editor shows: the engine table, the inspection switches, and no scores and no wording of the removed
// rule engine, detection level or confidence, also for a v1 document.
import './support/runes';
import './support/ssr';
import { describe, expect, test } from 'bun:test';
import { v1Rules } from './support/waf-policy-fixtures';
import { renderComponent } from './support/ssr';
import { newPathRule } from '../src/lib/components/waf-policy/model';

// The UI barrel pulls in PageHeader, which reads `dev` from SvelteKit.
Bun.plugin({
  name: 'app-environment-stub',
  setup(build) {
    build.module('$app/env', () => ({ loader: 'object', exports: { dev: false, browser: false, building: false, version: 'test' } }));
  },
});

const { WafPolicyForm } = await import('../src/lib/components/waf-policy/waf-policy-form.svelte');
const { default: InspectionOptions } = await import('../src/lib/components/waf-policy/InspectionOptions.svelte');
const { default: EngineTable } = await import('../src/lib/components/waf-policy/EngineTable.svelte');
const { default: ProtectionSection } = await import('../src/lib/components/waf-policy/ProtectionSection.svelte');
const { default: PathRuleEditor } = await import('../src/lib/components/waf-policy/PathRuleEditor.svelte');

const OLD_WORDS = /crs|coraza|rule.?set|rule-based|detection level|confidence|paranoia|semantic.only/i;

describe('inspection options', () => {
  test('a v1 document shows the two inspection switches, and no score, engine or category table', async () => {
    const form = WafPolicyForm.fromRules(v1Rules());
    const html = await renderComponent(InspectionOptions, { form } as never);
    expect(html).toContain('Inspection off');
    expect(html).toContain('Scan all request headers');
    expect(html).toContain('role="switch"');
    expect(html).not.toContain('Decision score');
    expect(html).not.toContain('Category scores');
    expect(html).not.toContain('Detection engines');
    expect(html).not.toMatch(OLD_WORDS);
  });

  test('the switch follows the stored flags', async () => {
    const off = await renderComponent(EngineTable, { form: WafPolicyForm.fromRules({ semantic_policies: { inspection_off: true } }) } as never);
    expect(off).toContain('Inspection is off, so these choices have no effect until it is on again.');
    // A version 1 document: disable_semantic alone, or the pair, is off too.
    for (const flags of [{ disable_semantic: true }, { disable_semantic: true, disable_rule_based: true }]) {
      const v1 = await renderComponent(EngineTable, { form: WafPolicyForm.fromRules({ semantic_policies: flags }) } as never);
      expect(v1).toContain('Inspection is off, so these choices have no effect');
    }
    const loneRuleFlag = await renderComponent(EngineTable, { form: WafPolicyForm.fromRules({ semantic_policies: { disable_rule_based: true } }) } as never);
    expect(loneRuleFlag).not.toContain('Inspection is off');
    const scan = await renderComponent(InspectionOptions, { form: WafPolicyForm.fromRules({ semantic_policies: { inspection_off: true } }) } as never);
    expect(scan).toMatch(/<button[^>]*id="wp-engines-scanAllHeaders"[^>]*disabled/);
  });
});

describe('protection section', () => {
  test('inspection off shows a warning that requests are not checked, and the section has no detection level', async () => {
    const off = WafPolicyForm.fromRules({ semantic_policies: { inspection_off: true } });
    const html = await renderComponent(ProtectionSection, { form: off } as never);
    expect(html).toContain('Inspection is off: requests to this project are not checked for attacks.');
    expect(html).not.toMatch(OLD_WORDS);
    const on = await renderComponent(ProtectionSection, { form: WafPolicyForm.fromRules(v1Rules()) } as never);
    expect(on).not.toContain('Inspection is off');
    expect(on).not.toMatch(OLD_WORDS);
    expect(on).toContain('Enforcement');
  });

  test('the warning names the application on an application policy', async () => {
    const form = WafPolicyForm.fromRules({ semantic_policies: { inspection_off: true } });
    form.engineScope = 'app';
    expect(await renderComponent(ProtectionSection, { form } as never)).toContain('requests to this application are not checked');
  });
});

describe('path rule editor', () => {
  const render = (rule = newPathRule()) =>
    renderComponent(PathRuleEditor, { open: true, rule: { ...rule, path: '/api/editor' }, policy: WafPolicyForm.fromRules({}).draft, onapply: () => {}, onclose: () => {} } as never);

  // Only the first tab renders on the server; the Inspection and Engine sensitivity tabs open on the client.
  test('the editor opens on the path tab without wording of the removed rule engine', async () => {
    const html = await render();
    expect(html).toContain('Rule path settings');
    expect(html).toContain('Inspection');
    expect(html).not.toMatch(OLD_WORDS);
  });
});
