/**
 * Dismiss timers for toasts.
 *
 * Each toast with a positive duration gets one timer. The timer pauses while
 * the toast is hovered or holds keyboard focus (each is a separate reason, so
 * leaving with the mouse while a button inside still has focus keeps it
 * paused) and resumes with the time that was left, not the full duration.
 * `sync()` is idempotent: it arms only toasts it has never seen, so calling it
 * on every store change never re-arms a paused (hovered/focused) toast.
 * A duration of 0 or less means the toast stays until dismissed.
 */

export type PauseReason = 'hover' | 'focus';

export interface TimerClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemClock: TimerClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface Entry {
  remaining: number;
  startedAt: number;
  handle: unknown;
  reasons: Set<PauseReason>;
}

export class ToastTimers {
  readonly #entries = new Map<string, Entry>();
  readonly #onExpire: (id: string) => void;
  readonly #clock: TimerClock;

  constructor(onExpire: (id: string) => void, clock: TimerClock = systemClock) {
    this.#onExpire = onExpire;
    this.#clock = clock;
  }

  /** Arms timers for new toasts and forgets toasts that are gone. */
  sync(items: readonly { id: string; duration: number }[]): void {
    const present = new Set<string>();
    for (const item of items) {
      present.add(item.id);
      if (item.duration <= 0 || this.#entries.has(item.id)) continue;
      const entry: Entry = { remaining: item.duration, startedAt: 0, handle: null, reasons: new Set() };
      this.#entries.set(item.id, entry);
      this.#start(item.id, entry);
    }
    for (const id of [...this.#entries.keys()]) {
      if (!present.has(id)) this.forget(id);
    }
  }

  pause(id: string, reason: PauseReason): void {
    const entry = this.#entries.get(id);
    if (!entry) return;
    const wasRunning = entry.reasons.size === 0;
    entry.reasons.add(reason);
    if (!wasRunning || entry.handle === null) return;
    this.#clock.clearTimeout(entry.handle);
    entry.handle = null;
    entry.remaining = Math.max(0, entry.remaining - (this.#clock.now() - entry.startedAt));
  }

  resume(id: string, reason: PauseReason): void {
    const entry = this.#entries.get(id);
    if (!entry || !entry.reasons.delete(reason) || entry.reasons.size > 0) return;
    this.#start(id, entry);
  }

  isPaused(id: string): boolean {
    return (this.#entries.get(id)?.reasons.size ?? 0) > 0;
  }

  /** Milliseconds left, or null for a toast without a timer. */
  remaining(id: string): number | null {
    const entry = this.#entries.get(id);
    if (!entry) return null;
    if (entry.handle === null) return entry.remaining;
    return Math.max(0, entry.remaining - (this.#clock.now() - entry.startedAt));
  }

  forget(id: string): void {
    const entry = this.#entries.get(id);
    if (!entry) return;
    if (entry.handle !== null) this.#clock.clearTimeout(entry.handle);
    this.#entries.delete(id);
  }

  dispose(): void {
    for (const id of [...this.#entries.keys()]) this.forget(id);
  }

  #start(id: string, entry: Entry): void {
    entry.startedAt = this.#clock.now();
    entry.handle = this.#clock.setTimeout(() => {
      this.#entries.delete(id);
      this.#onExpire(id);
    }, entry.remaining);
  }
}
