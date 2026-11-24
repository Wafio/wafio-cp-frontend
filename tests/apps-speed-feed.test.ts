// The feed behind the Speed, Gateway and Routing tabs: it reads while one of them is open, keeps the last good answer
// when a later read fails, puts a save into the state at once, and drops an answer that a save overtook.
import { afterEach, describe, expect, test } from 'bun:test';
import { deferred, flushMicrotasks } from './support/runes';
import { effect_root, flush, proxy } from 'svelte/internal/client';
import type { AppDelivery } from '../src/lib/api';
import { delivery } from './support/delivery-fixtures';

const { createDeliveryFeed } = await import('../src/lib/components/apps/delivery-feed.svelte');

const originalFetch = globalThis.fetch;
const stops: (() => void)[] = [];
afterEach(() => {
  globalThis.fetch = originalFetch;
  while (stops.length) stops.pop()!();
});

/** Answers the next reads in order; the last answer repeats. `Response` or a promise of one. */
function answers(...list: (AppDelivery | Response | Promise<Response>)[]) {
  const urls: string[] = [];
  let i = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    urls.push(String(input));
    const next = list[Math.min(i++, list.length - 1)];
    return next instanceof Response || next instanceof Promise ? next : Response.json(next);
  }) as unknown as typeof fetch;
  return urls;
}

function start(over: { active?: boolean; project?: string } = {}) {
  const ctl = proxy({ active: over.active ?? true, project: over.project ?? 'p1' });
  let feed!: ReturnType<typeof createDeliveryFeed>;
  stops.push(effect_root(() => {
    feed = createDeliveryFeed({ projectId: () => ctl.project, appId: () => 'a1', active: () => ctl.active });
  }));
  flush();
  return { feed, ctl };
}

/** Lets the poller's timer fire and the read finish. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 5));
  await flushMicrotasks();
  flush();
}

describe('createDeliveryFeed', () => {
  test('between opening the tab and the first answer it has neither a state nor a failure', async () => {
    answers(delivery());
    const { feed } = start();
    // The first read waits for the poller's timer, so right after the tab opens nothing has been read.
    expect(feed.state).toBeNull();
    expect(feed.failed).toBeNull();
    await settle();
    expect(feed.state).not.toBeNull();
  });

  test('reads the settings when a tab that needs them is open, and not before', async () => {
    const urls = answers(delivery());
    const { feed, ctl } = start({ active: false });
    await settle();
    expect(urls).toHaveLength(0);
    expect(feed.state).toBeNull();
    ctl.active = true;
    flush();
    await settle();
    expect(urls.map((url) => new URL(url).pathname)).toEqual(['/api/projects/p1/apps/a1/delivery']);
    expect(feed.state?.compression).toEqual({ enabled: false, min_bytes: 1024 });
    expect(feed.loading).toBe(false);
    expect(feed.failed).toBeNull();
  });

  test('a first read that fails is the failure the tab shows', async () => {
    const urls = answers(Response.json({ error: 'Forbidden' }, { status: 403 }));
    const { feed } = start();
    await settle();
    expect(urls).toHaveLength(1);
    expect(feed.state).toBeNull();
    expect(feed.failed?.error).toBe('Forbidden');
    expect(feed.loading).toBe(false);
  });

  test('a later read that fails keeps the last good answer and shows no failure', async () => {
    answers(delivery({ compression: { enabled: true, min_bytes: 1024 } }), Response.json({ error: 'Down' }, { status: 500 }));
    const { feed } = start();
    await settle();
    expect(feed.state?.compression.enabled).toBe(true);
    await feed.refresh();
    flush();
    expect(feed.state?.compression.enabled).toBe(true);
    expect(feed.failed).toBeNull();
  });

  test('a save is in the state at once with the generation the agent has to answer, and is read again', async () => {
    const urls = answers(delivery({ generation: 100 }));
    const { feed } = start();
    await settle();
    feed.saved({ compression: { enabled: true, min_bytes: 2048 } }, 101);
    expect(feed.state?.compression).toEqual({ enabled: true, min_bytes: 2048 });
    expect(feed.state?.generation).toBe(101);
    await settle();
    expect(urls.length).toBeGreaterThanOrEqual(2);
  });

  test('an answer that was on its way when a save was made is dropped', async () => {
    const slow = deferred<Response>();
    answers(delivery({ generation: 100 }), slow.promise);
    const { feed } = start();
    await settle();
    const reading = feed.refresh();
    await flushMicrotasks();
    feed.saved({ compression: { enabled: true, min_bytes: 2048 } }, 101);
    slow.resolve(Response.json(delivery({ generation: 100 })));
    await reading;
    flush();
    expect(feed.state?.compression.enabled).toBe(true);
    expect(feed.state?.generation).toBe(101);
  });

  test('the wait for the agent counts from the latest save or the first sight of a new generation', async () => {
    answers(delivery({ generation: 100 }));
    const { feed } = start();
    await settle();
    const first = feed.waitingSince;
    expect(first).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 15));
    feed.acted();
    expect(feed.waitingSince).toBeGreaterThan(first);
  });

  test('a removal that was queued is shown at once, newest first, the list keeps 10, and the feed reads again', async () => {
    const row = (id: string) => ({ id, scope: 'app' as const, url: '', state: 'pending' as const, error: '', by: 'Dewi', agent: '', created_at: '2026-11-24T12:00:00Z', finished_at: null });
    const old = Array.from({ length: 10 }, (_, i) => ({ ...row(`old-${i}`), state: 'done' as const }));
    const urls = answers(delivery({ purges: old }));
    const { feed } = start();
    await settle();
    const before = urls.length;
    feed.purged(row('new'));
    expect(feed.state?.purges).toHaveLength(10);
    expect(feed.state?.purges[0].id).toBe('new');
    expect(feed.state?.purges[9].id).toBe('old-8');
    feed.purged(row('new'));
    expect(feed.state?.purges.filter((p) => p.id === 'new')).toHaveLength(1);
    await settle();
    expect(urls.length).toBeGreaterThan(before);
  });

  test('a removal that was queued counts as an action, so the feed reads every 10 seconds for a while', async () => {
    answers(delivery());
    const { feed } = start();
    await settle();
    const first = feed.waitingSince;
    await new Promise((resolve) => setTimeout(resolve, 15));
    feed.purged({ id: 'x', scope: 'app', url: '', state: 'pending', error: '', by: '', agent: '', created_at: '2026-11-24T12:00:00Z', finished_at: null });
    expect(feed.waitingSince).toBeGreaterThan(first);
  });

  test('a new application starts from nothing', async () => {
    answers(delivery());
    const { feed, ctl } = start();
    await settle();
    expect(feed.state).not.toBeNull();
    const slow = deferred<Response>();
    answers(slow.promise);
    ctl.project = 'p2';
    flush();
    expect(feed.state).toBeNull();
    slow.resolve(Response.json(delivery()));
    await settle();
    expect(feed.state).not.toBeNull();
  });
});
