/**
 * Invitation create flow: submitting the form (Enter included) only
 * opens the confirmation; the invitation is created on Confirm. Shared by the
 * project Members page and admin Invitations so both gate the same way.
 */
import { tierFor, type ConfirmTier } from './confirm-tiers';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Trimmed email and whether it is invalid (`optional`: empty is allowed). */
export function checkInviteEmail(raw: string, optional: boolean): { email: string; invalid: boolean } {
  const email = raw.trim();
  if (!email) return { email, invalid: !optional };
  return { email, invalid: !EMAIL.test(email) };
}

/**
 * What a form submit does:
 * - `ignore` , a request is running or a confirmation is already open;
 * - `invalid`, show the email error, create nothing;
 * - `confirm`, open the confirmation dialog;
 * - `create` , create right away (only if the tier is ever set to 'none').
 */
export type InviteSubmitDecision = 'ignore' | 'invalid' | 'confirm' | 'create';

export function decideInviteSubmit(
  state: { busy: boolean; pending: boolean; invalid: boolean },
  tier: ConfirmTier = tierFor('create-invitation'),
): InviteSubmitDecision {
  if (state.busy || state.pending) return 'ignore';
  if (state.invalid) return 'invalid';
  return tier === 'none' ? 'create' : 'confirm';
}

/** Confirm creates only for a pending invitation and never twice at once. */
export function canConfirmInvite(pending: unknown, busy: boolean): boolean {
  return pending !== null && pending !== undefined && !busy;
}

/**
 * The invitation link to show, copy and open. Without a dashboard base URL
 * (Administration › Email (SMTP) or `server.base_url`) the server returns a
 * path, `/invite/<token>` or `/register?token=<token>`, since it never builds
 * links from the request Host; the dashboard completes it with its own address
 * (`origin` + SvelteKit `basePath`), which is where the invitee signs in.
 * Absolute links and anything else pass unchanged.
 */
export function completeInviteLink(url: string | undefined, origin: string, basePath = ''): string | undefined {
  if (!url || !url.startsWith('/') || url.startsWith('//')) return url;
  return origin.replace(/\/+$/, '') + basePath.replace(/\/+$/, '') + url;
}

/** What the invitation page says when the link cannot be read: a link the server does not know is plain wording, not the server's. */
export function inviteLoadMessage(error: { status?: number; error?: string }): string {
  if (error.status === 404) return 'This invitation link does not work. It may have expired or been used already.';
  return error.error || 'This invitation link is invalid or has expired.';
}
