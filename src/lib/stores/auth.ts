import { writable, derived } from 'svelte/store';
import { TOKEN_KEY, USER_KEY, clearSession, type User } from '../api';

/**
 * A user record as some endpoints return it: PUT /api/me answers with
 * id, email and name only (no role).
 */
export type UserUpdate = Pick<User, 'id' | 'email' | 'name'> & Partial<User>;

export interface AuthState {
  token: string | null;
  user: User | null;
  inited: boolean;
}

function hasStorage(): boolean {
  return typeof window !== 'undefined' && typeof localStorage !== 'undefined';
}

function loadUser(): User | null {
  if (!hasStorage()) return null;
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    const user = JSON.parse(raw) as Partial<User> | null;
    return user && typeof user.id === 'string' && typeof user.role === 'string' ? (user as User) : null;
  } catch {
    return null;
  }
}

/**
 * Merges a partial user into the stored one so that fields the response
 * does not carry (role after a profile update) are kept for the same user.
 */
export function mergeUser(previous: User | null, next: UserUpdate): User {
  const base = previous && previous.id === next.id ? previous : null;
  return { ...(base ?? { role: 'user' }), ...next, role: next.role ?? base?.role ?? 'user' } as User;
}

/** Query parameter the shell's Sign out adds to /login (see requestSignOut). */
export const SIGN_OUT_PARAM = 'signout';

/** The /login address Sign out navigates to; the session ends only once it is reached. */
export function signOutPath(base: string): string {
  return `${base}/login?${SIGN_OUT_PARAM}=1`;
}

function createAuthStore() {
  const store = writable<AuthState>({ token: null, user: null, inited: false });
  const { subscribe, set, update } = store;
  let current: AuthState = { token: null, user: null, inited: false };
  subscribe((value) => { current = value; });
  // Set by the shell's Sign out before it navigates to /login: the session
  // ends only when that navigation arrives, so unsaved-change guards of the
  // page being left can still cancel it. The /login?signout=1 address
  // alone (an outside link) never signs anyone out.
  let signOutRequested = false;

  const persist = (token: string, user: User) => {
    if (!hasStorage()) return;
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  };

  return {
    subscribe,
    init() {
      const token = hasStorage() ? localStorage.getItem(TOKEN_KEY) : null;
      const user = token ? loadUser() : null;
      set({ token, user, inited: true });
    },
    /**
     * Stores a session. A user without a role (PUT /api/me response) keeps
     * the role of the stored user with the same id instead of dropping it.
     */
    setAuth(token: string, user: User | UserUpdate) {
      const merged = mergeUser(current.user ?? loadUser(), user);
      persist(token, merged);
      set({ token, user: merged, inited: true });
    },
    /** Updates the signed-in user's profile fields without touching the token. */
    updateUser(user: UserUpdate) {
      update((state) => {
        if (!state.token) return state;
        const merged = mergeUser(state.user, user);
        persist(state.token, merged);
        return { ...state, user: merged };
      });
    },
    /**
     * Swaps in the replacement token a response carried (2FA enable/disable,
     * password change) and keeps the signed-in user.
     */
    replaceToken(token: string) {
      if (!token) return;
      if (hasStorage()) localStorage.setItem(TOKEN_KEY, token);
      update((state) => ({ ...state, token, inited: true }));
    },
    /** Marks a sign-out the next /login?signout=1 visit completes. */
    requestSignOut() {
      signOutRequested = true;
    },
    /** True once per requestSignOut(): the caller then calls logout(). */
    consumeSignOutRequest(): boolean {
      const requested = signOutRequested;
      signOutRequested = false;
      return requested;
    },
    logout() {
      signOutRequested = false;
      clearSession();
      set({ token: null, user: null, inited: true });
    },
  };
}

export const auth = createAuthStore();

/** true when the logged-in user has system role "admin" */
export const isAdmin = derived(auth, ($auth) => $auth.user?.role === 'admin');
