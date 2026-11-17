import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MAX_PASSWORD_BYTES,
  MIN_PASSWORD_LENGTH,
  RESET_FRAGMENT_GLOBAL,
  newPasswordError,
  parseResetFragment,
  recoveryEmailError,
  resetFormErrors,
  takeResetToken,
} from '../src/lib/password-reset';
import { documentTitle, isPublicPath } from '../src/lib/shell-nav';

// The reset link is <dashboard>/reset-password#token=<43 chars>.
const TOKEN = 'Q2hhbmdlTWVQbGVhc2VUaGlzSXNOb3RBUmVhbFRva2Vu'.slice(0, 43); // gitleaks:allow: decoded, it reads ChangeMePleaseThisIsNotARealToken

function fakeWindow(pathname: string, hash: string, search = '', stash?: string) {
  const calls: Array<{ data: unknown; url: string | undefined }> = [];
  const win: any = {
    location: { pathname, search, hash },
    history: {
      state: { 'sveltekit:index': 3 },
      replaceState(data: unknown, _unused: string, url?: string) {
        calls.push({ data, url });
        win.location.hash = '';
      },
    },
  };
  if (stash !== undefined) win[RESET_FRAGMENT_GLOBAL] = stash;
  return { win, calls };
}

describe('reset token from the URL fragment', () => {
  test('a well-formed token is read; anything else is null', () => {
    expect(TOKEN).toHaveLength(43);
    expect(parseResetFragment(`#token=${TOKEN}`)).toBe(TOKEN);
    expect(parseResetFragment(`token=${TOKEN}`)).toBe(TOKEN);
    expect(parseResetFragment(`#token=${TOKEN}&utm=mail`)).toBe(TOKEN);
    for (const bad of ['', '#', '#token=', '#token=short', `#token=${TOKEN}A`, `#token=${TOKEN.slice(0, 42)}+`, `#token=${TOKEN.slice(0, 42)}=`, `#other=${TOKEN}`, null, undefined]) {
      expect(parseResetFragment(bad)).toBeNull();
    }
  });

  test('takes the token from the address bar and removes it, keeping the history state', () => {
    const { win, calls } = fakeWindow('/reset-password', `#token=${TOKEN}`, '?x=1');
    expect(takeResetToken(win)).toBe(TOKEN);
    expect(calls).toEqual([{ data: { 'sveltekit:index': 3 }, url: '/reset-password?x=1' }]);
    expect(win.location.hash).toBe('');
  });

  test('prefers the fragment app.html stashed, and clears the stash', () => {
    const { win, calls } = fakeWindow('/base/reset-password', '', '', `#token=${TOKEN}`);
    expect(takeResetToken(win)).toBe(TOKEN);
    expect(calls).toHaveLength(0);
    expect(RESET_FRAGMENT_GLOBAL in win).toBe(false);
    // A second read finds nothing: the token lives in the page state only.
    expect(takeResetToken(win)).toBeNull();
  });

  test('a malformed fragment is still removed from the URL', () => {
    const { win, calls } = fakeWindow('/reset-password', '#token=nope');
    expect(takeResetToken(win)).toBeNull();
    expect(calls).toHaveLength(1);
  });

  test('no fragment, no history change', () => {
    const { win, calls } = fakeWindow('/reset-password', '');
    expect(takeResetToken(win)).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('app.html stash script', () => {
  const html = readFileSync(join(import.meta.dir, '..', 'src', 'app.html'), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const stash = scripts.find((s) => s.includes('__wafioResetFragment'))!;

  function run(pathname: string, hash: string) {
    const { win, calls } = fakeWindow(pathname, hash, '?a=b');
    new Function('window', 'location', 'history', stash)(win, win.location, win.history);
    return { win, calls };
  }

  test('is the first script, before anything else can read the page URL', () => {
    expect(stash).toBeDefined();
    expect(scripts[0]).toBe(stash);
    // SvelteKit's own scripts are injected at %sveltekit.head%.
    expect(html.indexOf('__wafioResetFragment')).toBeLessThan(html.indexOf('%sveltekit.head%'));
  });

  test('on the reset page the fragment leaves the address bar for the stash', () => {
    for (const path of ['/reset-password', '/reset-password/', '/wafio/reset-password']) {
      const { win, calls } = run(path, `#token=${TOKEN}`);
      expect(win[RESET_FRAGMENT_GLOBAL]).toBe(`#token=${TOKEN}`);
      expect(win.location.hash).toBe('');
      expect(calls).toEqual([{ data: { 'sveltekit:index': 3 }, url: `${path}?a=b` }]);
      expect(takeResetToken(win)).toBe(TOKEN);
    }
  });

  test('other pages keep their fragment', () => {
    for (const path of ['/login', '/projects/p1', '/reset-password-help']) {
      const { win, calls } = run(path, '#section');
      expect(win[RESET_FRAGMENT_GLOBAL]).toBeUndefined();
      expect(win.location.hash).toBe('#section');
      expect(calls).toHaveLength(0);
    }
  });
});

describe('reset form validation', () => {
  test('password policy matches the server: 8 characters, 72 bytes', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(8);
    expect(MAX_PASSWORD_BYTES).toBe(72);
    expect(newPasswordError('')).toContain('at least 8 characters');
    expect(newPasswordError('seven77')).toContain('at least 8 characters');
    expect(newPasswordError('eight888')).toBeNull();
    expect(newPasswordError('ąčęėįšųū')).toBeNull(); // 8 characters, 16 bytes
    expect(newPasswordError('a'.repeat(72))).toBeNull();
    expect(newPasswordError('a'.repeat(73))).toContain('72 bytes');
    expect(newPasswordError('ą'.repeat(37))).toContain('72 bytes'); // 74 bytes
  });

  test('confirmation must be present and equal', () => {
    expect(resetFormErrors('long-enough-1', 'long-enough-1')).toEqual({});
    expect(resetFormErrors('long-enough-1', '')).toEqual({ confirm: 'Enter the new password again.' });
    expect(resetFormErrors('long-enough-1', 'long-enough-2')).toEqual({ confirm: 'The two passwords do not match.' });
    const both = resetFormErrors('short', 'other');
    expect(both.password).toContain('at least 8');
    expect(both.confirm).toBe('The two passwords do not match.');
  });

  test('email field', () => {
    expect(recoveryEmailError('')).toBe('Enter your email address.');
    expect(recoveryEmailError('   ')).toBe('Enter your email address.');
    expect(recoveryEmailError('user@example.test')).toBeNull();
    expect(recoveryEmailError('  user@example.test ')).toBeNull();
    for (const bad of ['user', 'user@', '@example.test', 'user@example', 'a b@example.test', `${'a'.repeat(250)}@example.test`]) {
      expect(recoveryEmailError(bad)).toBe('Enter a valid email address.');
    }
  });
});

describe('recovery pages in the shell', () => {
  test('reachable without a session, titled per convention', () => {
    for (const path of ['/forgot-password', '/reset-password']) expect(isPublicPath(path)).toBe(true);
    expect(isPublicPath('/reset-passwordx')).toBe(false);
    expect(documentTitle({ path: '/forgot-password' })).toBe('Forgot password | WAFio');
    expect(documentTitle({ path: '/reset-password' })).toBe('Reset password | WAFio');
  });
});
