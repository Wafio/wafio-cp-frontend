import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { TEST_BASE_PATH } from './support/runes';
import {
  api,
  changePassword,
  handleUnauthorized,
  isSessionExpired,
  isTwoFactorChallenge,
  login,
  loginRedirectPath,
  resetSessionRedirectForTests,
  safeNextPath,
  TOKEN_KEY,
  USER_KEY,
} from '../src/lib/api';
import { auth, mergeUser } from '../src/lib/stores/auth';
import { get } from 'svelte/store';

class MemoryStorage {
  #data = new Map<string, string>();
  getItem(key: string) { return this.#data.has(key) ? this.#data.get(key)! : null; }
  setItem(key: string, value: string) { this.#data.set(key, String(value)); }
  removeItem(key: string) { this.#data.delete(key); }
  clear() { this.#data.clear(); }
}

const g = globalThis as unknown as Record<string, unknown>;
const originalFetch = globalThis.fetch;
let assigned: string[] = [];

function installBrowser(pathname = `${TEST_BASE_PATH}/projects/p1/host/firewall`, search = '?host=h1', hash = '') {
  assigned = [];
  g.localStorage = new MemoryStorage();
  g.window = { location: { pathname, search, hash, assign: (url: string) => { assigned.push(url); } } };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

const respond = (status: number, body: unknown) => {
  globalThis.fetch = (async () => (typeof body === 'string' ? new Response(body, { status }) : Response.json(body, { status }))) as unknown as typeof fetch;
};

beforeEach(() => {
  resetSessionRedirectForTests();
  installBrowser();
  localStorage.setItem(TOKEN_KEY, 'session-token');
  localStorage.setItem(USER_KEY, JSON.stringify({ id: 'u1', email: 'a@example.test', name: 'A', role: 'admin' }));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete g.window;
  delete g.localStorage;
});

describe('session expiry classification', () => {
  test('every 401 ends the session except credential answers', () => {
    expect(isSessionExpired('/api/projects/p1', 401)).toBe(true);
    expect(isSessionExpired('/api/projects/p1?x=1', 401, 'SESSION_INVALID')).toBe(true);
    expect(isSessionExpired('/api/login', 401)).toBe(false);
    expect(isSessionExpired('/api/login/2fa', 401)).toBe(false);
    expect(isSessionExpired('/api/register/invite', 401)).toBe(false);
    expect(isSessionExpired('/api/me/password', 401, 'INVALID_PASSWORD')).toBe(false);
    expect(isSessionExpired('/api/projects/p1', 403)).toBe(false);
    expect(isSessionExpired('/api/projects/p1', undefined)).toBe(false);
  });
});

describe('login redirect paths', () => {
  test('return path includes base, search and hash', () => {
    expect(loginRedirectPath('/app', { pathname: '/app/projects/p1', search: '?tab=rules', hash: '#r1' }))
      .toBe('/app/login?next=%2Fapp%2Fprojects%2Fp1%3Ftab%3Drules%23r1');
    expect(loginRedirectPath('', { pathname: '/projects' })).toBe('/login?next=%2Fprojects');
    expect(loginRedirectPath('/app/', { pathname: '/app/login' })).toBe('/app/login');
  });

  test('safeNextPath accepts in-app paths only', () => {
    expect(safeNextPath('/app/projects/p1?tab=rules#x', '/app')).toBe('/app/projects/p1?tab=rules#x');
    expect(safeNextPath('/projects', '')).toBe('/projects');
    for (const next of ['https://evil.example/', '//evil.example/x', '/\\evil.example', 'javascript:alert(1)', 'projects', '/other/projects', '/app/login?next=/app', '/app/login', '', null, undefined, '/app/\u0000x']) {
      expect(safeNextPath(next as never, '/app')).toBeNull();
    }
    expect(safeNextPath('/login', '')).toBeNull();
  });
});

describe('api() 401 handling', () => {
  test('a 401 clears the session and reloads the login page under base with a return path', async () => {
    respond(401, { error: 'token expired' });
    const result = await api('/api/projects/p1');
    expect(result.error).toMatchObject({ kind: 'http', status: 401 });
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(localStorage.getItem(USER_KEY)).toBeNull();
    await settle();
    expect(assigned).toEqual([`${TEST_BASE_PATH}/login?next=${encodeURIComponent(`${TEST_BASE_PATH}/projects/p1/host/firewall?host=h1`)}`]);
  });

  test('any 401 message counts, not just two strings', async () => {
    respond(401, { error: 'Your session is no longer valid. Please sign in again.', code: 'SESSION_INVALID' });
    await api('/api/projects/p1/config');
    await settle();
    expect(assigned).toHaveLength(1);
  });

  test('a non-JSON 401 (proxy) also ends the session', async () => {
    respond(401, '<html>Unauthorized</html>');
    await api('/api/projects');
    await settle();
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(assigned).toHaveLength(1);
  });

  test('parallel 401s redirect once', async () => {
    respond(401, { error: 'invalid token' });
    await Promise.all([api('/api/a'), api('/api/b'), api('/api/c')]);
    await settle();
    expect(assigned).toHaveLength(1);
  });

  test('wrong credentials on sign-in do not redirect', async () => {
    respond(401, { error: 'invalid email or password' });
    const result = await login('a@example.test', 'wrong');
    expect(result.error?.status).toBe(401);
    await settle();
    expect(assigned).toEqual([]);
    expect(localStorage.getItem(TOKEN_KEY)).toBe('session-token');
  });

  test('a wrong current password keeps the session', async () => {
    respond(401, { error: 'Current password is incorrect.', code: 'INVALID_PASSWORD' });
    const result = await changePassword('wrong', 'new-password');
    expect(result.error?.code).toBe('INVALID_PASSWORD');
    await settle();
    expect(assigned).toEqual([]);
    expect(localStorage.getItem(TOKEN_KEY)).toBe('session-token');
  });

  test('no redirect loop on the login page', async () => {
    installBrowser(`${TEST_BASE_PATH}/login`, '');
    handleUnauthorized();
    await settle();
    expect(assigned).toEqual([]);
  });

  test('403 and 404 leave the session alone', async () => {
    respond(403, { error: 'forbidden' });
    await api('/api/projects/p1');
    respond(404, { error: 'not found' });
    await api('/api/projects/p2');
    await settle();
    expect(assigned).toEqual([]);
    expect(localStorage.getItem(TOKEN_KEY)).toBe('session-token');
  });

  test('error hint is kept', async () => {
    respond(409, { error: 'Agent is online.', code: 'AGENT_ONLINE', hint: 'Stop the agent or retry with ?force=1.' });
    const result = await api('/api/fleet/agents/a1', { method: 'DELETE' });
    expect(result.error).toMatchObject({ status: 409, code: 'AGENT_ONLINE', hint: 'Stop the agent or retry with ?force=1.' });
  });
});

describe('typed auth responses', () => {
  test('login distinguishes a session from a 2FA challenge', async () => {
    respond(200, { requires_2fa: true, temp_token: 'pre-auth' });
    const challenge = await login('a@example.test', 'pw');
    expect(isTwoFactorChallenge(challenge.data)).toBe(true);
    respond(200, { token: 't', user: { id: 'u1', email: 'a@example.test', name: 'A', role: 'user' } });
    const session = await login('a@example.test', 'pw');
    expect(isTwoFactorChallenge(session.data)).toBe(false);
    expect(session.data?.token).toBe('t');
  });
});

describe('auth store', () => {
  test('uses the single token key', () => {
    auth.init();
    expect(get(auth).token).toBe('session-token');
    expect(get(auth).user?.role).toBe('admin');
    auth.logout();
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(localStorage.getItem(USER_KEY)).toBeNull();
  });

  test('a profile update without role keeps the stored role', () => {
    auth.init();
    auth.setAuth('session-token', { id: 'u1', email: 'a@example.test', name: 'Renamed' });
    expect(get(auth).user).toMatchObject({ id: 'u1', name: 'Renamed', role: 'admin' });
    expect(JSON.parse(localStorage.getItem(USER_KEY)!).role).toBe('admin');
    auth.updateUser({ id: 'u1', email: 'a@example.test', name: 'Again' });
    expect(get(auth).user).toMatchObject({ name: 'Again', role: 'admin' });
  });

  test('mergeUser never copies a role across users and defaults to the lowest role', () => {
    expect(mergeUser({ id: 'u1', email: 'a', name: 'A', role: 'admin' }, { id: 'u2', email: 'b', name: 'B' }).role).toBe('user');
    expect(mergeUser(null, { id: 'u2', email: 'b', name: 'B', role: 'admin' }).role).toBe('admin');
  });
});
