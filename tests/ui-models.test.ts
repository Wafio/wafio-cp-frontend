// UI models: decision-feed cursor paging, proxy_config key
// preservation and script-rule ownership.
import { describe, expect, test } from 'bun:test';
import { appWAFDecisionsQueryString } from '../src/lib/api';
import {
  currentCursor,
  decisionsErrorMessage,
  decisionsWindow,
  firstCursorPage,
  formatDecisionTotal,
  nextCursorPage,
  prevCursorPage,
} from '../src/lib/components/apps/decision-paging';
import { defaultProxyForm, proxyConfigFrom, proxyFormFrom } from '../src/lib/components/apps/route-model';
import { canEditScriptRules, forbiddenBuiltinsMessage, ruleSaveError, touchesScriptRule } from '../src/lib/components/rules/script-access';

describe('decision feed paging', () => {
  test('cursor pages go forward with next_cursor and back without an offset', () => {
    let p = firstCursorPage();
    expect(currentCursor(p)).toBeUndefined();
    expect(nextCursorPage(p, null)).toBe(p);
    p = nextCursorPage(p, 'c1');
    p = nextCursorPage(p, 'c2');
    expect(p.index).toBe(2);
    expect(currentCursor(p)).toBe('c2');
    p = prevCursorPage(p);
    expect(currentCursor(p)).toBe('c1');
    // A new next page from page 1 replaces the old tail.
    p = nextCursorPage(p, 'c2b');
    expect(p.cursors).toEqual([null, 'c1', 'c2b']);
    p = prevCursorPage(prevCursorPage(p));
    expect(p.index).toBe(0);
    expect(prevCursorPage(p)).toBe(p);
  });

  test('the window follows the time range', () => {
    const now = new Date('2026-09-28T12:00:00Z');
    expect(decisionsWindow('24h', now)).toEqual({ from_ts: '2026-09-27T12:00:00.000Z', to_ts: '2026-09-28T12:00:00.000Z' });
    expect(decisionsWindow('30d', now).from_ts).toBe('2026-08-29T12:00:00.000Z');
  });

  test('query string carries window, cursor and ip; offset only without cursor', () => {
    const qs = new URLSearchParams(appWAFDecisionsQueryString({ from_ts: 'a', to_ts: 'b', cursor: 'c', ip: '10.0.0.1', offset: 50, limit: 25 }));
    expect(qs.get('from_ts')).toBe('a');
    expect(qs.get('to_ts')).toBe('b');
    expect(qs.get('cursor')).toBe('c');
    expect(qs.get('ip')).toBe('10.0.0.1');
    expect(qs.has('offset')).toBe(false);
    expect(qs.get('limit')).toBe('25');
  });

  test('capped totals and error codes', () => {
    expect(formatDecisionTotal(10000, true)).toBe('10,000+');
    expect(formatDecisionTotal(134, false)).toBe('134');
    for (const code of ['WAF_DECISIONS_BAD_RANGE', 'WAF_DECISIONS_BAD_IP', 'WAF_DECISIONS_BAD_CURSOR', 'WAF_DECISIONS_BAD_OFFSET']) {
      expect(decisionsErrorMessage({ error: 'raw', code })).not.toBe('raw');
    }
    expect(decisionsErrorMessage({ error: 'raw' })).toBe('raw');
  });
});

describe('proxy_config round trip', () => {
  test('reject_invalid_path_encoding defaults to on and keeps an explicit off', () => {
    expect(defaultProxyForm().rejectInvalidPathEncoding).toBe(true);
    expect(proxyFormFrom(undefined).rejectInvalidPathEncoding).toBe(true);
    expect(proxyFormFrom({ reject_invalid_path_encoding: null }).rejectInvalidPathEncoding).toBe(true);
    expect(proxyFormFrom({ reject_invalid_path_encoding: false }).rejectInvalidPathEncoding).toBe(false);
    expect(proxyConfigFrom(proxyFormFrom({ reject_invalid_path_encoding: false })).reject_invalid_path_encoding).toBe(false);
    expect(proxyConfigFrom(defaultProxyForm()).reject_invalid_path_encoding).toBe(true);
  });

  test('keys the form does not manage survive a save', () => {
    const stored = { trust_forwarded: false, trusted_proxies: ['10.0.0.0/8'], future_key: { a: 1 }, max_conns: 64 };
    const out = proxyConfigFrom(proxyFormFrom(stored));
    expect(out.trusted_proxies).toEqual(['10.0.0.0/8']);
    expect(out.future_key).toEqual({ a: 1 });
    expect(out.trust_forwarded).toBe(false);
    expect(out.max_conns).toBe(64);
  });

  test('managed keys win over stale copies in extra', () => {
    const form = proxyFormFrom({ max_conns: 64 });
    form.maxConns = 128;
    expect(proxyConfigFrom(form).max_conns).toBe(128);
  });
});

describe('script rules', () => {
  test('only owners edit script rules', () => {
    expect(canEditScriptRules('owner')).toBe(true);
    expect(canEditScriptRules('member')).toBe(false);
    expect(canEditScriptRules(null)).toBe(false);
    expect(touchesScriptRule('script', 'gui')).toBe(true);
    expect(touchesScriptRule(null, 'script')).toBe(true);
    expect(touchesScriptRule('gui', 'tuning')).toBe(false);
  });

  test('save errors carry the code and the forbidden names', () => {
    const owner = ruleSaveError({ error: 'x', code: 'SCRIPT_RULE_OWNER_REQUIRED' });
    expect(owner.message).toContain('Only project owners');
    const forbidden = ruleSaveError({ error: 'x', code: 'SCRIPT_BUILTIN_FORBIDDEN', forbidden: ['exec', 'http_get'] });
    expect(forbidden.forbidden).toEqual(['exec', 'http_get']);
    expect(forbidden.message).toContain('exec, http_get');
    expect(ruleSaveError({ error: 'plain' }).message).toBe('plain');
    expect(forbiddenBuiltinsMessage([])).toContain('may not use');
  });
});
