// Pure helpers shared by Modal, Drawer and ConfirmModal (native <dialog>).
// Kept free of Svelte and DOM globals so the close policy is unit-testable.

/** What asked the dialog to close. */
export type CloseSource = 'escape' | 'backdrop' | 'close-button' | 'native';

/** What the dialog does with a close request. */
export type CloseDecision = 'close' | 'confirm-discard' | 'ignore';

export interface ClosePolicy {
  /** false while the dialog must stay open (e.g. a request is in flight). */
  dismissible: boolean;
  /** The dialog holds unsaved input. */
  dirty: boolean;
  /** Ask "Discard unsaved changes?" before closing a dirty dialog. When
   *  false, dirty only blocks the backdrop click (ConfirmModal). */
  guardDirty: boolean;
  /** A click on the backdrop may close the dialog (never while dirty). */
  closeOnBackdrop: boolean;
}

export function decideClose(source: CloseSource, policy: ClosePolicy): CloseDecision {
  if (!policy.dismissible) return 'ignore';
  if (source === 'backdrop') {
    if (!policy.closeOnBackdrop || policy.dirty) return 'ignore';
    return 'close';
  }
  if (policy.dirty && policy.guardDirty) return 'confirm-discard';
  return 'close';
}

export interface RectLike {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** True when the point lies outside the rectangle (a click on ::backdrop is
 *  reported on the <dialog> element with coordinates outside its box). */
export function isOutsideRect(x: number, y: number, rect: RectLike): boolean {
  return x < rect.left || x > rect.right || y < rect.top || y > rect.bottom;
}

/** Selector for elements that take keyboard focus. */
export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'summary',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Selector for an explicit initial-focus target inside a dialog. */
export const AUTOFOCUS_SELECTOR = '[data-autofocus],[autofocus]';

interface FocusableLike {
  focus(options?: FocusOptions): void;
  getClientRects(): { length: number };
  closest(selector: string): unknown;
}

interface QueryRoot {
  querySelector(selector: string): unknown;
  querySelectorAll(selector: string): ArrayLike<unknown>;
}

function isVisible(el: FocusableLike): boolean {
  return el.getClientRects().length > 0 && !el.closest('[hidden],[inert]');
}

/** First visible element inside `root` matching `selector`, or null. Hidden
 *  matches (e.g. inside a nested dialog that is not open) are skipped. */
function firstVisible(root: QueryRoot | null | undefined, selector: string): FocusableLike | null {
  if (!root) return null;
  const list = root.querySelectorAll(selector);
  for (let i = 0; i < list.length; i++) {
    const el = list[i] as FocusableLike;
    if (isVisible(el)) return el;
  }
  return null;
}

/** First visible focusable element inside `root`, or null. */
export function firstFocusable(root: QueryRoot | null | undefined): FocusableLike | null {
  return firstVisible(root, FOCUSABLE_SELECTOR);
}

/**
 * Move focus into an opened dialog: an explicit `selector` match, then
 * `[data-autofocus]`/`[autofocus]`, then the first focusable element of the
 * body, then anywhere in the dialog, then the dialog itself.
 */
export function focusInitial(
  dialog: (QueryRoot & FocusableLike) | null | undefined,
  body?: QueryRoot | null,
  selector?: string,
): void {
  if (!dialog) return;
  const explicit = selector ? firstVisible(dialog, selector) : null;
  const auto = firstVisible(dialog, AUTOFOCUS_SELECTOR);
  const target = explicit ?? auto ?? firstFocusable(body) ?? firstFocusable(dialog) ?? dialog;
  target.focus({ preventScroll: false });
}
