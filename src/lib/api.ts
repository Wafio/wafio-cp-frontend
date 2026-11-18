/**
 * WAFio API client, matches Go backend (Fiber) endpoints.
 */

const normalizeBase = (base: string) => base.replace(/\/+$/, '');
const ENV_API_BASE = normalizeBase((import.meta.env.VITE_API_BASE_URL ?? '').trim());
/** localStorage key of the session token, the only definition (stores/auth.ts imports it). */
export const TOKEN_KEY = 'wafio_token';
/** localStorage key of the signed-in user record. */
export const USER_KEY = 'wafio_user';
const getBase = () => {
  if (ENV_API_BASE) return ENV_API_BASE;
  return typeof window !== 'undefined' ? '' : 'http://localhost:9087';
};

/**
 * Absolute HTTP base of the control plane API as this browser reaches it:
 * `VITE_API_BASE_URL` when set, else the page origin (requests go to
 * `<origin>/api/…`, independent of the SvelteKit base path). Used to prefill
 * the installer's `--url`.
 */
export function apiBaseUrl(): string {
  if (ENV_API_BASE) return ENV_API_BASE;
  return typeof window !== 'undefined' ? window.location.origin : 'http://localhost:9087';
}

/** System role of a user account. */
export type SystemRole = 'admin' | 'user';

export interface User {
  id: string;
  email: string;
  name: string;
  role: SystemRole | string;
  totp_enabled?: boolean;
  backup_codes_remaining?: number;
}

/** Project role, lowest to highest: viewer (read) < member (configure) < owner (destructive, members). */
export type ProjectRole = 'viewer' | 'member' | 'owner';

/** Mirrors projectPermissions() in internal/adapter/http/handlers/projects.go. */
export interface ProjectPermissions {
  read: boolean;
  configure: boolean;
  manage_members: boolean;
  delete_project: boolean;
}

export interface Project {
  /** Present on GET /projects and GET /projects/:id, absent on create. */
  effective_role?: ProjectRole;
  permissions?: ProjectPermissions;
  id: string;
  name: string;
  code: string;
  description: string;
  created_at: string;
  /** Never returned by the API; kept optional for older callers. */
  updated_at?: string;
}

export interface ApiError {
  kind?: "http" | "network" | "protocol" | "aborted";
  status?: number;
  error: string;
  code?: string;
  detail?: string;
  /** Operator hint some handlers add (e.g. 409 AGENT_ONLINE → how to force). */
  hint?: string;
  retry_after_seconds?: number;
  /** 400 SCRIPT_BUILTIN_FORBIDDEN: script built-ins outside the sandbox allowlist. */
  forbidden?: string[];
  /** 400 TOO_MANY_LABELS: the hosts that would carry more than 32 labels. */
  host_ids?: string[];
  /** 400 TOO_MANY_TARGETS: hosts the label selector matched. */
  matched?: number;
  /** 400 VALIDATION_FAILED / 409 SMTP_SETTINGS_MANAGED: the request field it names. */
  field?: string;
}

/**
 * Delivery state of one host policy bundle. `refused`: the agent's lockout
 * guard rejected the state before changing anything (code = guard code);
 * ebpf_state also carries which policy runs (source saved|default|live), the
 * restored generation and dns_relaxed.
 */
export interface HostBundleStatus {
  command_id: string;
  desired_generation: string;
  applied_generation: string;
  status: 'pending' | 'failed' | 'applied' | 'refused';
  code?: string;
  source?: 'saved' | 'default' | 'live' | (string & {});
  saved_generation?: string;
  dns_relaxed?: boolean;
  error?: string;
  updated_at: string;
}

/** Result shape of every call in this module. */
export type ApiResult<T> = { data?: T; error?: ApiError };

/** `{"ok": true}` action acknowledgement. */
export interface OkResponse { ok: boolean }

/** ?limit=&offset= of a paged list (handlers/helpers.go parsePage). An
 *  omitted limit returns up to the endpoint maximum (100; blocklists 1000;
 *  custom rules 200); a larger limit is clamped. */
export interface PageParams { limit?: number; offset?: number }

/** Paging fields every paged list response carries: `total` counts all rows,
 *  `limit`/`offset` describe the returned window. */
export interface PageMeta { total: number; limit: number; offset: number }

/** Appends limit/offset to `path` (which may already have a query string). */
function withPage(path: string, page?: PageParams): string {
  const params = new URLSearchParams();
  if (page?.limit !== undefined) params.set('limit', String(page.limit));
  if (page?.offset !== undefined) params.set('offset', String(page.offset));
  const qs = params.toString();
  if (!qs) return path;
  return `${path}${path.includes('?') ? '&' : '?'}${qs}`;
}

export function getToken(): string | null {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') return null;
  return localStorage.getItem(TOKEN_KEY);
}

/**
 * Stores the replacement session token some responses carry (2FA enable and
 * disable, password change): the server revokes every earlier token on those
 * actions, so the next request with the old one would be 401
 * TOKEN_REVOKED. Called by the API functions themselves; the auth store
 * mirrors it with auth.replaceToken().
 */
export function storeSessionToken(token: unknown): token is string {
  if (typeof token !== 'string' || token.length === 0) return false;
  if (typeof localStorage === 'undefined') return false;
  localStorage.setItem(TOKEN_KEY, token);
  return true;
}

/** Seconds from a Retry-After header (delta-seconds or HTTP date); undefined when absent or invalid. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

// Session expiry
//
// One place decides what a 401 means. Any 401 from our API ends the session
// (token and user removed, full reload of base + /login?next=<current page>),
// except where 401 is an ordinary answer: the sign-in endpoints themselves
// and a wrong current password on the password-change form.

/** Endpoints whose 401 means "wrong credentials", not "session over". */
const CREDENTIAL_ENDPOINTS = new Set(['/api/login', '/api/login/2fa', '/api/register/invite']);
/** Error codes that come with a 401 but leave the session valid. */
const NON_SESSION_401_CODES = new Set(['INVALID_PASSWORD']);

/**
 * True when a response to `path` (an API path such as "/api/projects/1")
 * means the session is no longer valid.
 */
export function isSessionExpired(path: string, status: number | undefined, code?: string): boolean {
  if (status !== 401) return false;
  const pathname = path.split(/[?#]/)[0].replace(/\/+$/, '');
  if (CREDENTIAL_ENDPOINTS.has(pathname)) return false;
  return !(code && NON_SESSION_401_CODES.has(code));
}

/** Removes the stored token and user. */
export function clearSession(): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

/**
 * Login URL that returns to `current` after sign-in:
 * `${base}/login?next=${encodeURIComponent(path + search + hash)}`.
 * No `next` when `current` is the login page itself.
 */
export function loginRedirectPath(base: string, current: { pathname: string; search?: string; hash?: string }): string {
  const prefix = normalizeBase(base);
  const login = `${prefix}/login`;
  if (current.pathname === login || current.pathname === `${login}/`) return login;
  const next = `${current.pathname}${current.search ?? ''}${current.hash ?? ''}`;
  return `${login}?next=${encodeURIComponent(next)}`;
}

/**
 * Validates a `?next=` value before navigating to it after sign-in: only a
 * same-origin absolute path inside the app (under `base`), never a scheme,
 * a protocol-relative "//host", a backslash trick or the login page.
 * Returns the path, or null when it must be ignored.
 */
export function safeNextPath(next: string | null | undefined, base = ''): string | null {
  if (!next) return null;
  const value = next;
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\') || /[\u0000-\u001f]/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value, 'http://wafio.invalid');
  } catch {
    return null;
  }
  if (url.origin !== 'http://wafio.invalid') return null;
  const prefix = normalizeBase(base);
  if (prefix && url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return null;
  const appPath = prefix ? url.pathname.slice(prefix.length) || '/' : url.pathname;
  if (appPath === '/login' || appPath.startsWith('/login/')) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

let sessionRedirectStarted = false;

async function appBasePath(): Promise<string> {
  try {
    const paths: { base?: string } = await import('./paths.js');
    return typeof paths.base === 'string' ? paths.base : '';
  } catch {
    return '';
  }
}

/**
 * Ends the session after a 401: clears the token and user, then reloads the
 * login page with a return path. Repeated calls (parallel requests failing
 * together) redirect once. Also used by stream helpers that see a 401.
 */
export function handleUnauthorized(): void {
  clearSession();
  if (typeof window === 'undefined' || sessionRedirectStarted) return;
  sessionRedirectStarted = true;
  void appBasePath().then((base) => {
    const { pathname, search, hash } = window.location;
    const target = loginRedirectPath(base, { pathname, search, hash });
    if (pathname === target) return;
    if (pathname === `${normalizeBase(base)}/login`) return;
    window.location.assign(target);
  });
}

/** Test hook: allow another redirect in the same JS realm. */
export function resetSessionRedirectForTests(): void {
  sessionRedirectStarted = false;
}

const stringFields = (...names:string[]) => (body:unknown):boolean => body !== null && typeof body === 'object' && names.every(name => typeof (body as Record<string,unknown>)[name] === 'string' && (body as Record<string,string>)[name].length > 0);

export async function api<T>(
  path: string,
  options: RequestInit & { json?: unknown } = {},
  validateResponse?: (body: unknown) => boolean
): Promise<{ data?: T; error?: ApiError }> {
  const base = getBase();
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const { json, ...fetchOptions } = options;
  if (json !== undefined) {
    fetchOptions.body = JSON.stringify(json);
  }

  let res: Response;
  try {
    res = await fetch(`${base}${path}`, { ...fetchOptions, headers });
  } catch (cause) {
    const aborted = cause instanceof Error && cause.name === 'AbortError';
    return { error: { kind: aborted ? 'aborted' : 'network', error: aborted ? 'Request cancelled' : 'Unable to reach the server. Please retry.' } };
  }
  if (res.status === 204 && !validateResponse) return {data: undefined};
  let body: any;
  try {
    body = await res.json();
    if (typeof body !== 'object') throw new Error('Invalid response');
  } catch {
    if (isSessionExpired(path, res.status)) handleUnauthorized();
    return { error: { kind: res.ok ? 'protocol' : 'http', status: res.status, error: res.ok ? 'Invalid response from server' : `Request failed (${res.status})` } };
  }

  if (!res.ok) {
    const errorMessage = typeof body?.error === 'string' ? body.error : 'Request failed';
    const code = typeof body?.code === 'string' ? body.code : undefined;
    if (isSessionExpired(path, res.status, code)) handleUnauthorized();
    return {
      error: {
        kind: "http",
        status: res.status,
        error: errorMessage,
        code,
        detail: body?.detail,
        hint: typeof body?.hint === 'string' ? body.hint : undefined,
        retry_after_seconds: typeof body?.retry_after_seconds === 'number'
          ? body.retry_after_seconds
          : parseRetryAfter(res.headers?.get?.('Retry-After')),
        forbidden: Array.isArray(body?.forbidden)
          ? body.forbidden.filter((name: unknown): name is string => typeof name === 'string')
          : undefined,
        host_ids: Array.isArray(body?.host_ids)
          ? body.host_ids.filter((id: unknown): id is string => typeof id === 'string')
          : undefined,
        matched: typeof body?.matched === 'number' ? body.matched : undefined,
        field: typeof body?.field === 'string' ? body.field : undefined,
      },
    };
  }
  if (validateResponse && !validateResponse(body)) return {error:{kind:"protocol",status:res.status,error:"Server response does not match the operation"}};
  const method = (options.method ?? 'GET').toUpperCase();
  if (!['GET', 'HEAD'].includes(method) && (!body || Array.isArray(body) || Object.keys(body).length === 0)) {
    return { error: { kind: 'protocol', status: res.status, error: 'Server did not confirm the operation' } };
  }
  return { data: body as T };
}

// SSE stream tickets
// EventSource cannot send an Authorization header, so an SSE URL carries its
// credential in the query string. A stream ticket is valid for one stream of
// one project, for 60 s, once, request a new one for every (re)connect.

export type ProjectStreamName = 'host' | 'waf' | 'agent-decisions';

export interface StreamTicket {
  ticket: string;
  stream: ProjectStreamName;
  expires_at: string;
  expires_in: number;
}

export function createStreamTicket(projectId: string, stream: ProjectStreamName) {
  return api<StreamTicket>(
    `/api/projects/${encodeURIComponent(projectId)}/stream-ticket`,
    { method: 'POST', json: { stream } },
    stringFields('ticket'),
  );
}

/** URL of a project SSE endpoint authenticated by `ticket`. */
export function projectStreamURL(
  projectId: string,
  stream: ProjectStreamName,
  ticket: string,
  params: Record<string, string | undefined> = {},
  base: string = getBase(),
): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') q.set(key, value);
  }
  q.set('ticket', ticket);
  return `${base}/api/projects/${encodeURIComponent(projectId)}/${stream}/stream?${q}`;
}

/**
 * Requests a ticket and returns the stream URL for one connection, e.g.
 * `const r = await openProjectStreamURL(id, 'waf'); if (r.url) es = new EventSource(r.url)`.
 * Call it again for every reconnect: a ticket is spent by the first request.
 * A 401/403/404 error means the stream will not open, stop retrying.
 */
export async function openProjectStreamURL(
  projectId: string,
  stream: ProjectStreamName,
  params: Record<string, string | undefined> = {},
): Promise<{ url?: string; error?: ApiError }> {
  const res = await createStreamTicket(projectId, stream);
  if (res.error || !res.data) return { error: res.error ?? { kind: 'protocol', error: 'No stream ticket issued' } };
  return { url: projectStreamURL(projectId, stream, res.data.ticket, params) };
}

// Auth
// Shapes mirror internal/adapter/http/handlers/auth.go.

/** `user` object of a session response (no 2FA fields). */
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: SystemRole | string;
}

/** POST /api/login (no 2FA), /api/login/2fa, /api/register/invite. */
export interface AuthSession {
  token: string;
  user: AuthUser;
  requires_2fa?: undefined;
  temp_token?: undefined;
}

/** POST /api/login when the account has 2FA: finish with login2fa(temp_token, code). */
export interface TwoFactorChallenge {
  requires_2fa: true;
  temp_token: string;
  token?: undefined;
  user?: undefined;
}

export type LoginResponse = AuthSession | TwoFactorChallenge;

export function isTwoFactorChallenge(value: LoginResponse | null | undefined): value is TwoFactorChallenge {
  return value?.requires_2fa === true;
}

export interface TwoFactorSetup { secret: string; otpauth: string }
/** POST /api/profile/2fa/enable; `token` replaces the session token. */
export interface TwoFactorEnabled { message: string; backup_codes: string[]; backup_codes_warning?: string; token: string }
/** A response that revoked every earlier token and carries this session's replacement. */
export interface TokenReplacedResponse { message: string; token: string }
export interface BackupCodes { backup_codes: string[] }
/** PUT /api/me answers without the role; merge it into the stored user. */
export interface ProfileUpdate { id: string; email: string; name: string }

function isAuthSession(body: unknown): boolean {
  if (!stringFields('token')(body)) return false;
  const user = (body as Record<string, unknown>).user;
  return stringFields('id', 'email', 'role')(user)
    && typeof (user as Record<string, unknown>).name === 'string';
}

function isLoginResponse(body: unknown): boolean {
  return isAuthSession(body) || (stringFields('temp_token')(body)
    && (body as Record<string, unknown>).requires_2fa === true);
}

export async function login(email: string, password: string): Promise<ApiResult<LoginResponse>> {
  return api<LoginResponse>('/api/login', {
    method: 'POST',
    body: JSON.stringify({ email, password })
  }, isLoginResponse);
}

export async function login2fa(temp_token: string, code: string): Promise<ApiResult<AuthSession>> {
  return api<AuthSession>('/api/login/2fa', {
    method: 'POST',
    body: JSON.stringify({ temp_token, code })
  }, isAuthSession);
}

// ── Password recovery by email ─────────────────────────────

/** Whether this server can send reset emails (mail server and base URL set). Nothing per account. */
export interface RecoveryInfo { email_recovery: boolean }

export async function getRecoveryInfo(): Promise<ApiResult<RecoveryInfo>> {
  return api<RecoveryInfo>('/api/auth/recovery', {}, (body) =>
    body !== null && typeof body === 'object' && typeof (body as Record<string, unknown>).email_recovery === 'boolean');
}

/**
 * Asks for a reset email. The answer is the same `{"ok": true}` for every
 * well-formed address, registered or not (no account enumeration); 400
 * VALIDATION_FAILED for a malformed one, 429 RATE_LIMIT_EXCEEDED.
 */
export async function requestPasswordReset(email: string): Promise<ApiResult<OkResponse>> {
  return api<OkResponse>('/api/auth/forgot-password', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

/**
 * Sets a new password with the token of a reset link. 400
 * RESET_TOKEN_INVALID (unknown, expired, used or replaced link) or
 * VALIDATION_FAILED (password policy). Every session of the account ends;
 * no session is returned.
 */
export async function resetPassword(token: string, newPassword: string): Promise<ApiResult<OkResponse>> {
  return api<OkResponse>('/api/auth/reset-password', {
    method: 'POST',
    body: JSON.stringify({ token, new_password: newPassword }),
  });
}

/** Issues a new pending TOTP secret (POST, no body). 409 TOTP_ALREADY_ENABLED. */
export async function setup2fa(): Promise<ApiResult<TwoFactorSetup>> {
  return api<TwoFactorSetup>('/api/profile/2fa/setup', { method: 'POST' }, stringFields('secret', 'otpauth'));
}

/** Stores the replacement token of a successful response before the caller sees it. */
async function withReplacementToken<T extends { token?: string }>(res: Promise<ApiResult<T>>): Promise<ApiResult<T>> {
  const out = await res;
  if (out.data) storeSessionToken(out.data.token);
  return out;
}

/**
 * Confirms the pending secret with a code and the current password.
 * 400 VALIDATION_FAILED / TOTP_SETUP_REQUIRED / INVALID_TOTP_CODE,
 * 401 INVALID_PASSWORD (session stays), 409 TOTP_ALREADY_ENABLED,
 * 429 TOTP_TOO_MANY_ATTEMPTS. The replacement token is stored.
 */
export async function enable2fa(code: string, password: string): Promise<ApiResult<TwoFactorEnabled>> {
  return withReplacementToken(api<TwoFactorEnabled>('/api/profile/2fa/enable', {
    method: 'POST',
    body: JSON.stringify({ code, password })
  }, stringFields('token')));
}

/** 400 INVALID_TOTP_CODE, 429 TOTP_TOO_MANY_ATTEMPTS. The replacement token is stored. */
export async function disable2fa(code: string): Promise<ApiResult<TokenReplacedResponse>> {
  return withReplacementToken(api<TokenReplacedResponse>('/api/profile/2fa/disable', {
    method: 'POST',
    body: JSON.stringify({ code })
  }, stringFields('token')));
}

/**
 * Logs out every session of the user, this one included. The caller
 * clears the session and goes to the login page. 503 AUTH_UNAVAILABLE is
 * retryable and leaves the session alone.
 */
export async function logoutAll(): Promise<ApiResult<OkResponse>> {
  return api<OkResponse>('/api/account/logout-all', { method: 'POST' });
}

export async function regenerateBackupCodes(code: string): Promise<ApiResult<BackupCodes>> {
  return api<BackupCodes>('/api/profile/2fa/backup-codes/regenerate', {
    method: 'POST',
    body: JSON.stringify({ code })
  });
}
// Profile (requires auth)
export async function getMe() {
  return api<User>('/api/me');
}

/** Resolves to id/email/name only, use auth.updateUser() (or setAuth) to keep the role. */
export async function updateProfile(name: string) {
  return api<ProfileUpdate>('/api/me', {
    method: 'PUT',
    body: JSON.stringify({ name }),
  });
}

/** 401 INVALID_PASSWORD leaves the session; on success the replacement token is stored. */
export async function changePassword(currentPassword: string, newPassword: string) {
  return withReplacementToken(api<TokenReplacedResponse>('/api/me/password', {
    method: 'PUT',
    body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
  }, stringFields('token')));
}

// Projects
export async function listProjects(limit = 20, offset = 0) {
  return api<{ projects: Project[]; total: number }>(`/api/projects?limit=${limit}&offset=${offset}`);
}

// Selectors need the complete set; follow the server's total instead of raising a cap.
export async function listAllProjects() {
  const projects: Project[] = [];
  for (;;) {
    const result = await listProjects(100, projects.length);
    if (result.error) return { error: result.error };
    if (!result.data || !Array.isArray(result.data.projects)) return { error: { kind: 'protocol' as const, error: 'Invalid project list' } };
    projects.push(...result.data.projects);
    if (projects.length >= result.data.total) return { data: { projects, total: result.data.total } };
    if (!result.data.projects.length) return { error: { kind: 'protocol' as const, error: 'Incomplete project list' } };
  }
}

export async function getServerVersion() {
  return api<{ version: string }>('/api/version');
}

export async function getCountryCodes() {
  return api<{ codes: string[]; list: { code: string; name: string }[] }>('/api/country-codes');
}

export async function getDefaultUABlocklist() {
  return api<{ source: string; items: string[] }>('/api/bot-defaults/ua-blocklist');
}

export async function getDefaultJA4Blocklist() {
  return api<{ source: string; items: { fingerprint: string; comment?: string }[] }>('/api/bot-defaults/ja4-blocklist');
}

export async function getDefaultJA4Allowlist() {
  return api<{ source: string; items: { fingerprint: string; comment?: string }[] }>('/api/bot-defaults/ja4-allowlist');
}

export async function getProject(id: string) {
  return api<Project>(`/api/projects/${id}`);
}

export interface ProjectOverview {
  waf_window_start: string;
  waf_window_end: string;
  generated_at: string;
  widgets: Record<string, { state: "ok" | "empty" | "stale" | "unavailable"; message?: string }>;
  waf_summary:          WAFEventSummary | null;
  waf_summary_prev:     WAFEventSummary | null;
  waf_timeline:         { buckets: WAFEventTimelineBucket[] } | null;
  waf_top_ips:          { dimension: string; rows: WAFEventTopRow[] } | null;
  waf_top_categories:   { dimension: string; rows: WAFEventTopRow[] } | null;
  waf_top_countries:    { dimension: string; rows: { label: string; code: string; count: number }[] } | null;
  waf_agents:           { agents: FleetAgent[]; count: number } | null;
  host_agg_status:      HostAggregateStatus | null;
  host_agg_metrics:     EBPFMetrics | null;
  host_fw_drops_windowed: number;
  host_fw_drop_reasons: Record<string, number> | null;
  host_firewall_events: { events: EBPFEvent[]; count: number } | null;
  host_trace_stats:     TraceStats | null;
  host_trace_events:    TraceEvent[] | null;
  hosts:                { hosts: Host[]; count: number } | null;
}

export async function getProjectOverview(
  projectId: string,
  opts: { minutes?: number; bucketSeconds?: number; hostId?: string; wafAgentId?: string; limit?: number } = {}
) {
  const q = new URLSearchParams();
  if (opts.minutes)       q.set('minutes',        String(opts.minutes));
  if (opts.bucketSeconds) q.set('bucket_seconds',  String(opts.bucketSeconds));
  if (opts.hostId)        q.set('host_id',         opts.hostId);
  if (opts.wafAgentId)    q.set('waf_agent_id',    opts.wafAgentId);
  if (opts.limit)         q.set('limit',           String(opts.limit));
  return api<ProjectOverview>(`/api/projects/${projectId}/overview?${q.toString()}`);
}

export async function createProject(name: string, description: string) {
  return api<Project>('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name, description }),
  },stringFields('id','name'));
}

export async function updateProject(id: string, name: string, description: string) {
  return api<OkResponse>(`/api/projects/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ name, description }),
  });
}

export async function deleteProject(id: string) {
  return api<OkResponse>(`/api/projects/${id}`, { method: 'DELETE' });
}

/**
 * Credential flags on a WAF config read. For callers below
 * member `secrets_redacted` is true and siem.webhook_url, challenge.secret_key
 * and path-exception AES keys arrive blank; the `*_set` flags tell whether
 * one is configured.
 */
export interface ConfigSecretFlags {
  secrets_redacted?: boolean;
  webhook_url_set?: boolean;
  challenge_secret_key_set?: boolean;
  aes_keys_set?: boolean;
}

export async function getProjectConfig(projectId: string) {
  return api<{ rules_json: Record<string, unknown>; config_revision: number } & ConfigSecretFlags>(
    `/api/projects/${projectId}/config`
  );
}

export async function putProjectConfig(
  projectId: string,
  rules_json: Record<string, unknown>,
  expected_revision: number
) {
  return api<{ok:boolean;config_revision:number}>(`/api/projects/${projectId}/config`, {
    method: 'PUT',
    body: JSON.stringify({ rules_json, expected_revision }),
  });
}

// Dashboard / Analitik (per project, PostgreSQL/TimescaleDB)
export type DecisionStrength = 'block' | 'weak';

export interface DashboardLogEntry {
  id: number;
  project_id: string;
  ts: number;
  action: string;
  score: number;
  /** See WAFDecisionRow.strength. */
  strength?: DecisionStrength | null;
  rule_ids?: string;
  categories?: string;
  analyze_method?: string;
  message?: string;
  block_until_ts?: number;
  match_detail?: string;
  method?: string;
  uri?: string;
  host?: string;
  remote_addr?: string;
  country_code?: string;
  user_agent?: string;
  request_id?: string;
  body_injection_fields?: string; // Cuplikan body (POST/PUT/PATCH) saat deteksi; terpotong 512 byte.
  header_injection_fields?: string; // Cuplikan header mencurigakan; terpotong 512 byte.
}

export async function getDashboardLogs(
  projectId: string,
  params?: { from_ts?: number; to_ts?: number; action?: string; limit?: number; offset?: number; search?: string }
) {
  const q = new URLSearchParams();
  if (params?.from_ts != null) q.set('from_ts', String(params.from_ts));
  if (params?.to_ts != null) q.set('to_ts', String(params.to_ts));
  if (params?.action) q.set('action', params.action);
  if (params?.limit != null) q.set('limit', String(params.limit));
  if (params?.offset != null) q.set('offset', String(params.offset));
  if (params?.search) q.set('search', params.search);
  const query = q.toString();
  return api<{ total: number; logs: DashboardLogEntry[] }>(
    `/api/projects/${projectId}/dashboard/logs${query ? '?' + query : ''}`
  );
}

/** Stored WAF decisions per HTTP method over the whole project (no host filter). */
export async function getDashboardByMethod(projectId: string, params: { from_ts?: number; to_ts?: number } = {}, signal?: AbortSignal) {
  const q = new URLSearchParams();
  if (params.from_ts != null) q.set('from_ts', String(params.from_ts));
  if (params.to_ts != null) q.set('to_ts', String(params.to_ts));
  const query = q.toString();
  return api<{ by_method: { key: string; count: number }[] | null }>(
    `/api/projects/${projectId}/dashboard/stats/by-method${query ? '?' + query : ''}`,
    { signal }
  );
}

export interface GeoLocation {
  remote_addr: string;
  country_code: string;
  country_name?: string;
  count: number;
  allow: number;
  log: number;
  block: number;
  city?: string;
  lat?: number;
  lon?: number;
  isp?: string;
}

// Project-level WAF events (new Overview pipeline)
//
// These endpoints aggregate `waf_decisions` (pushed by the decomposed
// wafio-waf-agent via /api/internal/waf/ingest) and attribute traffic to a
// project via `agents.project_id`.

/**
 * KPI block shared by repository.AppWAFSummary (app) and ProjectWAFSummary
 * (project): GET …/apps/:appId/waf/summary and …/waf-events/summary.
 * WebSocket fields (scope: method='WEBSOCKET' OR match_source LIKE 'ws:%';
 * ws_messages_* count frames only, ws_handshake_rejected counts blocked
 * handshakes separately) are always present.
 */
export interface WAFSummary {
  window: string;
  requests: number;
  blocks: number;
  allows: number;
  monitors: number;
  logs: number;
  errors: number;
  /** action = 'challenge': part of `requests`, in no other bucket. */
  challenges: number;
  block_rate: number;
  avg_latency_us: number;
  unique_ips: number;
  /** Decisions made by semantic analysis. Rows an older agent stored as `rule_based` or `hybrid` are counted here. */
  semantic_triggers: number;
  other_triggers: number;
  ws_messages_blocked: number;
  ws_messages_logged: number;
  ws_handshake_rejected: number;
}

/** Project summary: the shared KPIs plus host/agent counts. */
export interface WAFEventSummary extends WAFSummary {
  unique_hosts: number;
  agents_active: number;
}

/** Values of waf_decisions.action. */
export type WAFDecisionAction = 'block' | 'allow' | 'monitor' | 'log' | 'upstream_error';

/**
 * repository.WAFDecisionRow, one row of the project "recent" feed
 * (GET …/waf-events/recent) and of the app decision feed
 * (GET …/apps/:appId/waf/decisions).
 */
export interface WAFDecisionRow {
  id: number;
  agent_id: string;
  app_id: string;
  host: string;
  method: string;
  uri: string;
  remote_addr: string;
  country_code: string;
  user_agent: string;
  content_type: string;
  action: WAFDecisionAction | string;
  score: number;
  /** null when the decision matched no category. */
  categories: string[] | null;
  cwe: string;
  match_detail: string;
  analyze_method: string;
  body_size: number;
  latency_us: number;
  body_preview: string;
  event_time: string;
  recorded_at: string;
  match_source: string;
  request_headers?: Record<string, string>;
  request_body?: string;
  query_params?: string;
  payload_type?: string;
  /** HTTP status the client received. 0 or absent means not recorded: older rows and agents, and logged WebSocket handshakes. */
  status?: number;
  /** Semantic-scan coverage gap flags ("field_cap,body_binary"); "" = complete. An older control plane also lists `engine_disabled:<key>` here. */
  coverage: string;
  /** Engine keys the operator switched off for this request. Not a gap. Absent on an older control plane. */
  engines_off?: string[];
  /** Engine keys whose block was held back as a LOG decision (their action is Log only). Absent on an older control plane. */
  engines_log_only?: string[];
  /** How strong the detection behind the decision was: "block" (a block or monitor decision, or a block held back as LOG), "weak" (a LOG that would not have blocked) or null (no detection). Absent on an older control plane. */
  strength?: DecisionStrength | null;
}

/** Row of the project "recent" feed. */
export type WAFEventDecision = WAFDecisionRow;

export interface WAFEventTopRow {
  label: string;
  count: number;
}

export interface WAFEventTimelineBucket {
  bucket_start: string;
  requests: number;
  blocks: number;
  allows: number;
  monitors: number;
  errors: number;
  /** action = 'log' (not included in `monitors`). */
  logs: number;
  /** action = 'challenge'. */
  challenges: number;
}

export async function getWAFEventsRecent(
  projectId: string,
  params?: { action?: string; limit?: number }
) {
  const q = new URLSearchParams();
  if (params?.action) q.set('action', params.action);
  if (params?.limit != null) q.set('limit', String(params.limit));
  const qs = q.toString();
  return api<{ decisions: WAFEventDecision[] }>(
    `/api/projects/${projectId}/waf-events/recent${qs ? '?' + qs : ''}`
  );
}

// eBPF Kernel Firewall

export interface TelemetryDelivery {
 pending_batches:number;pending_bytes:number;process_accepted_batches:number;dropped_batches:number;dropped_events:number;persisted_acknowledgements:false;
  /** Batches sent again because no receipt came within 2 s (v1.9.0+). */
  resent_batches?: number;
  /** Gzip members padded to the control plane's ratio cap; omitted while the stream sends plain JSON. */
  padded_batches?: number;
  /** Compression of the open stream; absent on the HTTP push path and older agents. */
  compression?: 'gzip' | 'none' | (string & {});
}
export interface IngestionStatus {
 acceptance:'process_accepted';durable:false;accepted_events:number;rejected_events:number;db_write_failures:number;
}
/** One BPF map the host agent sizes from the host memory. */
export interface MapCapacity {
  name: string;
  /** Entries the map holds; for the trace ring, its size in bytes. */
  max_entries: number;
  /** Size without scaling, the most the agent allocates. */
  default_max_entries?: number;
  /** Live count, sampled every 30 s; absent for the ring. */
  entries?: number;
  /** Inserts refused since the agent started; absent for maps that evict the oldest entry. */
  full_count?: number;
  /** Last time full_count grew; for a map that evicts, the last sample close to full (UTC ISO 8601). */
  last_full_at?: string;
}
/** Map sizes of the firewall (`EBPFStatus`) or of tracing (`TraceStatus`); absent on older agents. */
export interface MapSizing {
  /** Share of the largest sizes, above 0 and at most 1. */
  scale: number;
  /** 'auto' when the agent computed the scale from memory, anything else when WAFIO_EBPF_MAP_SCALE or the flag set it. */
  source: 'auto' | (string & {});
  memory_bytes?: number;
  memory_source?: string;
  sampled_at?: string;
  maps: MapCapacity[];
}
export interface EBPFStatus {
 ingestion?:IngestionStatus;
  map_sizing?: MapSizing;
 telemetry_delivery?:TelemetryDelivery;
 telemetry_send_failures?:number;
  bundle_status?: Record<string, HostBundleStatus>;
  coverage_warnings?: string[];
  egress_ipv6_supported?: boolean;
  /** Addresses the WAF agent jailed at XDP, latest expiry first, at most 100; read-only. */
  jail?: EBPFIPListEntry[];
  /** Every live jail entry on the host. */
  jail_count?: number;
  /** Live geo mode and, when the desired geo policy is not enforced, why
   * (GEO_ALLOW_UNSUPPORTED, GEO_ALLOW_NO_DATASET, ...). Every other rule
   * is applied; the previous geo state stays. */
  geo_mode?: string;
  geo_degraded_code?: string;
  /** What the host enforces instead: kept (previous geo state),
   * ranges_cleared (block mode without the country ranges), mixed (a failed
   * change could not be rolled back). */
  geo_degraded_state?: string;
  geo_degraded_message?: string;
  running: boolean;
  interface?: string;
  interface_idx?: number;
  xdp_attached: boolean;
  tc_ingress_attached: boolean;
  tc_egress_attached: boolean;
  xdp_mode?: string;
  started_at?: string;
  uptime_seconds?: number;
  pin_path?: string;
  kernel_version?: string;
  // Liveness fields injected by the server. These let the UI tell the
  // difference between "agent not connected / never reported" and
  // "agent online but firewall is stopped".
  agent_online?: boolean;
  agent_last_seen?: string;
  agent_name?: string;
  never_reported?: boolean;
  // Live config snapshot pushed by the agent alongside status. Used by the
  // overview banner to surface monitor-only mode without having to load the
  // full /config endpoint first.
  config?: {
    global?: EBPFGlobalConfig;
    rate?: unknown;
    anomaly?: unknown;
    port_scan?: EBPFPortScanConfig;
  };
}

export interface EBPFMetrics {
  would_drop_packets?: number;
  would_drop_bytes?: number;
  state_table_full?: number;
  packet_parse_failures?: number;
  rx_packets: number;
  rx_bytes: number;
  tx_packets: number;
  tx_bytes: number;
  dropped_packets: number;
  dropped_bytes: number;
  ratelimited_packets: number;
  synflood_drops: number;
  blocklist_drops: number;
  allowlist_passes: number;
  geoblock_drops: number;
  /** Connection-tracking entries created since the agent started (both families, ingress and egress; cumulative, not the live table size). */
  conntrack_entries: number;
  port_scan_drops: number;
  port_policy_drops: number;
  egress_ip_drops: number;
  pps: number;
  bps: number;
  drop_rate_pct: number;
  timestamp: string;
}

export interface EBPFGlobalConfig {
  enabled: boolean;
  monitor_only: boolean;
  log_allowed: boolean;
  log_blocked: boolean;
  enable_conntrack: boolean;
  enable_synflood: boolean;
  enable_ratelimit: boolean;
  enable_geoblock: boolean;
  max_payload_bytes: number;
}

export interface EBPFRateConfig {
  window_ms: number;
  max_pps: number;
  max_bps: number;
  max_syn_pps: number;
  burst_pps: number;
  burst_syn: number;
  drop_on_limit: boolean;
}

export interface EBPFAnomalyConfig {
  detect_xmas: boolean;
  detect_null: boolean;
  detect_fin_only: boolean;
  drop_on_detect: boolean;
}

export interface EBPFPortScanConfig {
  enabled: boolean;
  window_ms: number;
  max_unique_ports: number;
  drop_on_detect: boolean;
}

export interface EBPFFullConfig {
  global: EBPFGlobalConfig;
  rate: EBPFRateConfig;
  anomaly: EBPFAnomalyConfig;
  port_scan: EBPFPortScanConfig;
}

/** Entry of the block, allow and egress block lists (ebpf.BlocklistEntry). */
export interface EBPFIPListEntry {
  ip: string;
  added_at: string;
  /** Absent = permanent. */
  expires_at?: string;
  hit_count: number;
}
export type EBPFBlocklistEntry = EBPFIPListEntry;

/**
 * Port scope of an allowlist entry: `to` omitted
 * or 0 = the single port `from`; "any" = TCP and UDP.
 */
export interface EBPFPortScope { proto: 'tcp' | 'udp' | 'any'; from: number; to?: number }

/** Allowlist entry: `ports` empty or absent = every port and protocol, ICMP included. */
export interface EBPFAllowlistEntry extends EBPFIPListEntry {
  ports?: EBPFPortScope[];
  /**
   * Server-computed: permanent and either unscoped or covering an SSH port
   * over TCP, counts as the management escape hatch for wildcard blocks.
   */
  lockout_escape?: boolean;
}

/** Body of an IP list add: `ttl_ms` absent or 0 = permanent; `ports` only on the allowlist. */
export interface EBPFIPListAdd { ip: string; ttl_ms?: number; ports?: EBPFPortScope[] }

/** Answer of every host desired-state list mutation: the new list size. */
export interface HostStateMutation { status: string; count: number; warnings?: { code: string; message: string }[] }

export interface EBPFEvent {
  timestamp: string;
  src_ip: string;
  dst_ip: string;
  src_port: number;
  dst_port: number;
  proto: string;
  action: string;
  reason: string;
  tcp_flags?: string;
  pkt_len: number;
  rule_id?: number;
  /** Geo drops: "allow" when the host runs geo allow mode. */
  geo_mode?: string;
}

export interface FirewallTopIPRow {
  src_ip: string;
  country_code: string;
  country_name: string;
  blocklist: number;
  rate_limit: number;
  syn_flood: number;
  geo_block: number;
  port_scan: number;
  port_policy: number;
  other: number;
  total: number;
}

export interface EBPFConnection {
  src_ip: string;
  dst_ip: string;
  src_port: number;
  dst_port: number;
  proto: string;
  state: string;
  first_seen: string;
  last_seen: string;
  packets: number;
  bytes: number;
}

export interface EBPFBandwidthEntry {
  ip: string;
  ingress_bytes: number;
  egress_bytes: number;
  ingress_packets: number;
  egress_packets: number;
  ingress_bps: number;
  egress_bps: number;
}

// ──────────────────────────────────────────────────────────────────────────────
// Fleet API, unified agent management across projects & kinds (enterprise).
// ──────────────────────────────────────────────────────────────────────────────

/** repository.AgentWithHostInfo, GET /fleet/agents, /hosts/:hostId/agents. */
export type FleetAgent = {
  id: string;
  name: string;
  kind: 'host' | 'waf' | string;
  project_id?: string;
  host_id?: string;
  callback_url?: string;
  last_seen?: string;
  is_online: boolean;
  created_at: string;
  hostname?: string;
  version?: string;
  /** WAF agents: can run script rules; false = it reported no script engine, null or absent = unknown (an older control plane, an agent that never connected, a host agent). */
  script_rules?: boolean | null;
  host_os?: string;
  host_os_version?: string;
  host_kernel?: string;
  host_arch?: string;
  host_cpu_count?: number;
  host_memory?: number;
  host_virt?: string;
  host_boot_time?: string;
  host_updated_at?: string;
  // WAF inspection-health counters from the latest heartbeat (WAF agents
  // only; cumulative since agent start). Absent = agent never reported them.
  analyze_panics_total?: number;
  engine_panics_total?: number;
  partial_coverage_total?: number;
  parse_budget_exhausted_total?: number;
  // Heartbeat fields 11-19: script-rule and recovered-panic
  // counters, and analyze latency over the agent's last 5 minutes in
  // microseconds (percentiles omitted when there were no analyses).
  script_incomplete_total?: number;
  script_errors_total?: number;
  script_rules_rejected_total?: number;
  script_runs_in_flight?: number;
  agent_panics_total?: number;
  analyze_latency_p50_us?: number;
  analyze_latency_p95_us?: number;
  analyze_latency_p99_us?: number;
  analyze_latency_samples?: number;
  /** Heartbeat field 20: custom rules dropped at bundle load for an invalid or oversized regex. */
  regex_rules_dropped_total?: number;
  waf_health_updated_at?: string;
  binary_path?: string;
  install_dir?: string;
  service_name?: string;
  service_user?: string;
  host_info?: {
    siem_delivery?: unknown;
    hostname?: string;
    os?: string;
    os_version?: string;
    kernel_name?: string;
    kernel_release?: string;
    arch?: string;
    cpu_count?: number;
    cpu_model?: string;
    memory_total_bytes?: number;
    memory_used_bytes?: number;
    load_avg_1?: number;
    load_avg_5?: number;
    load_avg_15?: number;
    uptime_seconds?: number;
    boot_time?: number;
    agent_version?: string;
    agent_kind?: string;
    distro?: string;
    virt_type?: string;
  };
};

export async function listFleetAgents(opts: { kind?: 'host' | 'waf'; projectId?: string } & PageParams = {}) {
  const params = new URLSearchParams();
  if (opts.kind) params.set('kind', opts.kind);
  if (opts.projectId) params.set('project', opts.projectId);
  const qs = params.toString();
  // count = agents in this response; total = all matching agents.
  return api<{ agents: FleetAgent[]; count: number } & PageMeta>(
    withPage(`/api/fleet/agents${qs ? `?${qs}` : ''}`, opts)
  );
}

export async function registerFleetAgent(projectId: string, name: string, kind: 'host' | 'waf') {
  return api<{ agent: FleetAgent; api_key: string; kind: string }>(
    `/api/projects/${projectId}/agents`,
    {
      method: 'POST',
      body: JSON.stringify({ name, kind }),
    }
  );
}

/**
 * DELETE /api/projects/:id/agents/:agentId, any agent kind of the project;
 * project member or owner. An online agent answers 409 AGENT_ONLINE with
 * `error.hint`; retry with `{ force: true }` after the user confirms.
 */
export async function deleteProjectAgent(projectId: string, agentId: string, opts: { force?: boolean } = {}) {
  const qs = opts.force ? '?force=1' : '';
  return api<{ status: string } & OkResponse>(
    `/api/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(agentId)}${qs}`,
    { method: 'DELETE' }
  );
}

// aq builds an optional agent_id query string suffix: '?agent_id=<id>' or ''
function aq(agentId?: string, hostId?: string): string {
  if (agentId) return `?agent_id=${encodeURIComponent(agentId)}`;
  if (hostId) return `?host_id=${encodeURIComponent(hostId)}`;
  return '';
}
// aqs appends agent_id/host_id to an existing query string (use when URL already has '?...')
function aqs(url: string, agentId?: string, hostId?: string): string {
  if (agentId) return `${url}&agent_id=${encodeURIComponent(agentId)}`;
  if (hostId) return `${url}&host_id=${encodeURIComponent(hostId)}`;
  return url;
}

export async function getEBPFStatus(projectId: string, agentId?: string, hostId?: string) {
  return api<EBPFStatus>(`/api/projects/${projectId}/host/status${aq(agentId, hostId)}`);
}

export async function getEBPFMetrics(projectId: string, agentId?: string, hostId?: string) {
  return api<EBPFMetrics>(`/api/projects/${projectId}/host/metrics${aq(agentId, hostId)}`);
}

export async function getEBPFConfig(projectId: string, agentId?: string, hostId?: string) {
  return api<EBPFFullConfig>(`/api/projects/${projectId}/host/config${aq(agentId, hostId)}`);
}

/** Resolves to the stored configuration. */
export async function updateEBPFConfig(projectId: string, config: EBPFFullConfig, agentId?: string, hostId?: string) {
  return api<EBPFFullConfig>(`/api/projects/${projectId}/host/config${aq(agentId, hostId)}`, {
    method: 'PUT',
    body: JSON.stringify(config),
  });
}

export async function getEBPFBlocklist(projectId: string, limit = 1000, agentId?: string, hostId?: string, offset = 0, signal?: AbortSignal) {
  // count = entries in this response; total = all unexpired entries.
  return api<{ entries: EBPFBlocklistEntry[]; count: number } & PageMeta>(
    aqs(`/api/projects/${projectId}/host/blocklist?limit=${limit}&offset=${offset}`, agentId, hostId),
    { signal }
  );
}

export async function addEBPFBlocklist(projectId: string, entries: EBPFIPListAdd[], agentId?: string, hostId?: string) {
  return api<HostStateMutation>(`/api/projects/${projectId}/host/blocklist${aq(agentId, hostId)}`, {
    method: 'POST',
    body: JSON.stringify({ entries }),
  });
}

export async function deleteEBPFBlocklist(projectId: string, entries: { ip: string }[], agentId?: string, hostId?: string) {
  return api<HostStateMutation>(`/api/projects/${projectId}/host/blocklist${aq(agentId, hostId)}`, {
    method: 'DELETE',
    body: JSON.stringify({ entries }),
  });
}

export async function getEBPFAllowlist(projectId: string, limit = 1000, agentId?: string, hostId?: string, offset = 0, signal?: AbortSignal) {
  // count = entries in this response; total = all unexpired entries.
  // allowlist_ports_supported: the host enforces port-scoped entries.
  return api<{ entries: EBPFAllowlistEntry[]; count: number; allowlist_ports_supported?: boolean } & PageMeta>(
    aqs(`/api/projects/${projectId}/host/allowlist?limit=${limit}&offset=${offset}`, agentId, hostId),
    { signal }
  );
}

export async function addEBPFAllowlist(projectId: string, entries: EBPFIPListAdd[], agentId?: string, hostId?: string) {
  return api<HostStateMutation>(`/api/projects/${projectId}/host/allowlist${aq(agentId, hostId)}`, {
    method: 'POST',
    body: JSON.stringify({ entries }),
  });
}

export async function deleteEBPFAllowlist(projectId: string, entries: { ip: string }[], agentId?: string, hostId?: string) {
  return api<HostStateMutation>(`/api/projects/${projectId}/host/allowlist${aq(agentId, hostId)}`, {
    method: 'DELETE',
    body: JSON.stringify({ entries }),
  });
}

/** Geo policy of a host: `block` drops the listed countries, `allow` drops every country not listed. */
export type EBPFGeoMode = 'block' | 'allow';

export interface EBPFGeoPolicy {
  /** Block list (kept while in allow mode). */
  countries: { code: string; blocked: boolean }[];
  count: number;
  /** Absent on older control planes = block. */
  mode?: EBPFGeoMode;
  /** Allow list, sorted codes (kept while in block mode). */
  allowed_countries?: string[];
  allow_acknowledged?: boolean;
  /** The host agent reported allow-mode support (dataplane + GeoIP database). */
  allow_supported?: boolean;
}

/** PUT body of the geo policy; every field optional, lists are deltas. */
export interface EBPFGeoPolicyUpdate {
  countries?: { code: string; blocked: boolean }[];
  mode?: EBPFGeoMode;
  allowed_countries?: { code: string; allowed: boolean }[];
  /** Required when the result is allow mode and the request switches to it or removes an allowed country. */
  allow_acknowledged?: boolean;
}

export interface EBPFGeoPolicyMutation extends HostStateMutation {
  mode?: EBPFGeoMode;
  allowed_count?: number;
  warnings?: { code: string; message: string }[];
}

export async function getEBPFGeoBlocked(projectId: string, agentId?: string, hostId?: string, signal?: AbortSignal) {
  return api<EBPFGeoPolicy>(`/api/projects/${projectId}/host/geo/blocked${aq(agentId, hostId)}`, { signal });
}

export async function updateEBPFGeoBlocked(projectId: string, countries: { code: string; blocked: boolean }[], agentId?: string, hostId?: string) {
  return api<HostStateMutation>(`/api/projects/${projectId}/host/geo/blocked${aq(agentId, hostId)}`, {
    method: 'PUT',
    body: JSON.stringify({ countries }),
  });
}

export async function updateEBPFGeoPolicy(projectId: string, body: EBPFGeoPolicyUpdate, agentId?: string, hostId?: string) {
  return api<EBPFGeoPolicyMutation>(`/api/projects/${projectId}/host/geo/blocked${aq(agentId, hostId)}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

export async function getEBPFConnections(projectId: string, limit = 100, agentId?: string, hostId?: string, signal?: AbortSignal) {
  return api<{ connections: EBPFConnection[]; count: number }>(
    aqs(`/api/projects/${projectId}/host/connections?limit=${limit}`, agentId, hostId),
    { signal }
  );
}

export async function getEBPFBandwidth(projectId: string, limit = 100, agentId?: string, hostId?: string, signal?: AbortSignal) {
  return api<{ entries: EBPFBandwidthEntry[]; count: number }>(
    aqs(`/api/projects/${projectId}/host/bandwidth?limit=${limit}`, agentId, hostId),
    { signal }
  );
}

export async function getEBPFEvents(projectId: string, limit = 100, agentId?: string, hostId?: string, signal?: AbortSignal) {
  return api<{ events: EBPFEvent[]; count: number }>(
    aqs(`/api/projects/${projectId}/host/events?limit=${limit}`, agentId, hostId),
    { signal }
  );
}

// ── Port Policy (Enterprise ingress/egress port firewall) ──

export interface EBPFPortPolicy {
  port: number;
  proto: string;   // "tcp" | "udp" | "any"
  direction: string; // "ingress" | "egress" | "both"
  action: string;  // "drop" | "log" | "allow"
  ttl_ms?: number;
  hit_count?: number;
  added_at?: string;
  expires_at?: string;
}

export interface EBPFPortPolicyConfig {
  enabled: boolean;
  default_ingress: string; // "allow" | "deny"
  default_egress: string;  // "allow" | "deny"
}

export interface EBPFPortPoliciesSnapshot {
  config: EBPFPortPolicyConfig;
  policies: EBPFPortPolicy[];
  count: number;
}

export async function getEBPFPortPolicies(projectId: string, agentId?: string, hostId?: string, signal?: AbortSignal) {
  return api<EBPFPortPoliciesSnapshot>(`/api/projects/${projectId}/host/port-policies${aq(agentId, hostId)}`, { signal });
}

export async function addEBPFPortPolicy(projectId: string, policy: { port: number; proto: string; direction: string; action: string; ttl_ms?: number }, agentId?: string, hostId?: string) {
  return api<HostStateMutation>(`/api/projects/${projectId}/host/port-policies${aq(agentId, hostId)}`, {
    method: 'POST',
    body: JSON.stringify(policy),
  });
}

export async function deleteEBPFPortPolicy(projectId: string, policy: { port: number; proto: string; direction: string }, agentId?: string, hostId?: string) {
  return api<HostStateMutation>(`/api/projects/${projectId}/host/port-policies${aq(agentId, hostId)}`, {
    method: 'DELETE',
    body: JSON.stringify(policy),
  });
}

/** Resolves to the stored port-policy configuration. */
export async function updateEBPFPortPolicyConfig(projectId: string, config: EBPFPortPolicyConfig, agentId?: string, hostId?: string) {
  return api<EBPFPortPolicyConfig>(`/api/projects/${projectId}/host/port-policies/config${aq(agentId, hostId)}`, {
    method: 'PUT',
    body: JSON.stringify(config),
  });
}

// ── Egress IP Blocklist ──

export async function getEBPFEgressBlocklist(projectId: string, limit = 1000, agentId?: string, hostId?: string, offset = 0, signal?: AbortSignal) {
  return api<{ entries: EBPFBlocklistEntry[]; count: number } & PageMeta>(
    aqs(`/api/projects/${projectId}/host/egress-blocklist?limit=${limit}&offset=${offset}`, agentId, hostId),
    { signal }
  );
}

export async function addEBPFEgressBlocklist(projectId: string, entries: EBPFIPListAdd[], agentId?: string, hostId?: string) {
  return api<HostStateMutation & { added: number }>(`/api/projects/${projectId}/host/egress-blocklist${aq(agentId, hostId)}`, {
    method: 'POST',
    body: JSON.stringify({ entries }),
  });
}

export async function deleteEBPFEgressBlocklist(projectId: string, entries: { ip: string }[], agentId?: string, hostId?: string) {
  return api<HostStateMutation & { removed: number }>(`/api/projects/${projectId}/host/egress-blocklist${aq(agentId, hostId)}`, {
    method: 'DELETE',
    body: JSON.stringify({ entries }),
  });
}

// ── Firewall Top Attacker IPs ──

export async function getFirewallTopIPs(projectId: string, limit = 20, agentId?: string, hostId?: string, range_?: string, signal?: AbortSignal) {
  const base = `/api/projects/${projectId}/host/firewall/top-ips?limit=${limit}${range_ ? `&range=${range_}` : ''}`;
  return api<{ ips: FirewallTopIPRow[]; count: number }>(aqs(base, agentId, hostId), { signal });
}

export interface FirewallDropsSummary {
  blocklist:   number;
  syn_flood:   number;
  rate_limit:  number;
  geo_block:   number;
  port_scan:   number;
  port_policy: number;
  egress:      number;
  other:       number;
}

export interface FirewallAnalyticsCountry {
  code: string;
  name: string;
  count: number;
  pct: number;
}

export interface FirewallAnalyticsAgent {
  id: string;
  name: string;
  online: boolean;
  last_seen: string | null;
  registered_at: string;
}

export interface FirewallAnalytics {
  range: string;
  since: string | null;
  drops_current: FirewallDropsSummary;
  drops_previous: FirewallDropsSummary;
  total_current: number;
  total_previous: number;
  unique_ips: number;
  countries_count: number;
  active_rules: number;
  attack_origins: FirewallAnalyticsCountry[];
  peak_hours: number[];
  agents: FirewallAnalyticsAgent[];
}

export async function getFirewallDropsSummary(projectId: string, range = 'all', agentId?: string, hostId?: string, signal?: AbortSignal) {
  const base = `/api/projects/${projectId}/host/firewall/drops-summary?range=${encodeURIComponent(range)}`;
  return api<{ drops: FirewallDropsSummary }>(aqs(base, agentId, hostId), { signal });
}

export async function getFirewallAnalytics(projectId: string, range: string, agentId?: string, hostId?: string, signal?: AbortSignal) {
  const base = `/api/projects/${projectId}/host/firewall/analytics?range=${encodeURIComponent(range)}`;
  return api<FirewallAnalytics>(aqs(base, agentId, hostId), { signal });
}

// ─── eBPF Runtime security Tracing ─────────────────────────────────────────

export interface TraceEvent {
  parent_comm?: string;
  grandparent_comm?: string;
  is_container?: boolean;
  is_privileged?: boolean;
  container_name?: string;
  container_image?: string;
  container_id?: string;
  k8s_pod?: string;
  k8s_namespace?: string;
  signal_outcome?: 'requested' | 'accepted' | 'failed' | 'expired' | 'unknown';
  event_id?: string;
  process_start_ns?: string;
  signal_error?: number;
  activity_outcome?: 'attempt' | 'success' | 'failure' | 'unknown';
  timestamp: string;
  timestamp_ns: number;
  cgroup_id: number;
  pid: number;
  tid: number;
  ppid: number;
  uid: number;
  gid: number;
  event_type: number;
  event_name: string;
  category: string;
  severity: number;
  severity_name: string;
  comm: string;
  filename?: string;
  args?: string;
  flags?: number;
  ret_val?: number;
  detail?: number;
  port?: number;
  addr_family?: number;
  addr?: string;
  description?: string;
  action: number;
  action_name: string;
  policy_id?: number;
}

export interface TraceStatus {
 ingestion?:IngestionStatus;
  map_sizing?: MapSizing;
 telemetry_delivery?:TelemetryDelivery;
 telemetry_send_failures?:number;
  bundle_status?: EBPFStatus["bundle_status"];
  agent_online?: boolean;
  agent_last_seen?: string;
  expected_probes?: number;
  missing_probes?: Record<string, string>;
  kernel_events_dropped?: number;
  /** Events below MEDIUM the kernel shed to keep ring headroom for MEDIUM+ events while the reader was behind (absent on older agents). */
  kernel_events_shed?: number;
  /** Syscall hooks attached as kprobes because this kernel's syscall tracepoints copy user memory (Linux 6.19+). */
  kprobe_probes?: string[];
  enforcement_dropped?: number;
  /** Events the agent's send queue dropped since it started: queue_dropped_noise + queue_dropped_significant. */
  queue_dropped?: number;
  queue_depth?: number;
  /**
   * Loss accounting by send-queue class (absent on older agents), dropped in this order:
   * noise = observed file/network events below MEDIUM; watched = such accesses of sensitive or policy files;
   * significant = process, security, MEDIUM+ or enforced events. delivery_lost_* = trace events in telemetry
   * batches discarded without a control plane receipt. *_watched is absent on agents before the watched class.
   */
  queue_dropped_noise?: number;
  queue_dropped_watched?: number;
  queue_dropped_significant?: number;
  delivery_lost_noise?: number;
  delivery_lost_watched?: number;
  delivery_lost_significant?: number;
  /** Window of the recent_lost_* counts in seconds (3600). Kernel loss counts as significant. */
  loss_window_sec?: number;
  recent_lost_noise?: number;
  recent_lost_watched?: number;
  recent_lost_significant?: number;
  /** Last time the agent observed any loss (UTC ISO 8601); "" = none since it started. */
  last_loss_at?: string;
  userspace_kill_supported?: boolean;
  running: boolean;
  probes: number;
  probe_names: string[];
  events_total: number;
  events_dropped: number;
  uptime_ms: number;
  ringbuf_size_mb: number;
  enforcement: boolean;
  policies_total: number;
  /** The loaded object has trace_protected_tgids (kernel kill paths skip protected processes). */
  protected_kernel_set?: boolean;
  /** Processes currently in trace_protected_tgids. */
  protected_tgids?: number;
  /** Forked children of protected processes the kernel did not insert since load; omitted when 0. */
  protected_fork_refused?: number;
  /** Kill-candidate priority ring is read; counters below are absent on older agents. */
  priority_ring?: boolean;
  priority_events_routed?: number;
  priority_events_full?: number;
  priority_events_lost?: number;
  /** Trace forwarding filter: off | active | too_large | revision_mismatch | invalid; absent on older agents. */
  forward_filter?: 'off' | 'active' | 'too_large' | 'revision_mismatch' | 'invalid' | (string & {});
  forward_filter_digest?: string;
  /** Events the filter kept on the host since the agent started: dropped by a suppress rule … */
  forward_filtered_suppressed?: number;
  /** … or matching no stage and not stored by ingest. */
  forward_filtered_unstored?: number;
  /** The BPF-LSM programs are attached. False while tracing is stopped, so only `lsm_state` says why. */
  lsm_active?: boolean;
  /** BPF-LSM state of the agent: active | kernel_lacks_bpf | unverified | disabled | failed; absent on older agents and while tracing is stopped. */
  lsm_state?: 'active' | 'kernel_lacks_bpf' | 'unverified' | 'disabled' | 'failed' | (string & {});
}

export interface TraceConfig {
  enabled: boolean;
  event_types: string[];
  min_severity: string;
  filter_self: boolean;
  filtered_pids: number[];
}

export interface TraceStats {
  total_events: number;
  event_counts: Record<string, number>;
  by_severity: Record<string, number>;
  by_category: Record<string, number>;
  buffer_used: number;
  buffer_total: number;
  uptime_ms: number;
}

export interface TraceEventTypeInfo {
  id: number;
  name: string;
  category: string;
  description: string;
}

export async function getTraceStatus(projectId: string, agentId?: string, hostId?: string) {
  return api<TraceStatus>(`/api/projects/${projectId}/host/trace/status${aq(agentId, hostId)}`);
}

export async function getTraceConfig(projectId: string, agentId?: string, hostId?: string) {
  return api<TraceConfig>(`/api/projects/${projectId}/host/trace/config${aq(agentId, hostId)}`);
}

/** Resolves to the stored trace configuration. */
export async function updateTraceConfig(projectId: string, config: Partial<TraceConfig>, agentId?: string, hostId?: string) {
  return api<TraceConfig>(`/api/projects/${projectId}/host/trace/config${aq(agentId, hostId)}`, {
    method: 'PUT',
    body: JSON.stringify(config),
  });
}

export async function getTraceEvents(projectId: string, limit = 200, minSeverity?: string, agentId?: string, hostId?: string, sinceMinutes?: number) {
  let url = aqs(`/api/projects/${projectId}/host/trace/events?limit=${limit}`, agentId, hostId);
  if (minSeverity) url += `&min_severity=${minSeverity}`;
  if (sinceMinutes && sinceMinutes > 0) url += `&since_minutes=${sinceMinutes}`;
  return api<TraceEvent[]>(url);
}

export async function getTraceStats(projectId: string, agentId?: string, hostId?: string) {
  return api<TraceStats>(`/api/projects/${projectId}/host/trace/stats${aq(agentId, hostId)}`);
}

export async function getTraceEventTypes(projectId: string, agentId?: string, hostId?: string) {
  return api<TraceEventTypeInfo[]>(`/api/projects/${projectId}/host/trace/types${aq(agentId, hostId)}`);
}

// ─── Project-wide aggregate endpoints ─────────────────────────────────────

export interface HostAgentSummary {
  id: string;
  name: string;
  online: boolean;
  firewall_running: boolean;
  firewall_capable: boolean;
  trace_running: boolean;
  trace_capable: boolean;
  last_seen?: string;
}

export interface HostAggregateStatus {
  total_agents: number;
  agents_online: number;
  firewall_running: number;
  firewall_capable: number;
  trace_running: number;
  trace_capable: number;
  agents: HostAgentSummary[];
}

// ─── eBPF Enforcement Policies ─────────────────────────────────────────────

/**
 * How a match_comm term compares with the process name: the whole name,
 * a whole word (delimited by a non-letter; default for new policies), or any
 * substring (policies saved before the field existed).
 */
export type CommMatchMode = 'exact' | 'word' | 'substring';

export interface EnforcementPolicy {
  id: number;
  name: string;
  description: string;
  enabled: boolean;
  event_types: string[];
  min_severity: string;
  match_comm: string;
  // Absent from older servers and agents: substring.
  match_comm_mode?: CommMatchMode;
  match_filename: string;
  match_uid: number | null;
  match_dest_port: string;
  match_dest_ip?: string;
  action: string;
  // Required for a kill policy with no narrowing match (comm, filename, uid,
  // dest port, dest IP; UID 0, "/", bare system directories and terms under 3 characters do not
  // narrow); the server rejects such a policy without it.
  kill_acknowledged?: boolean;
  kernel_enforce: boolean;
  kernel_enforce_requested?: boolean;
  auto_downgraded?: boolean;
  enforcement_mode?: 'lsm' | 'kernel' | 'userspace' | 'deferred_outcome' | 'downgraded';
  mitre_technique_id?: string;
  mitre_technique_name?: string;
  mitre_tactic?: string;
  severity?: string;
  tags?: string[];
  created_at: string;
  updated_at: string;
  hit_count: number;
}

export interface EnforcementLogEntry {
  timestamp: string;
  recorded_at: string;
  policy_id: number;
  policy_name: string;
  action: string;
  success: boolean;
  failure_reason?: string;
  mode?: 'lsm' | 'kernel' | 'userspace' | 'deferred_outcome';
  event: TraceEvent;
}

export async function listPolicies(projectId: string, agentId?: string, hostId?: string) {
  return api<EnforcementPolicy[]>(`/api/projects/${projectId}/host/trace/policies${aq(agentId, hostId)}`);
}

export async function createPolicy(projectId: string, policy: Partial<EnforcementPolicy>, agentId?: string, hostId?: string) {
  return api<EnforcementPolicy>(`/api/projects/${projectId}/host/trace/policies${aq(agentId, hostId)}`, {
    method: 'POST',
    body: JSON.stringify(policy),
  });
}

export async function updatePolicy(projectId: string, id: number, policy: Partial<EnforcementPolicy>, agentId?: string, hostId?: string) {
  return api<EnforcementPolicy>(`/api/projects/${projectId}/host/trace/policies/${id}${aq(agentId, hostId)}`, {
    method: 'PUT',
    body: JSON.stringify(policy),
  });
}

export async function deletePolicy(projectId: string, id: number, agentId?: string, hostId?: string) {
  return api<{ status: string; policy_id: number }>(`/api/projects/${projectId}/host/trace/policies/${id}${aq(agentId, hostId)}`, {
    method: 'DELETE',
  });
}

export async function getEnforcementLog(projectId: string, limit = 200, agentId?: string, hostId?: string, sinceMinutes?: number, signal?: AbortSignal) {
  let url = aqs(`/api/projects/${projectId}/host/trace/enforcement?limit=${limit}`, agentId, hostId);
  if (sinceMinutes && sinceMinutes > 0) url += `&since_minutes=${sinceMinutes}`;
  return api<EnforcementLogEntry[]>(url, { signal });
}

export async function clearEnforcementLog(projectId: string, agentId?: string, hostId?: string) {
  return api<{ status: string; cleared_at: string }>(`/api/projects/${projectId}/host/trace/enforcement-log${aq(agentId, hostId)}`, {
    method: 'DELETE',
  });
}

// Apps (WAF targets)
//
// An App is a logical WAF target: `host_header → upstream_url` plus a per-app
// WAF Key the WAF agent presents when claiming authority.

export interface ProxyConfig {
  /**
   * Timeouts in milliseconds. Tri-state, mirrored from
   * internal/domain/proxyconfig.go:
   *   0  = unset, the backend default applies
   *  -1  = unlimited, no deadline is imposed
   *  >0  = that many milliseconds
   */
  timeouts?: { connect_ms?: number; upstream_ms?: number; read_ms?: number; write_ms?: number };
  max_body_bytes?: number;
  read_buf?: number;
  write_buf?: number;
  max_conns?: number;
  conn_wait_ms?: number;
  idle_conn_ms?: number;
  host_header?: { mode: 'preserve' | 'upstream' | 'custom'; value?: string };
  req_headers?: { add?: Record<string, string>; remove?: string[] };
  resp_headers?: { add?: Record<string, string>; remove?: string[] };
  /** Read X-Forwarded-For / X-Real-IP from trusted peers; absent or null = false. */
  trust_forwarded?: boolean | null;
  /** Peers allowed to send forwarded headers: IPs or CIDRs, max 64, no /0. Empty = loopback + private ranges. */
  trusted_proxies?: string[] | null;
  /** Reject paths with invalid percent-encoding (400); missing/null = true. */
  reject_invalid_path_encoding?: boolean | null;
  /** Keys added by newer control planes (e.g. trusted_proxies) pass through untouched. */
  [key: string]: unknown;
}

/** Derived warning about an app's client-IP trust settings; never stored. */
export type ProxyWarningCode = 'TRUSTED_PROXIES_UNSET' | 'TRUSTED_PROXIES_IGNORED';
export interface ProxyWarning {
  code: ProxyWarningCode | (string & {});
  message: string;
}

/** repository.App, routing fields are nullable pointers on the server. */
export interface App {
  id: string;
  project_id: string;
  name: string;
  // WAF-target fields
  upstream_url: string | null;
  listen_host?: string | null;
  listen_port?: number | null;
  proxy_config?: ProxyConfig;
  /** Present when proxy_config needs attention. */
  proxy_warnings?: ProxyWarning[];
  /** Viewer reads: proxy_config header values and upstream userinfo were blanked. */
  secrets_redacted?: boolean;
  /** With secrets_redacted: whether any proxy header value is configured. */
  proxy_header_values_set?: boolean;
  /** FastCGI upstream settings ('' when unused; absent from older control planes). */
  fcgi_doc_root?: string;
  fcgi_index?: string;
  /** Maintenance mode is on: the serving agent answers with the maintenance page (absent from older control planes). */
  maintenance_enabled?: boolean;
  created_at: string;
  updated_at: string;
}

/** PUT …/apps/:appId (handlers/apps.go updateAppBody); omitted fields keep their value. */
export interface AppUpdateBody {
  name?: string;
  listen_host?: string;
  listen_port?: number;
  upstream_url?: string;
  /** Each FastCGI field is optional and patched on its own: absent keeps the stored value; an empty fcgi_index means index.php. */
  fcgi_doc_root?: string;
  fcgi_index?: string;
  proxy_config?: ProxyConfig;
}

export async function listApps(projectId: string, page?: PageParams) {
  return api<{ apps: App[] } & PageMeta>(withPage(`/api/projects/${projectId}/apps`, page));
}

export async function getApp(projectId: string, appId: string) {
  return api<{ app: App }>(`/api/projects/${projectId}/apps/${appId}`);
}

export async function createApp(projectId: string, body: Partial<App>) {
  return api<{ app: App }>(`/api/projects/${projectId}/apps`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function updateApp(projectId: string, appId: string, body: AppUpdateBody) {
  return api<{ app: App }>(`/api/projects/${projectId}/apps/${appId}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

export async function deleteApp(projectId: string, appId: string) {
  return api<{ deleted: boolean }>(`/api/projects/${projectId}/apps/${appId}`, {
    method: 'DELETE',
  });
}

// ── Maintenance mode (per application) ──────────────────────────────────

/** domain.Maintenance: what the serving WAF agent answers with while `enabled`. */
export interface Maintenance {
  enabled: boolean;
  /** Plain text; '' shows the default message. At most 500 characters. */
  message: string;
  /** '' or YYYY-MM-DDTHH:MM:SSZ (UTC). Shown to visitors and sent as Retry-After; maintenance never ends by itself. */
  end_time: string;
  /** Replaces the standard page for browsers; '' keeps the standard page. At most 65,536 bytes. */
  custom_html: string;
  /** IP addresses and CIDR ranges that still reach the site. */
  allow_ips: string[];
  /** Paths (and everything below them) that still reach the site. */
  allow_paths: string[];
  /** Set by the server when maintenance goes on; '' while off. */
  started_at: string;
}

/** PUT body: the whole object, `started_at` is set by the server. */
export type MaintenanceBody = Omit<Maintenance, 'started_at'>;

/** Answer of GET and PUT …/apps/:appId/maintenance. */
export interface MaintenanceState {
  maintenance: Maintenance;
  /** The serving agent reports maintenance mode: false = it does not, null = no agent or it never said. */
  agent_supported: boolean | null;
  /** The caller's address as the control plane sees it. */
  client_ip: string;
  default_message: string;
  stock_html: string;
}

const hasMaintenance = (body: unknown): boolean => {
  const value = (body as { maintenance?: unknown } | null)?.maintenance;
  return value !== null && typeof value === 'object';
};

export async function getAppMaintenance(projectId: string, appId: string) {
  return api<MaintenanceState>(`/api/projects/${projectId}/apps/${appId}/maintenance`, {}, hasMaintenance);
}

export async function putAppMaintenance(projectId: string, appId: string, body: MaintenanceBody) {
  return api<MaintenanceState>(
    `/api/projects/${projectId}/apps/${appId}/maintenance`,
    { method: 'PUT', body: JSON.stringify(body) },
    hasMaintenance
  );
}

// ── WAF agent fleet (per-app) ─────────────────────────────────────────────

export interface AppWAFAssignment {
  agent_id: string;
  mode: 'block' | 'monitor';
  /** The serving agent can run script rules: false = it cannot, null or absent = unknown. */
  script_rules?: boolean | null;
}

/** App summary: the shared KPI block. */
export type AppWAFSummary = WAFSummary;

/** Row of the app decision feed. */
export type AppWAFDecision = WAFDecisionRow;

export async function getAppWAFAgent(projectId: string, appId: string) {
  return api<AppWAFAssignment>(`/api/projects/${projectId}/apps/${appId}/waf-agent`);
}

export async function assignAppWAFAgent(
  projectId: string,
  appId: string,
  agentId: string,
  mode: 'block' | 'monitor' = 'block'
) {
  return api<{ agent_id: string; app_id: string; mode: string }>(
    `/api/projects/${projectId}/apps/${appId}/waf-agent`,
    {
      method: 'PUT',
      body: JSON.stringify({ agent_id: agentId, mode }),
    }
  );
}

export async function unassignAppWAFAgent(projectId: string, appId: string) {
  return api<void>(`/api/projects/${projectId}/apps/${appId}/waf-agent`, {
    method: 'DELETE',
  });
}

export async function getAppWAFSummary(
  projectId: string,
  appId: string,
  minutes = 60
) {
  return api<AppWAFSummary>(
    `/api/projects/${projectId}/apps/${appId}/waf/summary?minutes=${minutes}`
  );
}

/** Query of the app decision feed. */
export interface AppWAFDecisionsQuery {
  /** RFC 3339 window start (inclusive); server default to_ts − 24 h; window ≤ 30 days. */
  from_ts?: string;
  /** RFC 3339 window end (exclusive); server default now. */
  to_ts?: string;
  /** Opaque keyset token from the previous page's next_cursor. */
  cursor?: string;
  action?: string;
  source?: '' | 'http' | 'ws';
  /** Exact client address (single IPv4/IPv6). */
  ip?: string;
  q?: string;
  method?: string;
  category?: string;
  /** 1–200 (default 50). */
  limit?: number;
  /** Legacy paging; not combined with cursor. */
  offset?: number;
}

/** Response of the app decision feed: newest first inside [from_ts, to_ts). */
export interface AppWAFDecisionsPage {
  decisions: AppWAFDecision[];
  /** Matching rows in the window, capped at 10000 (see total_capped). */
  total: number;
  total_capped: boolean;
  /** Token of the next (older) page; null on the last page. */
  next_cursor: string | null;
  limit: number;
  offset: number;
  from_ts: string;
  to_ts: string;
}

export function appWAFDecisionsQueryString(opts: AppWAFDecisionsQuery): string {
  const params = new URLSearchParams();
  if (opts.from_ts) params.set('from_ts', opts.from_ts);
  if (opts.to_ts) params.set('to_ts', opts.to_ts);
  if (opts.cursor) params.set('cursor', opts.cursor);
  if (opts.action) params.set('action', opts.action);
  if (opts.source) params.set('source', opts.source);
  if (opts.ip) params.set('ip', opts.ip);
  if (opts.q) params.set('q', opts.q);
  if (opts.method) params.set('method', opts.method);
  if (opts.category) params.set('category', opts.category);
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.offset && !opts.cursor) params.set('offset', String(opts.offset));
  return params.toString();
}

export async function getAppWAFDecisions(projectId: string, appId: string, opts: AppWAFDecisionsQuery = {}) {
  const qs = appWAFDecisionsQueryString(opts);
  return api<AppWAFDecisionsPage>(
    `/api/projects/${projectId}/apps/${appId}/waf/decisions${qs ? '?' + qs : ''}`
  );
}

// ── Per-app Overview dashboard (timeline + top-N panels) ─────────────────

export async function getAppWAFTimeline(
  projectId: string,
  appId: string,
  params?: { minutes?: number; bucket_seconds?: number }
) {
  const q = new URLSearchParams();
  q.set('minutes', String(params?.minutes ?? 60));
  if (params?.bucket_seconds != null)
    q.set('bucket_seconds', String(params.bucket_seconds));
  return api<{ buckets: WAFEventTimelineBucket[] }>(
    `/api/projects/${projectId}/apps/${appId}/waf-events/timeline?${q.toString()}`
  );
}

export async function getAppWAFTop(
  projectId: string,
  appId: string,
  dimension: 'ips' | 'uris' | 'categories' | 'user_agents',
  params?: { minutes?: number; limit?: number; scope?: 'attackers' | 'all' }
) {
  const q = new URLSearchParams();
  q.set('minutes', String(params?.minutes ?? 60));
  q.set('limit', String(params?.limit ?? 10));
  if (params?.scope) q.set('scope', params.scope);
  return api<{ dimension: string; rows: WAFEventTopRow[] }>(
    `/api/projects/${projectId}/apps/${appId}/waf-events/top/${dimension}?${q.toString()}`
  );
}

// ── Hosts (Pro/Enterprise self-hosted agents) ─────────────────────────────
//
// A Host is the customer-side machine running `wafio-ebpf-agent` +
// (optionally) one or more `wafio-waf-agent` processes. Keys are issued
// once; the server never stores the plain secret.

export async function getAppWAFGeo(
  projectId: string,
  appId: string,
  params?: { from_ts?: number; to_ts?: number; limit?: number }
) {
  const q = new URLSearchParams();
  if (params?.from_ts != null) q.set('from_ts', String(params.from_ts));
  if (params?.to_ts != null) q.set('to_ts', String(params.to_ts));
  if (params?.limit != null) q.set('limit', String(params.limit));
  const qs = q.toString();
  return api<{
    locations: GeoLocation[];
    total_requests: number;
    total_locations: number;
  }>(`/api/projects/${projectId}/apps/${appId}/waf-events/geo${qs ? '?' + qs : ''}`);
}

/** repository.Host, omitempty fields are optional. */
export interface Host {
  id: string;
  project_id: string;
  user_id: string;
  name: string;
  labels?: Record<string, string>;
  status: 'pending' | 'online' | 'offline' | 'revoked';
  host_key_prefix: string;
  host_info?: Record<string, unknown> | null;
  host_os?: string;
  host_os_version?: string;
  host_kernel?: string;
  host_arch?: string;
  host_cpu_count?: number;
  host_memory?: number;
  host_virt?: string;
  host_boot_time?: string;
  last_seen?: string | null;
  created_at: string;
  revoked_at?: string | null;
  /** End of the host key's enrollment window (UTC); null/absent = closed or never opened. */
  enroll_expires_at?: string | null;
}

export async function listHosts(projectId: string, page?: PageParams) {
  return api<{ hosts: Host[] } & PageMeta>(withPage(`/api/projects/${projectId}/hosts`, page));
}

export async function getHost(projectId: string, hostId: string) {
  return api<{ host: Host }>(`/api/projects/${projectId}/hosts/${hostId}`);
}

export async function createHost(
  projectId: string,
  body: { name: string; labels?: Record<string, string> }
) {
  return api<{ host: Host; host_key: string; warning: string; enroll_expires_at?: string | null }>(
    `/api/projects/${projectId}/hosts`,
    { method: 'POST', body: JSON.stringify(body) }
  );
}

export async function rotateHostKey(projectId: string, hostId: string) {
  return api<{ host_key: string; warning: string; enroll_expires_at?: string | null }>(
    `/api/projects/${projectId}/hosts/${hostId}/rotate-key`,
    { method: 'POST' }
  );
}

export async function revokeHost(projectId: string, hostId: string) {
  // credentials_revoked: host-bound (enrolled) credentials revoked with the host.
  return api<{ revoked: boolean; credentials_revoked?: number }>(
    `/api/projects/${projectId}/hosts/${hostId}/revoke`,
    { method: 'POST' }
  );
}

export async function deleteHost(projectId: string, hostId: string) {
  return api<{ deleted: boolean; credentials_revoked?: number }>(
    `/api/projects/${projectId}/hosts/${hostId}`,
    { method: 'DELETE' }
  );
}

export async function listHostAgents(projectId: string, hostId: string, page?: PageParams) {
  return api<{ agents: FleetAgent[] } & PageMeta>(
    withPage(`/api/projects/${projectId}/hosts/${hostId}/agents`, page)
  );
}

// ─── Host fleet ─────────────────────

export type FleetFirewallState = 'enforce' | 'monitor' | 'off' | 'not_running' | 'no_agent' | 'unknown';
export type FleetRuntimeState = 'on' | 'off' | 'no_agent' | 'unknown';
export type FleetAttention =
  | 'host_offline'
  | 'no_host_agent'
  | 'host_agent_offline'
  | 'firewall_not_running'
  | 'firewall_degraded'
  | 'incidents_critical'
  | 'incidents_high'
  | 'agent_outdated';

export interface FleetAgentRef {
  id: string;
  name: string;
  version: string | null;
  online: boolean;
  last_seen?: string | null;
  /** null: either version is unparseable (`dev`, empty). */
  outdated: boolean | null;
}

export interface HostProtection {
  firewall: {
    state: FleetFirewallState;
    attached: boolean;
    xdp_mode: string | null;
    features: string[];
    degraded: boolean;
    degraded_reasons: string[];
    reported_at: string | null;
  };
  runtime: {
    state: FleetRuntimeState;
    enforcing_policies: number;
    enabled_policies: number;
    missing_probes: number;
    reported_at: string | null;
  };
  incidents: { open_critical: number; open_high: number; acknowledged: number };
  agents: {
    host: FleetAgentRef | null;
    waf: {
      count: number;
      online: number;
      oldest_version: string | null;
      outdated: boolean | null;
      agents: Omit<FleetAgentRef, 'last_seen' | 'outdated'>[];
    };
  };
  attention: FleetAttention[];
}

/** One row of GET /hosts/fleet; field names match `Host` so $lib/host-nav works on it. */
export interface FleetHost {
  id: string;
  name: string;
  labels: Record<string, string>;
  status: Host['status'];
  host_key_prefix: string;
  hostname: string;
  host_os: string;
  host_os_version: string;
  host_kernel: string;
  host_arch: string;
  last_seen: string | null;
  created_at: string;
  revoked_at: string | null;
  protection: HostProtection;
}

export interface HostFleetPage extends PageMeta {
  hosts: FleetHost[];
  control_plane_version: string;
  unlinked_host_agents: number;
  generated_at: string;
}

export type HostTargets = { host_ids: string[] } | { label: { key: string; value: string } };

export type FirewallApplyOp =
  | 'blocklist.add'
  | 'blocklist.remove'
  | 'allowlist.add'
  | 'allowlist.remove'
  | 'egress_blocklist.add'
  | 'egress_blocklist.remove'
  | 'port_policies.add'
  | 'port_policies.remove';

export type HostApplyStatus = 'applied' | 'would_apply' | 'unchanged' | 'failed' | 'skipped';

export interface HostApplyResult {
  host_id: string;
  host_name: string;
  agent_id?: string;
  agent_online?: boolean;
  status: HostApplyStatus;
  code: string;
  error: string;
  warnings?: { code: string; message: string }[];
  count?: number;
  created?: number;
  replaced?: number;
  existing?: number;
}

export interface HostApplyResponse {
  apply_id: string | null;
  op: string;
  dry_run: boolean;
  results: HostApplyResult[];
  summary: Record<HostApplyStatus, number>;
  total: number;
  /** Copy from a source host: digest of the source items read (dry run and apply).
   *  Send it back with the real apply; 409 `SOURCE_CHANGED` when the source changed since. */
  source_digest?: string;
}

/** Item of a firewall apply: an IP-list entry (add carries ttl/ports) or a port rule. */
export interface FirewallApplyEntry { ip: string; ttl_ms?: number; ports?: EBPFPortScope[] }
export interface FirewallApplyPortPolicy { port: number; proto: string; direction: string; action?: string; ttl_ms?: number }

export interface FirewallApplyBody {
  targets: HostTargets;
  op: FirewallApplyOp;
  entries?: FirewallApplyEntry[];
  policies?: FirewallApplyPortPolicy[];
  dry_run?: boolean;
}

export type CopyConflict = 'skip' | 'replace';

export interface TracePoliciesApplyBody {
  targets: HostTargets;
  source?: { host_id: string; policy_ids: number[] };
  policies?: Partial<EnforcementPolicy>[];
  on_conflict?: CopyConflict;
  dry_run?: boolean;
  /** `source_digest` of the dry run this apply was previewed with. */
  source_digest?: string;
}

export interface DetectionRulesApplyBody {
  targets: HostTargets;
  source?: { host_id: string; rule_ids: string[] };
  rules?: Omit<CreateDetectionRuleBody, 'host_id'>[];
  on_conflict?: CopyConflict;
  dry_run?: boolean;
  /** `source_digest` of the dry run this apply was previewed with. */
  source_digest?: string;
}

export interface AgentConnectInfo {
  /** null when the control plane has no server.grpc_domain. */
  grpc_endpoint: string | null;
  grpc_server_name: string;
  grpc_domain_configured: boolean;
  /** null = no agent CA yet: one-command enrollment is not available. */
  ca_sha256: string | null;
  control_plane_version: string;
  /** Host-key enrollment limits; absent on servers older than enrollment. */
  enrollment?: AgentEnrollmentLimits;
}

export interface AgentEnrollmentLimits {
  /** Hours a host key can enroll after the host is created or its key rotated. */
  window_hours: number;
  /** Active enrolled credentials per host (one per agent name). */
  max_credentials_per_host: number;
  /** Validity of an enrolled certificate. */
  cert_validity_days: number;
}

/** GET /hosts/fleet, one page of fleet rows (limit ≤ 100); `hostId` narrows to one host. */
export async function listHostFleet(projectId: string, page?: PageParams, hostId?: string) {
  const path = hostId ? `/api/projects/${projectId}/hosts/fleet?host_id=${encodeURIComponent(hostId)}` : `/api/projects/${projectId}/hosts/fleet`;
  return api<HostFleetPage>(withPage(path, page));
}

/** POST /hosts/labels, all or nothing; one audit row per changed host. */
export async function updateHostLabels(projectId: string, body: { host_ids: string[]; set?: Record<string, string>; remove?: string[] }) {
  return api<{ ok: boolean; updated: number; unchanged: number; hosts: { id: string; name: string; labels: Record<string, string> }[] }>(
    `/api/projects/${projectId}/hosts/labels`,
    { method: 'POST', body: JSON.stringify(body) }
  );
}

/** POST /hosts/apply/firewall, 200 with one result per host (also when every host failed). */
export async function applyFirewallToHosts(projectId: string, body: FirewallApplyBody) {
  return api<HostApplyResponse>(`/api/projects/${projectId}/hosts/apply/firewall`, { method: 'POST', body: JSON.stringify(body) });
}

/** POST /hosts/apply/trace-policies, copy from a source host or inline bodies. */
export async function applyTracePoliciesToHosts(projectId: string, body: TracePoliciesApplyBody) {
  return api<HostApplyResponse>(`/api/projects/${projectId}/hosts/apply/trace-policies`, { method: 'POST', body: JSON.stringify(body) });
}

/** POST /hosts/apply/detection-rules, copy from a source host or inline bodies. */
export async function applyDetectionRulesToHosts(projectId: string, body: DetectionRulesApplyBody) {
  return api<HostApplyResponse>(`/api/projects/${projectId}/hosts/apply/detection-rules`, { method: 'POST', body: JSON.stringify(body) });
}

/** GET /agent-connect-info, values the host-agent installer asks for. */
export async function getAgentConnectInfo(projectId: string) {
  return api<AgentConnectInfo>(`/api/projects/${projectId}/agent-connect-info`);
}

// Instant SSH Setup was removed. It dialled an arbitrary host and port from
// the control plane and carried SSH credentials through the API. Install
// agents on the target host with deploy/install-host-agent.sh or
// deploy/install-waf-agent.sh of wafio-release.

export async function getAgent(agentId: string) {
  return api<FleetAgent>(`/api/fleet/agents/${agentId}`);
}

export interface AgentComponentInfo {
  exists: boolean;
  path: string;
  size_bytes: number;
  modified_at: string;
}

export interface AgentSecurityDataStatus {
  /** Absent when the control plane cannot see agent reports. */
  agent_name?: string;
  credential_id?: string;
  components: Record<string, AgentComponentInfo>;
  online: boolean;
}

export async function getAgentSecurityData(projectId: string, agentId: string) {
  return api<AgentSecurityDataStatus>(
    `/api/projects/${projectId}/agents/${agentId}/security-data`
  );
}
// ── Per-application WAF config (rules_json per app) ───────────────────────

/** Where GET …/routes/:appId/config found the rules. */
export type AppConfigSource = 'app' | 'project' | 'default';

export interface AppConfigResponse extends ConfigSecretFlags {
  rules_json: unknown;
  config_revision: number;
  /** 0 unless the app has its own config. */
  generation: number;
  /** Present when source is "app". */
  updated_at?: string;
  source: AppConfigSource;
}

export async function getAppConfig(projectId: string, agentId: string, appId: string) {
  return api<AppConfigResponse>(
    `/api/projects/${projectId}/agents/${agentId}/routes/${appId}/config`
  );
}

export async function putAppConfig(
  projectId: string,
  agentId: string,
  appId: string,
  body: { rules_json: unknown; expected_revision: number },
) {
  return api<{ ok: boolean; config_revision: number }>(
    `/api/projects/${projectId}/agents/${agentId}/routes/${appId}/config`,
    { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  );
}

// ── Audit log ─────────────────────────────────────────────────────────────

/** repository.AuditEvent as GET /projects/:id/audit-log returns it; omitempty fields are optional. */
export interface AuditLogEvent {
  id: string;
  project_id: string;
  actor_user_id?: string;
  actor_name?: string;
  actor_email?: string;
  action: string;
  target_type: string;
  target_id?: string;
  target_name?: string;
  ip?: string;
  user_agent?: string;
  metadata?: Record<string, unknown>;
  created_at: string;
}

/** limit/offset and the older page/per_page describe the same window. */
export interface AuditLogPage { events: AuditLogEvent[]; total: number; limit: number; offset: number; page: number; per_page: number }

function auditLogQuery(opts: { action?: string; page?: number; per_page?: number } & PageParams): string {
  const params = new URLSearchParams();
  if (opts.action) params.set('action', opts.action);
  // limit/offset win over page/per_page on the server when both are sent.
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts.offset !== undefined) params.set('offset', String(opts.offset));
  if (opts.page) params.set('page', String(opts.page));
  if (opts.per_page) params.set('per_page', String(opts.per_page));
  const qs = params.toString();
  return qs ? '?' + qs : '';
}

/** Project audit log, typed as the handler answers (string ids, optional fields). */
export async function listProjectAuditEvents(
  projectId: string,
  opts: { action?: string; page?: number; per_page?: number } & PageParams = {}
) {
  return api<AuditLogPage>(`/api/projects/${projectId}/audit-log${auditLogQuery(opts)}`);
}

// ── Agent Inline-Proxy Routes (WAF Agent → route management) ─────────────
//
// A "route" is an (app + waf_agent_apps binding) created and managed from
// the WAF Agent page. Creating a route creates the underlying app record AND
// immediately assigns it to the agent. Deleting a route removes both.

/** repository.AgentRouteRow. */
export interface AgentRoute {
  app_id: string;
  name: string;
  listen_host: string;
  listen_port: number;
  upstream: string;
  mode: 'block' | 'monitor';
  /** Read-only; the server reports the effective request body limit. */
  body_limit_bytes?: number;
  fcgi_doc_root?: string;
  fcgi_index?: string;
  // Per-app reverse-proxy config (migration 000061).
  proxy_config?: ProxyConfig;
  /** Read-only: present when proxy_config needs attention. */
  proxy_warnings?: ProxyWarning[];
  /** Read-only, viewer reads: header values and upstream userinfo were blanked. */
  secrets_redacted?: boolean;
  proxy_header_values_set?: boolean;
  /** Read-only: maintenance mode is on for this application (absent from older control planes). */
  maintenance_enabled?: boolean;
}

/** Writable route fields (handlers/waf_agent.go agentRouteBody). */
export type AgentRouteBody = Omit<AgentRoute, 'app_id' | 'body_limit_bytes' | 'proxy_warnings' | 'secrets_redacted' | 'proxy_header_values_set' | 'maintenance_enabled'>;

export async function listAgentRoutes(projectId: string, agentId: string, page?: PageParams) {
  return api<{ routes: AgentRoute[] } & PageMeta>(
    withPage(`/api/projects/${projectId}/agents/${agentId}/routes`, page)
  );
}

export async function createAgentRoute(
  projectId: string,
  agentId: string,
  body: AgentRouteBody
) {
  return api<{ route: AgentRoute }>(
    `/api/projects/${projectId}/agents/${agentId}/routes`,
    { method: 'POST', body: JSON.stringify(body) }
  );
}

export async function updateAgentRoute(
  projectId: string,
  agentId: string,
  appId: string,
  body: Partial<AgentRouteBody>
) {
  return api<{ ok: boolean }>(
    `/api/projects/${projectId}/agents/${agentId}/routes/${appId}`,
    { method: 'PUT', body: JSON.stringify(body) }
  );
}

// ─── Agent mTLS credentials (mTLS Agent page) ──────────────────────────────
export interface AgentMTLSCredential {
  id: string;
  name: string;
  fingerprint: string;
  created_at: string;
  valid_until?: string;
  expired?: boolean;
  expiring?: boolean;
  /** Host-bound (enrolled) credentials only: the host and the one agent it may register. */
  host_id?: string;
  host_name?: string;
  agent_kind?: 'host' | 'waf';
  agent_name?: string;
}

export interface AgentMTLSProvisionResponse {
  id: string;
  name: string;
  ca_cert: string;
  client_cert: string;
  client_key: string;
  fingerprint: string;
  /** Suggested --server address; omitted when the server has none configured. */
  server_hint?: string;
  created_at: string;
  valid_until: string;
}

export async function listAgentMTLSCredentials(projectId: string, page?: PageParams) {
  return api<{ credentials: AgentMTLSCredential[] } & PageMeta>(
    withPage(`/api/projects/${projectId}/agent-grpc-credentials`, page)
  );
}

export async function provisionAgentMTLSCredential(projectId: string, name: string, validityDays?: number) {
  return api<AgentMTLSProvisionResponse>(
    `/api/projects/${projectId}/agent-grpc-credentials`,
    { method: 'POST', body: JSON.stringify({ name, validity_days: validityDays }) },stringFields('client_cert','client_key','ca_cert','fingerprint','valid_until')
  );
}

/** 204 No Content: success resolves to `{ data: undefined }` without an error. */
export async function revokeAgentMTLSCredential(projectId: string, credId: string) {
  return api<void>(
    `/api/projects/${projectId}/agent-grpc-credentials/${credId}`,
    { method: 'DELETE' }
  );
}

// ── Block Window ──────────────────────────────────────────────────────────

export interface UnblockOperation {
 command_id:string; status: 'pending'|'applied'|'failed'|'timeout'|'superseded'; error?:string; expires_at:string;
}

export interface BlockWindowEntry {
  unblock?: UnblockOperation;
  id: string;
  key: string;
  key_type: string;
  reason: string;
  path: string;
  expires_at: string;
  blocked_at: string;
}

export async function listBlockWindow(projectId: string, agentId: string) {
  return api<{ entries: BlockWindowEntry[] }>(
    `/api/projects/${projectId}/agents/${agentId}/block-window`
  );
}

export async function deleteBlockWindowEntry(
  projectId: string,
  agentId: string,
  entryId: string
) {
  return api<UnblockOperation>(
    `/api/projects/${projectId}/agents/${agentId}/block-window/${entryId}`,
    { method: 'DELETE' }
  );
}

// ── Admin: User Management ─────────────────────────────────────────────────

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: string;
  created_at: string;
}

export function adminListUsers(limit = 100, offset = 0) {
  return api<{ users: AdminUser[]; total: number }>(
    `/api/admin/users?limit=${limit}&offset=${offset}`
  );
}

export function adminCreateUser(data: { email: string; name: string; password: string; role: string }) {
  return api<AdminUser>('/api/admin/users', { method: 'POST', json: data },stringFields('id','email','role'));
}

export function adminUpdateUser(userId: string, data: { name?: string; role?: string }) {
  return api<AdminUser>(`/api/admin/users/${userId}`, { method: 'PUT', json: data });
}

export function adminDeleteUser(userId: string) {
  return api<{ ok: boolean }>(`/api/admin/users/${userId}`, { method: 'DELETE' });
}

export function adminResetPassword(userId: string, password: string) {
  return api<{ ok: boolean }>(`/api/admin/users/${userId}/reset-password`, {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
}

// ── Admin: Invite Tokens ───────────────────────────────────────────────────

/**
 * An invite as the invite endpoints return it. Admin list rows carry
 * created_at/created_by/used_at but no invite_url; project list rows and
 * create responses carry invite_url.
 */
export interface InviteToken {
  token: string;
  role?: string;
  email: string;
  invite_url?: string;
  expires_at: string;
  used_at?: string | null;
  created_at?: string;
  created_by?: string;
  project_id?: string;
}

/** POST /admin/invites and POST /projects/:id/members/invite. */
export interface CreatedInvite { token: string; invite_url: string; email: string; expires_at: string }

/** GET /projects/:id/members/invites row. */
export interface ProjectInvite { token: string; email: string; role: string; expires_at: string; invite_url: string }

export function adminListInvites(page?: PageParams) {
  return api<{ invites: InviteToken[] } & PageMeta>(withPage('/api/admin/invites', page));
}

export function adminCreateInvite(email?: string) {
  return api<CreatedInvite>('/api/admin/invites', { method: 'POST', body: JSON.stringify({ email: email ?? '' }) });
}

export function adminDeleteInvite(token: string) {
  return api<OkResponse>(`/api/admin/invites/${encodeURIComponent(token)}`, { method: 'DELETE' });
}

export interface InviteInfo {
  email: string;
  expires_at: string;
  project_id?: string;
  project_name?: string;
  role: string;
  user_exists: boolean;
}

export function getInviteInfo(token: string) {
  return api<InviteInfo>(`/api/invite/${encodeURIComponent(token)}`);
}

export function createProjectInvite(projectId: string, email: string, role: string) {
  return api<CreatedInvite>(
    `/api/projects/${projectId}/members/invite`,
    { method: 'POST', body: JSON.stringify({ email, role }) },stringFields('token','invite_url','expires_at')
  );
}

export function acceptInvite(token: string) {
  return api<{ project_id: string; role: string; ok: boolean }>(
    `/api/invite/${encodeURIComponent(token)}/accept`,
    { method: 'POST' }
  );
}

// ── Project Members ────────────────────────────────────────────────────────

export interface ProjectMember {
  id: string;
  project_id: string;
  user_id: string;
  user_email: string;
  user_name: string;
  role: ProjectRole | string;
  created_at: string;
}

export function listProjectMembers(projectId: string, page?: PageParams) {
  return api<{ members: ProjectMember[] } & PageMeta>(withPage(`/api/projects/${projectId}/members`, page));
}

/** 201 `{"ok": true}`, reload the member list for the new row. */
export function addProjectMember(projectId: string, userId: string, role: string) {
  return api<OkResponse>(`/api/projects/${projectId}/members`, {
    method: 'POST',
    body: JSON.stringify({ user_id: userId, role }),
  });
}

export function updateProjectMemberRole(projectId: string, userId: string, role: string) {
  return api<OkResponse>(`/api/projects/${projectId}/members/${userId}`, {
    method: 'PUT',
    body: JSON.stringify({ role }),
  });
}

export function removeProjectMember(projectId: string, userId: string) {
  return api<OkResponse>(`/api/projects/${projectId}/members/${userId}`, {
    method: 'DELETE',
  });
}

// ── Invite-based Registration ──────────────────────────────────────────────

export function registerWithInvite(data: { token: string; email: string; name: string; password: string }) {
  return api<{ token: string; user: User }>('/api/register/invite', {
    method: 'POST',
    body: JSON.stringify(data),
  }, isAuthSession);
}

// searchUsers (GET /api/users/search) was removed with the endpoint:
// it listed accounts across tenants and had no caller.

// ── Detection Rules (Falco-like rule engine) ────────────────────────

export interface RuleCondition {
  field: string;
  op: string;
  value: string | number | boolean | (string | number | boolean)[];
}

export interface DetectionRule {
  id: string;
  project_id: string;
  name: string;
  description: string;
  enabled: boolean;
  built_in: boolean;
  action: 'suppress' | 'escalate' | 'downgrade' | 'tag';
  conditions: RuleCondition[];
  severity_override?: number;
  priority: number;
  tags: string[];
  hit_count: number;
  last_hit_at?: string;
  created_at: string;
  updated_at: string;
}

export interface CreateDetectionRuleBody {
  host_id: string;
  name: string;
  description?: string;
  enabled?: boolean;
  action: 'suppress' | 'escalate' | 'downgrade' | 'tag';
  conditions: RuleCondition[];
  severity_override?: number;
  priority?: number;
  tags?: string[];
}

export function listDetectionRules(projectId: string, hostId: string, page?: PageParams) {
  return api<{ rules: DetectionRule[] } & PageMeta>(
    withPage(`/api/projects/${projectId}/host/trace/rules?host_id=${encodeURIComponent(hostId)}`, page)
  );
}

export function createDetectionRule(projectId: string, hostId: string, body: Omit<CreateDetectionRuleBody, 'host_id'>) {
  return api<DetectionRule>(`/api/projects/${projectId}/host/trace/rules`, {
    method: 'POST',
    body: JSON.stringify({ ...body, host_id: hostId }),
  });
}

export function updateDetectionRule(projectId: string, hostId: string, ruleId: string, body: Partial<Omit<CreateDetectionRuleBody, 'host_id'>> & { enabled?: boolean }) {
  return api<DetectionRule>(
    `/api/projects/${projectId}/host/trace/rules/${ruleId}?host_id=${encodeURIComponent(hostId)}`,
    { method: 'PUT', body: JSON.stringify(body) }
  );
}

export function toggleDetectionRule(projectId: string, hostId: string, ruleId: string) {
  return api<{ ok: boolean; enabled: boolean }>(
    `/api/projects/${projectId}/host/trace/rules/${ruleId}/toggle?host_id=${encodeURIComponent(hostId)}`,
    { method: 'POST', body: JSON.stringify({}) }
  );
}

export function deleteDetectionRule(projectId: string, hostId: string, ruleId: string) {
  return api<{ ok: boolean }>(
    `/api/projects/${projectId}/host/trace/rules/${ruleId}?host_id=${encodeURIComponent(hostId)}`,
    { method: 'DELETE' }
  );
}

// ─── Correlation Rules (multi-stage attack chains) ─────────────────────────

export interface CorrelationCondition {
  field: string;
  op: string;
  value: unknown;
}

// within/max_span are Go time.Duration values serialized as nanoseconds.
export interface CorrelationStage {
  within?: number;
  conditions: CorrelationCondition[];
}

export interface StoredCorrelationRule {
  id: string;
  project_id: string;
  name: string;
  description: string;
  enabled: boolean;
  built_in: boolean;
  rule: {
    id: string;
    name: string;
    entity: 'process' | 'cgroup';
    max_span: number;
    stages: CorrelationStage[];
  };
  created_at: string;
  updated_at: string;
}

export interface CorrelationRuleBody {
  name: string;
  description?: string;
  enabled?: boolean;
  entity?: string;
  max_span_ms?: number;
  stages: CorrelationStage[];
}

export function listCorrelationRules(projectId: string, page?: PageParams) {
  return api<{ rules: StoredCorrelationRule[] } & PageMeta>(
    withPage(`/api/projects/${projectId}/correlation-rules`, page)
  );
}

export function createCorrelationRule(projectId: string, body: CorrelationRuleBody) {
  return api<StoredCorrelationRule>(`/api/projects/${projectId}/correlation-rules`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function updateCorrelationRule(projectId: string, ruleId: string, body: Partial<CorrelationRuleBody>) {
  return api<StoredCorrelationRule>(`/api/projects/${projectId}/correlation-rules/${ruleId}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

export function deleteCorrelationRule(projectId: string, ruleId: string) {
  return api<{ ok: boolean }>(`/api/projects/${projectId}/correlation-rules/${ruleId}`, {
    method: 'DELETE',
  });
}

// ─── Host Incidents ────────────────────────────────────────────────────────

export interface HostIncident {
  id: string;
  project_id: string;
  agent_id: string;
  technique_id: string;
  tactic: string;
  comm: string;
  severity: number;
  severity_name: string;
  status: 'open' | 'acknowledged' | 'resolved';
  event_count: number;
  first_seen_at: string;
  last_seen_at: string;
  acknowledged_at?: string;
  acknowledged_by?: string;
  resolved_at?: string;
  resolved_by?: string;
  sample_description: string;
}

export interface IncidentStats {
  open: number;
  acknowledged: number;
  open_by_severity: { critical: number; high: number };
  unacknowledged: number;
  mtta_seconds: number | null;
  mttr_seconds: number | null;
}

export function listIncidents(projectId: string, status = '', limit = 50, offset = 0, hostId = '') {
  return api<{ incidents: HostIncident[]; total: number }>(
    `/api/projects/${projectId}/host/incidents?status=${encodeURIComponent(status)}&limit=${limit}&offset=${offset}&host_id=${encodeURIComponent(hostId)}`
  );
}

export function incidentStats(projectId: string, range = '30d', signal?: AbortSignal) {
  return api<IncidentStats>(
    `/api/projects/${projectId}/host/incidents/stats?range=${range}`,
    { signal }
  );
}

/** Longest incident note the server accepts (handlers/incidents.go). */
export const INCIDENT_NOTE_MAX_LENGTH = 500;

function incidentChangeBody(note?: string): string {
  const text = note?.trim() ?? '';
  return JSON.stringify(text ? { note: text.slice(0, INCIDENT_NOTE_MAX_LENGTH) } : {});
}

/** Acknowledges an incident; the optional note is stored in the audit event's metadata. */
export function ackIncident(projectId: string, incidentId: string, note?: string) {
  return api<OkResponse>(
    `/api/projects/${encodeURIComponent(projectId)}/host/incidents/${encodeURIComponent(incidentId)}/ack`,
    { method: 'POST', body: incidentChangeBody(note) }
  );
}

/** Resolves an incident; the optional note is stored in the audit event's metadata. */
export function resolveIncident(projectId: string, incidentId: string, note?: string) {
  return api<OkResponse>(
    `/api/projects/${encodeURIComponent(projectId)}/host/incidents/${encodeURIComponent(incidentId)}/resolve`,
    { method: 'POST', body: incidentChangeBody(note) }
  );
}

// ── WAF Custom rules ──────────────────────────────────────────────────────────

export interface CustomRuleCondition {
  field: string;
  operator: string;
  value: string;
  negate?: boolean;
  case_sensitive?: boolean;
  transforms?: string[];
  body_scope?: 'all' | 'key' | 'value'; // json fields only
}

export interface CustomRuleTuningEffect {
  skip_semantic?: string[]; // engine names or "*"
  /** A stored `crs_only` or `semantic_only` (version 1) is read as `default`; the editor never writes them. */
  scan_mode?: 'default' | 'both' | 'disabled' | 'semantic_only' | 'crs_only';
  /** `log`: a detection that would block is recorded as LOG and the request goes on. */
  action?: 'log';
  /** Version 1 key, read and never written: the control plane turns it into `action` or drops it. */
  weaken?: {
    score_multiplier?: number;
    threshold_delta?: { block?: number; log?: number };
  };
}

export interface CustomRuleTuning {
  scope: { logic: 'and' | 'or'; conditions: CustomRuleCondition[] };
  /** The effect always applies to the whole request. */
  target: { components: string[]; match: 'exact' | 'prefix' | 'regex' | 'any' };
  effect: CustomRuleTuningEffect;
}

export interface CustomRuleDryRunSample {
  method: string;
  path: string;
  query: string;
  ip: string;
  country: string;
  user_agent: string;
  body: string;
  headers: Record<string, string>;
  cookies: Record<string, string>;
  content_type: string;
}

export interface CustomRuleDryRunResult {
  matched: boolean;
  action: string;
  trace?: string[];
}

export type CustomRuleMode = 'gui' | 'script' | 'tuning';

export interface CustomRule {
  id: string;
  app_id: string;
  name: string;
  description: string;
  enabled: boolean;
  priority: number;
  mode: CustomRuleMode;
  conditions: CustomRuleCondition[];
  condition_logic: 'and' | 'or';
  action: 'block' | 'allow' | 'challenge' | 'log';
  script: string;
  tuning?: CustomRuleTuning;
  created_at: string;
  updated_at: string;
  /**
   * Computed per response: why a regex of the rule (condition or
   * tuning target) is invalid or too complex; "" or absent when usable.
   * Agents drop such a rule at bundle load.
   */
  regex_error?: string;
}

export interface CreateCustomRuleBody {
  name: string;
  description?: string;
  enabled?: boolean;
  priority?: number;
  mode: CustomRuleMode;
  conditions?: CustomRuleCondition[];
  condition_logic?: 'and' | 'or';
  action: 'block' | 'allow' | 'challenge' | 'log';
  script?: string;
  tuning?: CustomRuleTuning;
}

export function listCustomRules(projectId: string, appId: string, page?: PageParams) {
  return api<{ rules: CustomRule[] } & PageMeta>(withPage(`/api/projects/${projectId}/apps/${appId}/custom-rules`, page));
}

export function createCustomRule(projectId: string, appId: string, body: CreateCustomRuleBody) {
  return api<CustomRule>(`/api/projects/${projectId}/apps/${appId}/custom-rules`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function updateCustomRule(projectId: string, appId: string, ruleId: string, body: Partial<CreateCustomRuleBody>) {
  return api<CustomRule>(`/api/projects/${projectId}/apps/${appId}/custom-rules/${ruleId}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

export function deleteCustomRule(projectId: string, appId: string, ruleId: string) {
  return api<{ ok: boolean }>(`/api/projects/${projectId}/apps/${appId}/custom-rules/${ruleId}`, {
    method: 'DELETE',
  });
}

export function validateCustomScript(projectId: string, appId: string, script: string) {
  return api<{ ok: boolean; error?: string }>(`/api/projects/${projectId}/apps/${appId}/custom-rules/validate`, {
    method: 'POST',
    body: JSON.stringify({ script }),
  });
}

export function validateCustomGUIRule(
  projectId: string,
  appId: string,
  conditions: CustomRuleCondition[],
  condition_logic: string,
  action: string,
  sample_request?: Record<string, unknown>
) {
  return api<CustomRuleDryRunResult>(
    `/api/projects/${projectId}/apps/${appId}/custom-rules/validate-gui`,
    {
      method: 'POST',
      body: JSON.stringify({ conditions, condition_logic, action, sample_request }),
    }
  );
}

export function validateTuningRule(
  projectId: string,
  appId: string,
  tuning: CustomRuleTuning,
  sample_request?: Record<string, unknown>
) {
  return api<CustomRuleDryRunResult>(
    `/api/projects/${projectId}/apps/${appId}/custom-rules/validate-gui`,
    {
      method: 'POST',
      body: JSON.stringify({ mode: 'tuning', tuning, sample_request }),
    }
  );
}

export function listProjectInvites(projectId: string, offset = 0) {
 return api<{invites: ProjectInvite[]; total:number}>(`/api/projects/${projectId}/members/invites?limit=20&offset=${offset}`);
}
export function revokeProjectInvite(projectId: string, token:string) {
 return api<{ok:boolean}>(`/api/projects/${projectId}/members/invites/${encodeURIComponent(token)}`,{method:'DELETE'});
}

export interface SystemAuditEvent { id:string; actor_user_id:string; actor_email:string; action:string; target_type:string; target_id:string; outcome:'success'|'failure'; http_status:number; ip:string; user_agent:string; metadata?: Record<string, unknown>; created_at:string }
/** Global audit log (admin). `limit` defaults to 20; the server allows up to 100. */
export function listSystemAudit(page: PageParams = {}) {
  const params = new URLSearchParams({ limit: String(page.limit ?? 20), offset: String(page.offset ?? 0) });
  return api<{ events: SystemAuditEvent[]; total: number }>(`/api/admin/audit-log?${params}`);
}

export function resetAppConfig(projectId:string,agentId:string,appId:string,expectedRevision:number) {return api<{ok:boolean;source:string;config_revision:number}>(`/api/projects/${projectId}/agents/${agentId}/routes/${appId}/config?expected_revision=${expectedRevision}`,{method:'DELETE'})}

export interface WAFDecisionFeedback {
  id: string;
  project_id: string;
  app_id: string;
  decision_id: number;
  decision_recorded_at: string;
  actor_user_id: string;
  verdict: 'true_positive' | 'false_positive' | 'unsure';
  note: string;
  created_at: string;
}

export function getWAFDecisionFeedback(projectId: string, appId: string, decisionId: number, recordedAt: string, offset = 0) {
  const q = new URLSearchParams({ recorded_at: recordedAt, offset: String(offset), limit: '20' });
  return api<{ feedback: WAFDecisionFeedback[]; total: number }>(`/api/projects/${projectId}/apps/${appId}/waf/decisions/${decisionId}/feedback?${q}`);
}

export function addWAFDecisionFeedback(projectId: string, appId: string, decisionId: number, recordedAt: string, verdict: WAFDecisionFeedback['verdict'], note: string) {
  const q = new URLSearchParams({ recorded_at: recordedAt });
  return api<WAFDecisionFeedback>(`/api/projects/${projectId}/apps/${appId}/waf/decisions/${decisionId}/feedback?${q}`, { method: 'POST', body: JSON.stringify({ verdict, note }) });
}

/** Windows GET …/waf/feedback/summary accepts. */
export type FeedbackSummaryRange = '24h' | '7d' | '30d';

/** Decision and assessment counters of one feedback-summary scope. */
export interface FeedbackCounters {
  blocks: number;
  logs: number;
  /** Decisions with at least one assessment. */
  reviewed: number;
  true_positive: number;
  false_positive: number;
  unsure: number;
  reviewed_blocks: number;
  false_positive_blocks: number;
  /** false_positive_blocks / reviewed_blocks (ratio); null when no block was reviewed. */
  fp_block_rate: number | null;
}

/** One breakdown row: `key` is the app id ("" = traffic no app claims, label "Unmapped host"), category or analyze method; `label` its display name. */
export interface FeedbackBreakdownRow extends FeedbackCounters {
  key: string;
  label: string;
}

export interface FeedbackSummary {
  range: FeedbackSummaryRange;
  from: string;
  to: string;
  /** The app_id filter echoed back; "" for the whole project. */
  app_id: string;
  totals: FeedbackCounters;
  by_app: FeedbackBreakdownRow[];
  by_category: FeedbackBreakdownRow[];
  by_method: FeedbackBreakdownRow[];
}

/** False-positive rate of reviewed decisions; `appId` narrows it to one application. */
export function getFeedbackSummary(projectId: string, range: FeedbackSummaryRange, opts: { appId?: string; signal?: AbortSignal } = {}) {
  const q = new URLSearchParams({ range });
  if (opts.appId) q.set('app_id', opts.appId);
  return api<FeedbackSummary>(`/api/projects/${projectId}/waf/feedback/summary?${q}`, { signal: opts.signal });
}

export interface WAFConfigHistoryEntry {
 project_revision?: number | null;
 project_rules_json?: Record<string, unknown> | null;
  revision: number;
  rules_json: unknown;
  actor_user_id: string | null;
  created_at: string;
  inherited: boolean;
}
export function getWAFConfigHistory(projectId: string, appId: string, offset = 0) {
  return api<{ history: WAFConfigHistoryEntry[]; total: number }>(`/api/projects/${projectId}/apps/${appId}/waf/config-history?limit=20&offset=${offset}`);
}
export function rollbackWAFConfig(projectId: string, appId: string, revision: number, expectedRevision: number) {
  return api<{ ok: boolean; config_revision: number }>(`/api/projects/${projectId}/apps/${appId}/waf/config-history/${revision}/rollback`, { method: 'POST', body: JSON.stringify({ expected_revision: expectedRevision }) });
}

export function getProjectConfigHistory(projectId: string, offset = 0) {
 return api<{history: WAFConfigHistoryEntry[]; total: number}>(`/api/projects/${projectId}/config-history?limit=20&offset=${offset}`);
}
export function rollbackProjectConfig(projectId: string, revision: number, expected_revision: number) {
 return api<{ok:boolean;config_revision:number}>(`/api/projects/${projectId}/config-history/${revision}/rollback`, {method:'POST', json:{expected_revision}});
}

export interface OverviewEvidenceSource { state: string; observed_at: string | null; message?: string }
export interface OverviewAgentEvidence {
 id: string; name: string; kind: string; host_id: string | null; last_seen: string | null; state_at: string | null; freshness: string;
 desired_generation: string | null; applied_generation: string | null; apply_state: string; apply_observed_at: string | null;
 capabilities: Record<string, boolean | null>;
}
export interface OverviewEvidenceAction { id: string; kind: string; severity: string; target_id: string; target_name: string; observed_at: string | null; due_at: string | null; message: string }
export interface OverviewEvidence {
 snapshot_at: string; connection_observed_at: string | null; project_id: string; host_id?: string;
 sources: Record<string, OverviewEvidenceSource>; agents: OverviewAgentEvidence[]; actions: OverviewEvidenceAction[]; total: number;
}
export function getOverviewEvidence(projectId: string, hostId = '', offset = 0) {
 const query = new URLSearchParams({limit:'20', offset:String(offset)}); if(hostId)query.set('host_id',hostId);
 return api<OverviewEvidence>(`/api/projects/${projectId}/overview/evidence?${query}`);
}

export interface MalwareCredentialStatus {
  configured: boolean;
  source: 'none' | 'saved' | 'environment';
  editable: boolean;
}

export const getMalwareCredentials = () => api<MalwareCredentialStatus>('/api/admin/security-data/malware-credentials', { cache: 'no-store' }, (body) => {
  const value = body as MalwareCredentialStatus;
  return typeof value?.configured === 'boolean' && typeof value.editable === 'boolean' && ['none', 'saved', 'environment'].includes(value.source);
});
export const saveMalwareCredentials = (authKey: string) => api<{ ok: boolean }>('/api/admin/security-data/malware-credentials', { method: 'PUT', json: { auth_key: authKey } }, (body) => (body as { ok?: boolean })?.ok === true);
export const removeMalwareCredentials = () => api<{ ok: boolean }>('/api/admin/security-data/malware-credentials', { method: 'DELETE' }, (body) => (body as { ok?: boolean })?.ok === true);

// ── Email (SMTP) settings (Administration; handlers/mail_settings.go) ─────

export type SmtpSecurity = 'auto' | 'starttls' | 'tls' | 'none';
/** config = config.yaml / WAFIO_* (read-only here); saved = set on this page. */
export type SmtpSettingSource = 'config' | 'saved' | 'default' | 'none';
export type SmtpField = 'host' | 'port' | 'security' | 'username' | 'password' | 'from_address' | 'from_name' | 'base_url';

/** Effective settings with a source per field. The password is never sent back, only password_set. */
export interface SmtpSettings {
  host: string;
  port: number;
  security: SmtpSecurity | string;
  username: string;
  password_set: boolean;
  from_address: string;
  from_name: string;
  base_url: string;
  sources: Partial<Record<SmtpField, SmtpSettingSource>>;
  smtp_managed_by_config: boolean;
  base_url_managed_by_config: boolean;
  editable: boolean;
  mail_configured: boolean;
  recovery_available: boolean;
  base_url_problem?: string;
}

/** Partial update: omitted = keep; empty password = keep; clear_password removes it. */
export interface SmtpSettingsUpdate {
  host?: string;
  port?: number;
  security?: SmtpSecurity;
  username?: string;
  password?: string;
  clear_password?: boolean;
  from_address?: string;
  from_name?: string;
  base_url?: string;
}

function isSmtpSettings(body: unknown): boolean {
  const v = body as SmtpSettings;
  return !!v && typeof v === 'object' && typeof v.host === 'string' && typeof v.port === 'number'
    && typeof v.password_set === 'boolean' && typeof v.editable === 'boolean'
    && typeof v.sources === 'object' && v.sources !== null;
}

export const getSmtpSettings = () =>
  api<SmtpSettings>('/api/admin/smtp-settings', { cache: 'no-store' }, isSmtpSettings);
/** 400 VALIDATION_FAILED (with `field`), 409 SMTP_SETTINGS_MANAGED, 503 SMTP_SETTINGS_UNAVAILABLE. */
export const updateSmtpSettings = (update: SmtpSettingsUpdate) =>
  api<SmtpSettings>('/api/admin/smtp-settings', { method: 'PUT', json: update }, isSmtpSettings);
export const clearSmtpSettings = () =>
  api<OkResponse>('/api/admin/smtp-settings', { method: 'DELETE' }, (body) => (body as { ok?: boolean })?.ok === true);
/**
 * Sends a test email with the settings in force, by default to the caller.
 * 409 SMTP_NOT_CONFIGURED; 502 SMTP_TEST_FAILED with a sanitized `error`;
 * 429 after three tests a minute.
 */
export const sendSmtpTest = (to?: string) =>
  api<{ ok: boolean; to: string }>('/api/admin/smtp-settings/test', { method: 'POST', json: to ? { to } : {} },
    (body) => (body as { ok?: boolean })?.ok === true);

// ── Data retention and database size (Administration; GET/PUT /api/admin/storage) ──

/** Tables with an operator-set retention. */
export type RetentionTable = 'waf_decisions' | 'host_security_events' | 'host_fw_features' | 'host_sec_features' | 'host_enforcement_events';
/** policy = TimescaleDB retention policy; drop_chunks / delete = the control plane removes old data; none = nothing removes it. */
export type RetentionMode = 'policy' | 'drop_chunks' | 'delete' | 'none';
export type StorageLevel = 'none' | 'ok' | 'warning' | 'critical';
/** budget = size against the configured budget; filesystem = the disk holding the database. */
export type StorageLevelReason = 'budget' | 'filesystem' | '';

export interface StorageCompression {
  enabled: boolean;
  compress_after_days: number | null;
  compressed_chunks: number;
  total_chunks: number;
  before_bytes: number | null;
  after_bytes: number | null;
  ratio: number | null;
}

export interface StorageTable {
  table: RetentionTable | (string & {});
  label: string;
  time_column: string;
  retention_days: number;
  default_days: number;
  min_days: number;
  max_days: number;
  /** A value saved on the Data retention page (else the default applies). */
  saved: boolean;
  live_days: number | null;
  mode: RetentionMode | (string & {});
  active: boolean;
  inactive_reason: string;
  last_run_at: string | null;
  last_run_deleted: number | null;
  hypertable: boolean;
  total_bytes: number | null;
  compression: StorageCompression | null;
  chunk_count: number | null;
  oldest_at: string | null;
  oldest_kind: 'chunk' | 'row' | '';
  ingest_bytes_per_day: number | null;
}

export interface StorageFilesystem {
  known: boolean;
  free_bytes: number | null;
  total_bytes: number | null;
  used_ratio: number | null;
  /** Why the filesystem is unknown, when it is. */
  reason: string;
}

export interface StorageDatabase {
  size_bytes: number | null;
  budget_bytes: number | null;
  used_ratio: number | null;
  level: StorageLevel;
  level_reason: StorageLevelReason;
  warning_ratio: number;
  critical_ratio: number;
  ingest_bytes_per_day: number | null;
  growth_bytes_per_day: number | null;
  growth_source: 'chunks' | 'observed' | 'unknown';
  projected_size_bytes: number | null;
  days_until_full: number | null;
  projection: 'fills' | 'stable' | 'unknown';
  filesystem: StorageFilesystem;
  checked_at: string | null;
}

export interface StorageStatus {
  checked_at: string;
  timescaledb: { installed: boolean; version: string; license: string; policies_supported: boolean; note: string };
  tables: StorageTable[];
  database: StorageDatabase;
}

/** GET /api/admin/storage/alert: what the shell banner and header indicator need. */
export interface StorageAlert {
  level: StorageLevel;
  level_reason: StorageLevelReason;
  size_bytes: number | null;
  budget_bytes: number | null;
  used_ratio: number | null;
  filesystem_used_ratio: number | null;
  days_until_full: number | null;
  checked_at: string | null;
}

/** Retention update: days per table, null = back to the default. */
export interface RetentionUpdate { tables: Partial<Record<RetentionTable | (string & {}), number | null>> }

function isStorageStatus(body: unknown): boolean {
  const v = body as StorageStatus;
  return !!v && typeof v === 'object' && Array.isArray(v.tables)
    && !!v.database && typeof v.database === 'object' && typeof v.database.level === 'string'
    && !!v.timescaledb && typeof v.timescaledb === 'object';
}

function isStorageAlert(body: unknown): boolean {
  const v = body as StorageAlert;
  return !!v && typeof v === 'object' && typeof v.level === 'string';
}

export const getStorageStatus = () =>
  api<StorageStatus>('/api/admin/storage', { cache: 'no-store' }, isStorageStatus);
/** 400 VALIDATION_FAILED / RETENTION_BELOW_COMPRESSION with `field` "tables.<table>"; 503 STORAGE_UNAVAILABLE. */
export const updateRetention = (update: RetentionUpdate) =>
  api<StorageStatus>('/api/admin/storage/retention', { method: 'PUT', json: update }, isStorageStatus);
/** budget_gb null removes the budget. 400 VALIDATION_FAILED with `field` "budget_gb". */
export const updateStorageBudget = (budgetGb: number | null) =>
  api<StorageStatus>('/api/admin/storage/budget', { method: 'PUT', json: { budget_gb: budgetGb } }, isStorageStatus);
export const getStorageAlert = (signal?: AbortSignal) =>
  api<StorageAlert>('/api/admin/storage/alert', { cache: 'no-store', signal }, isStorageAlert);

// GET /api/admin/security-data/status (handlers/security_data.go).
export interface SecurityDataComponent {
  component: string;
  label: string;
  /** 'control-plane' | 'agent' | 'both' */
  profile: string;
  path?: string;
  exists: boolean;
  size_bytes: number;
  modified_at?: string;
}

export interface SecurityDataAgentComponent {
  component: string;
  label: string;
  path?: string;
  exists: boolean;
  size_bytes: number;
  modified_at?: string;
}

export interface SecurityDataAgentReport {
  agent_name: string;
  credential_id: string;
  agent_kind: string;
  components: SecurityDataAgentComponent[];
}

export interface SecurityDataStatus {
  components: SecurityDataComponent[];
  agent_reports: SecurityDataAgentReport[];
}

/** Installed security data on the control plane and as reported by agents (admin). */
export const getSecurityDataStatus = () => api<SecurityDataStatus>('/api/admin/security-data/status');

export interface SecurityDataProgress {
  total?: number;
  component?: string;
  message?: string;
  size_bytes?: number;
  ok?: boolean;
  failed?: number;
}

// Use Authorization headers so the dashboard token is not put in SSE URLs.
// The update downloads and replaces data, so it is a POST (the GET form is
// refused with 405); progress still arrives as server-sent events.
export async function streamSecurityDataUpdate(
  components: string[], force: boolean,
  onEvent: (event: string, data: SecurityDataProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const token = getToken();
  const response = await fetch(`${getBase()}/api/admin/security-data/update`, {
    method: 'POST',
    headers: {
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ components, force }),
    signal,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const code = typeof body?.code === 'string' ? body.code : undefined;
    if (isSessionExpired('/api/admin/security-data/update', response.status, code)) handleUnauthorized();
    throw new Error(typeof body?.error === 'string' ? body.error : `Update request failed (${response.status})`);
  }
  if (!response.body || !response.headers.get('Content-Type')?.includes('text/event-stream')) throw new Error('Invalid update response');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) throw new Error('Update connection closed before completion. Refresh status before retrying.');
      pending += decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = pending.indexOf('\n\n')) >= 0) {
        const frame = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        let event = '';
        const data: string[] = [];
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
        }
        if (!event || !data.length) continue;
        const parsed: unknown = JSON.parse(data.join('\n'));
        if (!parsed || typeof parsed !== 'object') throw new Error('Invalid update progress');
        onEvent(event, parsed as SecurityDataProgress);
        if (event === 'complete') return;
      }
      if (pending.length > 65536) throw new Error('Invalid update progress');
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
