// Dashboard fixes: sign-out order,
// partial chunked applies, script-rule import for non-owners, URL list state,
// tone helpers and the runtime Triage URL filters.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HostApplyResponse } from '../src/lib/api';
import { NOT_SENT_CODE, partialApplyResponse, retryableHostIds, applyCodeText } from '../src/lib/host-fleet';
import {
  buildImportBodies,
  buildImportItems,
  defaultImportSelection,
  importBlockedReason,
  isImportable,
  parseRulesFile,
  remainingImportRows,
  summarizeImport,
} from '../src/lib/custom-rules-io';
import { SCRIPT_OWNER_MESSAGE } from '../src/lib/components/rules/script-access';
import { pageOffset, pageParamFor, querySearch, readChoiceParam, readPageParam, readTextParam } from '../src/lib/url-state';
import { capabilityTone, firewallStateTone, runtimeStateTone } from '../src/lib/tone';
import { parseIncidentStatus, readRuntimeUrl, runtimeSearch } from '../src/lib/components/runtime/url';
import { SIGN_OUT_PARAM, auth, signOutPath } from '../src/lib/stores/auth';

const SRC = join(import.meta.dir, '..', 'src');
const read = (path: string) => readFileSync(join(SRC, path), 'utf8');

describe('sign out', () => {
  test('the /login address carries the sign-out parameter', () => {
    expect(signOutPath('/app')).toBe(`/app/login?${SIGN_OUT_PARAM}=1`);
    expect(signOutPath('')).toBe('/login?signout=1');
  });

  test('a sign-out request is consumed once; an outside link alone signs nobody out', () => {
    expect(auth.consumeSignOutRequest()).toBe(false);
    auth.requestSignOut();
    expect(auth.consumeSignOutRequest()).toBe(true);
    expect(auth.consumeSignOutRequest()).toBe(false);
  });

  test('the shell navigates before the session ends', () => {
    const layout = read('routes/+layout.svelte');
    const fn = layout.slice(layout.indexOf('async function signOut'), layout.indexOf('function onUserMenuFocusOut'));
    expect(fn).not.toContain('auth.logout()');
    expect(fn).toContain('auth.requestSignOut()');
    expect(fn.indexOf('requestSignOut')).toBeLessThan(fn.indexOf('navigate('));
    expect(layout).toContain('let signingOut = $state(false)');
    const login = read('routes/login/+page.svelte');
    expect(login).toContain('consumeSignOutRequest()');
  });
});

describe('chunked apply stopped by a refused chunk', () => {
  const answered: HostApplyResponse = {
    apply_id: 'a1',
    op: 'firewall.add',
    dry_run: false,
    results: [
      { host_id: 'h1', host_name: 'one', status: 'applied', code: '', error: '' },
      { host_id: 'h2', host_name: 'two', status: 'failed', code: 'DEADLINE', error: 'timeout' },
    ],
    summary: { applied: 1, would_apply: 0, unchanged: 0, failed: 1, skipped: 0 },
    total: 2,
  };

  test('unsent hosts appear as failed with the request error; the summary is not a success', () => {
    const names: Record<string, string> = { h3: 'three' };
    const res = partialApplyResponse([answered], ['h3', 'h4', 'h1'], (id) => names[id] ?? '', 'Another apply is running.');
    expect(res).not.toBeNull();
    expect(res!.total).toBe(4);
    expect(res!.summary).toEqual({ applied: 1, would_apply: 0, unchanged: 0, failed: 3, skipped: 0 });
    const h3 = res!.results.find((r) => r.host_id === 'h3')!;
    expect(h3).toMatchObject({ host_name: 'three', status: 'failed', code: NOT_SENT_CODE, error: 'Another apply is running.' });
    // A host without a known name shows its id.
    expect(res!.results.find((r) => r.host_id === 'h4')!.host_name).toBe('h4');
    // Unsent hosts can be retried.
    expect(retryableHostIds(res!.results)).toEqual(['h2', 'h3', 'h4']);
    expect(applyCodeText(NOT_SENT_CODE)).not.toBe('');
  });

  test('nothing answered → null (the caller shows the error alone)', () => {
    expect(partialApplyResponse([], ['h1'], () => '', 'refused')).toBeNull();
  });

  test('both flows keep the error on the results step and use the partial result', () => {
    for (const file of ['lib/components/hosts/ApplyToHostsFlow.svelte', 'lib/components/hosts/CopyRuntimeFlow.svelte']) {
      const src = read(file);
      expect(src).toContain('partialApplyResponse(responses, unsent, hostName, error)');
      expect(src).toContain("goTo('results', true)");
      expect(src).toMatch(/s\.failed \|\| s\.skipped \|\| error/);
    }
  });
});

describe('rule import by a member (script rules need the owner role)', () => {
  const file = JSON.stringify({
    rules: [
      { name: 'gui one', mode: 'gui', action: 'block', enabled: true, priority: 10, condition_logic: 'and', conditions: [{ field: 'path', operator: 'starts_with', value: '/admin' }] },
      { name: 'script one', mode: 'script', action: 'block', enabled: true, script: 'if (score > 80.0) then:\n    waf_block()\nend\n' },
    ],
  });
  const parsed = parseRulesFile(file);
  if (!parsed.ok) throw new Error('fixture did not parse');
  const rows = parsed.rows;
  const script = rows.find((r) => r.mode === 'script')!;
  const gui = rows.find((r) => r.mode === 'gui')!;

  test('fixture rows are valid', () => {
    expect(script.body).not.toBeNull();
    expect(gui.body).not.toBeNull();
  });

  test('script rows are blocked for a non-owner, with the reason', () => {
    const member = { canEditScripts: false };
    expect(importBlockedReason(script, member)).toBe(SCRIPT_OWNER_MESSAGE);
    expect(importBlockedReason(gui, member)).toBeNull();
    expect(isImportable(script, member)).toBe(false);
    expect([...defaultImportSelection(rows, member)]).toEqual([gui.index]);
    // Even when selected, a blocked row is not sent.
    const all = new Set(rows.map((r) => r.index));
    expect(buildImportItems(rows, all, { keepEnabled: false, canEditScripts: false }).map((i) => i.index)).toEqual([gui.index]);
    const summary = summarizeImport(rows, all, false, member);
    expect(summary.selected).toBe(1);
    expect(summary.blocked).toBe(1);
  });

  test('owners keep importing script rules', () => {
    const owner = { canEditScripts: true };
    expect(defaultImportSelection(rows, owner).size).toBe(2);
    expect(buildImportBodies(rows, defaultImportSelection(rows), { keepEnabled: false })).toHaveLength(2);
    expect(summarizeImport(rows, defaultImportSelection(rows), false).blocked).toBe(0);
  });

  test('after a partial import only the rows not created stay listed', () => {
    expect(remainingImportRows(rows, new Set([gui.index])).map((r) => r.index)).toEqual([script.index]);
  });
});

describe('list state in the URL', () => {
  test('querySearch sets, removes and keeps parameters', () => {
    expect(querySearch('a=1&page=3', { page: null })).toBe('?a=1');
    expect(querySearch('a=1', { page: 2, q: 'x y' })).toBe('?a=1&page=2&q=x+y');
    expect(querySearch('', { q: '' })).toBe('');
  });

  test('page numbers are 1-based and forgiving', () => {
    expect(readPageParam('')).toBe(1);
    expect(readPageParam('page=0')).toBe(1);
    expect(readPageParam('page=-2')).toBe(1);
    expect(readPageParam('page=abc')).toBe(1);
    expect(readPageParam('page=4')).toBe(4);
    expect(pageOffset(4, 25)).toBe(75);
    expect(pageOffset(1, 25)).toBe(0);
    expect(pageParamFor(0, 25)).toBeNull();
    expect(pageParamFor(24, 25)).toBeNull();
    expect(pageParamFor(25, 25)).toBe('2');
    expect(pageParamFor(75, 25)).toBe('4');
  });

  test('choices and text', () => {
    expect(readChoiceParam('sort=name', 'sort', ['priority', 'name'] as const, 'priority')).toBe('name');
    expect(readChoiceParam('sort=drop', 'sort', ['priority', 'name'] as const, 'priority')).toBe('priority');
    expect(readTextParam('q=abc', 'q')).toBe('abc');
    expect(readTextParam('q=abcdef', 'q', 3)).toBe('abc');
    expect(readTextParam('', 'q')).toBe('');
  });

  test('runtime Triage filters round-trip through the URL', () => {
    expect(readRuntimeUrl('').incidentStatus).toBe('unresolved');
    expect(readRuntimeUrl('').incidentScope).toBe('host');
    expect(parseIncidentStatus('all')).toBe('');
    expect(parseIncidentStatus('bogus')).toBe('unresolved');
    const qs = runtimeSearch('host=h1', { incidentStatus: '', incidentScope: 'all' });
    expect(qs).toBe('?host=h1&istatus=all&iscope=all');
    const back = readRuntimeUrl(qs);
    expect(back.incidentStatus).toBe('');
    expect(back.incidentScope).toBe('all');
    // Defaults leave a clean URL.
    expect(runtimeSearch(qs, { incidentStatus: 'unresolved', incidentScope: 'host' })).toBe('?host=h1');
  });
});

describe('tone helpers for host fleet states', () => {
  test('firewall and runtime states', () => {
    expect(firewallStateTone('enforce')).toBe('mode-block');
    expect(firewallStateTone('monitor')).toBe('mode-monitor');
    expect(firewallStateTone('not_running')).toBe('warning');
    expect(firewallStateTone('no_agent')).toBe('neutral');
    expect(runtimeStateTone('on')).toBe('info');
    expect(runtimeStateTone('off')).toBe('warning');
    expect(runtimeStateTone('no_agent')).toBe('neutral');
  });

  test('a capability is never the ALLOW green', () => {
    expect(capabilityTone(true)).toBe('info');
    expect(capabilityTone(false)).toBe('neutral');
  });
});

describe('static checks', () => {
  test('no flag images from a third-party CDN', () => {
    expect(read('routes/projects/[id]/+page.svelte')).not.toContain('flagcdn.com');
  });

  test('DateTime has no hex fallback', () => {
    expect(read('lib/components/ui/DateTime.svelte')).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
  });

  test('global search does not send "delete project" to Project settings', () => {
    const nav = read('lib/shell-nav.ts');
    const settings = nav.slice(nav.indexOf("id: 'settings'"), nav.indexOf("id: 'credentials'"));
    expect(settings).not.toContain('delete project');
  });
});
