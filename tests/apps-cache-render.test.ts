// What the cache section of the Speed tab shows in each state, rendered on the server without a DOM: every part off,
// stored rules, the numbers and why answers were not kept, an agent that is too old, offline or refusing, a viewer,
// no agent, and the removal block (disabled while the cache is off, the last removals in each state). Clicks cannot
// run here (Bun has no DOM), so what a click decides is tested as functions in apps-cache.test.ts.
import './support/runes';
import './support/ssr';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { AppCache, AppCachePurge, AppCacheStats, AppDelivery } from '../src/lib/api';
import type { DeliveryFeed } from '../src/lib/components/apps/delivery-feed.svelte';
import { CACHE_FIXED, CACHE_LEAD, CACHE_OFF_TEXT, CACHE_SWITCH_HINT, COOKIES_IN_CACHE, FOLDER_NOT_COUNTED, NO_AGENT_TEXT, RULES_COOKIES, RULES_EMPTY, RULES_LEAD, RULE_SIGNED_IN_HINT } from '../src/lib/components/apps/cache';
import { VIEWER_TEXT } from '../src/lib/components/apps/speed';
import { renderComponent } from './support/ssr';
import { MINUTE, NOW, agent, delivery, feature, status } from './support/delivery-fixtures';

// The UI barrel pulls in PageHeader, which reads `dev` from SvelteKit.
Bun.plugin({
  name: 'app-environment-stub',
  setup(build) {
    build.module('$app/env', () => ({ loader: 'object', exports: { dev: false, browser: false, building: false, version: 'test' } }));
  },
});

const { default: AppSpeed } = await import('../src/lib/components/apps/AppSpeed.svelte');

function feed(state: AppDelivery | null): DeliveryFeed {
  return { state, loading: false, failed: null, now: NOW, waitingSince: NOW - MINUTE, refresh: async () => {}, saved() {}, purged() {}, acted() {} };
}

async function render(state: AppDelivery | null, props: { canConfigure?: boolean } = {}): Promise<string> {
  return renderComponent(AppSpeed, { projectId: 'p1', appId: 'a1', appName: 'Shop', feed: feed(state), canConfigure: true, dirty: false, ...props } as never);
}

const ON: AppCache = { ...delivery().cache, enabled: true };
const cacheOn = (over: Partial<AppCache> = {}, rest: Partial<AppDelivery> = {}) => delivery({ cache: { ...ON, ...over }, status: status({ cache: feature('cache') }), ...rest });
const stats = (over: Partial<AppCacheStats> = {}): AppCacheStats => ({
  requests: 1200, hits_memory: 700, hits_disk: 200, misses: 250, bypass: 0, stale: 0, stored: 240,
  skipped_no_lifetime: 0, skipped_private: 0, skipped_too_large: 0, skipped_streamed: 0, skipped_disk_full: 0,
  evictions: 0, corrupt: 0, disk_bytes: 52428800, memory_bytes: 4194304, objects: 310, ...over,
});
const purge = (over: Partial<AppCachePurge> = {}): AppCachePurge => ({
  id: 'r1', scope: 'url', url: '/products/42', state: 'pending', error: '', by: 'Dewi', agent: '', created_at: new Date(NOW - MINUTE).toISOString(), finished_at: null, ...over,
});

/** The part of the page from one heading to the next (or the end), without the comments the renderer leaves between nodes. */
function part(html: string, from: string, to?: string): string {
  const start = html.indexOf(from);
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, to ? html.indexOf(to, start) : undefined).replace(/<!--[\s\S]*?-->/g, '');
}
const cache = (html: string) => part(html, '>Cache</h3>', '>Remove stored copies</h4>');
const removal = (html: string) => part(html, '>Remove stored copies</h4>');
const switches = (html: string): string[] => html.match(/<button[^>]*role="switch"[^>]*>/g) ?? [];
const disabledFieldset = (html: string) => /<fieldset[^>]*cs-fieldset[^>]*disabled/.test(html);

describe('Cache section, every part off, with an agent that knows it', () => {
  test('is the last part of the tab, after Files from a folder', async () => {
    const html = await render(delivery());
    expect(html.indexOf('>Files from a folder</h3>')).toBeLessThan(html.indexOf('>Cache</h3>'));
    expect(html.indexOf('>Cache</h3>')).toBeLessThan(html.indexOf('>Remove stored copies</h4>'));
  });

  test('says in a sentence what it does for visitors, and the switch says what it keeps and never keeps', async () => {
    const section = cache(await render(delivery()));
    expect(section).toContain(CACHE_LEAD);
    expect(CACHE_LEAD).toBe('Pages and files that are the same for every visitor are kept for a while and sent at once, without waiting for your application.');
    expect(section).toContain('Keep copies of answers');
    expect(section).toContain(CACHE_SWITCH_HINT);
    expect(CACHE_SWITCH_HINT).toBe(
      'WAFio checks every request first, so a blocked request never gets a copy. It never keeps answers that set cookies, or that your application marks private or no-store. A signed-in visitor always gets a fresh answer from your application, never a stored copy. For a visitor who sends some other cookie, such as an analytics cookie, WAFio keeps an answer only when your application marks it public (Cache-Control: public or s-maxage) or it is an image, font, video, sound, style or script file.'
    );
    expect(section).not.toContain('Signed-in visitors need a rule');
    expect(switches(section)).toHaveLength(1);
    expect(switches(section)[0]).toContain('aria-checked="false"');
    expect(switches(section)[0]).not.toContain('disabled');
  });

  test('the two lifetimes are filled in with their help, in words a site owner reads', async () => {
    const section = cache(await render(delivery()));
    expect(section).toContain('Keep images, styles, scripts and fonts for');
    expect(section).toContain('When your application does not say how long. Pages and data are kept only when your application says so. 0 turns this off.');
    expect(section).toContain('When your application is down, keep sending stored copies for');
    expect(section).toContain('Visitors get the last good copy instead of an error page. 0 sends the error.');
    expect(section).toContain('value="1"');
    expect(section).toContain('value="10"');
    expect(section).toContain('hours');
    expect(section).toContain('minutes');
  });

  test('says there are no path rules and what that means, and offers to add one', async () => {
    const section = cache(await render(delivery()));
    expect(section).toContain('Path rules');
    expect(section).toContain(RULES_LEAD);
    expect(section).toContain(RULES_COOKIES);
    expect(section).toContain(RULES_EMPTY);
    expect(RULES_EMPTY).toBe('No path rules: every path follows the settings above.');
    expect(section).toContain('Add a path rule');
    expect(section).toContain('0 of 50 rules');
    expect(section).not.toContain('Path starts with');
  });

  test('the limits are folded, with the defaults filled in and the help under each', async () => {
    const section = cache(await render(delivery()));
    const details = /<details[^>]*cs-advanced[^>]*>/.exec(section);
    expect(details).not.toBeNull();
    expect(details![0]).not.toContain('open');
    expect(section).toContain('Advanced limits');
    for (const [label, value] of [['Disk space', '1 GiB'], ['Memory for hot copies', '32 MiB'], ['Largest answer to keep', '8 MiB']]) {
      expect(section).toContain(label);
      expect(section).toContain(`value="${value}"`);
    }
    expect(section).toContain("The most this application's copies may use on disk. When it is full, WAFio removes the least used copies first.");
    expect(section).toContain("Small copies asked for often are also kept in the agent's memory. 0 keeps them on disk only.");
    expect(section).toContain('Bigger answers always come from your application.');
    // The session cookie names are not here: compression uses them too, so they sit beside it.
    expect(section).not.toContain('Session cookie names');
    expect(section).not.toContain('<textarea');
    expect(section).toContain(COOKIES_IN_CACHE);
  });

  test('shows the line about X-Cache, a Save that waits for a change, and no numbers or reasons while it is off', async () => {
    const section = cache(await render(delivery({ cache_stats: stats({ skipped_private: 5 }) })));
    expect(section).toContain(CACHE_FIXED);
    expect(CACHE_FIXED).toBe("Each answer carries X-Cache: HIT, MISS, BYPASS or STALE, which your browser's developer tools show.");
    expect(section).toMatch(/<button[^>]*disabled[^>]*>(?:(?!<\/button>)[\s\S])*Save cache/);
    expect(section).not.toContain('answered from the cache');
    expect(section).not.toContain('Not kept because');
    expect(section).not.toContain('Unsaved changes');
  });

  test('no question is on the screen before anything is saved', async () => {
    const html = await render(delivery());
    for (const title of ['Turn off the cache?', 'Lower the disk space', 'signed-in visitors under', 'Remove every stored copy']) expect(html).not.toContain(title);
  });
});

describe('Cache section, what is saved is shown', () => {
  test('a cache that is on shows its switch on and its settings as saved', async () => {
    const html = await render(
      cacheOn({
        default_ttl_s: 7200, stale_if_error_s: 90, disk_bytes: 2 * 1024 ** 3, memory_bytes: 0, max_object_bytes: 4 << 20,
        session_cookies: ['shop_session', 'cart_id'],
      })
    );
    const section = cache(html);
    expect(switches(section)[0]).toContain('aria-checked="true"');
    expect(section).toContain('value="2"');
    expect(section).toContain('value="90"');
    expect(section).toContain('value="2 GiB"');
    expect(section).toContain('value="0"');
    expect(section).toContain('value="4 MiB"');
    // The names stay in the settings the cache sends back, and show in the part that edits them.
    expect(part(html, '>Signed-in visitors</h3>', '>Files from a folder</h3>')).toContain('shop_session\ncart_id');
  });

  test('stored path rules show each path, what it does, the time and the signed-in case', async () => {
    const section = cache(
      await render(
        cacheOn({
          rules: [
            { prefix: '/blog/', action: 'cache', ttl_s: 600, signed_in: false },
            { prefix: '/account/', action: 'bypass', ttl_s: 0, signed_in: false },
            { prefix: '/docs', action: 'cache', ttl_s: 3600, signed_in: true },
          ],
        })
      )
    );
    expect(section).not.toContain(RULES_EMPTY);
    expect((section.match(/Path starts with/g) ?? []).length).toBe(3);
    for (const prefix of ['/blog/', '/account/', '/docs']) expect(section).toContain(`value="${prefix}"`);
    expect(section).toContain('placeholder="/blog/"');
    expect((section.match(/Keep for a time/g) ?? []).length).toBe(2);
    expect((section.match(/Never keep/g) ?? []).length).toBe(1);
    // A rule that never keeps has no time and no signed-in case to set.
    expect((section.match(/>Keep for\s*<\/label>/g) ?? []).length).toBe(2);
    expect((section.replace(RULES_COOKIES, '').match(/Also for signed-in visitors/g) ?? []).length).toBe(2);
    expect(section).toContain(RULE_SIGNED_IN_HINT);
    expect(section).not.toContain('Only for paths that show the same page to everyone.');
    // The sentence about cookies stands once, above the rules, not once a rule.
    expect((section.match(/A rule shares its copies between all visitors\./g) ?? []).length).toBe(1);
    expect((section.match(/type="checkbox"[^>]*checked|checked[^>]*type="checkbox"/g) ?? []).length).toBe(1);
    expect(section).toContain('3 of 50 rules');
    expect((section.match(/Delete rule/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  test('the form of a rule is a group with a name for screen readers', async () => {
    const section = cache(await render(cacheOn({ rules: [{ prefix: '/blog/', action: 'cache', ttl_s: 600, signed_in: false }] })));
    expect(section).toContain('Path rule 1');
    expect(section).toContain('aria-label="Delete rule 1"');
  });

  test('a path with markup in it is shown as text', async () => {
    const section = cache(await render(cacheOn({ rules: [{ prefix: '/"><img src=x onerror=alert(1)>', action: 'bypass', ttl_s: 0, signed_in: false }] })));
    expect(section).not.toContain('<img src=x');
  });

  test('the cache is at its 50 rules: no more can be added', async () => {
    const rules = Array.from({ length: 50 }, (_, i) => ({ prefix: `/p${i}`, action: 'bypass' as const, ttl_s: 0, signed_in: false }));
    const section = cache(await render(cacheOn({ rules })));
    expect(section).toContain('50 of 50 rules');
    expect(section).toMatch(/<button[^>]*disabled[^>]*>(?:(?!<\/button>)[\s\S])*Add a path rule/);
  });
});

describe('Cache section, the line under the switch', () => {
  test('the agent has not answered the bundle: Saved. Waiting for the agent to apply it', async () => {
    const section = cache(await render(delivery({ cache: ON, generation: 101, status: status({ cache: feature('cache') }) })));
    expect(section).toContain('Saved. Waiting for edge-1 to apply it.');
  });

  test('the agent applied it: In use on the agent, and there are no numbers yet', async () => {
    const section = cache(await render(cacheOn()));
    expect(section).toContain('In use on edge-1.');
    expect(section).toContain('No numbers from edge-1 yet.');
  });

  test('the agent is offline: its settings apply when it reconnects', async () => {
    const section = cache(await render(cacheOn({}, { agent: agent({ online: false }) })));
    expect(section).toContain('edge-1 is offline. Saved settings apply when it reconnects.');
    expect(section).not.toContain('In use on');
  });

  test('a refusal shows its reason and says whether the previous settings still run', async () => {
    const refused = async (code: string, running_previous: boolean, detail = '') =>
      cache(await render(cacheOn({}, { status: status({ cache: feature('cache', { state: 'refused', code: code as never, detail, running_previous }) }) })));
    expect(await refused('disk_too_small', true, '1073741824 3221225472')).toContain(
      'edge-1 did not apply this: the cache disk has 1 GiB free, less than the 3 GiB its applications ask for (5 % of the disk stays free). Lower Disk space or free up space on the host. It still runs the previous settings.'
    );
    expect(await refused('memory_too_small', false, '2147483648')).toContain(
      "edge-1 did not apply this: hot copies would use more than a quarter of the host's 2 GiB memory. Lower Memory for hot copies. This part stays off until you fix it."
    );
    expect(await refused('memory_too_small', false)).toContain("edge-1 did not apply this: hot copies would use more than a quarter of the host's memory. Lower Memory for hot copies.");
  });

  test('an unusable cache folder is said on the line also while the cache is off', async () => {
    const off = delivery({ status: status({ cache: feature('cache', { state: 'refused', code: 'cache_dir_unusable', running_previous: false }) }) });
    const section = cache(await render(off));
    expect(section).toContain('edge-1 did not apply this: its cache folder /var/cache/wafio-waf was not usable at start; its log says why. Fix or reinstall, then restart it. This part stays off until you fix it.');
    expect(section).not.toContain('too old');
    expect(switches(section)[0]).not.toContain('disabled');
  });

  test('an unusable cache folder is also said while it is on, and still not as too old', async () => {
    const section = cache(await render(cacheOn({}, { status: status({ cache: feature('cache', { state: 'refused', code: 'cache_dir_unusable' }) }) })));
    expect(section).toContain('its cache folder /var/cache/wafio-waf was not usable at start');
    expect(section).not.toContain('too old');
  });

  test('a text from the agent is shown as text and never as markup', async () => {
    const section = cache(await render(cacheOn({}, { status: status({ cache: feature('cache', { state: 'refused', code: 'unknown', detail: '<img src=x onerror=alert(1)>' }) }) })));
    expect(section).toContain('&lt;img src=x onerror=alert(1)>');
    expect(section).not.toContain('<img src=x');
  });
});

describe('Cache section, the numbers and why answers were not kept', () => {
  test('says how many requests the cache answered, and the space used against the limits that are saved', async () => {
    const section = cache(await render(cacheOn({}, { cache_stats: stats() })));
    expect(section).toContain('In the last hour, 8 of every 10 requests were answered from the cache (900 of 1,200).');
    expect(section).toContain('Space used: 50 MiB of 1 GiB on disk (310 copies), 4 MiB of 32 MiB in memory.');
    expect(section).not.toContain('No numbers');
    expect(section).not.toContain('Not kept because');
  });

  test('says there were no requests', async () => {
    expect(cache(await render(cacheOn({}, { cache_stats: stats({ requests: 0, hits_memory: 0, hits_disk: 0 }) })))).toContain('No requests in the last hour.');
  });

  test('says when answers came from an older copy', async () => {
    expect(cache(await render(cacheOn({}, { cache_stats: stats({ stale: 7 }) })))).toContain('Sent from an older copy while your application was slow or down: 7.');
  });

  test('says what to do when most answers had no lifetime, and each other reason that happened', async () => {
    const section = cache(
      await render(
        cacheOn({}, { cache_stats: stats({ stored: 10, skipped_no_lifetime: 200, skipped_private: 6, skipped_streamed: 3, skipped_too_large: 2, bypass: 40 }) })
      )
    );
    expect(section).toContain('Most answers do not say how long they may be kept, so WAFio did not keep them (200). Add a path rule, or have your application send Cache-Control: public, max-age=600.');
    expect(section).toContain('Not kept because the answer was private, or the visitor sent a cookie and the answer was not marked public: 6.');
    expect(section).not.toContain('private or for a signed-in visitor');
    expect(section).toContain('Not kept because your application sent them in pieces, without a size: 3.');
    expect(section).toContain('Not kept because they were over 8 MiB: 2.');
    expect(section).toContain(
      'Not checked against the cache (a signed-in visitor, a request with a body or a method other than GET and HEAD, a path under a "Never keep" rule, or a request that WAFio only logs or monitors): 40.'
    );
    expect(section).not.toContain('the request had a body, or its rule only logs');
  });

  test('says the folder is not in the numbers when files come from a folder, and nothing about it otherwise', async () => {
    const folder = { enabled: true, root: '/var/www/shop/public', missing: 'app' as const, max_age_s: 0 };
    expect(cache(await render(cacheOn({}, { cache_stats: stats(), static_files: folder })))).toContain(FOLDER_NOT_COUNTED);
    expect(cache(await render(cacheOn({}, { cache_stats: stats() })))).not.toContain(FOLDER_NOT_COUNTED);
    // No numbers, no note under them.
    expect(cache(await render(cacheOn({}, { static_files: folder })))).not.toContain(FOLDER_NOT_COUNTED);
  });
});

describe('Cache section, an agent that is too old', () => {
  const old = (over: Partial<AppDelivery> = {}) => delivery({ agent: agent({}, { cache: false }), ...over });
  const FROM_BUILD = 'Upgrade it to a newer build of the WAF agent to use this.';

  test('a cache that is off cannot be switched on, and says which part and what to do', async () => {
    const section = cache(await render(old()));
    expect(section).toContain(`edge-1 is too old for the cache. ${FROM_BUILD}`);
    expect(switches(section)[0]).toContain('disabled');
    expect(disabledFieldset(section)).toBe(true);
  });

  test('a cache that is on can still be turned off', async () => {
    const section = cache(await render(old({ cache: ON })));
    expect(section).toContain(`edge-1 is too old for the cache. ${FROM_BUILD}`);
    expect(switches(section)[0]).toContain('aria-checked="true"');
    expect(switches(section)[0]).not.toContain('disabled');
    expect(section).not.toContain('Waiting for');
  });

  test('stored copies cannot be removed from it', async () => {
    const html = await render(old({ cache: ON }));
    expect(removal(html)).toContain(`edge-1 is too old for the cache. ${FROM_BUILD}`);
    expect(disabledFieldset(removal(html))).toBe(true);
  });

  test('an agent that never said which parts it applies is not too old', async () => {
    const section = cache(await render(delivery({ agent: agent({}, { cache: null }) })));
    expect(section).not.toContain('too old');
    expect(switches(section)[0]).not.toContain('disabled');
  });
});

describe('Cache section, an agent from a release before every part', () => {
  test('is sent to the release that brings the cache', async () => {
    const none = delivery({ agent: agent({}, { redirects: false, compression: false, static_files: false, cache: false }) });
    expect(cache(await render(none))).toContain('edge-1 is too old for the cache. Upgrade it to a WAF agent newer than v2.1.1 to use this.');
  });
});

describe('Cache section, a viewer and no agent', () => {
  test('a viewer can look and nothing in the cache or the removal block can be used', async () => {
    const html = await render(cacheOn({ rules: [{ prefix: '/blog/', action: 'cache', ttl_s: 600, signed_in: false }] }), { canConfigure: false });
    expect(html).toContain(VIEWER_TEXT);
    expect(switches(cache(html))[0]).toContain('disabled');
    expect(disabledFieldset(cache(html))).toBe(true);
    expect(disabledFieldset(removal(html))).toBe(true);
    for (const label of ['Save cache', 'Add a path rule', 'Delete rule', 'Remove copies']) {
      expect(html).toMatch(new RegExp(`<button[^>]*disabled[^>]*>(?:(?!</button>)[\\s\\S])*${label}`));
    }
  });

  test('with no agent the tab says once to assign one, the settings can be edited, and nothing can be removed', async () => {
    const html = await render(cacheOn({}, { agent: null, generation: null, status: null }));
    expect(html).toContain('No WAF agent serves this application yet. Saved settings apply once you assign one on the Assignment tab.');
    expect(switches(cache(html))[0]).not.toContain('disabled');
    expect(removal(html)).toContain(NO_AGENT_TEXT);
    expect(disabledFieldset(removal(html))).toBe(true);
    expect(cache(html)).not.toContain('In use on');
  });
});

describe('Cache section, removing stored copies', () => {
  test('while the saved cache is off the block is disabled and says to turn it on first', async () => {
    const html = await render(delivery({ purges: [purge({ state: 'done', agent: 'edge-1', finished_at: new Date(NOW).toISOString() })] }));
    expect(removal(html)).toContain(CACHE_OFF_TEXT);
    expect(CACHE_OFF_TEXT).toBe('The cache is off, so nothing is stored. Turn it on first.');
    expect(disabledFieldset(removal(html))).toBe(true);
    expect(removal(html)).toMatch(/<button[^>]*disabled[^>]*>(?:(?!<\/button>)[\s\S])*Remove copies/);
    // The last removals stay readable.
    expect(removal(html)).toContain('/products/42');
  });

  test('the saved cache decides: a cache that is switched on but not saved still blocks it', async () => {
    const html = await render(delivery());
    expect(switches(cache(html))[0]).toContain('aria-checked="false"');
    expect(removal(html)).toContain(CACHE_OFF_TEXT);
  });

  test('while it is on the block asks what to remove, with an address first and its help', async () => {
    const html = await render(cacheOn());
    const block = removal(html);
    expect(block).not.toContain(CACHE_OFF_TEXT);
    expect(disabledFieldset(block)).toBe(false);
    for (const label of ['One address', 'Everything under a path', 'Everything']) expect(block).toContain(label);
    expect(block).toMatch(/<input[^>]*value="url"[^>]*checked|<input[^>]*checked[^>]*value="url"/);
    expect(block).toMatch(/>Address\s*<\/label>/);
    expect(block).toContain('placeholder="https://shop.example.com/products/42"');
    expect(block).toContain('Every variant of this address goes, compressed or not.');
    expect(block).toMatch(/<button[^>]*>(?:(?!<\/button>)[\s\S])*Remove copies/);
    expect(block).not.toMatch(/<button[^>]*disabled[^>]*>(?:(?!<\/button>)[\s\S])*Remove copies/);
  });

  test('with nothing removed yet it says so', async () => {
    expect(removal(await render(cacheOn()))).toContain('Nothing removed yet.');
    expect(removal(await render(cacheOn({}, { purges: [purge()] })))).not.toContain('Nothing removed yet.');
  });

  test('a removal that waits says the agent confirms in a few seconds', async () => {
    const block = removal(await render(cacheOn({}, { purges: [purge()] })));
    expect(block).toContain('/products/42');
    expect(block).toContain('Asked by Dewi');
    expect(block).toContain('Removing. edge-1 confirms within a few seconds.');
  });

  test('a removal for an agent that is offline says the copies go when it reconnects', async () => {
    const block = removal(await render(cacheOn({}, { agent: agent({ online: false }), purges: [purge({ scope: 'app', url: '' })] })));
    expect(block).toContain('Everything');
    expect(block).toContain('edge-1 is offline. The copies go when it reconnects; until then it may still send them.');
  });

  test('a removal that waited past 2 minutes says the online agent has not confirmed it, as a warning, and not that the agent confirms in seconds', async () => {
    const block = removal(await render(cacheOn({}, { purges: [purge({ created_at: new Date(NOW - 3 * MINUTE).toISOString() })] })));
    expect(block).toContain('edge-1 is online but has not confirmed the removal. Its log may say why.');
    expect(block).not.toContain('Check that it is online');
    expect(block).not.toContain('confirms within a few seconds');
    expect(block).toMatch(/ui-alert tone-warning[^"]*"/);
  });

  test('each state of a removal is drawn with the shared alert: removing as a note, removed as success, could not remove and no answer as warnings', async () => {
    const block = removal(
      await render(
        cacheOn({}, {
          purges: [
            purge({ id: 'a' }),
            purge({ id: 'b', state: 'done', agent: 'edge-1', finished_at: new Date(NOW).toISOString() }),
            purge({ id: 'c', state: 'failed', error: 'invalid', agent: 'edge-1' }),
            purge({ id: 'd', created_at: new Date(NOW - 5 * MINUTE).toISOString() }),
          ],
        })
      )
    );
    const tones = (block.match(/ui-alert tone-(info|success|warning|error)/g) ?? []).map((m) => m.replace('ui-alert tone-', ''));
    expect(tones).toEqual(['info', 'success', 'warning', 'warning']);
    // The state is text first: the alert carries a screen-reader prefix and no live role of its own (the list is the live region).
    expect(block).toContain('>Warning:</span>');
    expect(block).toContain('>Success:</span>');
    expect(block).not.toMatch(/<div[^>]*ui-alert[^>]*role=/);
    expect(block).not.toContain('cs-purge-state');
  });

  test('a removal that is done names the agent, one that failed says why, and a path says what is under it', async () => {
    const block = removal(
      await render(
        cacheOn({}, {
          purges: [
            purge({ id: 'a', state: 'done', agent: 'edge-2', finished_at: new Date(NOW).toISOString() }),
            purge({ id: 'b', state: 'failed', error: 'cache_off', agent: 'edge-1', scope: 'prefix', url: '/blog/' }),
          ],
        })
      )
    );
    expect(block).toContain('Removed on edge-2 at ');
    expect(block).toContain('edge-1 could not remove them: the cache is off on it.');
    expect(block).toContain('Everything under /blog/');
  });

  test('an address, a name and an agent with markup are shown as text', async () => {
    const block = removal(await render(cacheOn({}, { agent: agent({ name: '<b>edge</b>' }), purges: [purge({ url: '/<script>alert(1)</script>', by: '<i>Dewi</i>' })] })));
    expect(block).not.toContain('<script>');
    expect(block).not.toContain('<i>Dewi');
    expect(block).not.toContain('<b>edge');
    expect(block).toContain('&lt;script>alert(1)&lt;/script>');
  });

  test('the list is a polite live region, so a change from removing to removed is announced', async () => {
    expect(removal(await render(cacheOn({}, { purges: [purge()] })))).toMatch(/<div aria-live="polite">\s*<ul/);
  });
});

describe('Cache section, the page wiring', () => {
  test('the page passes the application name to the Speed tab, for the question of removing everything', () => {
    const page = readFileSync(new URL('../src/routes/projects/[id]/apps/[appId]/+page.svelte', import.meta.url), 'utf8');
    expect(page).toContain('appName={app.name}');
  });
});
