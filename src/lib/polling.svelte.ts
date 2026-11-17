/**
 * Visibility-aware, coalescing poller.
 *
 *   const poller = createPoller((signal) => loadStatus(signal), 5000);
 *
 * Created during component initialisation (or inside an effect) the poller
 * starts once the component is mounted and stops for good when the owner is
 * destroyed. Created anywhere else, call start() and stop() yourself.
 *
 * - Paused while the document is hidden; refreshes once when it is shown
 *   again, then resumes the interval.
 * - Coalesced: runs never overlap. The next run is scheduled after the
 *   previous one settles, and trigger() during a run queues exactly one
 *   follow-up run no matter how often it is called.
 * - stop() aborts the AbortSignal passed to the in-flight run and cancels the
 *   pending timer; nothing runs after stop() until start() is called again,
 *   and nothing runs at all after dispose().
 */

/** The subset of `document` the poller needs; injectable for tests. */
export interface VisibilitySource {
  readonly hidden: boolean;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

/** Timer functions; injectable for tests (bun has no fake timers). */
export interface TimerApi {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const defaultTimers: TimerApi = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function defaultVisibility(): VisibilitySource | null {
  return typeof document !== 'undefined' ? document : null;
}

export type PollFn = (signal: AbortSignal) => unknown;

export interface PollerOptions {
  /** Run as soon as the poller starts (default true). */
  immediate?: boolean;
  /** Pause while the document is hidden (default true). */
  pauseWhenHidden?: boolean;
  /** Run once when the document becomes visible again (default true). */
  refreshOnVisible?: boolean;
  /** Called with errors thrown/rejected by the poll function. */
  onError?: (error: unknown) => void;
  /**
   * Start/stop with the current component or effect when there is one
   * (default true). Pass false when another lifecycle (HostScope) owns it.
   */
  bindToOwner?: boolean;
  visibility?: VisibilitySource | null;
  timers?: TimerApi;
  now?: () => number;
}

export interface Poller {
  /** start() was called and stop() was not. */
  readonly running: boolean;
  /** Running but suspended because the document is hidden. */
  readonly paused: boolean;
  /** A poll is in progress. */
  readonly inFlight: boolean;
  /** Completion time (ms since epoch) of the last run, or null. */
  readonly lastRunAt: number | null;
  /** Error from the last run, or null when it succeeded. */
  readonly lastError: unknown;
  readonly intervalMs: number;
  start(): void;
  stop(): void;
  /** Stops permanently; start() becomes a no-op. */
  dispose(): void;
  /** Runs now (coalesced with an in-flight run); resolves when that run settles. */
  trigger(): Promise<void>;
  setIntervalMs(ms: number): void;
}

export function createPoller(fn: PollFn, intervalMs: number, opts: PollerOptions = {}): Poller {
  const timers = opts.timers ?? defaultTimers;
  const visibility = opts.visibility === undefined ? defaultVisibility() : opts.visibility;
  const pauseWhenHidden = opts.pauseWhenHidden ?? true;
  const now = opts.now ?? Date.now;
  let interval = normaliseInterval(intervalMs);

  // Plain variables drive the logic so that calling start() inside an
  // effect never subscribes that effect to the poller's own state.
  let running = false;
  let disposed = false;
  let paused = false;
  let timer: unknown = null;
  let listening = false;
  let current: Promise<void> | null = null;
  let controller: AbortController | null = null;
  let queued: Promise<void> | null = null;
  let resolveQueued: (() => void) | null = null;

  // Reactive mirror for templates; written, never read, by the logic below.
  const status = $state({
    running: false,
    paused: false,
    inFlight: false,
    lastRunAt: null as number | null,
    lastError: null as unknown,
  });

  const clearTimer = () => {
    if (timer !== null) {
      timers.clearTimeout(timer);
      timer = null;
    }
  };

  const schedule = (delay: number) => {
    clearTimer();
    if (!running || paused || current) return;
    timer = timers.setTimeout(() => {
      timer = null;
      if (running && !paused && !current) void execute();
    }, delay);
  };

  const settleQueued = () => {
    const resolve = resolveQueued;
    queued = null;
    resolveQueued = null;
    resolve?.();
  };

  function execute(): Promise<void> {
    clearTimer();
    const run = new AbortController();
    controller = run;
    status.inFlight = true;
    const promise = (async () => {
      try {
        await fn(run.signal);
        if (!run.signal.aborted) status.lastError = null;
      } catch (error) {
        if (run.signal.aborted) return;
        status.lastError = error;
        try {
          opts.onError?.(error);
        } catch {
          // An error handler must not stop the poller.
        }
      }
    })().finally(() => {
      if (controller === run) controller = null;
      current = null;
      status.inFlight = false;
      status.lastRunAt = now();
      if (queued) {
        const resolve = resolveQueued;
        queued = null;
        resolveQueued = null;
        if (!disposed && running) void execute().then(() => resolve?.());
        else resolve?.();
        return;
      }
      schedule(interval);
    });
    current = promise;
    return promise;
  }

  const onVisibilityChange = () => {
    if (!visibility || !running) return;
    if (visibility.hidden) {
      paused = true;
      status.paused = true;
      clearTimer();
      return;
    }
    paused = false;
    status.paused = false;
    if (current) return;
    schedule((opts.refreshOnVisible ?? true) ? 0 : interval);
  };

  const poller: Poller = {
    get running() { return status.running; },
    get paused() { return status.paused; },
    get inFlight() { return status.inFlight; },
    get lastRunAt() { return status.lastRunAt; },
    get lastError() { return status.lastError; },
    get intervalMs() { return interval; },
    start() {
      if (disposed || running) return;
      running = true;
      status.running = true;
      if (visibility && pauseWhenHidden && !listening) {
        visibility.addEventListener('visibilitychange', onVisibilityChange);
        listening = true;
      }
      paused = Boolean(visibility && pauseWhenHidden && visibility.hidden);
      status.paused = paused;
      // Even the immediate run goes through the timer: fn never runs
      // synchronously inside the caller (component init or an effect).
      if (!paused) schedule((opts.immediate ?? true) ? 0 : interval);
    },
    stop() {
      running = false;
      paused = false;
      status.running = false;
      status.paused = false;
      clearTimer();
      if (listening && visibility) {
        visibility.removeEventListener('visibilitychange', onVisibilityChange);
        listening = false;
      }
      controller?.abort();
      settleQueued();
    },
    dispose() {
      disposed = true;
      poller.stop();
    },
    trigger() {
      if (disposed) return Promise.resolve();
      if (current) {
        if (!queued) queued = new Promise<void>((resolve) => { resolveQueued = resolve; });
        return queued;
      }
      return execute();
    },
    setIntervalMs(ms: number) {
      interval = normaliseInterval(ms);
      if (timer !== null) schedule(interval);
    },
  };

  if (opts.bindToOwner ?? true) bindToOwner(poller);
  return poller;
}

function normaliseInterval(ms: number): number {
  return Number.isFinite(ms) && ms > 0 ? ms : 1000;
}

/**
 * Starts the poller when the current component/effect runs its effects and
 * disposes it when that owner is destroyed. Without an owner ($effect throws
 * "effect_orphan"), the caller manages the lifecycle.
 */
function bindToOwner(poller: Poller): boolean {
  try {
    $effect(() => {
      poller.start();
      return () => poller.dispose();
    });
    return true;
  } catch {
    return false;
  }
}
