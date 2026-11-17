import './support/ssr';
import { describe, expect, test } from 'bun:test';
import { renderComponent } from './support/ssr';
import { FORM_ERROR_SELECTOR, INVALID_FIELD_SELECTOR, focusFirstError } from '../src/lib/focus-error';
import { canConfirmInvite, checkInviteEmail, decideInviteSubmit } from '../src/lib/invite-flow';
import { collapsesOnEscape } from '../src/lib/components/ui/disclosure';

// ── Invitation submit → confirm gating ─────────────────────────────

describe('invitation create gating', () => {
  const idle = { busy: false, pending: false, invalid: false };

  test('a valid submit (Enter included) only opens the confirmation', () => {
    expect(decideInviteSubmit(idle)).toBe('confirm');
    expect(decideInviteSubmit(idle, 'simple')).toBe('confirm');
    expect(decideInviteSubmit(idle, 'typed')).toBe('confirm');
  });

  test('an invalid email creates nothing', () => {
    expect(decideInviteSubmit({ ...idle, invalid: true })).toBe('invalid');
  });

  test('no second request while loading or while a confirmation is open', () => {
    expect(decideInviteSubmit({ ...idle, busy: true })).toBe('ignore');
    expect(decideInviteSubmit({ ...idle, pending: true })).toBe('ignore');
    expect(decideInviteSubmit({ busy: true, pending: true, invalid: true })).toBe('ignore');
  });

  test("tier 'none' creates directly", () => {
    expect(decideInviteSubmit(idle, 'none')).toBe('create');
    expect(decideInviteSubmit({ ...idle, invalid: true }, 'none')).toBe('invalid');
  });

  test('Confirm creates only a pending invitation, never twice at once', () => {
    expect(canConfirmInvite({ email: 'a@b.co', role: 'member' }, false)).toBe(true);
    expect(canConfirmInvite('', false)).toBe(true); // admin: empty email = any address
    expect(canConfirmInvite(null, false)).toBe(false);
    expect(canConfirmInvite(undefined, false)).toBe(false);
    expect(canConfirmInvite({ email: 'a@b.co', role: 'member' }, true)).toBe(false);
  });

  test('email check: required on Members, optional on admin', () => {
    expect(checkInviteEmail('  a@b.co ', false)).toEqual({ email: 'a@b.co', invalid: false });
    expect(checkInviteEmail('   ', false)).toEqual({ email: '', invalid: true });
    expect(checkInviteEmail('   ', true)).toEqual({ email: '', invalid: false });
    expect(checkInviteEmail('not-an-email', true)).toEqual({ email: 'not-an-email', invalid: true });
  });
});

// ── DataTable disclosure Escape ────────────────────────────────────

describe('row disclosure Escape', () => {
  const esc = { key: 'Escape', isComposing: false, defaultPrevented: false };

  test('Escape on an expanded row collapses it', () => {
    expect(collapsesOnEscape(esc, true)).toBe(true);
  });

  test('a collapsed row lets Escape through', () => {
    expect(collapsesOnEscape(esc, false)).toBe(false);
  });

  test('ignores consumed Escape, IME composition and other keys', () => {
    expect(collapsesOnEscape({ ...esc, defaultPrevented: true }, true)).toBe(false);
    expect(collapsesOnEscape({ ...esc, isComposing: true }, true)).toBe(false);
    expect(collapsesOnEscape({ ...esc, key: 'Enter' }, true)).toBe(false);
  });
});

// ── Focus helper against the rendered error primitives ─────────────

/** Root element of SSR output as a fake element with its real attributes. */
function rootElement(html: string) {
  const tag = /<[a-z][\w-]*((?:\s+[\w:-]+(?:="[^"]*")?)*)\s*\/?>/i.exec(html);
  if (!tag) throw new Error(`no element in ${html}`);
  const attrs: Record<string, string> = {};
  for (const m of tag[1].matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) attrs[m[1]] = m[2] ?? '';
  const el = {
    attrs,
    focused: 0,
    focus() {
      el.focused++;
    },
    hasAttribute: (name: string) => name in attrs,
    setAttribute: (name: string, value: string) => {
      attrs[name] = value;
    },
  };
  return el;
}

/** Matches the compound selectors the helper uses: `.a.b`, `[x]`, `[x="v"]`. */
function matches(el: { attrs: Record<string, string> }, selector: string): boolean {
  const classes = new Set((el.attrs.class ?? '').split(/\s+/).filter(Boolean));
  const parts = selector.trim().match(/\.[\w-]+|\[[^\]]+\]/g) ?? [];
  if (parts.join('') !== selector.trim()) throw new Error(`unsupported selector ${selector}`);
  return parts.every((part) => {
    if (part.startsWith('.')) return classes.has(part.slice(1));
    const [, name, value] = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(part) ?? [];
    return name in el.attrs && (value === undefined || el.attrs[name] === value);
  });
}

function rootOf(...els: ReturnType<typeof rootElement>[]) {
  return {
    querySelector: (selectors: string) => els.find((el) => selectors.split(',').some((s) => matches(el, s))) ?? null,
  };
}

async function render(name: string, props: Record<string, unknown>) {
  const mod = (await import(`../src/lib/components/ui/${name}.svelte`)) as { default: never };
  return renderComponent(mod.default, props as never);
}

describe('focusFirstError finds the shared error primitives', () => {
  test('InlineError renders focusable (tabindex -1) and is focused', async () => {
    const el = rootElement(await render('InlineError', { message: 'Enter a valid email address.' }));
    expect(el.attrs.tabindex).toBe('-1');
    expect('data-form-error' in el.attrs).toBe(true);
    expect(focusFirstError(rootOf(el))).toBe('error');
    expect(el.focused).toBe(1);
    expect(el.attrs.tabindex).toBe('-1');
  });

  test('an error Alert carries the marker and gets tabindex -1 when focused', async () => {
    const el = rootElement(await render('Alert', { tone: 'error', message: 'Could not save.' }));
    expect('data-form-error' in el.attrs).toBe(true);
    expect(focusFirstError(rootOf(el))).toBe('error');
    expect(el.focused).toBe(1);
    expect(el.attrs.tabindex).toBe('-1');
  });

  test('a non-error Alert is not treated as a form error', async () => {
    const el = rootElement(await render('Alert', { tone: 'info', message: 'Note.' }));
    expect('data-form-error' in el.attrs).toBe(false);
    expect(focusFirstError(rootOf(el))).toBeNull();
    expect(el.focused).toBe(0);
  });

  test('an invalid field wins over the error message', async () => {
    const error = rootElement(await render('InlineError', { message: 'Required.' }));
    const field = rootElement('<input id="x" aria-invalid="true">');
    expect(focusFirstError(rootOf(error, field))).toBe('field');
    expect(field.focused).toBe(1);
    expect(error.focused).toBe(0);
  });

  test('selectors used by the helper are the ones matched here', () => {
    expect(matches(rootElement('<input aria-invalid="true">'), INVALID_FIELD_SELECTOR)).toBe(true);
    expect(FORM_ERROR_SELECTOR.split(',').length).toBeGreaterThan(1);
  });
});
