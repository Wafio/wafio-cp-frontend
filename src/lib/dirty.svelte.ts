/**
 * Unsaved-change tracking.
 *
 *   let form = $state(emptyForm());
 *   const dirty = createDirtyTracker(() => form);
 *   dirty.guardNavigation();                 // during component initialisation
 *
 *   async function load() { form = fromRules(await fetchRules()); dirty.reset(); }
 *   async function save() { await putRules(toRules(form)); dirty.reset(); }
 *   async function switchTab(next) { if (await dirty.confirmDiscard()) tab = next; }
 *
 * `isDirty` compares a `$state.snapshot` of the current value with the
 * baseline taken at creation or at the last reset(); it is reactive, so a
 * template can show "Unsaved changes" and enable Save/Discard from it.
 * guardNavigation() asks before a SvelteKit navigation away from the page and
 * lets the browser show its native prompt before a reload/close.
 */
import { beforeNavigate, goto } from '$app/navigation';

export const UNSAVED_CHANGES_MESSAGE = 'You have unsaved changes. Leave without saving?';

/** Returns true to proceed. May be async (a custom dialog). */
export type ConfirmFn = (message: string) => boolean | Promise<boolean>;

export interface DirtyTrackerOptions<T> {
  /** Custom comparison; default is structural equality of the snapshots. */
  equals?: (a: T, b: T) => boolean;
  /** Prompt text for confirmDiscard() and guardNavigation(). */
  message?: string;
  /** Prompt implementation; default window.confirm. */
  confirm?: ConfirmFn;
}

export interface GuardNavigationOptions {
  message?: string;
  confirm?: ConfirmFn;
  /** Target for the beforeunload listener; default window (null disables it). */
  target?: Pick<Window, 'addEventListener' | 'removeEventListener'> | null;
}

export interface DirtyTracker<T> {
  /** Current value differs from the baseline. Reactive. */
  readonly isDirty: boolean;
  /** Snapshot the tracker compares against (for a "Discard" that restores it). */
  readonly baseline: T;
  /** Makes the current value (or `value`) the new baseline, e.g. after load or save. */
  reset(value?: T): void;
  /** True when not dirty or the operator agrees to discard the changes. */
  confirmDiscard(message?: string): Promise<boolean>;
  /**
   * Asks before navigating away while dirty. Call during component
   * initialisation (it uses beforeNavigate and an effect).
   */
  guardNavigation(options?: GuardNavigationOptions): void;
}

function defaultConfirm(message: string): boolean {
  if (typeof window === 'undefined' || typeof window.confirm !== 'function') return true;
  return window.confirm(message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Structural equality for form snapshots: primitives by Object.is (NaN equals
 * NaN), arrays by position, plain objects by key with `undefined` values
 * treated as absent ({a: undefined} equals {}), Dates by time, Maps and Sets
 * by content. Other objects compare by identity.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && Object.is(a.getTime(), b.getTime());
  }
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map) || !(b instanceof Map) || a.size !== b.size) return false;
    for (const [key, value] of a) if (!b.has(key) || !deepEqual(value, b.get(key))) return false;
    return true;
  }
  if (a instanceof Set || b instanceof Set) {
    if (!(a instanceof Set) || !(b instanceof Set) || a.size !== b.size) return false;
    for (const value of a) if (!b.has(value)) return false;
    return true;
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const keysA = Object.keys(a).filter((key) => a[key] !== undefined);
  const keysB = Object.keys(b).filter((key) => b[key] !== undefined);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]));
}

export function createDirtyTracker<T>(getSnapshot: () => T, options: DirtyTrackerOptions<T> = {}): DirtyTracker<T> {
  const equals = options.equals ?? ((x: T, y: T) => deepEqual(x, y));
  const snapshot = (): T => $state.snapshot(getSnapshot()) as T;

  let baseline = $state.raw<T>(snapshot());
  const isDirty = $derived(!equals(baseline, snapshot()));

  const confirmWith = (message: string, confirm: ConfirmFn | undefined) =>
    (confirm ?? options.confirm ?? defaultConfirm)(message);

  return {
    get isDirty() {
      return isDirty;
    },
    get baseline() {
      return baseline;
    },
    reset(value?: T) {
      baseline = (arguments.length > 0 ? $state.snapshot(value) : snapshot()) as T;
    },
    async confirmDiscard(message?: string) {
      if (!isDirty) return true;
      return Boolean(await confirmWith(message ?? options.message ?? UNSAVED_CHANGES_MESSAGE, undefined));
    },
    guardNavigation(guard: GuardNavigationOptions = {}) {
      const message = guard.message ?? options.message ?? UNSAVED_CHANGES_MESSAGE;
      // Set once the operator agreed to leave, so the unload prompt does not
      // ask a second time for the same navigation.
      let allowUnload = false;
      // Set while re-issuing a navigation the operator confirmed asynchronously.
      let allowNext = false;

      beforeNavigate((navigation) => {
        if (allowNext) {
          allowNext = false;
          return;
        }
        // Reload/close/external address bar: the beforeunload listener below
        // lets the browser show its own prompt (a confirm() is not allowed there).
        if (navigation.type === 'leave' || !isDirty) return;
        const answer = confirmWith(message, guard.confirm);
        if (answer === true) {
          if (navigation.willUnload) allowUnload = true;
          return;
        }
        navigation.cancel();
        if (answer === false) return;
        const target = navigation.to?.url;
        void Promise.resolve(answer).then((ok) => {
          if (!ok || !target) return;
          if (navigation.willUnload || (typeof location !== 'undefined' && target.origin !== location.origin)) {
            allowUnload = true;
            location.assign(target.href);
            return;
          }
          allowNext = true;
          void goto(target, { replace: navigation.type === 'popstate' ? false : undefined }).finally(() => {
            allowNext = false;
          });
        });
      });

      const target = guard.target === undefined ? (typeof window !== 'undefined' ? window : null) : guard.target;
      if (!target) return;
      $effect(() => {
        const onBeforeUnload = (event: Event) => {
          if (allowUnload || !isDirty) return;
          event.preventDefault();
          // Required by some browsers to show the prompt.
          (event as BeforeUnloadEvent).returnValue = '';
        };
        target.addEventListener('beforeunload', onBeforeUnload);
        return () => target.removeEventListener('beforeunload', onBeforeUnload);
      });
    },
  };
}
