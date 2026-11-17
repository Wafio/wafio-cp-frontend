import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { POLICY_TEMPLATES, policyHasNarrowingMatch, templateToPolicyBody } from '../src/lib/policyTemplates';

test('every template imports as a disabled draft, including kill policies', () => {
  expect(POLICY_TEMPLATES.some(t => t.policy.action === 'kill')).toBe(true);
  expect(POLICY_TEMPLATES.some(t => t.policy.action === 'kill' && policyHasNarrowingMatch(t.policy))).toBe(true);
  for (const template of POLICY_TEMPLATES) {
    const body = templateToPolicyBody(template);
    expect(body.enabled).toBe(false);
    // A kill template with no narrowing match imports as an alert draft (the
    // server needs kill_acknowledged for a broad kill); narrowed kills stay kill.
    const broadKill = template.policy.action === 'kill' && !policyHasNarrowingMatch(template.policy);
    expect(body.action).toBe(broadKill ? 'alert' : template.policy.action);
    if (broadKill) expect(body.description).toContain('Imported as alert');
    expect(body.kernel_enforce).toBe(template.policy.kernel_enforce ?? false);
    expect(body.event_types).toEqual(template.policy.event_types ?? []);
    // Imported templates are new policies: whole-word process names.
    expect(body.match_comm_mode).toBe('word');
  }
});

test('the narrowing check matches the server', () => {
  expect(policyHasNarrowingMatch({ match_comm: 'xmrig, minerd' })).toBe(true);
  expect(policyHasNarrowingMatch({ match_comm: 'nc' })).toBe(false);
  expect(policyHasNarrowingMatch({ match_uid: 0 })).toBe(false);
  expect(policyHasNarrowingMatch({ match_filename: '/' })).toBe(false);
  expect(policyHasNarrowingMatch({ match_dest_ip: '192.0.2.1' })).toBe(true);
});

test('template descriptions disclose missing context for broad matches', () => {
  const descriptions = Object.fromEntries(POLICY_TEMPLATES.map(t => [t.id, t.description]));
  expect(descriptions['exec-shell-from-web']).toContain('parent');
  expect(descriptions['persist-ld-preload']).toContain('read-only');
  expect(descriptions['impact-kill-pid1']).toContain('signal 0');
  expect(descriptions['evasion-auditd-stop']).toContain('arguments');
  expect(descriptions['priv-setuid-root']).toContain('success');
});

test('template UI describes disabled drafts and review before enabling', () => {
  // The template library moved from the Runtime security page into its Policies → Templates section.
  const page = readFileSync(new URL('../src/lib/components/runtime/PolicyTemplates.svelte', import.meta.url), 'utf8');
  expect(page.includes('Import draft')).toBe(true);
  expect(page.includes('Review conditions and action before enabling')).toBe(true);
  expect(page.includes('safe payload, copy')).toBe(false);
});

test('templates avoid unsupported socket exploits and follow memory-file severity', () => {
  expect(POLICY_TEMPLATES.some(t => t.id.startsWith('kernel-dirty-frag'))).toBe(false);
  expect(POLICY_TEMPLATES.find(t => t.id === 'kernel-memfd-create')?.policy.min_severity).toBe('medium');
});
