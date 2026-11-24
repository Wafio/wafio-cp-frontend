// The cache section as functions: the checks of the control plane (its fixture cases), the form and what it sends,
// which saves ask first, the check of a removal, the refusals of the agent in words, and the numbers in words.
// What the section renders for each state is in apps-cache-render.test.ts.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { ApiError, AppCache, AppCachePurge, AppCacheStats, AppEdgeFeatureState } from '../src/lib/api';
import { formatDateTime } from '../src/lib/format';
import {
  CACHE_OFF_TEXT,
  COOKIES_MESSAGE,
  DISK_MESSAGE,
  NO_AGENT_TEXT,
  cacheConfirmText,
  cacheConfirmations,
  cacheFieldOf,
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
  queueFullText,
  removalBlockedText,
  ruleFieldOf,
  sameCache,
  sameCookieNames,
  withCookieNames,
  type CacheInput,
} from '../src/lib/components/apps/cache';
import { NO_ANSWER_AFTER_MS, partLine, pollIntervalMs, refusalReason, waitingForAgent } from '../src/lib/components/apps/speed';
import { CONFIRM_TIERS, needsConfirmation, tierFor } from '../src/lib/confirm-tiers';
import { MINUTE, NOW, agent, delivery, feature, status } from './support/delivery-fixtures';

interface Cases {
  cache: { name: string; in: CacheInput; result?: unknown; field?: string; message?: string }[];
  purge: { name: string; scope: string; url: string; result?: string; field?: string; message?: string }[];
}
const backend = JSON.parse(readFileSync(new URL('./fixtures/backend/delivery-checks.json', import.meta.url), 'utf8')) as Cases;

const stored = (over: Partial<AppCache> = {}): AppCache => ({ ...delivery().cache, enabled: true, ...over });
const keepRule = (prefix: string, over: Record<string, unknown> = {}) => ({ prefix, action: 'cache' as const, ttl_s: 600, signed_in: false, ...over });

describe('control plane parity', () => {
  test('every case of the cache checks gets the stored form or the refusal of the server', () => {
    expect(backend.cache.length).toBeGreaterThanOrEqual(40);
    for (const c of backend.cache) {
      const got = normalizeCache(c.in);
      if (c.result) expect({ name: c.name, got: got.settings, error: got.error }).toEqual({ name: c.name, got: c.result, error: undefined });
      else expect({ name: c.name, error: got.error }).toEqual({ name: c.name, error: { field: c.field, message: c.message } });
    }
  });

  test('every case of the removal checks gets the address the agent compares or the refusal of the server', () => {
    expect(backend.purge.length).toBeGreaterThanOrEqual(15);
    for (const c of backend.purge) {
      const got = normalizePurge(c.scope, c.url);
      if (c.message) expect({ name: c.name, error: got.error }).toEqual({ name: c.name, error: { field: c.field, message: c.message } });
      else expect({ name: c.name, url: got.url, error: got.error }).toEqual({ name: c.name, url: c.result ?? '', error: undefined });
    }
  });

  test('a time or a size that cannot be read is refused under its field, not taken for a default', () => {
    expect(normalizeCache({ ...cacheInput(cacheForm(stored())), default_ttl_s: NaN }).error?.field).toBe('default_ttl_s');
    expect(normalizeCache({ ...cacheInput(cacheForm(stored())), disk_bytes: NaN }).error).toEqual({ field: 'disk_bytes', message: DISK_MESSAGE });
    expect(normalizeCache({ ...cacheInput(cacheForm(stored())), rules: [keepRule('/a', { ttl_s: NaN })] }).error?.field).toBe('rules[0].ttl_s');
  });

  test('a cookie name with a Unicode space around it is trimmed as the server trims it', () => {
    const got = normalizeCache({ ...cacheInput(cacheForm(stored())), session_cookies: ['\u0085shop_id ', 'SHOP_ID'] });
    expect(got.settings?.session_cookies).toEqual(['shop_id']);
    expect(normalizeCache({ ...cacheInput(cacheForm(stored())), session_cookies: ['a b'] }).error?.message).toBe(COOKIES_MESSAGE);
  });

  test('the field a 400 names is told apart from the fields of other parts', () => {
    expect(cacheFieldOf('disk_bytes')).toBe('disk_bytes');
    expect(cacheFieldOf('rules')).toBe('rules');
    expect(cacheFieldOf('rules[12].ttl_s')).toBe('rules[12].ttl_s');
    for (const other of ['min_bytes', 'root', 'rules[0]', 'rules[x].prefix', 'rules[0].signed_in', '', undefined]) expect(cacheFieldOf(other)).toBeNull();
    expect(ruleFieldOf('rules[3].prefix')).toEqual({ index: 3, part: 'prefix' });
    expect(ruleFieldOf('rules')).toBeNull();
  });
});

describe('the form', () => {
  test('shows the stored settings as the person would type them, and sends the defaults back unchanged', () => {
    const form = cacheForm(stored());
    expect(form).toMatchObject({ enabled: true, defaultTtl: 3600, staleIfError: 600, disk: '1 GiB', memory: '32 MiB', object: '8 MiB', cookies: '', rules: [] });
    expect(normalizeCache(cacheInput(form)).settings).toEqual(stored());
    expect(sameCache(form, stored())).toBe(true);
  });

  test('an empty size takes the default, 0 memory is kept, and cookie names go one a line', () => {
    const form = { ...cacheForm(stored()), disk: '', memory: '0', cookies: 'shop_session\n\n  cart_id  \n' };
    const got = normalizeCache(cacheInput(form)).settings;
    expect(got).toMatchObject({ disk_bytes: 1 << 30, memory_bytes: 0, session_cookies: ['shop_session', 'cart_id'] });
  });

  test('a size with units is read, and one that is not a size is refused', () => {
    expect(normalizeCache(cacheInput({ ...cacheForm(stored()), disk: '2 GB', object: '512KiB' })).settings).toMatchObject({ disk_bytes: 2 * 1024 ** 3, max_object_bytes: 512 * 1024 });
    expect(normalizeCache(cacheInput({ ...cacheForm(stored()), memory: 'plenty' })).error?.field).toBe('memory_bytes');
  });

  test('a rule that never keeps sends no time and no signed-in case, and a new rule keeps for 10 minutes', () => {
    const form = { ...cacheForm(stored()), rules: [{ ...emptyRule(), prefix: '/account/', action: 'bypass' as const, signedIn: true }, { ...emptyRule(), prefix: '/blog/' }] };
    expect(emptyRule()).toEqual({ prefix: '', action: 'cache', ttl: 600, signedIn: false });
    expect(normalizeCache(cacheInput(form)).settings?.rules).toEqual([
      { prefix: '/account/', action: 'bypass', ttl_s: 0, signed_in: false },
      { prefix: '/blog/', action: 'cache', ttl_s: 600, signed_in: false },
    ]);
  });

  test('a rule row of a stored never-keep rule still has a time to show when it is switched to keep', () => {
    const form = cacheForm(stored({ rules: [{ prefix: '/a', action: 'bypass', ttl_s: 0, signed_in: false }] }));
    expect(form.rules[0]).toEqual({ prefix: '/a', action: 'bypass', ttl: 600, signedIn: false });
  });

  test('a change is seen, a rule with no path is a change that cannot be saved, and the order of the keys does not matter', () => {
    const form = cacheForm(stored());
    expect(sameCache({ ...form, enabled: false }, stored())).toBe(false);
    expect(sameCache({ ...form, rules: [emptyRule()] }, stored())).toBe(false);
    const reordered = JSON.parse(JSON.stringify({ rules: [], session_cookies: [], max_object_bytes: 8 << 20, memory_bytes: 32 << 20, disk_bytes: 1 << 30, stale_if_error_s: 600, default_ttl_s: 3600, enabled: true }));
    expect(sameCache(form, reordered)).toBe(true);
  });
});

describe('which saves ask first', () => {
  const on = stored();
  const signedIn = (prefix: string) => keepRule(prefix, { signed_in: true });

  test('nothing to ask for an ordinary change, or while the cache stays off', () => {
    expect(cacheConfirmations(on, stored({ default_ttl_s: 60 }), 5 << 20)).toEqual([]);
    expect(cacheConfirmations(stored({ enabled: false }), stored({ enabled: false, rules: [signedIn('/docs')] }), null)).toEqual([]);
  });

  test('turning the cache off asks once, whatever else changes', () => {
    expect(cacheConfirmations(on, stored({ enabled: false, rules: [signedIn('/docs')] }), 0)).toEqual([{ kind: 'disable-cache' }]);
  });

  test('a disk space below what the copies use asks, one that still fits does not, and lowering with no report does not', () => {
    expect(cacheConfirmations(on, stored({ disk_bytes: 100 << 20 }), 300 << 20)).toEqual([{ kind: 'shrink-cache', bytes: 100 << 20 }]);
    expect(cacheConfirmations(on, stored({ disk_bytes: 500 << 20 }), 300 << 20)).toEqual([]);
    expect(cacheConfirmations(on, stored({ disk_bytes: 100 << 20 }), null)).toEqual([]);
  });

  test('a disk space that was already below the use is not asked again when something else is saved', () => {
    const small = stored({ disk_bytes: 100 << 20 });
    expect(cacheConfirmations(small, { ...small, default_ttl_s: 60 }, 300 << 20)).toEqual([]);
    expect(cacheConfirmations(small, { ...small, disk_bytes: 200 << 20 }, 300 << 20)).toEqual([]);
  });

  test('switching the cache on with a lower disk space than the old use does not ask: nothing is stored yet', () => {
    expect(cacheConfirmations(stored({ enabled: false }), stored({ disk_bytes: 100 << 20 }), 300 << 20)).toEqual([]);
  });

  test('a new rule for signed-in visitors asks for its prefix, one question for each', () => {
    expect(cacheConfirmations(on, stored({ rules: [signedIn('/docs'), keepRule('/blog/'), signedIn('/help')] }), null)).toEqual([
      { kind: 'cache-signed-in', prefix: '/docs' },
      { kind: 'cache-signed-in', prefix: '/help' },
    ]);
  });

  test('a rule that already runs for signed-in visitors is not asked again, a rule that gains the case is, and so is one that changes its kind', () => {
    const before = stored({ rules: [signedIn('/docs'), keepRule('/blog/')] });
    expect(cacheConfirmations(before, stored({ rules: [signedIn('/docs'), keepRule('/blog/', { ttl_s: 60 })] }), null)).toEqual([]);
    expect(cacheConfirmations(before, stored({ rules: [signedIn('/docs'), signedIn('/blog/')] }), null)).toEqual([{ kind: 'cache-signed-in', prefix: '/blog/' }]);
    const bypassed = stored({ rules: [{ prefix: '/docs', action: 'bypass', ttl_s: 0, signed_in: false }] });
    expect(cacheConfirmations(bypassed, stored({ rules: [signedIn('/docs')] }), null)).toEqual([{ kind: 'cache-signed-in', prefix: '/docs' }]);
  });

  test('switching the cache on with a signed-in rule stored asks: it only goes live now', () => {
    const rules = [signedIn('/docs')];
    expect(cacheConfirmations(stored({ enabled: false, rules }), stored({ rules }), null)).toEqual([{ kind: 'cache-signed-in', prefix: '/docs' }]);
  });

  test('a rule that never keeps is never a signed-in case', () => {
    const rules = [{ prefix: '/a', action: 'bypass' as const, ttl_s: 0, signed_in: true }];
    expect(cacheConfirmations(on, stored({ rules }), null)).toEqual([]);
  });

  test('the questions are in the tier table: three simple, the signed-in one typed with the prefix', () => {
    expect(tierFor('disable-cache')).toBe('simple');
    expect(tierFor('shrink-cache')).toBe('simple');
    expect(tierFor('purge-cache-app')).toBe('simple');
    expect(tierFor('cache-signed-in')).toBe('typed');
    for (const name of ['disable-cache', 'shrink-cache', 'purge-cache-app', 'cache-signed-in']) {
      expect(Object.keys(CONFIRM_TIERS)).toContain(name);
      expect(needsConfirmation(name)).toBe(true);
    }
  });

  test('the words of each question', () => {
    expect(cacheConfirmText({ kind: 'disable-cache' })).toEqual({
      title: 'Turn off the cache?',
      body: 'WAFio deletes the stored copies of this application and every request goes to your application again.',
      confirmLabel: 'Turn off',
      tone: 'warning',
    });
    expect(cacheConfirmText({ kind: 'shrink-cache', bytes: 100 << 20 })).toMatchObject({
      title: 'Lower the disk space to 100 MiB?',
      body: 'WAFio removes the least used copies until the rest fit.',
      confirmLabel: 'Lower it',
    });
    expect(cacheConfirmText({ kind: 'cache-signed-in', prefix: '/docs' })).toEqual({
      title: 'Keep copies for signed-in visitors under /docs?',
      body: 'Everyone, signed in or not, gets the same copy. If these pages show a name, a cart or an account, other people see it.',
      confirmLabel: 'Keep for signed-in visitors',
      tone: 'danger',
      requireText: '/docs',
    });
    expect(purgeAppConfirmTitle('Shop')).toBe('Remove every stored copy of Shop?');
    expect(purgeAppConfirmTitle('')).toBe('Remove every stored copy of this application?');
  });
});

describe('the questions of one save', () => {
  const signedIn = (prefix: string) => keepRule(prefix, { signed_in: true });

  test('come in the order turn off, lower the disk, then each signed-in rule in the order of the rules', () => {
    const before = stored();
    const steps = cacheConfirmations(before, stored({ disk_bytes: 100 << 20, rules: [signedIn('/b'), keepRule('/c'), signedIn('/a')] }), 300 << 20);
    expect(steps).toEqual([
      { kind: 'shrink-cache', bytes: 100 << 20 },
      { kind: 'cache-signed-in', prefix: '/b' },
      { kind: 'cache-signed-in', prefix: '/a' },
    ]);
  });

  test('each answer passes on to the next question, and the answer to the last one runs the save', () => {
    const steps = cacheConfirmations(stored(), stored({ disk_bytes: 100 << 20, rules: [signedIn('/b'), signedIn('/a')] }), 300 << 20);
    expect(steps).toHaveLength(3);
    const second = nextQuestion(steps);
    expect(second).toEqual([{ kind: 'cache-signed-in', prefix: '/b' }, { kind: 'cache-signed-in', prefix: '/a' }]);
    const third = nextQuestion(second ?? []);
    expect(third).toEqual([{ kind: 'cache-signed-in', prefix: '/a' }]);
    expect(nextQuestion(third ?? [])).toBeNull();
    expect(nextQuestion([])).toBeNull();
  });

  test('a single question, such as turning off, saves on its first answer', () => {
    expect(nextQuestion([{ kind: 'disable-cache' }])).toBeNull();
  });

  test('the text of each question follows the steps, one at a time', () => {
    const titles = cacheConfirmations(stored(), stored({ rules: [signedIn('/b'), signedIn('/a')] }), null).map((step) => cacheConfirmText(step).title);
    expect(titles).toEqual(['Keep copies for signed-in visitors under /b?', 'Keep copies for signed-in visitors under /a?']);
  });
});

describe('a refused save', () => {
  const refused = (over: Partial<ApiError>): ApiError => ({ status: 400, error: 'The server says no.', ...over });

  test('a field of the cache goes under it, without the field name the server puts in front', () => {
    expect(classifyCacheRefusal(refused({ code: 'INVALID_DELIVERY_SETTINGS', field: 'default_ttl_s', error: 'default_ttl_s: Enter a time from 0 seconds to 365 days.' }))).toEqual({
      kind: 'field',
      field: 'default_ttl_s',
      message: 'Enter a time from 0 seconds to 365 days.',
      advanced: false,
    });
    expect(classifyCacheRefusal(refused({ code: 'INVALID_DELIVERY_SETTINGS', field: 'rules[2].ttl_s', error: 'Enter a time from 1 second to 365 days.' }))).toMatchObject({
      kind: 'field',
      field: 'rules[2].ttl_s',
      advanced: false,
    });
  });

  test('a limit under Advanced limits opens the fold, the other fields do not', () => {
    for (const field of ['disk_bytes', 'memory_bytes', 'max_object_bytes'] as const) {
      expect(inAdvanced(field)).toBe(true);
      expect(classifyCacheRefusal(refused({ code: 'INVALID_DELIVERY_SETTINGS', field, error: 'No.' }))).toMatchObject({ kind: 'field', field, advanced: true });
    }
    // The cookie names have their own place on the tab, not a fold of the cache.
    for (const field of ['default_ttl_s', 'stale_if_error_s', 'session_cookies', 'rules', 'rules[0].prefix'] as const) expect(inAdvanced(field)).toBe(false);
  });

  test('a field of another part is not put under a field of the cache', () => {
    expect(classifyCacheRefusal(refused({ code: 'INVALID_DELIVERY_SETTINGS', field: 'min_bytes', error: 'Enter a size.' }))).toEqual({ kind: 'save', message: 'Enter a size.' });
  });

  test('an agent that is too old is said as that, and one that cannot run the part is said above the buttons', () => {
    expect(classifyCacheRefusal(refused({ status: 409, code: 'AGENT_TOO_OLD', agent: 'edge-1', feature: 'cache' }))).toEqual({
      kind: 'too-old',
      message: 'edge-1 is too old for the cache. Upgrade it to a WAF agent newer than v2.1.1 to use this.',
    });
    expect(classifyCacheRefusal(refused({ status: 409, code: 'FEATURE_UNSUPPORTED', agent: 'edge-1', parts: ['compression', 'cache'] }))).toEqual({
      kind: 'save',
      message: 'edge-1 cannot run compression and the cache of this application. Turn them off first, or upgrade it.',
    });
  });

  test('any other answer shows the words of the server, or a sentence when it sent none', () => {
    expect(classifyCacheRefusal(refused({ status: 413, code: 'BUNDLE_TOO_LARGE', error: 'The configuration is too large.' }))).toEqual({ kind: 'save', message: 'The configuration is too large.' });
    expect(classifyCacheRefusal(refused({ kind: 'network', error: '' }))).toEqual({ kind: 'save', message: 'Could not save the cache settings.' });
    expect(classifyCacheRefusal(undefined)).toEqual({ kind: 'save', message: 'Could not save the cache settings.' });
  });
});

describe('the session cookie names', () => {
  test('are saved with the cache settings and nothing else changes, also while the cache is off', () => {
    const off = stored({ enabled: false, disk_bytes: 64 << 20, max_object_bytes: 1 << 20, rules: [keepRule('/blog/'), { prefix: '/x', action: 'bypass', ttl_s: 0, signed_in: false }] });
    const got = withCookieNames(off, 'shop_session\ncart_id');
    expect(got.settings).toEqual({ ...off, session_cookies: ['shop_session', 'cart_id'] });
    expect(got.settings?.enabled).toBe(false);
  });

  test('are trimmed, without repeats in any case and without empty lines, as the server stores them', () => {
    expect(withCookieNames(stored(), '  shop_session \n\nSHOP_SESSION\n\u0085cart_id').settings?.session_cookies).toEqual(['shop_session', 'cart_id']);
    expect(withCookieNames(stored(), '').settings?.session_cookies).toEqual([]);
  });

  test('refuse a name with a separator and more than 20 names, with the sentence of the server', () => {
    expect(withCookieNames(stored(), 'a b').error).toEqual({ field: 'session_cookies', message: COOKIES_MESSAGE });
    expect(withCookieNames(stored(), 'a;b').error?.message).toBe(COOKIES_MESSAGE);
    expect(withCookieNames(stored(), 'a=b').error?.message).toBe(COOKIES_MESSAGE);
    expect(withCookieNames(stored(), 'n'.repeat(65)).error?.message).toBe(COOKIES_MESSAGE);
    expect(withCookieNames(stored(), Array.from({ length: 21 }, (_, i) => `c${i}`).join('\n')).error?.message).toBe(COOKIES_MESSAGE);
    expect(withCookieNames(stored(), Array.from({ length: 20 }, (_, i) => `c${i}`).join('\n')).error).toBeUndefined();
  });

  test('count as changed only when the stored list would differ', () => {
    const named = stored({ session_cookies: ['shop_session', 'cart_id'] });
    expect(sameCookieNames(named, 'shop_session\ncart_id')).toBe(true);
    expect(sameCookieNames(named, ' shop_session\n\ncart_id \nCART_ID')).toBe(true);
    expect(sameCookieNames(named, 'shop_session')).toBe(false);
    expect(sameCookieNames(named, 'cart_id\nshop_session')).toBe(false);
    expect(sameCookieNames(stored(), '')).toBe(true);
    // Names that cannot be read are a change the save will refuse.
    expect(sameCookieNames(stored(), 'a b')).toBe(false);
  });
});

describe('removals', () => {
  const online = { name: 'edge-1', online: true };
  const row = (over: Partial<AppCachePurge> = {}): AppCachePurge => ({
    id: 'r1', scope: 'url', url: '/products/42', state: 'pending', error: '', by: 'Dewi', agent: '', created_at: new Date(NOW - MINUTE).toISOString(), finished_at: null, ...over,
  });

  test('the block is disabled while the saved cache is off, with no agent, or with an agent that is too old; else it is open', () => {
    expect(removalBlockedText(delivery())).toBe(CACHE_OFF_TEXT);
    expect(CACHE_OFF_TEXT).toBe('The cache is off, so nothing is stored. Turn it on first.');
    const on = delivery({ cache: stored() });
    expect(removalBlockedText(on)).toBeNull();
    expect(removalBlockedText({ ...on, agent: null })).toBe(NO_AGENT_TEXT);
    expect(removalBlockedText({ ...on, agent: agent({}, { cache: false }) })).toBe('edge-1 is too old for the cache. Upgrade it to a newer build of the WAF agent to use this.');
    expect(removalBlockedText({ ...on, agent: agent({}, { redirects: false, compression: false, static_files: false, cache: false }) })).toBe(
      'edge-1 is too old for the cache. Upgrade it to a WAF agent newer than v2.1.1 to use this.',
    );
    expect(removalBlockedText({ ...on, agent: agent({}, { cache: null }) })).toBeNull();
  });

  test('the cache that is saved decides, not the switch on the screen', () => {
    expect(removalBlockedText(delivery({ cache: stored({ enabled: false }) }))).toBe(CACHE_OFF_TEXT);
  });

  test('a removal that waits says the agent confirms in a few seconds, and when it is offline that the copies go on reconnect', () => {
    expect(purgeView(row(), online, NOW).state).toBe('Removing. edge-1 confirms within a few seconds.');
    expect(purgeView(row(), { name: 'edge-1', online: false }, NOW)).toMatchObject({
      state: 'edge-1 is offline. The copies go when it reconnects; until then it may still send them.',
      tone: 'info',
    });
    expect(purgeView(row(), null, NOW).state).toBe('Removing. The WAF agent confirms within a few seconds.');
  });

  test('a removal that is done names the agent that answered and the time', () => {
    const done = row({ state: 'done', agent: 'edge-2', finished_at: new Date(NOW).toISOString() });
    expect(purgeView(done, online, NOW)).toMatchObject({ state: `Removed on edge-2 at ${formatDateTime(done.finished_at)}.`, tone: 'success' });
  });

  test('a removal that failed says why, in words, whatever code the agent gave', () => {
    const failed = (error: string) => purgeView(row({ state: 'failed', error, agent: 'edge-1' }), online, NOW);
    expect(failed('cache_off').state).toBe('edge-1 could not remove them: the cache is off on it.');
    expect(failed('invalid').state).toBe('edge-1 could not remove them: it did not accept the address.');
    expect(failed('expired').state).toBe('edge-1 could not remove them: it did not answer within 7 days.');
    expect(failed('not_in_bundle').state).toContain("this application is not in its configuration yet");
    expect(failed('unknown').state).toBe('edge-1 could not remove them: it gave no reason.');
    expect(failed('something new').state).toBe('edge-1 could not remove them: it gave no reason.');
    expect(failed('cache_off').tone).toBe('warning');
  });

  test('a row says what is removed and who asked, also when that member is gone', () => {
    expect(purgeView(row(), online, NOW)).toMatchObject({ what: '/products/42', address: true, by: 'Asked by Dewi' });
    expect(purgeView(row({ scope: 'prefix', url: '/blog/' }), online, NOW)).toMatchObject({ what: 'Everything under /blog/', address: false });
    expect(purgeView(row({ scope: 'app', url: '', by: '' }), online, NOW)).toMatchObject({ what: 'Everything', by: 'Asked by a former member' });
  });

  test('a full queue names the agent', () => {
    expect(queueFullText('edge-1')).toBe('Too many removals are waiting for edge-1. Try again when they finish.');
    expect(queueFullText('')).toBe('Too many removals are waiting for the WAF agent. Try again when they finish.');
  });

  test('a removal that waits keeps the feed on its fast interval, and a finished one does not', () => {
    const waiting = delivery({ cache: stored(), status: status({ cache: feature('cache') }), purges: [row()] });
    expect(waitingForAgent(waiting, NOW)).toBe(true);
    expect(pollIntervalMs(waiting, null, NOW)).toBe(10_000);
    const finished = { ...waiting, purges: [row({ state: 'done', agent: 'edge-1' })] };
    expect(waitingForAgent(finished, NOW)).toBe(false);
    expect(pollIntervalMs(finished, null, NOW)).toBe(60_000);
  });

  test('a removal that waited 2 minutes says an online agent has not confirmed it, as a warning, and is no longer polled for', () => {
    const at = (age: number) => row({ created_at: new Date(NOW - age).toISOString() });
    expect(purgeView(at(NO_ANSWER_AFTER_MS - 1), online, NOW).state).toBe('Removing. edge-1 confirms within a few seconds.');
    expect(purgeView(at(NO_ANSWER_AFTER_MS), online, NOW)).toMatchObject({ state: 'edge-1 is online but has not confirmed the removal. Its log may say why.', tone: 'warning' });
    expect(purgeView(at(3 * 24 * 60 * MINUTE), online, NOW).state).not.toContain('few seconds');
    expect(purgeView(at(NO_ANSWER_AFTER_MS), online, NOW).state).not.toContain('Check that it is online');
    // The agent that answered the row is named; with none serving the application, the agent may well be off, so that hint stays.
    expect(purgeView({ ...at(NO_ANSWER_AFTER_MS), agent: 'edge-2' }, online, NOW).state).toBe('edge-2 is online but has not confirmed the removal. Its log may say why.');
    expect(purgeView({ ...at(NO_ANSWER_AFTER_MS), agent: 'edge-2' }, null, NOW).state).toBe('No answer from edge-2 yet. Check that it is online.');
    expect(purgeView(at(NO_ANSWER_AFTER_MS), null, NOW).state).toBe('No answer from the WAF agent yet. Check that it is online.');
    const stale = delivery({ cache: stored(), status: status({ cache: feature('cache') }), purges: [at(NO_ANSWER_AFTER_MS)] });
    expect(waitingForAgent(stale, NOW)).toBe(false);
    expect(pollIntervalMs(stale, null, NOW)).toBe(60_000);
    expect(waitingForAgent({ ...stale, purges: [at(NO_ANSWER_AFTER_MS - 1)] }, NOW)).toBe(true);
    // One young row among old ones is still waited for.
    expect(waitingForAgent({ ...stale, purges: [at(NO_ANSWER_AFTER_MS), { ...at(MINUTE), id: 'r2' }] }, NOW)).toBe(true);
  });

  test('a removal whose agent is offline keeps saying so however long it waits, and a time that cannot be read is not overdue', () => {
    const old = row({ created_at: new Date(NOW - 3 * 24 * 60 * MINUTE).toISOString() });
    expect(purgeView(old, { name: 'edge-1', online: false }, NOW).state).toContain('is offline');
    expect(purgeView(row({ created_at: 'not a time' }), online, NOW).state).toBe('Removing. edge-1 confirms within a few seconds.');
  });

  test('a removal that is done or failed keeps its own state however long ago it was asked', () => {
    const long = new Date(NOW - 3 * 24 * 60 * MINUTE).toISOString();
    expect(purgeView(row({ state: 'done', created_at: long, agent: 'edge-1' }), online, NOW).tone).toBe('success');
    expect(purgeView(row({ state: 'failed', error: 'expired', created_at: long, agent: 'edge-1' }), online, NOW).tone).toBe('warning');
  });

  test('removing everything asks first, one address or one path does not', () => {
    expect(purgeAsksFirst('app')).toBe(true);
    expect(purgeAsksFirst('url')).toBe(false);
    expect(purgeAsksFirst('prefix')).toBe(false);
  });

  describe('a refused removal', () => {
    const refused = (over: Partial<ApiError>): ApiError => ({ status: 400, error: 'The server says no.', ...over });

    test('an address the server did not accept goes under the address, in the words of the server', () => {
      expect(classifyPurgeRefusal(refused({ code: 'INVALID_CACHE_PURGE', field: 'url', error: 'Enter an address that starts with http://, https:// or /.' }), 'edge-1')).toEqual({
        kind: 'field',
        message: 'Enter an address that starts with http://, https:// or /.',
      });
    });

    test('a refusal of another field is shown above the button, not under the address', () => {
      expect(classifyPurgeRefusal(refused({ code: 'INVALID_CACHE_PURGE', field: 'scope', error: 'Choose a scope.' }), 'edge-1')).toEqual({ kind: 'alert', message: 'Choose a scope.', refresh: false });
      expect(classifyPurgeRefusal(refused({ code: 'INVALID_CACHE_PURGE', error: 'Bad.' }), 'edge-1')).toEqual({ kind: 'alert', message: 'Bad.', refresh: false });
    });

    test('a cache that is off says so and asks for the settings to be read again', () => {
      expect(classifyPurgeRefusal(refused({ status: 409, code: 'CACHE_OFF' }), 'edge-1')).toEqual({ kind: 'alert', message: CACHE_OFF_TEXT, refresh: true });
    });

    test('a full queue names the agent, or the WAF agent when none is known', () => {
      expect(classifyPurgeRefusal(refused({ status: 429, code: 'PURGE_QUEUE_FULL' }), 'edge-1')).toEqual({ kind: 'alert', message: queueFullText('edge-1'), refresh: false });
      expect(classifyPurgeRefusal(refused({ status: 429, code: 'PURGE_QUEUE_FULL' }), '')).toEqual({ kind: 'alert', message: queueFullText(''), refresh: false });
    });

    test('any other answer shows the words of the server, or a sentence when it sent none', () => {
      expect(classifyPurgeRefusal(refused({ status: 500, code: 'INTERNAL', error: 'Something broke.' }), 'edge-1')).toEqual({ kind: 'alert', message: 'Something broke.', refresh: false });
      expect(classifyPurgeRefusal(refused({ kind: 'network', error: '' }), 'edge-1')).toEqual({ kind: 'alert', message: 'Could not remove the copies.', refresh: false });
      expect(classifyPurgeRefusal(undefined, 'edge-1')).toEqual({ kind: 'alert', message: 'Could not remove the copies.', refresh: false });
    });
  });
});

describe('what the agent says about the cache', () => {
  const refused = (over: Partial<AppEdgeFeatureState>) => feature('cache', { state: 'refused', ...over });
  const reasonOf = (code: string, detail = '') => refusalReason({ code: code as never, detail }, '');

  test('an unusable cache folder is said with the folder and what to do', () => {
    expect(reasonOf('cache_dir_unusable')).toBe('its cache folder /var/cache/wafio-waf was not usable at start; its log says why. Fix or reinstall, then restart it');
  });

  test('a disk the host cannot give says the free space and the space asked for in units, and what to change', () => {
    expect(reasonOf('disk_too_small', '1073741824 3221225472')).toBe(
      'the cache disk has 1 GiB free, less than the 3 GiB its applications ask for (5 % of the disk stays free). Lower Disk space or free up space on the host'
    );
    expect(reasonOf('disk_too_small', '0 16777216')).toContain('the cache disk has 0 B free, less than the 16 MiB its applications ask for');
    expect(reasonOf('disk_too_small', '1073741824 3221225472')).not.toContain('1073741824');
  });

  test('a memory the host cannot give says the memory of the host in units, and what to lower', () => {
    expect(reasonOf('memory_too_small', '2147483648')).toBe("hot copies would use more than a quarter of the host's 2 GiB memory. Lower Memory for hot copies");
  });

  test('a detail that is not byte counts is shown as written, and no detail leaves no empty brackets', () => {
    for (const detail of ['free 1 GiB, asked 3 GiB', '1073741824', '1 2 3', '-1 5', '1.5 2', '1,2 3', '99999999999999999 5']) {
      expect(reasonOf('disk_too_small', detail)).toBe(
        `the cache disk has less free space than its applications ask for (${detail}), and 5 % of the disk stays free. Lower Disk space or free up space on the host`
      );
    }
    for (const detail of ['host has 2 GiB', '1 2', '-1', '2.5']) {
      expect(reasonOf('memory_too_small', detail)).toBe(`hot copies would use more than a quarter of the host's memory (${detail}). Lower Memory for hot copies`);
    }
    expect(reasonOf('disk_too_small')).toBe('the cache disk has less free space than its applications ask for, and 5 % of the disk stays free. Lower Disk space or free up space on the host');
    expect(reasonOf('memory_too_small')).toBe("hot copies would use more than a quarter of the host's memory. Lower Memory for hot copies");
  });

  test('the cache folder refusal shows on the cache line while the cache is off, and a refusal of other things does not', () => {
    const d = delivery({ status: status({ cache: refused({ code: 'cache_dir_unusable', running_previous: false }) }) });
    expect(partLine({ delivery: d, part: 'cache', inUse: false, now: NOW, waitingSince: NOW - MINUTE })).toEqual({
      tone: 'warning',
      text: 'edge-1 did not apply this: its cache folder /var/cache/wafio-waf was not usable at start; its log says why. Fix or reinstall, then restart it.',
      more: 'This part stays off until you fix it.',
    });
    const other = delivery({ status: status({ cache: refused({ code: 'disk_too_small', running_previous: false }) }) });
    expect(partLine({ delivery: other, part: 'cache', inUse: false, now: NOW, waitingSince: NOW - MINUTE })).toBeNull();
  });

  test('the cache folder refusal is a refusal, never "too old"; an agent that is too old says that', () => {
    const d = delivery({ cache: stored(), status: status({ cache: refused({ code: 'cache_dir_unusable' }) }) });
    expect(partLine({ delivery: d, part: 'cache', inUse: true, now: NOW, waitingSince: NOW - MINUTE })?.text).not.toContain('too old');
    const old = { ...d, agent: agent({}, { cache: false }) };
    expect(partLine({ delivery: old, part: 'cache', inUse: true, now: NOW, waitingSince: NOW - MINUTE })?.text).toBe(
      'edge-1 is too old for the cache. Upgrade it to a newer build of the WAF agent to use this.',
    );
  });

  test('the cache folder refusal of the folder does not show for a part that is not the cache', () => {
    const d = delivery({ status: status({ compression: feature('compression', { state: 'refused', code: 'cache_dir_unusable' }) }) });
    expect(partLine({ delivery: d, part: 'compression', inUse: false, now: NOW, waitingSince: NOW - MINUTE })).toBeNull();
  });

  test('a refusal of the disk keeps the previous settings running when the agent says so, and says in use once applied', () => {
    const kept = delivery({ cache: stored(), status: status({ cache: refused({ code: 'disk_too_small', running_previous: true }) }) });
    expect(partLine({ delivery: kept, part: 'cache', inUse: true, now: NOW, waitingSince: NOW - MINUTE })?.more).toBe('It still runs the previous settings.');
    const applied = delivery({ cache: stored(), status: status({ cache: feature('cache') }) });
    expect(partLine({ delivery: applied, part: 'cache', inUse: true, now: NOW, waitingSince: NOW - MINUTE })).toEqual({ tone: 'success', text: 'In use on edge-1.' });
  });
});

describe('the numbers in words', () => {
  const stats = (over: Partial<AppCacheStats> = {}): AppCacheStats => ({
    requests: 1200, hits_memory: 700, hits_disk: 200, misses: 250, bypass: 0, stale: 0, stored: 240,
    skipped_no_lifetime: 0, skipped_private: 0, skipped_too_large: 0, skipped_streamed: 0, skipped_disk_full: 0,
    evictions: 0, corrupt: 0, disk_bytes: 52428800, memory_bytes: 4194304, objects: 310, ...over,
  });
  const limits = { diskBytes: 1 << 30, memoryBytes: 32 << 20, maxObjectBytes: 8 << 20 };

  test('says how many of every 10 requests came from the cache, and the space used', () => {
    expect(cacheNumbers(stats(), limits)).toEqual([
      'In the last hour, 8 of every 10 requests were answered from the cache (900 of 1,200).',
      'Space used: 50 MiB of 1 GiB on disk (310 copies), 4 MiB of 32 MiB in memory.',
    ]);
  });

  test('says fewer than 1 of every 10 below a tenth, also with no hit at all', () => {
    expect(cacheNumbers(stats({ requests: 1000, hits_memory: 40, hits_disk: 0 }), limits)[0]).toBe('In the last hour, fewer than 1 of every 10 requests were answered from the cache (40 of 1,000).');
    expect(cacheNumbers(stats({ requests: 10, hits_memory: 0, hits_disk: 0 }), limits)[0]).toContain('fewer than 1 of every 10 requests were answered from the cache (0 of 10)');
  });

  test('never says 10 of every 10 unless every request was a hit', () => {
    expect(cacheNumbers(stats({ requests: 1000, hits_memory: 995, hits_disk: 0 }), limits)[0]).toContain('9 of every 10');
    expect(cacheNumbers(stats({ requests: 1000, hits_memory: 1000, hits_disk: 0 }), limits)[0]).toContain('10 of every 10');
  });

  test('says there were no requests, and one copy in the singular, and that memory is not used when it is off', () => {
    const none = cacheNumbers(stats({ requests: 0, hits_memory: 0, hits_disk: 0, objects: 1 }), { ...limits, memoryBytes: 0 });
    expect(none[0]).toBe('No requests in the last hour.');
    expect(none[1]).toBe('Space used: 50 MiB of 1 GiB on disk (1 copy), none in memory.');
  });

  test('names the answers sent from an older copy only when there were some', () => {
    expect(cacheNumbers(stats({ stale: 3 }), limits)).toContain('Sent from an older copy while your application was slow or down: 3.');
    expect(cacheNumbers(stats(), limits).join(' ')).not.toContain('older copy');
  });

  test('says nothing without a report', () => {
    expect(cacheNumbers(null, limits)).toEqual([]);
    expect(cacheSkipLines(null, limits)).toEqual([]);
  });

  test('says no reason for answers that were all kept, or never reached the cache', () => {
    expect(cacheSkipLines(stats(), limits)).toEqual([]);
  });

  test('says what to do when most answers had no lifetime', () => {
    const lines = cacheSkipLines(stats({ stored: 20, skipped_no_lifetime: 100, skipped_private: 10 }), limits);
    expect(lines[0]).toBe(
      'Most answers do not say how long they may be kept, so WAFio did not keep them (100). Add a path rule, or have your application send Cache-Control: public, max-age=600.'
    );
    expect(lines).toContain('Not kept because they were private or for a signed-in visitor: 10.');
  });

  test('does not say it when only a minority had no lifetime, or exactly half', () => {
    expect(cacheSkipLines(stats({ stored: 90, skipped_no_lifetime: 10 }), limits)).toEqual([]);
    expect(cacheSkipLines(stats({ stored: 50, skipped_no_lifetime: 50 }), limits)).toEqual([]);
  });

  test('names each other reason that happened, with the size limit in words, and leaves out the ones that did not', () => {
    const lines = cacheSkipLines(stats({ skipped_streamed: 4, skipped_too_large: 2, skipped_disk_full: 1, bypass: 12 }), limits);
    expect(lines).toEqual([
      'Not kept because your application sent them in pieces, without a size: 4.',
      'Not kept because they were over 8 MiB: 2.',
      "Not kept because the host's disk was almost full: 1.",
      'Not checked against the cache (the request had a body, or its rule only logs or monitors): 12.',
    ]);
  });
});
