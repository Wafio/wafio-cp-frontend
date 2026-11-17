/**
 * User-facing messages for the error codes of the sign-in, 2FA and session
 * endpoints. Pages show them inline next to the form that
 * failed; the API client already ends the session for a real 401.
 */
import type { ApiError } from '#lib/api.js';
import { formatDuration } from '#lib/format.js';

/** "Try again in 4m 30s." from retry_after_seconds (Retry-After), or a generic hint. */
export function retryHint(err: Pick<ApiError, 'retry_after_seconds'> | undefined): string {
  const seconds = err?.retry_after_seconds;
  if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) {
    return `Try again in ${formatDuration(seconds, 's')}.`;
  }
  return 'Try again later.';
}

/** Message for an error of the 2FA, password, login and logout-all endpoints. */
export function authErrorMessage(err: ApiError | undefined, fallback = 'The request failed.'): string {
  if (!err) return fallback;
  switch (err.code) {
    case 'INVALID_TOTP_CODE':
      return 'That code is not valid. Enter the current code from your authenticator app.';
    case 'TOTP_CODE_REUSED':
      return 'That code was already used. Wait for the next code from your authenticator app.';
    case 'TOTP_TOO_MANY_ATTEMPTS':
      return `Too many wrong codes. ${retryHint(err)}`;
    case 'TOTP_SETUP_REQUIRED':
      return 'The setup is no longer pending. Start the setup again.';
    case 'TOTP_ALREADY_ENABLED':
      return 'Two-factor authentication is already on for this account.';
    case 'INVALID_PASSWORD':
      return 'The password is not correct.';
    case 'RESET_TOKEN_INVALID':
      return 'This password reset link does not work any more. Ask for a new one.';
    case 'PREAUTH_INVALID':
      return 'The sign-in step expired. Enter your email and password again.';
    case 'AUTH_UNAVAILABLE':
      return 'The server cannot check your session right now. Try again in a moment.';
    case 'RATE_LIMIT_EXCEEDED':
      return `Too many requests. ${retryHint(err)}`;
    default:
      return err.error || fallback;
  }
}

/** True for errors worth an immediate retry button (server briefly unable to answer). */
export function isRetryableAuthError(err: ApiError | undefined): boolean {
  if (!err) return false;
  return err.code === 'AUTH_UNAVAILABLE' || err.kind === 'network' || (err.status !== undefined && err.status >= 500);
}
