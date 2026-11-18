/**
 * Maintenance tab of an application: the limits, the checks the server makes
 * (same texts, without the "field: " prefix), the form model, the time input
 * conversion and the preview. Pure functions; the panel is AppMaintenance.svelte.
 */
import type { Maintenance, MaintenanceBody, MaintenanceState } from '../../api';
import { isIP, parseCIDR } from '../../validation';

/** The limits of the control plane (test/frontend-fixtures/maintenance.json). */
export const MAINTENANCE_LIMITS = {
  messageChars: 500,
  customHtmlBytes: 65536,
  allowIps: 50,
  allowPaths: 20,
  pathBytes: 256,
  endTimeMaxDays: 365,
} as const;

export type MaintenanceField = 'message' | 'end_time' | 'custom_html' | 'allow_ips' | 'allow_paths';
export type MaintenanceErrors = Partial<Record<MaintenanceField, string>>;

const FIELDS: readonly MaintenanceField[] = ['message', 'end_time', 'custom_html', 'allow_ips', 'allow_paths'];
const DAY_MS = 24 * 60 * 60 * 1000;

export function isMaintenanceField(value: unknown): value is MaintenanceField {
  return typeof value === 'string' && (FIELDS as readonly string[]).includes(value);
}

const encoder = new TextEncoder();

/** Size of a string in UTF-8, the unit of the 64 KiB limit. */
export function utf8Bytes(value: string): number {
  return encoder.encode(value).length;
}

/** "12", "12.4": KiB with one decimal, without a trailing ".0". */
export function formatKiB(bytes: number): string {
  return String(Number((bytes / 1024).toFixed(1)));
}

/** One entry per line: trimmed, empty lines dropped, repeats dropped (first kept). */
export function parseLines(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    const value = line.trim();
    if (value && !seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

// ── Times ──────────────────────────────────────────────────────────────────

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Epoch milliseconds of an RFC 3339 time (as the server reads it); null when it is not a real date and time. */
export function parseEndTime(value: string): number | null {
  const text = value.trim();
  const match = RFC3339.exec(text);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const real = probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day && hour < 24 && minute < 60 && second < 60;
  if (!real) return null;
  const at = Date.parse(text);
  return Number.isNaN(at) ? null : at;
}

/** "YYYY-MM-DDTHH:MM:SSZ" of an instant, whole seconds in UTC (the stored form). */
export function isoSeconds(ms: number): string {
  return `${new Date(Math.floor(ms / 1000) * 1000).toISOString().slice(0, 19)}Z`;
}

/** The end time has passed (false for an empty or unreadable value). */
export function endPassed(endTime: string, now: number): boolean {
  const at = parseEndTime(endTime);
  return at !== null && at <= now;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Value of a datetime-local input (browser time zone) for a stored UTC time; '' when unreadable. Seconds only when set. */
export function toLocalInput(iso: string): string {
  const at = parseEndTime(iso);
  if (at === null) return '';
  const d = new Date(at);
  const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.getSeconds() === 0 ? base : `${base}:${pad(d.getSeconds())}`;
}

/** Stored UTC time of a datetime-local value read in the browser time zone; '' when it is empty or not a real time. */
export function fromLocalInput(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) return '';
  const [year, month, day, hour, minute] = match.slice(1, 6).map(Number);
  const second = Number(match[6] ?? 0);
  // The fields are checked, not the local clock: a time the clock skips at a daylight saving change
  // is still kept, as the browser reads it, instead of clearing the end time without a word.
  const probe = new Date(Date.UTC(year, month - 1, day));
  const real = probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day && hour < 24 && minute < 60 && second < 60;
  return real ? isoSeconds(new Date(year, month - 1, day, hour, minute, second).getTime()) : '';
}

/** `min` and `max` of the end time input: now, and now plus the longest end time the server accepts. */
export function localInputBounds(now: number): { min: string; max: string } {
  const minute = Math.floor(now / 60000) * 60000;
  return { min: toLocalInput(isoSeconds(minute)), max: toLocalInput(isoSeconds(minute + MAINTENANCE_LIMITS.endTimeMaxDays * DAY_MS)) };
}

// ── Checks (the texts of the server, domain.Maintenance.Normalize) ─────────

/** An entry as the server shows it: cut to 64 bytes, in Go quoting. */
function quoted(value: string): string {
  let text = value;
  if (utf8Bytes(text) > 64) {
    let cut = '';
    for (const ch of text) {
      if (utf8Bytes(cut + ch) > 64) break;
      cut += ch;
    }
    text = cut;
  }
  const escapes: Record<number, string> = { 7: '\\a', 8: '\\b', 9: '\\t', 10: '\\n', 11: '\\v', 12: '\\f', 13: '\\r', 34: '\\"', 92: '\\\\' };
  let out = '"';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (escapes[code]) out += escapes[code];
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, '0')}`;
    else out += ch;
  }
  return `${out}"`;
}

const CONTROL_EXCEPT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;
// Go's unicode.IsSpace and IsControl, with the characters that cannot be in a path.
const PATH_FORBIDDEN = /[\p{Z}\p{Cc}?#%]/u;

function ipProblem(value: string): string {
  if (value.includes('/')) {
    const range = parseCIDR(value);
    if (!range) return 'is not an IP address or CIDR range';
    return range.prefix === 0 ? 'lets every visitor through; remove it or turn maintenance mode off' : '';
  }
  return isIP(value) ? '' : 'is not an IP address or CIDR range';
}

function pathProblem(value: string): string {
  if (!value.startsWith('/')) return 'must start with /';
  if (utf8Bytes(value) > MAINTENANCE_LIMITS.pathBytes) return `must be at most ${MAINTENANCE_LIMITS.pathBytes} characters`;
  if (PATH_FORBIDDEN.test(value)) return 'must not contain spaces, ?, #, % or control characters';
  if (value.split('/').some((segment) => segment === '.' || segment === '..')) return 'must not contain . or .. segments';
  // "/" matches every request, so the page would never be shown.
  if (value === '/')return 'lets every visitor through; remove it or turn maintenance mode off';
  return '';
}

function listProblem(entries: readonly string[], limit: number, problem: (value: string) => string): string {
  const list = [...new Set(entries.map((value) => value.trim()))];
  if (list.length > limit) return `at most ${limit} entries`;
  for (const value of list) {
    const text = problem(value);
    if (text) return `${quoted(value)} ${text}`;
  }
  return '';
}

/**
 * What the server would refuse in `draft`, one text per field. `stored` is the
 * value being replaced: an end time that is not in the future is only refused
 * when it changed or the switch goes on, as on the server.
 */
export function validateMaintenance(draft: Maintenance, stored: Maintenance, now: number | Date = Date.now()): MaintenanceErrors {
  const at = typeof now === 'number' ? now : now.getTime();
  const errors: MaintenanceErrors = {};

  const message = draft.message.trim();
  if ([...message].length > MAINTENANCE_LIMITS.messageChars) errors.message = `must be at most ${MAINTENANCE_LIMITS.messageChars} characters`;
  else if (CONTROL_EXCEPT_NEWLINE.test(message)) errors.message = 'must not contain control characters';

  const endText = draft.end_time.trim();
  if (endText) {
    const end = parseEndTime(endText);
    if (end === null) {
      errors.end_time = 'must be a date and time like 2026-11-18T22:00:00Z';
    } else {
      const whole = Math.floor(end / 1000) * 1000;
      const changed = isoSeconds(end) !== stored.end_time || (draft.enabled && !stored.enabled);
      if (changed && whole <= at) errors.end_time = 'must be in the future';
      else if (whole > at + MAINTENANCE_LIMITS.endTimeMaxDays * DAY_MS) errors.end_time = `must be within ${MAINTENANCE_LIMITS.endTimeMaxDays} days`;
    }
  }

  const html = draft.custom_html.trim() === '' ? '' : draft.custom_html;
  if (utf8Bytes(html) > MAINTENANCE_LIMITS.customHtmlBytes) errors.custom_html = 'must be at most 64 KiB (65,536 bytes)';
  else if (html.includes('\u0000')) errors.custom_html = 'must not contain NUL characters';

  const ips = listProblem(draft.allow_ips, MAINTENANCE_LIMITS.allowIps, ipProblem);
  if (ips) errors.allow_ips = ips;
  const paths = listProblem(draft.allow_paths, MAINTENANCE_LIMITS.allowPaths, pathProblem);
  if (paths) errors.allow_paths = paths;
  return errors;
}

/** The server text of a 400 INVALID_MAINTENANCE without its "field: " prefix. */
export function stripFieldPrefix(text: string, field: string): string {
  return text.startsWith(`${field}: `) ? text.slice(field.length + 2) : text;
}

// ── Form model ─────────────────────────────────────────────────────────────

/** The edited values: the switch is not part of the form, it has its own flow. */
export interface MaintenanceForm {
  page: 'standard' | 'custom';
  message: string;
  /** Value of the datetime-local input. */
  endLocal: string;
  /** Kept while the standard page is chosen, so switching back loses nothing. */
  customHtml: string;
  /** One entry per line. */
  ips: string;
  paths: string;
}

export function formFromMaintenance(m: Maintenance): MaintenanceForm {
  return {
    page: m.custom_html.trim() ? 'custom' : 'standard',
    message: m.message,
    endLocal: toLocalInput(m.end_time),
    customHtml: m.custom_html,
    ips: m.allow_ips.join('\n'),
    paths: m.allow_paths.join('\n'),
  };
}

/** The object the server would store for `form`, with the switch set to `enabled`. */
export function maintenanceFromForm(form: MaintenanceForm, enabled: boolean, startedAt = ''): Maintenance {
  return {
    enabled,
    message: form.message.trim(),
    end_time: fromLocalInput(form.endLocal),
    custom_html: form.page === 'custom' && form.customHtml.trim() ? form.customHtml : '',
    allow_ips: parseLines(form.ips),
    allow_paths: parseLines(form.paths),
    started_at: startedAt,
  };
}

/** PUT body: everything but started_at, which the server sets. */
export function maintenanceBody(m: Maintenance): MaintenanceBody {
  const { started_at: _startedAt, ...body } = m;
  return body;
}

/** Same settings, whatever the switch and started_at say (and whitespace the server removes). */
export function sameSettings(a: Maintenance, b: Maintenance): boolean {
  const key = (m: Maintenance) =>
    JSON.stringify([m.message.trim(), m.end_time.trim(), m.custom_html.trim() ? m.custom_html : '', parseLines(m.allow_ips.join('\n')), parseLines(m.allow_paths.join('\n'))]);
  return key(a) === key(b);
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const texts = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);

/** The answer of the server with every field present, so an older or partial answer cannot break the panel. */
export function normalizeMaintenanceState(raw: Partial<MaintenanceState> | null | undefined): MaintenanceState {
  const m: Partial<Maintenance> = raw?.maintenance ?? {};
  return {
    maintenance: {
      enabled: m.enabled === true,
      message: text(m.message),
      end_time: text(m.end_time),
      custom_html: text(m.custom_html),
      allow_ips: texts(m.allow_ips),
      allow_paths: texts(m.allow_paths),
      started_at: text(m.started_at),
    },
    agent_supported: typeof raw?.agent_supported === 'boolean' ? raw.agent_supported : null,
    client_ip: text(raw?.client_ip),
    default_message: text(raw?.default_message),
    stock_html: text(raw?.stock_html),
  };
}

// ── Notices and texts ──────────────────────────────────────────────────────

export type MaintenanceNotice = 'unassigned' | 'unsupported-off' | 'unsupported-on' | 'offline' | 'end-passed' | 'readonly';

/** The alerts above the switch, in the order they are shown. */
export function maintenanceNotices(o: {
  /** A WAF agent serves the application (undefined: yes). */
  assigned?: boolean;
  enabled: boolean;
  /** `agent_supported` of the server: false = the agent cannot, null = unknown. */
  supported: boolean | null;
  /** The serving agent is offline (undefined: not known). */
  online: boolean | undefined;
  canConfigure: boolean;
  endTime: string;
  now: number;
}): MaintenanceNotice[] {
  const out: MaintenanceNotice[] = [];
  if (o.assigned === false) out.push('unassigned');
  if (o.supported === false) out.push(o.enabled ? 'unsupported-on' : 'unsupported-off');
  if (o.online === false) out.push('offline');
  if (o.enabled && endPassed(o.endTime, o.now)) out.push('end-passed');
  if (!o.canConfigure) out.push('readonly');
  return out;
}

/** The switch cannot be turned on for an agent that does not support it; turning it off is always possible. */
export function switchDisabled(o: { canConfigure: boolean; busy: boolean; enabled: boolean; supported: boolean | null }): boolean {
  return !o.canConfigure || o.busy || (o.supported === false && !o.enabled);
}

/** Body of the confirmation that turns maintenance mode on. */
export function enableConfirmMessage(o: { noAllowedIps: boolean; unsaved: boolean }): string {
  return [
    'Visitors will see the maintenance page instead of the site within a few seconds, with HTTP status 503. Requests from allowed IP addresses and paths still reach the site.',
    o.noAllowedIps ? ' No IP addresses are allowed, so your team cannot open the site either.' : '',
    o.unsaved ? ' Your unsaved changes on this page are saved too.' : '',
  ].join('');
}

/** Toast after "Save changes". */
export function savedMessage(enabled: boolean): string {
  return enabled ? 'Maintenance settings saved. The agent applies them within a few seconds.' : 'Maintenance settings saved.';
}

// ── Preview ────────────────────────────────────────────────────────────────

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * The page a visitor gets for `draft`: the custom HTML or the standard page,
 * with the escaped message (or the default one) and the end time while it is
 * in the future. Both placeholders are replaced in one pass, so a message
 * that holds the other placeholder stays as written.
 */
export function previewDocument(
  draft: Pick<Maintenance, 'message' | 'end_time' | 'custom_html'>,
  state: Pick<MaintenanceState, 'default_message' | 'stock_html'>,
  now: number = Date.now(),
): string {
  const page = draft.custom_html.trim() ? draft.custom_html : state.stock_html;
  const message = draft.message.trim() || state.default_message;
  const end = parseEndTime(draft.end_time);
  const endText = end !== null && end > now ? isoSeconds(end) : '';
  return page.replace(/\{\{WAFIO_(MESSAGE|END_TIME)\}\}/g, (_token, name: string) => (name === 'MESSAGE' ? escapeHtml(message) : endText));
}
