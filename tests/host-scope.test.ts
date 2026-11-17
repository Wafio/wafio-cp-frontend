import { describe, expect, test } from 'bun:test';
import { deferred, FakeClock, FakeVisibility, flushMicrotasks } from './support/runes';
import { effect_root, flush } from 'svelte/internal/client';
import type { FleetAgent } from '../src/lib/api';

const { HostScope, Lifecycle, createLifecycle } = await import('../src/lib/host-scope.svelte');

const agent = (id: string, kind = 'host'): FleetAgent => ({ id, name: id, kind, is_online: true, created_at: '2026-09-27T00:00:00Z' });

function setup(opts: { hidden?: boolean; agents?: Record<string, FleetAgent | undefined> } = {}) {
  const clock = new FakeClock();
  const visibility = new FakeVisibility();
  visibility.hidden = opts.hidden ?? false;
  const resolverCalls: Array<{ projectId: string; hostId: string; signal: AbortSignal }> = [];
  const scope = new HostScope({
    projectId: 'p1',
    timers: clock,
    visibility,
    resolveAgent: async (ctx) => { resolverCalls.push(ctx); return opts.agents?.[ctx.hostId]; },
  });
  return { clock, visibility, scope, resolverCalls };
}

describe('epoch and host switching', () => {
  test('setScope bumps the epoch, aborts the signal and runs onReset callbacks in order', () => {
    const { scope } = setup();
    const order: string[] = [];
    scope.onReset(() => order.push('config'));
    scope.onReset(() => order.push('tabs'));
    expect(scope.setScope('p1', 'host-a')).toBe(true);
    const epochA = scope.epoch;
    const signalA = scope.signal;
    expect(scope.setScope('p1', 'host-a')).toBe(false);
    expect(scope.epoch).toBe(epochA);
    expect(scope.setHost('host-b')).toBe(true);
    expect(scope.isStale(epochA)).toBe(true);
    expect(scope.isStale(scope.epoch)).toBe(false);
    expect(signalA.aborted).toBe(true);
    expect(scope.signal.aborted).toBe(false);
    expect(scope.hostId).toBe('host-b');
    expect(order).toEqual(['config', 'tabs', 'config', 'tabs']);
    scope.destroy();
  });

  test('a response for host A that arrives after switching to B is stale', async () => {
    const { scope } = setup();
    scope.setHost('host-a');
    const response = deferred<string>();
    let config: string | null = null;
    const load = async () => {
      const epoch = scope.epoch;
      const value = await response.promise;
      if (scope.isStale(epoch)) return;
      config = value;
    };
    const pending = load();
    scope.setHost('host-b');
    response.resolve('config of A');
    await pending;
    expect(config).toBeNull();
    scope.destroy();
  });

  test('onReset unsubscribe', () => {
    const { scope } = setup();
    let n = 0;
    const off = scope.onReset(() => n++);
    scope.reset();
    off();
    scope.reset();
    expect(n).toBe(1);
    scope.destroy();
  });

  test('resolveAgent picks the resolver result and forgets it on reset', async () => {
    const { scope, resolverCalls } = setup({ agents: { 'host-a': agent('agent-a'), 'host-b': undefined } });
    scope.setHost('host-a');
    await expect(scope.resolveAgent()).resolves.toBe('agent-a');
    expect(scope.agentId).toBe('agent-a');
    expect(scope.agentStatus).toBe('ready');
    expect(resolverCalls[0]).toMatchObject({ projectId: 'p1', hostId: 'host-a' });
    scope.setHost('host-b');
    expect(scope.agentId).toBeUndefined();
    expect(scope.agentStatus).toBe('idle');
    await expect(scope.resolveAgent()).resolves.toBeUndefined();
    expect(scope.agentStatus).toBe('missing');
    scope.destroy();
  });

  test('a slow agent resolution for host A never lands on host B', async () => {
    const gate = deferred<FleetAgent | undefined>();
    const scope = new HostScope({ projectId: 'p1', hostId: 'host-a', visibility: null, resolveAgent: () => gate.promise });
    const resolving = scope.resolveAgent();
    expect(scope.agentStatus).toBe('resolving');
    scope.setHost('host-b');
    gate.resolve(agent('agent-a'));
    await expect(resolving).resolves.toBeUndefined();
    expect(scope.agentId).toBeUndefined();
    expect(scope.agentStatus).toBe('idle');
    scope.destroy();
  });

  test('concurrent resolveAgent calls in one epoch share one request', async () => {
    const { scope, resolverCalls } = setup({ agents: { h: agent('a') } });
    scope.setHost('h');
    const [x, y] = await Promise.all([scope.resolveAgent(), scope.resolveAgent()]);
    expect(x).toBe('a');
    expect(y).toBe('a');
    expect(resolverCalls).toHaveLength(1);
    scope.destroy();
  });

  test('a failing resolver reports error without throwing', async () => {
    const scope = new HostScope({ projectId: 'p1', hostId: 'h', visibility: null, resolveAgent: async () => { throw new Error('500'); } });
    await expect(scope.resolveAgent()).resolves.toBeUndefined();
    expect(scope.agentStatus).toBe('error');
    scope.destroy();
  });

  test('no host selected resolves to missing without a request', async () => {
    const { scope, resolverCalls } = setup();
    await expect(scope.resolveAgent()).resolves.toBeUndefined();
    expect(scope.agentStatus).toBe('missing');
    expect(resolverCalls).toHaveLength(0);
    scope.destroy();
  });
});

describe('streams and timers', () => {
  test('start() runs now and its cleanup runs on reset', () => {
    const { scope } = setup();
    scope.setHost('a');
    const log: string[] = [];
    expect(scope.start(() => { log.push('open'); return () => log.push('close'); })).toBe(true);
    expect(log).toEqual(['open']);
    scope.setHost('b');
    expect(log).toEqual(['open', 'close']);
    scope.destroy();
    expect(log).toEqual(['open', 'close']);
  });

  test('a stream started after an await with a stale epoch is never opened', async () => {
    const { scope } = setup();
    scope.setHost('a');
    const epoch = scope.epoch;
    await flushMicrotasks();
    scope.setHost('b');
    let opened = false;
    expect(scope.start(() => { opened = true; }, { epoch })).toBe(false);
    expect(opened).toBe(false);
    scope.destroy();
  });

  test('register() cleanups run on reset; the returned function runs one early', () => {
    const { scope } = setup();
    const log: string[] = [];
    scope.register(() => log.push('a'));
    const early = scope.register(() => log.push('b'));
    early();
    early();
    expect(log).toEqual(['b']);
    scope.reset();
    expect(log).toEqual(['b', 'a']);
    scope.destroy();
  });

  test('a throwing cleanup does not stop the others', () => {
    const { scope } = setup();
    const log: string[] = [];
    const originalError = console.error;
    console.error = () => {};
    try {
      scope.register(() => { throw new Error('bad'); });
      scope.register(() => log.push('ok'));
      scope.reset();
    } finally {
      console.error = originalError;
    }
    expect(log).toEqual(['ok']);
    scope.destroy();
  });

  test('poll() is coalesced, bound to the epoch and stopped on reset', async () => {
    const { scope, clock } = setup();
    scope.setHost('a');
    const hosts: string[] = [];
    expect(scope.poll(() => { hosts.push('a'); }, 1000)).toBe(true);
    await clock.advance(0);
    await clock.advance(2000);
    expect(hosts).toEqual(['a', 'a', 'a']);
    scope.setHost('b');
    await clock.advance(5000);
    expect(hosts).toEqual(['a', 'a', 'a']);
    expect(clock.pending).toBe(0);
    scope.destroy();
  });
});

describe('visibility', () => {
  test('pausable tasks stop while hidden and restart when visible', async () => {
    const { scope, visibility, clock } = setup();
    scope.setHost('a');
    const log: string[] = [];
    scope.start(() => { log.push('open'); return () => log.push('close'); });
    scope.start(() => { log.push('open-always'); return () => log.push('close-always'); }, { pauseWhenHidden: false });
    let polls = 0;
    scope.poll(() => { polls++; }, 1000);
    await clock.advance(0);
    expect(polls).toBe(1);
    visibility.set(true);
    expect(scope.hidden).toBe(true);
    expect(log).toEqual(['open', 'open-always', 'close']);
    await clock.advance(10_000);
    expect(polls).toBe(1);
    visibility.set(false);
    expect(log).toEqual(['open', 'open-always', 'close', 'open']);
    await clock.advance(0);
    expect(polls).toBe(2);
    scope.destroy();
    expect(log).toEqual(['open', 'open-always', 'close', 'open', 'close', 'close-always']);
  });

  test('a task started while hidden waits for visibility', () => {
    const { scope, visibility } = setup({ hidden: true });
    let opened = 0;
    expect(scope.start(() => { opened++; })).toBe(true);
    expect(opened).toBe(0);
    visibility.set(false);
    expect(opened).toBe(1);
    scope.destroy();
  });

  test('a task stopped by reset is not restarted by a later visibility change', () => {
    const { scope, visibility } = setup();
    let opened = 0;
    scope.start(() => { opened++; });
    visibility.set(true);
    scope.reset();
    visibility.set(false);
    expect(opened).toBe(1);
    scope.destroy();
  });
});

describe('destroy()', () => {
  test('nothing starts after destroy', async () => {
    const { scope, visibility, clock, resolverCalls } = setup({ agents: { a: agent('x') } });
    scope.setHost('a');
    scope.destroy();
    expect(scope.destroyed).toBe(true);
    expect(scope.signal.aborted).toBe(true);
    let started = false;
    expect(scope.start(() => { started = true; })).toBe(false);
    expect(scope.poll(() => { started = true; }, 10)).toBe(false);
    const log: string[] = [];
    scope.register(() => log.push('ran immediately'));
    expect(log).toEqual(['ran immediately']);
    await expect(scope.resolveAgent()).resolves.toBeUndefined();
    expect(resolverCalls).toHaveLength(0);
    expect(scope.setHost('b')).toBe(false);
    let resets = 0;
    scope.onReset(() => resets++);
    scope.reset();
    expect(resets).toBe(0);
    visibility.set(true);
    visibility.set(false);
    await clock.advance(1000);
    expect(started).toBe(false);
    expect(visibility.listenerCount).toBe(0);
  });

  test('destroy during an awaited load keeps the continuation from starting a stream', async () => {
    const { scope } = setup();
    scope.setHost('a');
    const gate = deferred();
    let opened = false;
    const init = (async () => {
      const epoch = scope.epoch;
      await gate.promise;
      scope.start(() => { opened = true; }, { epoch });
    })();
    scope.destroy();
    gate.resolve();
    await init;
    expect(opened).toBe(false);
  });

  test('destroy is idempotent and runs every cleanup once', () => {
    const { scope } = setup();
    let closes = 0;
    scope.start(() => () => { closes++; });
    scope.destroy();
    scope.destroy();
    expect(closes).toBe(1);
  });

  test('Lifecycle (non-host pages): a stream started after an await is skipped once destroyed', async () => {
    const life = new Lifecycle({ visibility: null, bindToOwner: false });
    const gate = deferred();
    const opened: string[] = [];
    const mount = (async () => {
      const epoch = life.epoch;
      await gate.promise;
      life.start(() => { opened.push('sse'); }, { epoch });
    })();
    life.destroy();
    gate.resolve();
    await mount;
    expect(opened).toEqual([]);
    expect(life.signal.aborted).toBe(true);
  });

  test('Lifecycle reset passes the instance to callbacks and stops its pollers', async () => {
    const clock = new FakeClock();
    const life = createLifecycle({ visibility: null, timers: clock });
    let polls = 0;
    life.poll(() => { polls++; }, 100);
    await clock.advance(250);
    expect(polls).toBe(3);
    let seen: unknown = null;
    life.onReset((instance) => { seen = instance; });
    life.reset();
    expect(seen).toBe(life);
    await clock.advance(1000);
    expect(polls).toBe(3);
    life.destroy();
  });

  test('created during component initialisation, it is destroyed with the component', () => {
    let scope!: InstanceType<typeof HostScope>;
    const destroyRoot = effect_root(() => {
      scope = new HostScope({ projectId: 'p1', hostId: 'a', visibility: null, resolveAgent: async () => undefined });
    });
    flush();
    let closes = 0;
    scope.start(() => () => { closes++; });
    expect(scope.destroyed).toBe(false);
    destroyRoot();
    expect(scope.destroyed).toBe(true);
    expect(closes).toBe(1);
  });
});
