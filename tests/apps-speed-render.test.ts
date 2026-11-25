// What the Speed tab shows in each state, rendered on the server without a DOM: loading, a failed read, a viewer, no
// agent, an agent that is too old or offline, a save that waits, applies or is refused, and the numbers. The main
// host name on the Gateway tab and the path prefix on the Routing tab show the same lines. Clicks cannot run here
// (Bun has no DOM), so what a click decides is tested as functions in apps-speed.test.ts.
import './support/runes';
import './support/ssr';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { AppDelivery, AppTLSState } from '../src/lib/api';
import type { DeliveryFeed } from '../src/lib/components/apps/delivery-feed.svelte';
import { COOKIES_HINT, COOKIES_IN_CACHE, COOKIES_LEAD } from '../src/lib/components/apps/cache';
import { emptyRouteForm } from '../src/lib/components/apps/route-model';
import { COMPRESSION_FIXED, COMPRESSION_LIMITS_FIXED, FILES_FIXED, NO_ANSWER_AFTER_MS, SPEED_INTRO, UNASSIGNED_TEXT, VIEWER_TEXT, keptFolderText } from '../src/lib/components/apps/speed';
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
const { default: AppTLS } = await import('../src/lib/components/apps/AppTLS.svelte');
const { default: AppRouteForm } = await import('../src/lib/components/apps/AppRouteForm.svelte');

function feed(state: AppDelivery | null, over: Partial<DeliveryFeed> = {}): DeliveryFeed {
  return { state, loading: false, failed: null, now: NOW, waitingSince: NOW - MINUTE, refresh: async () => {}, saved() {}, purged() {}, acted() {}, ...over };
}

async function render(state: AppDelivery | null, over: Partial<DeliveryFeed> = {}, props: { canConfigure?: boolean } = {}): Promise<string> {
  return renderComponent(AppSpeed, { projectId: 'p1', appId: 'a1', feed: feed(state, over), canConfigure: true, dirty: false, ...props } as never);
}

const COMPRESSION_ON = { compression: { enabled: true, min_bytes: 1024 } };
const FILES_ON = { static_files: { enabled: true, root: '/var/www/shop/public', missing: 'app' as const, max_age_s: 3600 } };
const answered = (over = {}) => status({ compression: feature('compression'), static_files: feature('static_files'), ...over });
const NO_PART = { redirects: false, compression: false, static_files: false, cache: false };
const FROM_RELEASE = 'Upgrade it to a WAF agent newer than v2.1.1 to use this.';
const FROM_BUILD = 'Upgrade it to a newer build of the WAF agent to use this.';

/** The part of the page between two headings. */
function part(html: string, from: string, to?: string): string {
  const start = html.indexOf(from);
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, to ? html.indexOf(to, start) : undefined);
}
const compression = (html: string) => part(html, '>Compression</h3>', '>Signed-in visitors</h3>');
const files = (html: string) => part(html, '>Files from a folder</h3>', '>Cache</h3>');
const signedIn = (html: string) => part(html, '>Signed-in visitors</h3>', '>Files from a folder</h3>');
const switches = (html: string): string[] => html.match(/<button[^>]*role="switch"[^>]*>/g) ?? [];

describe('Speed tab, before the settings are read', () => {
  test('says that it is loading, and shows no part and no switch; the intro is already there', async () => {
    const html = await render(null, { loading: true });
    expect(html).toContain('Loading speed settings.');
    expect(html).toContain(SPEED_INTRO);
    expect(html).not.toContain('role="switch"');
    expect(html).not.toContain('Compression');
  });

  test('the moment between opening the tab and the first read shows the wait, never an error', async () => {
    const html = await render(null);
    expect(html).toContain('Loading speed settings.');
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('Could not load');
    expect(html).not.toContain('Try again');
  });

  test('a failed read says what failed, offers Try again and shows no part', async () => {
    const html = await render(null, { failed: { error: 'Unable to reach the server. Please retry.' } });
    expect(html).toContain('Could not load the speed settings. Unable to reach the server. Please retry.');
    expect(html).toContain('Try again');
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('role="switch"');
  });
});

describe('Speed tab, every part off, with an agent that knows them', () => {
  test('opens with the intro, then Compression, then Files from a folder, then Cache', async () => {
    const html = await render(delivery());
    expect(html).toContain('Make this application faster for visitors. Each part can be turned on alone and works in both modes. WAFio checks every request before any of them answers it.');
    expect(html.indexOf(SPEED_INTRO)).toBeLessThan(html.indexOf('>Compression</h3>'));
    expect(html.indexOf('>Compression</h3>')).toBeLessThan(html.indexOf('>Files from a folder</h3>'));
    expect(html.indexOf('>Files from a folder</h3>')).toBeLessThan(html.indexOf('>Cache</h3>'));
  });

  test('Compression: the sentence for visitors, the switch with its effect, the fixed line, and its own Save', async () => {
    const section = compression(await render(delivery()));
    expect(section).toContain('Pages, styles and scripts are sent compressed, so visitors download less and pages load sooner on slow connections.');
    expect(section).toContain('Compress answers');
    expect(section).toContain("WAFio uses brotli or gzip, whichever the visitor's browser accepts. Images, video and answers your application already compressed are sent as they are.");
    expect(section).toContain(COMPRESSION_FIXED);
    expect(switches(section)).toHaveLength(1);
    expect(switches(section)[0]).toContain('aria-checked="false"');
    expect(switches(section)[0]).not.toContain('disabled');
    expect(section).toContain('Save compression');
  });

  test('Compression: the limits are folded, with the default size filled in and the fixed line inside', async () => {
    const section = compression(await render(delivery()));
    const details = /<details[^>]*>/.exec(section);
    expect(details).not.toBeNull();
    expect(details![0]).not.toContain('open');
    expect(section).toContain('Advanced limits');
    expect(section).toContain('Smallest answer to compress');
    expect(section).toContain('Smaller answers go as they are: compressing them saves little.');
    expect(section).toContain('value="1 KiB"');
    expect(section.indexOf(COMPRESSION_LIMITS_FIXED)).toBeGreaterThan(section.indexOf('Advanced limits'));
  });

  test('Files: the sentence, the switch, the folder with its example and help, both answers for a missing file, the fixed line', async () => {
    const section = files(await render(delivery()));
    expect(section).toContain('Images, styles, scripts and other files come straight from a folder on the server, without waiting for your application.');
    expect(section).toContain('Serve files from a folder');
    expect(switches(section)[0]).toContain('aria-checked="false"');
    expect(section).toContain('placeholder="/var/www/shop/public"');
    expect(section).toContain("The full path on edge-1's host. The user wafio must be able to read it; folders under /home are hidden from the agent.");
    expect(section).toContain('When a file is not in the folder');
    expect(section).toContain('Ask the application (recommended)');
    expect(section).toContain('Files in the folder come from it; everything else goes to your application as before. For a PHP site, choose its public folder.');
    expect(section).toContain('Answer Not found');
    expect(section).toContain('The folder is the whole site; your application gets no requests.');
    expect(section).toContain(FILES_FIXED);
    expect(section).toContain('Save files');
  });

  test('Files: the application is asked by default and the browser cache time is folded and not set', async () => {
    const section = files(await render(delivery()));
    expect(/<input[^>]*value="app"[^>]*checked/.exec(section) ?? /<input[^>]*checked[^>]*value="app"/.exec(section)).not.toBeNull();
    const details = /<details[^>]*>/.exec(section);
    expect(details![0]).not.toContain('open');
    expect(section).toContain('Browser cache time');
    expect(section).toContain("How long visitors' browsers may reuse a file before they ask again. Not set lets the browser decide.");
    expect(section).toContain('placeholder="Not set"');
    expect(section.indexOf('Browser cache time')).toBeGreaterThan(section.indexOf('Advanced limits'));
  });

  test('without an application agent to name, the host is the WAF agent', async () => {
    expect(files(await render(delivery({ agent: null, generation: null, status: null })))).toContain("The full path on the WAF agent's host.");
  });

  test('nothing is saved yet: both Save buttons are off, and neither line nor note shows', async () => {
    const html = await render(delivery());
    for (const label of ['Save compression', 'Save files', 'Save cache']) expect(html).toMatch(new RegExp(`<button[^>]*disabled[^>]*>(?:(?!</button>)[\\s\\S])*${label}`));
    expect(html).not.toContain('Unsaved changes');
    expect(html).not.toContain('class="ui-alert');
  });

  test('keeps a region for each line, so a change from waiting to in use is announced', async () => {
    const html = await render(delivery());
    expect((html.match(/class="part-status[^"]*"[^>]*aria-live="polite"/g) ?? []).length).toBe(3);
  });
});

describe('Speed tab, what is saved is shown', () => {
  test('a part that is on shows its switch on and its settings', async () => {
    const html = await render(delivery({ ...COMPRESSION_ON, ...FILES_ON, compression: { enabled: true, min_bytes: 2048 }, static_files: { enabled: true, root: '/srv/site/public', missing: 'not_found', max_age_s: 7200 } }));
    expect(switches(compression(html))[0]).toContain('aria-checked="true"');
    expect(compression(html)).toContain('value="2 KiB"');
    expect(switches(files(html))[0]).toContain('aria-checked="true"');
    expect(files(html)).toContain('value="/srv/site/public"');
    expect(/<input[^>]*value="not_found"[^>]*checked/.exec(files(html)) ?? /<input[^>]*checked[^>]*value="not_found"/.exec(files(html))).not.toBeNull();
    expect(files(html)).toContain('value="2"');
  });
});

describe('Speed tab, a viewer', () => {
  test('is told they can only look, and no control can be used', async () => {
    const html = await render(delivery(), {}, { canConfigure: false });
    expect(html).toContain(VIEWER_TEXT);
    for (const tag of switches(html)) expect(tag).toContain('disabled');
    expect(html).toMatch(/<fieldset[^>]*sp-fieldset[^>]*disabled/);
    for (const label of ['Save compression', 'Save files', 'Save cache']) expect(html).toMatch(new RegExp(`<button[^>]*disabled[^>]*>(?:(?!</button>)[\\s\\S])*${label}`));
  });

  test('a member sees no such note', async () => {
    expect(await render(delivery())).not.toContain(VIEWER_TEXT);
  });
});

describe('Speed tab, no agent serves the application', () => {
  const none = (over: Partial<AppDelivery> = {}) => delivery({ agent: null, generation: null, status: null, ...over });

  test('says once that saved settings apply after an agent is assigned, and the tab can still be used', async () => {
    const html = await render(none(COMPRESSION_ON));
    expect(html.split(UNASSIGNED_TEXT)).toHaveLength(2);
    for (const tag of switches(html)) expect(tag).not.toContain('disabled');
  });

  test('a part that is on says nothing more about the agent', async () => {
    const html = await render(none({ ...COMPRESSION_ON, ...FILES_ON }));
    expect(html).not.toContain('Waiting for');
    expect(html).not.toContain('In use on');
    expect(html).not.toContain('is offline');
  });
});

describe('Speed tab, the session cookie names beside Compression', () => {
  test('sit between Compression and Files, say who counts as signed in, and have their own Save', async () => {
    const html = await render(delivery());
    expect(html.indexOf('>Compression</h3>')).toBeLessThan(html.indexOf('>Signed-in visitors</h3>'));
    expect(html.indexOf('>Signed-in visitors</h3>')).toBeLessThan(html.indexOf('>Files from a folder</h3>'));
    const section = signedIn(html);
    expect(section).toContain(COOKIES_LEAD);
    expect(section).toContain('an Authorization header, a user name in the address, or a session cookie');
    // The cache skips them, and a path rule needs "Also for signed-in visitors" to cover them.
    expect(section).toContain('never answers them from a stored copy and never stores their answers');
    expect(section).toContain('unless a path rule has "Also for signed-in visitors"');
    expect(section).toContain('a cookie of another kind, such as analytics or consent, is not signed in');
    expect(section).not.toContain('unless a path rule says so');
    expect(section).toContain('used while compression or the cache is on');
    expect(section).toContain('Session cookie names');
    expect(section).toContain(COOKIES_HINT);
    expect(COOKIES_HINT.startsWith('One name a line. ')).toBe(true);
    expect(section).toContain('placeholder="shop_session"');
    expect(section).toContain('Save cookie names');
    expect(section).toMatch(/<button[^>]*disabled[^>]*>(?:(?!<\/button>)[\s\S])*Save cookie names/);
    expect(section).not.toContain('Unsaved changes');
  });

  test('show the saved names one a line, also while compression and the cache are both off', async () => {
    const stored = delivery().cache;
    const html = await render(delivery({ cache: { ...stored, session_cookies: ['shop_session', 'cart_id'] } }));
    expect(signedIn(html)).toContain('shop_session\ncart_id');
    expect(compression(html)).not.toContain('Waiting for');
  });

  test('are open to an agent that has compression but not the cache, and a viewer can only read them', async () => {
    const html = await render(delivery({ agent: agent({}, { cache: false }) }));
    expect(signedIn(html)).not.toContain('too old');
    expect(signedIn(html)).not.toMatch(/<textarea[^>]*disabled/);
    const viewer = await render(delivery(), {}, { canConfigure: false });
    expect(signedIn(viewer)).toMatch(/<textarea[^>]*disabled/);
    expect(signedIn(viewer)).toMatch(/<button[^>]*disabled[^>]*>(?:(?!<\/button>)[\s\S])*Save cookie names/);
  });

  test('the fixed line under Compression says where to add a name, and the Cache section points here and has no field of its own', async () => {
    const html = await render(delivery());
    expect(compression(html)).toContain('under Signed-in visitors below');
    expect(part(html, '>Cache</h3>')).toContain(COOKIES_IN_CACHE);
    expect(part(html, '>Cache</h3>', '>Remove stored copies</h4>')).not.toContain('<textarea');
  });
});

describe('Speed tab, a folder with a part of its path named like a system file', () => {
  const folder = (root: string) => delivery({ static_files: { enabled: true, root, missing: 'app', max_age_s: 0 }, status: answered() });

  test('is warned about under the folder, with the name, before anything is saved', async () => {
    const section = files(await render(folder('/var/www/private/public')));
    expect(section).toContain(keptFolderText('private'));
  });

  test('is warned about in any case, and a folder with no such part is not', async () => {
    expect(files(await render(folder('/srv/Profile/site')))).toContain(keptFolderText('Profile'));
    expect(files(await render(folder('/var/www/shop/public')))).not.toContain('will not use this folder');
    expect(files(await render(delivery()))).not.toContain('will not use this folder');
  });

  test('under /home it is warned about too, since the check leaves that folder to the agent', async () => {
    const section = files(await render(folder('/home/deploy/private/site')));
    expect(section).toContain(keptFolderText('private'));
  });

  test('the line under Files names the kept names and what a request for one gets', async () => {
    const section = files(await render(delivery()));
    expect(section).toContain('such as profile, network, group, hosts, security, private, credentials or systemd');
    expect(section).toContain('Those requests go to your application, or get Not found if you chose that.');
  });

  test('a folder the agent refused for the name says the name, not that it holds system files', async () => {
    const refused = delivery({
      static_files: { enabled: true, root: '/var/www/private/public', missing: 'app', max_age_s: 0 },
      status: answered({ static_files: feature('static_files', { state: 'refused', code: 'root_forbidden', detail: '/var/www/private/public' }) }),
    });
    const section = files(await render(refused));
    expect(section).toContain('/var/www/private/public has a part named private, a name the agent never serves from a folder.');
    expect(section).not.toContain('holds system or WAFio files');
  });
});

describe('Speed tab, an agent that is too old', () => {
  const old = (features: object, over: Partial<AppDelivery> = {}) => delivery({ agent: agent({}, features), ...over });

  test('a part that is off cannot be switched on, and says which part and what to do', async () => {
    const html = await render(old(NO_PART));
    expect(compression(html)).toContain(`edge-1 is too old for compression. ${FROM_RELEASE}`);
    expect(files(html)).toContain(`edge-1 is too old for files from a folder. ${FROM_RELEASE}`);
    for (const tag of [...switches(compression(html)), ...switches(files(html))]) expect(tag).toContain('disabled');
    expect(compression(html)).toMatch(/<fieldset[^>]*sp-fieldset[^>]*disabled/);
    expect(files(html)).toMatch(/<fieldset[^>]*sp-fieldset[^>]*disabled/);
  });

  test('a build from between releases, with the folder but not the cache, is sent to a newer build and not to a release', async () => {
    const html = await render(old({ cache: false }));
    expect(part(html, '>Cache</h3>')).toContain(`edge-1 is too old for the cache. ${FROM_BUILD}`);
    expect(part(html, '>Cache</h3>')).not.toContain('v2.1.1');
    expect(compression(html)).not.toContain('too old');
    expect(files(html)).not.toContain('too old');
  });

  test('an agent that has the folder and the cache is not told it is too old for either', async () => {
    const html = await render(old({}));
    expect(html).not.toContain('too old');
  });

  test('only the part it is too old for is locked', async () => {
    const html = await render(old({ static_files: false }));
    expect(switches(compression(html))[0]).not.toContain('disabled');
    expect(switches(files(html))[0]).toContain('disabled');
    expect(compression(html)).not.toContain('too old');
  });

  test('a part that is already on can still be turned off', async () => {
    const html = await render(old({ compression: false }, COMPRESSION_ON));
    expect(compression(html)).toContain(`edge-1 is too old for compression. ${FROM_BUILD}`);
    expect(switches(compression(html))[0]).toContain('aria-checked="true"');
    expect(switches(compression(html))[0]).not.toContain('disabled');
    expect(compression(html)).not.toContain('Waiting for');
  });

  test('an agent that never said which parts it applies is not too old', async () => {
    const html = await render(delivery({ agent: agent({}, { compression: null, static_files: null }) }));
    expect(html).not.toContain('too old');
    for (const tag of switches(html)) expect(tag).not.toContain('disabled');
  });
});

describe('Speed tab, after a save', () => {
  test('the agent has not answered the bundle: Saved. Waiting for the agent to apply it', async () => {
    const html = await render(delivery({ ...COMPRESSION_ON, generation: 101, status: answered() }));
    expect(compression(html)).toContain('Saved. Waiting for edge-1 to apply it.');
    expect(files(html)).not.toContain('Waiting for');
  });

  test('two minutes later it says the online agent has not confirmed, and that it may have refused the configuration', async () => {
    const waiting = delivery({ ...COMPRESSION_ON, generation: 101, status: answered() });
    expect(compression(await render(waiting, { waitingSince: NOW - NO_ANSWER_AFTER_MS + 1000 }))).toContain('Saved. Waiting for edge-1 to apply it.');
    const html = await render(waiting, { waitingSince: NOW - NO_ANSWER_AFTER_MS });
    expect(compression(html)).toContain('edge-1 is online but has not confirmed the latest configuration. It may have refused it; its log says why.');
    expect(compression(html)).not.toContain('Check that it is online');
    expect(compression(html)).not.toContain('Waiting for');
  });

  test('the agent applied it: In use on the agent', async () => {
    const html = await render(delivery({ ...COMPRESSION_ON, ...FILES_ON, status: answered() }));
    expect(compression(html)).toContain('In use on edge-1.');
    expect(files(html)).toContain('In use on edge-1.');
  });

  test('the agent is offline: its settings apply when it reconnects', async () => {
    const html = await render(delivery({ ...COMPRESSION_ON, agent: agent({ online: false }), status: answered() }));
    expect(compression(html)).toContain('edge-1 is offline. Saved settings apply when it reconnects.');
    expect(compression(html)).not.toContain('In use on');
  });

  test('a part that is off has no line, even when the agent said something about it before', async () => {
    const html = await render(delivery({ status: answered() }));
    expect(html).not.toContain('In use on');
    expect(html).not.toContain('did not apply');
  });
});

describe('Speed tab, the agent refused it', () => {
  const refused = (code: string, over = {}, detail = '') =>
    delivery({ ...FILES_ON, status: answered({ static_files: feature('static_files', { state: 'refused', code: code as never, detail, ...over }) }) });

  test('a disk that did not answer is said as that, with the folder and the 3 seconds, and not as a hidden /home', async () => {
    const stuck = delivery({
      ...FILES_ON,
      static_files: { enabled: true, root: '/mnt/nfs/site', missing: 'app', max_age_s: 0 },
      status: answered({ static_files: feature('static_files', { state: 'refused', code: 'root_unreadable', detail: '/mnt/nfs/site (no answer from the disk)' }) }),
    });
    const section = files(await render(stuck));
    expect(section).toContain('edge-1 did not apply this: the disk under /mnt/nfs/site did not answer within 3 seconds. If it is a network mount, check that its server is up.');
    expect(section).not.toContain('It runs as the user wafio');
  });

  test('a folder that is missing, is a file, cannot be read or holds system files: each with its reason', async () => {
    const text: Record<string, string> = {
      root_missing: '/var/www/shop/public does not exist on its host.',
      root_not_directory: '/var/www/shop/public is a file, not a folder.',
      root_unreadable: 'it cannot read /var/www/shop/public. It runs as the user wafio, and its service hides /home, /root and /run/user.',
      root_forbidden: '/var/www/shop/public holds system or WAFio files.',
    };
    for (const [code, reason] of Object.entries(text)) {
      expect(files(await render(refused(code)))).toContain(`edge-1 did not apply this: ${reason}`);
    }
  });

  test('says whether the previous settings still run or the part stays off', async () => {
    // One sentence after the other, with a space between: markup that drops it would glue "...user.This part".
    expect(files(await render(refused('root_missing')))).toContain('/var/www/shop/public does not exist on its host. This part stays off until you fix it.');
    expect(files(await render(refused('root_missing', { running_previous: true })))).toContain('does not exist on its host. It still runs the previous settings.');
    const off = files(await render(refused('root_missing')));
    expect(off).toContain('This part stays off until you fix it.');
    expect(off).not.toContain('previous settings');
  });

  test('a refusal on its own checks names the detail and says to upgrade the agent', async () => {
    expect(files(await render(refused('invalid', {}, 'root too long')))).toContain('edge-1 did not apply this: the settings failed its own checks (root too long). Upgrade the agent.');
  });

  test('another code shows the detail the agent gave, as text and never as markup', async () => {
    const html = await render(refused('unknown', {}, '<img src=x onerror=alert(1)> & "quoted"'));
    expect(files(html)).toContain('edge-1 did not apply this: &lt;img src=x onerror=alert(1)> &amp; "quoted".');
    expect(html).not.toContain('<img src=x');
  });

  test('an agent name with markup is shown as text too', async () => {
    const html = await render(delivery({ ...COMPRESSION_ON, agent: agent({ name: '<b>edge</b>' }), status: answered() }));
    expect(html).toContain('In use on &lt;b>edge&lt;/b>.');
    expect(html).not.toContain('<b>edge</b>');
  });
});

describe('Speed tab, the numbers under Compression', () => {
  const stats = { responses: 800, skipped_streamed: 0, bytes_saved: 91234567 };

  test('while it is on: how many answers, how much smaller; nothing about answers sent in pieces when there are none', async () => {
    const html = await render(delivery({ ...COMPRESSION_ON, status: answered(), compression_stats: stats }));
    expect(compression(html)).toContain('In the last hour 800 answers were sent compressed, 87 MiB smaller.');
    expect(compression(html)).not.toContain('in pieces');
    expect(compression(html)).not.toContain('No numbers');
  });

  test('says how many could not be compressed and why', async () => {
    const html = await render(delivery({ ...COMPRESSION_ON, status: answered(), compression_stats: { ...stats, skipped_streamed: 4 } }));
    expect(compression(html)).toContain('4 could not be compressed because your application sent them in pieces, without a size.');
  });

  test('says so when nothing was compressed in the last hour', async () => {
    const html = await render(delivery({ ...COMPRESSION_ON, status: answered(), compression_stats: { responses: 0, skipped_streamed: 0, bytes_saved: 0 } }));
    expect(compression(html)).toContain('No answers were compressed in the last hour.');
  });

  test('says there are no numbers yet when the agent applied it and has sent none', async () => {
    const html = await render(delivery({ ...COMPRESSION_ON, status: answered() }));
    expect(compression(html)).toContain('No numbers from edge-1 yet.');
  });

  test('shows none while compression is off, and none while the agent has not applied it', async () => {
    expect(compression(await render(delivery({ status: answered(), compression_stats: stats })))).not.toContain('In the last hour');
    const waiting = compression(await render(delivery({ ...COMPRESSION_ON, generation: 101, status: answered() })));
    expect(waiting).not.toContain('In the last hour');
    expect(waiting).not.toContain('No numbers');
  });

  test('are announced politely when they change', async () => {
    const html = await render(delivery({ ...COMPRESSION_ON, status: answered(), compression_stats: stats }));
    expect(html).toMatch(/<div class="sp-numbers[^"]*"[^>]*aria-live="polite"/);
  });
});

describe('the status line on the Gateway and Routing tabs', () => {
  const tls = (over: Partial<AppTLSState> = {}): AppTLSState => ({
    mode: 'gateway',
    hosts: ['shop.example.com', 'www.shop.example.com'],
    listen: '0.0.0.0:443',
    redirect_listen: '0.0.0.0:80',
    source: 'acme',
    canonical_host: '',
    certificate: null,
    acme: null,
    status: null,
    agent_supported: true,
    agent_host_bound: true,
    warnings: [],
    ...over,
  });
  const gateway = (state: AppTLSState, feedState: AppDelivery | null = delivery(), over: Partial<DeliveryFeed> = {}, canConfigure = true) =>
    renderComponent(AppTLS, {
      projectId: 'p1',
      appId: 'a1',
      appName: 'shop',
      assigned: true,
      agentName: 'edge-1',
      agentOnline: true,
      canConfigure,
      routing: { listenHost: '', listenPort: 8080, proxy: { trustForwarded: false, trustedProxies: '' } },
      dirty: false,
      initial: state,
      delivery: feed(feedState, over),
    } as never);
  const report = (over = {}) => delivery({ status: status({ redirects: feature('redirects'), ...over }) });

  test('Gateway offers the host names as the main host name, with No redirect first, its help and its note', async () => {
    const html = await gateway(tls({ canonical_host: 'shop.example.com' }));
    expect(html).toContain('Main host name');
    expect(html).toContain('Visitors who use another host name of this application are sent to this one, with the same path. Example: www.shop.example.com to shop.example.com.');
    expect(html).toContain('HTTP visitors go straight to https://shop.example.com.');
    expect(html).not.toContain('main host>');
    expect(html).toContain('Browsers remember this redirect. If you change it later, returning visitors may still go to the old name for a while.');
    expect(html.indexOf('Main host name')).toBeGreaterThan(html.indexOf('Host names'));
    expect(html.indexOf('Main host name')).toBeLessThan(html.indexOf('HTTPS address'));
    expect(html).toContain('shop.example.com');
  });

  test('with the HTTP redirect off, the help does not promise a hop for HTTP visitors', async () => {
    expect(await gateway(tls({ redirect_listen: '' }))).not.toContain('HTTP visitors go straight to');
  });

  test('with No redirect chosen for the main host name, the help names no host to go to', async () => {
    expect(await gateway(tls({ canonical_host: '' }))).not.toContain('HTTP visitors go straight to');
  });

  test('Behind a proxy shows no such field and says who handles the redirect', async () => {
    const html = await gateway(tls({ mode: 'proxy' }));
    expect(html).not.toContain('Main host name</label>');
    expect(html).toContain('Main host name and the HTTP to HTTPS redirect work in Gateway mode only. In Behind a proxy mode the web server in front of WAFio handles them.');
  });

  test('Behind a proxy shows a main host name that is still saved, with a way to clear it', async () => {
    const html = await gateway(tls({ mode: 'proxy', canonical_host: 'shop.example.com' }));
    expect(html).toContain('Main host name shop.example.com is saved but not used in this mode.');
    expect(html).toContain('Clear main host name');
    expect(html).not.toContain('Main host name</label>');
  });

  test('Behind a proxy with no main host name saved shows no such line, and a viewer gets the line without the button', async () => {
    expect(await gateway(tls({ mode: 'proxy' }))).not.toContain('is saved but not used in this mode');
    const html = await gateway(tls({ mode: 'proxy', canonical_host: 'shop.example.com' }), delivery(), {}, false);
    expect(html).toContain('is saved but not used in this mode');
    expect(html).not.toContain('Clear main host name');
  });

  test('Gateway mode shows the field, not the line about a saved one that is not used', async () => {
    expect(await gateway(tls({ canonical_host: 'shop.example.com' }))).not.toContain('is saved but not used in this mode');
  });

  test('says in use once the agent applied the saved main host name, and nothing while none is saved', async () => {
    expect(await gateway(tls({ canonical_host: 'shop.example.com' }), report())).toContain('In use on edge-1.');
    expect(await gateway(tls(), report())).not.toContain('In use on');
  });

  test('says it waits when the agent has not answered the latest bundle, and gives the reason of a refusal', async () => {
    expect(await gateway(tls({ canonical_host: 'shop.example.com' }), delivery({ generation: 101, status: status({ redirects: feature('redirects') }) }))).toContain('Saved. Waiting for edge-1 to apply it.');
    const refused = report({ redirects: feature('redirects', { state: 'refused', code: 'invalid', detail: 'canonical host', running_previous: true }) });
    const html = await gateway(tls({ canonical_host: 'shop.example.com' }), refused);
    expect(html).toContain('edge-1 did not apply this: the settings failed its own checks (canonical host). Upgrade the agent.');
    expect(html).toContain('It still runs the previous settings.');
  });

  test('an agent that is too old for it locks the list when none is saved, and says so', async () => {
    const html = await gateway(tls(), delivery({ agent: agent({}, { redirects: false }) }));
    expect(html).toContain(`edge-1 is too old for the main host name. ${FROM_BUILD}`);
    const select = /<button[^>]*role="combobox"[^>]*>/.exec(html);
    expect(select).not.toBeNull();
    expect(select![0]).toContain('disabled');
  });

  test('a saved main host name can still be cleared when the agent is too old', async () => {
    const html = await gateway(tls({ canonical_host: 'shop.example.com' }), delivery({ agent: agent({}, { redirects: false }) }));
    expect(html).toContain(`edge-1 is too old for the main host name. ${FROM_BUILD}`);
    const select = /<button[^>]*role="combobox"[^>]*>/.exec(html);
    expect(select![0]).not.toContain('disabled');
  });

  test('without the feed the field shows no status', async () => {
    const html = await renderComponent(AppTLS, {
      projectId: 'p1',
      appId: 'a1',
      appName: 'shop',
      assigned: true,
      agentName: 'edge-1',
      canConfigure: true,
      routing: { listenHost: '', listenPort: 8080, proxy: { trustForwarded: false, trustedProxies: '' } },
      dirty: false,
      initial: tls({ canonical_host: 'shop.example.com' }),
    } as never);
    expect(html).not.toContain('In use on');
    expect(html).toContain('Main host name');
  });

  const routing = (prefix: string, props: object = {}) => {
    const initial = emptyRouteForm();
    initial.proxy.stripPathPrefix = prefix;
    return renderComponent(AppRouteForm, { initial, onsubmit: async () => null, ...props } as never);
  };
  const line = { tone: 'success' as const, text: 'In use on edge-1.' };

  test('Routing offers Remove path prefix after the Host header, empty, with its example and its help', async () => {
    const html = await routing('');
    expect(html).toContain('Remove path prefix');
    expect(html).toContain('placeholder="/shop"');
    expect(html).toContain('For an application that lives under a path. With /shop, a visit to /shop/cart reaches the application as /cart, and any other path, such as /admin, gets Not found. WAFio still checks and logs the full path. Links the application writes must include /shop.');
    expect(html.indexOf('Remove path prefix')).toBeGreaterThan(html.indexOf('Host header sent upstream'));
    expect(html.indexOf('Remove path prefix')).toBeLessThan(html.indexOf('Trust X-Forwarded-For'));
  });

  test('Routing is folded under the proxy settings, like the Host header', async () => {
    const html = await routing('');
    const details = /<details[^>]*class="advanced[^"]*"[^>]*>/.exec(html);
    expect(details).not.toBeNull();
    expect(details![0]).not.toContain('open');
  });

  const openDetails = (html: string) => /<details[^>]*class="advanced[^"]*"[^>]*>/.exec(html)![0];

  test('Routing names the path prefix in the summary of the folded settings, so it can be found', async () => {
    const html = await routing('');
    expect(part(html, 'Proxy settings', 'Timeouts</h4>')).toContain('Host header, path prefix, forwarded headers');
  });

  test('Routing opens the proxy settings when a prefix is saved, so its line and its field are in view', async () => {
    expect(openDetails(await routing('/shop', { prefixLine: line }))).toMatch(/\sopen(=|\s|>)/);
  });

  test('Routing opens the proxy settings when the agent refused or is too old for the prefix, even with none saved', async () => {
    const refused = { tone: 'warning' as const, text: 'edge-1 did not apply this: the settings failed its own checks. Upgrade the agent.' };
    expect(openDetails(await routing('', { prefixLine: refused, prefixLocked: true }))).toMatch(/\sopen(=|\s|>)/);
    // A line that is only news (waiting, in use) leaves them folded.
    expect(openDetails(await routing('', { prefixLine: { tone: 'info' as const, text: 'Saved. Waiting for edge-1 to apply it.' } }))).not.toMatch(/\sopen(=|\s|>)/);
  });

  test('Routing shows the saved prefix, and the line of the agent under it', async () => {
    const html = await routing('/shop', { prefixLine: line });
    expect(html).toContain('value="/shop"');
    expect(html).toContain('In use on edge-1.');
  });

  test('Routing locks the field for an agent that is too old, with the text; a saved prefix stays editable', async () => {
    const text = { tone: 'warning' as const, text: `edge-1 is too old for the path prefix. ${FROM_RELEASE}` };
    const locked = await routing('', { prefixLocked: true, prefixLine: text });
    expect(/<input[^>]*placeholder="\/shop"[^>]*>/.exec(locked)![0]).toContain('disabled');
    expect(locked).toContain(text.text);
    const editable = await routing('/shop', { prefixLine: text });
    expect(/<input[^>]*placeholder="\/shop"[^>]*>/.exec(editable)![0]).not.toContain('disabled');
  });
});

describe('the Speed tab on a phone', () => {
  const source = readFileSync(new URL('../src/lib/components/apps/AppSpeed.svelte', import.meta.url), 'utf8');

  test('is one column, never wider than the page, with tap targets of 44 px', () => {
    expect(source).toContain('@media (max-width: 760px)');
    expect(source).toMatch(/\.sp :global\(\.sp-tap\), [^{]*\.lifetime-unit button[^{]*\{ min-height: 44px; \}/);
    expect(source).toContain(":global(input[type='text'])");
    expect(source).toMatch(/\.sp \{[^}]*min-width: 0/);
    // The only grid rule makes the choice of the two answers one column.
    expect(source.match(/grid-template-columns:[^;]*;/g)).toEqual(['grid-template-columns: minmax(0, 1fr);']);
    expect(source).not.toMatch(/overflow-x|[;{]\s*(min-)?width: \d{3,}px/);
  });

  test('keeps colours in tokens, writes no markup from agent text and removes no focus ring', () => {
    for (const name of ['AppSpeed.svelte', 'PartStatus.svelte', 'LifetimeInput.svelte']) {
      const text = readFileSync(new URL(`../src/lib/components/apps/${name}`, import.meta.url), 'utf8');
      expect(text).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(text).not.toMatch(/rgba?\(/);
      expect(text).not.toContain('{@html');
      expect(text).not.toMatch(/outline:\s*(none|0)/);
    }
  });
});
