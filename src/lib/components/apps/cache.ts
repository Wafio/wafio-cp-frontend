/**
 * Cache section of the Speed tab: the checks the control plane makes (same numbers and texts, never stricter), the
 * form model, which saves ask first, the check of a removal, and what the agent counted in words. Pure functions;
 * the section is CacheSection.svelte.
 */
import type { ApiError, AppCache, AppCachePurge, AppCacheRule, AppCacheStats, AppDelivery } from '../../api';
import { needsConfirmation } from '../../confirm-tiers';
import { formatBytes, formatDateTime, formatNumber } from '../../format';
import { bytesFromInput, bytesToInput } from './inputs';
import { PART_LABEL, answerOverdue, classifySpeedRefusal, tooOld, tooOldText } from './speed';

const KIB = 1024;
const MIB = 1024 * KIB;
const GIB = 1024 * MIB;
const DAY_S = 24 * 60 * 60;

/** The limits of the control plane (domain delivery settings). */
export const CACHE_LIMITS = {
  ttlMaxS: 365 * DAY_S,
  staleMaxS: DAY_S,
  diskMinBytes: 16 * MIB,
  diskMaxBytes: 1024 * GIB,
  memoryMaxBytes: 4 * GIB,
  objectMinBytes: KIB,
  objectMaxBytes: 64 * MIB,
  cookies: 20,
  cookieNameBytes: 64,
  rules: 50,
  prefixBytes: 256,
  purgeUrlBytes: 2048,
  /** What a new path rule keeps for. */
  newRuleTtlS: 10 * 60,
} as const;

export const TTL_MESSAGE = 'Enter a time from 0 seconds to 365 days.';
export const STALE_MESSAGE = 'Enter a time from 0 seconds to 1 day.';
export const RULE_TTL_MESSAGE = 'Enter a time from 1 second to 365 days.';
export const DISK_MESSAGE = 'Enter a size from 16 MiB to 1 TiB.';
export const MEMORY_MESSAGE = 'Enter a size from 0 bytes to 4 GiB.';
export const OBJECT_MESSAGE = 'Enter a size from 1 KiB to 64 MiB, no more than the disk space.';
export const COOKIES_MESSAGE = 'Use up to 20 cookie names of up to 64 characters, without spaces, commas, semicolons or =.';
export const RULES_MAX_MESSAGE = 'Up to 50 rules.';
export const RULE_PATH_MESSAGE = 'Enter a path that starts with /.';
export const RULE_PATH_SHAPE_MESSAGE = 'Use a path of up to 256 characters without spaces, ? or #.';
export const RULE_ONCE_MESSAGE = 'Each path can have one rule.';
export const RULE_ACTION_MESSAGE = 'Choose "Keep for a time" or "Never keep".';
export const PURGE_SCOPE_MESSAGE = 'Choose one address, everything under a path, or everything.';
export const PURGE_URL_MESSAGE = 'Enter an address that starts with http://, https:// or /.';
export const PURGE_PREFIX_MESSAGE = 'Enter a path that starts with /, without a query.';

// The server trims every Unicode space; JS \s is the same set plus U+FEFF (more lenient, never stricter) and lacks U+0085.
const SPACES = /^[\s\u0085]+|[\s\u0085]+$/g;
const trimSpace = (value: string): string => value.replace(SPACES, '');
const lowerAscii = (value: string): string => value.replace(/[A-Z]/g, (c) => c.toLowerCase());

// ── Checks (domain.Cache.Normalize and domain.NormalizePurge) ──────────────

export type CacheRuleField = `rules[${number}].${'prefix' | 'action' | 'ttl_s'}`;
export type CacheField = 'default_ttl_s' | 'stale_if_error_s' | 'disk_bytes' | 'memory_bytes' | 'max_object_bytes' | 'session_cookies' | 'rules' | CacheRuleField;

const RULE_FIELD = /^rules\[(\d+)\]\.(prefix|action|ttl_s)$/;

/** The field of a 400 answer if it is one of the cache's, else null. */
export function cacheFieldOf(name: string | undefined): CacheField | null {
  if (!name) return null;
  if (['default_ttl_s', 'stale_if_error_s', 'disk_bytes', 'memory_bytes', 'max_object_bytes', 'session_cookies', 'rules'].includes(name)) return name as CacheField;
  return RULE_FIELD.test(name) ? (name as CacheRuleField) : null;
}

/** `rules[2].ttl_s` is the time of the third rule. */
export function ruleFieldOf(field: string | undefined): { index: number; part: 'prefix' | 'action' | 'ttl_s' } | null {
  const match = field ? RULE_FIELD.exec(field) : null;
  return match ? { index: Number(match[1]), part: match[2] as 'prefix' | 'action' | 'ttl_s' } : null;
}

/** The limits folded under "Advanced limits": a refusal of one of them opens the fold. */
export const inAdvanced = (field: CacheField): boolean => ['disk_bytes', 'memory_bytes', 'max_object_bytes'].includes(field);

export type CacheRefusal = { kind: 'field'; field: CacheField; message: string; advanced: boolean } | { kind: 'too-old' | 'save'; message: string };

/** Where a refused save is said: under the cache field the 400 names, as the agent being too old, or above the buttons. */
export function classifyCacheRefusal(error: ApiError | undefined): CacheRefusal {
  const field = cacheFieldOf(error?.field);
  const refusal = classifySpeedRefusal(error, field ? [field] : [], 'cache', 'Could not save the cache settings.');
  return refusal.kind === 'field' ? { ...refusal, advanced: inAdvanced(refusal.field) } : refusal;
}

export interface CacheRuleInput {
  prefix: string;
  action: string;
  ttl_s: number;
  signed_in: boolean;
}

export interface CacheInput {
  enabled: boolean;
  /** null: left out, the default applies (an explicit 0 is kept). */
  default_ttl_s: number | null;
  stale_if_error_s: number | null;
  disk_bytes: number | null;
  memory_bytes: number | null;
  max_object_bytes: number | null;
  session_cookies: string[] | null;
  rules: CacheRuleInput[] | null;
}

export interface CacheFieldError {
  field: CacheField;
  message: string;
}
export type NormalizedCache = { settings: AppCache; error?: undefined } | { settings?: undefined; error: CacheFieldError };

const outside = (value: number, low: number, high: number): boolean => !Number.isInteger(value) || value < low || value > high;

/** An RFC 6265 token of 1 to 64 characters: printable ASCII without a separator. */
function validCookieName(name: string): boolean {
  if (name.length === 0 || name.length > CACHE_LIMITS.cookieNameBytes) return false;
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code <= 0x20 || code >= 0x7f || '()<>@,;:\\"/[]?={}'.includes(name[i])) return false;
  }
  return true;
}

/** A path of at most 256 printable ASCII characters without a space, ? or #. */
function prefixShape(path: string): boolean {
  if (path.length > CACHE_LIMITS.prefixBytes) return false;
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i);
    if (code <= 0x20 || code > 0x7e || path[i] === '?' || path[i] === '#') return false;
  }
  return true;
}

/**
 * The stored form of the cache settings or the first refused field: defaults for what is left out, cookie names
 * trimmed and without repeats, a "Never keep" rule with no time and no signed-in case. Every value is checked
 * whether the switch is on or off.
 */
export function normalizeCache(input: CacheInput): NormalizedCache {
  const fail = (field: CacheField, message: string): NormalizedCache => ({ error: { field, message } });
  const ttl = input.default_ttl_s ?? 3600;
  const stale = input.stale_if_error_s ?? 600;
  const disk = input.disk_bytes ?? GIB;
  const memory = input.memory_bytes ?? 32 * MIB;
  const object = input.max_object_bytes ?? 8 * MIB;
  if (outside(ttl, 0, CACHE_LIMITS.ttlMaxS)) return fail('default_ttl_s', TTL_MESSAGE);
  if (outside(stale, 0, CACHE_LIMITS.staleMaxS)) return fail('stale_if_error_s', STALE_MESSAGE);
  if (outside(disk, CACHE_LIMITS.diskMinBytes, CACHE_LIMITS.diskMaxBytes)) return fail('disk_bytes', DISK_MESSAGE);
  if (outside(memory, 0, CACHE_LIMITS.memoryMaxBytes)) return fail('memory_bytes', MEMORY_MESSAGE);
  if (outside(object, CACHE_LIMITS.objectMinBytes, CACHE_LIMITS.objectMaxBytes) || object > disk) return fail('max_object_bytes', OBJECT_MESSAGE);

  const cookies: string[] = [];
  const seen = new Set<string>();
  for (const raw of input.session_cookies ?? []) {
    const name = trimSpace(raw);
    if (name === '' || seen.has(lowerAscii(name))) continue;
    seen.add(lowerAscii(name));
    if (!validCookieName(name)) return fail('session_cookies', COOKIES_MESSAGE);
    cookies.push(name);
  }
  if (cookies.length > CACHE_LIMITS.cookies) return fail('session_cookies', COOKIES_MESSAGE);

  const given = input.rules ?? [];
  if (given.length > CACHE_LIMITS.rules) return fail('rules', RULES_MAX_MESSAGE);
  const rules: AppCacheRule[] = [];
  const prefixes = new Set<string>();
  for (const [i, rule] of given.entries()) {
    const prefix = trimSpace(rule.prefix);
    if (!prefix.startsWith('/')) return fail(`rules[${i}].prefix`, RULE_PATH_MESSAGE);
    if (!prefixShape(prefix)) return fail(`rules[${i}].prefix`, RULE_PATH_SHAPE_MESSAGE);
    if (prefixes.has(prefix)) return fail(`rules[${i}].prefix`, RULE_ONCE_MESSAGE);
    prefixes.add(prefix);
    if (rule.action === 'cache') {
      if (outside(rule.ttl_s, 1, CACHE_LIMITS.ttlMaxS)) return fail(`rules[${i}].ttl_s`, RULE_TTL_MESSAGE);
      rules.push({ prefix, action: 'cache', ttl_s: rule.ttl_s, signed_in: rule.signed_in });
    } else if (rule.action === 'bypass') {
      rules.push({ prefix, action: 'bypass', ttl_s: 0, signed_in: false });
    } else {
      return fail(`rules[${i}].action`, RULE_ACTION_MESSAGE);
    }
  }
  return {
    settings: {
      enabled: input.enabled,
      default_ttl_s: ttl,
      stale_if_error_s: stale,
      disk_bytes: disk,
      memory_bytes: memory,
      max_object_bytes: object,
      session_cookies: cookies,
      rules,
    },
  };
}

export type PurgeScope = AppCachePurge['scope'];

export type NormalizedPurge = { url: string; error?: undefined } | { url?: undefined; error: { field: 'scope' | 'url'; message: string } };

/**
 * A removal's address as the agent compares it: "" for everything, a path that starts with /, or an absolute URL with
 * the scheme and host in lower case and the default port left out. Everything after the host stays as typed, since
 * it is compared with the request target the agent stored.
 */
export function normalizePurge(scope: string, address: string): NormalizedPurge {
  if (scope === 'app') return { url: '' };
  if (scope !== 'url' && scope !== 'prefix') return { error: { field: 'scope', message: PURGE_SCOPE_MESSAGE } };
  const message = scope === 'prefix' ? PURGE_PREFIX_MESSAGE : PURGE_URL_MESSAGE;
  const bad: NormalizedPurge = { error: { field: 'url', message } };
  const url = trimSpace(address);
  if (url === '' || url.length > CACHE_LIMITS.purgeUrlBytes) return bad;
  for (let i = 0; i < url.length; i++) {
    const code = url.charCodeAt(i);
    if (code <= 0x20 || code > 0x7e || url[i] === '#') return bad;
  }
  let head = '';
  let target = url;
  if (url[0] !== '/') {
    const split = splitPurgeUrl(url);
    if (!split) return bad;
    [head, target] = split;
  }
  if (scope === 'prefix' && target.includes('?')) return bad;
  return { url: head + target };
}

/** Scheme and host as the agent keys them, and the request target after them ("/" when there is none). */
function splitPurgeUrl(url: string): [string, string] | null {
  const at = url.indexOf('://');
  if (at < 0) return null;
  const scheme = lowerAscii(url.slice(0, at));
  if (scheme !== 'http' && scheme !== 'https') return null;
  const rest = url.slice(at + 3);
  let authority = rest;
  let target = '/';
  const end = rest.search(/[/?]/);
  if (end >= 0) {
    authority = rest.slice(0, end);
    target = rest.slice(end);
    if (target[0] === '?') target = `/${target}`;
  }
  const parts = splitAuthority(lowerAscii(authority));
  if (!parts) return null;
  let { host, port } = parts;
  if ((port === '80' && scheme === 'http') || (port === '443' && scheme === 'https')) port = '';
  if (port !== '') host += `:${port}`;
  return [`${scheme}://${host}`, target];
}

/** A DNS name or IPv4 address, or an IPv6 address in brackets, with an optional port of 1 to 5 digits without a leading zero. */
function splitAuthority(authority: string): { host: string; port: string } | null {
  let host: string;
  let port: string;
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    if (end < 0) return null;
    host = authority.slice(0, end + 1);
    const after = authority.slice(end + 1);
    if (!/^[0-9a-f:.]*$/.test(host.slice(1, end)) || end === 1) return null;
    if (after === '') return { host, port: '' };
    if (after[0] !== ':') return null;
    port = after.slice(1);
  } else {
    const colon = authority.indexOf(':');
    host = colon < 0 ? authority : authority.slice(0, colon);
    if (host === '' || host.startsWith('.') || host.startsWith('-') || !/^[a-z0-9.-]+$/.test(host)) return null;
    if (colon < 0) return { host, port: '' };
    port = authority.slice(colon + 1);
  }
  if (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535) return null;
  return { host, port };
}

// ── Form ───────────────────────────────────────────────────────────────────

export interface CacheRuleForm {
  prefix: string;
  action: 'cache' | 'bypass';
  /** Seconds; NaN while the time cannot be read. */
  ttl: number;
  signedIn: boolean;
}

/** What the person edits: sizes and cookie names as text, so that an empty size means the default. */
export interface CacheForm {
  enabled: boolean;
  /** Seconds; NaN while the time cannot be read. */
  defaultTtl: number;
  staleIfError: number;
  disk: string;
  memory: string;
  object: string;
  /** One cookie name a line. */
  cookies: string;
  rules: CacheRuleForm[];
}

export const emptyRule = (): CacheRuleForm => ({ prefix: '', action: 'cache', ttl: CACHE_LIMITS.newRuleTtlS, signedIn: false });

export function cacheForm(settings: AppCache): CacheForm {
  return {
    enabled: settings.enabled,
    defaultTtl: settings.default_ttl_s,
    staleIfError: settings.stale_if_error_s,
    disk: bytesToInput(settings.disk_bytes),
    memory: bytesToInput(settings.memory_bytes),
    object: bytesToInput(settings.max_object_bytes),
    cookies: settings.session_cookies.join('\n'),
    rules: settings.rules.map((rule) => ({
      prefix: rule.prefix,
      action: rule.action,
      ttl: rule.action === 'cache' ? rule.ttl_s : CACHE_LIMITS.newRuleTtlS,
      signedIn: rule.signed_in,
    })),
  };
}

/** A size as typed: empty is the default, one that cannot be read is NaN and refused by the checks. */
const sizeInput = (text: string): number | null => (text.trim() === '' ? null : bytesFromInput(text));

export function cacheInput(form: CacheForm): CacheInput {
  return {
    enabled: form.enabled,
    default_ttl_s: form.defaultTtl,
    stale_if_error_s: form.staleIfError,
    disk_bytes: sizeInput(form.disk),
    memory_bytes: sizeInput(form.memory),
    max_object_bytes: sizeInput(form.object),
    session_cookies: form.cookies.split('\n'),
    rules: form.rules.map((rule) => ({
      prefix: rule.prefix,
      action: rule.action,
      ttl_s: rule.action === 'cache' ? rule.ttl : 0,
      signed_in: rule.action === 'cache' && rule.signedIn,
    })),
  };
}

/** The settings with their keys in one fixed order, so two copies compare by text whatever order the server wrote. */
const canonical = (c: AppCache): string =>
  JSON.stringify([
    c.enabled, c.default_ttl_s, c.stale_if_error_s, c.disk_bytes, c.memory_bytes, c.max_object_bytes, c.session_cookies,
    c.rules.map((r) => [r.prefix, r.action, r.ttl_s, r.signed_in]),
  ]);

/**
 * The stored cache settings with the cookie names typed (one a line) and nothing else changed, or the refused field.
 * The names are saved with the cache object, but compression uses them too, so they have their own place on the tab.
 */
export function withCookieNames(stored: AppCache, text: string): NormalizedCache {
  return normalizeCache({ ...stored, session_cookies: text.split('\n') });
}

/** The same settings once the server's normal form is applied; settings that cannot be read count as different. */
export function sameCache(form: CacheForm, stored: AppCache): boolean {
  const next = normalizeCache(cacheInput(form)).settings;
  return next !== undefined && canonical(next) === canonical(stored);
}

/** The typed cookie names are the stored ones once trimmed and without repeats; names that cannot be read count as different. */
export function sameCookieNames(stored: AppCache, text: string): boolean {
  const next = withCookieNames(stored, text).settings;
  return next !== undefined && canonical(next) === canonical(stored);
}

// ── Confirm: what a save asks first ────────────────────────────────────────

export type CacheConfirm = { kind: 'disable-cache' } | { kind: 'shrink-cache'; bytes: number } | { kind: 'cache-signed-in'; prefix: string };

/**
 * What this save asks before it is sent, in the order it is asked: turning the cache off deletes the stored copies; a
 * smaller disk space than the copies use removes some; a rule that keeps copies for signed-in visitors that does not
 * already do so on a running cache shares them between people (also when only the switch turns on). `usedDiskBytes`
 * is what the agent last counted, null without a report.
 */
export function cacheConfirmations(stored: AppCache, next: AppCache, usedDiskBytes: number | null): CacheConfirm[] {
  if (stored.enabled && !next.enabled) return [{ kind: 'disable-cache' }];
  if (!next.enabled) return [];
  const steps: CacheConfirm[] = [];
  if (stored.enabled && usedDiskBytes !== null && next.disk_bytes < stored.disk_bytes && next.disk_bytes < usedDiskBytes) {
    steps.push({ kind: 'shrink-cache', bytes: next.disk_bytes });
  }
  for (const rule of next.rules) {
    if (rule.action !== 'cache' || !rule.signed_in) continue;
    const before = stored.rules.find((r) => r.prefix === rule.prefix);
    if (!stored.enabled || !before || before.action !== 'cache' || !before.signed_in) steps.push({ kind: 'cache-signed-in', prefix: rule.prefix });
  }
  return steps;
}

/** The questions still to ask after the first is answered; null when it was the last and the save runs. */
export const nextQuestion = (steps: readonly CacheConfirm[]): CacheConfirm[] | null => (steps.length > 1 ? steps.slice(1) : null);

export interface ConfirmText {
  title: string;
  body: string;
  confirmLabel: string;
  tone: 'danger' | 'warning';
  /** The text the person has to type. */
  requireText?: string;
}

export function cacheConfirmText(step: CacheConfirm): ConfirmText {
  switch (step.kind) {
    case 'disable-cache':
      return {
        title: 'Turn off the cache?',
        body: 'WAFio deletes the stored copies of this application and every request goes to your application again.',
        confirmLabel: 'Turn off',
        tone: 'warning',
      };
    case 'shrink-cache':
      return {
        title: `Lower the disk space to ${formatBytes(step.bytes)}?`,
        body: 'WAFio removes the least used copies until the rest fit.',
        confirmLabel: 'Lower it',
        tone: 'warning',
      };
    case 'cache-signed-in':
      return {
        title: `Keep copies for signed-in visitors under ${step.prefix}?`,
        body: 'Everyone, signed in or not, gets the same copy. If these pages show a name, a cart or an account, other people see it.',
        confirmLabel: 'Keep for signed-in visitors',
        tone: 'danger',
        requireText: step.prefix,
      };
  }
}

export const purgeAppConfirmTitle = (app: string): string => `Remove every stored copy of ${app || 'this application'}?`;
export const PURGE_APP_CONFIRM_BODY = 'The next requests go to your application until the cache fills again.';

// ── Texts of the section ───────────────────────────────────────────────────

export const CACHE_LEAD = 'Pages and files that are the same for every visitor are kept for a while and sent at once, without waiting for your application.';
export const CACHE_SWITCH_HINT =
  'WAFio checks every request first, so a blocked request never gets a copy. It never keeps answers that set cookies, or that your application marks private or no-store. For visitors who send cookies it keeps only answers marked public, and files and paths you add a rule for. Signed-in visitors need a rule.';
export const CACHE_FIXED = "Each answer carries X-Cache: HIT, MISS, BYPASS or STALE, which your browser's developer tools show.";
export const RULES_LEAD = 'A rule applies to every path that starts with the text you enter. When several match, the longest one wins.';
export const RULES_EMPTY = 'No path rules: every path follows the settings above.';
export const RULE_SIGNED_IN_HINT = 'Only for paths that show the same page to everyone.';
export const COOKIES_HINT =
  "One name a line. Visitors with one of these cookies count as signed in. WAFio already knows the common ones: names with sess in them, such as PHPSESSID and laravel_session, and the WordPress sign-in cookies. Add your application's own if its session cookie has another name.";
export const COOKIES_LEAD =
  'WAFio treats a visitor as signed in when the request carries an Authorization header or a session cookie. Compression leaves their pages uncompressed, and the cache does not keep their answers unless a path rule says so. The names below are used while compression or the cache is on.';
export const COOKIES_IN_CACHE = 'Which cookies mean a signed-in visitor is set under Signed-in visitors, above.';

export const REMOVE_HINT_URL = 'Every variant of this address goes, compressed or not.';
export const REMOVE_HINT_PREFIX = 'Everything stored under this path goes, on every host name of the application.';
export const REMOVE_EMPTY = 'Nothing removed yet.';
export const CACHE_OFF_TEXT = 'The cache is off, so nothing is stored. Turn it on first.';
export const NO_AGENT_TEXT = 'No WAF agent serves this application yet, so nothing is stored.';
export const queueFullText = (agent: string): string => `Too many removals are waiting for ${agent || 'the WAF agent'}. Try again when they finish.`;

/** Why the removal block is disabled, or null when it can be used. */
export function removalBlockedText(d: AppDelivery): string | null {
  if (!d.cache.enabled) return CACHE_OFF_TEXT;
  if (!d.agent) return NO_AGENT_TEXT;
  if (tooOld(d, 'cache')) return tooOldText(d.agent.name, PART_LABEL.cache, d.agent.features);
  return null;
}

/** Removing everything asks first; one address or one path does not. */
export const purgeAsksFirst = (scope: PurgeScope): boolean => scope === 'app' && needsConfirmation('purge-cache-app');

export type PurgeRefusal = { kind: 'field'; message: string } | { kind: 'alert'; message: string; refresh: boolean };

/** Where a refused removal is said: under the address, or above the button (`refresh` when the settings it read are out of date). */
export function classifyPurgeRefusal(error: ApiError | undefined, agent: string): PurgeRefusal {
  if (error?.code === 'INVALID_CACHE_PURGE' && error.field === 'url') return { kind: 'field', message: error.error };
  if (error?.code === 'CACHE_OFF') return { kind: 'alert', message: CACHE_OFF_TEXT, refresh: true };
  if (error?.code === 'PURGE_QUEUE_FULL') return { kind: 'alert', message: queueFullText(agent), refresh: false };
  return { kind: 'alert', message: error?.error || 'Could not remove the copies.', refresh: false };
}

const PURGE_REASON: Record<string, string> = {
  not_in_bundle: "this application is not in its configuration yet. Try again in a minute",
  cache_off: 'the cache is off on it',
  invalid: 'it did not accept the address',
  expired: 'it did not answer within 7 days',
};

export interface PurgeView {
  what: string;
  /** The address is shown in the monospace face. */
  address: boolean;
  by: string;
  state: string;
  tone: 'success' | 'info' | 'warning';
}

/**
 * One removal as a row: what, who asked, and where it stands. `agent` is the one that serves the application now.
 * A removal that waited past the time an agent gets says so instead of promising seconds.
 */
export function purgeView(row: AppCachePurge, agent: { name: string; online: boolean } | null, now: number): PurgeView {
  const named = row.agent || agent?.name || '';
  const name = named || 'The WAF agent';
  const view = {
    what: row.scope === 'app' ? 'Everything' : row.scope === 'prefix' ? `Everything under ${row.url}` : row.url,
    address: row.scope === 'url',
    by: `Asked by ${row.by || 'a former member'}`,
  };
  if (row.state === 'done') {
    const when = row.finished_at ? ` at ${formatDateTime(row.finished_at)}` : '';
    return { ...view, state: `Removed on ${name}${when}.`, tone: 'success' };
  }
  if (row.state === 'failed') {
    return { ...view, state: `${name} could not remove them: ${PURGE_REASON[row.error] ?? 'it gave no reason'}.`, tone: 'warning' };
  }
  if (agent && !agent.online) {
    return { ...view, state: `${agent.name} is offline. The copies go when it reconnects; until then it may still send them.`, tone: 'info' };
  }
  if (answerOverdue(row.created_at, now)) {
    // An agent that is online has been reached, so the hint to check that it is online would name the wrong cause.
    const state = agent ? `${name} is online but has not confirmed the removal. Its log may say why.` : `No answer from ${named || 'the WAF agent'} yet. Check that it is online.`;
    return { ...view, state, tone: 'warning' };
  }
  return { ...view, state: `Removing. ${name} confirms within a few seconds.`, tone: 'info' };
}

// ── Numbers in words ───────────────────────────────────────────────────────

/** How many of every 10 requests the cache answered; "fewer than 1" below a tenth, never 10 unless all were. */
function ofTen(hits: number, requests: number): string {
  const tenths = (hits * 10) / requests;
  if (tenths < 1) return 'fewer than 1';
  const n = Math.round(tenths);
  return String(hits < requests ? Math.min(n, 9) : 10);
}

export interface CacheLimitsShown {
  diskBytes: number;
  memoryBytes: number;
  maxObjectBytes: number;
}

/** The lines under the settings: how many requests the cache answered, the space used, and answers from an older copy. */
export function cacheNumbers(stats: AppCacheStats | null, limits: CacheLimitsShown): string[] {
  if (!stats) return [];
  const hits = stats.hits_memory + stats.hits_disk;
  const lines =
    stats.requests === 0
      ? ['No requests in the last hour.']
      : [`In the last hour, ${ofTen(hits, stats.requests)} of every 10 requests were answered from the cache (${formatNumber(hits)} of ${formatNumber(stats.requests)}).`];
  const copies = stats.objects === 1 ? '1 copy' : `${formatNumber(stats.objects)} copies`;
  const memory = limits.memoryBytes === 0 ? 'none in memory' : `${formatBytes(stats.memory_bytes)} of ${formatBytes(limits.memoryBytes)} in memory`;
  lines.push(`Space used: ${formatBytes(stats.disk_bytes)} of ${formatBytes(limits.diskBytes)} on disk (${copies}), ${memory}.`);
  if (stats.stale > 0) lines.push(`Sent from an older copy while your application was slow or down: ${formatNumber(stats.stale)}.`);
  return lines;
}

/** Why answers were not kept in the last hour; a reason that did not happen is left out. */
export function cacheSkipLines(stats: AppCacheStats | null, limits: Pick<CacheLimitsShown, 'maxObjectBytes'>): string[] {
  if (!stats) return [];
  const lines: string[] = [];
  const skipped = stats.skipped_no_lifetime + stats.skipped_private + stats.skipped_too_large + stats.skipped_streamed + stats.skipped_disk_full;
  if (stats.skipped_no_lifetime > 0 && stats.skipped_no_lifetime * 2 > stats.stored + skipped) {
    lines.push(
      `Most answers do not say how long they may be kept, so WAFio did not keep them (${formatNumber(stats.skipped_no_lifetime)}). Add a path rule, or have your application send Cache-Control: public, max-age=600.`
    );
  }
  const reasons: [number, string][] = [
    [stats.skipped_private, 'Not kept because they were private or for a signed-in visitor'],
    [stats.skipped_streamed, 'Not kept because your application sent them in pieces, without a size'],
    [stats.skipped_too_large, `Not kept because they were over ${formatBytes(limits.maxObjectBytes)}`],
    [stats.skipped_disk_full, "Not kept because the host's disk was almost full"],
    [stats.bypass, 'Not checked against the cache (the request had a body, or its rule only logs or monitors)'],
  ];
  for (const [n, text] of reasons) if (n > 0) lines.push(`${text}: ${formatNumber(n)}.`);
  return lines;
}
