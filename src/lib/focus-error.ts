/**
 * Focus after a failed inline submit (WCAG 3.3.1).
 *
 * After a submit fails, focus moves to the first field marked
 * `aria-invalid="true"` inside the form's container, else to the first error
 * message there (`InlineError`, `Alert tone="error"`, or any element carrying
 * `data-form-error`). The error element gets `tabindex="-1"` when it has none,
 * so it can take programmatic focus without joining the Tab order.
 *
 * Call it after the error state is set: `focusFormError` waits one Svelte
 * tick so the error element exists before it looks.
 */
import { tick } from 'svelte';

export const INVALID_FIELD_SELECTOR = '[aria-invalid="true"]';
export const FORM_ERROR_SELECTOR = '[data-form-error], .ui-inline-error, .ui-alert.tone-error';

/** The subset of Element the helper needs (keeps it testable without a DOM). */
export interface FocusTarget {
  focus(options?: FocusOptions): void;
  hasAttribute(name: string): boolean;
  setAttribute(name: string, value: string): void;
}

export interface FocusRoot {
  querySelector(selectors: string): unknown;
}

/**
 * Focus the first invalid field in `root`, else its first error element.
 * Returns what was focused ('field' | 'error'), or null when nothing matched.
 */
export function focusFirstError(root: FocusRoot | null | undefined): 'field' | 'error' | null {
  if (!root) return null;
  const field = root.querySelector(INVALID_FIELD_SELECTOR) as FocusTarget | null;
  if (field) {
    field.focus();
    return 'field';
  }
  const error = root.querySelector(FORM_ERROR_SELECTOR) as FocusTarget | null;
  if (error) {
    if (!error.hasAttribute('tabindex')) error.setAttribute('tabindex', '-1');
    error.focus();
    return 'error';
  }
  return null;
}

/** Wait for the DOM to show the error, then focus it (see `focusFirstError`). */
export async function focusFormError(root: FocusRoot | null | undefined): Promise<'field' | 'error' | null> {
  await tick();
  return focusFirstError(root);
}

/**
 * The container to search after a failed submit: the submitted form's
 * enclosing `<section>` or dialog (errors often render next to the form, not
 * in it), else the form. Read it before the first `await`, `currentTarget`
 * is cleared once the event has been dispatched.
 */
export function submitScope(event: Event): HTMLElement | null {
  const form = event.currentTarget;
  if (typeof HTMLElement === 'undefined' || !(form instanceof HTMLElement)) return null;
  return form.closest<HTMLElement>('section, dialog') ?? form;
}
