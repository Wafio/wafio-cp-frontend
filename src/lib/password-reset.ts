/**
 * Password recovery by email: the reset link is
 * `<dashboard>/reset-password#token=<token>`. The token rides in the URL
 * fragment, so it never reaches a server log or a Referer header; the page
 * takes it out of the address bar before anything else reads `location`
 * (app.html stashes it for the page before the analytics tag runs).
 */

/** Account password policy, as the server enforces it. */
export const MIN_PASSWORD_LENGTH = 8;
/** bcrypt's input limit; the server refuses longer passwords. */
export const MAX_PASSWORD_BYTES = 72;

/** 32 random bytes, unpadded base64url. */
const RESET_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** Where app.html leaves the fragment it removed from the address bar. */
export const RESET_FRAGMENT_GLOBAL = '__wafioResetFragment';

/** The reset token in a URL fragment ("#token=…"), or null when absent or malformed. */
export function parseResetFragment(hash: string | null | undefined): string | null {
  if (!hash) return null;
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const token = params.get('token');
  return token && RESET_TOKEN.test(token) ? token : null;
}

interface ResetWindow {
  location: { pathname: string; search: string; hash: string };
  history: { state: unknown; replaceState(data: unknown, unused: string, url?: string | URL | null): void };
  [RESET_FRAGMENT_GLOBAL]?: string;
}

/**
 * Takes the reset token: from the fragment app.html stashed, else from the
 * address bar. Either way the fragment is removed from the URL (history
 * entry replaced, so Back does not bring it back) and the stash cleared.
 * Returns null when there is no well-formed token.
 */
export function takeResetToken(win: ResetWindow): string | null {
  const stashed = win[RESET_FRAGMENT_GLOBAL];
  delete win[RESET_FRAGMENT_GLOBAL];
  const fromBar = win.location.hash;
  if (fromBar) {
    win.history.replaceState(win.history.state, '', `${win.location.pathname}${win.location.search}`);
  }
  return parseResetFragment(stashed ?? fromBar);
}

/** UTF-8 length of a string. */
function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** Message for a new password that breaks the policy, or null when it is fine. */
export function newPasswordError(password: string): string | null {
  if ([...password].length < MIN_PASSWORD_LENGTH) return `The password needs at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (byteLength(password) > MAX_PASSWORD_BYTES) return `The password can be at most ${MAX_PASSWORD_BYTES} bytes long (fewer characters when they are not plain ASCII).`;
  return null;
}

/** Field errors of the reset form; empty when the form can be sent. */
export function resetFormErrors(password: string, confirm: string): { password?: string; confirm?: string } {
  const errors: { password?: string; confirm?: string } = {};
  const policy = newPasswordError(password);
  if (policy) errors.password = policy;
  if (!confirm) errors.confirm = 'Enter the new password again.';
  else if (confirm !== password) errors.confirm = 'The two passwords do not match.';
  return errors;
}

/** Message for the forgot-password email field, or null when it can be sent. */
export function recoveryEmailError(email: string): string | null {
  const value = email.trim();
  if (!value) return 'Enter your email address.';
  if (value.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return 'Enter a valid email address.';
  return null;
}
