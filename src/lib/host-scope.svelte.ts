/**
 * Page lifecycle guard and HostScope.
 *
 * `Lifecycle`, for any page that starts streams or timers after an await:
 *
 *   const life = createLifecycle();          // destroyed with the component
 *   onMount(async () => {
 *     const epoch = life.epoch;
 *     await load();
 *     life.start(() => openStream(), { epoch });   // skipped if destroyed meanwhile
 *     life.poll(() => refresh(), 5000, { epoch });
 *   });
 *
 * `HostScope`, a Lifecycle bound to one project + host, for Firewall, Runtime
 * Security and host detail:
 *
 *   const scope = new HostScope({ projectId });
 *   scope.onReset(() => { config = null; loadedTabs = new Set(); });
 *
 *   $effect(() => { scope.setScope(projectId, selectedHostId); });
 *
 *   async function load() {
 *     const epoch = scope.epoch;
 *     await scope.resolveAgent();
 *     const res = await getEBPFConfig(projectId, scope.agentId, scope.hostId);
 *     if (scope.isStale(epoch)) return;              // host changed meanwhile
 *     config = res.data ?? null;
 *     scope.start(() => openStream(), { epoch });    // never after destroy
 *     scope.poll(() => refreshStatus(), 5000, { epoch });
 *   }
 *
 * Guarantees:
 * - reset() (and, for HostScope, a host or project change through setScope)
 *   bumps the epoch, aborts `signal`, stops every stream/timer started through
 *   the scope, clears the resolved agent and runs the onReset callbacks, so no
 *   field, cache or request from host A can land on host B.
 * - Anything started with an epoch that is no longer current is not started.
 * - After destroy() nothing starts: start() and poll() return false,
 *   register() runs the cleanup immediately, resolveAgent() resolves to
 *   undefined and reset()/setScope() are no-ops.
 * - Streams and pollers started with `pauseWhenHidden` (default) are stopped
 *   while the document is hidden and started again when it is visible.
 * - Created during component initialisation, the instance destroys itself
 *   when the component is destroyed.
 */
import { listHostAgents, type FleetAgent } from './api';
import { createPoller, defaultTimers, defaultVisibility, type PollFn, type PollerOptions, type TimerApi, type VisibilitySource } from './polling.svelte';

export type Cleanup = () => void;
export type Starter = () => Cleanup | void;

export interface LifecycleOptions {
  visibility?: VisibilitySource | null;
  timers?: TimerApi;
  /** Destroy with the current component/effect (default true). */
  bindToOwner?: boolean;
}

export interface StartOptions {
  /** Epoch captured before an await; the task is skipped when it is stale. */
  epoch?: number;
  /** Stop while the document is hidden and restart when visible (default true). */
  pauseWhenHidden?: boolean;
}

interface Task {
  starter: Starter;
  cleanup: Cleanup | null;
  running: boolean;
  pauseWhenHidden: boolean;
}

function runCleanup(cleanup: Cleanup | null | undefined): void {
  if (!cleanup) return;
  try {
    cleanup();
  } catch (error) {
    // One failing cleanup must not keep the others (or the reset) from running.
    console.error('Lifecycle cleanup failed', error);
  }
}

export class Lifecycle {
  /** The document is hidden (pausable tasks are stopped). Reactive. */
  hidden = $state(false);

  // Plain fields: the logic never reads $state, so calling the lifecycle
  // inside an effect does not subscribe that effect to its own writes.
  #epoch = 0;
  #destroyed = false;
  #hiddenNow = false;
  #controller = new AbortController();
  #tasks = new Set<Task>();
  #cleanups = new Set<Cleanup>();
  #resetCallbacks = new Set<(scope: this) => void>();
  #visibility: VisibilitySource | null;
  #timers: TimerApi;

  constructor(opts: LifecycleOptions = {}) {
    this.#timers = opts.timers ?? defaultTimers;
    this.#visibility = opts.visibility === undefined ? defaultVisibility() : opts.visibility;
    if (this.#visibility) {
      this.#hiddenNow = Boolean(this.#visibility.hidden);
      this.hidden = this.#hiddenNow;
      this.#visibility.addEventListener('visibilitychange', this.#onVisibilityChange);
    }
    if (opts.bindToOwner ?? true) {
      try {
        $effect(() => () => this.destroy());
      } catch {
        // No component/effect owner: the caller calls destroy().
      }
    }
  }

  /** Current epoch. Capture it before an await, compare with isStale() after. */
  get epoch(): number {
    return this.#epoch;
  }

  get destroyed(): boolean {
    return this.#destroyed;
  }

  /** Aborted on reset and destroy; pass it to fetches. */
  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  /** True when `epoch` is no longer current or the lifecycle was destroyed. */
  isStale(epoch: number): boolean {
    return this.#destroyed || epoch !== this.#epoch;
  }

  /**
   * Invalidates everything bound to the current epoch: aborts the signal,
   * stops streams/timers and runs onReset callbacks (in registration order).
   */
  reset(): void {
    if (this.#destroyed) return;
    this.#epoch += 1;
    this.#teardown();
    this.#controller = new AbortController();
    this.resetState();
    for (const callback of [...this.#resetCallbacks]) {
      try {
        callback(this);
      } catch (error) {
        console.error('Lifecycle onReset callback failed', error);
      }
    }
  }

  /** Subclass hook: clear per-scope state before the onReset callbacks run. */
  protected resetState(): void {}

  /** Runs `callback` on every reset. Returns an unsubscribe function. */
  onReset(callback: (scope: this) => void): Cleanup {
    if (this.#destroyed) return () => {};
    this.#resetCallbacks.add(callback);
    return () => { this.#resetCallbacks.delete(callback); };
  }

  /**
   * Registers a cleanup for the current epoch (an EventSource close, a
   * clearInterval). It runs on the next reset or on destroy. The returned
   * function runs it early and unregisters it. For a stale epoch or after
   * destroy the cleanup runs immediately.
   */
  register(cleanup: Cleanup, epoch: number = this.#epoch): Cleanup {
    if (this.isStale(epoch)) {
      runCleanup(cleanup);
      return () => {};
    }
    let done = false;
    const once: Cleanup = () => {
      if (done) return;
      done = true;
      this.#cleanups.delete(once);
      runCleanup(cleanup);
    };
    this.#cleanups.add(once);
    return once;
  }

  /**
   * Starts a stream or timer bound to the current epoch. `starter` returns
   * its cleanup. Not started (returns false) when the epoch is stale or the
   * lifecycle is destroyed; paused while the document is hidden unless
   * `pauseWhenHidden: false`. Returns true when the task was accepted (it may
   * be waiting for the document to become visible).
   */
  start(starter: Starter, opts: StartOptions = {}): boolean {
    const epoch = opts.epoch ?? this.#epoch;
    if (this.isStale(epoch)) return false;
    const task: Task = { starter, cleanup: null, running: false, pauseWhenHidden: opts.pauseWhenHidden ?? true };
    this.#tasks.add(task);
    if (!(task.pauseWhenHidden && this.#hiddenNow)) this.#runTask(task);
    return true;
  }

  /**
   * Polls `fn` every `intervalMs` for the current epoch: coalesced, paused
   * while hidden (with a refresh when visible again), stopped on reset and
   * destroy. Returns false when not started (stale epoch or destroyed).
   */
  poll(fn: PollFn, intervalMs: number, opts: StartOptions & Pick<PollerOptions, 'immediate' | 'onError'> = {}): boolean {
    return this.start(() => {
      const poller = createPoller(fn, intervalMs, {
        immediate: opts.immediate,
        onError: opts.onError,
        // The lifecycle pauses/resumes the whole task on visibility changes.
        visibility: null,
        timers: this.#timers,
        bindToOwner: false,
      });
      poller.start();
      return () => poller.dispose();
    }, opts);
  }

  /** Stops everything for good. Idempotent. */
  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#epoch += 1;
    this.#teardown();
    this.#resetCallbacks.clear();
    if (this.#visibility) this.#visibility.removeEventListener('visibilitychange', this.#onVisibilityChange);
  }

  #runTask(task: Task): void {
    if (task.running) return;
    task.running = true;
    try {
      const cleanup = task.starter();
      task.cleanup = typeof cleanup === 'function' ? cleanup : null;
    } catch (error) {
      task.running = false;
      this.#tasks.delete(task);
      throw error;
    }
  }

  #stopTask(task: Task): void {
    if (!task.running) return;
    task.running = false;
    const cleanup = task.cleanup;
    task.cleanup = null;
    runCleanup(cleanup);
  }

  #teardown(): void {
    this.#controller.abort();
    const tasks = [...this.#tasks];
    this.#tasks.clear();
    for (const task of tasks) this.#stopTask(task);
    const cleanups = [...this.#cleanups];
    this.#cleanups.clear();
    for (const cleanup of cleanups) runCleanup(cleanup);
  }

  #onVisibilityChange = (): void => {
    if (this.#destroyed || !this.#visibility) return;
    const hidden = Boolean(this.#visibility.hidden);
    if (hidden === this.#hiddenNow) return;
    this.#hiddenNow = hidden;
    this.hidden = hidden;
    for (const task of [...this.#tasks]) {
      if (!task.pauseWhenHidden) continue;
      if (hidden) this.#stopTask(task);
      else if (this.#tasks.has(task)) {
        try {
          this.#runTask(task);
        } catch (error) {
          console.error('Lifecycle task restart failed', error);
        }
      }
    }
  };
}

/** Creates a Lifecycle; during component initialisation it is destroyed with the component. */
export function createLifecycle(opts: LifecycleOptions = {}): Lifecycle {
  return new Lifecycle(opts);
}

// ── HostScope ──────────────────────────────────────────────────────────────

export type AgentStatus = 'idle' | 'resolving' | 'ready' | 'missing' | 'error';

export interface AgentResolverContext {
  projectId: string;
  hostId: string;
  signal: AbortSignal;
}

/** Resolves the host agent (kind "host") for a host; undefined when it has none. */
export type AgentResolver = (ctx: AgentResolverContext) => Promise<FleetAgent | undefined>;

export interface HostScopeOptions extends LifecycleOptions {
  projectId?: string;
  hostId?: string;
  resolveAgent?: AgentResolver;
}

/**
 * Default resolver: the host's agent of kind "host" (never a WAF agent, an
 * undefined agent id must not fall through to the project's default agent).
 */
export const resolveHostAgent: AgentResolver = async ({ projectId, hostId }) => {
  const result = await listHostAgents(projectId, hostId);
  if (result.error) throw new Error(result.error.error);
  return result.data?.agents?.find((agent) => agent.kind === 'host');
};

export class HostScope extends Lifecycle {
  /** Reactive, for templates. */
  projectId = $state('');
  hostId = $state('');
  agent = $state.raw<FleetAgent | undefined>(undefined);
  agentId = $state<string | undefined>(undefined);
  agentStatus = $state<AgentStatus>('idle');

  #projectId = '';
  #hostId = '';
  #resolver: AgentResolver;
  #resolving: Promise<string | undefined> | null = null;
  #resolvingEpoch = -1;

  constructor(opts: HostScopeOptions = {}) {
    super(opts);
    this.#projectId = opts.projectId ?? '';
    this.#hostId = opts.hostId ?? '';
    this.projectId = this.#projectId;
    this.hostId = this.#hostId;
    this.#resolver = opts.resolveAgent ?? resolveHostAgent;
  }

  /**
   * Switches to another project/host. Returns true (after a full reset) when
   * either changed, false when nothing changed or the scope is destroyed.
   */
  setScope(projectId: string, hostId: string): boolean {
    if (this.destroyed) return false;
    if (projectId === this.#projectId && hostId === this.#hostId) return false;
    this.#projectId = projectId;
    this.#hostId = hostId;
    this.projectId = projectId;
    this.hostId = hostId;
    this.reset();
    return true;
  }

  /** setScope() with the current project. */
  setHost(hostId: string): boolean {
    return this.setScope(this.#projectId, hostId);
  }

  protected override resetState(): void {
    this.#resolving = null;
    this.#resolvingEpoch = -1;
    this.agent = undefined;
    this.agentId = undefined;
    this.agentStatus = 'idle';
  }

  /**
   * Resolves the host agent for the current host (deduplicated per epoch).
   * Sets agent/agentId/agentStatus unless the scope changed meanwhile; a
   * stale or destroyed scope resolves to undefined and changes nothing.
   */
  resolveAgent(): Promise<string | undefined> {
    if (this.destroyed) return Promise.resolve(undefined);
    const epoch = this.epoch;
    if (this.#resolving && this.#resolvingEpoch === epoch) return this.#resolving;
    const projectId = this.#projectId;
    const hostId = this.#hostId;
    if (!hostId || !projectId) {
      this.agent = undefined;
      this.agentId = undefined;
      this.agentStatus = 'missing';
      return Promise.resolve(undefined);
    }
    this.agentStatus = 'resolving';
    const signal = this.signal;
    const promise = (async () => {
      try {
        const agent = await this.#resolver({ projectId, hostId, signal });
        if (this.isStale(epoch)) return undefined;
        this.agent = agent;
        this.agentId = agent?.id;
        this.agentStatus = agent ? 'ready' : 'missing';
        return agent?.id;
      } catch {
        if (this.isStale(epoch)) return undefined;
        this.agent = undefined;
        this.agentId = undefined;
        this.agentStatus = 'error';
        return undefined;
      } finally {
        if (this.#resolvingEpoch === epoch) {
          this.#resolving = null;
          this.#resolvingEpoch = -1;
        }
      }
    })();
    this.#resolving = promise;
    this.#resolvingEpoch = epoch;
    return promise;
  }

  override destroy(): void {
    super.destroy();
    this.#resolving = null;
  }
}

/** Creates a HostScope; during component initialisation it is destroyed with the component. */
export function createHostScope(opts: HostScopeOptions = {}): HostScope {
  return new HostScope(opts);
}
