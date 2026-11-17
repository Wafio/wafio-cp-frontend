// Session handling on the client: replacement tokens, POST 2FA setup,
// Retry-After, logout-all and which errors end the session.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { TEST_BASE_PATH } from './support/runes';
import {
  api,
  changePassword,
  disable2fa,
  enable2fa,
  logoutAll,
  parseRetryAfter,
  resetSessionRedirectForTests,
  setup2fa,
  TOKEN_KEY,
  USER_KEY,
} from '../src/lib/api';
import { auth } from '../src/lib/stores/auth';
import { authErrorMessage, isRetryableAuthError, retryHint } from '../src/lib/auth-errors';
import { get } from 'svelte/store';

class MemoryStorage {
  #data = new Map<string, string>();
  getItem(key: string) { return this.#data.has(key) ? this.#data.get(key)! : null; }
  setItem(key: string, value: string) { this.#data.set(key, String(value)); }
  removeItem(key: string) { this.#data.delete(key); }
  clear() { this.#data.clear(); }
}

type Call = { url: string; method: string; body?: unknown };
const g = globalThis as unknown as Record<string, unknown>;
const originalFetch = globalThis.fetch;
let assigned: string[] = [];
let calls: Call[] = [];

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: (init?.method ?? 'GET').toUpperCase(), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  }) as unknown as typeof fetch;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  resetSessionRedirectForTests();
  assigned = [];
  calls = [];
  g.localStorage = new MemoryStorage();
  g.window = { location: { pathname: `${TEST_BASE_PATH}/account`, search: '', hash: '', assign: (url: string) => { assigned.push(url); } } };
  localStorage.setItem(TOKEN_KEY, 'old-token');
  localStorage.setItem(USER_KEY, JSON.stringify({ id: 'u1', email: 'a@example.test', name: 'A', role: 'user' }));
  auth.init();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete g.window;
  delete g.localStorage;
});

describe('2FA endpoints', () => {
  test('setup is a POST without a body', async () => {
    respond(200, { secret: 'S', otpauth: 'otpauth://totp/x' });
    const res = await setup2fa();
    expect(res.data?.secret).toBe('S');
    expect(calls[0]).toMatchObject({ method: 'POST', body: undefined });
    expect(calls[0].url.endsWith('/api/profile/2fa/setup')).toBe(true);
  });

  test('enable sends code and password and stores the replacement token', async () => {
    respond(200, { message: 'ok', backup_codes: ['a', 'b'], token: 'new-token' });
    const res = await enable2fa('123456', 'pw');
    expect(calls[0].body).toEqual({ code: '123456', password: 'pw' });
    expect(res.data?.backup_codes).toEqual(['a', 'b']);
    expect(localStorage.getItem(TOKEN_KEY)).toBe('new-token');
  });

  test('a wrong password on enable keeps the session', async () => {
    respond(401, { error: 'wrong', code: 'INVALID_PASSWORD' });
    const res = await enable2fa('123456', 'bad');
    await settle();
    expect(res.error?.code).toBe('INVALID_PASSWORD');
    expect(assigned).toEqual([]);
    expect(localStorage.getItem(TOKEN_KEY)).toBe('old-token');
  });

  test('disable and password change store their replacement tokens', async () => {
    respond(200, { message: 'off', token: 't-disable' });
    await disable2fa('123456');
    expect(localStorage.getItem(TOKEN_KEY)).toBe('t-disable');
    respond(200, { message: 'changed', token: 't-password' });
    await changePassword('old', 'new-password');
    expect(localStorage.getItem(TOKEN_KEY)).toBe('t-password');
  });

  test('an error keeps the old token', async () => {
    respond(400, { error: 'bad code', code: 'INVALID_TOTP_CODE' });
    await disable2fa('000000');
    expect(localStorage.getItem(TOKEN_KEY)).toBe('old-token');
  });

  test('429 carries Retry-After as retry_after_seconds', async () => {
    respond(429, { error: 'too many', code: 'TOTP_TOO_MANY_ATTEMPTS' }, { 'Retry-After': '270' });
    const res = await disable2fa('000000');
    expect(res.error?.retry_after_seconds).toBe(270);
    expect(authErrorMessage(res.error)).toBe('Too many wrong codes. Try again in 4m 30s.');
  });

  test('auth.replaceToken keeps the user and swaps the token', () => {
    auth.replaceToken('swapped');
    const state = get(auth);
    expect(state.token).toBe('swapped');
    expect(state.user?.id).toBe('u1');
    expect(localStorage.getItem(TOKEN_KEY)).toBe('swapped');
  });
});

describe('sessions', () => {
  test('logout-all posts and answers ok', async () => {
    respond(200, { ok: true });
    const res = await logoutAll();
    expect(res.data?.ok).toBe(true);
    expect(calls[0]).toMatchObject({ method: 'POST' });
    expect(calls[0].url.endsWith('/api/account/logout-all')).toBe(true);
  });

  test('503 AUTH_UNAVAILABLE is retryable and does not log out', async () => {
    respond(503, { error: 'unavailable', code: 'AUTH_UNAVAILABLE' });
    const res = await logoutAll();
    await settle();
    expect(isRetryableAuthError(res.error)).toBe(true);
    expect(assigned).toEqual([]);
    expect(localStorage.getItem(TOKEN_KEY)).toBe('old-token');
  });

  test('401 TOKEN_REVOKED ends the session like any 401', async () => {
    respond(401, { error: 'revoked', code: 'TOKEN_REVOKED' });
    await api('/api/projects');
    await settle();
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(assigned).toHaveLength(1);
    expect(assigned[0]).toContain('/login?next=');
  });
});

describe('error texts', () => {
  test('codes map to inline messages', () => {
    expect(authErrorMessage({ error: 'x', code: 'PREAUTH_INVALID' })).toContain('Enter your email and password again');
    expect(authErrorMessage({ error: 'x', code: 'TOTP_CODE_REUSED' })).toContain('already used');
    expect(authErrorMessage({ error: 'server text', code: 'SOMETHING_ELSE' })).toBe('server text');
    expect(authErrorMessage(undefined, 'fallback')).toBe('fallback');
    expect(retryHint({})).toBe('Try again later.');
  });

  test('Retry-After accepts seconds and HTTP dates', () => {
    expect(parseRetryAfter('60')).toBe(60);
    expect(parseRetryAfter(new Date(10_000 + 30_000).toUTCString(), 10_000)).toBe(30);
    expect(parseRetryAfter('soon')).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });

  test('SCRIPT_BUILTIN_FORBIDDEN keeps the forbidden names', async () => {
    respond(400, { error: 'forbidden', code: 'SCRIPT_BUILTIN_FORBIDDEN', forbidden: ['exec', 3, 'http_get'] });
    const res = await api('/api/projects/p1/apps/a1/custom-rules/validate', { method: 'POST', json: { script: 'x' } });
    expect(res.error?.forbidden).toEqual(['exec', 'http_get']);
  });
});
