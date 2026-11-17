import { readFileSync } from 'node:fs';
import { expect, test } from 'bun:test';

const src = readFileSync('src/routes/projects/[id]/waf/+page.svelte', 'utf8');

test('agent and health columns keep a minimum width', () => {
  expect(src).toMatch(/key: 'name'[^}]*class: 'waf-col-agent'/);
  expect(src).toMatch(/:global\(\.waf-col-agent\)\s*\{\s*min-width:\s*\d+rem/);
  expect(src).toMatch(/:global\(\.waf-col-health\)\s*\{\s*min-width:\s*\d+rem/);
});

test('the agent version gets its "v" from formatVersion, never a literal prefix', () => {
  expect(src).toContain('formatVersion(a.version)');
  expect(src).not.toMatch(/`v\$\{/);
});

test('the list has no engine column: every agent runs the same engine', () => {
  expect(src).not.toContain("key: 'engines'");
  expect(src).not.toContain('EngineBadge');
  expect(src).not.toContain('rule_engine');
});

test('the register modal points to the installer, not to agent flags', () => {
  expect(src).toContain('wafAgentInstall(res.data.agent.name, window.location.hostname)');
  expect(src).not.toContain('--security-data-dir');
  expect(src).toContain('the installer from the WAF agent release');
});
