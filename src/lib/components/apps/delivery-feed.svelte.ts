/**
 * The delivery settings of one application and what its WAF agent reported, kept current for the tabs that show
 * them (Speed, Gateway, Routing). One feed lives as long as the application page: it reads while one of those tabs
 * is open, every 10 s while the agent has not answered a save and every 60 s otherwise, and it keeps the last good
 * answer when a later read fails. Create it while a component initialises.
 */
import { untrack } from 'svelte';
import { getAppDelivery, type ApiError, type AppDelivery } from '#lib/api.js';
import { createPoller } from '#lib/polling.svelte.js';
import { POLL_SLOW_MS, pollIntervalMs, withSaved } from './speed';

export interface DeliveryFeed {
  /** The last answer, null until the first read ends well. */
  readonly state: AppDelivery | null;
  /** The first read is running. */
  readonly loading: boolean;
  /** The first read failed (a later failure keeps the last answer). */
  readonly failed: ApiError | null;
  /** Ticks every 5 s, so the waits of the lines stay true between reads. */
  readonly now: number;
  /** Epoch ms the agent was first seen at the bundle generation it has now, or the last save, whichever is later. */
  readonly waitingSince: number;
  refresh(): Promise<void>;
  /** A save answered: the part as stored and the generation the agent has to answer; the feed then reads again. */
  saved(part: Partial<Pick<AppDelivery, 'compression' | 'static_files' | 'cache'>>, generation: number | null): void;
  /** Something that changes what the agent reports was saved elsewhere (the main host name, the path prefix). */
  acted(): void;
}

export function createDeliveryFeed(o: { projectId: () => string; appId: () => string; active: () => boolean }): DeliveryFeed {
  let state = $state<AppDelivery | null>(null);
  let loading = $state(false);
  let failed = $state<ApiError | null>(null);
  let now = $state(Date.now());
  let seenAt = $state(Date.now());
  let lastActionAt = $state<number | null>(null);
  let epoch = 0;
  let key = '';

  function take(next: AppDelivery) {
    if (state === null || next.generation !== state.generation) seenAt = Date.now();
    state = next;
  }

  async function read() {
    const my = ++epoch;
    const first = state === null;
    if (first) {
      loading = true;
      failed = null;
    }
    const res = await getAppDelivery(o.projectId(), o.appId());
    // A read that is not the newest, or that meets a save, is dropped.
    if (my !== epoch) return;
    loading = false;
    if (res.error || !res.data) {
      if (first) failed = res.error ?? { error: 'Could not read the settings.' };
      return;
    }
    failed = null;
    take(res.data);
  }

  const poller = createPoller(() => read(), POLL_SLOW_MS, { bindToOwner: false });

  $effect(() => {
    const next = `${o.projectId()}/${o.appId()}`;
    const on = o.active();
    untrack(() => {
      if (next !== key) {
        key = next;
        epoch++;
        state = null;
        failed = null;
        loading = false;
        lastActionAt = null;
      }
    });
    if (!on) return;
    poller.start();
    const tick = setInterval(() => (now = Date.now()), 5000);
    return () => {
      poller.stop();
      clearInterval(tick);
    };
  });

  $effect(() => {
    const ms = pollIntervalMs(state, lastActionAt, now);
    // setIntervalMs also pushes back a read that is due now (the one a tab opens with): leave it alone when nothing changes.
    if (ms !== poller.intervalMs) poller.setIntervalMs(ms);
  });
  $effect(() => () => poller.dispose());

  return {
    get state() { return state; },
    get loading() { return loading; },
    get failed() { return failed; },
    get now() { return now; },
    get waitingSince() { return Math.max(seenAt, lastActionAt ?? 0); },
    refresh: () => poller.trigger(),
    saved(part, generation) {
      epoch++;
      if (state) take(withSaved(state, part, generation));
      lastActionAt = Date.now();
      void poller.trigger();
    },
    acted() {
      lastActionAt = Date.now();
      void poller.trigger();
    },
  };
}
