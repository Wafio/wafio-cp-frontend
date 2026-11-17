/**
 * Test support for `.svelte.ts` rune modules under `bun test`.
 *
 * Bun cannot run `$state`/`$derived`/`$effect` directly, so this registers a
 * runtime plugin that compiles `*.svelte.ts` with the Svelte compiler (client
 * output, as in the browser) and stubs the SvelteKit `$app/*` modules. Import
 * this module first, then load rune modules with a dynamic `await import()`
 * so the plugin is active when they are resolved.
 */
import { compileModule } from 'svelte/compiler';

export interface NavigationStub {
  beforeNavigate: Array<(navigation: FakeNavigation) => void>;
  gotoCalls: Array<{ url: unknown; opts: unknown }>;
}

export interface FakeNavigation {
  type: 'link' | 'goto' | 'popstate' | 'form' | 'leave';
  willUnload: boolean;
  to: { url: URL } | null;
  cancelled: boolean;
  cancel(): void;
}

export const navigationStub: NavigationStub = { beforeNavigate: [], gotoCalls: [] };

/** paths.base of the `$app/paths` stub. */
export const TEST_BASE_PATH = '/app';

export function fakeNavigation(type: FakeNavigation['type'], url: string | null, willUnload = false): FakeNavigation {
  return {
    type,
    willUnload,
    to: url ? { url: new URL(url, 'http://localhost') } : null,
    cancelled: false,
    cancel() { this.cancelled = true; },
  };
}

/** Runs every registered beforeNavigate hook, as SvelteKit does. */
export function navigate(navigation: FakeNavigation): FakeNavigation {
  for (const hook of navigationStub.beforeNavigate) hook(navigation);
  return navigation;
}

const REGISTERED = Symbol.for('wafio.tests.svelte-rune-modules');
const registry = globalThis as unknown as Record<symbol, boolean>;

if (!registry[REGISTERED]) {
  registry[REGISTERED] = true;
  Bun.plugin({
    name: 'svelte-rune-modules',
    setup(build) {
      build.module('$app/navigation', () => ({
        loader: 'object',
        exports: {
          beforeNavigate: (hook: (navigation: FakeNavigation) => void) => { navigationStub.beforeNavigate.push(hook); },
          goto: async (url: unknown, opts: unknown) => { navigationStub.gotoCalls.push({ url, opts }); },
        },
      }));
      build.module('$app/paths', () => ({
        loader: 'object',
        exports: {
          resolve: (path: string) => `${TEST_BASE_PATH}/${path}`,
          asset: (file: string) => `${TEST_BASE_PATH}/${file}`,
        },
      }));
      build.onLoad({ filter: /\.svelte\.ts$/ }, async ({ path }) => {
        const source = await Bun.file(path).text();
        const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(source);
        const compiled = compileModule(js, { filename: path, generate: 'client', dev: false });
        return { contents: compiled.js.code, loader: 'js' };
      });
    },
  });
}

/**
 * Deterministic timers for modules that accept a TimerApi (bun 1.2 has no
 * fake timers). `advance(ms)` fires due callbacks in time order and lets
 * promise continuations run between them.
 */
export class FakeClock {
  now = 0;
  #next = 1;
  #timers = new Map<number, { at: number; callback: () => void }>();

  setTimeout = (callback: () => void, ms: number): number => {
    const id = this.#next++;
    this.#timers.set(id, { at: this.now + Math.max(0, ms), callback });
    return id;
  };

  clearTimeout = (handle: unknown): void => {
    this.#timers.delete(handle as number);
  };

  get pending(): number {
    return this.#timers.size;
  }

  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      await flushMicrotasks();
      let nextId: number | null = null;
      let nextAt = Infinity;
      for (const [id, timer] of this.#timers) {
        if (timer.at <= target && timer.at < nextAt) { nextAt = timer.at; nextId = id; }
      }
      if (nextId === null) break;
      const timer = this.#timers.get(nextId)!;
      this.#timers.delete(nextId);
      this.now = timer.at;
      timer.callback();
    }
    this.now = target;
    await flushMicrotasks();
  }
}

export async function flushMicrotasks(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

/** A controllable `document` stand-in for visibility handling. */
export class FakeVisibility {
  hidden = false;
  #listeners = new Set<() => void>();

  addEventListener(_type: 'visibilitychange', listener: () => void): void {
    this.#listeners.add(listener);
  }

  removeEventListener(_type: 'visibilitychange', listener: () => void): void {
    this.#listeners.delete(listener);
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }

  set(hidden: boolean): void {
    this.hidden = hidden;
    for (const listener of [...this.#listeners]) listener();
  }
}

/** A promise with its resolve/reject exposed. */
export function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
