import { describe, expect, test } from 'bun:test';
import { deferred, FakeClock, FakeVisibility, flushMicrotasks } from './support/runes';
import { effect_root, flush } from 'svelte/internal/client';

const { createPoller } = await import('../src/lib/polling.svelte');

function setup(opts: { hidden?: boolean; immediate?: boolean } = {}) {
  const clock = new FakeClock();
  const visibility = new FakeVisibility();
  visibility.hidden = opts.hidden ?? false;
  const calls: AbortSignal[] = [];
  return { clock, visibility, calls };
}

describe('createPoller', () => {
  test('runs immediately (never synchronously) and then every interval', async () => {
    const { clock, visibility, calls } = setup();
    const poller = createPoller((signal) => { calls.push(signal); }, 1000, { timers: clock, visibility, now: () => clock.now });
    poller.start();
    expect(calls).toHaveLength(0);
    await clock.advance(0);
    expect(calls).toHaveLength(1);
    await clock.advance(999);
    expect(calls).toHaveLength(1);
    await clock.advance(1);
    expect(calls).toHaveLength(2);
    await clock.advance(3000);
    expect(calls).toHaveLength(5);
    expect(poller.running).toBe(true);
    expect(poller.lastRunAt).toBe(4000);
    poller.stop();
  });

  test('immediate: false waits a full interval', async () => {
    const { clock, visibility, calls } = setup();
    const poller = createPoller((s) => { calls.push(s); }, 500, { timers: clock, visibility, immediate: false });
    poller.start();
    await clock.advance(499);
    expect(calls).toHaveLength(0);
    await clock.advance(1);
    expect(calls).toHaveLength(1);
    poller.stop();
  });

  test('runs never overlap: the next run is scheduled after the previous settles', async () => {
    const { clock, visibility } = setup();
    let active = 0;
    let maxActive = 0;
    const pending: Array<() => void> = [];
    const poller = createPoller(() => {
      active++;
      maxActive = Math.max(maxActive, active);
      const d = deferred();
      pending.push(() => { active--; d.resolve(); });
      return d.promise;
    }, 100, { timers: clock, visibility });
    poller.start();
    await clock.advance(0);
    expect(poller.inFlight).toBe(true);
    await clock.advance(1000); // slow request: no new run while in flight
    expect(pending).toHaveLength(1);
    pending.shift()!();
    await flushMicrotasks();
    expect(poller.inFlight).toBe(false);
    await clock.advance(100);
    expect(pending).toHaveLength(1);
    expect(maxActive).toBe(1);
    pending.shift()!();
    poller.stop();
  });

  test('trigger() during a run queues exactly one follow-up run', async () => {
    const { clock, visibility } = setup();
    let runs = 0;
    const gates: Array<ReturnType<typeof deferred>> = [];
    const poller = createPoller(() => { runs++; const d = deferred(); gates.push(d); return d.promise; }, 10_000, { timers: clock, visibility });
    poller.start();
    await clock.advance(0);
    expect(runs).toBe(1);
    const a = poller.trigger();
    const b = poller.trigger();
    const c = poller.trigger();
    expect(a).toBe(b);
    expect(b).toBe(c);
    let settled = false;
    void a.then(() => { settled = true; });
    gates[0].resolve();
    await flushMicrotasks();
    expect(runs).toBe(2);
    expect(settled).toBe(false);
    gates[1].resolve();
    await flushMicrotasks();
    expect(settled).toBe(true);
    expect(runs).toBe(2);
    poller.stop();
  });

  test('pauses while hidden and refreshes once when visible again', async () => {
    const { clock, visibility, calls } = setup();
    const poller = createPoller((s) => { calls.push(s); }, 1000, { timers: clock, visibility });
    poller.start();
    await clock.advance(0);
    expect(calls).toHaveLength(1);
    visibility.set(true);
    expect(poller.paused).toBe(true);
    await clock.advance(10_000);
    expect(calls).toHaveLength(1);
    visibility.set(false);
    expect(poller.paused).toBe(false);
    await clock.advance(0);
    expect(calls).toHaveLength(2);
    await clock.advance(1000);
    expect(calls).toHaveLength(3);
    poller.stop();
  });

  test('starting while hidden waits for visibility', async () => {
    const { clock, visibility, calls } = setup({ hidden: true });
    const poller = createPoller((s) => { calls.push(s); }, 1000, { timers: clock, visibility });
    poller.start();
    expect(poller.paused).toBe(true);
    await clock.advance(5000);
    expect(calls).toHaveLength(0);
    visibility.set(false);
    await clock.advance(0);
    expect(calls).toHaveLength(1);
    poller.stop();
  });

  test('stop() aborts the in-flight run, cancels the timer and removes the listener', async () => {
    const { clock, visibility, calls } = setup();
    const gate = deferred();
    const poller = createPoller((signal) => { calls.push(signal); return gate.promise; }, 1000, { timers: clock, visibility });
    poller.start();
    await clock.advance(0);
    expect(visibility.listenerCount).toBe(1);
    poller.stop();
    expect(calls[0].aborted).toBe(true);
    expect(visibility.listenerCount).toBe(0);
    gate.resolve();
    await clock.advance(10_000);
    expect(calls).toHaveLength(1);
    expect(clock.pending).toBe(0);
    expect(poller.running).toBe(false);
  });

  test('errors are reported and polling continues', async () => {
    const { clock, visibility } = setup();
    const errors: unknown[] = [];
    let n = 0;
    const poller = createPoller(() => { n++; if (n === 1) throw new Error('boom'); }, 100, { timers: clock, visibility, onError: (e) => errors.push(e) });
    poller.start();
    await clock.advance(0);
    expect(errors).toHaveLength(1);
    expect((poller.lastError as Error).message).toBe('boom');
    await clock.advance(100);
    expect(n).toBe(2);
    expect(poller.lastError).toBeNull();
    poller.stop();
  });

  test('dispose() is final', async () => {
    const { clock, visibility, calls } = setup();
    const poller = createPoller((s) => { calls.push(s); }, 100, { timers: clock, visibility });
    poller.dispose();
    poller.start();
    await poller.trigger();
    await clock.advance(1000);
    expect(calls).toHaveLength(0);
  });

  test('bound to an owner: starts when effects run, disposed when the owner is destroyed', async () => {
    const { clock, visibility, calls } = setup();
    let poller!: ReturnType<typeof createPoller>;
    const destroy = effect_root(() => {
      poller = createPoller((s) => { calls.push(s); }, 100, { timers: clock, visibility });
    });
    expect(poller.running).toBe(false);
    flush();
    expect(poller.running).toBe(true);
    await clock.advance(0);
    expect(calls).toHaveLength(1);
    destroy();
    expect(poller.running).toBe(false);
    poller.start();
    await clock.advance(1000);
    expect(calls).toHaveLength(1);
  });

  test('setIntervalMs reschedules the pending tick', async () => {
    const { clock, visibility, calls } = setup();
    const poller = createPoller((s) => { calls.push(s); }, 10_000, { timers: clock, visibility });
    poller.start();
    await clock.advance(0);
    poller.setIntervalMs(50);
    await clock.advance(50);
    expect(calls).toHaveLength(2);
    expect(poller.intervalMs).toBe(50);
    poller.stop();
  });
});
