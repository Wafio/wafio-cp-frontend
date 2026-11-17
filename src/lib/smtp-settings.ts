/**
 * Form model of Administration › Email (SMTP) (handlers/mail_settings.go).
 * Pure functions so the page stays thin and the rules are testable: the
 * form mirrors the effective settings, sends only what changed and what is
 * editable (fields set in the server configuration are read-only), never
 * echoes a password, and checks values the way the server does.
 */
import type { SmtpField, SmtpSecurity, SmtpSettings, SmtpSettingSource, SmtpSettingsUpdate } from '#lib/api.js';

export interface SmtpForm {
  host: string;
  /** Text of the port input; empty = default for the security mode. */
  port: string;
  security: SmtpSecurity;
  username: string;
  /** New password; empty keeps the saved one. */
  password: string;
  /** Remove the saved password on save. */
  clearPassword: boolean;
  fromAddress: string;
  fromName: string;
  baseUrl: string;
}

export type SmtpFormErrors = Partial<Record<SmtpField, string>>;

export const SECURITY_OPTIONS: ReadonlyArray<{ value: SmtpSecurity; label: string; hint: string }> = [
  { value: 'auto', label: 'Automatic (by port)', hint: 'Port 465 uses TLS, 587 and 2525 require STARTTLS, any other port uses STARTTLS when the server offers it.' },
  { value: 'starttls', label: 'STARTTLS', hint: 'Plain connection upgraded to TLS; refused if the server cannot upgrade. Usually port 587.' },
  { value: 'tls', label: 'TLS (implicit)', hint: 'TLS from the first byte (SMTPS). Usually port 465.' },
  { value: 'none', label: 'None required', hint: 'STARTTLS only when the server offers it. A password is not sent over an unencrypted connection, except to localhost.' },
];

const SECURITY_VALUES = new Set<string>(SECURITY_OPTIONS.map((o) => o.value));

/** The mail server fields, managed as one group by smtp.host in the server configuration. */
export const SMTP_SERVER_FIELDS: readonly SmtpField[] = ['host', 'port', 'security', 'username', 'password', 'from_address', 'from_name'];

/** True when the server configuration sets the field (read-only here). */
export function isManaged(settings: Pick<SmtpSettings, 'sources'> | null | undefined, field: SmtpField): boolean {
  return settings?.sources?.[field] === 'config';
}

/** Short note shown under a field about where its value comes from. */
export function sourceNote(source: SmtpSettingSource | undefined): string {
  switch (source) {
    case 'config':
      return 'Managed by the server configuration (config.yaml or WAFIO_* environment).';
    case 'default':
      return 'Default.';
    default:
      return '';
  }
}

export function formFromSettings(s: SmtpSettings): SmtpForm {
  const security = SECURITY_VALUES.has(s.security) ? (s.security as SmtpSecurity) : 'auto';
  return {
    host: s.host ?? '',
    // A defaulted port stays empty, so it keeps following the security mode.
    port: s.sources?.port === 'default' || !s.port ? '' : String(s.port),
    security,
    username: s.username ?? '',
    password: '',
    clearPassword: false,
    fromAddress: s.from_address ?? '',
    fromName: s.from_name ?? '',
    baseUrl: s.base_url ?? '',
  };
}

/** Port the server uses when the field is empty. */
export function defaultPort(security: SmtpSecurity): number {
  return security === 'tls' ? 465 : 587;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const HOSTNAME = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const ADDRESS = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

function isHost(v: string): boolean {
  if (v.length > 253) return false;
  if (v.includes(':')) return /^[0-9A-Fa-f:.]+$/.test(v); // IPv6 literal
  return IPV4.test(v) || HOSTNAME.test(v);
}

/** Absolute http(s) URL without user info, query or fragment. */
export function isBaseUrl(v: string): boolean {
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return false;
  }
  return (url.protocol === 'http:' || url.protocol === 'https:') && !!url.hostname
    && !url.username && !url.password && !url.search && !url.hash && !v.includes('#') && !v.includes('?');
}

/** Field errors of the editable fields; empty when the form can be saved. */
export function validateSmtpForm(form: SmtpForm, settings: Pick<SmtpSettings, 'sources'> | null): SmtpFormErrors {
  const errors: SmtpFormErrors = {};
  const editable = (f: SmtpField) => !isManaged(settings, f);
  const host = form.host.trim();
  if (editable('host') && host && !isHost(host)) errors.host = 'Enter a host name or an IP address.';
  if (editable('port') && form.port.trim()) {
    const n = Number(form.port.trim());
    if (!Number.isInteger(n) || n < 1 || n > 65535) errors.port = 'Enter a port from 1 to 65535, or leave it empty for the default.';
  }
  if (editable('username') && (form.username.length > 256 || CONTROL.test(form.username))) {
    errors.username = 'The username can have at most 256 characters and no control characters.';
  }
  if (editable('password') && form.password && (new TextEncoder().encode(form.password).length > 1024 || CONTROL.test(form.password))) {
    errors.password = 'The password can have at most 1024 bytes and no control characters.';
  }
  const from = form.fromAddress.trim();
  if (editable('from_address')) {
    if (from && (from.length > 254 || !ADDRESS.test(from))) errors.from_address = 'Enter one email address, for example noreply@example.com.';
    else if (!from && host && editable('host')) errors.from_address = 'A sender address is required with a mail server.';
  }
  if (editable('from_name') && (form.fromName.trim().length > 128 || CONTROL.test(form.fromName))) {
    errors.from_name = 'The sender name can have at most 128 characters and no control characters.';
  }
  const base = form.baseUrl.trim();
  if (editable('base_url') && base && !isBaseUrl(base)) {
    errors.base_url = 'Enter the dashboard address as an absolute http:// or https:// URL without a query or fragment.';
  }
  return errors;
}

export function hasErrors(errors: SmtpFormErrors): boolean {
  return Object.values(errors).some(Boolean);
}

/**
 * The PUT body: editable fields that differ from the baseline, a password
 * only when one was typed, clear_password when asked. Empty object = nothing
 * to save.
 */
export function buildSmtpUpdate(form: SmtpForm, baseline: SmtpForm, settings: Pick<SmtpSettings, 'sources'> | null): SmtpSettingsUpdate {
  const out: SmtpSettingsUpdate = {};
  const editable = (f: SmtpField) => !isManaged(settings, f);
  const changed = (a: string, b: string) => a.trim() !== b.trim();
  if (editable('host') && changed(form.host, baseline.host)) out.host = form.host.trim();
  if (editable('port') && changed(form.port, baseline.port)) out.port = form.port.trim() ? Number(form.port.trim()) : 0;
  if (editable('security') && form.security !== baseline.security) out.security = form.security;
  if (editable('username') && changed(form.username, baseline.username)) out.username = form.username.trim();
  if (editable('password')) {
    if (form.clearPassword) out.clear_password = true;
    else if (form.password) out.password = form.password;
  }
  if (editable('from_address') && changed(form.fromAddress, baseline.fromAddress)) out.from_address = form.fromAddress.trim();
  if (editable('from_name') && changed(form.fromName, baseline.fromName)) out.from_name = form.fromName.trim();
  if (editable('base_url') && changed(form.baseUrl, baseline.baseUrl)) out.base_url = form.baseUrl.trim();
  return out;
}

/**
 * Which of host / username the form changes so that saving clears the saved
 * password (no new password entered while one is saved), or null. The
 * server compares the host trimmed and lower-cased and the username
 * trimmed, so re-entering the same value is no change.
 */
export function passwordClearedBy(
  form: SmtpForm,
  baseline: SmtpForm,
  settings: Pick<SmtpSettings, 'sources' | 'password_set'> | null,
): 'host' | 'username' | 'host and username' | null {
  if (!settings?.password_set || form.clearPassword || form.password) return null;
  const host = !isManaged(settings, 'host') && form.host.trim().toLowerCase() !== baseline.host.trim().toLowerCase();
  const user = !isManaged(settings, 'username') && form.username.trim() !== baseline.username.trim();
  if (host && user) return 'host and username';
  if (host) return 'host';
  if (user) return 'username';
  return null;
}

/** Message for the test-email recipient, or null (empty = the caller's own address). */
export function testRecipientError(to: string): string | null {
  const v = to.trim();
  if (!v) return null;
  return v.length > 254 || !ADDRESS.test(v) ? 'Enter one email address to send the test to.' : null;
}

/** One-line status of the page. */
export function smtpStatus(s: SmtpSettings): { tone: 'success' | 'warning' | 'info'; message: string } {
  if (s.recovery_available) {
    return { tone: 'success', message: 'Email is set up: invitations are sent by email and users can reset a forgotten password themselves.' };
  }
  if (s.mail_configured) {
    return {
      tone: 'warning',
      message: s.base_url_problem
        ? `A mail server is set, but the dashboard base URL is not usable (${s.base_url_problem}). Password reset by email stays off until it is fixed.`
        : 'A mail server is set, but no dashboard base URL. Password reset by email stays off until one is set; invitation links are relative.',
    };
  }
  return { tone: 'info', message: 'No mail server is set. Invitations show their link only, and users who forget their password ask an administrator to reset it.' };
}

/** True when anything is saved on this page (what "Clear saved settings" removes). */
export function hasSavedSettings(s: SmtpSettings | null): boolean {
  return !!s && Object.values(s.sources ?? {}).some((src) => src === 'saved');
}
