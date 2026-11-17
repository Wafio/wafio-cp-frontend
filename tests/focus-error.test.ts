import { describe, expect, test } from 'bun:test';
import { FORM_ERROR_SELECTOR, INVALID_FIELD_SELECTOR, focusFirstError, type FocusTarget } from '../src/lib/focus-error';
import { CONFIRM_TIERS, tierFor } from '../src/lib/confirm-tiers';

// No DOM in the bun test setup: a fake element records focus and attributes,
// and a fake root answers the two selectors the helper asks for.
function fakeEl(attrs: Record<string, string> = {}) {
  const el = {
    attrs: { ...attrs },
    focused: 0,
    focus() {
      el.focused++;
    },
    hasAttribute(name: string) {
      return name in el.attrs;
    },
    setAttribute(name: string, value: string) {
      el.attrs[name] = value;
    },
  };
  return el satisfies FocusTarget;
}

function fakeRoot(found: { field?: FocusTarget; error?: FocusTarget }) {
  const asked: string[] = [];
  return {
    asked,
    querySelector(selector: string) {
      asked.push(selector);
      if (selector === INVALID_FIELD_SELECTOR) return found.field ?? null;
      if (selector === FORM_ERROR_SELECTOR) return found.error ?? null;
      return null;
    },
  };
}

describe('focusFirstError', () => {
  test('focuses the first invalid field before any error message', () => {
    const field = fakeEl({ 'aria-invalid': 'true' });
    const error = fakeEl();
    const root = fakeRoot({ field, error });
    expect(focusFirstError(root)).toBe('field');
    expect(field.focused).toBe(1);
    expect(error.focused).toBe(0);
    expect(root.asked).toEqual([INVALID_FIELD_SELECTOR]);
  });

  test('falls back to the error element and makes it programmatically focusable', () => {
    const error = fakeEl();
    expect(focusFirstError(fakeRoot({ error }))).toBe('error');
    expect(error.focused).toBe(1);
    expect(error.attrs.tabindex).toBe('-1');
  });

  test('keeps an existing tabindex on the error element', () => {
    const error = fakeEl({ tabindex: '0' });
    focusFirstError(fakeRoot({ error }));
    expect(error.attrs.tabindex).toBe('0');
  });

  test('does nothing without a root or a match', () => {
    expect(focusFirstError(null)).toBeNull();
    expect(focusFirstError(undefined)).toBeNull();
    expect(focusFirstError(fakeRoot({}))).toBeNull();
  });

  test('error selector covers the shared error primitives', () => {
    expect(FORM_ERROR_SELECTOR).toContain('[data-form-error]');
    expect(FORM_ERROR_SELECTOR).toContain('.ui-inline-error');
    expect(FORM_ERROR_SELECTOR).toContain('.ui-alert.tone-error');
  });
});

describe('create-invitation confirmation', () => {
  test('creating an invitation needs a simple confirm', () => {
    expect(CONFIRM_TIERS['create-invitation']).toBe('simple');
    expect(tierFor('create-invitation')).toBe('simple');
  });
});
